import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { TextDecoder } from "node:util";

import {
  S3ArtifactStoreVersionConflictError,
  type SingletonObjectVersionResolver,
} from "./s3-raw-artifact-store.js";

const MAX_LIST_RESPONSE_BYTES = 65_536;
const MAX_PRIVATE_KEY_BYTES = 16_384;
const OCI_LIST_LIMIT = 2;
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });

export class OciObjectStorageError extends Error {
  constructor(readonly statusCode: number | null) {
    super("OCI Object Storage version inventory operation failed");
    this.name = "OciObjectStorageError";
  }
}

export class OciObjectStorageTimeoutError extends OciObjectStorageError {
  constructor() {
    super(null);
    this.name = "OciObjectStorageTimeoutError";
  }
}

/** OCI ListObjectVersions has one admissible success status. */
export function assertOciObjectVersionListStatus(statusCode: number | undefined): void {
  if (statusCode !== 200) throw new OciObjectStorageError(statusCode ?? null);
}

export interface OciNativeObjectVersionResolverOptions {
  readonly bucket: string;
  readonly clock?: () => Date;
  readonly fingerprint: string;
  readonly namespace: string;
  readonly privateKeyPem: string;
  readonly region: string;
  readonly requestTimeoutMs?: number;
  readonly tenancyOcid: string;
  readonly userOcid: string;
}

interface OciSigningIdentity {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface OciSignedGetRequestInput {
  readonly date: string;
  readonly host: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly requestTarget: string;
}

function versionConflict(): never {
  throw new S3ArtifactStoreVersionConflictError();
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function encodeRfc3986(value: string): string {
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
  return objectKey;
}

function parsePrivateKey(input: {
  readonly fingerprint: string;
  readonly privateKeyPem: string;
}): OciSigningIdentity["privateKey"] {
  if (
    Buffer.byteLength(input.privateKeyPem, "utf8") < 1 ||
    Buffer.byteLength(input.privateKeyPem, "utf8") > MAX_PRIVATE_KEY_BYTES ||
    containsAsciiControlCharacter(input.privateKeyPem.replaceAll("\n", "")) ||
    !input.privateKeyPem.startsWith("-----BEGIN ")
  ) {
    throw new TypeError("Invalid OCI API signing private key");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new TypeError("Invalid OCI API signing private key");
  }
  const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength;
  if (
    privateKey.asymmetricKeyType !== "rsa" ||
    modulusLength === undefined ||
    modulusLength < 2_048 ||
    modulusLength > 8_192
  ) {
    throw new TypeError("OCI API signing requires a 2048-bit or stronger RSA key");
  }
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const derivedFingerprint = createHash("md5")
    .update(publicKeyDer)
    .digest("hex")
    .match(/.{2}/g)
    ?.join(":");
  if (!derivedFingerprint || derivedFingerprint !== input.fingerprint.toLowerCase()) {
    throw new TypeError("OCI API signing key fingerprint does not match its private key");
  }
  return privateKey;
}

function signingIdentity(options: OciNativeObjectVersionResolverOptions): OciSigningIdentity {
  if (!/^ocid1\.tenancy\.oc[1-9][0-9]*\.\.[a-z0-9]{10,255}$/.test(options.tenancyOcid)) {
    throw new TypeError("Invalid OCI tenancy OCID");
  }
  if (!/^ocid1\.user\.oc[1-9][0-9]*\.\.[a-z0-9]{10,255}$/.test(options.userOcid)) {
    throw new TypeError("Invalid OCI user OCID");
  }
  if (!/^(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}$/.test(options.fingerprint)) {
    throw new TypeError("Invalid OCI API signing key fingerprint");
  }
  return {
    keyId: `${options.tenancyOcid}/${options.userOcid}/${options.fingerprint.toLowerCase()}`,
    privateKey: parsePrivateKey(options),
  };
}

/** Builds the exact OCI Signature v1 Authorization value for a bodyless GET. */
export function createOciSignedGetAuthorization(input: OciSignedGetRequestInput): string {
  if (
    !/^[a-z0-9.-]+$/.test(input.host) ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+$/.test(input.requestTarget) ||
    input.requestTarget.includes("#") ||
    containsAsciiControlCharacter(input.requestTarget) ||
    containsAsciiControlCharacter(input.date) ||
    !/^ocid1\.tenancy\.oc[1-9][0-9]*\.\.[a-z0-9]{10,255}\/ocid1\.user\.oc[1-9][0-9]*\.\.[a-z0-9]{10,255}\/(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(
      input.keyId,
    )
  ) {
    throw new TypeError("Invalid OCI request signing input");
  }
  const parsedDate = new Date(input.date);
  if (!Number.isFinite(parsedDate.valueOf()) || parsedDate.toUTCString() !== input.date) {
    throw new TypeError("Invalid OCI request signing date");
  }
  const signedHeaders = "(request-target) host date";
  const signingString = [
    `(request-target): get ${input.requestTarget}`,
    `host: ${input.host}`,
    `date: ${input.date}`,
  ].join("\n");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingString, "utf8"),
    input.privateKey,
  ).toString("base64");
  return `Signature version="1",keyId="${input.keyId}",algorithm="rsa-sha256",headers="${signedHeaders}",signature="${signature}"`;
}

class StrictJsonParser {
  #offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#offset !== this.source.length) versionConflict();
    return value;
  }

