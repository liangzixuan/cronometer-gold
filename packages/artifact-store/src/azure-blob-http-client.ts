import { Agent } from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createDefaultHttpClient,
  createHttpHeaders,
  createPipelineRequest,
  type HttpClient,
} from "@azure/core-rest-pipeline";
import type { HttpOperationResponse, IHttpClient } from "@azure/storage-blob";

export class AzureArtifactStoreError extends Error {
  constructor(readonly statusCode: number | null = null) {
    super("Azure artifact storage operation failed");
    this.name = "AzureArtifactStoreError";
  }
}

export interface AzureRestoreReadLimits {
  readonly maximumRequests: number;
  readonly maximumHeaderBytes: number;
  readonly maximumBodyBytes: number;
}

/** Protective ledger policy; a live invocation needs separate authority. */
export const AZURE_LEDGER_RESTORE_READ_BUDGET: AzureRestoreReadLimits = Object.freeze({
  maximumRequests: 4096,
  maximumHeaderBytes: 8_388_608,
  maximumBodyBytes: 67_108_864,
});

/** Private to one configured store; counts observations at the native HTTP boundary. */
export class AzureRestoreReadBudget {
  readonly #limits: AzureRestoreReadLimits;
  readonly #controller = new AbortController();
  #unsafe = false;
  readonly #usage = {
    requestAttempts: 0,
    listAttempts: 0,
    downloadAttempts: 0,
    responses: 0,
    nonSuccessResponses: 0,
    failedRequests: 0,
    settledRequests: 0,
    headerBytes: 0,
    bodyBytes: 0,
  };
  constructor(value: AzureRestoreReadLimits) {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      throw new AzureArtifactStoreError();
    const fields = Object.keys(
      AZURE_LEDGER_RESTORE_READ_BUDGET,
    ) as (keyof AzureRestoreReadLimits)[];
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((k) => typeof k !== "string" || !fields.includes(k as keyof AzureRestoreReadLimits))
    )
      throw new AzureArtifactStoreError();
    const copy = {} as Record<keyof AzureRestoreReadLimits, number>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "number" ||
        !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 1 ||
        descriptor.value > AZURE_LEDGER_RESTORE_READ_BUDGET[field]
      )
        throw new AzureArtifactStoreError();
      copy[field] = descriptor.value;
    }
    this.#limits = Object.freeze(copy);
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  #refuse(): never {
    this.#controller.abort(new AzureArtifactStoreError());
    throw new AzureArtifactStoreError();
  }
  #add(
    field:
      | "requestAttempts"
      | "listAttempts"
      | "downloadAttempts"
      | "responses"
      | "nonSuccessResponses"
      | "failedRequests"
      | "settledRequests"
      | "headerBytes"
      | "bodyBytes",
    bytes: number,
  ): void {
    const total = this.#usage[field] + bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(total)) {
      this.#unsafe = true;
      this.#refuse();
    }
    this.#usage[field] = total;
  }
  snapshot() {
    if (this.#unsafe) throw new AzureArtifactStoreError();
    return Object.freeze({
      ...this.#usage,
      activeRequests: this.#usage.requestAttempts - this.#usage.settledRequests,
    });
  }
  begin(operation: "list" | "download") {
    if (this.signal.aborted || this.#usage.requestAttempts >= this.#limits.maximumRequests)
      this.#refuse();
    this.#add("requestAttempts", 1);
    this.#add(operation === "list" ? "listAttempts" : "downloadAttempts", 1);
    let settled = false;
    let nonSuccess = false;
    return {
      response: (status: number, headerBytes: number) => {
        this.#add("responses", 1);
        nonSuccess = status < 200 || status >= 300;
        if (nonSuccess) this.#add("nonSuccessResponses", 1);
        this.#add("headerBytes", headerBytes);
        if (this.#usage.headerBytes > this.#limits.maximumHeaderBytes) this.#refuse();
        if (headerBytes > 8192 || this.signal.aborted) throw new AzureArtifactStoreError();
      },
      body: (bytes: number) => {
        this.#add("bodyBytes", bytes);
        if (this.#usage.bodyBytes > this.#limits.maximumBodyBytes) this.#refuse();
        if (this.signal.aborted) throw new AzureArtifactStoreError();
      },
      settle: (failed: boolean) => {
        if (settled) return;
        settled = true;
        this.#add("settledRequests", 1);
        if (failed || nonSuccess) this.#add("failedRequests", 1);
      },
    };
  }
}

/** Fixed service-key endpoint; no container/data operation can use this transport. */
export function azureBlobDelegationHttpClient(input: {
  readonly serviceUrl: string;
  readonly signal: AbortSignal;
}): IHttpClient {
  const base = new URL(input.serviceUrl);
  if (
    base.origin !== input.serviceUrl ||
    !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(input.serviceUrl)
  )
    throw new AzureArtifactStoreError();
  return boundedHttpClient(
    {
      containerUrl: base.origin + "/",
      signal: input.signal,
      maximumObjectBytes: 16384,
      onDownloadCompletion() {
        throw new AzureArtifactStoreError();
      },
    },
    true,
  );
}

/** SDK HTTP extension: bound bytes before its XML deserializer sees them. */
export function azureBlobHttpClient(input: {
  readonly containerUrl: string;
  readonly signal: AbortSignal;
  readonly maximumObjectBytes: number;
  readonly onDownloadCompletion: (completion: Promise<void>) => void;
  readonly restoreReadBudget?: AzureRestoreReadBudget;
}): IHttpClient {
  return boundedHttpClient(input, false);
}

export interface AzureInventoryResponse {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly consumedBytes: number;
  readonly complete: boolean;
}
export interface AzureInventoryTransportInput {
  readonly serviceUrl: string;
  readonly containerName: string;
  readonly blockNames: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly begin: (
    operation: "containers" | "blobs" | "blocks",
    name: string | null,
    marker: string | null,
  ) => {
    readonly signal: AbortSignal;
    readonly finish: (response: AzureInventoryResponse) => Promise<void>;
  };
}

/** Operator enumeration only. Application credentials never use this scope. */
export function azureBlobInventoryHttpClient(input: AzureInventoryTransportInput): IHttpClient {
  return inventoryClient(input);
}
/** Nonnetwork evidence replay; the live producer never selects this entrypoint. */
export function azureBlobInventoryReplayClient(
  input: AzureInventoryTransportInput,
  responseSource: HttpClient,
): IHttpClient {
  if (!responseSource || typeof responseSource.sendRequest !== "function")
    throw new AzureArtifactStoreError();
  return inventoryClient(input, responseSource);
}
function inventoryClient(
  input: AzureInventoryTransportInput,
  responseSource?: HttpClient,
): IHttpClient {
  if (
    !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(input.serviceUrl) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.containerName)
  )
    throw new AzureArtifactStoreError();
  return boundedHttpClient(
    {
      containerUrl: input.serviceUrl + "/",
      signal: input.signal,
      maximumObjectBytes: 0,
      onDownloadCompletion() {
        throw new AzureArtifactStoreError();
      },
    },
    false,
    input,
    responseSource,
  );
}

function inventoryOperation(url: URL, input: AzureInventoryTransportInput) {
  const q = url.searchParams;
  if (new Set(q.keys()).size !== q.size) throw new AzureArtifactStoreError();
  const include = (value: string) => q.get("include")?.split(",").sort().join(",") === value;
  let operation: "containers" | "blobs" | "blocks",
    name: string | null = null;
  let keys: string[];
  if (url.pathname === "/" && q.get("comp") === "list" && include("deleted,system")) {
    operation = "containers";
    keys = ["comp", "include", "maxresults", "marker"];
  } else if (
    url.pathname === "/" + input.containerName &&
    q.get("comp") === "list" &&
    q.get("restype") === "container" &&
    include("deleted,deletedwithversions,snapshots,uncommittedblobs,versions")
  ) {
    operation = "blobs";
    keys = ["comp", "restype", "include", "maxresults", "marker"];
  } else if (
    url.pathname.startsWith("/" + input.containerName + "/") &&
    q.get("comp") === "blocklist" &&
    q.get("blocklisttype") === "all"
  ) {
    operation = "blocks";
    keys = ["comp", "blocklisttype"];
    name = decodeURIComponent(url.pathname.slice(input.containerName.length + 2));
    if (!input.blockNames.has(name)) throw new AzureArtifactStoreError();
  } else throw new AzureArtifactStoreError();
  if (
    [...q.keys()].some((key) => !keys.includes(key)) ||
    (operation !== "blocks" && q.get("maxresults") !== "16") ||
    (q.has("marker") && (!q.get("marker") || Buffer.byteLength(q.get("marker") ?? "") > 8192))
  )
    throw new AzureArtifactStoreError();
  return { operation, name, marker: q.get("marker") };
}

function boundedHttpClient(
  input: Parameters<typeof azureBlobHttpClient>[0],
  delegation: boolean,
  inventory?: AzureInventoryTransportInput,
  responseSource?: HttpClient,
): IHttpClient {
  const base = new URL(input.containerUrl);
  const native = responseSource ?? createDefaultHttpClient();
  return {
    async sendRequest(request): Promise<HttpOperationResponse> {
      const url = new URL(request.url);
      if (
        url.origin !== base.origin ||
        (!inventory &&
          !(url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname}/`))) ||
        url.username ||
        url.password ||
        url.hash ||
        input.signal.aborted ||
        (inventory
          ? request.method !== "GET" || request.body !== undefined
          : delegation
            ? request.method !== "POST" ||
              url.pathname !== "/" ||
              url.searchParams.size !== 2 ||
              url.searchParams.get("restype") !== "service" ||
              url.searchParams.get("comp") !== "userdelegationkey"
            : !["GET", "PUT", "DELETE", "HEAD"].includes(request.method))
      ) {
        throw new AzureArtifactStoreError();
      }
      const budget = input.restoreReadBudget;
      const budgetOperation =
        url.pathname === base.pathname &&
        url.searchParams.get("restype") === "container" &&
        url.searchParams.get("comp") === "list"
          ? "list"
          : url.pathname.startsWith(`${base.pathname}/`) &&
              url.searchParams.getAll("versionid").length === 1 &&
              url.searchParams.get("versionid") &&
              !url.searchParams.has("comp")
            ? "download"
            : undefined;
      if (
        budget &&
        (inventory ||
          delegation ||
          request.method !== "GET" ||
          request.body !== undefined ||
          !budgetOperation)
      )
        throw new AzureArtifactStoreError();
      const selected = inventory ? inventoryOperation(url, inventory) : undefined;
      const lease =
        selected && inventory?.begin(selected.operation, selected.name, selected.marker);
      const activeSignal = lease?.signal ?? input.signal;
      let consumedBytes = 0,
        status: number | null = null,
        complete = false;
      let retainedHeaders: Record<string, string> = {};
      const retainedChunks: Buffer[] = [];
      const agent = new Agent({ keepAlive: false, maxSockets: 1 });
      let body: Readable | undefined;
      let attempt: ReturnType<AzureRestoreReadBudget["begin"]> | undefined;
      const stop = () => {
        body?.destroy(new AzureArtifactStoreError());
        agent.destroy();
      };
      activeSignal.addEventListener("abort", stop, { once: true });
      const cleanup = () => {
        activeSignal.removeEventListener("abort", stop);
        agent.destroy();
      };
      try {
        const outbound = createPipelineRequest({
          url: request.url,
          method: request.method,
          headers: createHttpHeaders({
            ...request.headers.toJson(),
            "accept-encoding": "identity",
          }),
          body: request.body,
          abortSignal: activeSignal,
          allowInsecureConnection: false,
          agent,
          disableKeepAlive: true,
          requestOverrides: { maxHeaderSize: 8192, rejectUnauthorized: true },
          streamResponseStatusCodes: new Set([Number.POSITIVE_INFINITY]),
        });
        if (activeSignal.aborted) throw new AzureArtifactStoreError();
        if (budget && budgetOperation) attempt = budget.begin(budgetOperation);
        const response = await native.sendRequest(outbound);
        body = response.readableStreamBody as Readable | undefined;
        if (attempt && body instanceof Readable) body.once("error", () => undefined);
        status = response.status;
        if (attempt) {
          let headerBytes = 0;
          for (const [name, value] of response.headers)
            headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
          attempt.response(response.status, headerBytes);
          if (activeSignal.aborted) throw new AzureArtifactStoreError();
        }
        const headers = request.headers.clone();
        for (const name of headers.headerNames()) headers.remove(name);
        for (const [name, value] of response.headers) headers.set(name, value);
        if (inventory) {
          let headerBytes = 0;
          for (const [name, value] of response.headers)
            headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
          if (headerBytes > 8192) throw new AzureArtifactStoreError();
          const declared = response.headers.get("content-length");
          if (
            declared !== undefined &&
            (!/^[0-9]+$/.test(declared) || Number(declared) > 1_048_576)
          )
            throw new AzureArtifactStoreError();
          // Only noncredential response identity headers are retained.
          retainedHeaders = Object.fromEntries(
            ["etag", "x-ms-request-id", "x-ms-version", "content-type", "content-length"]
              .filter((key) => response.headers.has(key))
              .map((key) => [key, response.headers.get(key) ?? ""]),
          );
        }
        if (
          !(body instanceof Readable) ||
          (response.status >= 300 && response.status < 400) ||
          (headers.get("content-encoding") !== undefined &&
            headers.get("content-encoding") !== "identity")
        ) {
          throw new AzureArtifactStoreError(response.status);
        }
        const streaming =
          !inventory &&
          !delegation &&
          request.streamResponseStatusCodes?.has(response.status) === true;
        if (streaming) {
          const length = Number(headers.get("content-length"));
          if (!Number.isSafeInteger(length) || length < 1 || length > input.maximumObjectBytes) {
            throw new AzureArtifactStoreError(response.status);
          }
          let count = 0;
          const checked = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              try {
                attempt?.body(chunk.byteLength);
                if (attempt && activeSignal.aborted) throw new AzureArtifactStoreError();
                count += chunk.byteLength;
                callback(count > length ? new AzureArtifactStoreError() : null, chunk);
              } catch {
                callback(new AzureArtifactStoreError());
              }
            },
            flush(callback) {
              callback(
                count === length && !(attempt && activeSignal.aborted)
                  ? null
                  : new AzureArtifactStoreError(),
              );
            },
          });
          // The caller owns this stream; closing it also closes the source and socket.
          const source = body;
          checked.once("close", () => {
            source.destroy();
            cleanup();
          });
          const completion = pipeline(source, checked)
            .then(() => {
              if (attempt && activeSignal.aborted) throw new AzureArtifactStoreError();
              attempt?.settle(false);
            })
            .catch(() => {
              attempt?.settle(true);
              throw new AzureArtifactStoreError();
            });
          void completion.catch(() => undefined);
          input.onDownloadCompletion(completion);
          return { request, status: response.status, headers, readableStreamBody: checked };
        }
        const chunks: Buffer[] = [];
        let count = 0;
        for await (const raw of body) {
          const chunk = Buffer.from(raw as Uint8Array);
          attempt?.body(chunk.byteLength);
          if (attempt && activeSignal.aborted) throw new AzureArtifactStoreError();
          count += chunk.byteLength;
          consumedBytes = count;
          if (inventory && count - chunk.byteLength < 1_048_576)
            retainedChunks.push(
              chunk.subarray(0, Math.max(0, 1_048_576 - (count - chunk.byteLength))),
            );
          if (count > (delegation ? 16384 : 1_048_576))
            throw new AzureArtifactStoreError(response.status);
          chunks.push(chunk);
        }
        if (inventory && (response.status !== 200 || activeSignal.aborted))
          throw new AzureArtifactStoreError();
        if (attempt && activeSignal.aborted) throw new AzureArtifactStoreError();
        complete = true;
        attempt?.settle(false);
        cleanup();
        return {
          request,
          status: response.status,
          headers,
          bodyAsText: Buffer.concat(chunks).toString("utf8"),
        };
      } catch {
        attempt?.settle(true);
        body?.destroy();
        cleanup();
        throw new AzureArtifactStoreError();
      } finally {
        if (lease)
          await lease.finish({
            status,
            headers: retainedHeaders,
            body: Buffer.concat(retainedChunks),
            consumedBytes,
            complete,
          });
      }
    },
  };
}
