import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  approveBatch,
  createDatabase,
  getBatchCheckpoint,
  getSourceNutrientMappingDigest,
  type JsonObject,
  previewBatchValidation,
  promoteBatch,
  recordBatchParserReport,
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
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("catalogue ingestion PostgreSQL integration", () => {
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
        cursor: { byteOffset: 42 },
        lastSequenceNumber: 2,
        processedCount: 3,
        stage: "stage",
      });
      expect(await getBatchCheckpoint(database, firstBatch.batchId, "stage")).toMatchObject({
        cursor: { byteOffset: 42 },
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
