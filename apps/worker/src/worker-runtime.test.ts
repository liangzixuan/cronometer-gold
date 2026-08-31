import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDatabaseReady: vi.fn(),
  clientInstances: [] as unknown[],
  clientOptions: [] as unknown[],
  createDatabase: vi.fn(),
  createRepository: vi.fn(),
  createStorage: vi.fn(),
  database: { destroy: vi.fn() },
  repository: { kind: "retention-repository" },
  retentionPoll: vi.fn(),
  searchPoll: vi.fn(),
  storage: {
    erasureLedger: { kind: "erasure-ledger" },
    exportArtifactStore: { kind: "export-store" },
  },
}));

vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  assertDatabaseReady: mocks.assertDatabaseReady,
  createDatabaseFromEnvironment: mocks.createDatabase,
}));
vi.mock("@nutrition-tracker/search", () => ({
  MeilisearchHttpClient: class {
    constructor(options: unknown) {
      mocks.clientOptions.push(options);
      mocks.clientInstances.push(this);
    }
  },
}));
vi.mock("./food-search-worker.js", () => ({ runFoodSearchWorkerPoll: mocks.searchPoll }));
vi.mock("./retention-database-repository.js", () => ({
  createRetentionWorkerRepository: mocks.createRepository,
}));
vi.mock("./retention-storage.js", () => ({
  createRetentionStorageRuntime: mocks.createStorage,
}));
vi.mock("./retention-worker.js", () => ({ runRetentionWorkerPoll: mocks.retentionPoll }));

import {
  createWorkerPollRuntime,
  WorkerDatabaseCleanupTimeoutError,
  type WorkerOperationalEvent,
  WorkerPollDrainTimeoutError,
} from "./worker-runtime.js";

function retentionEnvironment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://local.invalid/nutrition",
    ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "ledger-v1",
    ERASURE_REPLAY_LEDGER_DIRECTORY: "/tmp/worker-runtime-test-ledger",
    ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
      "ledger-v1": Buffer.alloc(32, 2).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
    ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 3).toString("base64"),
    }),
    EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
    EXPORT_ARTIFACT_DIRECTORY: "/tmp/worker-runtime-test-exports",
    EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
      "export-v1": Buffer.alloc(32, 1).toString("base64"),
    }),
    MEILI_ADMIN_KEY: "scoped-worker-key-long-enough",
    MEILI_TASK_OBSERVER_KEY: "scoped-task-observer-key-long-enough",
    MEILI_URL: "http://127.0.0.1:7700",
    NODE_ENV: "test",
    RETENTION_EXPORT_SPOOL_DIR: "/tmp/worker-runtime-test-spool",
    RETENTION_FEATURES_ENABLED: "true",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientInstances.length = 0;
  mocks.clientOptions.length = 0;
  mocks.createDatabase.mockReturnValue(mocks.database);
  mocks.createRepository.mockReturnValue(mocks.repository);
  mocks.createStorage.mockResolvedValue(mocks.storage);
  mocks.database.destroy.mockResolvedValue(undefined);
  mocks.searchPoll.mockResolvedValue({ status: "idle" });
  mocks.retentionPoll.mockResolvedValue(undefined);
  mocks.assertDatabaseReady.mockResolvedValue(undefined);
});

