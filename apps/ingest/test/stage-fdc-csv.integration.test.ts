import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type CatalogueReconciliationDocument,
  type CatalogueValidationReceipt,
  canonicalJson,
  createDatabase,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  type JsonObject,
  type PreparedCatalogueValidationRequest,
  parsePreparedCatalogueValidationRequest,
  runMigrations,
  verifyCatalogueReconciliationDocument,
} from "@nutrition-tracker/db";
import {
  assertAuthenticatedReleaseEvidenceBundle,
  type FoodSourceManifestV4,
  parseAuthenticatedReleaseEvidenceBundle,
  type StagedFoodRecord,
} from "@nutrition-tracker/ingestion";
import { describe, expect, it, vi } from "vitest";

import { type CommandIo, runCommand } from "../src/run.js";
import { bindSyntheticLiveReview } from "./synthetic-live-release-evidence.js";
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
interface PrepareValidationOutput {
  readonly batchId: string;
  readonly request: { readonly path: string; readonly sha256: string; readonly byteSize: number };
  readonly validationDigest: string;
  readonly validatorDatabasePrincipal: string;
}
interface SubmitValidationOutput {
  readonly batchId: string;
  readonly requestSha256: string;
  readonly validation: CatalogueValidationReceipt;
}
type MutableJsonObject = { -readonly [Key in keyof JsonObject]: JsonObject[Key] };
interface ValidationDocument extends MutableJsonObject {
  digestDocument: string;
  records: MutableJsonObject[];
}
interface ValidationDigestDocument extends MutableJsonObject {
  records: MutableJsonObject[];
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
  it("initializes an absent fixture parent and preserves shared files on reuse and cleanup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fdc-fixture-parent-"));
    const parent = join(workspace, ".local-data");
    const root = join(parent, "owned-fixture");
    const secondRoot = join(parent, "second-fixture");
    const sentinel = join(parent, "unrelated.txt");
    const cleanup: string[] = [];
    try {
      await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
      await createFixtureRoot(root, cleanup);
      expect((await lstat(parent)).mode & 0o777).toBe(0o700);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      await writeFile(sentinel, "preserved", { flag: "wx", mode: 0o600 });
      await createFixtureRoot(secondRoot, cleanup);
      await expect(createFixtureRoot(root, cleanup)).rejects.toMatchObject({ code: "EEXIST" });
      expect(cleanup).toEqual([root, secondRoot]);
      for (const path of cleanup.reverse()) await rm(path, { recursive: true });
      expect((await lstat(parent)).isDirectory()).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("preserved");
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(secondRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("prepares the verified 251-record export without PostgreSQL or network access", async () => {
    const cleanupPaths: string[] = [];
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error("Synthetic fixture forbids network fetch")),
    );
    try {
      vi.stubGlobal("fetch", deniedFetch);
      const fixture = await createFixture(randomBytes(8).toString("hex"), cleanupPaths);
      expect(fixture.manifest.releaseClass).toBe("fixture-nonrelease");
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

describe("synthetic validation policy fixture", () => {
  it("exports one valid food with an unmapped nutrient without PostgreSQL", async () => {
    const cleanupPaths: string[] = [];
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error("Synthetic fixture forbids network fetch")),
    );
    try {
      vi.stubGlobal("fetch", deniedFetch);
      const fixture = await createFixture(randomBytes(8).toString("hex"), cleanupPaths, {
        recordCount: 1,
        unmappedNutrient: true,
      });
      const bytes = await readFile(join(WORKSPACE_ROOT, fixture.recordsRelative));
      expect(bytes.byteLength).toBe(fixture.recordsBytes);
      expect(hash(bytes)).toBe(fixture.recordsSha256);
      const lines = bytes.toString("utf8").trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      const record = JSON.parse(lines[1] ?? "null") as StagedFoodRecord;
      expect(record.source.sourceRecordId).toBe("1000");
      expect(record.nutrients).toHaveLength(2);
      expect(record.nutrients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceNutrientId: "1008", originalUnit: "KCAL" }),
          expect.objectContaining({
            sourceNutrientId: "9999",
            originalUnit: "MG",
            value: expect.objectContaining({ state: "known", amount: "1" }),
          }),
        ]),
      );
      expect(deniedFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      for (const path of cleanupPaths.reverse()) await rm(path, { force: true, recursive: true });
    }
  });
});

