import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  approveBatch,
  canonicalJson,
  createDatabase,
  type Database,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  type JsonObject,
  previewBatchValidation,
  promoteBatch,
  type RecordBatchParserReportInput,
  reconcileCatalogueBatch,
  recordBatchParserReport,
  recordBatchParserReportAndValidate,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  rollbackSourceRelease,
  runMigrations,
  saveBatchCheckpoint,
  sha256CanonicalJson,
  stageBatch,
  stageBatchRecords,
  supersedeSourceNutrientMapping,
  validateBatch,
  verifyCatalogueReconciliationDocument,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const CNF_SOURCE_CODE = "HEALTH_CANADA_CNF";
const CNF_TABLE_CONTRACT = [
  ["Food_Name.csv", "adapter-input", null],
  ["Food_Source.csv", "reference-only", "food_source_reference_not_materialized_v1"],
  ["CNF_Food_Group.csv", "reference-only", "upstream_food_group_taxonomy_not_materialized_v1"],
  ["Nutrient_Amount.csv", "adapter-input", null],
  ["Nutrient_Name.csv", "adapter-input", null],
  ["Nutrient_Source.csv", "reference-only", "nutrient_source_lookup_not_materialized_v1"],
  ["Measure_Weight_Conversion.csv", "adapter-input", null],
  ["Measure_Type.csv", "reference-only", "measure_type_lookup_not_materialized_v1"],
  ["Measure_Name.csv", "adapter-input", null],
] as const;

