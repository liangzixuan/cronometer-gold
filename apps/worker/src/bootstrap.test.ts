import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { workerFailureEvent } from "./index.js";

describe("worker bootstrap boundary", () => {
  it("never includes an operational error message", () => {
    const privateValue = "private-diary-job-value-must-not-leak";
    expect(JSON.stringify(workerFailureEvent(new Error(privateValue)))).not.toContain(privateValue);
  });

  it("reports invalid fields without printing environment values or a stack", () => {
    const privateValue = "private-invalid-poll-interval-must-not-leak";
    const workerRoot = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: workerRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        POLL_INTERVAL_MS: privateValue,
      },
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"event":"worker.bootstrap.failed"');
    expect(result.stderr).toContain('"invalidFields":["POLL_INTERVAL_MS"]');
    expect(result.stderr).not.toContain(privateValue);
    expect(result.stderr).not.toContain(" at ");
  });
});
