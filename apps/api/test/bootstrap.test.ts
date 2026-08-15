import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("API bootstrap boundary", () => {
  it("reports invalid fields without printing environment values or a stack", () => {
    const privateValue = "private-invalid-port-must-not-leak";
    const apiRoot = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        API_PORT: privateValue,
        LOG_LEVEL: "silent",
      },
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"event":"api.bootstrap.failed"');
    expect(result.stderr).toContain('"invalidFields":["API_PORT"]');
    expect(result.stderr).not.toContain(privateValue);
    expect(result.stderr).not.toContain(" at ");
  });
});
