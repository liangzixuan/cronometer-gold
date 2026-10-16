import { Readable } from "node:stream";
import type { PipelineRequest, PipelineResponse } from "@azure/core-rest-pipeline";
import { createHttpHeaders } from "@azure/core-rest-pipeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedArtifactStore, type RawArtifactStore } from "./artifact-encryption.js";
import {
  AZURE_LEDGER_RESTORE_READ_BUDGET,
  AzureArtifactStoreError,
  AzureBlobRawArtifactStore,
  isAzureBlobContainerUrl,
  snapshotAzureBlobVersionReadIdentity,
  validateAzureBlobCredential,
} from "./azure-blob-raw-artifact-store.js";
import {
  deriveErasureLedgerLocator,
  parseErasureLedgerLocatorKeyRing,
} from "./erasure-ledger-locator.js";
import { EncryptedErasureReplayLedger } from "./erasure-replay-ledger.js";

describe("aggregate Azure ledger read consumption", () => {
  function queue(
    status: number,
    body: string | Buffer | Readable = "",
    headers: Record<string, string> = {},
  ) {
    wire.send.mockImplementationOnce(async (r: PipelineRequest) =>
      response(r, status, body, {
        ...(typeof body === "string" && body.startsWith("<")
          ? { "content-type": "application/xml" }
          : {}),
        ...headers,
      }),
    );
  }
  function budgetStore(overrides: Partial<typeof AZURE_LEDGER_RESTORE_READ_BUDGET> = {}) {
    return new AzureBlobRawArtifactStore({
      ...options("restore-reader"),
      maximumObjectBytes: 16_512,
      restoreReadBudget: { ...AZURE_LEDGER_RESTORE_READ_BUDGET, ...overrides },
    });
  }
  function emptyUsage() {
    return {
      requestAttempts: 0,
      listAttempts: 0,
      downloadAttempts: 0,
      responses: 0,
      nonSuccessResponses: 0,
      failedRequests: 0,
      settledRequests: 0,
      activeRequests: 0,
      headerBytes: 0,
      bodyBytes: 0,
    };
  }
  const objectKey = "exports/v1/user/item.enc";

  it("retains charged missing histories across opens and freezes only scalar snapshots", async () => {
    const store = budgetStore({ maximumRequests: 2 });
    const original = store.restoreReadUsage();
    queue(200, listing(""));
    queue(200, listing(""));
    expect(await store.open({ objectKey })).toBeNull();
    expect(await store.open({ objectKey })).toBeNull();
    const usage = store.restoreReadUsage();
    expect(usage).toEqual({
      ...emptyUsage(),
      requestAttempts: 2,
      listAttempts: 2,
      responses: 2,
      settledRequests: 2,
      headerBytes: 2 * (19 + 31),
      bodyBytes: 2 * Buffer.byteLength(listing("")),
    });
    expect(Object.isFrozen(usage)).toBe(true);
    expect(original).toEqual(emptyUsage());
    await expect(store.open({ objectKey })).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(2);
    expect(store.restoreReadUsage()).toEqual(usage);
    expect(budgetStore().restoreReadUsage()).toEqual(emptyUsage());
    expect(() =>
      new AzureBlobRawArtifactStore(options("restore-reader")).restoreReadUsage(),
    ).toThrow();
    expect(JSON.stringify(usage)).not.toMatch(/synthetic|https:|exports|sig|secret|key|version/i);
  });

  it("counts every page and the selected download, then ignores normal later disposal", async () => {
    const store = budgetStore();
    queue(200, listing(item(), "next"));
    queue(200, listing(""));
    queue(200, "abc", { "content-length": "3", "x-ms-version-id": "v1" });
    const opened = await store.open({ objectKey });
    if (!opened) throw new Error("Expected object");
    expect(await collect(opened.stream)).toEqual(Buffer.from("abc"));
    const usage = store.restoreReadUsage();
    expect(usage).toMatchObject({
      requestAttempts: 3,
      listAttempts: 2,
      downloadAttempts: 1,
      responses: 3,
      settledRequests: 3,
      activeRequests: 0,
      failedRequests: 0,
      bodyBytes: Buffer.byteLength(listing(item(), "next")) + Buffer.byteLength(listing("")) + 3,
    });
    opened.stream.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.restoreReadUsage()).toEqual(usage);
  });

  it.each(["throw", "reject"] as const)(
    "charges a native %s without inventing response observations",
    async (mode) => {
      const store = budgetStore({ maximumRequests: 2 });
      wire.send.mockImplementationOnce(() => {
        if (mode === "throw") throw new Error("private transport secret");
        return Promise.reject(new Error("private transport secret"));
      });
      await expect(store.open({ objectKey })).rejects.toThrow(
        "Azure artifact storage operation failed",
      );
      expect(store.restoreReadUsage()).toEqual({
        ...emptyUsage(),
        requestAttempts: 1,
        listAttempts: 1,
        failedRequests: 1,
        settledRequests: 1,
      });
      queue(200, listing(""));
      expect(await store.open({ objectKey })).toBeNull();
      expect(store.restoreReadUsage()).toMatchObject({
        requestAttempts: 2,
        failedRequests: 1,
        settledRequests: 2,
      });
    },
  );

  it.each([0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "1", null])(
    "rejects invalid limits without traffic: %s",
    (value) => {
      expect(() => budgetStore({ maximumRequests: value as number })).toThrow();
      expect(wire.send).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed records and roles without invoking limit getters", () => {
    const getter = vi.fn(() => 1);
    const bad = [
      null,
      [],
      Object.create(null),
      { ...AZURE_LEDGER_RESTORE_READ_BUDGET, extra: 1 },
      { ...AZURE_LEDGER_RESTORE_READ_BUDGET, [Symbol("private")]: 1 },
      Object.defineProperty({ ...AZURE_LEDGER_RESTORE_READ_BUDGET }, "maximumRequests", {
        get: getter,
      }),
      { ...AZURE_LEDGER_RESTORE_READ_BUDGET, maximumHeaderBytes: 8_388_609 },
      { ...AZURE_LEDGER_RESTORE_READ_BUDGET, maximumBodyBytes: 67_108_865 },
    ];
    for (const restoreReadBudget of bad)
      expect(
        () =>
          new AzureBlobRawArtifactStore({
            ...options("restore-reader"),
            restoreReadBudget: restoreReadBudget as typeof AZURE_LEDGER_RESTORE_READ_BUDGET,
          }),
      ).toThrow();
    expect(
      () =>
        new AzureBlobRawArtifactStore({
          ...options("reader"),
          restoreReadBudget: AZURE_LEDGER_RESTORE_READ_BUDGET,
        }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(wire.send).not.toHaveBeenCalled();
  });

  it("copies admitted limits before a caller mutates its option record", async () => {
    const limits = { ...AZURE_LEDGER_RESTORE_READ_BUDGET, maximumRequests: 1 };
    const selected = { ...options("restore-reader"), restoreReadBudget: limits };
    const store = new AzureBlobRawArtifactStore(selected);
    wire.send.mockImplementationOnce(async (r: PipelineRequest) => {
      limits.maximumRequests = 100;
      selected.restoreReadBudget = { ...AZURE_LEDGER_RESTORE_READ_BUDGET };
      return response(r, 200, listing(""), { "content-type": "application/xml" });
    });
    expect(await store.open({ objectKey })).toBeNull();
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(wire.send).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1])(
    "accepts exact body budget or charges the full crossing chunk (%s)",
    async (delta) => {
      const xml = listing("");
      const store = budgetStore({ maximumBodyBytes: Buffer.byteLength(xml) + delta });
      queue(200, xml);
      const pending = store.open({ objectKey });
      if (delta === 0) expect(await pending).toBeNull();
      else await expect(pending).rejects.toThrow();
      expect(store.restoreReadUsage()).toMatchObject({
        requestAttempts: 1,
        responses: 1,
        bodyBytes: Buffer.byteLength(xml),
        settledRequests: 1,
        failedRequests: delta === 0 ? 0 : 1,
      });
      queue(200, xml);
      await expect(store.open({ objectKey })).rejects.toThrow();
      expect(wire.send).toHaveBeenCalledTimes(delta === 0 ? 2 : 1);
    },
  );

  it.each([0, -1])(
    "accepts exact logical header budget or refuses one beyond (%s)",
    async (delta) => {
      // Etag contributes 19 logical header bytes and XML content type contributes 31.
      const store = budgetStore({ maximumHeaderBytes: 50 + delta });
      queue(200, listing(""));
      const pending = store.open({ objectKey });
      if (delta === 0) expect(await pending).toBeNull();
      else await expect(pending).rejects.toThrow();
      expect(store.restoreReadUsage()).toMatchObject({
        headerBytes: 50,
        bodyBytes: delta === 0 ? Buffer.byteLength(listing("")) : 0,
        failedRequests: delta === 0 ? 0 : 1,
        settledRequests: 1,
        activeRequests: 0,
      });
    },
  );

  it("counts logical per-response header overflow before destroying its unread body", async () => {
    const store = budgetStore();
    queue(200, "unread", { "x-padding": "x".repeat(8192) });
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      headerBytes: 19 + 9 + 8192 + 4,
      bodyBytes: 0,
      failedRequests: 1,
      settledRequests: 1,
    });
    expect(owned.at(-1)?.destroyed).toBe(true);
  });

  it.each([404, 500])("counts status %s and actual error body without a retry", async (status) => {
    const store = budgetStore();
    queue(status, "private-error-body");
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 1,
      responses: 1,
      nonSuccessResponses: 1,
      failedRequests: 1,
      settledRequests: 1,
      bodyBytes: Buffer.byteLength("private-error-body"),
    });
    expect(wire.send).toHaveBeenCalledTimes(1);
  });

  it("counts HTTP failure plus partial error-body failure only once", async () => {
    const store = budgetStore();
    const body = Readable.from(
      (async function* () {
        yield Buffer.from("part");
        throw new Error("private");
      })(),
    );
    queue(500, body);
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      responses: 1,
      nonSuccessResponses: 1,
      failedRequests: 1,
      settledRequests: 1,
      bodyBytes: 4,
      activeRequests: 0,
    });
  });

  it("retains successful HTTP consumption when SDK XML parsing fails", async () => {
    const store = budgetStore();
    queue(200, "<invalid");
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      responses: 1,
      failedRequests: 0,
      settledRequests: 1,
      bodyBytes: 8,
    });
  });

  it("retains HTTP completion when the parsed listing identity disagrees", async () => {
    const store = budgetStore();
    const xml = listing("", "", "foreign-prefix");
    queue(200, xml);
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 1,
      listAttempts: 1,
      responses: 1,
      failedRequests: 0,
      settledRequests: 1,
      activeRequests: 0,
      bodyBytes: Buffer.byteLength(xml),
    });
    expect(wire.send).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "deadline"] as const)(
    "charges partial buffered XML before %s and waits for rejection",
    async (mode) => {
      const store = new AzureBlobRawArtifactStore({
        ...options("restore-reader"),
        requestTimeoutMs: 100,
        restoreReadBudget: AZURE_LEDGER_RESTORE_READ_BUDGET,
      });
      const controller = new AbortController();
      const body = new Readable({ read() {} });
      queue(200, body, { "content-type": "application/xml" });
      const failure = expect(
        store.open({ objectKey, signal: controller.signal }),
      ).rejects.toThrow();
      body.push(Buffer.from("part"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.restoreReadUsage()).toMatchObject({
        requestAttempts: 1,
        responses: 1,
        activeRequests: 1,
        settledRequests: 0,
        bodyBytes: 4,
      });
      if (mode === "abort") controller.abort();
      else await new Promise<void>((resolve) => setTimeout(resolve, 130));
      await failure;
      expect(store.restoreReadUsage()).toMatchObject({
        failedRequests: 1,
        settledRequests: 1,
        activeRequests: 0,
        bodyBytes: 4,
      });
      expect(body.destroyed).toBe(true);
    },
  );

  it.each([302, 200])(
    "does not invent unread body bytes for rejected status/encoding %s",
    async (status) => {
      const store = budgetStore();
      queue(status, "unread", status === 200 ? { "content-encoding": "gzip" } : {});
      await expect(store.open({ objectKey })).rejects.toThrow();
      expect(store.restoreReadUsage()).toMatchObject({
        responses: 1,
        bodyBytes: 0,
        failedRequests: 1,
        settledRequests: 1,
        nonSuccessResponses: status === 302 ? 1 : 0,
      });
    },
  );

  it.each(["short", "long", "late-error"] as const)(
    "charges download bytes on %s without a second terminal update",
    async (mode) => {
      const store = budgetStore();
      queue(200, listing(item()));
      const bytes = mode === "short" ? "ab" : mode === "long" ? "abcd" : "abc";
      const body =
        mode === "late-error"
          ? Readable.from(
              (async function* () {
                yield Buffer.from(bytes);
                throw new Error("private late failure");
              })(),
            )
          : bytes;
      queue(200, body, { "content-length": "3", "x-ms-version-id": "v1" });
      const opened = await store.open({ objectKey });
      if (!opened) throw new Error("Expected object");
      await expect(collect(opened.stream)).rejects.toThrow();
      expect(store.restoreReadUsage()).toMatchObject({
        requestAttempts: 2,
        downloadAttempts: 1,
        failedRequests: 1,
        settledRequests: 2,
        activeRequests: 0,
        bodyBytes: Buffer.byteLength(listing(item())) + bytes.length,
      });
    },
  );

  it("keeps a held download active until the checked pipeline actually settles", async () => {
    const store = budgetStore();
    const body = new Readable({ read() {} });
    queue(200, listing(item()));
    queue(200, body, { "content-length": "3", "x-ms-version-id": "v1" });
    const opened = await store.open({ objectKey });
    if (!opened) throw new Error("Expected object");
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 2,
      settledRequests: 1,
      activeRequests: 1,
    });
    const collecting = collect(opened.stream);
    body.push(Buffer.from("abc"));
    body.push(null);
    expect(await collecting).toEqual(Buffer.from("abc"));
    expect(store.restoreReadUsage()).toMatchObject({
      settledRequests: 2,
      failedRequests: 0,
      activeRequests: 0,
    });
  });

  it("reserves concurrently, poisons at exhaustion, and owns late response bodies", async () => {
    const store = budgetStore({ maximumRequests: 1 });
    const started = deferred();
    let release!: (value: PipelineResponse) => void;
    let held!: PipelineRequest;
    wire.send.mockImplementationOnce((r: PipelineRequest) => {
      held = r;
      started.resolve();
      return new Promise<PipelineResponse>((resolve) => {
        release = resolve;
      });
    });
    const first = store.open({ objectKey });
    const firstRejected = expect(first).rejects.toThrow();
    await started.promise;
    await expect(store.open({ objectKey: "another" })).rejects.toThrow();
    expect(held.abortSignal?.aborted).toBe(true);
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 1,
      activeRequests: 1,
      settledRequests: 0,
    });
    const late = response(held, 200, "never-consumed");
    release(late);
    await firstRejected;
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 1,
      responses: 1,
      headerBytes: 19,
      bodyBytes: 0,
      failedRequests: 1,
      settledRequests: 1,
      activeRequests: 0,
    });
    expect((late.readableStreamBody as Readable).destroyed).toBe(true);
    expect(wire.send).toHaveBeenCalledTimes(1);
  });

  it("poisons concurrent downloads at the full crossing chunk and charges both settlements", async () => {
    const xmlBytes = Buffer.byteLength(listing(item()));
    const store = budgetStore({ maximumBodyBytes: 2 * xmlBytes + 2 });
    const firstBody = new Readable({ read() {} });
    const secondBody = new Readable({ read() {} });
    queue(200, listing(item()));
    queue(200, firstBody, { "content-length": "3", "x-ms-version-id": "v1" });
    const first = await store.open({ objectKey });
    queue(200, listing(item()));
    queue(200, secondBody, { "content-length": "3", "x-ms-version-id": "v1" });
    const second = await store.open({ objectKey });
    if (!first || !second) throw new Error("Expected objects");
    const failures = [
      expect(collect(first.stream)).rejects.toThrow(),
      expect(collect(second.stream)).rejects.toThrow(),
    ];
    expect(store.restoreReadUsage()).toMatchObject({ activeRequests: 2, settledRequests: 2 });
    firstBody.push(Buffer.from("abc"));
    await Promise.all(failures);
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 4,
      bodyBytes: 2 * xmlBytes + 3,
      failedRequests: 2,
      settledRequests: 4,
      activeRequests: 0,
    });
    expect(secondBody.destroyed).toBe(true);
    await expect(store.open({ objectKey })).rejects.toThrow();
    expect(wire.send).toHaveBeenCalledTimes(4);
  });

  it.each(["abort", "deadline"] as const)("settles a held download after %s", async (mode) => {
    const store = new AzureBlobRawArtifactStore({
      ...options("restore-reader"),
      requestTimeoutMs: 100,
      restoreReadBudget: AZURE_LEDGER_RESTORE_READ_BUDGET,
    });
    const signal = new AbortController();
    const body = new Readable({ read() {} });
    queue(200, listing(item()));
    queue(200, body, { "content-length": "3", "x-ms-version-id": "v1" });
    const opened = await store.open({ objectKey, signal: signal.signal });
    if (!opened) throw new Error("Expected object");
    const failure = expect(collect(opened.stream)).rejects.toThrow();
    if (mode === "abort") signal.abort();
    else await new Promise<void>((resolve) => setTimeout(resolve, 130));
    await failure;
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 2,
      failedRequests: 1,
      settledRequests: 2,
      activeRequests: 0,
    });
  });

  async function encryptedLedger(
    generations: number,
    matches: number,
    maximumRequests = 4096,
    corrupt = false,
  ) {
    const objects = new Map<string, Buffer>();
    const memory: RawArtifactStore = {
      async put(input) {
        objects.set(input.objectKey, await collect(input.source));
      },
      async open(input) {
        const bytes = objects.get(input.objectKey);
        return bytes ? { stream: Readable.from([bytes]), contentLength: bytes.length } : null;
      },
    };
    const keyRing = {
      purpose: "erasure_replay_ledger" as const,
      currentKeyId: "aes",
      keys: new Map([["aes", Buffer.alloc(32, 7)]]),
    };
    const keys = Object.fromEntries(
      Array.from({ length: generations }, (_, i) => [
        "key" + (i + 1),
        Buffer.alloc(32, i + 1).toString("base64"),
      ]),
    );
    const subject = "a0000000-0000-4000-8000-000000000001";
    for (let i = 1; i <= matches; i++) {
      const ring = parseErasureLedgerLocatorKeyRing({
        currentKeyId: "key" + i,
        serializedKeys: JSON.stringify(keys),
      });
      const writer = new EncryptedErasureReplayLedger({
        artifactStore: new EncryptedArtifactStore({
          rawStore: memory,
          keyRing,
          maxPlaintextBytes: 16_384,
        }),
        locatorKeyRing: ring,
      });
      await writer.append({
        subjectUserId: subject,
        jobId: "c0000000-0000-4000-8000-000000000003",
        recordedAt: "2026-10-09T12:00:00.000Z",
        restoreLocator: deriveErasureLedgerLocator(ring, subject).value,
      });
    }
    if (corrupt)
      for (const bytes of objects.values()) bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    const offered: number[] = [];
    wire.send.mockImplementation(async (request: PipelineRequest) => {
      const url = new URL(request.url);
      const blobName =
        url.searchParams.get("prefix") ??
        decodeURIComponent(url.pathname.slice("/exports/".length));
      const bytes = objects.get(blobName.slice(prefix.length));
      let payload: string | Buffer;
      let headers: Record<string, string> = { "content-type": "application/xml" };
      if (url.searchParams.get("comp") === "list") {
        payload = listing(
          bytes
            ? item("", blobName).replace(
                "<Content-Length>3</Content-Length>",
                "<Content-Length>" + bytes.length + "</Content-Length>",
              )
            : "",
          "",
          blobName,
        );
      } else {
        if (!bytes) throw new Error("Unexpected missing download");
        payload = bytes;
        headers = { "content-length": String(bytes.length), "x-ms-version-id": "v1" };
      }
      offered.push(Buffer.byteLength(payload));
      return response(request, 200, payload, headers);
    });
    const store = budgetStore({ maximumRequests });
    const ledger = new EncryptedErasureReplayLedger({
      artifactStore: new EncryptedArtifactStore({
        rawStore: store,
        keyRing,
        maxPlaintextBytes: 16_384,
      }),
      locatorKeyRing: parseErasureLedgerLocatorKeyRing({
        currentKeyId: "key1",
        serializedKeys: JSON.stringify(keys),
      }),
    });
    return { ledger, store, subject, offered };
  }

  it("retains one budget over all 32 generations during actual authenticated recovery", async () => {
    const { ledger, store, subject, offered } = await encryptedLedger(32, 1);
    const apply = vi.fn(async () => ({ reconciled: true, remainingRows: {} }));
    await ledger.replaySubject({ subjectUserId: subject, apply });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 33,
      listAttempts: 32,
      downloadAttempts: 1,
      responses: 33,
      settledRequests: 33,
      failedRequests: 0,
      activeRequests: 0,
      bodyBytes: offered.reduce((sum, n) => sum + n, 0),
    });
  });
  it("keeps conflict traffic charged without calling it a transport failure", async () => {
    const { ledger, store, subject, offered } = await encryptedLedger(2, 2);
    const apply = vi.fn();
    await expect(ledger.replaySubject({ subjectUserId: subject, apply })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 4,
      settledRequests: 4,
      failedRequests: 0,
      bodyBytes: offered.reduce((sum, n) => sum + n, 0),
    });
  });
  it("refuses remaining generation work after an authenticated match without applying it", async () => {
    const { ledger, store, subject } = await encryptedLedger(2, 2, 2);
    const apply = vi.fn();
    await expect(ledger.replaySubject({ subjectUserId: subject, apply })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 2,
      listAttempts: 1,
      downloadAttempts: 1,
      settledRequests: 2,
      failedRequests: 0,
    });
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it("retains HTTP completion on failed actual ciphertext authentication", async () => {
    const { ledger, store, subject } = await encryptedLedger(1, 1, 4096, true);
    await expect(ledger.findForSubject({ subjectUserId: subject })).rejects.toThrow();
    expect(store.restoreReadUsage()).toMatchObject({
      requestAttempts: 2,
      settledRequests: 2,
      failedRequests: 0,
      activeRequests: 0,
    });
  });
});