describeDatabase("catalogue ingestion PostgreSQL integration", () => {
  it("atomically rolls back parser evidence so a new authenticated run can resume", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const fixture = await createCnfParserValidationFixture(database, {
        persistReport: false,
      });
      const firstReport = structuredClone(fixture.reportInput) as RecordBatchParserReportInput;
      const firstPayload = firstReport.report as {
        actor: { runReference: string };
        parserPackage: string;
      };
      firstPayload.actor.runReference = "urn:cnf-integration:first-run";
      firstPayload.parserPackage = "unreviewed-parser";

      await expect(recordBatchParserReportAndValidate(database, firstReport)).rejects.toThrow(
        "CNF parser report parserPackage must be @nutrition-tracker/ingestion",
      );
      expect(
        await database
          .selectFrom("food_import_parser_report")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("batch_id", "=", fixture.batchId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      expect(await cnfValidationFreezeSnapshot(database, fixture.batchId)).toMatchObject({
        batch: { status: "staging", validated_at: null, validation_policy: {} },
      });

      const resumedReport = structuredClone(fixture.reportInput) as RecordBatchParserReportInput;
      const resumedPayload = resumedReport.report as { actor: { runReference: string } };
      resumedPayload.actor.runReference = "urn:cnf-integration:replacement-run";
      const finalized = await recordBatchParserReportAndValidate(database, resumedReport);

      expect(finalized.validation).toMatchObject({
        promotionEligible: false,
        stagedCount: 2,
        validCount: 2,
      });
      expect(await cnfValidationFreezeSnapshot(database, fixture.batchId)).toMatchObject({
        batch: { status: "quarantined", validated_at: expect.any(Date) },
      });
      const stored = await database
        .selectFrom("food_import_parser_report")
        .select("report")
        .where("batch_id", "=", fixture.batchId)
        .executeTakeFirstOrThrow();
      expect((stored.report.actor as JsonObject).runReference).toBe(
        "urn:cnf-integration:replacement-run",
      );
    } finally {
      await database.destroy();
    }
  }, 30_000);

  it("rejects malformed count-consistent CNF evidence before freezing validation", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const fixture = await createCnfParserValidationFixture(database, {
        parserPackage: "unreviewed-parser",
      });
      const before = await cnfValidationFreezeSnapshot(database, fixture.batchId);

      await expect(validateBatch(database, fixture.batchId)).rejects.toThrow(
        "CNF parser report parserPackage must be @nutrition-tracker/ingestion",
      );
      const after = await cnfValidationFreezeSnapshot(database, fixture.batchId);
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        batch: { status: "staging", validated_at: null, validation_policy: {} },
        records: [
          { validated_at: null, validation_issues: [], validation_status: "pending" },
          { validated_at: null, validation_issues: [], validation_status: "pending" },
        ],
      });
    } finally {
      await database.destroy();
    }
  }, 30_000);

  it("rejects CNF accepted-payload evidence that is not bound to ordered staged rows", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const fixture = await createCnfParserValidationFixture(database, {
        reverseAcceptedSourcePayloadOrder: true,
      });
      const before = await cnfValidationFreezeSnapshot(database, fixture.batchId);

      await expect(validateBatch(database, fixture.batchId)).rejects.toThrow(
        "CNF accepted source-payload digest does not match staged canonical records",
      );
      const after = await cnfValidationFreezeSnapshot(database, fixture.batchId);
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        batch: { status: "staging", validated_at: null, validation_policy: {} },
        records: [
          { validated_at: null, validation_issues: [], validation_status: "pending" },
          { validated_at: null, validation_issues: [], validation_status: "pending" },
        ],
      });
    } finally {
      await database.destroy();
    }
  }, 30_000);

  it("serializes monotonic checkpoints and rejects a queued write after validation freezes", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const suffix = randomBytes(6).toString("hex");
    const finalWriterName = `checkpoint-final-${suffix}`;
    const staleWriterName = `checkpoint-stale-${suffix}`;
    const validatorName = `checkpoint-validator-${suffix}`;
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    const finalWriter = createDatabase({
      applicationName: finalWriterName,
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const staleWriter = createDatabase({
      applicationName: staleWriterName,
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const validator = createDatabase({
      applicationName: validatorName,
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const releaseBatchLock = deferred<void>();
    const batchLockReady = deferred<void>();
    const releaseRecordLock = deferred<void>();
    const recordLockReady = deferred<void>();
    let batchLocker: Promise<void> | undefined;
    let finalCheckpoint: Promise<void> | undefined;
    let staleCheckpoint: Promise<void> | undefined;
    let recordLocker: Promise<void> | undefined;
    let validation: ReturnType<typeof recordBatchParserReportAndValidate> | undefined;
    let lateCheckpoint: Promise<void> | undefined;
    try {
      await runMigrations(database);
      const fixture = await createCnfParserValidationFixture(database, {
        persistReport: false,
      });
      await saveBatchCheckpoint(database, {
        batchId: fixture.batchId,
        cursor: { page: 2 },
        lastSequenceNumber: 1,
        processedCount: 2,
        stage: "parse",
      });
      await saveBatchCheckpoint(database, {
        batchId: fixture.batchId,
        cursor: { page: 2 },
        lastSequenceNumber: 1,
        processedCount: 2,
        stage: "parse",
      });
      await expect(
        saveBatchCheckpoint(database, {
          batchId: fixture.batchId,
          cursor: { page: 1 },
          lastSequenceNumber: 1,
          processedCount: 1,
          stage: "parse",
        }),
      ).rejects.toThrow("processedCount cannot regress from 2 to 1");
      await expect(
        saveBatchCheckpoint(database, {
          batchId: fixture.batchId,
          cursor: { page: 3 },
          lastSequenceNumber: 0,
          processedCount: 3,
          stage: "parse",
        }),
      ).rejects.toThrow("lastSequenceNumber cannot regress from 1 to 0");
      await expect(
        saveBatchCheckpoint(database, {
          batchId: fixture.batchId,
          cursor: { page: "different-evidence" },
          lastSequenceNumber: 1,
          processedCount: 2,
          stage: "parse",
        }),
      ).rejects.toThrow("cannot replace equal-progress evidence");

      await saveBatchCheckpoint(database, {
        batchId: fixture.batchId,
        cursor: { nextOffset: 1 },
        lastSequenceNumber: 0,
        processedCount: 1,
        stage: "stage",
      });
      await expect(
        saveBatchCheckpoint(database, {
          batchId: fixture.batchId,
          cursor: { nextOffset: 1 },
          lastSequenceNumber: 1,
          processedCount: 2,
          stage: "stage",
        }),
      ).rejects.toThrow("Stage checkpoint requires nextOffset = processedCount");

      batchLocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("food_import_batch")
          .select("id")
          .where("id", "=", fixture.batchId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        batchLockReady.resolve();
        await releaseBatchLock.promise;
      });
      await batchLockReady.promise;
      finalCheckpoint = saveBatchCheckpoint(finalWriter, {
        batchId: fixture.batchId,
        cursor: { nextOffset: 2 },
        lastSequenceNumber: 1,
        processedCount: 2,
        stage: "stage",
      });
      await waitForApplicationLock(database, finalWriterName);
      staleCheckpoint = expect(
        saveBatchCheckpoint(staleWriter, {
          batchId: fixture.batchId,
          cursor: { nextOffset: 1 },
          lastSequenceNumber: 0,
          processedCount: 1,
          stage: "stage",
        }),
      ).rejects.toThrow("processedCount cannot regress from 2 to 1");
      await waitForApplicationLock(database, staleWriterName);
      releaseBatchLock.resolve();
      await batchLocker;
      await finalCheckpoint;
      await staleCheckpoint;
      const frozenCheckpoint = await getBatchCheckpoint(database, fixture.batchId, "stage");
      expect(frozenCheckpoint).toMatchObject({
        cursor: { nextOffset: 2 },
        lastSequenceNumber: "1",
        processedCount: "2",
      });

      recordLocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("food_import_record")
          .select("id")
          .where("batch_id", "=", fixture.batchId)
          .orderBy("sequence_number")
          .forUpdate()
          .executeTakeFirstOrThrow();
        recordLockReady.resolve();
        await releaseRecordLock.promise;
      });
      await recordLockReady.promise;
      validation = recordBatchParserReportAndValidate(validator, fixture.reportInput, {
        maximumExcludedNutrientFraction: 1,
        requireMaterializedNutrientPerValidRecord: false,
      });
      await waitForApplicationLock(database, validatorName);
      lateCheckpoint = expect(
        saveBatchCheckpoint(staleWriter, {
          batchId: fixture.batchId,
          cursor: { nextOffset: 2 },
          lastSequenceNumber: 1,
          processedCount: 2,
          stage: "stage",
        }),
      ).rejects.toThrow("cannot checkpoint while ready");
      await waitForApplicationLock(database, staleWriterName);
      releaseRecordLock.resolve();
      await recordLocker;
      expect((await validation).validation).toMatchObject({ promotionEligible: true });
      await lateCheckpoint;
      expect(await getBatchCheckpoint(database, fixture.batchId, "stage")).toEqual(
        frozenCheckpoint,
      );
    } finally {
      releaseBatchLock.resolve();
      releaseRecordLock.resolve();
      await Promise.allSettled(
        [
          batchLocker,
          finalCheckpoint,
          staleCheckpoint,
          recordLocker,
          validation,
          lateCheckpoint,
        ].map((operation) => operation ?? Promise.resolve()),
      );
      await Promise.all([
        finalWriter.destroy(),
        staleWriter.destroy(),
        validator.destroy(),
        database.destroy(),
      ]);
    }
  }, 30_000);

  it("replays idempotently, promotes atomically, rolls back pointers, and preserves history", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const suffix = randomBytes(4).toString("hex").toUpperCase();
      const sourceCode = `IT${suffix}`;
      const rightsSha = "c".repeat(64);
      const source = {
        id: await registerFoodSourceFromReviewedManifest(database, {
          attributionRequired: true,
          attributionText: "Integration test source",
          code: sourceCode,
          commercialUseAllowed: true,
          databaseRightsNotes: "Test-only fixture",
          displayName: `Integration source ${suffix}`,
          homepageUrl: "https://example.invalid/catalogue",
          kind: "government",
          licenseExpression: "CC0-1.0",
          licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
          redistributionAllowed: true,
          rightsReviewStatus: "approved",
          rightsReviewedAt: "2026-08-15T12:00:00Z",
          rightsReviewedBy: "principal:legal-review",
        }),
      };
      await registerSourceNutrientMappings(database, {
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "g",
          },
        ],
        reviewedAt: "2026-08-15T12:05:00Z",
        reviewedBy: "principal:nutrition-review",
        sourceCode,
      });
      await registerSourceNutrientMappings(database, {
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "g",
          },
        ],
        reviewedAt: "2026-08-15T12:05:00Z",
        reviewedBy: "principal:nutrition-review",
        sourceCode,
      });

      const firstBatch = await stageBatch(database, batchInput(sourceCode, "release-1", rightsSha));
      const firstRecords = [
        recordInput(foodPayload(sourceCode, "release-1", "food-1", "Oats", "12.5", true), 0),
        recordInput(foodPayload(sourceCode, "release-1", "food-removed", "Barley", "10"), 1),
        {
          canonicalPayload: null,
          sequenceNumber: 2,
          sourcePayloadSha256: "d".repeat(64),
          sourceRecordKey: `${sourceCode}:release-1:Foundation:null-2`,
          sourceRecordType: "Foundation",
        },
      ] as const;
      expect(await stageBatchRecords(database, firstBatch.batchId, firstRecords)).toMatchObject({
        inserted: 3,
        replayed: 0,
        stagedCount: "3",
      });
      expect(await stageBatchRecords(database, firstBatch.batchId, firstRecords)).toMatchObject({
        inserted: 0,
        replayed: 3,
        stagedCount: "3",
      });
      await recordBatchParserReport(database, {
        batchId: firstBatch.batchId,
        emittedNutrientCount: 2,
        emittedPortionCount: 1,
        emittedRecordCount: 3,
        excludedNutrientCount: 1,
        excludedPortionCount: 1,
        excludedRecordCount: 1,
        report: { adapter: "integration", release: "release-1" },
        sourceNutrientCount: 3,
        sourcePortionCount: 2,
        sourceRecordCount: 4,
      });
      await saveBatchCheckpoint(database, {
        batchId: firstBatch.batchId,
        cursor: { nextOffset: 3 },
        lastSequenceNumber: 2,
        processedCount: 3,
        stage: "stage",
      });
      expect(await getBatchCheckpoint(database, firstBatch.batchId, "stage")).toMatchObject({
        cursor: { nextOffset: 3 },
        lastSequenceNumber: "2",
        processedCount: "3",
      });

      const policy = {
        maximumExcludedNutrientFraction: 0.34,
        maximumQuarantineFraction: 0.5,
        maximumQuarantinedRecords: 2,
        requireAtLeastOneValidRecord: true,
        requireDistinctApprovalPrincipals: true,
        requireMaterializedNutrientPerValidRecord: true,
      } as const;
      expect(await previewBatchValidation(database, firstBatch.batchId, policy)).toMatchObject({
        promotionEligible: true,
        parserExcludedNutrientCount: 1,
        parserExcludedPortionCount: 1,
        parserExcludedRecordCount: 1,
        quarantinedCount: 2,
        validCount: 2,
      });
      const firstSummary = await validateBatch(database, firstBatch.batchId, policy);
      await expect(
        approveBatch(database, {
          approvalReference: "review://invalid-principal",
          approvalRole: "data",
          batchId: firstBatch.batchId,
          principalId: "principal:data-review ",
          rightsManifestSha256: rightsSha,
          validationDigest: firstSummary.validationDigest,
        }),
      ).rejects.toThrow("canonical lowercase principal ID");
      await expect(
        promoteBatch(database, {
          batchId: firstBatch.batchId,
          performedBy: "service:catalogue-promoter",
        }),
      ).rejects.toThrow("Data, quality, and rights approvals");
      expect(
        await database
          .selectFrom("food_source_release")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("food_source_id", "=", source.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
      await approveAll(database, firstBatch.batchId, firstSummary.validationDigest, rightsSha);

      const firstPromotion = await promoteBatch(database, {
        batchId: firstBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      expect(firstPromotion).toMatchObject({ materializedCount: 2, previousReleaseId: null });
      expect(
        await promoteBatch(database, {
          batchId: firstBatch.batchId,
          performedBy: "service:catalogue-promoter",
        }),
      ).toMatchObject({ previousReleaseId: null, wasAlreadyCompleted: true });

      const firstVersion = await database
        .selectFrom("food")
        .innerJoin("food_version", "food_version.id", "food.current_version_id")
        .select(["food.id as food_id", "food_version.id as version_id"])
        .where("food.food_source_id", "=", source.id)
        .where("food.source_food_key", "=", "food-1")
        .executeTakeFirstOrThrow();
      const snapshot = await createHistoricalSnapshot(database, firstVersion.version_id, suffix);

      const duplicateBatch = await stageBatch(
        database,
        batchInput(sourceCode, "release-duplicates", rightsSha, "1".repeat(64)),
      );
      const duplicateFoundation = foodPayload(
        sourceCode,
        "release-duplicates",
        "duplicate-food",
        "Duplicate foundation",
        "11",
      );
      const duplicateBranded: JsonObject = {
        ...duplicateFoundation,
        idempotencyKey: `${sourceCode}:release-duplicates:Branded:duplicate-food`,
        source: {
          ...(duplicateFoundation.source as JsonObject),
          sourceDataType: "Branded",
        },
      };
      await stageBatchRecords(database, duplicateBatch.batchId, [
        recordInput(duplicateFoundation, 0),
        recordInput(duplicateBranded, 1),
      ]);
      await recordBatchParserReport(database, {
        batchId: duplicateBatch.batchId,
        emittedNutrientCount: 2,
        emittedPortionCount: 0,
        emittedRecordCount: 2,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        report: { adapter: "integration", release: "release-duplicates" },
        sourceNutrientCount: 2,
        sourcePortionCount: 0,
        sourceRecordCount: 2,
      });
      const duplicateSummary = await previewBatchValidation(
        database,
        duplicateBatch.batchId,
        policy,
      );
      expect(duplicateSummary).toMatchObject({ promotionEligible: false, quarantinedCount: 2 });
      expect(
        duplicateSummary.records.flatMap((record) => record.issues.map((issue) => issue.code)),
      ).toEqual(["DUPLICATE_SOURCE_FOOD_KEY", "DUPLICATE_SOURCE_FOOD_KEY"]);

      const pinnedMappingDigest = await getSourceNutrientMappingDigest(database, sourceCode);
      const staleMappingBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "release-stale-mapping",
          rightsSha,
          "2".repeat(64),
          `integration-parser@1.0.0+build.${"3".repeat(64)}+mapping.${pinnedMappingDigest}`,
        ),
      );
      await stageBatchRecords(database, staleMappingBatch.batchId, [
        recordInput(
          foodPayload(sourceCode, "release-stale-mapping", "stale-food", "Stale food", "7"),
          0,
        ),
      ]);
      await recordBatchParserReport(database, {
        batchId: staleMappingBatch.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        report: { adapter: "integration", release: "release-stale-mapping" },
        sourceNutrientCount: 1,
        sourcePortionCount: 0,
        sourceRecordCount: 1,
      });
      const staleMappingSummary = await validateBatch(database, staleMappingBatch.batchId, policy);
      await approveAll(
        database,
        staleMappingBatch.batchId,
        staleMappingSummary.validationDigest,
        rightsSha,
      );

      const initialMapping = await database
        .selectFrom("source_nutrient_map")
        .select("current_revision_id")
        .where("food_source_id", "=", source.id)
        .where("source_nutrient_key", "=", "1003")
        .executeTakeFirstOrThrow();
      await supersedeSourceNutrientMapping(database, {
        changeReason: "Correct reviewed source conversion fixture",
        expectedCurrentRevisionId: initialMapping.current_revision_id,
        mapping: {
          canonicalNutrient: {
            code: "protein",
            dimension: "mass",
            name: "Protein",
            unit: "g",
          },
          conversionMultiplier: "2",
          sourceName: "Protein",
          sourceNutrientKey: "1003",
          sourceUnit: "g",
        },
        reviewedAt: "2026-08-16T12:05:00Z",
        reviewedBy: "principal:nutrition-review-2",
        sourceCode,
      });
      await expect(
        previewBatchValidation(database, staleMappingBatch.batchId, policy),
      ).rejects.toThrow("Source nutrient mappings changed after this validation attempt");
      await expect(
        promoteBatch(database, {
          batchId: staleMappingBatch.batchId,
          performedBy: "service:catalogue-promoter",
        }),
      ).rejects.toThrow("Source nutrient mappings changed after this validation attempt");
      await expect(
        database
          .updateTable("source_nutrient_map_revision")
          .set({ change_reason: "Rewrite old review" })
          .where("id", "=", initialMapping.current_revision_id)
          .execute(),
      ).rejects.toThrow("immutable row");

      const secondBatch = await stageBatch(
        database,
        batchInput(sourceCode, "release-2", rightsSha, "e".repeat(64)),
      );
      await stageBatchRecords(database, secondBatch.batchId, [
        recordInput(foodPayload(sourceCode, "release-2", "food-1", "Oats, updated", "13"), 0),
      ]);
      await recordBatchParserReport(database, {
        batchId: secondBatch.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        report: { adapter: "integration", release: "release-2" },
        sourceNutrientCount: 1,
        sourcePortionCount: 0,
        sourceRecordCount: 1,
      });
      const secondSummary = await validateBatch(database, secondBatch.batchId, policy);
      await approveAll(database, secondBatch.batchId, secondSummary.validationDigest, rightsSha);
      const secondPromotion = await promoteBatch(database, {
        batchId: secondBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      expect(secondPromotion.previousReleaseId).toBe(firstPromotion.activatedReleaseId);
      const secondAmount = await database
        .selectFrom("food")
        .innerJoin("food_version", "food_version.id", "food.current_version_id")
        .innerJoin("food_nutrient_value", "food_nutrient_value.food_version_id", "food_version.id")
        .select([
          "food_nutrient_value.amount",
          "food_nutrient_value.derivation_code",
          "food_nutrient_value.metadata",
        ])
        .where("food.food_source_id", "=", source.id)
        .where("food.source_food_key", "=", "food-1")
        .executeTakeFirstOrThrow();
      expect(secondAmount.amount).toBe("26.000000000000");
      expect(secondAmount).toMatchObject({
        derivation_code: "analytical",
        metadata: { dataPoints: 5, derivationCode: "analytical" },
      });

      const removedAfterSecond = await database
        .selectFrom("food")
        .select(["archived_at", "current_version_id"])
        .where("food_source_id", "=", source.id)
        .where("source_food_key", "=", "food-removed")
        .executeTakeFirstOrThrow();
      expect(removedAfterSecond.current_version_id).toBeNull();
      expect(removedAfterSecond.archived_at).not.toBeNull();

      await rollbackSourceRelease(database, {
        performedBy: "principal:release-manager",
        reason: "Integration rollback",
        sourceCode,
        targetReleaseId: firstPromotion.activatedReleaseId,
      });
      const restored = await database
        .selectFrom("food")
        .select(["archived_at", "current_version_id"])
        .where("food_source_id", "=", source.id)
        .where("source_food_key", "=", "food-removed")
        .executeTakeFirstOrThrow();
      expect(restored.current_version_id).not.toBeNull();
      expect(restored.archived_at).toBeNull();
      expect(await readSnapshotAmount(database, snapshot.diaryEntryId)).toBe("12.500000000000");

      await expect(
        database
          .updateTable("food_version")
          .set({ name: "Rewritten history" })
          .where("id", "=", firstVersion.version_id)
          .execute(),
      ).rejects.toThrow("immutable row");
      await expect(
        database
          .deleteFrom("food_nutrient_value")
          .where("food_version_id", "=", firstVersion.version_id)
          .execute(),
      ).rejects.toThrow("imported food-version child");
      await expect(
        database
          .deleteFrom("food_serving")
          .where("food_version_id", "=", firstVersion.version_id)
          .execute(),
      ).rejects.toThrow("imported food-version child");
      await expect(
        database
          .updateTable("diary_entry_nutrient_snapshot")
          .set({ amount: "99" })
          .where("diary_entry_id", "=", snapshot.diaryEntryId)
          .execute(),
      ).rejects.toThrow("immutable row");
      await expect(
        database
          .deleteFrom("diary_entry_nutrient_snapshot")
          .where("diary_entry_id", "=", snapshot.diaryEntryId)
          .execute(),
      ).rejects.toThrow("immutable diary snapshot");

      const otherCode = `OT${suffix}`;
      await cloneSource(database, otherCode);
      await expect(
        rollbackSourceRelease(database, {
          performedBy: "principal:release-manager",
          reason: "Wrong owner must fail",
          sourceCode: otherCode,
          targetReleaseId: firstPromotion.activatedReleaseId,
        }),
      ).rejects.toThrow("does not belong");

      await database
        .updateTable("food_source")
        .set({ active: false, commercial_use_allowed: false, rights_review_status: "blocked" })
        .where("id", "=", source.id)
        .execute();
      await expect(
        rollbackSourceRelease(database, {
          performedBy: "principal:release-manager",
          reason: "Inactive source cannot reactivate a release",
          sourceCode,
          targetReleaseId: secondPromotion.activatedReleaseId,
        }),
      ).rejects.toThrow("disabled");
      await rollbackSourceRelease(database, {
        performedBy: "principal:release-manager",
        reason: "Emergency deactivation after rights revocation",
        sourceCode,
        targetReleaseId: null,
      });
      expect(await readSnapshotAmount(database, snapshot.diaryEntryId)).toBe("12.500000000000");
      await database.deleteFrom("diary").where("id", "=", snapshot.diaryId).execute();
      expect(
        await database
          .selectFrom("diary_entry_nutrient_snapshot")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("diary_entry_id", "=", snapshot.diaryEntryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    } finally {
      await database.destroy();
    }
  }, 30_000);
});

describeDatabase("catalogue reconciliation PostgreSQL integration", () => {
  it("reconciles semantic releases deterministically, rejects drift, and never mutates state", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const suffix = randomBytes(4).toString("hex").toUpperCase();
      const sourceCode = `RC${suffix}`;
      const rightsSha = "c".repeat(64);
      const parserBuildSha256 = "3".repeat(64);
      const sourceId = await registerFoodSourceFromReviewedManifest(database, {
        attributionRequired: true,
        attributionText: "Reconciliation integration source",
        code: sourceCode,
        commercialUseAllowed: true,
        databaseRightsNotes: "Synthetic reconciliation fixture",
        displayName: `Reconciliation source ${suffix}`,
        homepageUrl: "https://example.invalid/reconciliation",
        kind: "government",
        licenseExpression: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistributionAllowed: true,
        rightsReviewStatus: "approved",
        rightsReviewedAt: "2026-08-20T12:00:00Z",
        rightsReviewedBy: "principal:legal-review",
      });
      await registerSourceNutrientMappings(database, {
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "g",
          },
          {
            canonicalNutrient: {
              code: "fat",
              dimension: "mass",
              name: "Total fat",
              unit: "g",
            },
            sourceName: "Total fat",
            sourceNutrientKey: "1004",
            sourceUnit: "g",
          },
          {
            canonicalNutrient: {
              code: "carbohydrate",
              dimension: "mass",
              name: "Carbohydrate",
              unit: "g",
            },
            sourceName: "Carbohydrate",
            sourceNutrientKey: "1005",
            sourceUnit: "g",
          },
        ],
        reviewedAt: "2026-08-20T12:05:00Z",
        reviewedBy: "principal:nutrition-review",
        sourceCode,
      });
      const firstMappingDigest = await getSourceNutrientMappingDigest(database, sourceCode);
      const frozenMappingRevisionIds = (
        await database
          .selectFrom("source_nutrient_map")
          .select("current_revision_id")
          .where("food_source_id", "=", sourceId)
          .execute()
      )
        .map((row) => row.current_revision_id)
        .sort();
      expect(frozenMappingRevisionIds).toHaveLength(3);
      const firstParserVersion = pinnedParserVersion(parserBuildSha256, firstMappingDigest);
      const firstBatch = await stageBatch(
        database,
        batchInput(sourceCode, "reconciliation-1", rightsSha, "4".repeat(64), firstParserVersion),
      );
      const firstPayloads = [
        withNutrient(
          foodPayload(sourceCode, "reconciliation-1", "stable", "Stable oats", "12.5", true),
          {
            canonicalNutrientId: "fat",
            canonicalUnit: "g",
            originalUnit: "g",
            provenance: { dataPoints: 5, derivationCode: "analytical" },
            sourceName: "Total fat",
            sourceNutrientId: "1004",
            value: { amount: "-0.1", quality: "measured", state: "known" },
          },
        ),
        foodPayload(sourceCode, "reconciliation-1", "changed", "Beans", "8"),
        foodPayload(sourceCode, "reconciliation-1", "removed", "Barley", "10"),
      ];
      await stageBatchRecords(
        database,
        firstBatch.batchId,
        firstPayloads.map((payload, index) => recordInput(payload, index)),
      );
      await recordReconciliationParserReport(database, {
        artifactSha256: "4".repeat(64),
        batchId: firstBatch.batchId,
        emittedNutrientCount: 4,
        emittedPortionCount: 1,
        emittedRecordCount: 3,
        nutrientMappingDigest: firstMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-1",
        sourceCode,
      });
      const firstSummary = await validateBatch(database, firstBatch.batchId, {
        maximumExcludedNutrientFraction: 0.25,
      });
      expect(
        firstSummary.records.find((record) => record.sourceRecordKey.endsWith(":stable"))?.issues,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "NUTRIENT_NEGATIVE_AMOUNT",
            disposition: "exclude_nutrient",
          }),
        ]),
      );
      const firstBefore = await reconciliationMutationSnapshot(
        database,
        sourceId,
        firstBatch.batchId,
      );
      const firstDocument = await reconcileCatalogueBatch(database, {
        batchId: firstBatch.batchId,
        expectedCurrentReleaseId: null,
        expectedValidationDigest: firstSummary.validationDigest,
      });
      const firstReplay = await reconcileCatalogueBatch(database, {
        batchId: firstBatch.batchId,
        expectedCurrentReleaseId: null,
        expectedValidationDigest: firstSummary.validationDigest,
      });
      verifyCatalogueReconciliationDocument(firstDocument);
      expect(canonicalJson(firstReplay)).toBe(canonicalJson(firstDocument));
      expect(firstDocument.evidence.counts).toMatchObject({
        addedRecords: "3",
        baselineRecords: "0",
        candidateRecords: "3",
        changedRecords: "0",
        removedRecords: "0",
        unchangedRecords: "0",
      });
      expect(await reconciliationMutationSnapshot(database, sourceId, firstBatch.batchId)).toEqual(
        firstBefore,
      );

      await approveAll(database, firstBatch.batchId, firstSummary.validationDigest, rightsSha);
      const firstPromotion = await promoteBatch(database, {
        batchId: firstBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      const frozenRelease = await database
        .selectFrom("food_source_release")
        .select("validation_summary")
        .where("id", "=", firstPromotion.activatedReleaseId)
        .executeTakeFirstOrThrow();
      expect((frozenRelease.validation_summary as JsonObject).nutrientMappingRevisionIds).toEqual(
        frozenMappingRevisionIds,
      );
      const secondBatch = await stageBatch(
        database,
        batchInput(sourceCode, "reconciliation-2", rightsSha, "5".repeat(64), firstParserVersion),
      );
      const secondPayloads = [
        foodPayload(sourceCode, "reconciliation-2", "stable", "Stable oats", "12.5", true),
        foodPayload(sourceCode, "reconciliation-2", "changed", "Beans, updated", "9", true),
        foodPayload(sourceCode, "reconciliation-2", "added", "Lentils", "11"),
      ];
      await stageBatchRecords(
        database,
        secondBatch.batchId,
        secondPayloads.map((payload, index) => recordInput(payload, index)),
      );
      await recordReconciliationParserReport(database, {
        artifactSha256: "5".repeat(64),
        batchId: secondBatch.batchId,
        emittedNutrientCount: 3,
        emittedPortionCount: 2,
        emittedRecordCount: 3,
        nutrientMappingDigest: firstMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-2",
        sourceCode,
      });
      const secondSummary = await validateBatch(database, secondBatch.batchId);
      const secondBefore = await reconciliationMutationSnapshot(
        database,
        sourceId,
        secondBatch.batchId,
      );
      const secondDocument = await reconcileCatalogueBatch(database, {
        batchId: secondBatch.batchId,
        expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
        expectedValidationDigest: secondSummary.validationDigest,
      });
      const secondReplay = await reconcileCatalogueBatch(database, {
        batchId: secondBatch.batchId,
        expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
        expectedValidationDigest: secondSummary.validationDigest,
      });
      verifyCatalogueReconciliationDocument(secondDocument);
      expect(canonicalJson(secondReplay)).toBe(canonicalJson(secondDocument));
      expect(secondDocument.evidence.counts).toMatchObject({
        addedRecords: "1",
        baselineRecords: "3",
        candidateRecords: "3",
        changedRecords: "1",
        removedRecords: "1",
        unchangedRecords: "1",
      });
      expect(secondDocument.evidence.records).toMatchObject({ unchangedCount: "1" });
      expect(await reconciliationMutationSnapshot(database, sourceId, secondBatch.batchId)).toEqual(
        secondBefore,
      );
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: secondBatch.batchId,
          expectedCurrentReleaseId: null,
          expectedValidationDigest: secondSummary.validationDigest,
        }),
      ).rejects.toThrow("Current release pointer changed");
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: secondBatch.batchId,
          expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
          expectedValidationDigest: "f".repeat(64),
        }),
      ).rejects.toThrow("validation digest");

      const currentMapping = await database
        .selectFrom("source_nutrient_map")
        .select("current_revision_id")
        .where("food_source_id", "=", sourceId)
        .where("source_nutrient_key", "=", "1004")
        .executeTakeFirstOrThrow();
      await supersedeSourceNutrientMapping(database, {
        changeReason: "Exercise frozen excluded-nutrient registry reconstruction",
        expectedCurrentRevisionId: currentMapping.current_revision_id,
        mapping: {
          canonicalNutrient: {
            code: "fat",
            dimension: "mass",
            name: "Total fat",
            unit: "g",
          },
          conversionMultiplier: "2",
          sourceName: "Total fat",
          sourceNutrientKey: "1004",
          sourceUnit: "g",
        },
        reviewedAt: "2026-08-21T12:05:00Z",
        reviewedBy: "principal:nutrition-review-2",
        sourceCode,
      });
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: secondBatch.batchId,
          expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
          expectedValidationDigest: secondSummary.validationDigest,
        }),
      ).rejects.toThrow("Source nutrient mappings changed after this validation attempt");

      const currentMappingDigest = await getSourceNutrientMappingDigest(database, sourceCode);
      const currentParserVersion = pinnedParserVersion(parserBuildSha256, currentMappingDigest);
      const parserDriftBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-parser-drift",
          rightsSha,
          "6".repeat(64),
          currentParserVersion,
        ),
      );
      const parserDriftPayload = foodPayload(
        sourceCode,
        "reconciliation-parser-drift",
        "parser-drift",
        "Parser drift",
        "6",
      );
      await stageBatchRecords(database, parserDriftBatch.batchId, [
        recordInput(parserDriftPayload, 0),
      ]);
      const parserDriftReport = reconciliationParserReport({
        artifactSha256: "6".repeat(64),
        nutrientMappingDigest: currentMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-parser-drift",
        sourceCode,
      });
      await database
        .insertInto("food_import_parser_report")
        .values({
          batch_id: parserDriftBatch.batchId,
          emitted_nutrient_count: 1,
          emitted_portion_count: 0,
          emitted_record_count: 1,
          excluded_nutrient_count: 0,
          excluded_portion_count: 0,
          excluded_record_count: 0,
          report: parserDriftReport,
          report_sha256: "e".repeat(64),
          source_nutrient_count: 1,
          source_portion_count: 0,
          source_record_count: 1,
        })
        .execute();
      const parserDriftSummary = await validateBatch(database, parserDriftBatch.batchId);
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: parserDriftBatch.batchId,
          expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
          expectedValidationDigest: parserDriftSummary.validationDigest,
        }),
      ).rejects.toThrow("Parser report digest");

      const payloadDriftBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-payload-drift",
          rightsSha,
          "7".repeat(64),
          currentParserVersion,
        ),
      );
      const validPayload = foodPayload(
        sourceCode,
        "reconciliation-payload-drift",
        "payload-valid",
        "Payload valid",
        "7",
      );
      const corruptPayload = foodPayload(
        sourceCode,
        "reconciliation-payload-drift",
        "payload-corrupt",
        "Payload corrupt",
        "8",
      );
      await stageBatchRecords(database, payloadDriftBatch.batchId, [recordInput(validPayload, 0)]);
      await database
        .insertInto("food_import_record")
        .values({
          batch_id: payloadDriftBatch.batchId,
          canonical_payload: corruptPayload,
          canonical_payload_sha256: "0".repeat(64),
          sequence_number: 1,
          source_payload_sha256: String(corruptPayload.sourcePayloadHash),
          source_record_key: String(corruptPayload.idempotencyKey),
          source_record_type: "Foundation",
        })
        .execute();
      await recordReconciliationParserReport(database, {
        artifactSha256: "7".repeat(64),
        batchId: payloadDriftBatch.batchId,
        emittedNutrientCount: 2,
        emittedPortionCount: 0,
        emittedRecordCount: 2,
        nutrientMappingDigest: currentMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-payload-drift",
        sourceCode,
      });
      const payloadDriftSummary = await validateBatch(database, payloadDriftBatch.batchId, {
        maximumQuarantineFraction: 0.5,
        maximumQuarantinedRecords: 1,
      });
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: payloadDriftBatch.batchId,
          expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
          expectedValidationDigest: payloadDriftSummary.validationDigest,
        }),
      ).rejects.toThrow("canonical payload digest");

      const cleanBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-baseline-drift",
          rightsSha,
          "8".repeat(64),
          currentParserVersion,
        ),
      );
      const cleanPayload = foodPayload(
        sourceCode,
        "reconciliation-baseline-drift",
        "baseline-drift-candidate",
        "Baseline drift candidate",
        "9",
      );
      await stageBatchRecords(database, cleanBatch.batchId, [recordInput(cleanPayload, 0)]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "8".repeat(64),
        batchId: cleanBatch.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        nutrientMappingDigest: currentMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-baseline-drift",
        sourceCode,
      });
      const cleanSummary = await validateBatch(database, cleanBatch.batchId);
      const mappingTransitionDocument = await reconcileCatalogueBatch(database, {
        batchId: cleanBatch.batchId,
        expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
        expectedValidationDigest: cleanSummary.validationDigest,
      });
      verifyCatalogueReconciliationDocument(mappingTransitionDocument);
      expect(mappingTransitionDocument.evidence.mappings).toMatchObject({
        baselineDigest: firstMappingDigest,
        candidateDigest: currentMappingDigest,
        digestChanged: true,
        transitionScope: "materialized-observations-only",
        transitions: [],
      });
      expect(mappingTransitionDocument.evidence.counts).toMatchObject({
        addedRecords: "1",
        baselineRecords: "3",
        candidateRecords: "1",
        removedRecords: "3",
      });
      const duplicateBaseline = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-duplicate-baseline",
          rightsSha,
          "9".repeat(64),
          currentParserVersion,
        ),
      );
      const duplicatePayload = foodPayload(
        sourceCode,
        "reconciliation-duplicate-baseline",
        "duplicate-baseline",
        "Duplicate baseline",
        "9",
      );
      await stageBatchRecords(database, duplicateBaseline.batchId, [
        recordInput(duplicatePayload, 0),
      ]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "9".repeat(64),
        batchId: duplicateBaseline.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        nutrientMappingDigest: currentMappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-duplicate-baseline",
        sourceCode,
      });
      await validateBatch(database, duplicateBaseline.batchId);
      await database
        .updateTable("food_import_batch")
        .set({ release_id: firstPromotion.activatedReleaseId, status: "promoting" })
        .where("id", "=", duplicateBaseline.batchId)
        .execute();
      await database
        .updateTable("food_import_batch")
        .set({ completed_at: new Date(), status: "completed" })
        .where("id", "=", duplicateBaseline.batchId)
        .execute();
      await expect(
        reconcileCatalogueBatch(database, {
          batchId: cleanBatch.batchId,
          expectedCurrentReleaseId: firstPromotion.activatedReleaseId,
          expectedValidationDigest: cleanSummary.validationDigest,
        }),
      ).rejects.toThrow("exactly one provenance-linked import batch");
    } finally {
      await database.destroy();
    }
  }, 30_000);

  it("reconciles against a valid promoted release with zero materialized foods", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const database = createDatabase({ connectionString: databaseUrl, maxConnections: 4 });
    try {
      await runMigrations(database);
      const suffix = randomBytes(4).toString("hex").toUpperCase();
      const sourceCode = `RE${suffix}`;
      const rightsSha = "d".repeat(64);
      const parserBuildSha256 = "4".repeat(64);
      const sourceId = await registerFoodSourceFromReviewedManifest(database, {
        attributionRequired: true,
        attributionText: "Empty-baseline reconciliation source",
        code: sourceCode,
        commercialUseAllowed: true,
        databaseRightsNotes: "Synthetic empty-baseline fixture",
        displayName: `Empty-baseline source ${suffix}`,
        homepageUrl: "https://example.invalid/empty-baseline",
        kind: "government",
        licenseExpression: "CC0-1.0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistributionAllowed: true,
        rightsReviewStatus: "approved",
        rightsReviewedAt: "2026-08-22T12:00:00Z",
        rightsReviewedBy: "principal:legal-review",
      });
      await registerSourceNutrientMappings(database, {
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "g",
          },
        ],
        reviewedAt: "2026-08-22T12:05:00Z",
        reviewedBy: "principal:nutrition-review",
        sourceCode,
      });
      const mappingDigest = await getSourceNutrientMappingDigest(database, sourceCode);
      const parserVersion = pinnedParserVersion(parserBuildSha256, mappingDigest);
      const emptyBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-empty-baseline",
          rightsSha,
          "a".repeat(64),
          parserVersion,
        ),
      );
      await recordReconciliationParserReport(database, {
        artifactSha256: "a".repeat(64),
        batchId: emptyBatch.batchId,
        emittedNutrientCount: 0,
        emittedPortionCount: 0,
        emittedRecordCount: 0,
        nutrientMappingDigest: mappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-empty-baseline",
        sourceCode,
      });
      const emptySummary = await validateBatch(database, emptyBatch.batchId, {
        maximumExcludedNutrientFraction: 1,
        maximumQuarantineFraction: 1,
        maximumQuarantinedRecords: 0,
        requireAtLeastOneValidRecord: false,
        requireDistinctApprovalPrincipals: true,
        requireMaterializedNutrientPerValidRecord: true,
      });
      expect(emptySummary).toMatchObject({
        promotionEligible: true,
        stagedCount: 0,
        validCount: 0,
      });
      await approveAll(database, emptyBatch.batchId, emptySummary.validationDigest, rightsSha);
      const emptyPromotion = await promoteBatch(database, {
        batchId: emptyBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      expect(emptyPromotion).toMatchObject({ materializedCount: 0, previousReleaseId: null });

      const candidateBatch = await stageBatch(
        database,
        batchInput(
          sourceCode,
          "reconciliation-after-empty",
          rightsSha,
          "b".repeat(64),
          parserVersion,
        ),
      );
      const candidatePayload = foodPayload(
        sourceCode,
        "reconciliation-after-empty",
        "first-food",
        "First food after empty release",
        "10",
      );
      await stageBatchRecords(database, candidateBatch.batchId, [recordInput(candidatePayload, 0)]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "b".repeat(64),
        batchId: candidateBatch.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        nutrientMappingDigest: mappingDigest,
        parserBuildSha256,
        releaseKey: "reconciliation-after-empty",
        sourceCode,
      });
      const candidateSummary = await validateBatch(database, candidateBatch.batchId);
      const before = await reconciliationMutationSnapshot(
        database,
        sourceId,
        candidateBatch.batchId,
      );
      const document = await reconcileCatalogueBatch(database, {
        batchId: candidateBatch.batchId,
        expectedCurrentReleaseId: emptyPromotion.activatedReleaseId,
        expectedValidationDigest: candidateSummary.validationDigest,
      });
      verifyCatalogueReconciliationDocument(document);
      expect(document.evidence.baseline).toMatchObject({
        releaseId: emptyPromotion.activatedReleaseId,
        releaseKey: "reconciliation-empty-baseline",
      });
      expect(document.evidence.counts).toMatchObject({
        addedRecords: "1",
        baselineRecords: "0",
        candidateRecords: "1",
        removedRecords: "0",
      });
      expect(
        await reconciliationMutationSnapshot(database, sourceId, candidateBatch.batchId),
      ).toEqual(before);
    } finally {
      await database.destroy();
    }
  }, 30_000);

  it("reports cross-source GTIN conflicts and freezes excluded baseline barcode evidence", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const capturedQueries: { readonly parameters: readonly unknown[]; readonly sql: string }[] = [];
    const database = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 4 }) }),
      log(event) {
        if (event.level === "query") {
          capturedQueries.push({ parameters: event.query.parameters, sql: event.query.sql });
        }
      },
    });
    try {
      await runMigrations(database);
      const suffix = randomBytes(4).toString("hex").toUpperCase();
      const ownerCode = `GO${suffix}`;
      const targetCode = `GT${suffix}`;
      const rightsSha = "e".repeat(64);
      const parserBuildSha256 = "5".repeat(64);
      const sharedGtin = gtin14FromHexSuffix(suffix);
      const quarantinedGtin = gtin14FromHexSuffix(
        (BigInt(`0x${suffix}`) ^ 1n).toString(16).padStart(8, "0").toUpperCase(),
      );
      const unrelatedGtin = gtin14FromHexSuffix(
        (BigInt(`0x${suffix}`) ^ 2n).toString(16).padStart(8, "0").toUpperCase(),
      );
      for (const sourceCode of [ownerCode, targetCode]) {
        await cloneSource(database, sourceCode);
        await registerSourceNutrientMappings(database, {
          mappings: [
            {
              canonicalNutrient: {
                code: "protein",
                dimension: "mass",
                name: "Protein",
                unit: "g",
              },
              sourceName: "Protein",
              sourceNutrientKey: "1003",
              sourceUnit: "g",
            },
          ],
          reviewedAt: "2026-08-23T12:05:00Z",
          reviewedBy: "principal:nutrition-review",
          sourceCode,
        });
      }

      const ownerMappingDigest = await getSourceNutrientMappingDigest(database, ownerCode);
      const ownerParserVersion = pinnedParserVersion(parserBuildSha256, ownerMappingDigest);
      const ownerBatch = await stageBatch(
        database,
        batchInput(ownerCode, "gtin-owner-1", rightsSha, "1".repeat(64), ownerParserVersion),
      );
      const ownerPayload = withGtin(
        foodPayload(ownerCode, "gtin-owner-1", "owner-food", "GTIN owner", "10"),
        sharedGtin,
      );
      const quarantinedGtinOwnerPayload = withGtin(
        foodPayload(
          ownerCode,
          "gtin-owner-1",
          "quarantined-gtin-owner",
          "Quarantined GTIN owner",
          "11",
        ),
        quarantinedGtin,
      );
      const unrelatedOwnerPayload = withGtin(
        foodPayload(ownerCode, "gtin-owner-1", "unrelated-owner", "Unrelated GTIN owner", "12"),
        unrelatedGtin,
      );
      await stageBatchRecords(database, ownerBatch.batchId, [
        recordInput(ownerPayload, 0),
        recordInput(quarantinedGtinOwnerPayload, 1),
        recordInput(unrelatedOwnerPayload, 2),
      ]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "1".repeat(64),
        batchId: ownerBatch.batchId,
        emittedNutrientCount: 3,
        emittedPortionCount: 0,
        emittedRecordCount: 3,
        nutrientMappingDigest: ownerMappingDigest,
        parserBuildSha256,
        releaseKey: "gtin-owner-1",
        sourceCode: ownerCode,
      });
      const ownerSummary = await validateBatch(database, ownerBatch.batchId);
      await approveAll(database, ownerBatch.batchId, ownerSummary.validationDigest, rightsSha);
      const ownerPromotion = await promoteBatch(database, {
        batchId: ownerBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      expect(await activeBarcodeCountForSource(database, ownerCode)).toBe("3");

      const indexDefinition = await sql<{ indexdef: string }>`
        select indexdef
        from pg_indexes
        where schemaname = 'public'
          and indexname = 'food_barcode_active_release_version_idx'
      `.execute(database);
      expect(indexDefinition.rows[0]?.indexdef.replace(/\s+/g, " ")).toContain(
        "(source_release_id, food_version_id) INCLUDE (gtin, market_code) WHERE ((valid_to IS NULL) AND (source_release_id IS NOT NULL))",
      );
      const baselinePlan = await database.transaction().execute(async (transaction) => {
        await sql`set local enable_seqscan = off`.execute(transaction);
        return sql<{ "QUERY PLAN": unknown }>`
          explain (format json, costs off)
          select food_version_id, gtin, market_code
          from food_barcode
          where source_release_id = ${ownerPromotion.activatedReleaseId}
            and valid_to is null
          order by food_version_id, market_code, gtin
        `.execute(transaction);
      });
      expect(JSON.stringify(baselinePlan.rows)).toContain(
        "food_barcode_active_release_version_idx",
      );

      const targetMappingDigest = await getSourceNutrientMappingDigest(database, targetCode);
      const targetParserVersion = pinnedParserVersion(parserBuildSha256, targetMappingDigest);
      const targetReleaseKey = "gtin-target-1";
      const targetBatch = await stageBatch(
        database,
        batchInput(targetCode, targetReleaseKey, rightsSha, "2".repeat(64), targetParserVersion),
      );
      const targetPayload = withGtin(
        foodPayload(targetCode, targetReleaseKey, "target-food", "Target food", "12"),
        sharedGtin,
      );
      const quarantinedPayload = withGtin(
        foodPayload(
          targetCode,
          "gtin-target-wrong-release",
          "quarantined",
          "Quarantined conflicting food",
          "13",
        ),
        quarantinedGtin,
      );
      const quarantinedRecordKey = String(quarantinedPayload.idempotencyKey);
      await stageBatchRecords(database, targetBatch.batchId, [
        recordInput(targetPayload, 0),
        recordInput(quarantinedPayload, 1),
      ]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "2".repeat(64),
        batchId: targetBatch.batchId,
        emittedNutrientCount: 2,
        emittedPortionCount: 0,
        emittedRecordCount: 2,
        nutrientMappingDigest: targetMappingDigest,
        parserBuildSha256,
        releaseKey: targetReleaseKey,
        sourceCode: targetCode,
      });
      const targetSummary = await validateBatch(database, targetBatch.batchId, {
        maximumExcludedNutrientFraction: 0,
        maximumQuarantineFraction: 0.5,
        maximumQuarantinedRecords: 1,
        requireAtLeastOneValidRecord: true,
        requireDistinctApprovalPrincipals: true,
        requireMaterializedNutrientPerValidRecord: true,
      });
      expect(targetSummary).toMatchObject({
        promotionEligible: true,
        quarantinedCount: 1,
        stagedCount: 2,
        validCount: 1,
      });
      expect(
        targetSummary.records.find((record) => record.sourceRecordKey.endsWith(":target-food"))
          ?.issues,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "BARCODE_CROSS_SOURCE_CONFLICT",
            disposition: "exclude_barcode",
          }),
        ]),
      );
      expect(
        targetSummary.records.find((record) => record.sourceRecordKey.endsWith(":quarantined")),
      ).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "BARCODE_CROSS_SOURCE_CONFLICT" }),
          expect.objectContaining({ code: "SOURCE_PROVENANCE_MISMATCH", severity: "error" }),
        ]),
        status: "quarantined",
      });
      capturedQueries.length = 0;
      const conflictDocument = await reconcileCatalogueBatch(database, {
        batchId: targetBatch.batchId,
        expectedCurrentReleaseId: null,
        expectedValidationDigest: targetSummary.validationDigest,
      });
      const targetedQueries = capturedQueries.filter((query) => query.sql.includes("from unnest("));
      expect(targetedQueries).toHaveLength(1);
      const targetedParameters = targetedQueries[0]?.parameters;
      if (
        !targetedParameters ||
        JSON.stringify(targetedParameters[0]) !==
          JSON.stringify([sharedGtin, quarantinedGtin].sort()) ||
        JSON.stringify(targetedParameters[1]) !== JSON.stringify(["US", "US"]) ||
        (targetedParameters[0] as readonly unknown[]).includes(unrelatedGtin)
      ) {
        throw new Error(
          "Targeted GTIN conflict query parameters do not match candidate identities",
        );
      }
      verifyCatalogueReconciliationDocument(conflictDocument);
      expect(conflictDocument.evidence.barcodes).toMatchObject({
        markets: [
          {
            assignmentCount: "1",
            collisionAssignmentCount: "1",
            collisionRate: { denominator: "1", numerator: "1" },
            crossSourceConflictCount: "1",
            marketCode: "US",
            withinCandidateCollisionAssignmentCount: "0",
          },
        ],
        rejectedCandidate: [
          {
            marketCode: "US",
            normalizedGtin: sharedGtin,
            rawValue: sharedGtin,
            reasonCode: "BARCODE_CROSS_SOURCE_CONFLICT",
            sourceFoodKey: "target-food",
          },
        ],
      });
      expect(conflictDocument.evidence.counts).toMatchObject({
        candidateCrossSourceBarcodeConflicts: "1",
        candidateRejectedBarcodes: "1",
        candidateStagedQuarantined: "1",
        candidateStagedValid: "1",
      });
      expect(conflictDocument.evidence.quarantine).toMatchObject({
        records: [
          {
            canonicalPayloadSha256: sha256CanonicalJson(quarantinedPayload),
            sourceRecordKey: quarantinedRecordKey,
          },
        ],
      });

      await approveAll(database, targetBatch.batchId, targetSummary.validationDigest, rightsSha);
      const targetPromotion = await promoteBatch(database, {
        batchId: targetBatch.batchId,
        performedBy: "service:catalogue-promoter",
      });
      expect(targetPromotion).toMatchObject({ materializedCount: 1, previousReleaseId: null });
      expect(await activeBarcodeCountForSource(database, targetCode)).toBe("0");

      await database
        .updateTable("food_source")
        .set({ active: false })
        .where("code", "=", ownerCode)
        .execute();
      const ownerDeactivation = await rollbackSourceRelease(database, {
        performedBy: "principal:release-manager",
        reason: "Deactivate the synthetic conflicting source",
        sourceCode: ownerCode,
        targetReleaseId: null,
      });
      expect(ownerDeactivation).toMatchObject({
        activeReleaseId: null,
        changed: true,
        previousReleaseId: ownerPromotion.activatedReleaseId,
      });
      expect(await activeBarcodeCountForSource(database, ownerCode)).toBe("0");

      const laterReleaseKey = "gtin-target-2";
      const laterBatch = await stageBatch(
        database,
        batchInput(targetCode, laterReleaseKey, rightsSha, "3".repeat(64), targetParserVersion),
      );
      const laterPayload = withGtin(
        foodPayload(targetCode, laterReleaseKey, "target-food", "Target food", "12"),
        sharedGtin,
      );
      await stageBatchRecords(database, laterBatch.batchId, [recordInput(laterPayload, 0)]);
      await recordReconciliationParserReport(database, {
        artifactSha256: "3".repeat(64),
        batchId: laterBatch.batchId,
        emittedNutrientCount: 1,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        nutrientMappingDigest: targetMappingDigest,
        parserBuildSha256,
        releaseKey: laterReleaseKey,
        sourceCode: targetCode,
      });
      const laterSummary = await validateBatch(database, laterBatch.batchId);
      const laterDocument = await reconcileCatalogueBatch(database, {
        batchId: laterBatch.batchId,
        expectedCurrentReleaseId: targetPromotion.activatedReleaseId,
        expectedValidationDigest: laterSummary.validationDigest,
      });
      verifyCatalogueReconciliationDocument(laterDocument);
      expect(laterDocument.evidence.baseline).toMatchObject({
        recordSetSha256: (conflictDocument.evidence.candidate as JsonObject).recordSetSha256,
        releaseId: targetPromotion.activatedReleaseId,
      });
      expect(laterDocument.evidence.counts).toMatchObject({
        baselineRecords: "1",
        candidateRecords: "1",
        changedRecords: "1",
      });
      expect(laterDocument.evidence.barcodes).toMatchObject({
        added: [{ gtin: sharedGtin, marketCode: "US", sourceFoodKey: "target-food" }],
        markets: [
          {
            assignmentCount: "1",
            collisionAssignmentCount: "0",
            collisionRate: { denominator: "1", numerator: "0" },
            crossSourceConflictCount: "0",
            marketCode: "US",
          },
        ],
        rejectedCandidate: [],
      });
    } finally {
      await database.destroy();
    }
  }, 30_000);
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolvePromise?.(value),
  };
}

