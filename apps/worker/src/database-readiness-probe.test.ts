import { describe, expect, it } from "vitest";

import { runDatabaseReadinessProbeFromEnvironment } from "./database-readiness-probe.js";

describe("database readiness probe", () => {
  it("fails before opening a database when the explicit restore epoch is absent or ambiguous", async () => {
    await expect(runDatabaseReadinessProbeFromEnvironment({})).rejects.toThrow(
      "DATABASE_RESTORE_EPOCH",
    );
    await expect(
      runDatabaseReadinessProbeFromEnvironment({
        DATABASE_RESTORE_EPOCH: ` ${"a".repeat(32)}`,
      }),
    ).rejects.toThrow("DATABASE_RESTORE_EPOCH");
  });
});
