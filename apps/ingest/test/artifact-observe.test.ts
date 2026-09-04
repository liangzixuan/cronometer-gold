import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AcquireArtifactOptions } from "@nutrition-tracker/ingestion";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataReadState = vi.hoisted(() => ({
  calls: 0,
  contents: undefined as string | undefined,
  fail: true,
  marker: "metadata-read-error-must-not-leak".repeat(1_000),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: ((...arguments_: unknown[]) => {
      metadataReadState.calls += 1;
      if (metadataReadState.fail) {
        const error = new Error(`ENOENT: ${metadataReadState.marker}`);
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
      if (metadataReadState.contents !== undefined) return metadataReadState.contents;
      return Reflect.apply(original.readFileSync, undefined, arguments_);
    }) as typeof original.readFileSync,
  };
});

const acquireArtifactAttempt = vi.hoisted(() => vi.fn());
vi.mock("@nutrition-tracker/ingestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/ingestion")>()),
  acquireArtifact: acquireArtifactAttempt,
}));

import { type CommandIo, runCommand } from "../src/run.js";

const CANDIDATE = resolve(
  import.meta.dirname,
  "../../../data/manifests/usda-fdc-full-csv-2026-04-30.candidate.json",
);
const SHA256 = "a".repeat(64);
const TRUSTED_RUNNER_ENVIRONMENT = Object.freeze({
  INGEST_AUTHENTICATED_PRINCIPAL_ID: "principal:fdc-observer-a",
  INGEST_AUTHENTICATION_METHOD: "oidc",
  INGEST_AUTHENTICATION_RUN_REFERENCE: "urn:nutrition-tracker:test:artifact-observe",
  npm_package_version: "caller-controlled-version-must-not-be-used",
});

function testIo(environment: NodeJS.ProcessEnv = TRUSTED_RUNNER_ENVIRONMENT): {
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

describe("artifact observation CLI boundary", () => {
  beforeEach(() => {
    acquireArtifactAttempt.mockReset();
    metadataReadState.calls = 0;
    metadataReadState.contents = undefined;
    metadataReadState.fail = false;
  });

  const exactArguments = Object.freeze([
    "artifact",
    "observe",
    "/manifest-must-not-be-read.json",
    "--cache-dir",
    "/cache-must-not-be-created",
    "--observation-out",
    "/observation-must-not-be-created.json",
  ]);

  it.each([
    {
      arguments_: [...exactArguments, "unexpected-positional"],
      expected: "artifact observe requires exactly one manifest path",
      name: "an extra positional",
    },
    {
      arguments_: exactArguments.filter(
        (value) => value !== "--cache-dir" && value !== "/cache-must-not-be-created",
      ),
      expected: "--cache-dir requires a non-blank value",
      name: "a missing cache directory",
    },
    {
      arguments_: exactArguments.filter(
        (value) =>
          value !== "--observation-out" && value !== "/observation-must-not-be-created.json",
      ),
      expected: "--observation-out requires a non-blank value",
      name: "a missing observation path",
    },
    {
      arguments_: [...exactArguments, "--tool", "caller-authored/9.9.9"],
      expected: "Unknown artifact observe option: --tool",
      name: "a caller-authored tool identity",
    },
    {
      arguments_: [...exactArguments, "--actor", "caller-authored"],
      expected: "Unknown artifact observe option: --actor",
      name: "a caller-authored actor",
    },
    {
      arguments_: [...exactArguments, "--__proto__=caller-authored"],
      expected: "Unknown artifact observe option: --__proto__",
      name: "a prototype-like option",
    },
  ])("rejects $name before reading the manifest or acquiring an artifact", async (testCase) => {
    const { errors, io, output } = testIo();

    expect(await runCommand(testCase.arguments_, io)).toBe(1);

    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain(testCase.expected);
    expect(errors.join("\n")).not.toContain("ENOENT");
    expect(acquireArtifactAttempt).not.toHaveBeenCalled();
  });

  it("loads package metadata only for artifact observation and bounds read failures", async () => {
    const unrelated = testIo();
    expect(await runCommand(["manifest", "validate", CANDIDATE], unrelated.io)).toBe(0);
    expect(unrelated.errors).toEqual([]);
    expect(metadataReadState.calls).toBe(0);

    metadataReadState.fail = true;
    const observation = testIo();
    expect(
      await runCommand(
        [
          "artifact",
          "observe",
          CANDIDATE,
          "--cache-dir",
          "/cache-must-not-be-created",
          "--observation-out",
          "/observation-must-not-be-created.json",
        ],
        observation.io,
      ),
    ).toBe(1);

    expect(metadataReadState.calls).toBe(1);
    expect(acquireArtifactAttempt).not.toHaveBeenCalled();
    expect(observation.output).toEqual([]);
    expect(observation.errors).toEqual(["Unable to read co-located ingest package metadata\n"]);
    expect(observation.errors.join("\n")).not.toContain(metadataReadState.marker);
  });

  it.each(["1.2.3-.", "1.2.3+..", "1.2.3-01"])(
    "rejects noncanonical package version %s before acquisition",
    async (version) => {
      metadataReadState.contents = JSON.stringify({
        name: "@nutrition-tracker/ingest",
        version,
      });
      const { errors, io, output } = testIo();

      expect(
        await runCommand(
          [
            "artifact",
            "observe",
            CANDIDATE,
            "--cache-dir",
            "/cache-must-not-be-created",
            "--observation-out",
            "/observation-must-not-be-created.json",
          ],
          io,
        ),
      ).toBe(1);

      expect(metadataReadState.calls).toBe(1);
      expect(acquireArtifactAttempt).not.toHaveBeenCalled();
      expect(output).toEqual([]);
      expect(errors).toEqual([
        "Ingest package metadata must have the expected name and a canonical numeric version\n",
      ]);
    },
  );

  it("derives the recorded tool identity from co-located package metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nutrition-artifact-observe-"));
    const cacheDirectory = join(directory, "cache");
    const observationPath = join(directory, "evidence", "observation.json");
    acquireArtifactAttempt.mockImplementation(async (options: AcquireArtifactOptions) => ({
      cacheHit: false,
      observation: {
        acquisitionId: "11111111-1111-4111-8111-111111111111",
        byteSize: 123,
        downloadUrl: String(options.source),
        etag: null,
        freshDownload: true,
        lastModified: null,
        observedAt: "2026-09-04T12:00:00.000Z",
        operatorPrincipalId: options.operatorPrincipalId,
        resolvedUrl: String(options.source),
        sha256: SHA256,
        tool: options.tool,
        transport: "https" as const,
      },
      path: join(cacheDirectory, "sha256", SHA256),
      verification: { status: "unverified-observation" as const },
    }));
    try {
      const { errors, io, output } = testIo();

      expect(
        await runCommand(
          [
            "artifact",
            "observe",
            CANDIDATE,
            "--cache-dir",
            cacheDirectory,
            "--observation-out",
            observationPath,
          ],
          io,
        ),
      ).toBe(0);

      expect(errors).toEqual([]);
      expect(output).toHaveLength(1);
      expect(acquireArtifactAttempt).toHaveBeenCalledOnce();
      expect(metadataReadState.calls).toBe(1);
      const options = acquireArtifactAttempt.mock.calls[0]?.[0] as AcquireArtifactOptions;
      expect(options.tool).toBe("nutrition-tracker-ingest/0.1.0");
      expect(JSON.parse(await readFile(observationPath, "utf8"))).toMatchObject({
        operatorPrincipalId: "principal:fdc-observer-a",
        tool: "nutrition-tracker-ingest/0.1.0",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
