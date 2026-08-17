import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { RawArtifactStore } from "./artifact-encryption.js";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export class S3ArtifactStoreError extends Error {
  constructor(readonly statusCode: number | null) {
    super("S3-compatible artifact storage operation failed");
    this.name = "S3ArtifactStoreError";
  }
}

export class S3ArtifactStoreTimeoutError extends S3ArtifactStoreError {
  constructor() {
    super(null);
    this.name = "S3ArtifactStoreTimeoutError";
  }
}

export class S3ArtifactStoreVersionConflictError extends S3ArtifactStoreError {
  constructor() {
    super(null);
    this.name = "S3ArtifactStoreVersionConflictError";
  }
}

export interface S3RawArtifactStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly clock?: () => Date;
  readonly requestTimeoutMs?: number;
  /** Restore-only mode: reject missing, multiple, truncated or delete-marker version history. */
  readonly readVersionPolicy?: "latest" | "require_singleton";
  /** Optional native provider for the restore-only singleton history check. */
  readonly singletonVersionResolver?: SingletonObjectVersionResolver;
  /** Export-only deletion of the sole null version in a versioning-suspended bucket. */
  readonly deleteVersionPolicy?: "latest" | "suspended_null";
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalObjectKey(objectKey: string): string {
  if (
    Buffer.byteLength(objectKey, "utf8") > 1_024 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectKey) ||
    objectKey.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("Invalid export artifact object key");
  }
  return objectKey.split("/").map(encodePathSegment).join("/");
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function canonicalQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .map(([key, value]) => [encodePathSegment(key), encodePathSegment(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(secret: string, shortDate: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), "s3"), "aws4_request");
}

function amzTimestamp(date: Date): { readonly timestamp: string; readonly shortDate: string } {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { shortDate: timestamp.slice(0, 8), timestamp };
}

async function drain(response: IncomingMessage): Promise<void> {
  response.resume();
  await new Promise<void>((resolvePromise, reject) => {
    response.once("end", resolvePromise);
    response.once("error", reject);
  });
}

export interface S3ObjectVersion {
  readonly deleteMarker: boolean;
  readonly isLatest: boolean;
  readonly versionId: string;
}

/**
 * Resolves the only admissible immutable object version for an offline restore.
 * Implementations must reject incomplete history, delete markers, and ambiguity.
 */
export interface SingletonObjectVersionResolver {
  resolveSingletonVersion(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly versionId: string } | null>;
}

/** Validates that an exact version GET returned the requested live object version. */
export function assertS3ExactVersionResponse(input: {
  readonly deleteMarkerHeader?: string | readonly string[];
  readonly requestedVersionId: string;
  readonly statusCode: number | undefined;
  readonly versionIdHeader?: string | readonly string[];
}): void {
  if (
    input.statusCode !== 200 ||
    typeof input.versionIdHeader !== "string" ||
    input.versionIdHeader !== input.requestedVersionId ||
    (input.deleteMarkerHeader !== undefined && input.deleteMarkerHeader !== "false")
  ) {
    throw new S3ArtifactStoreVersionConflictError();
  }
}