async function waitForApplicationLock(
  database: ReturnType<typeof createDatabase>,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await sql<{ wait_event_type: string | null }>`
      select wait_event_type
      from pg_stat_activity
      where application_name = ${applicationName}
    `.execute(database);
    if (activity.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Writer ${applicationName} did not reach a PostgreSQL lock wait`);
}

async function createCnfParserValidationFixture(
  database: Parameters<typeof recordBatchParserReport>[0],
  options: {
    readonly parserPackage?: string;
    readonly persistReport?: boolean;
    readonly reverseAcceptedSourcePayloadOrder?: boolean;
  },
): Promise<{
  readonly batchId: string;
  readonly reportInput: RecordBatchParserReportInput;
}> {
  await ensureCnfIntegrationSource(database);
  const nutrientMappingDigest = await getSourceNutrientMappingDigest(database, CNF_SOURCE_CODE);
  const parserBuildSha256 = sha256CanonicalJson({ fixture: "cnf-parser-validation" });
  const parserVersion = pinnedParserVersion(parserBuildSha256, nutrientMappingDigest);
  const releaseKey = `cnf-validation-${randomBytes(12).toString("hex")}`;
  const artifactSha256 = sha256CanonicalJson({ releaseKey });
  const rightsManifestSha256 = sha256CanonicalJson({ releaseKey, type: "rights-manifest" });
  const batch = await stageBatch(database, {
    ...batchInput(CNF_SOURCE_CODE, releaseKey, rightsManifestSha256, artifactSha256, parserVersion),
    artifactUri: `s3://catalogue/${CNF_SOURCE_CODE}/${releaseKey}.zip`,
    mediaType: "application/zip",
    upstreamSchemaVersion: "cnf-2026",
  });
  const first = recordInput(cnfFoodPayload(releaseKey, "food-1", "First CNF food"), 0);
  const second = recordInput(cnfFoodPayload(releaseKey, "food-2", "Second CNF food"), 1);

  // Insert in reverse order so the report must bind the canonical sequence order,
  // not insertion order or source-record-key ordering by accident.
  await stageBatchRecords(database, batch.batchId, [second, first]);
  const acceptedRows = [first, second].map((record) => ({
    sourcePayloadHash: record.sourcePayloadSha256,
    sourceRecordKey: record.sourceRecordKey,
  }));
  const reportedRows = options.reverseAcceptedSourcePayloadOrder
    ? [...acceptedRows].reverse()
    : acceptedRows;
  const reportInput: RecordBatchParserReportInput = {
    batchId: batch.batchId,
    emittedNutrientCount: 2,
    emittedPortionCount: 0,
    emittedRecordCount: 2,
    excludedNutrientCount: 0,
    excludedPortionCount: 0,
    excludedRecordCount: 0,
    report: cnfIntegrationParserReport({
      acceptedSourcePayloadSha256: sha256CanonicalJson(reportedRows),
      artifactSha256,
      nutrientMappingDigest,
      parserBuildSha256,
      parserPackage: options.parserPackage ?? "@nutrition-tracker/ingestion",
      releaseKey,
    }),
    sourceNutrientCount: 2,
    sourcePortionCount: 0,
    sourceRecordCount: 2,
  };
  if (options.persistReport !== false) {
    await recordBatchParserReport(database, reportInput);
  }
  return { batchId: batch.batchId, reportInput };
}

