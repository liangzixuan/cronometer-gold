import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { RestError } from "@azure/core-rest-pipeline";
import { ContainerClient, newPipeline } from "@azure/storage-blob";
import { AzureArtifactStoreError, azureBlobHttpClient } from "./azure-blob-http-client.js";
import {
  AzureBlobRawArtifactStore,
  type AzureBlobReadIdentity,
  validateAzureBlobProbeCredential,
} from "./azure-blob-raw-artifact-store.js";

export interface AzureBlobCredentialCanaryConfiguration {
  readonly exports: {
    readonly containerUrl: string;
    readonly prefix: string;
    readonly readerSas: string;
    readonly writerSas: string;
    readonly observerSas: string;
  };
  readonly ledger: {
    readonly containerUrl: string;
    readonly prefix: string;
    readonly writerSas: string;
    readonly restoreSas: string;
  };
}

export class AzureBlobCredentialCanaryError extends AzureArtifactStoreError {
  constructor(readonly canaryId: string) {
    super();
    this.name = "AzureBlobCredentialCanaryError";
  }
}

export interface AzureBlobCredentialCanaryExecution {
  readonly signal?: AbortSignal;
  readonly onStart: (
    identity: Readonly<{ canaryId: string; exportKey: string; ledgerKey: string }>,
  ) => void | Promise<void>;
}

export interface AzureBlobCredentialCanaryResult {
  readonly canaryId: string;
  readonly exportCleanupVerified: true;
  readonly ledgerCanaryRetained: true;
  readonly ledgerVersionVerified: true;
}

const PAYLOAD_BYTES = 64;
const DEADLINE_MS = 60_000;
const REQUEST_MS = 5_000;

/** Validates supplied grants without authenticating or discovering credentials. */
export function validateAzureBlobCredentialCanaryConfiguration(
  input: AzureBlobCredentialCanaryConfiguration,
): AzureBlobCredentialCanaryConfiguration {
  return snapshotConfiguration(input, Date.now() + DEADLINE_MS + REQUEST_MS);
}

function snapshotConfiguration(
  input: AzureBlobCredentialCanaryConfiguration,
  minimumExpiry: number,
): AzureBlobCredentialCanaryConfiguration {
  const exports = Object.freeze({ ...input.exports });
  const ledger = Object.freeze({ ...input.ledger });
  const credentials = [
    [exports, exports.readerSas, "r"],
    [exports, exports.writerSas, "rcd"],
    [exports, exports.observerSas, "l"],
    [ledger, ledger.writerSas, "rc"],
    [ledger, ledger.restoreSas, "rl"],
  ] as const;
  for (const [location, sasToken, permission] of credentials) {
    const expires = validateAzureBlobProbeCredential({ ...location, sasToken }, permission);
    if (expires <= minimumExpiry) throw new AzureArtifactStoreError();
  }
  if (
    new URL(exports.containerUrl).origin === new URL(ledger.containerUrl).origin ||
    new Set(credentials.map(([, token]) => token)).size !== credentials.length
  )
    throw new AzureArtifactStoreError();
  return Object.freeze({ exports, ledger });
}

