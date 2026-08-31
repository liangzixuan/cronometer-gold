import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createDatabase,
  getBatchCheckpoint,
  type JsonObject,
  runMigrations,
  sha256CanonicalJson,
  verifyCnfParserReport,
} from "@nutrition-tracker/db";
import {
  CNF_ARCHIVE_CSV_PATHS,
  type CnfArchiveCsvPath,
  type FoodSourceManifestV3,
} from "@nutrition-tracker/ingestion";
import { describe, expect, it, vi } from "vitest";

import { type CommandIo, runCommand } from "../src/run.js";

const adminDatabaseUrl = process.env.CNF_CLI_TEST_DATABASE_ADMIN_URL;
const describeDatabase = adminDatabaseUrl ? describe : describe.skip;
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const FOUNDATION_MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  "data/manifests/health-canada-cnf-2026.candidate.json",
);
const GUIDE_PATH = "guides/CNF User Guide EN.txt";
const RECORD_COUNT = 251;
const RELEASE_KEY = "cnf-cli-synthetic-251";
const PARSER_BUILD_SHA256 = "b".repeat(64);
const ACTOR_PRINCIPAL_ID = "service:cnf-cli-integration";
const ACTOR_RUN_REFERENCE = "urn:nutrition-tracker:test:cnf-cli-integration";

const CSV_FIXTURES: Readonly<Record<CnfArchiveCsvPath, string>> = Object.freeze({
  "Food_Name.csv": csv([
    "Food_Code,Food_Description_EN,Food_Description_FR,Food_Last_Updated_Date",
    ...Array.from({ length: RECORD_COUNT }, (_, index) => {
      const ordinal = index + 1;
      return `${foodCode(index)},Synthetic food ${ordinal},Aliment synthetique ${ordinal},2026-08-29`;
    }),
  ]),
  "Food_Source.csv": csv(["Food_Source_ID,Food_Source_Description_EN", "1,Analytical"]),
  "CNF_Food_Group.csv": csv(["Food_Group_ID,Food_Group_Name_EN", "1,Synthetic"]),
  "Nutrient_Amount.csv": csv([
    "Food_Code,Nutrient_Code,Nutrient_Amount,Nutrient_Source_ID,Observations",
    ...Array.from({ length: RECORD_COUNT }, (_, index) => `${foodCode(index)},208,1,1,1`),
  ]),
  "Nutrient_Name.csv": csv([
    "Nutrient_Code,Nutrient_Symbol,Nutrient_Unit,Nutrient_Name_EN,Tagname",
    "208,KCAL,kcal,Energy,ENERC_KCAL",
  ]),
  "Nutrient_Source.csv": csv(["Nutrient_Source_ID,Nutrient_Source_Description_EN", "1,Analytical"]),
  "Measure_Weight_Conversion.csv": csv([
    "Food_Code,Measure_Type_Code,Measure_Code,Measure_Weight_Conversion",
  ]),
  "Measure_Type.csv": csv(["Measure_Type_Code,Measure_Type_Description_EN"]),
  "Measure_Name.csv": csv(["Measure_Code,Measure_Description_and_Unit_EN"]),
});