async function ensureCnfIntegrationSource(
  database: Parameters<typeof registerFoodSourceFromReviewedManifest>[0],
): Promise<void> {
  const existing = await database
    .selectFrom("food_source")
    .select("id")
    .where("code", "=", CNF_SOURCE_CODE)
    .executeTakeFirst();
  if (existing) return;
  await registerFoodSourceFromReviewedManifest(database, {
    attributionRequired: true,
    attributionText: "Synthetic Health Canada CNF integration fixture",
    code: CNF_SOURCE_CODE,
    commercialUseAllowed: true,
    databaseRightsNotes: "Test-only CNF parser-evidence fixture",
    displayName: "Health Canada CNF integration fixture",
    homepageUrl: "https://example.invalid/health-canada-cnf-integration",
    kind: "government",
    licenseExpression: "LicenseRef-Open-Government-Licence-Canada-2.0",
    licenseUrl: "https://open.canada.ca/en/open-government-licence-canada",
    redistributionAllowed: true,
    rightsReviewStatus: "approved",
    rightsReviewedAt: "2026-08-31T12:00:00Z",
    rightsReviewedBy: "principal:legal-review",
  });
}

function cnfFoodPayload(
  releaseKey: string,
  sourceRecordId: string,
  description: string,
): JsonObject {
  const payload = foodPayload(
    CNF_SOURCE_CODE,
    releaseKey,
    sourceRecordId,
    description,
    sourceRecordId === "food-1" ? "11" : "12",
  );
  return {
    ...payload,
    idempotencyKey: `${CNF_SOURCE_CODE}:${releaseKey}:Food_Name:${sourceRecordId}`,
    source: {
      ...(payload.source as JsonObject),
      marketCode: "CA",
      sourceDataType: "Food_Name",
    },
    sourcePayloadHash: sha256CanonicalJson({ releaseKey, sourceRecordId }),
  };
}