interface StrictXmlNode {
  readonly name: string;
  readonly attributes: string;
  readonly children: StrictXmlNode[];
  text: string;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const S3_XML_NAMESPACE = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
const VALID_XML_ENTITY = /&(amp|apos|gt|lt|quot|#(?:[0-9]+|x[0-9a-fA-F]+));/g;

function versionConflict(): never {
  throw new S3ArtifactStoreVersionConflictError();
}

function xmlText(value: string): string {
  if (value.replace(VALID_XML_ENTITY, "").includes("&")) versionConflict();
  return value.replace(VALID_XML_ENTITY, (_match, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const codePoint = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint < 1 ||
          codePoint > 0x10ffff ||
          (codePoint < 0x20 && ![0x9, 0xa, 0xd].includes(codePoint)) ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          versionConflict();
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

function parseStrictXmlDocument(xml: string): StrictXmlNode {
  let source = xml.trim();
  if (source.startsWith("<?xml")) {
    if (!source.startsWith(XML_DECLARATION)) versionConflict();
    source = source.slice(XML_DECLARATION.length).trimStart();
  }
  if (source.includes("<!") || source.includes("<?")) versionConflict();

  const roots: StrictXmlNode[] = [];
  const stack: StrictXmlNode[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] !== "<") {
      const tagOffset = source.indexOf("<", offset);
      const end = tagOffset === -1 ? source.length : tagOffset;
      const text = source.slice(offset, end);
      if (stack.length === 0) {
        if (text.trim() !== "") versionConflict();
      } else {
        const current = stack.at(-1);
        if (!current) versionConflict();
        current.text += text;
      }
      offset = end;
      continue;
    }

    const end = source.indexOf(">", offset + 1);
    if (end === -1) versionConflict();
    const rawTag = source.slice(offset + 1, end);
    if (rawTag.startsWith("/")) {
      if (!/^\/[A-Za-z][A-Za-z0-9]*$/.test(rawTag)) versionConflict();
      const current = stack.pop();
      if (!current || current.name !== rawTag.slice(1)) versionConflict();
      offset = end + 1;
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const tag = selfClosing ? rawTag.slice(0, -1).trimEnd() : rawTag;
    const match = /^([A-Za-z][A-Za-z0-9]*)(.*)$/.exec(tag);
    if (!match) versionConflict();
    const name = match[1];
    if (!name) versionConflict();
    const attributes = match[2]?.trim() ?? "";
    if (
      attributes !== "" &&
      !(
        name === "ListVersionsResult" &&
        (attributes === S3_XML_NAMESPACE ||
          attributes === 'xmlns="http://s3.amazonaws.com/doc/2006-03-01"')
      )
    ) {
      versionConflict();
    }
    const node: StrictXmlNode = { attributes, children: [], name, text: "" };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
    offset = end + 1;
  }
  if (stack.length !== 0 || roots.length !== 1) versionConflict();
  const root = roots[0];
  if (!root) versionConflict();

  const validateText = (node: StrictXmlNode): void => {
    xmlText(node.text);
    if (node.children.length > 0 && node.text.trim() !== "") versionConflict();
    for (const child of node.children) validateText(child);
  };
  validateText(root);
  return root;
}

function directElement(node: StrictXmlNode, name: string): StrictXmlNode {
  const elements = node.children.filter((child) => child.name === name);
  if (elements.length !== 1) versionConflict();
  const element = elements[0];
  if (!element) versionConflict();
  if (element.children.length !== 0 || element.attributes !== "") versionConflict();
  return element;
}

function descendants(node: StrictXmlNode, name: string): readonly StrictXmlNode[] {
  const values: StrictXmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) values.push(child);
    values.push(...descendants(child, name));
  }
  return values;
}

function parseObjectVersionsXml(xml: string, exactObjectKey: string): readonly S3ObjectVersion[] {
  if (xml.length < 1 || xml.length > 1_048_576) versionConflict();
  const root = parseStrictXmlDocument(xml);
  if (root.name !== "ListVersionsResult" || root.text.trim() !== "") versionConflict();
  const truncatedElements = descendants(root, "IsTruncated");
  if (
    truncatedElements.length !== 1 ||
    truncatedElements[0] !== directElement(root, "IsTruncated")
  ) {
    versionConflict();
  }
  const truncated = truncatedElements[0];
  if (!truncated) versionConflict();
  if (truncated.children.length !== 0 || truncated.text !== "false") {
    versionConflict();
  }

  const versions: S3ObjectVersion[] = [];
  const blocks = root.children.filter(
    (child) => child.name === "Version" || child.name === "DeleteMarker",
  );
  if (
    descendants(root, "Version").length !==
      blocks.filter((block) => block.name === "Version").length ||
    descendants(root, "DeleteMarker").length !==
      blocks.filter((block) => block.name === "DeleteMarker").length
  ) {
    versionConflict();
  }
  for (const block of blocks) {
    if (block.attributes !== "" || block.text.trim() !== "") versionConflict();
    const key = xmlText(directElement(block, "Key").text);
    const decodedVersionId = xmlText(directElement(block, "VersionId").text);
    const latest = directElement(block, "IsLatest").text;
    if (key !== exactObjectKey) continue;
    if (
      decodedVersionId.length < 1 ||
      decodedVersionId.length > 1_024 ||
      containsAsciiControlCharacter(decodedVersionId) ||
      (latest !== "true" && latest !== "false")
    ) {
      throw new S3ArtifactStoreVersionConflictError();
    }
    versions.push({
      deleteMarker: block.name === "DeleteMarker",
      isLatest: latest === "true",
      versionId: decodedVersionId,
    });
  }
  return versions;
}

export class S3RawArtifactStore implements RawArtifactStore {
  readonly #endpoint: URL;
  readonly #region: string;
  readonly #bucket: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken: string | undefined;
  readonly #clock: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #readVersionPolicy: "latest" | "require_singleton";
  readonly #deleteVersionPolicy: "latest" | "suspended_null";
  readonly #singletonVersionResolver: SingletonObjectVersionResolver | undefined;

  constructor(options: S3RawArtifactStoreOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "")
    ) {
      throw new TypeError("Invalid S3-compatible endpoint");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new TypeError("Invalid artifact bucket");
    }
    if (!/^[a-z0-9-]{2,64}$/.test(options.region)) throw new TypeError("Invalid S3 region");
    if (!options.accessKeyId || !options.secretAccessKey)
      throw new TypeError("Missing S3 credentials");
    this.#endpoint = endpoint;
    this.#region = options.region;
    this.#bucket = options.bucket;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = options.secretAccessKey;
    this.#sessionToken = options.sessionToken;
    this.#clock = options.clock ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#readVersionPolicy = options.readVersionPolicy ?? "latest";
    this.#deleteVersionPolicy = options.deleteVersionPolicy ?? "latest";
    this.#singletonVersionResolver = options.singletonVersionResolver;
    if (this.#singletonVersionResolver && this.#readVersionPolicy !== "require_singleton") {
      throw new TypeError("A singleton version resolver is restore-only");
    }
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 100 ||
      this.#requestTimeoutMs > 300_000
    ) {
      throw new RangeError("Invalid S3 artifact request timeout");
    }
  }

  #signedRequest(input: {
    readonly method: "DELETE" | "GET" | "PUT";
    readonly objectKey?: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly contentLength?: number;
    readonly signal?: AbortSignal;
  }): {
    readonly request: ReturnType<typeof httpRequest>;
    readonly response: Promise<IncomingMessage>;
  } {
    const canonicalUri = input.objectKey
      ? `/${encodePathSegment(this.#bucket)}/${canonicalObjectKey(input.objectKey)}`
      : `/${encodePathSegment(this.#bucket)}`;
    const query = canonicalQuery(input.query ?? {});
    const url = new URL(canonicalUri, this.#endpoint);
    if (query) url.search = `?${query}`;
    const { shortDate, timestamp } = amzTimestamp(this.#clock());
    const signedHeaderValues: Record<string, string> = {
      host: url.host,
      ...(input.method === "PUT" ? { "if-none-match": "*" } : {}),
      "x-amz-content-sha256": UNSIGNED_PAYLOAD,
      "x-amz-date": timestamp,
      ...(this.#sessionToken ? { "x-amz-security-token": this.#sessionToken } : {}),
    };
    const signedHeaders = Object.keys(signedHeaderValues).sort().join(";");
    const canonicalHeaders = `${Object.entries(signedHeaderValues)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, " ")}`)
      .join("\n")}\n`;
    const canonicalRequest = [
      input.method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join("\n");
    const scope = `${shortDate}/${this.#region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join(
      "\n",
    );
    const signature = createHmac(
      "sha256",
      signingKey(this.#secretAccessKey, shortDate, this.#region),
    )
      .update(stringToSign, "utf8")
      .digest("hex");
    const headers: Record<string, string> = {
      ...signedHeaderValues,
      accept: "application/octet-stream",
      "accept-encoding": "identity",
      authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(input.contentLength === undefined
        ? {}
        : {
            "content-length": String(input.contentLength),
            "content-type": "application/octet-stream",
          }),
    };
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    let resolveResponse!: (response: IncomingMessage) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<IncomingMessage>((resolvePromise, reject) => {
      resolveResponse = resolvePromise;
      rejectResponse = reject;
    });
    let timeout: NodeJS.Timeout | undefined;
    const request = transport(
      url,
      {
        // Failed conditional PUTs are commonly answered before the request body is
        // fully consumed and MinIO closes that connection. A per-request socket
        // prevents the next authenticated GET from inheriting the half-closed socket.
        agent: false,
        headers,
        method: input.method,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (incoming) => {
        const clear = () => {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
        };
        incoming.once("end", clear);
        incoming.once("close", clear);
        incoming.once("error", clear);
        resolveResponse(incoming);
      },
    );
    timeout = setTimeout(
      () => request.destroy(new S3ArtifactStoreTimeoutError()),
      this.#requestTimeoutMs,
    );
    timeout.unref();
    request.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      rejectResponse(error);
    });
    return { request, response };
  }

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      throw new RangeError("Invalid encrypted artifact length");
    }
    const operation = this.#signedRequest({
      contentLength: input.contentLength,
      method: "PUT",
      objectKey: input.objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      const upload = input.signal
        ? pipeline(input.source, operation.request, { signal: input.signal })
        : pipeline(input.source, operation.request);
      const [, response] = await Promise.all([upload, operation.response]);
      const statusCode = response.statusCode ?? null;
      await drain(response);
      if (statusCode === null || statusCode < 200 || statusCode >= 300) {
        throw new S3ArtifactStoreError(statusCode);
      }
    } catch (error) {
      operation.request.destroy();
      if (error instanceof S3ArtifactStoreError) throw error;
      throw error;
    }
  }

  async open(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly stream: Readable; readonly contentLength: number } | null> {
    if (this.#readVersionPolicy === "require_singleton") {
      const version = this.#singletonVersionResolver
        ? await this.#singletonVersionResolver.resolveSingletonVersion(input)
        : await this.#resolveS3SingletonVersion(input);
      if (!version) return null;
      const opened = await this.#openObject({
        ...input,
        versionId: version.versionId,
      });
      if (!opened) throw new S3ArtifactStoreVersionConflictError();
      return opened;
    }
    return this.#openObject(input);
  }

  async #resolveS3SingletonVersion(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly versionId: string } | null> {
    const versions = await this.listObjectVersions(input);
    if (versions.length === 0) return null;
    const version = versions[0];
    if (!version || versions.length !== 1 || version.deleteMarker || !version.isLatest) {
      throw new S3ArtifactStoreVersionConflictError();
    }
    return { versionId: version.versionId };
  }

  async #openObject(input: {
    readonly objectKey: string;
    readonly versionId?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly stream: Readable; readonly contentLength: number } | null> {
    if (
      input.versionId !== undefined &&
      (input.versionId.length < 1 ||
        input.versionId.length > 1_024 ||
        containsAsciiControlCharacter(input.versionId))
    ) {
      throw new TypeError("Invalid S3 object version identifier");
    }
    const operation = this.#signedRequest({
      method: "GET",
      objectKey: input.objectKey,
      ...(input.versionId ? { query: { versionId: input.versionId } } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    operation.request.end();
    const response = await operation.response;
    if (input.versionId !== undefined) {
      try {
        assertS3ExactVersionResponse({
          ...(response.headers["x-amz-delete-marker"] === undefined
            ? {}
            : { deleteMarkerHeader: response.headers["x-amz-delete-marker"] }),
          requestedVersionId: input.versionId,
          statusCode: response.statusCode,
          ...(response.headers["x-amz-version-id"] === undefined
            ? {}
            : { versionIdHeader: response.headers["x-amz-version-id"] }),
        });
      } catch (error) {
        response.destroy();
        throw error;
      }
    }
    if (response.statusCode === 404) {
      await drain(response);
      return null;
    }
    if (
      response.statusCode === undefined ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      const statusCode = response.statusCode ?? null;
      await drain(response);
      throw new S3ArtifactStoreError(statusCode);
    }
    const rawLength = response.headers["content-length"];
    const contentLength = typeof rawLength === "string" ? Number(rawLength) : Number.NaN;
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      response.destroy();
      throw new S3ArtifactStoreError(response.statusCode);
    }
    return { contentLength, stream: response };
  }

  async listObjectVersions(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly S3ObjectVersion[]> {
    canonicalObjectKey(input.objectKey);
    const operation = this.#signedRequest({
      method: "GET",
      query: { prefix: input.objectKey, versions: "" },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    operation.request.end();
    const response = await operation.response;
    if (
      response.statusCode === undefined ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      const statusCode = response.statusCode ?? null;
      await drain(response);
      throw new S3ArtifactStoreError(statusCode);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const value = Buffer.from(chunk as Uint8Array);
      bytes += value.byteLength;
      if (bytes > 1_048_576) {
        response.destroy();
        throw new S3ArtifactStoreVersionConflictError();
      }
      chunks.push(value);
    }
    return parseObjectVersionsXml(Buffer.concat(chunks).toString("utf8"), input.objectKey);
  }

  async delete(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const operation = this.#signedRequest({
      method: "DELETE",
      objectKey: input.objectKey,
      ...(this.#deleteVersionPolicy === "suspended_null" ? { query: { versionId: "null" } } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    operation.request.end();
    const response = await operation.response;
    const statusCode = response.statusCode ?? null;
    await drain(response);
    if (statusCode !== 404 && (statusCode === null || statusCode < 200 || statusCode >= 300)) {
      throw new S3ArtifactStoreError(statusCode);
    }
  }
}
