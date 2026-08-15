import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type CommandIo, runCommand } from "../src/run.js";

function testIo(environment: NodeJS.ProcessEnv = {}): {
  readonly errors: string[];
  readonly io: CommandIo;
  readonly output: string[];
} {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    io: {
      environment,
      writeError: (value) => errors.push(value),
      writeOutput: (value) => output.push(value),
    },
    output,
  };
}

describe("operator command authority boundary", () => {
  it("rejects an approval before opening the database when no trusted runner identity exists", async () => {
    const { errors, io, output } = testIo();

    const exitCode = await runCommand(
      [
        "catalogue",
        "approve",
        "--batch-id",
        "batch-id",
        "--role",
        "data",
        "--principal-id",
        "caller-authored",
      ],
      io,
    );

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("externally authenticated");
  });

  it("rejects incomplete externally injected identity context before database access", async () => {
    const { errors, io } = testIo({
      INGEST_AUTHENTICATION_METHOD: "oidc",
      INGEST_AUTHENTICATED_PRINCIPAL_ID: "service:release-operator",
    });

    const exitCode = await runCommand(["catalogue", "promote", "--batch-id", "batch-id"], io);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("INGEST_AUTHENTICATION_RUN_REFERENCE");
  });

  it("rejects an unknown mapping key instead of silently defaulting a conversion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nutrition-ingest-cli-"));
    const mappingPath = join(directory, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            conversionMultipler: "0.001",
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "mg",
          },
        ],
        reviewedAt: "2026-08-15T12:00:00Z",
        reviewedBy: "service:mapping-reviewer",
        sourceCode: "USDA_FDC",
      }),
    );
    const { errors, io } = testIo({
      INGEST_AUTHENTICATION_METHOD: "oidc",
      INGEST_AUTHENTICATED_PRINCIPAL_ID: "service:mapping-reviewer",
      INGEST_AUTHENTICATION_RUN_REFERENCE: "https://runner.example/runs/123",
    });

    const exitCode = await runCommand(["catalogue", "mappings", mappingPath], io);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("unknown field conversionMultipler");
    await rm(directory, { force: true, recursive: true });
  });
});