describe("synthetic reviewed release fixture", () => {
  it("binds a separate synthetic authority decision through normal evidence acceptance", async () => {
    const cleanupPaths: string[] = [];
    const deniedFetch = vi.fn(() =>
      Promise.reject(new Error("Synthetic fixture forbids network fetch")),
    );
    try {
      vi.stubGlobal("fetch", deniedFetch);
      const fixture = await createFixture(randomBytes(8).toString("hex"), cleanupPaths, {
        recordCount: 1,
        syntheticLiveReview: true,
      });
      const bundle = parseAuthenticatedReleaseEvidenceBundle(
        JSON.parse(await readFile(fixture.evidencePath, "utf8")),
      );
      expect(fixture.manifest.releaseClass).toBe("live-reviewed");
      expect(bundle.authorityDecision).toMatchObject({
        releaseClass: "live-reviewed",
        decision: "approved-for-live-staging",
      });
      expect(() =>
        assertAuthenticatedReleaseEvidenceBundle(
          fixture.manifest,
          bundle,
          SYNTHETIC_EVIDENCE_EVALUATED_AT,
        ),
      ).not.toThrow();
      expect(() =>
        assertAuthenticatedReleaseEvidenceBundle(fixture.manifest, bundle),
      ).not.toThrow();
      expect(deniedFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      for (const path of cleanupPaths.reverse()) await rm(path, { force: true, recursive: true });
    }
  });
});

describeDatabase("synthetic full-FDC CSV capability CLI PostgreSQL integration", () => {
  it("stages, validates, reconciles and reviews with exact retained retries", async () => {
    if (!adminDatabaseUrl) throw new Error("FDC_CSV_CLI_TEST_DATABASE_ADMIN_URL is required");
    const adminUrl = localAdminUrl(adminDatabaseUrl);
    const suffix = randomBytes(8).toString("hex");
    const databaseName = `fdc_csv_cli_${suffix}`;
    const roles = [
      { name: `fdc_csv_stage_${suffix}`, capabilities: ["nutrition_catalogue_stage"] },
      { name: `fdc_csv_wrong_${suffix}`, capabilities: [] },
      {
        name: `fdc_csv_multi_${suffix}`,
        capabilities: [
          "nutrition_catalogue_stage",
          "nutrition_catalogue_validate",
          "nutrition_catalogue_approve_data",
        ],
      },
      { name: `fdc_csv_validate_${suffix}`, capabilities: ["nutrition_catalogue_validate"] },
      { name: `fdc_csv_data_${suffix}`, capabilities: ["nutrition_catalogue_approve_data"] },
      { name: `fdc_csv_quality_${suffix}`, capabilities: ["nutrition_catalogue_approve_quality"] },
      { name: `fdc_csv_rights_${suffix}`, capabilities: ["nutrition_catalogue_approve_rights"] },
      { name: `fdc_csv_promote_${suffix}`, capabilities: ["nutrition_catalogue_promote_activate"] },
    ].map((role) => ({ ...role, password: randomBytes(24).toString("hex") }));
    const stageRole = roles[0];
    const validateRole = roles[3];
    const promoteRole = roles[7];
    if (!stageRole || !validateRole || !promoteRole)
      throw new Error("Synthetic stage or validate role is missing");
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
          if (
            !/^nutrition_catalogue_(?:stage|validate|approve_data|approve_quality|approve_rights|promote_activate)$/u.test(
              capability,
            )
          )
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
            sourceUnit: "KCAL",
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
      const preparation = await exerciseIndependentValidation({
        owner,
        ownerUrl,
        stageUrl,
        stagePrincipal: stageRole.name,
        validateUrl: databaseUrl(adminUrl, databaseName, validateRole),
        validatePrincipal: validateRole.name,
        rejectedUrls: [
          ownerUrl,
          stageUrl,
          ...roles.slice(1, 3).map((role) => databaseUrl(adminUrl, databaseName, role)),
        ],
        staged: result,
        mappingSha256,
        suffix,
        cleanupPaths,
      });
      const reviewers: ReviewLogin[] = (["data", "quality", "rights"] as const).map(
        (role, index) => {
          const login = roles[index + 4];
          if (!login) throw new Error("Synthetic reviewer login is missing");
          return { role, principal: login.name, url: databaseUrl(adminUrl, databaseName, login) };
        },
      );
      await exerciseCatalogueReviewHandoff({
        owner,
        ownerUrl,
        stageUrl,
        validateUrl: databaseUrl(adminUrl, databaseName, validateRole),
        promoteUrl: databaseUrl(adminUrl, databaseName, promoteRole),
        promotePrincipal: promoteRole.name,
        reviewers,
        rejectedUrls: [
          ownerUrl,
          stageUrl,
          ...roles.slice(1, 4).map((role) => databaseUrl(adminUrl, databaseName, role)),
        ],
        fixture,
        preparation,
        mappingSha256,
        suffix,
        cleanupPaths,
      });
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

async function exerciseIndependentValidation(input: {
  readonly owner: DatabaseClient;
  readonly ownerUrl: string;
  readonly stageUrl: string;
  readonly stagePrincipal: string;
  readonly validateUrl: string;
  readonly validatePrincipal: string;
  readonly rejectedUrls: readonly string[];
  readonly staged: StageOutput;
  readonly mappingSha256: string;
  readonly suffix: string;
  readonly cleanupPaths: string[];
}): Promise<PrepareValidationOutput> {
  const { owner, staged, cleanupPaths, mappingSha256 } = input;
  const environment = validationEnvironment(input.validateUrl);
  const before = await catalogueSnapshot(owner);
  const requestPath = validationRequestPath(input.suffix, "retained");
  await expect(lstat(join(WORKSPACE_ROOT, requestPath))).rejects.toMatchObject({ code: "ENOENT" });
  cleanupPaths.push(join(WORKSPACE_ROOT, requestPath));
  const prepareArgs = prepareValidationArguments(staged, mappingSha256, requestPath);
  for (const url of input.rejectedUrls) {
    const denied = capture(validationEnvironment(url));
    expect(await runCommand(prepareArgs, denied.io)).toBe(1);
    expect(denied.output).toEqual([]);
    await expect(lstat(join(WORKSPACE_ROOT, requestPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await catalogueSnapshot(owner)).toEqual(before);
  }
  for (const option of ["--staging-seal-sha256", "--nutrient-mapping-sha256"]) {
    const stale = capture(environment);
    expect(await runCommand(replaceOption(prepareArgs, option, "0".repeat(64)), stale.io)).toBe(1);
    expect(stale.output).toEqual([]);
    expect(await catalogueSnapshot(owner)).toEqual(before);
  }
  const prepared = capture(environment);
  expect(await runCommand(prepareArgs, prepared.io)).toBe(0);
  const preparation = oneOutput<PrepareValidationOutput>(prepared);
  expect(preparation).toMatchObject({
    batchId: staged.batchId,
    validatorDatabasePrincipal: input.validatePrincipal,
    request: { path: requestPath },
  });
  const requestBytes = await readFile(join(WORKSPACE_ROOT, requestPath));
  expect(preparation.request).toMatchObject({
    sha256: hash(requestBytes),
    byteSize: requestBytes.length,
  });
  expect((await lstat(join(WORKSPACE_ROOT, requestPath))).mode & 0o777).toBe(0o600);
  const retained = parsePreparedCatalogueValidationRequest(
    JSON.parse(requestBytes.toString("utf8")),
  );
  expect(requestBytes.toString("utf8")).toBe(
    `${canonicalJson(retained as unknown as JsonObject)}\n`,
  );
  expect(retained).toMatchObject({
    batchId: staged.batchId,
    validatorDatabasePrincipal: input.validatePrincipal,
    expectedStagingSealSha256: staged.stagingSealSha256,
    nutrientMappingDigest: mappingSha256,
    parserReportSha256: staged.parserReportSha256,
    validationDigest: preparation.validationDigest,
  });
  expect(retained.policy).toEqual({
    maximumExcludedNutrientFraction: 0,
    maximumQuarantineFraction: 0,
    maximumQuarantinedRecords: 0,
    requireDistinctApprovalPrincipals: true,
    requireAtLeastOneValidRecord: true,
    requireMaterializedNutrientPerValidRecord: true,
  });
  expect(retained.observationSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(await catalogueSnapshot(owner)).toEqual(before);
  const noOverwrite = capture(environment);
  expect(await runCommand(prepareArgs, noOverwrite.io)).toBe(1);
  expect(await readFile(join(WORKSPACE_ROOT, requestPath))).toEqual(requestBytes);
  expect(await catalogueSnapshot(owner)).toEqual(before);

  const validator = createDatabase({ connectionString: input.validateUrl, maxConnections: 1 });
  try {
    const identity = await validator.executeQuery<{ readonly principal: string }>(
      query("select session_user::text as principal"),
    );
    expect(identity.rows[0]?.principal).toBe(input.validatePrincipal);
    for (const statement of [
      "update public.food_import_batch set validation_digest = validation_digest where false",
      "update public.food_import_record set validation_status = validation_status where false",
    ])
      await expect(validator.executeQuery(query(statement))).rejects.toMatchObject({
        code: "42501",
      });
  } finally {
    await validator.destroy();
  }

  const submitArgs = submitValidationArguments(preparation);
  const rejectSubmission = async (args: readonly string[], url = input.validateUrl) => {
    const rejected = capture(validationEnvironment(url));
    expect(await runCommand(args, rejected.io)).toBe(1);
    expect(rejected.output).toEqual([]);
    expect(rejected.errors.length).toBeGreaterThan(0);
    expect(await catalogueSnapshot(owner)).toEqual(before);
    return rejected;
  };
  for (const url of input.rejectedUrls) await rejectSubmission(submitArgs, url);
  await rejectSubmission(replaceOption(submitArgs, "--request-sha256", "0".repeat(64)));
  await rejectSubmission(
    replaceOption(submitArgs, "--request-bytes", String(requestBytes.length + 1)),
  );
  const tamperedPath = validationRequestPath(input.suffix, "tampered-file");
  await privateFile(
    join(WORKSPACE_ROOT, tamperedPath),
    Buffer.concat([requestBytes, Buffer.from("\n")]),
  );
  cleanupPaths.push(join(WORKSPACE_ROOT, tamperedPath));
  await rejectSubmission(replaceOption(submitArgs, "--request", tamperedPath));

  const rewrittenRequest = (
    mutate: (document: ValidationDocument, digest: ValidationDigestDocument) => void,
    overrides: Partial<PreparedCatalogueValidationRequest> = {},
  ): PreparedCatalogueValidationRequest => {
    const document = JSON.parse(retained.validationDocument) as ValidationDocument;
    const digest = JSON.parse(document.digestDocument) as ValidationDigestDocument;
    mutate(document, digest);
    document.digestDocument = canonicalJson(digest);
    const validationDocument = canonicalJson(document);
    return parsePreparedCatalogueValidationRequest({
      ...retained,
      ...overrides,
      validationDocument,
      validationDocumentByteSize: Buffer.byteLength(validationDocument),
      validationDocumentSha256: hash(Buffer.from(validationDocument)),
      validationDigest: hash(Buffer.from(document.digestDocument)),
    });
  };
  const saveRewritten = async (label: string, request: PreparedCatalogueValidationRequest) => {
    const path = validationRequestPath(input.suffix, label);
    const bytes = Buffer.from(`${canonicalJson(request as unknown as JsonObject)}\n`);
    await privateFile(join(WORKSPACE_ROOT, path), bytes);
    cleanupPaths.push(join(WORKSPACE_ROOT, path));
    return submitValidationArguments({
      batchId: staged.batchId,
      request: { path, sha256: hash(bytes), byteSize: bytes.length },
      validationDigest: request.validationDigest,
      validatorDatabasePrincipal: input.validatePrincipal,
    });
  };
  const wrongSeal = rewrittenRequest(() => {}, { expectedStagingSealSha256: "0".repeat(64) });
  await rejectSubmission(await saveRewritten("stale-seal", wrongSeal));
  const wrongMapping = rewrittenRequest(
    (_document, digest) => {
      digest.nutrientMappingDigest = "0".repeat(64);
    },
    { nutrientMappingDigest: "0".repeat(64) },
  );
  await rejectSubmission(await saveRewritten("stale-mapping", wrongMapping));
  const staleObservation = rewrittenRequest(
    (_document, digest) => {
      digest.observationSha256 = "0".repeat(64);
    },
    { observationSha256: "0".repeat(64) },
  );
  const stale = await rejectSubmission(await saveRewritten("stale-observation", staleObservation));
  expect(stale.errors.join("\n")).toContain("observation");

  // Rehash every envelope so the public SQL semantic recheck, rather than a
  // mismatched file/document digest, must reject the fabricated nutrient value.
  const wrongNutrition = rewrittenRequest((document, digest) => {
    const record = document.records[0];
    const digestRecord = digest.records[0];
    if (!record || !digestRecord || typeof record.validatedFoodDocument !== "string")
      throw new Error("Synthetic validated food is missing");
    const food = JSON.parse(record.validatedFoodDocument) as MutableJsonObject;
    const nutrients = food.nutrients as MutableJsonObject[];
    const nutrient = nutrients[0];
    if (!nutrient) throw new Error("Synthetic validated nutrient is missing");
    nutrient.amount = nutrient.amount === "0" ? "1" : "0";
    record.validatedFoodDocument = canonicalJson(food);
    digestRecord.validatedFoodSha256 = hash(Buffer.from(record.validatedFoodDocument));
  });
  const semantic = await rejectSubmission(await saveRewritten("wrong-nutrition", wrongNutrition));
  expect(semantic.errors.join("\n")).toMatch(/semantic|nutrient|nutrition/iu);

  // The database commits before the CLI output transport fails. The operator
  // retries the identical private file; no fresh observation/document replaces it.
  const lost = capture(environment);
  let discardedAcknowledgement: SubmitValidationOutput | undefined;
  expect(
    await runCommand(submitArgs, {
      ...lost.io,
      writeOutput: (value) => {
        discardedAcknowledgement = JSON.parse(value) as SubmitValidationOutput;
        throw new Error("synthetic validation acknowledgement lost after commit");
      },
    }),
  ).toBe(1);
  expect(lost.errors.join("\n")).toContain(
    "synthetic validation acknowledgement lost after commit",
  );
  expect(discardedAcknowledgement).toMatchObject({
    batchId: staged.batchId,
    requestSha256: preparation.request.sha256,
    validation: {
      wasAlreadyValidated: false,
      stagedCount: RECORD_COUNT,
      validCount: RECORD_COUNT,
      quarantinedCount: 0,
      promotionEligible: true,
      validationDigest: preparation.validationDigest,
      nutritionSemanticContractVersion: 1,
    },
  });
  const validated = await owner
    .selectFrom("food_import_batch")
    .selectAll()
    .where("id", "=", staged.batchId)
    .executeTakeFirstOrThrow();
  expect(validated).toMatchObject({
    status: "ready",
    staged_database_principal: input.stagePrincipal,
    validated_database_principal: input.validatePrincipal,
    validated_database_capability_role: "nutrition_catalogue_validate",
    validation_digest: preparation.validationDigest,
  });
  expect(input.validatePrincipal).not.toBe(input.stagePrincipal);
  expect(validated.validated_at).not.toBeNull();
  const afterCommit = await catalogueSnapshot(owner);
  expect(afterCommit.releaseState).toEqual(before.releaseState);
  expect(afterCommit.authorityState).toEqual(before.authorityState);
  expect(discardedAcknowledgement?.validation.nutritionSemanticSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(discardedAcknowledgement?.validation.nutritionSemanticSha256).toBe(
    validated.nutrition_semantic_sha256,
  );
  const changedPolicy = { ...retained.policy, maximumQuarantinedRecords: 1 };
  const changedRetry = rewrittenRequest(
    (_document, digest) => {
      digest.policy = changedPolicy;
    },
    { policy: changedPolicy },
  );
  expect(changedRetry.validationDigest).not.toBe(retained.validationDigest);
  const changed = capture(environment);
  expect(
    await runCommand(await saveRewritten("changed-policy-retry", changedRetry), changed.io),
  ).toBe(1);
  expect(changed.output).toEqual([]);
  expect(changed.errors.join("\n")).toContain("replay differs from immutable validation evidence");
  expect(await catalogueSnapshot(owner)).toEqual(afterCommit);
  const retry = capture(environment);
  expect(await runCommand(submitArgs, retry.io)).toBe(0);
  expect(oneOutput<SubmitValidationOutput>(retry)).toMatchObject({
    batchId: staged.batchId,
    requestSha256: preparation.request.sha256,
    validation: {
      wasAlreadyValidated: true,
      validationDigest: preparation.validationDigest,
      nutrientMappingDigest: mappingSha256,
      nutritionSemanticContractVersion: 1,
      nutritionSemanticSha256: validated.nutrition_semantic_sha256,
      stagedCount: RECORD_COUNT,
      validCount: RECORD_COUNT,
      promotionEligible: true,
    },
  });
  expect(await catalogueSnapshot(owner)).toEqual(afterCommit);
  expect(await readFile(join(WORKSPACE_ROOT, requestPath))).toEqual(requestBytes);

  const quarantine = await createFixture(randomBytes(8).toString("hex"), cleanupPaths, {
    recordCount: 1,
    unmappedNutrient: true,
  });
  const registration = capture(runnerEnvironment(input.ownerUrl));
  expect(
    await runCommand(
      [
        "catalogue",
        "register-source",
        quarantine.manifestRelative,
        "--evidence-bundle",
        quarantine.evidencePath,
      ],
      registration.io,
    ),
  ).toBe(0);
  oneOutput(registration);
  const quarantineStage = capture(runnerEnvironment(input.stageUrl));
  expect(await runCommand(stageArguments(quarantine, mappingSha256), quarantineStage.io)).toBe(0);
  const quarantineBatch = oneOutput<StageOutput>(quarantineStage);
  const beforeQuarantine = await catalogueSnapshot(owner);
  const quarantinePath = validationRequestPath(input.suffix, "quarantine");
  const prepareQuarantine = capture(environment);
  expect(
    await runCommand(
      prepareValidationArguments(quarantineBatch, mappingSha256, quarantinePath),
      prepareQuarantine.io,
    ),
  ).toBe(0);
  cleanupPaths.push(join(WORKSPACE_ROOT, quarantinePath));
  const quarantineRequest = oneOutput<PrepareValidationOutput>(prepareQuarantine);
  expect(await catalogueSnapshot(owner)).toEqual(beforeQuarantine);
  const submitQuarantine = capture(environment);
  expect(await runCommand(submitValidationArguments(quarantineRequest), submitQuarantine.io)).toBe(
    0,
  );
  expect(oneOutput<SubmitValidationOutput>(submitQuarantine)).toMatchObject({
    batchId: quarantineBatch.batchId,
    validation: {
      wasAlreadyValidated: false,
      stagedCount: 1,
      validCount: 1,
      quarantinedCount: 0,
      excludedNutrientCount: 1,
      promotionEligible: false,
      nutritionSemanticContractVersion: 1,
    },
  });
  const quarantined = await owner
    .selectFrom("food_import_batch")
    .select(["status", "unresolved_error_count"])
    .where("id", "=", quarantineBatch.batchId)
    .executeTakeFirstOrThrow();
  expect(quarantined.status).toBe("quarantined");
  expect(Number(quarantined.unresolved_error_count)).toBeGreaterThan(0);
  const afterQuarantine = await catalogueSnapshot(owner);
  expect(afterQuarantine.releaseState).toEqual(beforeQuarantine.releaseState);
  expect(afterQuarantine.authorityState).toEqual(beforeQuarantine.authorityState);
  return preparation;
}

interface ReviewLogin {
  readonly role: "data" | "quality" | "rights";
  readonly principal: string;
  readonly url: string;
}

async function exerciseCatalogueReviewHandoff(input: {
  readonly owner: DatabaseClient;
  readonly ownerUrl: string;
  readonly stageUrl: string;
  readonly validateUrl: string;
  readonly promoteUrl: string;
  readonly promotePrincipal: string;
  readonly reviewers: readonly ReviewLogin[];
  readonly rejectedUrls: readonly string[];
  readonly fixture: Fixture;
  readonly preparation: PrepareValidationOutput;
  readonly mappingSha256: string;
  readonly suffix: string;
  readonly cleanupPaths: string[];
}): Promise<void> {
  const { owner, suffix } = input;
  const dataReviewer = input.reviewers.find((entry) => entry.role === "data");
  if (!dataReviewer) throw new Error("Synthetic data reviewer is missing");

  // The original fixture keeps its nonrelease authority. Neither review nor a
  // protected promotion call can turn that fixture into an active catalogue.
  const beforeNonrelease = await catalogueSnapshot(owner);
  const nonreleaseApproval = capture(validationEnvironment(dataReviewer.url));
  expect(
    await runCommand(
      approvalArguments(input.preparation, input.fixture, dataReviewer),
      nonreleaseApproval.io,
    ),
  ).toBe(1);
  expect(nonreleaseApproval.output).toEqual([]);
  expect(nonreleaseApproval.errors.join("\n")).toContain("live-reviewed");
  await expect(
    promoteSyntheticBatch(input.promoteUrl, input.promotePrincipal, input.preparation.batchId),
  ).rejects.toThrow("live-reviewed");
  expect(await catalogueSnapshot(owner)).toEqual(beforeNonrelease);

  await exerciseRetainedReconciliation({
    ...input,
    preparation: input.preparation,
    currentReleaseId: null,
    label: "nonrelease",
  });

  // This is a separate synthetic live-reviewed authority fixture, assembled by
  // the normal manifest/bundle parsers. No staged row is relabelled or rewritten.
  const baseline = await stageValidatedReviewFixture(input, "baseline");
  const beforeApprovals = await catalogueSnapshot(owner);
  const rejectApproval = async (args: readonly string[], url: string) => {
    const before = await catalogueSnapshot(owner);
    const rejected = capture(validationEnvironment(url));
    expect(await runCommand(args, rejected.io)).toBe(1);
    expect(rejected.output).toEqual([]);
    expect(rejected.errors.length).toBeGreaterThan(0);
    expect(await catalogueSnapshot(owner)).toEqual(before);
  };
  const dataArgs = approvalArguments(baseline.preparation, baseline.fixture, dataReviewer);
  for (const url of input.rejectedUrls) {
    await rejectApproval(
      replaceOption(dataArgs, "--external-principal-id", decodeURIComponent(new URL(url).username)),
      url,
    );
  }
  await rejectApproval(
    replaceOption(dataArgs, "--external-principal-id", "principal:spoofed-reviewer"),
    dataReviewer.url,
  );
  await rejectApproval(replaceOption(dataArgs, "--role", "quality"), dataReviewer.url);
  await rejectApproval(
    replaceOption(dataArgs, "--manifest-sha256", "0".repeat(64)),
    dataReviewer.url,
  );
  await rejectApproval(
    replaceOption(dataArgs, "--validation-digest", "0".repeat(64)),
    dataReviewer.url,
  );

  for (const reviewer of input.reviewers) {
    const client = createDatabase({ connectionString: reviewer.url, maxConnections: 1 });
    try {
      const identity = await client.executeQuery<{ readonly principal: string }>(
        query("select session_user::text as principal"),
      );
      expect(identity.rows[0]?.principal).toBe(reviewer.principal);
      for (const statement of [
        "select id from public.food_import_batch limit 1",
        "select id from public.food_import_approval limit 1",
        "update public.food_import_approval set approval_reference = approval_reference where false",
      ])
        await expect(client.executeQuery(query(statement))).rejects.toMatchObject({
          code: "42501",
        });
    } finally {
      await client.destroy();
    }
    const args = approvalArguments(baseline.preparation, baseline.fixture, reviewer);
    const first = capture(validationEnvironment(reviewer.url));
    if (reviewer.role === "data") {
      let lostReceipt: unknown;
      expect(
        await runCommand(args, {
          ...first.io,
          writeOutput: (value) => {
            lostReceipt = JSON.parse(value);
            throw new Error("synthetic approval acknowledgement lost after commit");
          },
        }),
      ).toBe(1);
      expect(first.errors.join("\n")).toContain("approval acknowledgement lost after commit");
      expect(lostReceipt).toMatchObject({
        batchId: baseline.preparation.batchId,
        approvalRole: reviewer.role,
        wasAlreadyApproved: false,
      });
    } else {
      expect(await runCommand(args, first.io)).toBe(0);
      expect(oneOutput(first)).toMatchObject({
        batchId: baseline.preparation.batchId,
        approvalRole: reviewer.role,
        wasAlreadyApproved: false,
      });
    }
    const beforeReplay = await catalogueSnapshot(owner);
    const replay = capture(validationEnvironment(reviewer.url));
    expect(await runCommand(args, replay.io)).toBe(0);
    expect(oneOutput(replay)).toMatchObject({
      batchId: baseline.preparation.batchId,
      approvalRole: reviewer.role,
      wasAlreadyApproved: true,
    });
    expect(await catalogueSnapshot(owner)).toEqual(beforeReplay);
    await rejectApproval(
      replaceOption(
        args,
        "--approval-reference",
        `review://synthetic-adr0103/${suffix}/${reviewer.role}/changed`,
      ),
      reviewer.url,
    );
  }
  const approvals = await owner
    .selectFrom("food_import_approval")
    .selectAll()
    .where("batch_id", "=", baseline.preparation.batchId)
    .orderBy("approval_role")
    .execute();
  expect(approvals).toHaveLength(3);
  expect(new Set(approvals.map((row) => row.database_principal)).size).toBe(3);
  for (const reviewer of input.reviewers) {
    expect(approvals.find((row) => row.approval_role === reviewer.role)).toMatchObject({
      database_principal: reviewer.principal,
      principal_id: reviewer.principal,
      database_capability_role: `nutrition_catalogue_approve_${reviewer.role}`,
      validation_digest: baseline.preparation.validationDigest,
      rights_manifest_sha256: baseline.fixture.manifestSha256,
    });
  }
  const afterApprovals = await catalogueSnapshot(owner);
  expect(afterApprovals.releaseState).toEqual(beforeApprovals.releaseState);
  expect(afterApprovals.stagingState).toEqual(beforeApprovals.stagingState);
  expect((afterApprovals.authorityState as { readonly outbox: unknown }).outbox).toEqual(
    (beforeApprovals.authorityState as { readonly outbox: unknown }).outbox,
  );
  await exerciseRetainedReconciliation({
    ...input,
    preparation: baseline.preparation,
    currentReleaseId: null,
    label: "reviewed-baseline",
  });

  // Promotion is an explicit synthetic setup step after proving approvals alone
  // changed neither the active release nor materialized/index state.
  const promoted = await promoteSyntheticBatch(
    input.promoteUrl,
    input.promotePrincipal,
    baseline.preparation.batchId,
  );
  expect(promoted).toMatchObject({
    previousReleaseId: null,
    materializedCount: 1,
    wasAlreadyCompleted: false,
  });
  expect(promoted.activatedReleaseId).toMatch(/^[0-9a-f-]{36}$/u);
  const completed = await owner
    .selectFrom("food_import_batch")
    .select(["status", "release_id", "validation_digest"])
    .where("id", "=", baseline.preparation.batchId)
    .executeTakeFirstOrThrow();
  expect(completed).toEqual({
    status: "completed",
    release_id: promoted.activatedReleaseId,
    validation_digest: baseline.preparation.validationDigest,
  });
  const next = await stageValidatedReviewFixture(input, "next-candidate");
  const reconciled = await exerciseRetainedReconciliation({
    ...input,
    preparation: next.preparation,
    currentReleaseId: promoted.activatedReleaseId,
    label: "current-baseline",
  });
  expect(reconciled.evidence.baseline).toMatchObject({
    batchId: baseline.preparation.batchId,
    releaseId: promoted.activatedReleaseId,
    validationDigest: baseline.preparation.validationDigest,
  });
  expect(reconciled.evidence.candidate).toMatchObject({
    batchId: next.preparation.batchId,
    validationDigest: next.preparation.validationDigest,
  });
  const active = await owner
    .selectFrom("food_source")
    .select("active_release_id")
    .where("code", "=", "USDA_FDC")
    .executeTakeFirstOrThrow();
  expect(active.active_release_id).toBe(promoted.activatedReleaseId);
  expect(
    await owner
      .selectFrom("food_import_approval")
      .select("id")
      .where("batch_id", "=", next.preparation.batchId)
      .execute(),
  ).toEqual([]);
}

async function stageValidatedReviewFixture(
  input: {
    readonly ownerUrl: string;
    readonly stageUrl: string;
    readonly validateUrl: string;
    readonly mappingSha256: string;
    readonly suffix: string;
    readonly cleanupPaths: string[];
  },
  label: string,
) {
  const fixture = await createFixture(randomBytes(8).toString("hex"), input.cleanupPaths, {
    recordCount: 1,
    syntheticLiveReview: true,
  });
  const registration = capture(runnerEnvironment(input.ownerUrl));
  expect(
    await runCommand(
      [
        "catalogue",
        "register-source",
        fixture.manifestRelative,
        "--evidence-bundle",
        fixture.evidencePath,
      ],
      registration.io,
    ),
  ).toBe(0);
  oneOutput(registration);
  const stage = capture(runnerEnvironment(input.stageUrl));
  expect(await runCommand(stageArguments(fixture, input.mappingSha256), stage.io)).toBe(0);
  const staged = oneOutput<StageOutput>(stage);
  const path = validationRequestPath(input.suffix, label);
  await expect(lstat(join(WORKSPACE_ROOT, path))).rejects.toMatchObject({ code: "ENOENT" });
  input.cleanupPaths.push(join(WORKSPACE_ROOT, path));
  const prepare = capture(validationEnvironment(input.validateUrl));
  expect(
    await runCommand(prepareValidationArguments(staged, input.mappingSha256, path), prepare.io),
  ).toBe(0);
  const preparation = oneOutput<PrepareValidationOutput>(prepare);
  const submit = capture(validationEnvironment(input.validateUrl));
  expect(await runCommand(submitValidationArguments(preparation), submit.io)).toBe(0);
  expect(oneOutput<SubmitValidationOutput>(submit)).toMatchObject({
    validation: { promotionEligible: true, validCount: 1, wasAlreadyValidated: false },
  });
  return { fixture, preparation };
}

async function exerciseRetainedReconciliation(input: {
  readonly owner: DatabaseClient;
  readonly ownerUrl: string;
  readonly preparation: PrepareValidationOutput;
  readonly currentReleaseId: string | null;
  readonly suffix: string;
  readonly label: string;
  readonly cleanupPaths: string[];
}): Promise<CatalogueReconciliationDocument> {
  const { preparation } = input;
  const path = `.local-data/evidence/catalogue-reconciliation/adr0103-${input.suffix}-${input.label}.json`;
  await expect(lstat(join(WORKSPACE_ROOT, path))).rejects.toMatchObject({ code: "ENOENT" });
  input.cleanupPaths.push(join(WORKSPACE_ROOT, path));
  const base = [
    "catalogue",
    "reconcile",
    "--batch-id",
    preparation.batchId,
    "--expected-current-release-id",
    input.currentReleaseId ?? "none",
    "--expected-validation-digest",
    preparation.validationDigest,
    "--report-out",
    path,
  ];
  const args = [
    ...base,
    "--validation-request",
    preparation.request.path,
    "--validation-request-sha256",
    preparation.request.sha256,
    "--validation-request-bytes",
    String(preparation.request.byteSize),
  ];
  const before = await catalogueSnapshot(input.owner);
  const reject = async (rejectedArgs: readonly string[]) => {
    const command = capture(validationEnvironment(input.ownerUrl));
    expect(await runCommand(rejectedArgs, command.io)).toBe(1);
    expect(command.output).toEqual([]);
    expect(command.errors.length).toBeGreaterThan(0);
    await expect(lstat(join(WORKSPACE_ROOT, path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await catalogueSnapshot(input.owner)).toEqual(before);
  };
  await reject(base);
  await reject([...base, "--validation-request", preparation.request.path]);
  await reject(replaceOption(args, "--validation-request-sha256", "0".repeat(64)));
  await reject(
    replaceOption(args, "--validation-request-bytes", String(preparation.request.byteSize + 1)),
  );
  await reject(replaceOption(args, "--expected-validation-digest", "0".repeat(64)));
  await reject(replaceOption(args, "--expected-current-release-id", randomUUID()));
  const request = JSON.parse(
    await readFile(join(WORKSPACE_ROOT, preparation.request.path), "utf8"),
  ) as PreparedCatalogueValidationRequest;
  const tampered = { ...request, expectedStagingSealSha256: "0".repeat(64) };
  const tamperedPath = validationRequestPath(input.suffix, `${input.label}-seal-tamper`);
  const bytes = Buffer.from(`${canonicalJson(tampered as unknown as JsonObject)}\n`);
  await privateFile(join(WORKSPACE_ROOT, tamperedPath), bytes);
  input.cleanupPaths.push(join(WORKSPACE_ROOT, tamperedPath));
  await reject(
    replaceOption(
      replaceOption(
        replaceOption(args, "--validation-request", tamperedPath),
        "--validation-request-sha256",
        hash(bytes),
      ),
      "--validation-request-bytes",
      String(bytes.length),
    ),
  );
  const command = capture(validationEnvironment(input.ownerUrl));
  expect(await runCommand(args, command.io)).toBe(0);
  const receipt = oneOutput<{ readonly reconciliationSha256: string }>(command);
  const document: unknown = JSON.parse(await readFile(join(WORKSPACE_ROOT, path), "utf8"));
  verifyCatalogueReconciliationDocument(document);
  expect(document.reconciliationSha256).toBe(receipt.reconciliationSha256);
  expect(document.evidence.candidate).toMatchObject({
    batchId: preparation.batchId,
    validationDigest: preparation.validationDigest,
  });
  if (input.currentReleaseId === null) expect(document.evidence.baseline).toBeNull();
  else expect(document.evidence.baseline).toMatchObject({ releaseId: input.currentReleaseId });
  expect(await catalogueSnapshot(input.owner)).toEqual(before);
  return document;
}

function approvalArguments(
  preparation: PrepareValidationOutput,
  fixture: Fixture,
  reviewer: ReviewLogin,
): string[] {
  return [
    "catalogue",
    "submit-approval",
    "--batch-id",
    preparation.batchId,
    "--role",
    reviewer.role,
    "--manifest-sha256",
    fixture.manifestSha256,
    "--validation-digest",
    preparation.validationDigest,
    "--external-principal-id",
    reviewer.principal,
    "--approval-reference",
    `review://synthetic-adr0103/${preparation.batchId}/${reviewer.role}`,
  ];
}

async function promoteSyntheticBatch(
  url: string,
  principal: string,
  batchId: string,
): Promise<{
  readonly activatedReleaseId: string;
  readonly previousReleaseId: string | null;
  readonly materializedCount: number;
  readonly wasAlreadyCompleted: boolean;
}> {
  const database = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    const result = await database.executeQuery<{
      readonly result: {
        readonly activatedReleaseId: string;
        readonly previousReleaseId: string | null;
        readonly materializedCount: number;
        readonly wasAlreadyCompleted: boolean;
      };
    }>(
      query(
        "select public.catalogue_promote_import_batch($1::uuid, $2::text, $3::text) as result",
        [batchId, principal, "Synthetic ADR0103 baseline for isolated reconciliation test"],
      ),
    );
    const row = result.rows[0]?.result;
    if (!row) throw new Error("Synthetic promotion returned no receipt");
    return row;
  } finally {
    await database.destroy();
  }
}

function validationRequestPath(suffix: string, label: string): string {
  return `.local-data/evidence/catalogue-validation/adr0102-${suffix}-${label}.json`;
}
function prepareValidationArguments(
  staged: StageOutput,
  mappingSha256: string,
  path: string,
): string[] {
  return [
    "catalogue",
    "prepare-validation",
    staged.batchId,
    "--staging-seal-sha256",
    staged.stagingSealSha256,
    "--nutrient-mapping-sha256",
    mappingSha256,
    "--maximum-excluded-nutrient-fraction",
    "0",
    "--maximum-quarantine-fraction",
    "0",
    "--maximum-quarantined-records",
    "0",
    "--require-distinct-approval-principals",
    "true",
    "--require-at-least-one-valid-record",
    "true",
    "--require-materialized-nutrient-per-valid-record",
    "true",
    "--request-out",
    path,
  ];
}
function submitValidationArguments(prepared: PrepareValidationOutput): string[] {
  return [
    "catalogue",
    "submit-validation",
    prepared.batchId,
    "--request",
    prepared.request.path,
    "--request-sha256",
    prepared.request.sha256,
    "--request-bytes",
    String(prepared.request.byteSize),
  ];
}
function validationEnvironment(url: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: url,
    DATABASE_APPLICATION_NAME: "nutrition-fdc-csv-independent-validator",
    DATABASE_POOL_MAX: "1",
    DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    DATABASE_STATEMENT_TIMEOUT_MS: "30000",
    DATABASE_SSL_MODE: "disable",
    NODE_ENV: "test",
  };
}

async function createFixtureRoot(root: string, cleanup: string[]): Promise<void> {
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  cleanup.push(root);
}

async function createFixture(
  suffix: string,
  cleanup: string[],
  options: {
    readonly recordCount?: number;
    readonly unmappedNutrient?: boolean;
    readonly syntheticLiveReview?: boolean;
  } = {},
): Promise<Fixture> {
  const recordCount = options.recordCount ?? RECORD_COUNT;
  const rootRelative = `.local-data/fdc-csv-stage-cli-${suffix}`;
  const root = join(WORKSPACE_ROOT, rootRelative);
  await createFixtureRoot(root, cleanup);
  const prefix = "synthetic-full-fdc";
  const files = {
    [`${prefix}/food.csv`]: `fdc_id,data_type,description,publication_date\n${Array.from({ length: recordCount }, (_, index) => `${1000 + index},source_foundation,Synthetic food ${index},2026-04-30`).join("\n")}\n`,
    [`${prefix}/branded_food.csv`]:
      "fdc_id,brand_owner,gtin_upc,serving_size,serving_size_unit,household_serving_fulltext,market_country\n",
    [`${prefix}/food_nutrient.csv`]: `id,fdc_id,nutrient_id,amount,data_points,derivation_id,loq\n${Array.from({ length: recordCount }, (_, index) => `${index + 1},${1000 + index},1008,${index % 7},3,49,`).join("\n")}\n`,
    [`${prefix}/nutrient.csv`]: `id,name,unit_name\n1008,Energy,KCAL\n${options.unmappedNutrient ? "9999,Synthetic unmapped nutrient,MG\n" : ""}`,
    [`${prefix}/food_nutrient_derivation.csv`]:
      "id,code,description,source_id\n49,A,Analytical,1\n",
    [`${prefix}/food_portion.csv`]:
      "id,fdc_id,amount,measure_unit_id,portion_description,modifier,gram_weight\n",
    [`${prefix}/measure_unit.csv`]: "id,name\n1,gram\n",
  };
  if (options.unmappedNutrient) {
    files[`${prefix}/food_nutrient.csv`] += `${recordCount + 1},1000,9999,1,3,49,\n`;
  }
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
  const fixtureEvidence = bindSyntheticReleaseEvidence(manifest, RUNNER);
  const bound = options.syntheticLiveReview
    ? bindSyntheticLiveReview(fixtureEvidence)
    : fixtureEvidence;
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
      'activations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]') from food_source_release_activation a),
      'foods', (select coalesce(jsonb_agg(to_jsonb(f) order by f.id), '[]') from food f),
      'foodVersions', (select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from food_version v)
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
  if (
    !/^fdc_csv_(?:cli|stage|validate|wrong|multi|data|quality|rights|promote)_[0-9a-f]{16}$/u.test(
      value,
    )
  )
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
