import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createRuntime: vi.fn(),
  pollOnce: vi.fn(),
  runWorker: vi.fn(),
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  runWorker: mocks.runWorker,
}));
vi.mock("./worker-runtime.js", () => ({
  assertWorkerDatabaseReady: vi.fn(),
  createWorkerPollRuntime: mocks.createRuntime,
}));

import {
  startWorker,
  workerGracefulShutdownPhaseCount,
  workerShutdownWatchdogMaximumMs,
  workerShutdownWatchdogTimeoutMs,
} from "./index.js";
import { WorkerShutdownTimeoutError } from "./runtime.js";

function watchdogHarness() {
  const signals = new EventEmitter();
  const exit = vi.fn();
  const callback = { current: undefined as (() => void) | undefined };
  const unref = vi.fn();
  const handle = { kind: "referenced-worker-shutdown-watchdog", unref };
  const clear = vi.fn();
  const set = vi.fn((listener: () => void, _timeoutMs: number) => {
    callback.current = listener;
    return handle;
  });
  return {
    callback,
    clear,
    exit,
    handle,
    processRuntime: {
      exit,
      once: (signal: NodeJS.Signals, listener: () => void) => signals.once(signal, listener),
      removeListener: (signal: NodeJS.Signals, listener: () => void) =>
        signals.removeListener(signal, listener),
    },
    set,
    signals,
    unref,
    watchdogTimers: { clear, set },
  };
}

