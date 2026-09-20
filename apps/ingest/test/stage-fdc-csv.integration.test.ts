import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDatabase,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  runMigrations,
} from "@nutrition-tracker/db";
import type { FoodSourceManifestV4 } from "@nutrition-tracker/ingestion";
import { describe, expect, it, vi } from "vitest";

import { type CommandIo, runCommand } from "../src/run.js";
import {
  bindSyntheticReleaseEvidence,
  SYNTHETIC_EVIDENCE_EVALUATED_AT,
  type SyntheticEvidenceRunner,
  writeCanonicalReleaseEvidence,
} from "./synthetic-release-evidence.js";

const adminDatabaseUrl = process.env.FDC_CSV_CLI_TEST_DATABASE_ADMIN_URL;
const describeDatabase = adminDatabaseUrl ? describe : describe.skip;
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const RECORD_COUNT = 251;
const PARSER_BUILD_SHA256 = "b".repeat(64);
const RUNNER: SyntheticEvidenceRunner = Object.freeze({
  authenticationMethod: "workload-identity",
  principalId: "service:fdc-csv-cli-integration",
  runId: "fdc-csv-cli-integration",
  runReference: "urn:nutrition-tracker:test:fdc-csv-cli-integration",
});

type DatabaseClient = ReturnType<typeof createDatabase>;
interface StageOutput {
  readonly batchId: string;
  readonly parserReportSha256: string;
  readonly stagingSealSha256: string;
  readonly recordsExport: {
    readonly byteSize: number;
    readonly sha256: string;
    readonly recordCount: number;
    readonly recordsSha256: string;
  };
}
interface InspectionOutput {
  readonly baseline: Record<string, boolean | number | string>;
  readonly recordsExport?: {
    readonly byteSize: number;
    readonly sha256: string;
  };
}
interface Fixture {
  readonly manifest: FoodSourceManifestV4;
  readonly manifestRelative: string;
  readonly manifestSha256: string;
  readonly evidencePath: string;
  readonly recordsRelative: string;
  readonly recordsBytes: number;
  readonly recordsSha256: string;
  readonly root: string;
}

describe("synthetic full-FDC CSV integration fixture", () => {
  it("prepares the verified 251-record export without PostgreSQL or network access", async () => {
    const cleanupPaths: string[] = [];
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error("Synthetic fixture forbids network fetch")),
    );
    try {
      vi.stubGlobal("fetch", deniedFetch);
      const fixture = await createFixture(randomBytes(8).toString("hex"), cleanupPaths);
      const bytes = await readFile(join(WORKSPACE_ROOT, fixture.recordsRelative));
      expect(bytes.byteLength).toBe(fixture.recordsBytes);
      expect(hash(bytes)).toBe(fixture.recordsSha256);
      expect(bytes.toString("utf8").trimEnd().split("\n")).toHaveLength(RECORD_COUNT + 2);
      expect(deniedFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      for (const path of cleanupPaths.reverse()) {
        await rm(path, { force: true, recursive: true });
      }
    }
  });
});

