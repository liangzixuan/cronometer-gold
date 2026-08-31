import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CommandIo,
  runAfterRequiredCleanup,
  runCommand,
  writeCatalogueReconciliationReport,
} from "../src/run.js";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_8_BATCH_ID = "11111111-1111-8111-8111-111111111111";
const CURRENT_RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const VALIDATION_DIGEST = "a".repeat(64);
const REPORT_DIRECTORY = ".local-data/evidence/catalogue-reconciliation";
const REPORT_OUT = `${REPORT_DIRECTORY}/catalogue-reconciliation.json`;
const REPORT_DOCUMENT = { a: "fixture", z: 1 } as const;

function reconcileArguments(overrides: readonly string[] = []): string[] {
  return [
    "catalogue",
    "reconcile",
    "--batch-id",
    BATCH_ID,
    "--expected-current-release-id",
    CURRENT_RELEASE_ID,
    "--expected-validation-digest",
    VALIDATION_DIGEST,
    "--report-out",
    REPORT_OUT,
    ...overrides,
  ];
}

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

describe("catalogue reconciliation CLI boundary", () => {
  const invalidCases: readonly {
    readonly arguments_: readonly string[];
    readonly expectedError: string;
    readonly name: string;
  }[] = [
    {
      arguments_: reconcileArguments(["unexpected-positional"]),
      expectedError: "does not accept positional arguments",
      name: "positional arguments",
    },
    {
      arguments_: [
        "catalogue",
        "reconcile",
        "--expected-current-release-id",
        "none",
        "--expected-validation-digest",
        VALIDATION_DIGEST,
        "--report-out",
        "evidence/report.json",
      ],
      expectedError: "--batch-id requires a non-blank value",
      name: "a missing batch ID",
    },
    {
      arguments_: [
        "catalogue",
        "reconcile",
        "--batch-id",
        BATCH_ID,
        "--expected-validation-digest",
        VALIDATION_DIGEST,
        "--report-out",
        "evidence/report.json",
      ],
      expectedError: "--expected-current-release-id requires a non-blank value",
      name: "a missing expected current release",
    },
    {
      arguments_: [
        "catalogue",
        "reconcile",
        "--batch-id",
        BATCH_ID,
        "--expected-current-release-id",
        "none",
        "--report-out",
        "evidence/report.json",
      ],
      expectedError: "--expected-validation-digest requires a non-blank value",
      name: "a missing validation digest",
    },
    {
      arguments_: [
        "catalogue",
        "reconcile",
        "--batch-id",
        BATCH_ID,
        "--expected-current-release-id",
        "none",
        "--expected-validation-digest",
        VALIDATION_DIGEST,
      ],
      expectedError: "--report-out requires a non-blank value",
      name: "a missing report path",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === REPORT_OUT
          ? ".local-data/evidence/catalogue-reconciliation/../../outside.json"
          : value,
      ),
      expectedError: `--report-out must name a file beneath ${REPORT_DIRECTORY}`,
      name: "a report path that traverses outside the private evidence root",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === REPORT_OUT ? "/tmp/catalogue-reconciliation.json" : value,
      ),
      expectedError: `--report-out must be a relative path beneath ${REPORT_DIRECTORY}`,
      name: "an absolute report path",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === REPORT_OUT ? "/mnt/c/Users/example/catalogue-reconciliation.json" : value,
      ),
      expectedError: `--report-out must be a relative path beneath ${REPORT_DIRECTORY}`,
      name: "a report path on a WSL Windows mount",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === REPORT_OUT ? "C:\\Users\\example\\catalogue-reconciliation.json" : value,
      ),
      expectedError: `--report-out must be a relative path beneath ${REPORT_DIRECTORY}`,
      name: "a Windows drive report path",
    },
    {
      arguments_: reconcileArguments(["--batch-id", BATCH_ID]),
      expectedError: "Invalid or repeated option",
      name: "a repeated option",
    },
    {
      arguments_: reconcileArguments(["--actor", "caller-authored"]),
      expectedError: "Unknown catalogue reconcile option: --actor",
      name: "an unknown option",
    },
    {
      arguments_: reconcileArguments(["--__proto__=ignored"]),
      expectedError: "Unknown catalogue reconcile option: --__proto__",
      name: "a prototype-like unknown option",
    },
    {
      arguments_: reconcileArguments().map((value) => (value === BATCH_ID ? "batch-id" : value)),
      expectedError: "--batch-id must be a canonical lowercase UUID",
      name: "an invalid batch UUID",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === BATCH_ID ? "00000000-0000-0000-0000-000000000000" : value,
      ),
      expectedError: "--batch-id must be a canonical lowercase UUID",
      name: "a nil batch UUID",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === BATCH_ID ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() : value,
      ),
      expectedError: "--batch-id must be a canonical lowercase UUID",
      name: "an uppercase batch UUID",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === BATCH_ID ? "11111111-1111-4111-7111-111111111111" : value,
      ),
      expectedError: "--batch-id must be a canonical lowercase UUID",
      name: "a non-RFC-variant batch UUID",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === BATCH_ID ? "11111111-1111-9111-8111-111111111111" : value,
      ),
      expectedError: "--batch-id must be a canonical lowercase UUID",
      name: "an unsupported-version batch UUID",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === CURRENT_RELEASE_ID ? "NONE" : value,
      ),
      expectedError: "--expected-current-release-id must be a canonical lowercase UUID",
      name: "an invalid expected current release",
    },
    {
      arguments_: reconcileArguments().map((value) =>
        value === VALIDATION_DIGEST ? "A".repeat(64) : value,
      ),
      expectedError: "--expected-validation-digest must be a lowercase SHA-256 digest",
      name: "an uppercase validation digest",
    },
  ];

  it.each(invalidCases)("rejects $name before database access", async (testCase) => {
    const { errors, io, output } = testIo();

    const exitCode = await runCommand(testCase.arguments_, io);

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain(testCase.expectedError);
    expect(errors.join("\n")).not.toContain("DATABASE_URL");
  });

  it("accepts the exact actor-free shape through database configuration", async () => {
    const { errors, io, output } = testIo();
    const arguments_ = reconcileArguments().map((value) => {
      if (value === BATCH_ID) return VERSION_8_BATCH_ID;
      return value === CURRENT_RELEASE_ID ? "none" : value;
    });

    const exitCode = await runCommand(arguments_, io);

    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("DATABASE_URL is required");
    expect(errors.join("\n")).not.toContain("externally authenticated");
  });
});

