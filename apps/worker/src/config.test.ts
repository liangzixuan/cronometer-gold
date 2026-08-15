import { describe, expect, it } from "vitest";

import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";

describe("worker configuration", () => {
  it("uses bounded local defaults", () => {
    expect(parseWorkerConfig({})).toMatchObject({
      POLL_INTERVAL_MS: 1_000,
      SHUTDOWN_GRACE_MS: 10_000,
    });
  });

  it("validates the shutdown grace period", () => {
    expect(() => parseWorkerConfig({ SHUTDOWN_GRACE_MS: "99" })).toThrow(
      WorkerConfigValidationError,
    );
    expect(parseWorkerConfig({ SHUTDOWN_GRACE_MS: "25000" }).SHUTDOWN_GRACE_MS).toBe(25_000);
  });
});
