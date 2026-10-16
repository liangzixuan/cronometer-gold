import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { type BlobItem, ContainerClient, newPipeline } from "@azure/storage-blob";
import type { RawArtifactStore } from "./artifact-encryption.js";
import {
  AzureArtifactStoreError,
  AzureRestoreReadBudget,
  type AzureRestoreReadLimits,
  azureBlobHttpClient,
} from "./azure-blob-http-client.js";

export {
  AZURE_LEDGER_RESTORE_READ_BUDGET,
  AzureArtifactStoreError,
  type AzureRestoreReadLimits,
} from "./azure-blob-http-client.js";

export interface AzureBlobRawArtifactStoreOptions {
  readonly containerUrl: string;
  readonly sasToken: string;
  readonly deletionObserverSasToken?: string;
  readonly prefix: string;
  readonly role: "reader" | "export-writer" | "ledger-writer" | "backup-writer" | "restore-reader";
  readonly requestTimeoutMs?: number;
  readonly maximumObjectBytes?: number;
  readonly restoreReadBudget?: AzureRestoreReadLimits;
}

/** Selected response headers; body completion and authentication are separate. */
export type AzureBlobReadIdentity = Readonly<{
  containerUrl: string;
  prefix: string;
  objectKey: string;
  blobName: string;
  contentLength: number;
}> &
  (
    | Readonly<{ kind: "azure-blob-version"; versionId: string }>
    | Readonly<{ kind: "azure-blob-current" }>
  );

const PERMISSIONS = {
  reader: "r",
  "export-writer": "rcd",
  "ledger-writer": "rc",
  "backup-writer": "c",
  "restore-reader": "rl",
} as const;
const MAX_BYTES = 107_374_182_400 + 128;
const BLOCK_BYTES = 8 * 1024 * 1024;
const SAS_FIELDS = new Set([
  "sv",
  "spr",
  "st",
  "se",
  "sr",
  "sp",
  "sig",
  "skoid",
  "sktid",
  "skt",
  "ske",
  "sks",
  "skv",
]);

function key(value: string): string {
  if (
    Buffer.byteLength(value) > 1024 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new AzureArtifactStoreError();
  return value;
}

function readVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    Buffer.byteLength(value) > 1024 ||
    Buffer.from(value).toString("utf8") !== value ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new AzureArtifactStoreError();
  return value;
}

export type AzureBlobReadLocation = Readonly<{
  kind: "azure-blob-version";
  containerUrl: string;
  prefix: string;
}>;

function scalarRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new AzureArtifactStoreError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((field) => typeof field !== "string" || !fields.includes(field))
  )
    throw new AzureArtifactStoreError();
  const copy: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) throw new AzureArtifactStoreError();
    copy[field] = descriptor.value;
  }
  return copy;
}

/** Admitted location only; this is not an observed provider identity. */
export function snapshotAzureBlobReadLocation(value: unknown): AzureBlobReadLocation {
  const v = scalarRecord(value, ["kind", "containerUrl", "prefix"]);
  if (
    v.kind !== "azure-blob-version" ||
    typeof v.containerUrl !== "string" ||
    !isAzureBlobContainerUrl(v.containerUrl) ||
    typeof v.prefix !== "string" ||
    !v.prefix.endsWith("/")
  )
    throw new AzureArtifactStoreError();
  key(v.prefix.slice(0, -1));
  return Object.freeze({
    kind: "azure-blob-version",
    containerUrl: v.containerUrl,
    prefix: v.prefix,
  });
}