/** Real SDK probes; a local role guard is never accepted as provider denial. */
export async function runAzureBlobCredentialCanary(
  input: AzureBlobCredentialCanaryConfiguration,
  execution: AzureBlobCredentialCanaryExecution,
): Promise<AzureBlobCredentialCanaryResult> {
  const minimumExpiry = Date.now() + DEADLINE_MS + REQUEST_MS;
  const config = snapshotConfiguration(input, minimumExpiry);
  if (typeof execution.onStart !== "function") throw new AzureArtifactStoreError();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(execution.signal ? [execution.signal] : []),
  ]);
  const token = randomBytes(16).toString("hex");
  const exportKey = `exports/v1/credential-canary/${token}`;
  const ledgerKey = `erasure-ledger/v1/credential-canary/${token}`;
  const payload = randomBytes(PAYLOAD_BYTES);
  const { exports, ledger } = config;
  const store = (
    location: typeof ledger | typeof exports,
    sasToken: string,
    role: "reader" | "export-writer" | "ledger-writer" | "restore-reader",
  ) =>
    new AzureBlobRawArtifactStore({
      containerUrl: location.containerUrl,
      prefix: location.prefix,
      sasToken,
      role,
      ...(role === "export-writer" ? { deletionObserverSasToken: exports.observerSas } : {}),
      requestTimeoutMs: REQUEST_MS,
      maximumObjectBytes: PAYLOAD_BYTES,
      ...(role === "restore-reader"
        ? {
            restoreReadBudget: {
              maximumRequests: 8,
              maximumHeaderBytes: 65536,
              maximumBodyBytes: 131072,
            },
          }
        : {}),
    });
  const writer = store(exports, exports.writerSas, "export-writer");
  const reader = store(exports, exports.readerSas, "reader");
  const ledgerWriter = store(ledger, ledger.writerSas, "ledger-writer");
  const restore = store(ledger, ledger.restoreSas, "restore-reader");
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);

  async function read(client: AzureBlobRawArtifactStore, objectKey: string) {
    const result = await client.open({ objectKey, signal });
    if (!result || result.contentLength !== PAYLOAD_BYTES) {
      result?.stream.destroy();
      throw new AzureArtifactStoreError();
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of result.stream) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > PAYLOAD_BYTES || signal.aborted) throw new AzureArtifactStoreError();
        chunks.push(bytes);
      }
      if (length !== PAYLOAD_BYTES || !timingSafeEqual(Buffer.concat(chunks), payload))
        throw new AzureArtifactStoreError();
      return result.readIdentity;
    } finally {
      result.stream.destroy();
    }
  }

  // Each direct probe gets one bounded request, including any SDK redirect attempt.
  async function denied(
    location: typeof ledger | typeof exports,
    sasToken: string,
    operation: (client: ContainerClient, requestSignal: AbortSignal) => Promise<unknown>,
    code = "AuthorizationPermissionMismatch",
  ) {
    snapshotConfiguration(config, minimumExpiry);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    const transport = azureBlobHttpClient({
      containerUrl: location.containerUrl,
      signal: requestSignal,
      maximumObjectBytes: PAYLOAD_BYTES,
      onDownloadCompletion(completion) {
        void completion.catch(() => undefined);
      },
    });
    let requests = 0;
    let observedDenial = false;
    const client = new ContainerClient(
      `${location.containerUrl}?${sasToken}`,
      newPipeline(undefined, {
        retryOptions: { maxTries: 1 },
        keepAliveOptions: { enable: false },
        httpClient: {
          async sendRequest(request) {
            if (++requests !== 1) throw new AzureArtifactStoreError();
            const response = await transport.sendRequest(request);
            // Close an unexpected successful download before reporting failure.
            if (response.readableStreamBody instanceof Readable)
              response.readableStreamBody.destroy();
            observedDenial =
              response.status === 403 &&
              response.headers.get("x-ms-error-code") === code &&
              !!response.headers.get("x-ms-request-id") &&
              typeof response.bodyAsText === "string";
            return response;
          },
        },
      }),
    );
    try {
      await operation(client, requestSignal);
    } catch (error) {
      if (
        !signal.aborted &&
        !requestSignal.aborted &&
        requests === 1 &&
        observedDenial &&
        error instanceof RestError &&
        error.statusCode === 403 &&
        error.code === code
      )
        return;
      throw new AzureArtifactStoreError();
    }
    throw new AzureArtifactStoreError();
  }
  const exportName = exports.prefix + exportKey;
  const ledgerName = ledger.prefix + ledgerKey;
  const overwrite = (name: string) => (client: ContainerClient, abortSignal: AbortSignal) =>
    client.getBlockBlobClient(name).upload(payload, payload.length, { abortSignal });
  const remove = (name: string) => (client: ContainerClient, abortSignal: AbortSignal) =>
    client.getBlobClient(name).delete({ abortSignal });
  const list = (name: string) => async (client: ContainerClient, abortSignal: AbortSignal) => {
    await client.listBlobsFlat({ prefix: name, abortSignal }).byPage({ maxPageSize: 1 }).next();
  };
  const download = (name: string) => async (client: ContainerClient, abortSignal: AbortSignal) => {
    const result = await client
      .getBlobClient(name)
      .download(0, undefined, { abortSignal, maxRetryRequests: 0 });
    result.readableStreamBody?.destroy();
  };
  async function observeExport() {
    snapshotConfiguration(config, minimumExpiry);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    const transport = azureBlobHttpClient({
      containerUrl: exports.containerUrl,
      signal: requestSignal,
      maximumObjectBytes: PAYLOAD_BYTES,
      onDownloadCompletion() {
        throw new AzureArtifactStoreError();
      },
    });
    let requests = 0;
    const client = new ContainerClient(
      `${exports.containerUrl}?${exports.observerSas}`,
      newPipeline(undefined, {
        retryOptions: { maxTries: 1 },
        keepAliveOptions: { enable: false },
        httpClient: {
          sendRequest(request) {
            if (++requests !== 1) throw new AzureArtifactStoreError();
            return transport.sendRequest(request);
          },
        },
      }),
    );
    const { value: page, done } = await client
      .listBlobsFlat({
        prefix: exportName,
        includeVersions: true,
        includeSnapshots: true,
        includeDeleted: true,
        includeDeletedWithVersions: true,
        includeUncommitedBlobs: true,
        abortSignal: requestSignal,
      })
      .byPage({ maxPageSize: 16 })
      .next();
    const item = page?.segment?.blobItems?.[0];
    if (
      done ||
      requestSignal.aborted ||
      requests !== 1 ||
      page.serviceEndpoint !== `${new URL(exports.containerUrl).origin}/` ||
      page.containerName !== new URL(exports.containerUrl).pathname.slice(1) ||
      page.prefix !== exportName ||
      page.maxPageSize !== 16 ||
      page.continuationToken !== "" ||
      page.segment.blobItems.length !== 1 ||
      !item ||
      item.name !== exportName ||
      item.deleted ||
      item.snapshot ||
      item.versionId ||
      item.isCurrentVersion ||
      item.properties.blobType !== "BlockBlob" ||
      item.properties.contentLength !== PAYLOAD_BYTES
    )
      throw new AzureArtifactStoreError();
  }
  function exactVersion(identity: AzureBlobReadIdentity, expected?: string) {
    if (
      identity.kind !== "azure-blob-version" ||
      (expected !== undefined && identity.versionId !== expected)
    )
      throw new AzureArtifactStoreError();
    return identity.versionId;
  }
  try {
    if (signal.aborted) throw new AzureArtifactStoreError();
    let cancelPublication = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPublication = () => reject(new AzureArtifactStoreError());
      signal.addEventListener("abort", cancelPublication, { once: true });
      if (signal.aborted) cancelPublication();
    });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          execution.onStart(Object.freeze({ canaryId: token, exportKey, ledgerKey })),
        ),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener("abort", cancelPublication);
    }

    if (signal.aborted) throw new AzureArtifactStoreError();
    await writer.put({
      objectKey: exportKey,
      source: Readable.from([payload]),
      contentLength: payload.length,
      signal,
    });
    await ledgerWriter.put({
      objectKey: ledgerKey,
      source: Readable.from([payload]),
      contentLength: payload.length,
      signal,
    });
    await read(writer, exportKey);
    await read(reader, exportKey);
    await read(ledgerWriter, ledgerKey);
    const version = exactVersion(await read(restore, ledgerKey));
    await observeExport();
    await denied(exports, exports.readerSas, overwrite(exportName));
    await denied(exports, exports.readerSas, remove(exportName));
    await denied(exports, exports.writerSas, list(exportName));
    await denied(exports, exports.observerSas, download(exportName));
    await denied(exports, exports.observerSas, overwrite(exportName));
    await denied(exports, exports.observerSas, remove(exportName));
    await denied(ledger, ledger.writerSas, overwrite(ledgerName));
    await denied(ledger, ledger.writerSas, remove(ledgerName));
    await denied(ledger, ledger.writerSas, list(ledgerName));
    await denied(ledger, ledger.restoreSas, overwrite(ledgerName));
    await denied(ledger, ledger.restoreSas, remove(ledgerName));
    await denied(ledger, exports.readerSas, download(ledgerName), "AuthenticationFailed");
    await denied(exports, ledger.restoreSas, download(exportName), "AuthenticationFailed");
    // Positive controls exclude revoked/expired credentials and changed native versions.
    await read(writer, exportKey);
    await read(reader, exportKey);
    await read(ledgerWriter, ledgerKey);
    exactVersion(await read(restore, ledgerKey), version);
    await observeExport();
    snapshotConfiguration(config, minimumExpiry);
    // Cleanup only follows complete evidence. Uncertain or failed runs retain both objects.
    await writer.delete({ objectKey: exportKey, signal });
    if (signal.aborted) throw new AzureArtifactStoreError();
    return {
      canaryId: token,
      exportCleanupVerified: true,
      ledgerCanaryRetained: true,
      ledgerVersionVerified: true,
    };
  } catch {
    throw new AzureBlobCredentialCanaryError(token);
  } finally {
    clearTimeout(timer);
    controller.abort();
    payload.fill(0);
  }
}
