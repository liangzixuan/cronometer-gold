import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadApiDependencyConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies safe local defaults", () => {
    expect(loadConfig({})).toEqual({
      apiHost: "127.0.0.1",
      apiPort: 3_001,
      logLevel: "info",
      nodeEnv: "development",
      readinessTimeoutMs: 2_000,
      shutdownGraceMs: 10_000,
    });
  });

  it("coerces validated numeric environment values", () => {
    expect(
      loadConfig({
        API_PORT: "4100",
        READINESS_TIMEOUT_MS: "1500",
        SHUTDOWN_GRACE_MS: "25000",
      }),
    ).toMatchObject({
      apiPort: 4_100,
      readinessTimeoutMs: 1_500,
      shutdownGraceMs: 25_000,
    });
  });

  it("fails fast without including invalid values in the error message", () => {
    const invalidPort = "not-a-port-that-must-not-leak";

    expect(() => loadConfig({ API_PORT: invalidPort })).toThrow(ConfigValidationError);

    try {
      loadConfig({ API_PORT: invalidPort });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual([
        expect.objectContaining({ field: "API_PORT" }),
      ]);
      expect((error as Error).message).not.toContain(invalidPort);
    }
  });
});

describe("loadApiDependencyConfig", () => {
  it("uses loopback search defaults only outside production", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://local.invalid/nutrition",
      meiliUrl: "http://127.0.0.1:7700",
      searchDatabaseMaxConcurrency: 4,
      searchDatabaseMaxQueue: 16,
      searchRequestTimeoutMs: 5_000,
    });
  });

  it("bounds the process-local search database bulkhead configuration", () => {
    expect(
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        NODE_ENV: "development",
        SEARCH_DB_MAX_CONCURRENCY: "2",
        SEARCH_DB_MAX_QUEUE: "3",
      }),
    ).toMatchObject({ searchDatabaseMaxConcurrency: 2, searchDatabaseMaxQueue: 3 });

    expect(() =>
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://local.invalid/nutrition",
        SEARCH_DB_MAX_CONCURRENCY: "0",
      }),
    ).toThrow(ConfigValidationError);
  });

  it("requires a scoped key, cursor secret, and TLS in production", () => {
    try {
      loadApiDependencyConfig({
        DATABASE_URL: "postgresql://production.invalid/nutrition",
        MEILI_URL: "http://search.internal:7700",
        NODE_ENV: "production",
      });
      throw new Error("expected production dependency configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.map((issue) => issue.field)).toEqual([
        "SEARCH_CURSOR_SECRET",
        "MEILI_SEARCH_KEY",
        "MEILI_URL",
      ]);
    }
  });
});