function cnfIntegrationParserReport(input: {
  readonly acceptedSourcePayloadSha256: string;
  readonly artifactSha256: string;
  readonly nutrientMappingDigest: string;
  readonly parserBuildSha256: string;
  readonly parserPackage: string;
  readonly releaseKey: string;
}): JsonObject {
  const expectedFiles = CNF_TABLE_CONTRACT.map(([archivePath]) => archivePath).sort();
  const tables = CNF_TABLE_CONTRACT.map(([archivePath, disposition, referenceOnlyReason]) => {
    const rowCount =
      archivePath === "Food_Name.csv" || archivePath === "Nutrient_Amount.csv"
        ? 2
        : archivePath === "Nutrient_Name.csv"
          ? 1
          : 0;
    const headers = ["Code"];
    return {
      archivePath,
      byteSize: 10 + rowCount,
      disposition,
      headerSha256: sha256CanonicalJson(headers),
      headers,
      rawSha256: sha256CanonicalJson({ archivePath, evidence: "raw" }),
      referenceOnlyReason,
      rowCount,
      rowsSha256: sha256CanonicalJson({ archivePath, evidence: "rows", rowCount }),
    };
  });
  const exclusionReasonCounts = {};
  const rowDispositions = {
    foodNames: [0, 1].map((sourceIndex) => ({ disposition: "emitted", sourceIndex })),
    measureWeightConversions: [],
    nutrientAmounts: [0, 1].map((sourceIndex) => ({ disposition: "emitted", sourceIndex })),
  };
  return {
    actor: {
      authenticationMethod: "oidc",
      principalId: "service:cnf-integration",
      runReference: `urn:cnf-integration:${input.releaseKey}`,
    },
    archive: {
      expectedFiles,
      inventoryCount: expectedFiles.length,
      inventorySha256: sha256CanonicalJson(expectedFiles),
    },
    artifactSha256: input.artifactSha256,
    exclusionReasonCounts,
    exclusions: { measures: [], nutrients: [], records: [], skippedMeasures: [] },
    metrics: {
      acceptedSourcePayloadSha256: input.acceptedSourcePayloadSha256,
      bilingualDescriptionCount: 0,
      emittedNutrientCount: 2,
      emittedPortionCount: 0,
      emittedRecordCount: 2,
      englishOnlyDescriptionCount: 2,
      excludedMeasureCount: 0,
      excludedNutrientCount: 0,
      exclusionReasonCountsSha256: sha256CanonicalJson(exclusionReasonCounts),
      frenchOnlyDescriptionCount: 0,
      missingBothDescriptionCount: 0,
      quarantinedRecordCount: 0,
      rowDispositionsSha256: sha256CanonicalJson(rowDispositions),
      skippedMeasureCount: 0,
      sourceNutrientCount: 2,
      sourcePortionCount: 0,
      sourceRecordCount: 2,
      tableEvidenceSha256: sha256CanonicalJson(tables),
    },
    nutrientMappingDigest: input.nutrientMappingDigest,
    parserBuildSha256: input.parserBuildSha256,
    parserPackage: input.parserPackage,
    parserVersion: "integration-parser@1.0.0",
    releaseKey: input.releaseKey,
    reportKind: "health-canada-cnf-stage-v1",
    rowDispositions,
    schemaVersion: 1,
    sourceCode: CNF_SOURCE_CODE,
    tables,
  };
}