  #whitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.#offset] ?? "")) this.#offset += 1;
  }

  #value(depth: number): unknown {
    if (depth > 8) versionConflict();
    this.#whitespace();
    const character = this.source[this.#offset];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.source.startsWith(literal, this.#offset)) {
        this.#offset += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.#offset),
    );
    if (!match) versionConflict();
    this.#offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) versionConflict();
    return number;
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    let escaped = false;
    while (this.#offset < this.source.length) {
      const codePoint = this.source.charCodeAt(this.#offset);
      const character = this.source[this.#offset];
      if (!escaped && character === '"') {
        this.#offset += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#offset)) as string;
        } catch {
          versionConflict();
        }
      }
      if (!escaped && codePoint <= 0x1f) versionConflict();
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      this.#offset += 1;
    }
    return versionConflict();
  }

  #object(depth: number): Record<string, unknown> {
    this.#offset += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#whitespace();
    if (this.source[this.#offset] === "}") {
      this.#offset += 1;
      return result;
    }
    for (;;) {
      this.#whitespace();
      if (this.source[this.#offset] !== '"') versionConflict();
      const key = this.#string();
      if (keys.has(key)) versionConflict();
      keys.add(key);
      this.#whitespace();
      if (this.source[this.#offset] !== ":") versionConflict();
      this.#offset += 1;
      result[key] = this.#value(depth);
      this.#whitespace();
      const delimiter = this.source[this.#offset];
      this.#offset += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") versionConflict();
    }
  }

  #array(depth: number): unknown[] {
    this.#offset += 1;
    const result: unknown[] = [];
    this.#whitespace();
    if (this.source[this.#offset] === "]") {
      this.#offset += 1;
      return result;
    }
    for (;;) {
      if (result.length >= 16) versionConflict();
      result.push(this.#value(depth));
      this.#whitespace();
      const delimiter = this.source[this.#offset];
      this.#offset += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") versionConflict();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const ROOT_FIELDS = new Set(["items", "prefixes"]);
const VERSION_FIELDS = new Set([
  "archivalState",
  "etag",
  "isDeleteMarker",
  "md5",
  "name",
  "size",
  "storageTier",
  "timeCreated",
  "timeModified",
  "versionId",
]);

/** Strictly parses a bounded, complete OCI ObjectVersionCollection response. */
export function parseOciSingletonObjectVersion(input: {
  readonly body: Buffer;
  readonly exactObjectKey: string;
  readonly opcNextPage?: string | readonly string[];
}): { readonly versionId: string } | null {
  const exactObjectKey = canonicalObjectKey(input.exactObjectKey);
  if (
    input.body.byteLength < 1 ||
    input.body.byteLength > MAX_LIST_RESPONSE_BYTES ||
    input.opcNextPage !== undefined
  ) {
    versionConflict();
  }
  let source: string;
  try {
    source = JSON_DECODER.decode(input.body);
  } catch {
    return versionConflict();
  }
  const root = new StrictJsonParser(source).parse();
  if (!isRecord(root) || !hasOnlyKeys(root, ROOT_FIELDS) || !Array.isArray(root.items)) {
    versionConflict();
  }
  if (
    root.prefixes !== undefined &&
    root.prefixes !== null &&
    (!Array.isArray(root.prefixes) || root.prefixes.length !== 0)
  ) {
    versionConflict();
  }
  if (root.items.length === 0) return null;
  if (root.items.length !== 1) versionConflict();
  const item = root.items[0];
  if (
    !isRecord(item) ||
    !hasOnlyKeys(item, VERSION_FIELDS) ||
    item.name !== exactObjectKey ||
    typeof item.versionId !== "string" ||
    !/^[!-~]{1,1024}$/.test(item.versionId) ||
    typeof item.isDeleteMarker !== "boolean" ||
    item.isDeleteMarker
  ) {
    versionConflict();
  }
  return { versionId: item.versionId };
}

function listRequestTarget(input: {
  readonly bucket: string;
  readonly namespace: string;
  readonly objectKey: string;
}): string {
  return (
    `/n/${encodeRfc3986(input.namespace)}/b/${encodeRfc3986(input.bucket)}/objectversions` +
    `?prefix=${encodeRfc3986(input.objectKey)}&limit=${OCI_LIST_LIMIT}&fields=name`
  );
}

export class OciNativeObjectVersionResolver implements SingletonObjectVersionResolver {
  readonly #bucket: string;
  readonly #clock: () => Date;
  readonly #host: string;
  readonly #identity: OciSigningIdentity;
  readonly #namespace: string;
  readonly #requestTimeoutMs: number;

  constructor(options: OciNativeObjectVersionResolverOptions) {
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(options.namespace)) {
      throw new TypeError("Invalid OCI Object Storage namespace");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new TypeError("Invalid OCI Object Storage bucket");
    }
    if (
      options.region.length > 64 ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/.test(options.region)
    ) {
      throw new TypeError("Invalid OCI region");
    }
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 100 ||
      this.#requestTimeoutMs > 300_000
    ) {
      throw new RangeError("Invalid OCI Object Storage request timeout");
    }
    this.#bucket = options.bucket;
    this.#clock = options.clock ?? (() => new Date());
    this.#host = `objectstorage.${options.region}.oraclecloud.com`;
    this.#identity = signingIdentity(options);
    this.#namespace = options.namespace;
  }

  async resolveSingletonVersion(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly versionId: string } | null> {
    const objectKey = canonicalObjectKey(input.objectKey);
    const requestTarget = listRequestTarget({
      bucket: this.#bucket,
      namespace: this.#namespace,
      objectKey,
    });
    const date = this.#clock().toUTCString();
    const authorization = createOciSignedGetAuthorization({
      date,
      host: this.#host,
      keyId: this.#identity.keyId,
      privateKey: this.#identity.privateKey,
      requestTarget,
    });
    let resolveResponse!: (response: IncomingMessage) => void;
    let rejectResponse!: (error: Error) => void;
    const responsePromise = new Promise<IncomingMessage>((resolvePromise, reject) => {
      resolveResponse = resolvePromise;
      rejectResponse = reject;
    });
    let timeout: NodeJS.Timeout | undefined;
    const request = httpsRequest(
      `https://${this.#host}${requestTarget}`,
      {
        agent: false,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization,
          date,
          host: this.#host,
        },
        method: "GET",
        ...(input.signal ? { signal: input.signal } : {}),
      },
      (response) => {
        const clear = () => {
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
        };
        response.once("end", clear);
        response.once("close", clear);
        response.once("error", clear);
        resolveResponse(response);
      },
    );
    timeout = setTimeout(
      () => request.destroy(new OciObjectStorageTimeoutError()),
      this.#requestTimeoutMs,
    );
    timeout.unref();
    request.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      rejectResponse(error);
    });
    request.end();
    const response = await responsePromise;
    try {
      assertOciObjectVersionListStatus(response.statusCode);
    } catch (error) {
      response.destroy();
      throw error;
    }
    const contentType = response.headers["content-type"];
    const contentEncoding = response.headers["content-encoding"];
    if (
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
      (contentEncoding !== undefined && contentEncoding !== "identity")
    ) {
      response.destroy();
      versionConflict();
    }
    const rawLength = response.headers["content-length"];
    if (
      rawLength !== undefined &&
      (typeof rawLength !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/.test(rawLength) ||
        Number(rawLength) < 1 ||
        Number(rawLength) > MAX_LIST_RESPONSE_BYTES)
    ) {
      response.destroy();
      versionConflict();
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const value = Buffer.from(chunk as Uint8Array);
      bytes += value.byteLength;
      if (bytes > MAX_LIST_RESPONSE_BYTES) {
        response.destroy();
        versionConflict();
      }
      chunks.push(value);
    }
    if (rawLength !== undefined && bytes !== Number(rawLength)) versionConflict();
    return parseOciSingletonObjectVersion({
      body: Buffer.concat(chunks),
      exactObjectKey: objectKey,
      ...(response.headers["opc-next-page"] === undefined
        ? {}
        : { opcNextPage: response.headers["opc-next-page"] }),
    });
  }
}
