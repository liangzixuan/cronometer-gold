import { describe, expect, it } from "vitest";

import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";

describe("worker configuration", () => {
  it("uses bounded local defaults", () => {
    expect(parseWorkerConfig({})).toMatchObject({
      POLL_INTERVAL_MS: 1_000,
      SEARCH_REBUILD_BATCH_SIZE: 500,
      SEARCH_REBUILD_EVENT_BATCH_SIZE: 100,
      SEARCH_REBUILD_SPOOL_MAX_BYTES: 2_147_483_648,
      SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS: 5_000_000,
      SEARCH_REBUILD_WORKER_ID: "local-food-search-worker",
      SEARCH_REQUEST_TIMEOUT_MS: 5_000,
      SEARCH_TASK_TIMEOUT_MS: 120_000,
      SHUTDOWN_GRACE_MS: 10_000,
    });
  });

  it("validates the shutdown grace period", () => {
    expect(() => parseWorkerConfig({ SHUTDOWN_GRACE_MS: "99" })).toThrow(
      WorkerConfigValidationError,
    );
    expect(parseWorkerConfig({ SHUTDOWN_GRACE_MS: "25000" }).SHUTDOWN_GRACE_MS).toBe(25_000);
  });

  it("requires explicit database, admin key, and TLS in production", () => {
    try {
      parseWorkerConfig({ NODE_ENV: "production" });
      throw new Error("expected production worker configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigValidationError);
      expect((error as WorkerConfigValidationError).issues.map((issue) => issue.field)).toEqual([
        "DATABASE_URL",
        "MEILI_ADMIN_KEY",
        "MEILI_URL",
      ]);
    }
  });
});
