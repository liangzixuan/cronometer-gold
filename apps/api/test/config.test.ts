import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "../src/config.js";

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