const wire = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@azure/core-rest-pipeline", async (original) => {
  const actual = await original<typeof import("@azure/core-rest-pipeline")>();
  return { ...actual, createDefaultHttpClient: () => ({ sendRequest: wire.send }) };
});
const endpoint = "https://nourishingtest.blob.core.windows.net/exports";
const prefix = "development/exports/";
const name = prefix + "exports/v1/user/item.enc";
const now = Date.UTC(2026, 9, 9, 12);
const perms = {
  reader: "r",
  "export-writer": "rcd",
  "ledger-writer": "rc",
  "restore-reader": "rl",
} as const;
function options(role: keyof typeof perms = "export-writer") {
  return {
    containerUrl: endpoint,
    prefix,
    role,
    ...(role === "export-writer"
      ? {
          deletionObserverSasToken: observerToken(),
        }
      : {}),
    sasToken: new URLSearchParams({
      sv: "2026-04-06",
      spr: "https",
      st: "2026-10-09T11:00:00Z",
      se: "2026-10-09T15:00:00Z",
      sr: "c",
      sp: perms[role],
      sig: "synthetic-signature",
      skoid: "synthetic-reader",
      sktid: "synthetic-tenant",
      skt: "2026-10-09T10:00:00Z",
      ske: "2026-10-09T16:00:00Z",
      sks: "b",
      skv: "2026-04-06",
    }).toString(),
  };
}
function observerToken() {
  const q = new URLSearchParams(options("reader").sasToken);
  q.set("sp", "l");
  q.set("sig", "synthetic-observer");
  q.set("skoid", "observer");
  return q.toString();
}
const owned: Readable[] = [];
function response(
  request: PipelineRequest,
  status = 200,
  bytes: string | Buffer | Readable = "",
  headers: Record<string, string> = {},
): PipelineResponse {
  const body = bytes instanceof Readable ? bytes : Readable.from([Buffer.from(bytes)]);
  owned.push(body);
  return {
    request,
    status,
    headers: createHttpHeaders({ etag: '"synthetic"', ...headers }),
    readableStreamBody: body,
  };
}
function queue(
  status: number,
  body: string | Buffer | Readable = "",
  headers: Record<string, string> = {},
) {
  wire.send.mockImplementationOnce(async (r: PipelineRequest) =>
    response(r, status, body, headers),
  );
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function listing(items: string, marker = "", blobName = name) {
  return (
    '<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://nourishingtest.blob.core.windows.net/" ContainerName="exports"><Prefix>' +
    blobName +
    "</Prefix><MaxResults>16</MaxResults><Blobs>" +
    items +
    "</Blobs><NextMarker>" +
    marker +
    "</NextMarker></EnumerationResults>"
  );
}
function item(extra = "", objectName = name) {
  return (
    "<Blob><Name>" +
    objectName +
    "</Name><Deleted>false</Deleted><Snapshot/><VersionId>v1</VersionId><IsCurrentVersion>true</IsCurrentVersion><Properties><Content-Length>3</Content-Length><BlobType>BlockBlob</BlobType></Properties>" +
    extra +
    "</Blob>"
  );
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  wire.send.mockReset();
});
afterEach(() => {
  for (const s of owned.splice(0)) s.destroy();
  vi.restoreAllMocks();
});