describeDatabase("synthetic CNF CLI PostgreSQL integration", () => {
  it("derives, enforces, stages, freezes, and replays exact CNF evidence", async () => {
    if (!adminDatabaseUrl) {
      throw new Error("CNF_CLI_TEST_DATABASE_ADMIN_URL is required");
    }
    const checkedAdminUrl = localAdminDatabaseUrl(adminDatabaseUrl);
    const databaseName = `cnf_cli_${randomBytes(8).toString("hex")}`;
    const targetDatabaseUrl = databaseUrlForName(checkedAdminUrl, databaseName);
    const applicationName = `cnf-cli-${randomBytes(8).toString("hex")}`;
    const root = await mkdtemp(join(tmpdir(), "nutrition-stage-cnf-cli-"));
    const archivePath = join(root, "cnf-synthetic.zip");
    const cacheDirectory = join(root, "cache");
    let admin: ReturnType<typeof createDatabase> | undefined;
    let database: ReturnType<typeof createDatabase> | undefined;
    let databaseCreationAttempted = false;
    let operationError: unknown;
    let operationFailed = false;
    const cleanupErrors: unknown[] = [];

    try {
      await chmod(root, 0o700);
      admin = createDatabase({
        applicationName: "nutrition-tracker-cnf-cli-test-admin",
        connectionString: checkedAdminUrl,
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      const testAdmin = admin;
      const deniedFetch = vi.fn(() =>
        Promise.reject(new Error("Network access is forbidden in the synthetic CNF CLI test")),
      );
      vi.stubGlobal("fetch", deniedFetch);
      expect(root.startsWith("/tmp/")).toBe(true);
      await writePrivateFile(archivePath, makeStoredZip(cnfArchiveFiles()));
      const artifactBytes = await readFile(archivePath);
      const artifactSha256 = sha256Bytes(artifactBytes);
      const foundation = JSON.parse(
        await readFile(FOUNDATION_MANIFEST_PATH, "utf8"),
      ) as FoodSourceManifestV3;
      const expectedFiles = [...CNF_ARCHIVE_CSV_PATHS, GUIDE_PATH];
      const pinnedTemplate = pinnedTemplateManifest(
        foundation,
        expectedFiles,
        artifactBytes.byteLength,
        artifactSha256,
      );
      const templatePath = join(root, "cnf-pinned-template.json");
      await writePrivateJson(templatePath, pinnedTemplate);

      const inspect = commandIo({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
      expect(
        await runCommand(
          [
            "cnf",
            "inspect",
            templatePath,
            "--artifact",
            archivePath,
            "--cache-dir",
            cacheDirectory,
            "--extract-dir",
            join(root, "inspect-extract"),
          ],
          inspect.io,
        ),
      ).toBe(0);
      const inspection = singleOutput<{
        readonly archive: JsonObject;
        readonly baseline: Readonly<Record<string, boolean | number | string>>;
        readonly metrics: JsonObject & {
          readonly emittedNutrientCount: number;
          readonly emittedPortionCount: number;
          readonly emittedRecordCount: number;
        };
        readonly tables: readonly JsonObject[];
      }>(inspect);
      expect(inspection.metrics).toMatchObject({
        emittedNutrientCount: RECORD_COUNT,
        emittedPortionCount: 0,
        emittedRecordCount: RECORD_COUNT,
      });

      const importReady = importReadyManifest(
        pinnedTemplate,
        inspection.baseline,
        artifactBytes.byteLength,
        artifactSha256,
      );
      const manifestPath = join(root, "cnf-import-ready.json");
      const manifestSha256 = await writePrivateJson(manifestPath, importReady);
      const wrongBaselineManifest = {
        ...importReady,
        validation: {
          ...importReady.validation,
          releaseSpecificExpectations: {
            ...inspection.baseline,
            "cnfParser.emittedRecordCount": RECORD_COUNT - 1,
          },
        },
      } satisfies FoodSourceManifestV3;
      const wrongManifestPath = join(root, "cnf-wrong-baseline.json");
      const wrongManifestSha256 = await writePrivateJson(wrongManifestPath, wrongBaselineManifest);
      const runnerEnvironment = trustedRunnerEnvironment(targetDatabaseUrl, applicationName);

      expect(await databaseExists(testAdmin, databaseName)).toBe(false);
      const invalidManifestUri = commandIo(runnerEnvironment);
      expect(
        await runCommand(
          stageArguments(
            manifestPath,
            join(root, "artifact-must-not-be-read.zip"),
            cacheDirectory,
            join(root, "invalid-manifest-uri-extract"),
            "s3://synthetic-cnf-manifests/not-content-addressed/manifest.json",
          ),
          invalidManifestUri.io,
        ),
      ).toBe(1);
      expect(invalidManifestUri.output).toEqual([]);
      expect(invalidManifestUri.errors).toEqual([
        `--manifest-object-uri must be a content-addressed S3 URI containing /sha256/${manifestSha256}\n`,
      ]);
      expect(await databaseExists(testAdmin, databaseName)).toBe(false);

      const wrongStage = commandIo(runnerEnvironment);
      expect(
        await runCommand(
          stageArguments(
            wrongManifestPath,
            archivePath,
            cacheDirectory,
            join(root, "wrong-baseline-extract"),
            manifestObjectUri(wrongManifestSha256),
          ),
          wrongStage.io,
        ),
      ).toBe(1);
      expect(wrongStage.output).toEqual([]);
      expect(wrongStage.errors).toEqual([
        "CNF parser baseline mismatch for cnfParser.emittedRecordCount\n",
      ]);
      expect(await databaseExists(testAdmin, databaseName)).toBe(false);

      databaseCreationAttempted = true;
      await testAdmin.executeQuery(
        compiledQuery(
          `create database ${quotedDatabaseName(databaseName)} template template0 encoding 'UTF8'`,
        ),
      );
      expect(await databaseExists(testAdmin, databaseName)).toBe(true);
      database = createDatabase({
        applicationName: "nutrition-tracker-cnf-cli-test",
        connectionString: targetDatabaseUrl,
        maxConnections: 2,
        statementTimeoutMs: 30_000,
      });
      await runMigrations(database);
      expect(
        await database
          .selectFrom("food_source")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(
        await database
          .selectFrom("food_import_batch")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });

      const registerSource = commandIo(runnerEnvironment);
      expect(
        await runCommand(["catalogue", "register-source", manifestPath], registerSource.io),
      ).toBe(0);
      singleOutput(registerSource);

      const mappingPath = join(root, "cnf-mapping.json");
      await writePrivateJson(mappingPath, {
        mappings: [
          {
            canonicalNutrient: {
              code: "energy",
              dimension: "energy",
              name: "Energy",
              unit: "kcal",
            },
            sourceName: "Energy",
            sourceNutrientKey: "208",
            sourceUnit: "kcal",
          },
        ],
        reviewedAt: "2026-08-29T13:00:00Z",
        reviewedBy: ACTOR_PRINCIPAL_ID,
        sourceCode: "HEALTH_CANADA_CNF",
      });
      const registerMapping = commandIo(runnerEnvironment);
      expect(await runCommand(["catalogue", "mappings", mappingPath], registerMapping.io)).toBe(0);
      expect(
        singleOutput<{ readonly mappings: number; readonly sourceCode: string }>(registerMapping),
      ).toEqual({ mappings: 1, sourceCode: "HEALTH_CANADA_CNF" });

      const firstExtractDirectory = join(root, "stage-extract");
      const firstStage = commandIo(runnerEnvironment, async () => {
        expect(await applicationConnectionCount(testAdmin, databaseName, applicationName)).toBe(0);
      });
      expect(
        await runCommand(
          stageArguments(
            manifestPath,
            archivePath,
            cacheDirectory,
            firstExtractDirectory,
            manifestObjectUri(manifestSha256),
          ),
          firstStage.io,
        ),
      ).toBe(0);
      await Promise.all(firstStage.outputChecks);
      const first = singleOutput<StageOutput>(firstStage);
      expect(first).toMatchObject({
        inserted: RECORD_COUNT,
        promotionEligible: true,
        quarantined: 0,
        replayed: 0,
        staged: RECORD_COUNT,
        status: "ready",
        valid: RECORD_COUNT,
      });
      expect(first.status).not.toBe("staging");
      expect(first.parserReportSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.validationDigest).toMatch(/^[0-9a-f]{64}$/u);
      await expectPrivateCnfExtraction(firstExtractDirectory);

      const batch = await database
        .selectFrom("food_import_batch as batch")
        .innerJoin("food_source as source", "source.id", "batch.food_source_id")
        .select([
          "batch.id",
          "batch.status",
          "batch.staged_count",
          "batch.valid_count",
          "batch.quarantined_count",
          "batch.nutrient_input_count",
          "batch.nutrient_materializable_count",
          "batch.nutrient_excluded_count",
          "batch.validated_at",
        ])
        .where("source.code", "=", "HEALTH_CANADA_CNF")
        .where("batch.release_key", "=", RELEASE_KEY)
        .executeTakeFirstOrThrow();
      expect(batch).toMatchObject({
        id: first.batchId,
        nutrient_excluded_count: "0",
        nutrient_input_count: String(RECORD_COUNT),
        nutrient_materializable_count: String(RECORD_COUNT),
        quarantined_count: "0",
        staged_count: String(RECORD_COUNT),
        status: "ready",
        valid_count: String(RECORD_COUNT),
      });
      expect(batch.validated_at).not.toBeNull();
      expect(await getBatchCheckpoint(database, first.batchId, "stage")).toMatchObject({
        cursor: { nextOffset: RECORD_COUNT },
        lastSequenceNumber: String(RECORD_COUNT - 1),
        processedCount: String(RECORD_COUNT),
        stage: "stage",
      });
      const records = await database
        .selectFrom("food_import_record")
        .select(["sequence_number", "validated_at", "validation_status"])
        .where("batch_id", "=", first.batchId)
        .orderBy("sequence_number")
        .execute();
      expect(records).toHaveLength(RECORD_COUNT);
      expect(records[0]).toMatchObject({ sequence_number: "0", validation_status: "valid" });
      expect(records.at(-1)).toMatchObject({
        sequence_number: String(RECORD_COUNT - 1),
        validation_status: "valid",
      });
      expect(records.every((record) => record.validated_at !== null)).toBe(true);

      const report = await database
        .selectFrom("food_import_parser_report")
        .selectAll()
        .where("batch_id", "=", first.batchId)
        .executeTakeFirstOrThrow();
      expect(sha256CanonicalJson(report.report)).toBe(report.report_sha256);
      expect(report.report_sha256).toBe(first.parserReportSha256);
      const parserCounts = {
        emittedNutrientCount: Number(report.emitted_nutrient_count),
        emittedPortionCount: Number(report.emitted_portion_count),
        emittedRecordCount: Number(report.emitted_record_count),
        excludedNutrientCount: Number(report.excluded_nutrient_count),
        excludedPortionCount: Number(report.excluded_portion_count),
        excludedRecordCount: Number(report.excluded_record_count),
        sourceNutrientCount: Number(report.source_nutrient_count),
        sourcePortionCount: Number(report.source_portion_count),
        sourceRecordCount: Number(report.source_record_count),
      };
      expect(parserCounts).toEqual({
        emittedNutrientCount: RECORD_COUNT,
        emittedPortionCount: 0,
        emittedRecordCount: RECORD_COUNT,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        sourceNutrientCount: RECORD_COUNT,
        sourcePortionCount: 0,
        sourceRecordCount: RECORD_COUNT,
      });
      expect(() => verifyCnfParserReport(report.report, parserCounts)).not.toThrow();
      const persistedReport = report.report as JsonObject;
      expect(persistedReport.archive).toEqual(inspection.archive);
      expect(persistedReport.tables).toEqual(inspection.tables);
      expect(persistedReport.metrics).toEqual(inspection.metrics);
      expect(persistedReport).toMatchObject({
        actor: {
          authenticationMethod: "workload-identity",
          principalId: ACTOR_PRINCIPAL_ID,
          runReference: ACTOR_RUN_REFERENCE,
        },
        archive: { inventoryCount: CNF_ARCHIVE_CSV_PATHS.length + 1 },
        parserBuildSha256: PARSER_BUILD_SHA256,
        parserPackage: "@nutrition-tracker/ingestion",
        parserVersion: "0.1.0",
        reportKind: "health-canada-cnf-stage-v1",
        schemaVersion: 1,
        sourceCode: "HEALTH_CANADA_CNF",
      });
      expect((persistedReport.tables as readonly unknown[]).length).toBe(9);
      await expect(
        database
          .updateTable("food_import_parser_report")
          .set({ report_sha256: "0".repeat(64) })
          .where("batch_id", "=", first.batchId)
          .execute(),
      ).rejects.toThrow("immutable row");

      const replayExtractDirectory = join(root, "replay-extract");
      const replayStage = commandIo(runnerEnvironment);
      expect(
        await runCommand(
          stageArguments(
            manifestPath,
            archivePath,
            cacheDirectory,
            replayExtractDirectory,
            manifestObjectUri(manifestSha256),
          ),
          replayStage.io,
        ),
      ).toBe(0);
      const replay = singleOutput<StageOutput>(replayStage);
      expect(replay).toMatchObject({
        batchId: first.batchId,
        inserted: 0,
        replayed: 0,
        resumed: true,
        staged: RECORD_COUNT,
        status: "ready",
      });
      expect(replay.parserReportSha256).toBe(first.parserReportSha256);
      expect(replay.validationDigest).toBe(first.validationDigest);
      await expectPrivateCnfExtraction(replayExtractDirectory);
      expect(deniedFetch).not.toHaveBeenCalled();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    } finally {
      try {
        vi.unstubAllGlobals();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await database?.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (admin && databaseCreationAttempted) {
        try {
          await admin.executeQuery(
            compiledQuery(
              "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
              [databaseName],
            ),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await admin.executeQuery(
            compiledQuery(`drop database if exists ${quotedDatabaseName(databaseName)}`),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          if (await databaseExists(admin, databaseName)) {
            cleanupErrors.push(new Error("Synthetic CNF database still exists after cleanup"));
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await admin?.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rm(root, { force: true, recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (operationFailed) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "Synthetic CNF CLI operation and cleanup both failed",
        );
      }
      throw operationError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Synthetic CNF CLI cleanup failed");
    }
  }, 120_000);
});

interface StageOutput {
  readonly batchId: string;
  readonly inserted: number;
  readonly parserReportSha256: string;
  readonly promotionEligible: boolean;
  readonly quarantined: number;
  readonly replayed: number;
  readonly resumed?: boolean;
  readonly staged: number;
  readonly status: string;
  readonly valid: number;
  readonly validationDigest: string;
}

function csv(lines: readonly string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function foodCode(index: number): string {
  return String(100_000 + index);
}

function cnfArchiveFiles(): readonly { readonly data: Buffer; readonly name: string }[] {
  return [
    { data: Buffer.from("Synthetic non-data guide\n"), name: GUIDE_PATH },
    ...CNF_ARCHIVE_CSV_PATHS.map((name) => ({ data: Buffer.from(CSV_FIXTURES[name]), name })),
  ];
}

function pinnedTemplateManifest(
  foundation: FoodSourceManifestV3,
  expectedFiles: readonly string[],
  artifactByteSize: number,
  artifactSha256: string,
): FoodSourceManifestV3 {
  return {
    ...foundation,
    artifact: {
      ...foundation.artifact,
      acquisitionObservations: [],
      byteSize: artifactByteSize,
      objectUri: `s3://synthetic-cnf-artifacts/sha256/${artifactSha256}/cnf-synthetic.zip`,
      sha256: artifactSha256,
    },
    ingestion: {
      ...foundation.ingestion,
      parserBuildSha256: PARSER_BUILD_SHA256,
      parserPackage: "@nutrition-tracker/ingestion",
      parserVersion: "0.1.0",
    },
    release: {
      ...foundation.release,
      releaseKey: RELEASE_KEY,
    },
    templateOnly: true,
    validation: {
      ...foundation.validation,
      expectedFiles,
      releaseSpecificExpectations: { foundationTemplate: true },
    },
  };
}

function importReadyManifest(
  template: FoodSourceManifestV3,
  baseline: Readonly<Record<string, boolean | number | string>>,
  artifactByteSize: number,
  artifactSha256: string,
): FoodSourceManifestV3 {
  const downloadUrl = requiredString(template.artifact.downloadUrl, "template download URL");
  const permittedResolvedUrls = template.artifact.permittedResolvedUrls;
  const firstResolvedUrl = requiredString(permittedResolvedUrls[0], "first resolved URL");
  const secondResolvedUrl = requiredString(permittedResolvedUrls[1], "second resolved URL");
  return {
    ...template,
    artifact: {
      ...template.artifact,
      acquisitionObservations: [
        {
          acquisitionId: "11111111-1111-4111-8111-111111111111",
          byteSize: artifactByteSize,
          downloadUrl,
          etag: null,
          freshDownload: true,
          lastModified: null,
          observedAt: "2026-08-29T10:00:00Z",
          operatorPrincipalId: "principal:cnf-fixture-observer-a",
          resolvedUrl: firstResolvedUrl,
          sha256: artifactSha256,
          tool: "synthetic-cnf-cli-test/1",
          transport: "https",
        },
        {
          acquisitionId: "22222222-2222-4222-8222-222222222222",
          byteSize: artifactByteSize,
          downloadUrl,
          etag: null,
          freshDownload: true,
          lastModified: null,
          observedAt: "2026-08-29T11:00:00Z",
          operatorPrincipalId: "principal:cnf-fixture-observer-b",
          resolvedUrl: secondResolvedUrl,
          sha256: artifactSha256,
          tool: "synthetic-cnf-cli-test/1",
          transport: "https",
        },
      ],
      byteSize: artifactByteSize,
      objectUri: `s3://synthetic-cnf-artifacts/sha256/${artifactSha256}/cnf-synthetic.zip`,
      sha256: artifactSha256,
    },
    release: {
      ...template.release,
      acquiredAt: "2026-08-30T12:00:00Z",
      publishedOn: "2026-08-29",
      upstreamSchemaVersion: "cnf-cli-integration-v1",
    },
    rights: {
      ...template.rights,
      commercialUseAllowed: true,
      redistributionAllowed: true,
      review: {
        ...template.rights.review,
        notes: "Synthetic integration fixture approval; not release evidence.",
        reviewedAt: "2026-08-29T12:00:00Z",
        reviewedBy: ACTOR_PRINCIPAL_ID,
        status: "approved",
      },
    },
    templateOnly: false,
    validation: {
      ...template.validation,
      releaseSpecificExpectations: baseline,
    },
  };
}

function trustedRunnerEnvironment(databaseUrl: string, applicationName: string): NodeJS.ProcessEnv {
  return {
    DATABASE_APPLICATION_NAME: applicationName,
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_POOL_MAX: "2",
    DATABASE_SSL_MODE: "disable",
    DATABASE_STATEMENT_TIMEOUT_MS: "30000",
    DATABASE_URL: databaseUrl,
    INGEST_AUTHENTICATED_PRINCIPAL_ID: ACTOR_PRINCIPAL_ID,
    INGEST_AUTHENTICATION_METHOD: "workload-identity",
    INGEST_AUTHENTICATION_RUN_REFERENCE: ACTOR_RUN_REFERENCE,
    INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
    NODE_ENV: "test",
  };
}

function stageArguments(
  manifestPath: string,
  archivePath: string,
  cacheDirectory: string,
  extractDirectory: string,
  manifestUri: string,
): string[] {
  return [
    "catalogue",
    "stage-cnf",
    manifestPath,
    "--artifact",
    archivePath,
    "--cache-dir",
    cacheDirectory,
    "--extract-dir",
    extractDirectory,
    "--manifest-object-uri",
    manifestUri,
  ];
}

function manifestObjectUri(manifestSha256: string): string {
  return `s3://synthetic-cnf-manifests/sha256/${manifestSha256}/manifest.json`;
}

function commandIo(
  environment: NodeJS.ProcessEnv,
  onOutput?: () => Promise<void>,
): {
  readonly errors: string[];
  readonly io: CommandIo;
  readonly output: string[];
  readonly outputChecks: Promise<void>[];
} {
  const errors: string[] = [];
  const output: string[] = [];
  const outputChecks: Promise<void>[] = [];
  return {
    errors,
    io: {
      environment,
      writeError: (value) => errors.push(value),
      writeOutput: (value) => {
        if (onOutput) outputChecks.push(onOutput());
        output.push(value);
      },
    },
    output,
    outputChecks,
  };
}

function singleOutput<T = unknown>(result: {
  readonly errors: readonly string[];
  readonly output: readonly string[];
}): T {
  expect(result.errors).toEqual([]);
  expect(result.output).toHaveLength(1);
  return JSON.parse(requiredString(result.output[0], "command output")) as T;
}

async function expectPrivateCnfExtraction(directory: string): Promise<void> {
  expect(await readdir(directory)).toEqual([...CNF_ARCHIVE_CSV_PATHS].sort());
  for (const archivePath of CNF_ARCHIVE_CSV_PATHS) {
    const metadata = await lstat(join(directory, archivePath));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writePrivateFile(path, bytes);
  return sha256Bytes(bytes);
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function localAdminDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CNF_CLI_TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname) ||
    parsed.pathname.length <= 1 ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "CNF_CLI_TEST_DATABASE_ADMIN_URL must be a query-free loopback PostgreSQL database URL",
    );
  }
  return parsed.href;
}

function databaseUrlForName(adminUrl: string, databaseName: string): string {
  quotedDatabaseName(databaseName);
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.href;
}

function quotedDatabaseName(databaseName: string): string {
  if (!/^cnf_cli_[0-9a-f]{16}$/u.test(databaseName)) {
    throw new Error("Synthetic CNF database name is invalid");
  }
  return `"${databaseName}"`;
}

function compiledQuery(sql: string, parameters: readonly unknown[] = []) {
  return Object.freeze({
    parameters: Object.freeze([...parameters]),
    query: Object.freeze({
      kind: "RawNode" as const,
      parameters: Object.freeze([]),
      sqlFragments: Object.freeze([sql]),
    }),
    queryId: Object.freeze({ queryId: randomUUID() }),
    sql,
  });
}

async function databaseExists(
  admin: ReturnType<typeof createDatabase>,
  databaseName: string,
): Promise<boolean> {
  quotedDatabaseName(databaseName);
  const result = await admin.executeQuery<{ readonly exists: boolean }>(
    compiledQuery("select exists(select 1 from pg_database where datname = $1) as exists", [
      databaseName,
    ]),
  );
  return result.rows[0]?.exists === true;
}

async function applicationConnectionCount(
  admin: ReturnType<typeof createDatabase>,
  databaseName: string,
  applicationName: string,
): Promise<number> {
  quotedDatabaseName(databaseName);
  const result = await admin.executeQuery<{ readonly count: string }>(
    compiledQuery(
      "select count(*)::text as count from pg_stat_activity where datname = $1 and application_name = $2",
      [databaseName, applicationName],
    ),
  );
  return Number(result.rows[0]?.count ?? "0");
}

function requiredString(value: string | undefined | null, field: string): string {
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function makeStoredZip(files: readonly { readonly data: Buffer; readonly name: string }[]): Buffer {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localEntries.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralEntries.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