describe("worker poll runtime factory", () => {
  it("shares production dependencies across one bounded poll and closes once", async () => {
    const events: WorkerOperationalEvent[] = [];
    const clock = () => new Date("2026-08-30T12:34:56.000Z");
    const environment = retentionEnvironment();
    const runtime = await createWorkerPollRuntime({
      clock,
      environment,
      onOperationalEvent: (event) => events.push(event),
    });
    const controller = new AbortController();
    const signal = controller.signal;

    expect(mocks.createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ DATABASE_URL: environment.DATABASE_URL }),
    );
    expect(mocks.clientOptions).toEqual([
      {
        apiKey: environment.MEILI_ADMIN_KEY,
        host: environment.MEILI_URL,
        requestTimeoutMs: 5_000,
        taskApiKey: environment.MEILI_TASK_OBSERVER_KEY,
      },
    ]);
    expect(mocks.createStorage).toHaveBeenCalledWith(
      expect.objectContaining({ RETENTION_FEATURES_ENABLED: true }),
      { clock },
    );
    expect(mocks.assertDatabaseReady).toHaveBeenCalledWith(mocks.database, {
      requireRestoreAttestation: false,
    });
    expect(mocks.createRepository).toHaveBeenCalledWith(mocks.database);

    await runtime.pollOnce(signal);
    const runtimeSignal = (
      mocks.searchPoll.mock.calls[0]?.[0] as { readonly signal?: AbortSignal } | undefined
    )?.signal;
    expect(runtimeSignal).toBeInstanceOf(AbortSignal);
    expect(runtimeSignal).not.toBe(signal);
    expect(runtimeSignal?.aborted).toBe(false);
    expect(mocks.searchPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        client: mocks.clientInstances[0],
        database: mocks.database,
        signal: runtimeSignal,
      }),
    );
    expect(mocks.retentionPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        clock,
        erasureLedger: mocks.storage.erasureLedger,
        exportArtifactStore: mocks.storage.exportArtifactStore,
        repository: mocks.repository,
        temporaryDirectory: environment.RETENTION_EXPORT_SPOOL_DIR,
        uploadLeaseMs: 60_000,
      }),
      runtimeSignal,
    );
    expect(events).toEqual([]);
    controller.abort();
    expect(runtimeSignal?.aborted).toBe(true);

    await Promise.all([runtime.close(), runtime.close()]);
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
    await expect(runtime.pollOnce()).rejects.toThrow("Worker poll runtime is closed");
  });

  it("continues to retention after a sanitized search failure", async () => {
    const events: WorkerOperationalEvent[] = [];
    const privateValue = "private-search-failure-must-not-leak";
    const failure = new Error(privateValue);
    failure.name = "SearchBackendFailure";
    mocks.searchPoll.mockRejectedValue(failure);
    const runtime = await createWorkerPollRuntime({
      environment: retentionEnvironment(),
      onOperationalEvent: (event) => events.push(event),
    });

    await runtime.pollOnce();
    expect(mocks.retentionPoll).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      errorType: "SearchBackendFailure",
      event: "worker.poll.slice_failed",
      level: "warn",
      slice: "search",
    });
    expect(JSON.stringify(events)).not.toContain(privateValue);
    await runtime.close();
  });

  it("skips retention dependencies when the feature is disabled", async () => {
    const runtime = await createWorkerPollRuntime({
      environment: {
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "test",
      },
      onOperationalEvent: vi.fn(),
    });
    await runtime.pollOnce();

    expect(mocks.createStorage).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
    expect(mocks.retentionPoll).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("destroys the database and preserves initialization plus cleanup failures", async () => {
    const primary = new Error("synthetic repository failure");
    const cleanup = new Error("synthetic database cleanup failure");
    mocks.createRepository.mockImplementation(() => {
      throw primary;
    });
    mocks.database.destroy.mockRejectedValue(cleanup);

    const failure = await createWorkerPollRuntime({
      environment: retentionEnvironment(),
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
  });

  it("rejects unsafe S3 configuration before allocating any runtime dependency", async () => {
    const environment = {
      ...retentionEnvironment(),
      ERASURE_REPLAY_LEDGER_BUCKET: "nutrition-erasure-ledger",
      ERASURE_REPLAY_LEDGER_ENDPOINT: "http://127.0.0.1:9000/private",
      ERASURE_REPLAY_LEDGER_REGION: "us-east-1",
      ERASURE_REPLAY_LEDGER_STORE: "s3",
      ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: "ledger-writer",
      ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: "ledger-writer-secret",
      EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
      EXPORT_ARTIFACT_ENDPOINT: "http://127.0.0.1:9000",
      EXPORT_ARTIFACT_REGION: "us-east-1",
      EXPORT_ARTIFACT_STORE: "s3",
      EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: "export-writer",
      EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "export-writer-secret",
    };

    await expect(createWorkerPollRuntime({ environment })).rejects.toMatchObject({
      issues: [{ field: "ERASURE_REPLAY_LEDGER_ENDPOINT" }],
    });
    expect(mocks.clientOptions).toEqual([]);
    expect(mocks.createDatabase).not.toHaveBeenCalled();
    expect(mocks.createStorage).not.toHaveBeenCalled();
    expect(mocks.createRepository).not.toHaveBeenCalled();
  });

  it("rejects concurrent polls while allowing the admitted poll to finish", async () => {
    let finishSearch: (() => void) | undefined;
    mocks.searchPoll.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSearch = () => resolve({ status: "idle" });
        }),
    );
    const runtime = await createWorkerPollRuntime({
      environment: retentionEnvironment(),
      onOperationalEvent: vi.fn(),
    });

    const admitted = runtime.pollOnce();
    await expect(runtime.pollOnce()).rejects.toThrow(
      "Worker poll runtime already has an active poll",
    );
    finishSearch?.();
    await admitted;
    await runtime.close();
  });

  it("aborts and drains a cooperative poll before database cleanup without starting retention", async () => {
    const order: string[] = [];
    let observedSignal: AbortSignal | undefined;
    mocks.searchPoll.mockImplementation((input: unknown) => {
      const signal = (input as { readonly signal: AbortSignal }).signal;
      observedSignal = signal;
      return new Promise<{ readonly status: "idle" }>((resolvePromise) => {
        signal.addEventListener(
          "abort",
          () => {
            order.push("poll-aborted");
            resolvePromise({ status: "idle" });
          },
          { once: true },
        );
      });
    });
    mocks.database.destroy.mockImplementation(async () => {
      order.push("database-destroyed");
    });
    const runtime = await createWorkerPollRuntime({
      environment: { ...retentionEnvironment(), SHUTDOWN_GRACE_MS: "250" },
      onOperationalEvent: vi.fn(),
    });

    const admitted = runtime.pollOnce();
    expect(observedSignal?.aborted).toBe(false);
    const close = runtime.close();
    const rejectedAdmission = expect(runtime.pollOnce()).rejects.toThrow(
      "Worker poll runtime is closed",
    );

    await Promise.all([admitted, close, rejectedAdmission]);
    expect(observedSignal?.aborted).toBe(true);
    expect(order).toEqual(["poll-aborted", "database-destroyed"]);
    expect(mocks.retentionPoll).not.toHaveBeenCalled();
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
    await runtime.close();
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
  });

  it("bounds an ignored poll and reports its timeout with database cleanup failure", async () => {
    vi.useFakeTimers();
    try {
      let finishSearch: (() => void) | undefined;
      let observedSignal: AbortSignal | undefined;
      mocks.searchPoll.mockImplementation((input: unknown) => {
        observedSignal = (input as { readonly signal: AbortSignal }).signal;
        return new Promise<{ readonly status: "idle" }>((resolvePromise) => {
          finishSearch = () => resolvePromise({ status: "idle" });
        });
      });
      const cleanupFailure = new Error("synthetic close cleanup failure");
      mocks.database.destroy.mockRejectedValue(cleanupFailure);
      const runtime = await createWorkerPollRuntime({
        environment: { ...retentionEnvironment(), SHUTDOWN_GRACE_MS: "100" },
        onOperationalEvent: vi.fn(),
      });

      const admitted = runtime.pollOnce();
      const closeResult = runtime.close().catch((error) => error);
      expect(observedSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(99);
      expect(mocks.database.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const failure = await closeResult;
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBeInstanceOf(WorkerPollDrainTimeoutError);
      expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
      expect(mocks.database.destroy).toHaveBeenCalledOnce();
      expect(mocks.retentionPoll).not.toHaveBeenCalled();
      expect(await runtime.close().catch((error) => error)).toBe(failure);

      finishSearch?.();
      await admitted;
      expect(mocks.retentionPoll).not.toHaveBeenCalled();
      expect(mocks.database.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a poll-drain budget already exhausted by the process runtime", async () => {
    let finishSearch: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    mocks.searchPoll.mockImplementation((input: unknown) => {
      observedSignal = (input as { readonly signal: AbortSignal }).signal;
      return new Promise<{ readonly status: "idle" }>((resolvePromise) => {
        finishSearch = () => resolvePromise({ status: "idle" });
      });
    });
    const runtime = await createWorkerPollRuntime({
      environment: { ...retentionEnvironment(), SHUTDOWN_GRACE_MS: "100" },
      onOperationalEvent: vi.fn(),
    });

    const admitted = runtime.pollOnce();
    await runtime.close({ pollDrainAlreadyTimedOut: true });
    expect(observedSignal?.aborted).toBe(true);
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
    expect(mocks.retentionPoll).not.toHaveBeenCalled();

    finishSearch?.();
    await admitted;
    expect(mocks.retentionPoll).not.toHaveBeenCalled();
    await runtime.close();
    expect(mocks.database.destroy).toHaveBeenCalledOnce();
  });

  it("bounds database cleanup and observes a rejection that arrives after its timeout", async () => {
    vi.useFakeTimers();
    try {
      let rejectCleanup: (reason?: unknown) => void = (_reason?: unknown) => {
        throw new Error("database cleanup promise was not created");
      };
      mocks.database.destroy.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCleanup = reject;
          }),
      );
      const runtime = await createWorkerPollRuntime({
        environment: { ...retentionEnvironment(), SHUTDOWN_GRACE_MS: "100" },
        onOperationalEvent: vi.fn(),
      });

      const closeResult = runtime.close().catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.database.destroy).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      const failure = await closeResult;
      expect(failure).toBeInstanceOf(WorkerDatabaseCleanupTimeoutError);
      expect(await runtime.close().catch((error) => error)).toBe(failure);
      expect(mocks.database.destroy).toHaveBeenCalledOnce();

      rejectCleanup(new Error("late database cleanup rejection"));
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});