async function cnfValidationFreezeSnapshot(
  database: Parameters<typeof validateBatch>[0],
  batchId: string,
): Promise<unknown> {
  const [batch, records] = await Promise.all([
    database
      .selectFrom("food_import_batch")
      .select([
        "materialized_count",
        "nutrient_excluded_count",
        "nutrient_input_count",
        "nutrient_materializable_count",
        "quarantined_count",
        "status",
        "unresolved_error_count",
        "valid_count",
        "validated_at",
        "validation_policy",
        "warning_count",
      ])
      .where("id", "=", batchId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("food_import_record")
      .select(["validation_status", "validated_at", "validation_issues"])
      .where("batch_id", "=", batchId)
      .orderBy("sequence_number")
      .execute(),
  ]);
  return { batch, records };
}

function pinnedParserVersion(parserBuildSha256: string, nutrientMappingDigest: string): string {
  return `integration-parser@1.0.0+build.${parserBuildSha256}+mapping.${nutrientMappingDigest}`;
}

function reconciliationParserReport(input: {
  readonly artifactSha256: string;
  readonly nutrientMappingDigest: string;
  readonly parserBuildSha256: string;
  readonly releaseKey: string;
  readonly sourceCode: string;
}): JsonObject {
  return {
    adapter: "integration",
    artifactSha256: input.artifactSha256,
    nutrientMappingDigest: input.nutrientMappingDigest,
    parserBuildSha256: input.parserBuildSha256,
    parserVersion: "integration-parser@1.0.0",
    releaseKey: input.releaseKey,
    schemaVersion: 1,
    sourceCode: input.sourceCode,
  };
}

async function recordReconciliationParserReport(
  database: Parameters<typeof recordBatchParserReport>[0],
  input: {
    readonly artifactSha256: string;
    readonly batchId: string;
    readonly emittedNutrientCount: number;
    readonly emittedPortionCount: number;
    readonly emittedRecordCount: number;
    readonly nutrientMappingDigest: string;
    readonly parserBuildSha256: string;
    readonly releaseKey: string;
    readonly sourceCode: string;
  },
): Promise<string> {
  return recordBatchParserReport(database, {
    batchId: input.batchId,
    emittedNutrientCount: input.emittedNutrientCount,
    emittedPortionCount: input.emittedPortionCount,
    emittedRecordCount: input.emittedRecordCount,
    excludedNutrientCount: 0,
    excludedPortionCount: 0,
    excludedRecordCount: 0,
    report: reconciliationParserReport(input),
    sourceNutrientCount: input.emittedNutrientCount,
    sourcePortionCount: input.emittedPortionCount,
    sourceRecordCount: input.emittedRecordCount,
  });
}

async function reconciliationMutationSnapshot(
  database: Parameters<typeof approveBatch>[0],
  sourceId: string,
  candidateBatchId: string,
): Promise<unknown> {
  const [source, batch, records, foods, versions, releases, activations, outbox] =
    await Promise.all([
      database
        .selectFrom("food_source")
        .selectAll()
        .where("id", "=", sourceId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("food_import_batch")
        .selectAll()
        .where("id", "=", candidateBatchId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("food_import_record")
        .selectAll()
        .where("batch_id", "=", candidateBatchId)
        .orderBy("sequence_number")
        .execute(),
      database
        .selectFrom("food")
        .selectAll()
        .where("food_source_id", "=", sourceId)
        .orderBy("source_food_key")
        .execute(),
      database
        .selectFrom("food_version as version")
        .innerJoin("food", "food.id", "version.food_id")
        .selectAll("version")
        .where("food.food_source_id", "=", sourceId)
        .orderBy("version.id")
        .execute(),
      database
        .selectFrom("food_source_release")
        .selectAll()
        .where("food_source_id", "=", sourceId)
        .orderBy("created_at")
        .execute(),
      database
        .selectFrom("food_source_release_activation")
        .selectAll()
        .where("food_source_id", "=", sourceId)
        .orderBy("id")
        .execute(),
      database
        .selectFrom("outbox_event")
        .selectAll()
        .where("aggregate_type", "=", "food_source")
        .where("aggregate_id", "=", sourceId)
        .orderBy("id")
        .execute(),
    ]);
  return JSON.parse(
    JSON.stringify({ activations, batch, foods, outbox, records, releases, source, versions }),
  );
}

function batchInput(
  sourceCode: string,
  releaseKey: string,
  rightsManifestSha256: string,
  artifactSha256 = "b".repeat(64),
  parserVersion = "integration-parser@1.0.0",
) {
  return {
    acquiredAt: `2026-08-${releaseKey.endsWith("1") ? "15" : "16"}T12:00:00Z`,
    artifactBytes: 1_024,
    artifactSha256,
    artifactUri: `s3://catalogue/${sourceCode}/${releaseKey}.json`,
    mediaType: "application/json",
    parserVersion,
    publishedOn: "2026-08-15",
    releaseKey,
    rightsManifestSha256,
    rightsManifestUri: `repo://manifests/${sourceCode}.json`,
    sourceCode,
    upstreamSchemaVersion: "integration-v1",
  } as const;
}

function foodPayload(
  sourceCode: string,
  releaseKey: string,
  sourceRecordId: string,
  description: string,
  protein: string,
  includeServing = false,
): JsonObject {
  const idempotencyKey = `${sourceCode}:${releaseKey}:Foundation:${sourceRecordId}`;
  return {
    basis: { amount: "100", unit: "g" },
    idempotencyKey,
    identity: { brandOwner: null, description, descriptionFr: null, gtin: null },
    nutrients: [
      {
        canonicalNutrientId: "protein",
        canonicalUnit: "g",
        originalUnit: "g",
        provenance: { dataPoints: 5, derivationCode: "analytical" },
        sourceName: "Protein",
        sourceNutrientId: "1003",
        value: { amount: protein, quality: "measured", state: "known" },
      },
    ],
    schemaVersion: 1,
    servings: includeServing
      ? [
          {
            amount: "1",
            description: "1 cup",
            gramWeight: "81",
            sourceServingId: "cup-1",
            unit: "cup",
          },
        ]
      : [],
    source: {
      languageTag: "en",
      marketCode: "US",
      releaseKey,
      sourceCode,
      sourceDataType: "Foundation",
      sourceModifiedAt: "2026-08-15T00:00:00.000Z",
      sourceRecordId,
    },
    sourcePayloadHash: "a".repeat(64),
    unlistedNutrientPolicy: "unknown_not_reported",
  };
}

function withGtin(payload: JsonObject, gtin: string): JsonObject {
  return {
    ...payload,
    identity: { ...(payload.identity as JsonObject), gtin },
  };
}

function withNutrient(payload: JsonObject, nutrient: JsonObject): JsonObject {
  return {
    ...payload,
    nutrients: [...(payload.nutrients as readonly JsonObject[]), nutrient],
  };
}

function gtin14FromHexSuffix(suffix: string): string {
  const body = `9${BigInt(`0x${suffix}`).toString().padStart(12, "0")}`;
  const weightedSum = [...body].reduce(
    (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return `${body}${(10 - (weightedSum % 10)) % 10}`;
}

function recordInput(payload: JsonObject, sequenceNumber: number) {
  const source = payload.source as JsonObject;
  return {
    canonicalPayload: payload,
    canonicalPayloadSha256: sha256CanonicalJson(payload),
    sequenceNumber,
    sourcePayloadSha256: String(payload.sourcePayloadHash),
    sourceRecordKey: String(payload.idempotencyKey),
    sourceRecordType: String(source.sourceDataType),
  };
}

async function activeBarcodeCountForSource(
  database: Parameters<typeof approveBatch>[0],
  sourceCode: string,
): Promise<string> {
  const result = await database
    .selectFrom("food_barcode as barcode")
    .innerJoin("food", "food.id", "barcode.food_id")
    .innerJoin("food_source as source", "source.id", "food.food_source_id")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("source.code", "=", sourceCode)
    .where("barcode.valid_to", "is", null)
    .executeTakeFirstOrThrow();
  return result.count;
}

async function approveAll(
  database: Parameters<typeof approveBatch>[0],
  batchId: string,
  validationDigest: string,
  rightsManifestSha256: string,
) {
  for (const [approvalRole, principalId] of [
    ["data", "principal:data-review"],
    ["quality", "principal:quality-review"],
    ["rights", "principal:rights-review"],
  ] as const) {
    await approveBatch(database, {
      approvalReference: `review://${approvalRole}/${batchId}`,
      approvalRole,
      batchId,
      principalId,
      rightsManifestSha256,
      validationDigest,
    });
  }
}

async function createHistoricalSnapshot(
  database: Parameters<typeof approveBatch>[0],
  foodVersionId: string,
  suffix: string,
) {
  return database.transaction().execute(async (transaction) => {
    const user = await transaction
      .insertInto("app_user")
      .values({
        auth_subject: `integration-${suffix}`,
        deleted_at: null,
        deletion_requested_at: null,
        email: `integration-${suffix.toLowerCase()}@example.invalid`,
        email_verified_at: null,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const diary = await transaction
      .insertInto("diary")
      .values({
        local_date: "2026-08-15",
        note: null,
        revision: 0,
        status: "open",
        time_zone: "UTC",
        user_id: user.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const revisionId = randomUUID();
    const version = await transaction
      .selectFrom("food_version")
      .select(["name", "brand_name"])
      .where("id", "=", foodVersionId)
      .executeTakeFirstOrThrow();
    const entry = await transaction
      .insertInto("diary_entry")
      .values({
        client_operation_id: randomUUID(),
        current_revision_id: revisionId,
        current_revision_number: "1",
        deleted_at: null,
        diary_id: diary.id,
        entry_kind: "food",
        food_serving_id: null,
        food_version_id: foodVersionId,
        input_unit: "g",
        local_time: "12:00:00",
        meal_slot: "lunch",
        note: null,
        occurred_at: "2026-08-15T12:00:00Z",
        position: 0,
        quantity: "100",
        recipe_version_id: null,
        resolved_grams: "100",
        snapshot_engine_version: "integration@1",
        snapshot_status: "complete",
        user_id: user.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("diary_entry_revision")
      .values({
        brand_name: version.brand_name,
        diary_entry_id: entry.id,
        diary_id: diary.id,
        entry_kind: "food",
        food_name: version.name,
        food_serving_id: null,
        food_version_id: foodVersionId,
        id: revisionId,
        input_unit: "g",
        local_date: "2026-08-15",
        local_time: "12:00:00",
        meal_slot: "lunch",
        note: null,
        nutrient_component_count: 1,
        occurred_at: "2026-08-15T12:00:00Z",
        operation: "create",
        position: 0,
        quantity: "100",
        recipe_version_id: null,
        resolved_quantity: "100",
        resolved_unit: "g",
        revision_number: "1",
        serving_label: null,
        snapshot_engine_version: "integration@1",
        snapshot_status: "complete",
        time_zone: "UTC",
        user_id: user.id,
      })
      .execute();
    const protein = await transaction
      .selectFrom("nutrient")
      .select(["id", "code", "name", "canonical_unit"])
      .where("code", "=", "protein")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("diary_entry_revision_nutrient")
      .values({
        completeness: "complete",
        contributor_count: 1,
        diary_entry_revision_id: revisionId,
        is_exact: true,
        known_amount: "12.5",
        nutrient_code: protein.code,
        nutrient_id: protein.id,
        nutrient_name: protein.name,
        quantified_count: 1,
        trace_count: 0,
        unit: protein.canonical_unit,
        unknown_count: 0,
        unknown_reasons: {},
      })
      .execute();
    await transaction
      .insertInto("diary_entry_nutrient_snapshot")
      .values({
        amount: "12.5",
        calculation_version: "integration@1",
        diary_entry_id: entry.id,
        nutrient_id: protein.id,
        provenance: { foodVersionId },
        unit: "g",
      })
      .execute();
    return { diaryEntryId: entry.id, diaryId: diary.id };
  });
}

async function readSnapshotAmount(
  database: Parameters<typeof approveBatch>[0],
  diaryEntryId: string,
) {
  return (
    await database
      .selectFrom("diary_entry_nutrient_snapshot")
      .select("amount")
      .where("diary_entry_id", "=", diaryEntryId)
      .executeTakeFirstOrThrow()
  ).amount;
}

async function cloneSource(database: Parameters<typeof approveBatch>[0], code: string) {
  await database
    .insertInto("food_source")
    .values({
      access_url: null,
      active: true,
      attribution_required: false,
      attribution_text: "Other integration source",
      code,
      commercial_use_allowed: true,
      database_rights_notes: null,
      display_name: code,
      homepage_url: "https://example.invalid/other",
      kind: "government",
      license_expression: "CC0-1.0",
      license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      redistribution_allowed: true,
      rights_review_status: "approved",
      rights_reviewed_at: "2026-08-15T12:00:00Z",
      rights_reviewed_by: "principal:legal-review",
      terms_url: null,
    })
    .execute();
}