describe("catalogue reconciliation cleanup ordering", () => {
  it("completes required cleanup before invoking publication", async () => {
    const events: string[] = [];

    await runAfterRequiredCleanup(
      async () => {
        events.push("reconcile");
        return REPORT_DOCUMENT;
      },
      async () => {
        events.push("destroy");
      },
      async () => {
        events.push("publish");
      },
    );

    expect(events).toEqual(["reconcile", "destroy", "publish"]);
  });

  it("never invokes publication or success output when required cleanup fails", async () => {
    const events: string[] = [];

    await expect(
      runAfterRequiredCleanup(
        async () => {
          events.push("reconcile");
          return REPORT_DOCUMENT;
        },
        async () => {
          events.push("destroy");
          throw new Error("database destroy failed");
        },
        async () => {
          events.push("publish");
        },
      ),
    ).rejects.toThrow("database destroy failed");

    expect(events).toEqual(["reconcile", "destroy"]);
  });

  it("preserves both reconciliation and cleanup failures without publishing", async () => {
    const events: string[] = [];
    const reconciliationError = new Error("reconciliation failed");
    const cleanupError = new Error("database destroy failed");
    let failure: unknown;

    try {
      await runAfterRequiredCleanup(
        async () => {
          events.push("reconcile");
          throw reconciliationError;
        },
        async () => {
          events.push("destroy");
          throw cleanupError;
        },
        async () => {
          events.push("publish");
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([reconciliationError, cleanupError]);
    expect(events).toEqual(["reconcile", "destroy"]);
  });
});

describe("catalogue reconciliation report writer", () => {
  it("rejects a workspace rooted on a WSL Windows mount", async () => {
    await expect(
      writeCatalogueReconciliationReport(
        REPORT_OUT,
        REPORT_DOCUMENT,
        "/mnt/c/Users/example/cronometer-gold",
      ),
    ).rejects.toThrow("workspace must reside in the WSL Linux filesystem");
  });

  it("creates a canonical private report and refuses to replace it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-success-"));
    try {
      const reportPath = await writeCatalogueReconciliationReport(
        REPORT_OUT,
        REPORT_DOCUMENT,
        workspace,
      );
      const parentStatistics = await lstat(dirname(reportPath));
      const reportStatistics = await lstat(reportPath);

      expect(reportPath).toBe(join(workspace, ...REPORT_OUT.split("/")));
      expect(await readFile(reportPath, "utf8")).toBe('{"a":"fixture","z":1}\n');
      expect(parentStatistics.isDirectory()).toBe(true);
      expect(parentStatistics.mode & 0o777).toBe(0o700);
      expect(reportStatistics.isFile()).toBe(true);
      expect(reportStatistics.mode & 0o777).toBe(0o600);
      if (typeof process.getuid !== "function") throw new Error("POSIX test runtime is required");
      expect(parentStatistics.uid).toBe(process.getuid());
      expect(reportStatistics.uid).toBe(process.getuid());
      await expect(
        writeCatalogueReconciliationReport(REPORT_OUT, REPORT_DOCUMENT, workspace),
      ).rejects.toThrow("already exists; refusing to overwrite");
      expect(await readFile(reportPath, "utf8")).toBe('{"a":"fixture","z":1}\n');
      expect(await readdir(dirname(reportPath))).toEqual(["catalogue-reconciliation.json"]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("publishes a large canonical report without truncation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-large-"));
    const reportOut = `${REPORT_DIRECTORY}/large.json`;
    const document = {
      rows: Array.from({ length: 10_000 }, (_, index) => ({ index, value: `row-${index}` })),
      scalar: "x".repeat(128 * 1_024 + 1),
    } as const;
    try {
      const reportPath = await writeCatalogueReconciliationReport(reportOut, document, workspace);

      expect(await readFile(reportPath, "utf8")).toBe(`${JSON.stringify(document)}\n`);
      expect((await lstat(reportPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("publishes exactly one complete report when concurrent writers race", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-race-"));
    const reportOut = `${REPORT_DIRECTORY}/race.json`;
    try {
      const results = await Promise.allSettled([
        writeCatalogueReconciliationReport(reportOut, { winner: "first" }, workspace),
        writeCatalogueReconciliationReport(reportOut, { winner: "second" }, workspace),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      const reportParent = join(workspace, ...REPORT_DIRECTORY.split("/"));
      const reportText = await readFile(join(reportParent, "race.json"), "utf8");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = rejected[0];
      if (rejection?.status !== "rejected") {
        throw new Error("Expected one rejected concurrent report publication");
      }
      expect(rejection.reason).toBeInstanceOf(Error);
      expect(String(rejection.reason)).toContain("already exists; refusing to overwrite");
      expect(['{"winner":"first"}\n', '{"winner":"second"}\n']).toContain(reportText);
      expect(await readdir(reportParent)).toEqual(["race.json"]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("removes its temporary file when serialization fails before publication", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-failure-"));
    const reportOut = `${REPORT_DIRECTORY}/failed.json`;
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    try {
      await expect(
        writeCatalogueReconciliationReport(
          reportOut,
          cyclic as unknown as Parameters<typeof writeCatalogueReconciliationReport>[1],
          workspace,
        ),
      ).rejects.toThrow();
      const reportParent = join(workspace, ...REPORT_DIRECTORY.split("/"));
      expect(await readdir(reportParent)).toEqual([]);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects a symbolic-link parent component", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-parent-link-"));
    try {
      const target = join(workspace, "real-parent");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, join(workspace, ".local-data"), "dir");

      await expect(
        writeCatalogueReconciliationReport(REPORT_OUT, REPORT_DOCUMENT, workspace),
      ).rejects.toThrow("parent contains a symbolic link");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects a symbolic-link report leaf", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-leaf-link-"));
    try {
      const reportParent = await createPrivateDirectoryTree(workspace, REPORT_DIRECTORY);
      const target = join(workspace, "target.json");
      await writeFile(target, "not evidence\n", { mode: 0o600 });
      await symlink(target, join(reportParent, "catalogue-reconciliation.json"));

      await expect(
        writeCatalogueReconciliationReport(REPORT_OUT, REPORT_DOCUMENT, workspace),
      ).rejects.toThrow("leaf must not be a symbolic link");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects an existing evidence parent with group or other access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "catalogue-report-wide-parent-"));
    try {
      const localData = join(workspace, ".local-data");
      await mkdir(localData, { mode: 0o700 });
      await chmod(localData, 0o755);

      await expect(
        writeCatalogueReconciliationReport(REPORT_OUT, REPORT_DOCUMENT, workspace),
      ).rejects.toThrow("current-user-owned with mode 0700");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

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

async function createPrivateDirectoryTree(
  workspace: string,
  relativeDirectory: string,
): Promise<string> {
  let current = workspace;
  for (const component of relativeDirectory.split("/")) {
    current = join(current, component);
    await mkdir(current, { mode: 0o700 });
  }
  return current;
}