describeDatabase("synthetic full-FDC CSV capability CLI PostgreSQL integration", () => {
  it("rejects invalid input and authority, resumes one committed page and seals without validation", async () => {
    if (!adminDatabaseUrl) throw new Error("FDC_CSV_CLI_TEST_DATABASE_ADMIN_URL is required");
    const adminUrl = localAdminUrl(adminDatabaseUrl);
    const suffix = randomBytes(8).toString("hex");
    const databaseName = `fdc_csv_cli_${suffix}`;
    const roles = [
      { name: `fdc_csv_stage_${suffix}`, capabilities: ["nutrition_catalogue_stage"] },
      { name: `fdc_csv_wrong_${suffix}`, capabilities: [] },
      {
        name: `fdc_csv_multi_${suffix}`,
        capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"],
      },
    ].map((role) => ({ ...role, password: randomBytes(24).toString("hex") }));
    const stageRole = roles[0];
    if (!stageRole) throw new Error("Synthetic stage role is missing");
    const cleanupPaths: string[] = [];
    const createdRoles: string[] = [];
    let databaseCreated = false;
    let admin: DatabaseClient | undefined;
    let owner: DatabaseClient | undefined;
    let restricted: DatabaseClient | undefined;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error("Synthetic test forbids network fetch")),
    );

    try {
      vi.stubGlobal("fetch", deniedFetch);
      const fixture = await createFixture(suffix, cleanupPaths);
      admin = createDatabase({
        applicationName: "nutrition-fdc-csv-cli-admin",
        connectionString: adminUrl,
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      const collision = await resourceExists(
        admin,
        databaseName,
        roles.map((role) => role.name),
      );
      expect(collision).toBe(false);
      await admin.executeQuery(
        query(`create database ${identifier(databaseName)} template template0 encoding 'UTF8'`),
      );
      databaseCreated = true;
      const ownerUrl = databaseUrl(adminUrl, databaseName);
      owner = createDatabase({
        applicationName: "nutrition-fdc-csv-cli-owner",
        connectionString: ownerUrl,
        maxConnections: 1,
        statementTimeoutMs: 30_000,
      });
      await runMigrations(owner);
      await admin.executeQuery(
        query(`revoke connect on database ${identifier(databaseName)} from public`),
      );
      const expires = new Date(Date.now() + 30 * 60_000).toISOString();
      for (const role of roles) {
        await admin.executeQuery(
          query(
            `create role ${identifier(role.name)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2 password '${role.password}' valid until '${expires}'`,
          ),
        );
        createdRoles.push(role.name);
        await admin.executeQuery(
          query(
            `grant connect on database ${identifier(databaseName)} to ${identifier(role.name)}`,
          ),
        );
        for (const capability of role.capabilities) {
          if (!/^nutrition_catalogue_(?:stage|validate)$/u.test(capability))
            throw new Error("Unexpected fixture capability");
          await admin.executeQuery(
            query(
              `grant "${capability}" to ${identifier(role.name)} with admin false, inherit true, set false`,
            ),
          );
        }
      }

      // Only the scratch owner prepares source/mapping fixtures; the command under
      // test receives a separate stage-only login and cannot perform this setup.
      const setupEnvironment = runnerEnvironment(ownerUrl);
      const register = capture(setupEnvironment);
      expect(
        await runCommand(
          [
            "catalogue",
            "register-source",
            fixture.manifestRelative,
            "--evidence-bundle",
            fixture.evidencePath,
          ],
          register.io,
        ),
      ).toBe(0);
      oneOutput(register);
      const mappingPath = join(fixture.root, "mapping.json");
      await privateJson(mappingPath, {
        mappings: [
          {
            canonicalNutrient: {
              code: "energy",
              dimension: "energy",
              name: "Energy",
              unit: "kcal",
            },
            sourceName: "Energy",
            sourceNutrientKey: "1008",
            sourceUnit: "kcal",
          },
        ],
        reviewedAt: SYNTHETIC_EVIDENCE_EVALUATED_AT,
        reviewedBy: RUNNER.principalId,
        sourceCode: "USDA_FDC",
      });
      const mapping = capture(setupEnvironment);
      expect(await runCommand(["catalogue", "mappings", mappingPath], mapping.io)).toBe(0);
      oneOutput(mapping);
      const mappingSha256 = await getSourceNutrientMappingDigest(owner, "USDA_FDC");
      const stageUrl = databaseUrl(adminUrl, databaseName, stageRole);
      const args = stageArguments(fixture, mappingSha256);
      const before = await catalogueSnapshot(owner);

      const badHash = capture(runnerEnvironment(stageUrl));
      expect(
        await runCommand(replaceOption(args, "--records-sha256", "0".repeat(64)), badHash.io),
      ).toBe(1);
      expect(badHash.output).toEqual([]);
      expect(await catalogueSnapshot(owner)).toEqual(before);
      const originalExport = await readFile(join(WORKSPACE_ROOT, fixture.recordsRelative));
      const truncated = originalExport.subarray(
        0,
        originalExport.lastIndexOf(10, originalExport.length - 2) + 1,
      );
      const badRelative = `.local-data/evidence/fdc-csv-records/adr0101-truncated-${suffix}.ndjson`;
      await privateFile(join(WORKSPACE_ROOT, badRelative), truncated);
      cleanupPaths.push(join(WORKSPACE_ROOT, badRelative));
      const badFooterArgs = replaceOption(
        replaceOption(
          replaceOption(args, "--records", badRelative),
          "--records-sha256",
          hash(truncated),
        ),
        "--records-bytes",
        String(truncated.length),
      );
      const badFooter = capture(runnerEnvironment(stageUrl));
      expect(await runCommand(badFooterArgs, badFooter.io)).toBe(1);
      expect(badFooter.output).toEqual([]);
      expect(await catalogueSnapshot(owner)).toEqual(before);
      for (const rejectedUrl of [
        ownerUrl,
        ...roles.slice(1).map((role) => databaseUrl(adminUrl, databaseName, role)),
      ]) {
        const rejected = capture(runnerEnvironment(rejectedUrl));
        expect(await runCommand(args, rejected.io)).toBe(1);
        expect(rejected.output).toEqual([]);
        expect(await catalogueSnapshot(owner)).toEqual(before);
      }
      restricted = createDatabase({
        applicationName: "nutrition-fdc-csv-cli-denial",
        connectionString: stageUrl,
        maxConnections: 1,
      });
      await expect(
        restricted.executeQuery(
          query("update public.food_import_batch set staged_count = staged_count where false"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        restricted.executeQuery(
          query(
            "insert into public.food_import_record(batch_id) values ('11111111-1111-4111-8111-111111111111')",
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await restricted.destroy();
      restricted = undefined;

      // A real PostgreSQL error on page two simulates interruption after page one
      // committed. The failure trigger exists only in this generated scratch DB.
      await owner.executeQuery(
        query(
          "create function public.adr0101_interrupt_second_page() returns trigger language plpgsql as $$ begin if new.sequence_number = 250 then raise exception 'synthetic interruption after first committed page'; end if; return new; end $$",
        ),
      );
      await owner.executeQuery(
        query(
          "create trigger adr0101_interrupt_second_page before insert on public.food_import_record for each row execute function public.adr0101_interrupt_second_page()",
        ),
      );
      const interrupted = capture(runnerEnvironment(stageUrl));
      expect(await runCommand(args, interrupted.io)).toBe(1);
      expect(interrupted.output).toEqual([]);
      expect(interrupted.errors.join("\n")).toContain(
        "synthetic interruption after first committed page",
      );
      const partial = await owner
        .selectFrom("food_import_batch")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(partial).toMatchObject({
        staged_count: "250",
        status: "staging",
        staging_seal_sha256: null,
        staged_database_principal: stageRole.name,
        staged_database_capability_role: "nutrition_catalogue_stage",
        validated_at: null,
        validation_digest: null,
      });
      expect(await getBatchCheckpoint(owner, partial.id, "stage")).toMatchObject({
        cursor: { nextOffset: 250 },
        processedCount: "250",
        lastSequenceNumber: "249",
      });
      expect(await count(owner, "food_import_record")).toBe("250");
      expect(await count(owner, "food_import_parser_report")).toBe("0");
      await owner.executeQuery(
        query("drop trigger adr0101_interrupt_second_page on public.food_import_record"),
      );
      await owner.executeQuery(query("drop function public.adr0101_interrupt_second_page()"));

      const resumed = capture(runnerEnvironment(stageUrl));
      expect(await runCommand(args, resumed.io)).toBe(0);
      const result = oneOutput<StageOutput>(resumed);
      expect(result).toMatchObject({
        batchId: partial.id,
        databasePrincipal: stageRole.name,
        capabilityRole: "nutrition_catalogue_stage",
        inserted: 1,
        replayed: 250,
        resumed: true,
        staged: RECORD_COUNT,
        status: "staging",
        validationPending: true,
        wasAlreadySealed: false,
      });
      expect(result.parserReportSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.stagingSealSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result).not.toHaveProperty("promotionEligible");
      expect(result).not.toHaveProperty("validationDigest");
      const sealed = await owner
        .selectFrom("food_import_batch")
        .selectAll()
        .where("id", "=", partial.id)
        .executeTakeFirstOrThrow();
      expect(sealed).toMatchObject({
        status: "staging",
        staged_count: String(RECORD_COUNT),
        release_class: "fixture-nonrelease",
        staging_seal_sha256: result.stagingSealSha256,
        validated_at: null,
        validation_digest: null,
      });
      expect(sealed.staging_sealed_at).not.toBeNull();
      expect(await getBatchCheckpoint(owner, partial.id, "stage")).toMatchObject({
        cursor: { nextOffset: RECORD_COUNT },
        processedCount: String(RECORD_COUNT),
        lastSequenceNumber: String(RECORD_COUNT - 1),
      });
      const records = await owner
        .selectFrom("food_import_record")
        .select(["sequence_number", "validation_status", "validated_at", "validated_food_document"])
        .where("batch_id", "=", partial.id)
        .orderBy("sequence_number")
        .execute();
      expect(records).toHaveLength(RECORD_COUNT);
      expect(records.map((record) => record.sequence_number)).toEqual(
        Array.from({ length: RECORD_COUNT }, (_, index) => String(index)),
      );
      expect(
        records.every(
          (record) =>
            record.validation_status === "pending" &&
            record.validated_at === null &&
            record.validated_food_document === null,
        ),
      ).toBe(true);
      const report = await owner
        .selectFrom("food_import_parser_report")
        .selectAll()
        .where("batch_id", "=", partial.id)
        .executeTakeFirstOrThrow();
      expect(report.report_sha256).toBe(result.parserReportSha256);
      expect(report.report).toMatchObject({
        reportKind: "usda-fdc-full-csv-capability-stage-v1",
        recordsExport: {
          sha256: fixture.recordsSha256,
          byteSize: fixture.recordsBytes,
          recordCount: RECORD_COUNT,
        },
      });
      const beforeReplay = await catalogueSnapshot(owner);
      const replay = capture(runnerEnvironment(stageUrl));
      expect(await runCommand(args, replay.io)).toBe(0);
      expect(oneOutput<StageOutput>(replay)).toMatchObject({
        batchId: partial.id,
        inserted: 0,
        replayed: 0,
        resumed: true,
        wasAlreadySealed: true,
        status: "staging",
        validationPending: true,
        parserReportSha256: result.parserReportSha256,
        stagingSealSha256: result.stagingSealSha256,
      });
      expect(await catalogueSnapshot(owner)).toEqual(beforeReplay);
      const after = await catalogueSnapshot(owner);
      expect(after.releaseState).toEqual(before.releaseState);
      expect(after.authorityState).toEqual(before.authorityState);
      expect(deniedFetch).not.toHaveBeenCalled();
    } catch (error) {
      primaryError = sanitizedError(error, [adminUrl, ...roles.map((role) => role.password)]);
    } finally {
      vi.unstubAllGlobals();
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(
            sanitizedError(error, [adminUrl, ...roles.map((role) => role.password)]),
          );
        }
      };
      const restrictedClient = restricted;
      const ownerClient = owner;
      if (restrictedClient) await attempt(() => restrictedClient.destroy());
      if (ownerClient) await attempt(() => ownerClient.destroy());
      if (admin) {
        const administrator = admin;
        if (databaseCreated) {
          await attempt(() =>
            administrator.executeQuery(
              query(
                "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
                [databaseName],
              ),
            ),
          );
          await attempt(() =>
            administrator.executeQuery(
              query(`drop database if exists ${identifier(databaseName)}`),
            ),
          );
        }
        for (const role of [...createdRoles].reverse()) {
          await attempt(() =>
            administrator.executeQuery(query(`drop role if exists ${identifier(role)}`)),
          );
        }
        await attempt(async () => {
          if (await resourceExists(administrator, databaseName, createdRoles))
            throw new Error("Synthetic full-CSV database or role residue remains");
        });
        await attempt(() => administrator.destroy());
      }
      for (const path of cleanupPaths.reverse()) {
        await attempt(() => rm(path, { force: true, recursive: true }));
      }
    }
    if (primaryError !== undefined || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
        "Synthetic full-CSV stage integration or owned-resource cleanup failed",
      );
    }
  }, 180_000);
});

async function createFixture(suffix: string, cleanup: string[]): Promise<Fixture> {
  const rootRelative = `.local-data/fdc-csv-stage-cli-${suffix}`;
  const root = join(WORKSPACE_ROOT, rootRelative);
  await mkdir(root, { mode: 0o700 });
  cleanup.push(root);
  const prefix = "synthetic-full-fdc";
  const files = {
    [`${prefix}/food.csv`]: `fdc_id,data_type,description,publication_date\n${Array.from({ length: RECORD_COUNT }, (_, index) => `${1000 + index},source_foundation,Synthetic food ${index},2026-04-30`).join("\n")}\n`,
    [`${prefix}/branded_food.csv`]:
      "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country\n",
    [`${prefix}/food_nutrient.csv`]: `id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq\n${Array.from({ length: RECORD_COUNT }, (_, index) => `${index + 1},${1000 + index},1008,${index % 7},3,49,`).join("\n")}\n`,
    [`${prefix}/nutrient.csv`]: "id,name,unit_name\n1008,Energy,KCAL\n",
    [`${prefix}/food_nutrient_derivation.csv`]:
      "id,code,description,source_id\n49,A,Analytical,1\n",
    [`${prefix}/food_portion.csv`]:
      "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight\n",
    [`${prefix}/measure_unit.csv`]: "id,name\n1,gram\n",
  };
  const zip = makeStoredZip(
    Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })),
  );
  const archiveRelative = `${rootRelative}/release.zip`;
  await privateFile(join(WORKSPACE_ROOT, archiveRelative), zip);
  const base = JSON.parse(
    await readFile(
      join(WORKSPACE_ROOT, "data/manifests/usda-fdc-full-csv-2026-04-30.candidate.json"),
      "utf8",
    ),
  ) as FoodSourceManifestV4;
  const dispositions = [
    ["food.csv", "food"],
    ["branded_food.csv", "branded-food"],
    ["food_nutrient.csv", "food-nutrient"],
    ["nutrient.csv", "nutrient"],
    ["food_nutrient_derivation.csv", "food-nutrient-derivation"],
    ["food_portion.csv", "food-portion"],
    ["measure_unit.csv", "measure-unit"],
  ] as const;
  let manifest: FoodSourceManifestV4 = {
    ...base,
    artifact: {
      ...base.artifact,
      byteSize: zip.length,
      sha256: hash(zip),
      objectUri: `s3://synthetic-fdc-csv-artifacts/sha256/${hash(zip)}/release.zip`,
    },
    ingestion: {
      ...base.ingestion,
      parserVersion: "0.1.0",
      parserBuildSha256: PARSER_BUILD_SHA256,
    },
    release: {
      ...base.release,
      releaseKey: `full-fdc-csv-cli-${suffix}`,
      upstreamSchemaVersion: "synthetic-fdc-csv-v1",
    },
    rights: {
      ...base.rights,
      commercialUseAllowed: true,
      redistributionAllowed: true,
      review: {
        ...base.rights.review,
        status: "approved",
        reviewedAt: SYNTHETIC_EVIDENCE_EVALUATED_AT,
        reviewedBy: RUNNER.principalId,
        notes: "Synthetic fixture rights only; not release acceptance.",
      },
    },
    validation: {
      ...base.validation,
      expectedFiles: Object.keys(files),
      releaseSpecificExpectations: {
        fdcCsvDefaultMarketCode: "US",
        "fdcCsvDataTypeMapping:source_branded": "Branded",
        "fdcCsvDataTypeMapping:source_experimental": "Experimental",
        "fdcCsvDataTypeMapping:source_fndds": "FNDDS",
        "fdcCsvDataTypeMapping:source_foundation": "Foundation",
        "fdcCsvDataTypeMapping:source_sr_legacy": "SR Legacy",
        "fdcCsvMarketMapping:New Zealand": "NZ",
        "fdcCsvMarketMapping:United States": "US",
        ...Object.fromEntries(
          dispositions.map(([file, type]) => [
            `fdcCsvDisposition:${prefix}/${file}`,
            `adapter-input:${type}-v1`,
          ]),
        ),
      },
    },
  };
  const manifestRelative = `data/manifests/.fdc-csv-stage-cli-${suffix}.json`;
  const manifestPath = join(WORKSPACE_ROOT, manifestRelative);
  await privateJson(manifestPath, manifest);
  cleanup.push(manifestPath);
  const inspectArgs = (label: string) => [
    "fdc",
    "inspect-csv",
    manifestRelative,
    "--artifact",
    archiveRelative,
    "--cache-dir",
    `${rootRelative}/cache-${label}`,
    "--extract-dir",
    `${rootRelative}/extract-${label}`,
  ];
  const proposal = capture({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
  expect(await runCommand(inspectArgs("proposal"), proposal.io)).toBe(1);
  expect(proposal.errors).toHaveLength(1);
  expect(proposal.errors[0]).toContain(
    "FDC CSV inspection produced a non-qualifying baseline proposal for:",
  );
  expect(proposal.output).toHaveLength(1);
  const baseline = (JSON.parse(proposal.output[0] ?? "") as InspectionOutput).baseline;
  expect(baseline).toBeDefined();
  manifest = {
    ...manifest,
    validation: {
      ...manifest.validation,
      releaseSpecificExpectations: {
        ...manifest.validation.releaseSpecificExpectations,
        ...baseline,
      },
    },
  };
  const bound = bindSyntheticReleaseEvidence(manifest, RUNNER);
  manifest = bound.manifest;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const manifestSha256 = hash(await readFile(manifestPath));
  const evidencePath = join(root, "release-evidence.json");
  await writeCanonicalReleaseEvidence(evidencePath, bound.bundle);
  const recordsRelative = `.local-data/evidence/fdc-csv-records/adr0101-${suffix}.ndjson`;
  const exported = capture({ INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256 });
  expect(
    await runCommand([...inspectArgs("export"), "--records-out", recordsRelative], exported.io),
  ).toBe(0);
  cleanup.push(join(WORKSPACE_ROOT, recordsRelative));
  const output = oneOutput<InspectionOutput>(exported);
  if (!output.recordsExport)
    throw new Error("Synthetic fixture did not produce a normalized export");
  return {
    manifest,
    manifestRelative,
    manifestSha256,
    evidencePath,
    recordsRelative,
    root,
    recordsBytes: output.recordsExport.byteSize,
    recordsSha256: output.recordsExport.sha256,
  };
}

function stageArguments(fixture: Fixture, mappingSha256: string): string[] {
  return [
    "catalogue",
    "stage-fdc-csv",
    fixture.manifestRelative,
    "--records",
    fixture.recordsRelative,
    "--records-sha256",
    fixture.recordsSha256,
    "--records-bytes",
    String(fixture.recordsBytes),
    "--nutrient-mapping-sha256",
    mappingSha256,
    "--evidence-bundle",
    fixture.evidencePath,
    "--manifest-object-uri",
    `s3://synthetic-fdc-csv-manifests/sha256/${fixture.manifestSha256}/manifest.json`,
  ];
}
function replaceOption(args: readonly string[], name: string, value: string): string[] {
  const copy = [...args];
  const index = copy.indexOf(name);
  if (index < 0 || index === copy.length - 1) throw new Error("Missing fixture option");
  copy[index + 1] = value;
  return copy;
}
function runnerEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: url,
    DATABASE_APPLICATION_NAME: "nutrition-fdc-csv-cli-under-test",
    DATABASE_POOL_MAX: "1",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_STATEMENT_TIMEOUT_MS: "30000",
    DATABASE_SSL_MODE: "disable",
    NODE_ENV: "test",
    INGEST_AUTHENTICATED_PRINCIPAL_ID: RUNNER.principalId,
    INGEST_AUTHENTICATION_METHOD: RUNNER.authenticationMethod,
    INGEST_AUTHENTICATION_RUN_REFERENCE: RUNNER.runReference,
    INGEST_PARSER_BUILD_SHA256: PARSER_BUILD_SHA256,
  };
}
function capture(environment: NodeJS.ProcessEnv) {
  const output: string[] = [];
  const errors: string[] = [];
  const io: CommandIo = {
    environment,
    now: () => new Date(SYNTHETIC_EVIDENCE_EVALUATED_AT),
    writeError: (value) => errors.push(value),
    writeOutput: (value) => output.push(value),
  };
  return { output, errors, io };
}
function oneOutput<T = unknown>(result: ReturnType<typeof capture>): T {
  expect(result.errors).toEqual([]);
  expect(result.output).toHaveLength(1);
  return JSON.parse(result.output[0] ?? "") as T;
}
async function catalogueSnapshot(database: DatabaseClient) {
  const result = await database.executeQuery<{
    readonly releaseState: unknown;
    readonly authorityState: unknown;
    readonly stagingState: unknown;
  }>(
    query(`select
    jsonb_build_object(
      'sources', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]') from food_source s),
      'releases', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]') from food_source_release r),
      'activations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]') from food_source_release_activation a)
    ) as "releaseState",
    jsonb_build_object(
      'approvals', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]') from food_import_approval a),
      'outbox', (select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]') from outbox_event o)
    ) as "authorityState",
    jsonb_build_object(
      'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]') from food_import_batch b),
      'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]') from food_import_record r),
      'reports', (select coalesce(jsonb_agg(to_jsonb(r) order by r.batch_id), '[]') from food_import_parser_report r),
      'checkpoints', (select coalesce(jsonb_agg(to_jsonb(c) order by c.batch_id, c.stage), '[]') from food_import_checkpoint c)
    ) as "stagingState"`),
  );
  const row = result.rows[0];
  if (!row) throw new Error("Synthetic catalogue snapshot is missing");
  return row;
}
async function count(
  database: DatabaseClient,
  table: "food_import_record" | "food_import_parser_report",
): Promise<string> {
  const result = await database.executeQuery<{ readonly count: string }>(
    query(`select count(*)::text as count from ${table}`),
  );
  return result.rows[0]?.count ?? "missing";
}
function sanitizedError(error: unknown, secrets: readonly string[]): Error {
  let message = error instanceof Error ? error.message : "Unknown integration failure";
  message = message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[redacted-database-url]");
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted-secret]");
  }
  // Never pass PostgreSQL error objects, query properties or URL inputs through
  // Vitest's recursive diagnostic serializer.
  return new Error(message.slice(0, 16_384));
}
function localAdminUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FDC_CSV_CLI_TEST_DATABASE_ADMIN_URL is not a valid URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname.length <= 1 ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "FDC_CSV_CLI_TEST_DATABASE_ADMIN_URL must be a query-free loopback PostgreSQL URL",
    );
  }
  return url.href;
}
function databaseUrl(
  value: string,
  databaseName: string,
  role?: { readonly name: string; readonly password: string },
): string {
  identifier(databaseName);
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.href;
}
function identifier(value: string): string {
  if (!/^fdc_csv_(?:cli|stage|wrong|multi)_[0-9a-f]{16}$/u.test(value))
    throw new Error("Invalid generated full-CSV resource identifier");
  return `"${value}"`;
}
function query(sql: string, parameters: readonly unknown[] = []) {
  return {
    sql,
    parameters,
    query: { kind: "RawNode" as const, parameters: [], sqlFragments: [sql] },
    queryId: { queryId: randomUUID() },
  };
}
async function resourceExists(
  admin: DatabaseClient,
  databaseName: string,
  roles: readonly string[],
): Promise<boolean> {
  const result = await admin.executeQuery<{ readonly exists: boolean }>(
    query(
      "select exists(select 1 from pg_database where datname = $1) or exists(select 1 from pg_roles where rolname = any($2::text[])) as exists",
      [databaseName, roles],
    ),
  );
  return result.rows[0]?.exists !== false;
}
async function privateJson(path: string, value: unknown): Promise<void> {
  await privateFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}
async function privateFile(path: string, value: Uint8Array): Promise<void> {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
}
function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
