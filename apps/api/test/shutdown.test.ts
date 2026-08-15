import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { installGracefulShutdown } from "../src/shutdown.js";

const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

describe("graceful shutdown", () => {
  it("drains the Fastify instance only once", async () => {
    const app = buildApp({ config: testConfig, logger: false });
    await app.ready();
    const closeSpy = vi.spyOn(app, "close");
    const shutdown = installGracefulShutdown(app, { timeoutMs: 1_000 });

    try {
      await Promise.all([shutdown.close("test"), shutdown.close("duplicate-test")]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      shutdown.dispose();
    }
  });
});
