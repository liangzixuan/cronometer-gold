import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { runWorker, WorkerShutdownTimeoutError } from "./runtime.js";

describe("worker runtime", () => {
  it("stops after cancellation without another poll", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onPoll = vi.fn(async (_signal: AbortSignal) => {
      controller.abort();
    });

    await runWorker({
      onPoll,
      pollIntervalMs: 1_000,
      shutdownGraceMs: 1_000,
      signal: controller.signal,
    });

    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not retain abort listeners across completed polling intervals", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let polls = 0;
    const worker = runWorker({
      pollIntervalMs: 100,
      shutdownGraceMs: 1_000,
      signal: controller.signal,
      onPoll: async () => {
        polls += 1;
        if (polls === 20) controller.abort();
      },
    });

    await vi.runAllTimersAsync();
    await worker;

    expect(polls).toBe(20);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("waits for a cooperative in-flight poll to drain after abort", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let finishPoll!: () => void;
    let startedPoll!: () => void;
    const started = new Promise<void>((resolve) => {
      startedPoll = resolve;
    });
    const drain = new Promise<void>((resolve) => {
      finishPoll = resolve;
    });
    const worker = runWorker({
      pollIntervalMs: 1_000,
      shutdownGraceMs: 1_000,
      signal: controller.signal,
      onPoll: async (signal) => {
        observedSignal = signal;
        startedPoll();
        await drain;
      },
    });

    await started;
    controller.abort();
    let settled = false;
    void worker.finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(observedSignal?.aborted).toBe(true);

    finishPoll();
    await worker;
    expect(settled).toBe(true);
  });

  it("fails shutdown when a poll ignores cancellation past the grace period", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let startedPoll!: () => void;
    const started = new Promise<void>((resolve) => {
      startedPoll = resolve;
    });
    const worker = runWorker({
      pollIntervalMs: 1_000,
      shutdownGraceMs: 250,
      signal: controller.signal,
      onPoll: async () => {
        startedPoll();
        await new Promise(() => undefined);
      },
    });

    await started;
    controller.abort();
    const assertion = expect(worker).rejects.toBeInstanceOf(WorkerShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;

    vi.useRealTimers();
  });
});