describe("Azure Blob raw storage through the actual SDK", () => {
  it("stages exact bytes and atomically commits create-only at the explicit prefix", async () => {
    queue(201);
    queue(201, "", { etag: '"owned"' });
    const source = Readable.from([Buffer.from("one"), Buffer.from("two")]);
    await new AzureBlobRawArtifactStore(options()).put({
      objectKey: "exports/v1/user/item.enc",
      source,
      contentLength: 6,
    });
    expect(wire.send).toHaveBeenCalledTimes(2);
    const stage = wire.send.mock.calls[0]?.[0] as PipelineRequest;
    const commit = wire.send.mock.calls[1]?.[0] as PipelineRequest;
    expect(new URL(stage.url).pathname).toBe("/exports/" + name);
    expect(new URL(stage.url).searchParams.get("comp")).toBe("block");
    expect(Buffer.from(stage.body as Uint8Array).toString()).toBe("onetwo");
    expect(new URL(commit.url).searchParams.get("comp")).toBe("blocklist");
    expect(commit.headers.get("if-none-match")).toBe("*");
    expect(commit.headers.get("x-ms-version")).toBe("2026-04-06");
    expect(stage.requestOverrides).toEqual({ maxHeaderSize: 8192, rejectUnauthorized: true });
    expect(stage.headers.get("accept-encoding")).toBe("identity");
    expect(stage.allowInsecureConnection).toBe(false);
    expect(source.destroyed).toBe(true);
  });
  it("stages bounded blocks serially", async () => {
    queue(201);
    queue(201);
    queue(201, "", { etag: '"owned"' });
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 3, 9);
    await new AzureBlobRawArtifactStore(options()).put({
      objectKey: "big",
      source: Readable.from([bytes]),
      contentLength: bytes.length,
    });
    expect(
      wire.send.mock.calls
        .slice(0, 2)
        .map(([r]) => (r as PipelineRequest).headers.get("content-length")),
    ).toEqual([String(8 * 1024 * 1024), "3"]);
    const ids = wire.send.mock.calls
      .slice(0, 2)
      .map(([r]) => new URL((r as PipelineRequest).url).searchParams.get("blockid"));
    expect(ids[0]).not.toBe(ids[1]);
  });
  it.each([2, 4])("rejects a length mismatch %s before publication", async (length) => {
    await expect(
      new AzureBlobRawArtifactStore(options()).put({
        objectKey: "bad",
        source: Readable.from([Buffer.from("abc")]),
        contentLength: length,
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).not.toHaveBeenCalled();
  });
  it("never retries an ambiguous commit or deletes staged data blindly", async () => {
    queue(201);
    wire.send.mockRejectedValueOnce(new Error("private token and URL"));
    await expect(
      new AzureBlobRawArtifactStore(options()).put({
        objectKey: "once",
        source: Readable.from([Buffer.from("abc")]),
        contentLength: 3,
      }),
    ).rejects.toThrow("Azure artifact storage operation failed");
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it("retains a service conflict status while redacting response details", async () => {
    queue(201);
    queue(412, "<Error><Code>BlobAlreadyExists</Code><Message>private-value</Message></Error>", {
      "content-type": "application/xml",
    });
    await expect(
      new AzureBlobRawArtifactStore(options()).put({
        objectKey: "once",
        source: Readable.from([Buffer.from("abc")]),
        contentLength: 3,
      }),
    ).rejects.toMatchObject({
      statusCode: 412,
      message: "Azure artifact storage operation failed",
    });
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it.each(["reader", "restore-reader"] as const)(
    "rejects writes from %s before any request",
    async (role) => {
      await expect(
        new AzureBlobRawArtifactStore(options(role)).put({
          objectKey: "bad",
          source: Readable.from(["a"]),
          contentLength: 1,
        }),
      ).rejects.toBeInstanceOf(AzureArtifactStoreError);
      expect(wire.send).not.toHaveBeenCalled();
    },
  );
  it("streams an exact response through SDK download without recovery retries", async () => {
    queue(200, "abc", {
      "content-length": "3",
      etag: '"private-etag"',
      "x-ms-version-id": "unselected-version",
      "x-private": "private-header",
    });
    const opened = await new AzureBlobRawArtifactStore(options("reader")).open({
      objectKey: "exports/v1/user/item.enc",
    });
    if (!opened) throw new Error("Expected current read");
    expect(opened?.contentLength).toBe(3);
    expect(opened?.readIdentity).toEqual({
      kind: "azure-blob-current",
      containerUrl: endpoint,
      prefix,
      objectKey: "exports/v1/user/item.enc",
      blobName: name,
      contentLength: 3,
    });
    expect(Object.isFrozen(opened?.readIdentity)).toBe(true);
    expect(Object.keys(opened).sort()).toEqual(["contentLength", "readIdentity", "stream"]);
    expect(await collect(opened.stream)).toEqual(Buffer.from("abc"));
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it.each(["ab", "abcd"])("rejects truncated or oversized data %s without retry", async (body) => {
    queue(200, body, { "content-length": "3" });
    await expect(
      (async () => {
        const opened = await new AzureBlobRawArtifactStore(options("reader")).open({
          objectKey: "file",
        });
        expect(opened?.readIdentity.kind).toBe("azure-blob-current");
        return collect(opened!.stream);
      })(),
    ).rejects.toBeDefined();
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it("returns missing for a current blob 404", async () => {
    queue(404, "<Error><Code>BlobNotFound</Code></Error>", { "content-type": "application/xml" });
    expect(
      await new AzureBlobRawArtifactStore(options("reader")).open({ objectKey: "missing" }),
    ).toBeNull();
  });
  it.each([301, 302, 307, 308])(
    "rejects redirect %s before SDK redirect handling",
    async (status) => {
      queue(status, "", { location: "https://other.example/private" });
      await expect(
        new AzureBlobRawArtifactStore(options("reader")).open({ objectKey: "file" }),
      ).rejects.toBeInstanceOf(AzureArtifactStoreError);
      expect(wire.send).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds metadata before XML parsing", async () => {
    queue(500, Buffer.alloc(1_048_577));
    await expect(
      new AzureBlobRawArtifactStore(options("reader")).open({ objectKey: "file" }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it("rejects encoded responses", async () => {
    queue(200, "abc", { "content-length": "3", "content-encoding": "gzip" });
    await expect(
      new AzureBlobRawArtifactStore(options("reader")).open({ objectKey: "file" }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it("aborts stalled response bodies at the operation deadline", async () => {
    const stalled = new Readable({ read() {} });
    queue(200, stalled, { "content-length": "3" });
    const opened = await new AzureBlobRawArtifactStore({
      ...options("reader"),
      requestTimeoutMs: 100,
    }).open({ objectKey: "file" });
    expect(opened?.readIdentity.kind).toBe("azure-blob-current");
    await expect(collect(opened!.stream)).rejects.toBeDefined();
    expect(stalled.destroyed).toBe(true);
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it("does not turn exact bytes followed by a late source error into successful EOF", async () => {
    const body = Readable.from(
      (async function* () {
        yield Buffer.from("abc");
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("private transport detail");
      })(),
    );
    queue(200, body, { "content-length": "3" });
    const opened = await new AzureBlobRawArtifactStore(options("reader")).open({
      objectKey: "file",
    });
    expect(opened?.readIdentity.kind).toBe("azure-blob-current");
    await expect(collect(opened!.stream)).rejects.toMatchObject({
      message: "Azure artifact storage operation failed",
    });
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it("cancels caller-visible buffered data even after the underlying response ended", async () => {
    queue(200, "abc", { "content-length": "3" });
    const controller = new AbortController();
    const opened = await new AzureBlobRawArtifactStore(options("reader")).open({
      objectKey: "file",
      signal: controller.signal,
    });
    expect(opened?.readIdentity.kind).toBe("azure-blob-current");
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(collect(opened!.stream)).rejects.toMatchObject({
      message: "Azure artifact storage operation failed",
    });
  });
  it("cancels an owned upload source", async () => {
    const source = new Readable({ read() {} });
    const controller = new AbortController();
    const pending = new AzureBlobRawArtifactStore(options()).put({
      objectKey: "file",
      source,
      contentLength: 3,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(source.destroyed).toBe(true);
    expect(wire.send).not.toHaveBeenCalled();
  });
  it("enumerates all pages and reads only the exact ledger version", async () => {
    queue(200, listing(item(), "page2"), { "content-type": "application/xml" });
    queue(200, listing(""), { "content-type": "application/xml" });
    queue(200, "abc", { "content-length": "3", "x-ms-version-id": "v1" });
    const opened = await new AzureBlobRawArtifactStore(options("restore-reader")).open({
      objectKey: "exports/v1/user/item.enc",
    });
    expect(opened?.readIdentity).toEqual({
      kind: "azure-blob-version",
      containerUrl: endpoint,
      prefix,
      objectKey: "exports/v1/user/item.enc",
      blobName: name,
      versionId: "v1",
      contentLength: 3,
    });
    expect(Object.isFrozen(opened?.readIdentity)).toBe(true);
    expect(await collect(opened!.stream)).toEqual(Buffer.from("abc"));
    const urls = wire.send.mock.calls.map(([r]) => new URL((r as PipelineRequest).url));
    expect(urls[0]?.searchParams.get("include")).toContain("versions");
    expect(urls[0]?.searchParams.get("include")).toContain("uncommittedblobs");
    expect(urls[1]?.searchParams.get("marker")).toBe("page2");
    expect(urls[2]?.searchParams.get("versionid")).toBe("v1");
  });
  it.each(["reader", "restore-reader"] as const)(
    "retains admitted case-sensitive location after caller mutation for %s",
    async (role) => {
      const configured = { ...options(role), prefix: "Development/Exports/" };
      const originalPrefix = configured.prefix;
      const input = { objectKey: "Exports/V1/User/Item.enc" };
      const originalKey = input.objectKey;
      const blobName = originalPrefix + originalKey;
      const store = new AzureBlobRawArtifactStore(configured);
      if (role === "restore-reader")
        queue(200, listing(item("", blobName), "", blobName), {
          "content-type": "application/xml",
        });
      const entered = deferred();
      const release = deferred();
      wire.send.mockImplementationOnce(async (request: PipelineRequest) => {
        entered.resolve();
        await release.promise;
        return response(request, 200, "abc", {
          "content-length": "3",
          "x-ms-version-id": "v1",
          "x-private": "private-header",
        });
      });
      const pending = store.open(input);
      await entered.promise;
      configured.prefix = "replaced/";
      configured.containerUrl = "https://replaced.blob.core.windows.net/other";
      configured.sasToken = "private-replacement";
      input.objectKey = "replaced.enc";
      release.resolve();
      const opened = await pending;
      if (!opened) throw new Error("Expected admitted read");
      expect(opened?.readIdentity).toEqual({
        kind: role === "restore-reader" ? "azure-blob-version" : "azure-blob-current",
        containerUrl: endpoint,
        prefix: originalPrefix,
        objectKey: originalKey,
        blobName,
        contentLength: 3,
        ...(role === "restore-reader" ? { versionId: "v1" } : {}),
      });
      expect(Object.isFrozen(opened?.readIdentity)).toBe(true);
      const encoded = JSON.stringify(opened?.readIdentity);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192);
      for (const value of ["synthetic-signature", "private", "sig=", "replaced", "etag"])
        expect(encoded).not.toContain(value);
      expect(await collect(opened.stream)).toEqual(Buffer.from("abc"));
      for (const [request] of wire.send.mock.calls)
        expect(["/exports", `/exports/${blobName}`]).toContain(
          new URL((request as PipelineRequest).url).pathname,
        );
      expect(wire.send).toHaveBeenCalledTimes(role === "restore-reader" ? 2 : 1);
    },
  );
  it.each(["Version/With+Opaque=Case", "v".repeat(1024), "é".repeat(512)])(
    "preserves opaque version contents and the inclusive byte bound",
    async (version) => {
      queue(200, listing(item().replace("<VersionId>v1", `<VersionId>${version}`)), {
        "content-type": "application/xml",
      });
      queue(200, "abc", { "content-length": "3", "x-ms-version-id": version });
      const opened = await new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      });
      if (!opened) throw new Error("Expected selected version read");
      expect(opened?.readIdentity).toMatchObject({
        kind: "azure-blob-version",
        versionId: version,
      });
      const request = wire.send.mock.calls[1]?.[0] as PipelineRequest;
      expect(new URL(request.url).searchParams.get("versionid")).toBe(version);
      expect(await collect(opened.stream)).toEqual(Buffer.from("abc"));
    },
  );
  it.each(["", "v".repeat(1025), "é".repeat(513), "v\t1", "v\n1", "v\u007f1"])(
    "rejects invalid selected version before download",
    async (version) => {
      queue(200, listing(item().replace("<VersionId>v1", `<VersionId>${version}`)), {
        "content-type": "application/xml",
      });
      await expect(
        new AzureBlobRawArtifactStore(options("restore-reader")).open({
          objectKey: "exports/v1/user/item.enc",
        }),
      ).rejects.toMatchObject({ message: "Azure artifact storage operation failed" });
      expect(wire.send).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, "", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "4"])(
    "rejects missing, malformed or oversized list length %s before download",
    async (length) => {
      const replacement = length === undefined ? "" : `<Content-Length>${length}</Content-Length>`;
      queue(200, listing(item().replace("<Content-Length>3</Content-Length>", replacement)), {
        "content-type": "application/xml",
      });
      await expect(
        new AzureBlobRawArtifactStore({ ...options("restore-reader"), maximumObjectBytes: 3 }).open(
          {
            objectKey: "exports/v1/user/item.enc",
          },
        ),
      ).rejects.toMatchObject({ message: "Azure artifact storage operation failed" });
      expect(wire.send).toHaveBeenCalledTimes(1);
    },
  );
  it.each([2, 4])("rejects response length %s differing from the selected list row", async (n) => {
    queue(200, listing(item()), { "content-type": "application/xml" });
    queue(200, "x".repeat(n), { "content-length": String(n), "x-ms-version-id": "v1" });
    await expect(
      new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toMatchObject({ message: "Azure artifact storage operation failed" });
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it("refuses absent response version without substituting the selected version", async () => {
    queue(200, listing(item()), { "content-type": "application/xml" });
    queue(200, "abc", { "content-length": "3" });
    await expect(
      new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it("returns null for empty history but refuses an exact-version 404", async () => {
    queue(200, listing(""), { "content-type": "application/xml" });
    const store = new AzureBlobRawArtifactStore(options("restore-reader"));
    const input = { objectKey: "exports/v1/user/item.enc" };
    expect(await store.open(input)).toBeNull();
    queue(200, listing(item()), { "content-type": "application/xml" });
    queue(404, "<Error><Code>BlobNotFound</Code></Error>", { "content-type": "application/xml" });
    await expect(store.open(input)).rejects.toMatchObject({ statusCode: 404 });
    expect(wire.send).toHaveBeenCalledTimes(3);
  });
  it.each([
    item() + item(),
    item().replace("<Deleted>false", "<Deleted>true"),
    item().replace("<Snapshot/>", "<Snapshot>snapshot1</Snapshot>"),
    item().replace("<IsCurrentVersion>true", "<IsCurrentVersion>false"),
    item().replace("<VersionId>v1</VersionId>", ""),
    item().replace("BlockBlob", "PageBlob"),
  ])("rejects ambiguous or unqualified exact-key history", async (xml) => {
    queue(200, listing(xml), { "content-type": "application/xml" });
    await expect(
      new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(1);
  });
  it("rejects repeated pagination tokens", async () => {
    queue(200, listing(item(), "again"), { "content-type": "application/xml" });
    queue(200, listing("", "again"), { "content-type": "application/xml" });
    await expect(
      new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(2);
  });
  it("rejects version readback drift", async () => {
    queue(200, listing(item()), { "content-type": "application/xml" });
    queue(200, "abc", { "content-length": "3", "x-ms-version-id": "v2" });
    await expect(
      new AzureBlobRawArtifactStore(options("restore-reader")).open({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it.each([202, 404])("requires empty complete inventory after DELETE %s", async (status) => {
    queue(status, "", { "content-type": "application/xml" });
    queue(200, listing(item("", name + "-other"), "next"), { "content-type": "application/xml" });
    queue(200, listing(""), { "content-type": "application/xml" });
    await new AzureBlobRawArtifactStore(options()).delete({
      objectKey: "exports/v1/user/item.enc",
    });
    const requests = wire.send.mock.calls.map(([r]) => r as PipelineRequest);
    expect(requests[0]!.headers.get("x-ms-delete-snapshots")).toBe("include");
    expect(new URL(requests[0]!.url).searchParams.get("sp")).toBe("rcd");
    expect(new URL(requests[1]!.url).searchParams.get("sp")).toBe("l");
    expect(new URL(requests[1]!.url).searchParams.get("include")?.split(",").sort()).toEqual([
      "deleted",
      "deletedwithversions",
      "snapshots",
      "uncommittedblobs",
      "versions",
    ]);
    expect(new URL(requests[2]!.url).searchParams.get("marker")).toBe("next");
  });
  it.each([
    item(),
    item().replace("<Deleted>false", "<Deleted>true"),
    item().replace("<Snapshot/>", "<Snapshot>snapshot</Snapshot>"),
    item().replace("<VersionId>v1</VersionId>", ""),
  ])("rejects retained ciphertext after the base is absent", async (items) => {
    queue(404);
    queue(200, listing(items), { "content-type": "application/xml" });
    await expect(
      new AzureBlobRawArtifactStore(options()).delete({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it.each([
    listing("").replace("<Blobs></Blobs>", ""),
    listing("").replace("<NextMarker></NextMarker>", ""),
    listing("").replace("<Prefix>" + name, "<Prefix>wrong"),
    listing("").replace('ContainerName="exports"', 'ContainerName="foreign"'),
    listing("").replace("<MaxResults>16", "<MaxResults>17"),
    listing(item().repeat(17)),
    "<not-a-list/>",
  ])("rejects malformed or mismatched deletion inventory", async (xml) => {
    queue(202);
    queue(200, xml, { "content-type": "application/xml" });
    await expect(
      new AzureBlobRawArtifactStore(options()).delete({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it.each([403, 404, 500])("does not treat observer failure %s as absence", async (status) => {
    queue(404);
    queue(status);
    await expect(
      new AzureBlobRawArtifactStore(options()).delete({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it("bounds pagination without requesting a 65th inventory page", async () => {
    queue(202);
    for (let n = 0; n < 64; n++)
      queue(200, listing("", "page" + n), { "content-type": "application/xml" });
    await expect(
      new AzureBlobRawArtifactStore(options()).delete({
        objectKey: "exports/v1/user/item.enc",
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
    expect(wire.send).toHaveBeenCalledTimes(65);
  });
  it("conserves caller cancellation through deletion inventory", async () => {
    const controller = new AbortController();
    queue(202);
    wire.send.mockImplementationOnce(async (r: PipelineRequest) => {
      controller.abort();
      return response(r, 200, listing(""), { "content-type": "application/xml" });
    });
    await expect(
      new AzureBlobRawArtifactStore(options()).delete({
        objectKey: "exports/v1/user/item.enc",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AzureArtifactStoreError);
  });
  it.each(["reader", "ledger-writer", "restore-reader"] as const)(
    "rejects delete for %s",
    async (role) => {
      await expect(
        new AzureBlobRawArtifactStore(options(role)).delete({ objectKey: "file" }),
      ).rejects.toBeInstanceOf(AzureArtifactStoreError);
      expect(wire.send).not.toHaveBeenCalled();
    },
  );
  it.each(["complete", "commit-failed", "inventory-failed", "still-readable"] as const)(
    "accounts for the encrypted export workflow when %s",
    async (outcome) => {
      const blocks: Buffer[] = [];
      const trace: {
        account: string;
        method: string;
        operation: string;
        status: number;
        sentBodyBytes: number;
        offeredResponseBodyBytes: number;
      }[] = [];
      let committed = false;
      let deleted = false;
      let pages = 0;
      let commitBytes = 0;
      let inventoryBytes = 0;
      wire.send.mockImplementation(async (request: PipelineRequest) => {
        const url = new URL(request.url);
        const operation = url.searchParams.get("comp") ?? "blob";
        const sent =
          request.body === undefined ? Buffer.alloc(0) : Buffer.from(request.body as Uint8Array);
        let status: number;
        let body: Buffer = Buffer.alloc(0);
        let headers: Record<string, string> = {};
        if (request.method === "PUT" && operation === "block") {
          blocks.push(Buffer.from(sent));
          status = 201;
        } else if (request.method === "PUT" && operation === "blocklist") {
          commitBytes = sent.length;
          status = outcome === "commit-failed" ? 500 : 201;
          committed = status === 201;
        } else if (request.method === "DELETE" && operation === "blob" && committed) {
          deleted = true;
          status = 202;
        } else if (request.method === "GET" && operation === "list" && deleted) {
          pages++;
          status = outcome === "inventory-failed" ? 500 : 200;
          if (status === 200) {
            body = Buffer.from(listing("", pages === 1 ? "page2" : ""));
            headers = { "content-type": "application/xml" };
            inventoryBytes += body.length;
          }
        } else if (request.method === "GET" && operation === "blob" && committed) {
          status = deleted && outcome !== "still-readable" ? 404 : 200;
          if (status === 200) {
            body = Buffer.concat(blocks);
            headers = { "content-length": String(body.length) };
          }
        } else {
          throw new Error("Unexpected SDK workflow request");
        }
        trace.push({
          account: url.hostname,
          method: request.method,
          operation,
          status,
          sentBodyBytes: sent.length,
          offeredResponseBodyBytes: body.length,
        });
        return response(request, status, body, headers);
      });
      const store = new EncryptedArtifactStore({
        rawStore: new AzureBlobRawArtifactStore(options()),
        keyRing: {
          currentKeyId: "test-key",
          purpose: "export",
          keys: new Map([["test-key", Buffer.alloc(32, 9)]]),
        },
      });
      const plaintext = Buffer.alloc(8 * 1024 * 1024, 7);
      const put = store.put({
        objectKey: "exports/v1/user/item.enc",
        mediaType: "application/json",
        plaintextBytes: plaintext.length,
        source: Readable.from([plaintext]),
      });
      if (outcome === "commit-failed") {
        await expect(put).rejects.toBeInstanceOf(AzureArtifactStoreError);
      } else {
        const metadata = await put;
        const opened = await store.openAuthenticated(metadata);
        if (!opened) throw new Error("Expected authenticated readback");
        try {
          expect((await collect(opened.stream)).equals(plaintext)).toBe(true);
        } finally {
          await opened.dispose();
        }
        const deletion = store.deleteVerified({ objectKey: metadata.objectKey });
        if (outcome === "complete") await deletion;
        else await expect(deletion).rejects.toThrow();
      }

      // Fixture response sizes are offered bytes, not consumed or billed wire bytes.
      const ciphertextBytes = blocks.reduce((total, block) => total + block.length, 0);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toHaveLength(8 * 1024 * 1024);
      expect(ciphertextBytes).toBeGreaterThan(plaintext.length);
      expect(ciphertextBytes).toBeLessThanOrEqual(plaintext.length + 101);
      expect(commitBytes).toBeGreaterThan(0);
      const writes = [
        ["PUT", "block", 201],
        ["PUT", "block", 201],
        ["PUT", "blocklist", outcome === "commit-failed" ? 500 : 201],
      ];
      const readAndDelete = [
        ["GET", "blob", 200],
        ["DELETE", "blob", 202],
        ["GET", "list", outcome === "inventory-failed" ? 500 : 200],
      ];
      const verification = [
        ["GET", "list", 200],
        ["GET", "blob", outcome === "still-readable" ? 200 : 404],
      ];
      expect(trace.map(({ method, operation, status }) => [method, operation, status])).toEqual(
        outcome === "commit-failed"
          ? writes
          : [...writes, ...readAndDelete, ...(outcome === "inventory-failed" ? [] : verification)],
      );
      expect(trace.every(({ account }) => account === "nourishingtest.blob.core.windows.net")).toBe(
        true,
      );
      expect(trace.reduce((total, row) => total + row.sentBodyBytes, 0)).toBe(
        ciphertextBytes + commitBytes,
      );
      expect(trace.reduce((total, row) => total + row.offeredResponseBodyBytes, 0)).toBe(
        (outcome === "commit-failed" ? 0 : ciphertextBytes) +
          inventoryBytes +
          (outcome === "still-readable" ? ciphertextBytes : 0),
      );
      expect(wire.send).toHaveBeenCalledTimes(trace.length);
    },
  );

  it("keeps encryption and purpose authentication above the Azure raw boundary", async () => {
    let encrypted = Buffer.alloc(0);
    wire.send.mockImplementation(async (r: PipelineRequest) => {
      if (r.method === "PUT" && new URL(r.url).searchParams.get("comp") === "block") {
        encrypted = Buffer.from(r.body as Uint8Array);
        return response(r, 201);
      }
      if (r.method === "PUT") return response(r, 201, "", { etag: '"owned"' });
      return response(r, 200, encrypted, { "content-length": String(encrypted.length) });
    });
    const store = new EncryptedArtifactStore({
      rawStore: new AzureBlobRawArtifactStore(options()),
      keyRing: {
        currentKeyId: "test-key",
        purpose: "export",
        keys: new Map([["test-key", Buffer.alloc(32, 9)]]),
      },
    });
    const text = Buffer.from("private diary");
    const metadata = await store.put({
      objectKey: "file",
      mediaType: "application/json",
      plaintextBytes: text.length,
      source: Readable.from([text]),
    });
    expect(encrypted.includes(text)).toBe(false);
    const opened = await store.openAuthenticated(metadata);
    try {
      expect(await collect(opened!.stream)).toEqual(text);
    } finally {
      await opened!.dispose();
    }
  });
});

describe("Azure credential and namespace selection", () => {
  it.each([
    "http://nourishingtest.blob.core.windows.net/exports",
    "https://other.example/exports",
    "https://nourishingtest.blob.core.windows.net/exports?sig=x",
    "https://nourishingtest.blob.core.windows.net/ex--ports",
    "https://nourishingtest.blob.core.windows.net/exports/",
  ])("rejects noncanonical endpoint %s", (value) =>
    expect(isAzureBlobContainerUrl(value)).toBe(false),
  );
  it.each([
    ["sv", "2025-11-05"],
    ["spr", "http,https"],
    ["sp", "rwdlac"],
    ["sr", "b"],
    ["se", "2026-10-09T11:00:00Z"],
    ["st", "2026-10-09T13:00:00Z"],
    ["sks", "x"],
  ])("rejects unsupported SAS %s", (field, value) => {
    const o = options();
    const q = new URLSearchParams(o.sasToken);
    q.set(field!, value!);
    expect(() => validateAzureBlobCredential({ ...o, sasToken: q.toString() })).toThrow(
      AzureArtifactStoreError,
    );
  });
  it("rejects missing user delegation and duplicated fields", () => {
    const o = options();
    expect(() => validateAzureBlobCredential({ ...o, sasToken: o.sasToken + "&sp=rcd" })).toThrow();
    const q = new URLSearchParams(o.sasToken);
    q.delete("skoid");
    expect(() => validateAzureBlobCredential({ ...o, sasToken: q.toString() })).toThrow();
  });
  it.each(["../file", "a//b", "/file", "a/./b", "a/../b", "a?b", "a%2fb"])(
    "rejects object key %s",
    async (key) => {
      await expect(
        new AzureBlobRawArtifactStore(options("reader")).open({ objectKey: key }),
      ).rejects.toBeInstanceOf(AzureArtifactStoreError);
      expect(wire.send).not.toHaveBeenCalled();
    },
  );
});

describe("strict selected read identity snapshots", () => {
  const location = { kind: "azure-blob-version" as const, containerUrl: endpoint, prefix };
  const selected = {
    ...location,
    objectKey: "Backups/A.enc",
    blobName: prefix + "Backups/A.enc",
    versionId: "Opaque-Case-V1",
    contentLength: 125,
  };
  const expected = {
    ...location,
    objectKey: selected.objectKey,
    contentLength: 125,
    maximumObjectBytes: 1024,
  };
  it("copies exact observed scalar fields and keeps opaque case", () => {
    const input = { ...selected };
    const result = snapshotAzureBlobVersionReadIdentity(input, expected);
    input.versionId = "replaced";
    expect(result).toEqual(selected);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    { kind: "azure-blob-current" },
    { containerUrl: endpoint + "?sig=PRIVATE" },
    { prefix: "foreign/" },
    { objectKey: "backups/a.enc" },
    { blobName: selected.blobName.toLowerCase() },
    { versionId: "" },
    { versionId: "a".repeat(1025) },
    { versionId: "é".repeat(513) },
    { versionId: "\ud800" },
    { versionId: "x\n" },
    { versionId: { toString: (): string => "Opaque-Case-V1" } },
    { contentLength: 0 },
    { contentLength: 126 },
    { contentLength: Number.MAX_SAFE_INTEGER + 1 },
    { contentLength: "125" },
    { extra: "PRIVATE" },
  ])("refuses invalid observations %j", (patch) => {
    expect(() => snapshotAzureBlobVersionReadIdentity({ ...selected, ...patch }, expected)).toThrow(
      AzureArtifactStoreError,
    );
  });
  it("rejects hidden properties, symbols, accessors and foreign prototypes without invoking getters", () => {
    let invoked = 0;
    const getter = Object.defineProperty({ ...selected }, "versionId", {
      get() {
        invoked++;
        return "PRIVATE";
      },
    });
    const hidden = Object.defineProperty({ ...selected }, "secret", { value: "PRIVATE" });
    for (const value of [
      getter,
      hidden,
      { ...selected, [Symbol("extra")]: true },
      Object.assign(Object.create(null), selected),
    ])
      expect(() => snapshotAzureBlobVersionReadIdentity(value, expected)).toThrow(
        AzureArtifactStoreError,
      );
    expect(invoked).toBe(0);
  });
  it.each([0, -1, 124, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid or exceeded object maximum %s",
    (maximumObjectBytes) => {
      expect(() =>
        snapshotAzureBlobVersionReadIdentity(selected, { ...expected, maximumObjectBytes }),
      ).toThrow(AzureArtifactStoreError);
    },
  );
});