async function waitForSignalListeners(signals: EventEmitter): Promise<void> {
  await vi.waitFor(() => {
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.createRuntime.mockResolvedValue({
    close: mocks.close,
    pollIntervalMs: 1_000,
    pollOnce: mocks.pollOnce,
    shutdownGraceMs: 10_000,
  });
  mocks.runWorker.mockResolvedValue(undefined);
});

describe("worker entrypoint lifecycle", () => {
  it("derives the referenced watchdog from both allowed shutdown phases", () => {
    expect(workerGracefulShutdownPhaseCount).toBe(2);
    expect(workerShutdownWatchdogTimeoutMs(10_000)).toBe(22_500);
    expect(workerShutdownWatchdogTimeoutMs(300_000)).toBe(602_500);
    expect(workerShutdownWatchdogMaximumMs).toBe(602_500);
    for (const invalid of [99, 300_001, 10_000.5, Number.NaN]) {
      expect(() => workerShutdownWatchdogTimeoutMs(invalid)).toThrow(
        "Worker requires a bounded shutdown grace period",
      );
    }
  });

  it("arms on a termination signal and clears only after a clean close", async () => {
    const harness = watchdogHarness();
    mocks.runWorker.mockImplementation(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const running = startWorker({
      environment: {},
      processRuntime: harness.processRuntime,
      watchdogTimers: harness.watchdogTimers,
    });
    await waitForSignalListeners(harness.signals);

    harness.signals.emit("SIGTERM");
    await running;

    expect(harness.set).toHaveBeenCalledOnce();
    expect(harness.set).toHaveBeenCalledWith(expect.any(Function), 22_500);
    expect(harness.clear).toHaveBeenCalledOnce();
    expect(harness.clear).toHaveBeenCalledWith(harness.handle);
    expect(harness.unref).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    expect(harness.signals.listenerCount("SIGINT")).toBe(0);
    expect(harness.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("keeps the watchdog referenced after a signal-driven poll timeout", async () => {
    const harness = watchdogHarness();
    const timeout = new WorkerShutdownTimeoutError(10_000);
    mocks.runWorker.mockImplementation(async ({ signal }: { readonly signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw timeout;
    });
    const running = startWorker({
      environment: {},
      processRuntime: harness.processRuntime,
      watchdogTimers: harness.watchdogTimers,
    });
    const failure = running.catch((error) => error);
    await waitForSignalListeners(harness.signals);

    harness.signals.emit("SIGINT");
    expect(await failure).toBe(timeout);
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.unref).not.toHaveBeenCalled();
    expect(harness.callback.current).toBeTypeOf("function");
    harness.callback.current?.();
    expect(harness.exit).toHaveBeenCalledOnce();
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("keeps the watchdog referenced after another signal-driven execution failure", async () => {
    const harness = watchdogHarness();
    const executionFailure = new Error("synthetic signal-driven execution failure");
    mocks.runWorker.mockImplementation(async ({ signal }: { readonly signal: AbortSignal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw executionFailure;
    });
    const running = startWorker({
      environment: {},
      processRuntime: harness.processRuntime,
      watchdogTimers: harness.watchdogTimers,
    });
    const failure = running.catch((error) => error);
    await waitForSignalListeners(harness.signals);

    harness.signals.emit("SIGTERM");
    expect(await failure).toBe(executionFailure);
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.unref).not.toHaveBeenCalled();
    harness.callback.current?.();
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("keeps the watchdog referenced after signal-driven cleanup failure", async () => {
    const harness = watchdogHarness();
    const cleanupFailure = new Error("synthetic cleanup failure");
    mocks.runWorker.mockImplementation(
      ({ signal }: { readonly signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    mocks.close.mockRejectedValue(cleanupFailure);
    const running = startWorker({
      environment: {},
      processRuntime: harness.processRuntime,
      watchdogTimers: harness.watchdogTimers,
    });
    const failure = running.catch((error) => error);
    await waitForSignalListeners(harness.signals);

    harness.signals.emit("SIGTERM");
    expect(await failure).toBe(cleanupFailure);
    expect(harness.clear).not.toHaveBeenCalled();
    harness.callback.current?.();
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("does not arm or force-exit on ordinary startup validation failure", async () => {
    const harness = watchdogHarness();
    const startupFailure = new Error("synthetic configuration failure");
    mocks.createRuntime.mockRejectedValue(startupFailure);

    await expect(
      startWorker({
        environment: {},
        processRuntime: harness.processRuntime,
        watchdogTimers: harness.watchdogTimers,
      }),
    ).rejects.toBe(startupFailure);
    expect(harness.set).not.toHaveBeenCalled();
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
    expect(harness.signals.listenerCount("SIGINT")).toBe(0);
    expect(harness.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not silently convert a falsy execution rejection into success", async () => {
    mocks.runWorker.mockRejectedValue(undefined);
    let rejected = false;
    try {
      await startWorker({ environment: {} });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.close.mock.calls[0]).toEqual([]);
  });

  it("does not silently convert a falsy cleanup rejection into success", async () => {
    mocks.close.mockRejectedValue(null);
    let rejected = false;
    try {
      await startWorker({ environment: {} });
    } catch (error) {
      rejected = true;
      expect(error).toBeNull();
    }
    expect(rejected).toBe(true);
  });

  it("aggregates falsy execution and cleanup failures", async () => {
    mocks.runWorker.mockRejectedValue(false);
    mocks.close.mockRejectedValue(undefined);

    const failure = await startWorker({ environment: {} }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([false, undefined]);
  });

  it("does not spend the poll-drain grace again after runWorker times out", async () => {
    const timeout = new WorkerShutdownTimeoutError(10_000);
    mocks.runWorker.mockRejectedValue(timeout);

    await expect(startWorker({ environment: {} })).rejects.toBe(timeout);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledWith({ pollDrainAlreadyTimedOut: true });
  });

  it("preserves execution and bounded-cleanup failures after the drain budget is exhausted", async () => {
    const timeout = new WorkerShutdownTimeoutError(10_000);
    const cleanup = new Error("synthetic bounded cleanup failure");
    mocks.runWorker.mockRejectedValue(timeout);
    mocks.close.mockRejectedValue(cleanup);

    const failure = await startWorker({ environment: {} }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([timeout, cleanup]);
    expect(mocks.close).toHaveBeenCalledWith({ pollDrainAlreadyTimedOut: true });
  });
});