/** Copy actual selected headers and join them to the admitted read, without upgrading current reads. */
export function snapshotAzureBlobVersionReadIdentity(
  value: unknown,
  expected: AzureBlobReadLocation & {
    readonly objectKey: string;
    readonly contentLength: number;
    readonly maximumObjectBytes: number;
  },
): Extract<AzureBlobReadIdentity, { kind: "azure-blob-version" }> {
  const v = scalarRecord(value, [
    "kind",
    "containerUrl",
    "prefix",
    "objectKey",
    "blobName",
    "versionId",
    "contentLength",
  ]);
  const location = snapshotAzureBlobReadLocation({
    kind: expected.kind,
    containerUrl: expected.containerUrl,
    prefix: expected.prefix,
  });
  if (
    typeof expected.objectKey !== "string" ||
    !Number.isSafeInteger(expected.maximumObjectBytes) ||
    expected.maximumObjectBytes <= 0 ||
    !Number.isSafeInteger(expected.contentLength) ||
    expected.contentLength <= 0 ||
    expected.contentLength > expected.maximumObjectBytes ||
    v.kind !== "azure-blob-version" ||
    v.containerUrl !== location.containerUrl ||
    v.prefix !== location.prefix ||
    v.objectKey !== key(expected.objectKey) ||
    v.blobName !== key(location.prefix + expected.objectKey) ||
    v.contentLength !== expected.contentLength
  )
    throw new AzureArtifactStoreError();
  const result = Object.freeze({
    kind: "azure-blob-version" as const,
    containerUrl: v.containerUrl as string,
    prefix: v.prefix as string,
    objectKey: v.objectKey as string,
    blobName: v.blobName as string,
    versionId: readVersion(v.versionId),
    contentLength: v.contentLength as number,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) throw new AzureArtifactStoreError();
  return result;
}

export function isAzureBlobContainerUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.href === value &&
      u.protocol === "https:" &&
      !u.port &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(u.hostname) &&
      /^\/[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** Restricts syntax and requested grants; actual issuer/RBAC/policy acceptance is separate. */
function validateCredential(
  options: AzureBlobRawArtifactStoreOptions,
  permission: string,
  now: number,
): number {
  if (
    !isAzureBlobContainerUrl(options.containerUrl) ||
    !Object.hasOwn(PERMISSIONS, options.role) ||
    !options.sasToken ||
    options.sasToken.length > 8192 ||
    options.sasToken.startsWith("?") ||
    !options.prefix.endsWith("/")
  )
    throw new AzureArtifactStoreError();
  key(options.prefix.slice(0, -1));
  const q = new URLSearchParams(options.sasToken);
  if (
    Array.from(q.keys()).some((x) => !SAS_FIELDS.has(x) || q.getAll(x).length !== 1) ||
    q.get("sv") !== "2026-04-06" ||
    q.get("spr") !== "https" ||
    q.get("sr") !== "c" ||
    q.get("sp") !== permission ||
    !q.get("sig") ||
    ["skoid", "sktid", "skt", "ske", "sks", "skv"].some((x) => !q.get(x)) ||
    q.get("sks") !== "b" ||
    q.get("skv") !== "2026-04-06"
  )
    throw new AzureArtifactStoreError();
  const start = Date.parse(q.get("st") ?? "");
  const end = Date.parse(q.get("se") ?? "");
  const keyStart = Date.parse(q.get("skt") ?? "");
  const keyEnd = Date.parse(q.get("ske") ?? "");
  if (
    ![start, end, keyStart, keyEnd, now].every(Number.isFinite) ||
    start > now ||
    end <= now ||
    end - start > 7 * 86400_000 ||
    keyStart > start ||
    keyEnd < end
  )
    throw new AzureArtifactStoreError();
  return end;
}

/** Same SAS syntax/expiry checks for direct credential-canary probes. */
export function validateAzureBlobProbeCredential(
  options: { readonly containerUrl: string; readonly prefix: string; readonly sasToken: string },
  permission: "r" | "rcd" | "l" | "rc" | "rl" | "c",
  now = Date.now(),
): number {
  if (!["r", "rcd", "l", "rc", "rl", "c"].includes(permission)) throw new AzureArtifactStoreError();
  return validateCredential({ ...options, role: "reader" }, permission, now);
}

export function validateAzureBlobCredential(
  options: AzureBlobRawArtifactStoreOptions,
  now = Date.now(),
): number {
  const expiry = validateCredential(options, PERMISSIONS[options.role], now);
  if (options.role !== "export-writer") {
    if (options.deletionObserverSasToken !== undefined) throw new AzureArtifactStoreError();
    return expiry;
  }
  if (!options.deletionObserverSasToken || options.deletionObserverSasToken === options.sasToken)
    throw new AzureArtifactStoreError();
  return Math.min(
    expiry,
    validateCredential(
      {
        ...options,
        sasToken: options.deletionObserverSasToken,
      },
      "l",
      now,
    ),
  );
}

function failure(error: unknown): AzureArtifactStoreError {
  if (error instanceof AzureArtifactStoreError) return error;
  const status =
    typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : null;
  return new AzureArtifactStoreError(
    typeof status === "number" && Number.isInteger(status) ? status : null,
  );
}

export class AzureBlobRawArtifactStore implements RawArtifactStore {
  readonly #options: AzureBlobRawArtifactStoreOptions;
  readonly #timeout: number;
  readonly #maximum: number;
  readonly #readBudget: AzureRestoreReadBudget | undefined;
  constructor(options: AzureBlobRawArtifactStoreOptions) {
    validateAzureBlobCredential(options);
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#maximum = options.maximumObjectBytes ?? MAX_BYTES;
    if (
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 100 ||
      this.#timeout > 300_000 ||
      !Number.isSafeInteger(this.#maximum) ||
      this.#maximum < 1 ||
      this.#maximum > MAX_BYTES
    )
      throw new AzureArtifactStoreError();
    if (options.restoreReadBudget !== undefined && options.role !== "restore-reader")
      throw new AzureArtifactStoreError();
    this.#readBudget =
      options.restoreReadBudget === undefined
        ? undefined
        : new AzureRestoreReadBudget(options.restoreReadBudget);
    this.#options = { ...options };
  }

  restoreReadUsage() {
    if (!this.#readBudget) throw new AzureArtifactStoreError();
    return this.#readBudget.snapshot();
  }

  #operation(signal?: AbortSignal) {
    const expiry = validateAzureBlobCredential(this.#options);
    const controller = new AbortController();
    const abort = () => controller.abort(new AzureArtifactStoreError());
    signal?.addEventListener("abort", abort, { once: true });
    const budgetSignal = this.#readBudget?.signal;
    budgetSignal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || budgetSignal?.aborted) abort();
    const timer = setTimeout(abort, Math.min(this.#timeout, expiry - Date.now()));
    timer.unref();
    let disposed = false;
    let completion: Promise<void> | undefined;
    const client = (sasToken: string) =>
      new ContainerClient(
        `${this.#options.containerUrl}?${sasToken}`,
        newPipeline(undefined, {
          retryOptions: { maxTries: 1 },
          keepAliveOptions: { enable: false },
          httpClient: azureBlobHttpClient({
            containerUrl: this.#options.containerUrl,
            signal: controller.signal,
            maximumObjectBytes: this.#maximum,
            ...(this.#readBudget ? { restoreReadBudget: this.#readBudget } : {}),
            onDownloadCompletion(value) {
              completion = value;
            },
          }),
        }),
      );
    return {
      signal: controller.signal,
      observer: this.#options.deletionObserverSasToken
        ? client(this.#options.deletionObserverSasToken)
        : undefined,
      downloadCompletion() {
        if (!completion) throw new AzureArtifactStoreError();
        return completion;
      },
      client: client(this.#options.sasToken),
      close() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        budgetSignal?.removeEventListener("abort", abort);
        abort();
      },
    };
  }

  #name(objectKey: string): string {
    return key(this.#options.prefix + key(objectKey));
  }

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (
      !["export-writer", "ledger-writer", "backup-writer"].includes(this.#options.role) ||
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 1 ||
      input.contentLength > this.#maximum
    )
      throw new AzureArtifactStoreError();
    const name = this.#name(input.objectKey);
    const op = this.#operation(input.signal);
    const blob = op.client.getBlockBlobClient(name);
    const ids: string[] = [];
    const nonce = randomBytes(16).toString("hex");
    let observed = 0;
    let buffer = Buffer.alloc(BLOCK_BYTES);
    let used = 0;
    const stage = async () => {
      const id = Buffer.from(`${nonce}-${String(ids.length).padStart(6, "0")}`).toString("base64");
      await blob.stageBlock(id, buffer.subarray(0, used), used, { abortSignal: op.signal });
      ids.push(id);
      buffer = Buffer.alloc(BLOCK_BYTES);
      used = 0;
    };
    const abortSource = () => input.source.destroy(new AzureArtifactStoreError());
    op.signal.addEventListener("abort", abortSource, { once: true });
    try {
      if (op.signal.aborted) throw new AzureArtifactStoreError();
      for await (const raw of input.source) {
        const chunk = Buffer.from(raw as Uint8Array);
        observed += chunk.byteLength;
        if (observed > input.contentLength || op.signal.aborted)
          throw new AzureArtifactStoreError();
        let offset = 0;
        while (offset < chunk.byteLength) {
          const n = Math.min(BLOCK_BYTES - used, chunk.byteLength - offset);
          chunk.copy(buffer, used, offset, offset + n);
          used += n;
          offset += n;
          if (used === BLOCK_BYTES) await stage();
        }
      }
      if (observed !== input.contentLength) throw new AzureArtifactStoreError();
      if (used) await stage();
      const result = await blob.commitBlockList(ids, {
        abortSignal: op.signal,
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/octet-stream" },
      });
      if (result._response.status !== 201 || !result.etag) throw new AzureArtifactStoreError();
    } catch (error) {
      throw failure(error);
    } finally {
      op.signal.removeEventListener("abort", abortSource);
      input.source.destroy();
      buffer.fill(0);
      op.close();
    }
  }

  async #versions(client: ContainerClient, name: string, signal: AbortSignal): Promise<BlobItem[]> {
    const pages = client
      .listBlobsFlat({
        prefix: name,
        includeVersions: true,
        includeSnapshots: true,
        includeDeleted: true,
        includeDeletedWithVersions: true,
        includeUncommitedBlobs: true,
        abortSignal: signal,
      })
      .byPage({ maxPageSize: 16 });
    const found: BlobItem[] = [];
    const tokens = new Set<string>();
    let count = 0;
    let rows = 0;
    for await (const page of pages) {
      if (
        ++count > 64 ||
        signal.aborted ||
        page.serviceEndpoint !== new URL(this.#options.containerUrl).origin + "/" ||
        page.containerName !== new URL(this.#options.containerUrl).pathname.slice(1) ||
        page.prefix !== name ||
        page.maxPageSize !== 16 ||
        typeof page.continuationToken !== "string" ||
        !page.segment ||
        !Array.isArray(page.segment.blobItems) ||
        page.segment.blobItems.length > 16
      )
        throw new AzureArtifactStoreError();
      rows += page.segment.blobItems.length;
      if (rows > 1024) throw new AzureArtifactStoreError();
      for (const item of page.segment.blobItems) {
        if (typeof item.name !== "string" || !item.name.startsWith(name))
          throw new AzureArtifactStoreError();
        if (item.name === name) found.push(item);
      }
      if (page.continuationToken) {
        if (
          count === 64 ||
          page.continuationToken.length > 8192 ||
          tokens.has(page.continuationToken)
        )
          throw new AzureArtifactStoreError();
        tokens.add(page.continuationToken);
      }
    }
    if (count === 0 || signal.aborted) throw new AzureArtifactStoreError();
    return found;
  }

  async open(input: { readonly objectKey: string; readonly signal?: AbortSignal }): Promise<{
    readonly stream: Readable;
    readonly contentLength: number;
    readonly readIdentity: AzureBlobReadIdentity;
  } | null> {
    if (this.#options.role === "backup-writer") throw new AzureArtifactStoreError();
    const objectKey = key(input.objectKey);
    const name = this.#name(objectKey);
    const op = this.#operation(input.signal);
    let handedOff = false;
    try {
      let blob = op.client.getBlobClient(name);
      let version: string | undefined;
      let listedLength: number | undefined;
      if (this.#options.role === "restore-reader") {
        const items = await this.#versions(op.client, name, op.signal);
        if (items.length === 0) return null;
        const item = items[0];
        if (
          items.length !== 1 ||
          !item ||
          item.deleted ||
          item.snapshot ||
          !item.isCurrentVersion ||
          item.properties.blobType !== "BlockBlob" ||
          !Number.isSafeInteger(item.properties.contentLength) ||
          item.properties.contentLength === undefined ||
          item.properties.contentLength <= 0 ||
          item.properties.contentLength > this.#maximum
        )
          throw new AzureArtifactStoreError();
        version = readVersion(item.versionId);
        listedLength = item.properties.contentLength;
        blob = blob.withVersion(version);
      }
      const result = await blob.download(0, undefined, {
        abortSignal: op.signal,
        maxRetryRequests: 0,
      });
      const stream = result.readableStreamBody;
      if (
        !(stream instanceof Readable) ||
        result._response.status !== 200 ||
        !Number.isSafeInteger(result.contentLength) ||
        result.contentLength === undefined ||
        result.contentLength <= 0 ||
        result.contentLength > this.#maximum ||
        (version !== undefined &&
          (result.versionId !== version || result.contentLength !== listedLength))
      ) {
        stream?.destroy();
        throw new AzureArtifactStoreError();
      }
      const readIdentity: AzureBlobReadIdentity = Object.freeze({
        containerUrl: this.#options.containerUrl,
        prefix: this.#options.prefix,
        objectKey,
        blobName: name,
        contentLength: result.contentLength,
        ...(version === undefined
          ? { kind: "azure-blob-current" as const }
          : { kind: "azure-blob-version" as const, versionId: readVersion(result.versionId) }),
      });
      if (Buffer.byteLength(JSON.stringify(readIdentity)) > 8192) {
        stream.destroy();
        throw new AzureArtifactStoreError();
      }
      const completion = op.downloadCompletion();
      // The SDK may convert a late source error to EOF after its expected byte count.
      // Require the independently checked transport completion as well.
      const guarded = Readable.from(
        (async function* () {
          try {
            for await (const chunk of stream) {
              if (op.signal.aborted) throw new AzureArtifactStoreError();
              yield chunk;
            }
            await completion;
            if (op.signal.aborted) throw new AzureArtifactStoreError();
          } catch {
            throw new AzureArtifactStoreError();
          }
        })(),
      );
      const abort = () => {
        stream.destroy(new AzureArtifactStoreError());
        guarded.destroy(new AzureArtifactStoreError());
      };
      op.signal.addEventListener("abort", abort, { once: true });
      guarded.on("error", () => undefined);
      stream.on("error", () => undefined);
      guarded.once("close", () => {
        op.signal.removeEventListener("abort", abort);
        stream.destroy();
        op.close();
      });
      if (op.signal.aborted) abort();
      handedOff = true;
      return { stream: guarded, contentLength: result.contentLength, readIdentity };
    } catch (error) {
      if (this.#options.role !== "restore-reader" && failure(error).statusCode === 404) return null;
      throw failure(error);
    } finally {
      if (!handedOff) op.close();
    }
  }

  /** A complete exact-name inventory must be empty before deletion can finish. */
  async delete(input: {
    readonly objectKey: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (this.#options.role !== "export-writer") throw new AzureArtifactStoreError();
    const name = this.#name(input.objectKey);
    const op = this.#operation(input.signal);
    try {
      if (!op.observer || op.signal.aborted) throw new AzureArtifactStoreError();
      try {
        const result = await op.client
          .getBlobClient(name)
          .delete({ abortSignal: op.signal, deleteSnapshots: "include" });
        if (result._response.status !== 202) throw new AzureArtifactStoreError();
      } catch (error) {
        if (failure(error).statusCode !== 404) throw failure(error);
      }
      if ((await this.#versions(op.observer, name, op.signal)).length !== 0 || op.signal.aborted)
        throw new AzureArtifactStoreError();
    } catch (error) {
      throw failure(error);
    } finally {
      op.close();
    }
  }
}
