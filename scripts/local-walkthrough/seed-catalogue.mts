/**
 * Disposable synthetic local walkthrough fixture. Never target a real catalogue.
 * Adapted from apps/api/test/retention-worker.integration.test.ts seedPromotedPublicFood.
 * Public eligibility requires synthetic "live-reviewed" rows, as in that test.
 * They simulate contracts ONLY: no rights/scientific/independent-review approval exists.
 * No SQL trigger, constraint, role, authorization or application guard is disabled.
 *
 * Root supplies a fresh sanitized environment. This helper never reads .env.
 * Required names: WALKTHROUGH_RUN_ID, WALKTHROUGH_FIXTURE_ONLY, NODE_ENV,
 * DATABASE_URL, MEILI_URL, MEILI_ADMIN_KEY, MEILI_TASK_OBSERVER_KEY,
 * MEILI_SEARCH_KEY, WALKTHROUGH_EVIDENCE_DIR.
 * NODE_ENV=development; WALKTHROUGH_FIXTURE_ONLY=yes; run ID is 8-32 lowercase alphanumerics.
 * Database must be fresh, migrated and named nourishing_walkthrough_<run ID>.
 * Three Meili keys must be scoped and distinct; master key stays with bootstrap.
 * Evidence directory must be a fresh owner-only Linux directory from run.py.
 *
 * Use run.py create to provide the isolated runtime and sanitized environment.
 * Add --validate-only for offline fixture checks (no environment or services).
 * Fixture evidence expires after 12 hours; do not silently extend it.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rebuildFoodSearchNow } from "../../apps/worker/dist/food-search-worker.js";
import { canonicalJson } from "../../packages/contracts/dist/index.js";
import {
  assertDatabaseReady,
  createDatabase,
  type JsonArray,
  pageFoodSearchProjection,
} from "../../packages/db/dist/index.js";
import { lockActiveNutrientRegistryForWrite } from "../../packages/db/dist/nutrient-registry-lock.js";
import { CORE_NUTRIENTS } from "../../packages/domain/dist/index.js";
import { MeilisearchHttpClient } from "../../packages/search/dist/index.js";

type Fixture = {
  name: string;
  serving: string;
  grams: string;
  amounts: Record<string, string | null>;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
// Invented per-100g display profiles. null means unknown, never zero.
const definitions: readonly [string, string, string, readonly (string | null)[]][] = [
  [
    "Rolled oats",
    "1 bowl (60 g)",
    "60",
    ["380", "13", "67", "7", "10", "1", "5", "350", "50", "4", "0", null, "0", "30", "0"],
  ],
  [
    "Greek yogurt",
    "1 pot (170 g)",
    "170",
    ["90", "10", "5", "3", "0", "4", "40", "160", "120", "0", "0", "0", "0.5", "7", "20"],
  ],
  [
    "Banana",
    "1 medium (120 g)",
    "120",
    ["90", "1", "23", "0.3", "3", "12", "1", "350", "5", "0.3", "8", "0", "0", "20", "3"],
  ],
  [
    "Blueberries",
    "1 cup (150 g)",
    "150",
    ["60", "1", "14", "0.5", "2", "10", "1", "80", "8", "0.4", "10", "0", "0", "6", "3"],
  ],
  [
    "Wholegrain toast",
    "1 slice (40 g)",
    "40",
    ["250", "10", "45", "4", "7", "5", "400", "200", "100", "3", "0", null, "0", "50", "0"],
  ],
  [
    "Egg",
    "1 egg (50 g)",
    "50",
    ["145", "13", "1", "10", "0", "0", "140", "130", "55", "2", "0", "2", "1", "45", "160"],
  ],
  [
    "Grilled chicken",
    "1 portion (150 g)",
    "150",
    ["165", "31", "0", "4", "0", "0", "70", "260", "15", "1", "0", "0", "0.3", "4", "10"],
  ],
  [
    "Brown rice",
    "1 cup (190 g)",
    "190",
    ["125", "3", "26", "1", "2", "0", "5", "90", "10", "0.6", "0", "0", "0", "10", "0"],
  ],
  [
    "Broccoli",
    "1 cup (90 g)",
    "90",
    ["35", "3", "7", "0.5", "3", "2", "30", "300", "45", "0.7", "80", "0", "0", "60", "30"],
  ],
  [
    "Salmon",
    "1 fillet (140 g)",
    "140",
    ["200", "22", "0", "12", "0", "0", "60", "350", "15", "0.5", "0", "10", "3", "25", "20"],
  ],
  [
    "Chickpeas",
    "1 cup (160 g)",
    "160",
    ["165", "9", "27", "3", "8", "5", "25", "290", "50", "3", "1", "0", "0", "170", "2"],
  ],
  [
    "Almonds",
    "1 handful (28 g)",
    "28",
    ["580", "21", "22", "50", "12", "4", "1", "700", "260", "4", "0", "0", null, "45", "0"],
  ],
];
const fixtures: Fixture[] = definitions.map(([name, serving, grams, values]) => ({
  name: `${name} (synthetic sample)`,
  serving,
  grams,
  amounts: Object.fromEntries(
    CORE_NUTRIENTS.map((nutrient, index) => [nutrient.id, values[index] ?? null]),
  ),
}));
function validateFixtures() {
  assert(CORE_NUTRIENTS.length === 15 && definitions.length === 12);
  assert.deepEqual(
    CORE_NUTRIENTS.map((nutrient) => nutrient.id),
    [
      "energy",
      "protein",
      "carbohydrate",
      "fat",
      "fiber",
      "sugars",
      "sodium",
      "potassium",
      "calcium",
      "iron",
      "vitamin-c",
      "vitamin-d",
      "vitamin-b12",
      "folate-dfe",
      "vitamin-a-rae",
    ],
    "Fixture profile order must match checked-in core definitions",
  );
  assert(new Set(fixtures.map((food) => food.name)).size === fixtures.length);
  for (const [index, fixture] of fixtures.entries()) {
    assert(definitions[index]?.[3].length === CORE_NUTRIENTS.length);
    assert(/^[1-9][0-9]*$/.test(fixture.grams) && fixture.name.includes("(synthetic sample)"));
    assert(Object.keys(fixture.amounts).length === 15);
    for (const value of Object.values(fixture.amounts))
      assert(value === null || /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value));
  }
}
async function seedPromotedPublicFood(
  database: ReturnType<typeof createDatabase>,
  input: {
    readonly registry: ReadonlyMap<
      string,
      { id: string; code: string; name: string; canonical_unit: string }
    >;
    readonly fixture: Fixture;
    readonly now: Date;
  },
): Promise<{
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly releaseId: string;
  readonly sourceId: string;
}> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const instant = input.now.toISOString();
    const artifactSha256 = sha256(`synthetic-walkthrough-food-${suffix}`);
    const evidenceBundleSha256 = sha256(`synthetic-walkthrough-evidence-bundle-${suffix}`);
    const evidenceDecisionSha256 = sha256(`synthetic-walkthrough-evidence-decision-${suffix}`);
    const evidenceValidUntil = new Date(Date.now() + 12 * 60 * 60 * 1_000);
    const rightsManifestSha256 = sha256(`synthetic-walkthrough-rights-${suffix}`);
    const source = await transaction
      .insertInto("food_source")
      .values({
        access_url: null,
        active: true,
        attribution_required: true,
        attribution_text: "Invented walkthrough values; not a nutrient reference",
        code: `RP${suffix}`,
        commercial_use_allowed: true,
        database_rights_notes: "Test-only synthetic fixture",
        display_name: `Synthetic walkthrough fixture ${suffix}`,
        homepage_url: "https://example.invalid/synthetic-walkthrough-food",
        kind: "open",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: input.now,
        rights_reviewed_by: "principal:synthetic-walkthrough",
        terms_url: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const mappingReviewedBy = "principal:synthetic-walkthrough";
    const nutrientMappings = CORE_NUTRIENTS.map((definition) => {
      const row = input.registry.get(definition.id);
      assert(row, "Missing core nutrient definition");
      return {
        canonicalUnit: definition.canonicalUnit,
        conversionMultiplier: "1",
        nutrientCode: definition.id,
        nutrientDimension: definition.category === "energy" ? "energy" : "mass",
        nutrientId: row.id,
        nutrientName: definition.name,
        revisionId: randomUUID(),
        sourceName: definition.name,
        sourceNutrientKey: definition.id,
        sourceUnit: definition.canonicalUnit,
      };
    }).sort((left, right) => (left.sourceNutrientKey < right.sourceNutrientKey ? -1 : 1));
    const includedMappings = nutrientMappings.filter(
      (mapping) => input.fixture.amounts[mapping.nutrientCode] !== null,
    );
    const nutrientMappingDigest = sha256(
      canonicalJson(
        nutrientMappings.map((mapping) => ({
          canonicalUnit: mapping.canonicalUnit,
          conversionMultiplier: mapping.conversionMultiplier,
          nutrientCode: mapping.nutrientCode,
          nutrientDimension: mapping.nutrientDimension,
          nutrientId: mapping.nutrientId,
          nutrientName: mapping.nutrientName,
          revisionId: mapping.revisionId,
          sourceNutrientKey: mapping.sourceNutrientKey,
          sourceUnit: mapping.sourceUnit,
        })),
      ),
    );
    await transaction
      .insertInto("source_nutrient_map")
      .values(
        nutrientMappings.map((mapping) => ({
          conversion_multiplier: mapping.conversionMultiplier,
          current_revision_id: mapping.revisionId,
          food_source_id: source.id,
          mapping_notes: null,
          nutrient_id: mapping.nutrientId,
          reviewed_at: input.now,
          reviewed_by: mappingReviewedBy,
          source_name: mapping.sourceName,
          source_nutrient_key: mapping.sourceNutrientKey,
          source_unit: mapping.sourceUnit,
        })),
      )
      .execute();
    await transaction
      .insertInto("source_nutrient_map_revision")
      .values(
        nutrientMappings.map((mapping) => ({
          change_reason: "Synthetic walkthrough fixture mapping; not independent source review",
          conversion_multiplier: mapping.conversionMultiplier,
          food_source_id: source.id,
          id: mapping.revisionId,
          mapping_notes: null,
          nutrient_id: mapping.nutrientId,
          reviewed_at: input.now,
          reviewed_by: mappingReviewedBy,
          source_name: mapping.sourceName,
          source_nutrient_key: mapping.sourceNutrientKey,
          source_unit: mapping.sourceUnit,
          supersedes_revision_id: null,
        })),
      )
      .execute();
    const release = await transaction
      .insertInto("food_source_release")
      .values({
        acquired_at: input.now,
        artifact_bytes: 1,
        artifact_sha256: artifactSha256,
        artifact_uri: `s3://walkthrough-fixture.invalid/sha256/${artifactSha256}.json`,
        evidence_bundle_sha256: evidenceBundleSha256,
        evidence_bundle_uri: `s3://walkthrough-fixture-evidence.invalid/sha256/${evidenceBundleSha256}/bundle.json`,
        evidence_decision_sha256: evidenceDecisionSha256,
        evidence_object_version_id: `synthetic-walkthrough-${suffix}-evidence-v1`,
        evidence_valid_until: evidenceValidUntil,
        food_source_id: source.id,
        media_type: "application/json",
        parser_version: `synthetic-walkthrough@1+mapping.${nutrientMappingDigest}`,
        promoted_at: null,
        published_on: instant.slice(0, 10),
        record_counts: { records: 1 },
        release_class: "live-reviewed",
        release_key: `synthetic-walkthrough-${suffix}`,
        rights_manifest_sha256: rightsManifestSha256,
        rights_manifest_uri: "repo://synthetic-walkthrough/synthetic-rights.json",
        status: "imported",
        upstream_schema_version: "synthetic-v1",
        validation_summary: { synthetic: true, valid: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const batch = await transaction
      .insertInto("food_import_batch")
      .values({
        acquired_at: input.now,
        artifact_bytes: 1,
        artifact_sha256: artifactSha256,
        artifact_uri: `s3://walkthrough-fixture.invalid/sha256/${artifactSha256}.json`,
        evidence_bundle_sha256: evidenceBundleSha256,
        evidence_bundle_uri: `s3://walkthrough-fixture-evidence.invalid/sha256/${evidenceBundleSha256}/bundle.json`,
        evidence_decision_sha256: evidenceDecisionSha256,
        evidence_object_version_id: `synthetic-walkthrough-${suffix}-evidence-v1`,
        evidence_valid_until: evidenceValidUntil,
        food_source_id: source.id,
        media_type: "application/json",
        nutrient_input_count: includedMappings.length,
        nutrient_materializable_count: includedMappings.length,
        parser_version: `synthetic-walkthrough@1+mapping.${nutrientMappingDigest}`,
        published_on: instant.slice(0, 10),
        release_class: "live-reviewed",
        release_key: `synthetic-walkthrough-${suffix}`,
        rights_manifest_sha256: rightsManifestSha256,
        rights_manifest_uri: "repo://synthetic-walkthrough/synthetic-rights.json",
        staged_count: 1,
        upstream_schema_version: "synthetic-v1",
        valid_count: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("food_import_batch")
      .set({
        nutrient_mapping_digest: nutrientMappingDigest,
        nutrient_mapping_revision_ids: transaction
          .selectFrom("source_nutrient_map")
          .select((expressionBuilder) =>
            expressionBuilder.fn
              .agg<JsonArray>("jsonb_agg", ["current_revision_id"])
              .orderBy("current_revision_id")
              .as("revision_ids"),
          )
          .where("food_source_id", "=", source.id),
        status: "ready",
        validated_at: input.now,
        validated_food_contract_version: 1,
        validation_digest: "d".repeat(64),
      })
      .where("id", "=", batch.id)
      .execute();
    await transaction
      .updateTable("food_import_batch")
      .set({ release_id: release.id, status: "promoting" })
      .where("id", "=", batch.id)
      .execute();
    const food = await transaction
      .insertInto("food")
      .values({
        archived_at: null,
        food_source_id: source.id,
        kind: "generic",
        owner_user_id: null,
        source_food_key: `synthetic-walkthrough-${suffix}`,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await transaction
      .insertInto("food_version")
      .values({
        attributes: { synthetic: true },
        basis_quantity: "100",
        basis_unit: "g",
        brand_name: null,
        created_by_user_id: null,
        data_quality: "provisional",
        description: "Synthetic source-backed public food",
        food_id: food.id,
        ingredients_text: null,
        language_tag: "en-US",
        market_code: "US",
        name: input.fixture.name,
        normalized_name: input.fixture.name.toLowerCase(),
        source_modified_at: input.now,
        source_release_id: release.id,
        version_number: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const sourcePayloadSha256 = sha256(canonicalJson(input.fixture));
    const validatedNutrients = includedMappings.map((mapping) => {
      const amount = input.fixture.amounts[mapping.nutrientCode];
      assert(typeof amount === "string");
      return {
        amount,
        canonicalUnit: mapping.canonicalUnit,
        dataPoints: null,
        derivationCode: null,
        metadata: {
          dataPoints: null,
          derivationCode: null,
          mappingRevisionId: mapping.revisionId,
          sourceName: mapping.sourceName,
          sourceNutrientId: mapping.sourceNutrientKey,
          sourceUnit: mapping.sourceUnit,
        },
        mappingRevisionId: mapping.revisionId,
        nutrientCode: mapping.nutrientCode,
        nutrientId: mapping.nutrientId,
        sourceAmount: amount,
        sourceBasisQuantity: "100",
        sourceBasisUnit: "g" as const,
        sourceName: mapping.sourceName,
        sourceNutrientId: mapping.sourceNutrientKey,
        sourceUnit: mapping.sourceUnit,
        valueStatus: "estimated" as const,
      };
    });
    const servings = [
      {
        displayOrder: 0,
        gramWeight: input.fixture.grams,
        isDefault: true,
        label: input.fixture.serving,
        metadata: { synthetic: true },
        quantity: "1",
        sourceServingKey: "portion",
        unit: "portion",
        unitKind: "count" as const,
      },
      {
        displayOrder: 1,
        gramWeight: "100",
        isDefault: false,
        label: "100 g",
        metadata: { synthetic: true },
        quantity: "100",
        sourceServingKey: "100g",
        unit: "g",
        unitKind: "mass" as const,
      },
    ];
    const validatedFood = {
      attributes: {
        idempotencyKey: `synthetic-walkthrough-${suffix}`,
        sourcePayloadSha256,
        unlistedNutrientPolicy: "unknown_not_reported",
      },
      basisQuantity: "100",
      brandName: null,
      description: "Synthetic source-backed public food",
      gtin: null,
      kind: "generic" as const,
      languageTag: "en-US",
      marketCode: "US",
      name: input.fixture.name,
      normalizedName: input.fixture.name.toLowerCase(),
      nutrients: validatedNutrients,
      servings,
      sourceDataType: "fixture",
      sourceFoodKey: `synthetic-walkthrough-${suffix}`,
      sourceModifiedAt: instant,
    };
    const canonicalPayload = { name: input.fixture.name, synthetic: true };
    const record = await transaction
      .insertInto("food_import_record")
      .values({
        batch_id: batch.id,
        canonical_payload: canonicalPayload,
        canonical_payload_sha256: sha256(canonicalJson(canonicalPayload)),
        sequence_number: 0,
        source_payload_sha256: sourcePayloadSha256,
        source_record_key: `synthetic-walkthrough-${suffix}`,
        source_record_type: "fixture",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("food_import_record")
      .set({
        validated_at: input.now,
        validated_food_contract_version: 1,
        validated_food_document: canonicalJson(validatedFood),
        validated_food_sha256: sha256(canonicalJson(validatedFood)),
        validation_issues: transaction.fn<JsonArray>("jsonb_build_array", []),
        validation_status: "valid",
      })
      .where("id", "=", record.id)
      .execute();
    await transaction
      .updateTable("food_import_record")
      .set({
        food_version_id: version.id,
        materialized_at: input.now,
        validation_status: "materialized",
      })
      .where("id", "=", record.id)
      .execute();
    await transaction
      .updateTable("food")
      .set({ current_version_id: version.id })
      .where("id", "=", food.id)
      .execute();
    await transaction
      .insertInto("food_nutrient_value")
      .values(
        validatedNutrients.map((nutrient) => ({
          amount: nutrient.amount,
          basis_quantity: "100",
          basis_unit: "g" as const,
          derivation_code: nutrient.derivationCode,
          food_version_id: version.id,
          metadata: nutrient.metadata,
          nutrient_id: nutrient.nutrientId,
          source_amount: nutrient.sourceAmount,
          source_basis_quantity: nutrient.sourceBasisQuantity,
          source_basis_unit: nutrient.sourceBasisUnit,
          source_unit: nutrient.sourceUnit,
          unit: nutrient.canonicalUnit,
          value_status: nutrient.valueStatus,
        })),
      )
      .execute();
    await transaction
      .insertInto("food_serving")
      .values(
        servings.map((serving) => ({
          display_order: serving.displayOrder,
          food_version_id: version.id,
          gram_weight: serving.gramWeight,
          is_default: serving.isDefault,
          label: serving.label,
          metadata: serving.metadata,
          milliliter_volume: null,
          quantity: serving.quantity,
          source_serving_key: serving.sourceServingKey,
          unit: serving.unit,
          unit_kind: serving.unitKind,
        })),
      )
      .execute();
    await transaction
      .updateTable("food_import_batch")
      .set({ completed_at: input.now, materialized_count: 1, status: "completed" })
      .where("id", "=", batch.id)
      .execute();
    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: input.now, status: "promoted" })
      .where("id", "=", release.id)
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release.id })
      .where("id", "=", source.id)
      .execute();
    return {
      foodId: food.id,
      foodVersionId: version.id,
      releaseId: release.id,
      sourceId: source.id,
    };
  });
}

function required(name: string): string {
  const value = process.env[name];
  assert(value && value.trim() === value, `Missing or invalid ${name}`);
  return value;
}
async function seed() {
  validateFixtures();
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--validate-only") {
    console.log(
      JSON.stringify({
        valid: true,
        syntheticOnly: true,
        foods: 12,
        servings: 24,
        coreNutrients: 15,
        serviceAccess: false,
      }),
    );
    return;
  }
  assert(process.argv.length === 2, "Only --validate-only is supported");
  assert(required("WALKTHROUGH_FIXTURE_ONLY") === "yes");
  assert(required("NODE_ENV") === "development");
  assert(!process.env.MEILI_MASTER_KEY, "Master key must stay with scoped-key bootstrap");
  const runId = required("WALKTHROUGH_RUN_ID");
  assert(/^[a-z0-9]{8,32}$/.test(runId), "Invalid walkthrough run ID");
  const target = new URL(required("DATABASE_URL"));
  assert(
    target.protocol === "postgresql:" &&
      target.hostname === "127.0.0.1" &&
      Number(target.port) >= 1024 &&
      Number(target.port) <= 65535 &&
      target.username &&
      target.password &&
      target.pathname === `/nourishing_walkthrough_${runId}` &&
      !target.search &&
      !target.hash,
    "Requires the selected fresh walkthrough database on loopback",
  );
  const host = required("MEILI_URL"),
    meili = new URL(host);
  assert(
    meili.protocol === "http:" &&
      meili.hostname === "127.0.0.1" &&
      Number(meili.port) >= 1024 &&
      Number(meili.port) <= 65535 &&
      host === `http://127.0.0.1:${meili.port}`,
    "Requires exact loopback Meilisearch",
  );
  const adminKey = required("MEILI_ADMIN_KEY"),
    taskKey = required("MEILI_TASK_OBSERVER_KEY"),
    searchKey = required("MEILI_SEARCH_KEY");
  assert(
    new Set([adminKey, taskKey, searchKey]).size === 3 &&
      [adminKey, taskKey, searchKey].every((key) => /^[a-f0-9]{64}$/.test(key)),
    "Requires distinct generated scoped Meilisearch keys",
  );
  const directory = required("WALKTHROUGH_EVIDENCE_DIR");
  assert(
    directory.startsWith("/") &&
      !directory.startsWith("/mnt/") &&
      (await realpath(directory)) === directory,
    "Evidence must be a Linux-filesystem directory",
  );
  const meta = await lstat(directory);
  assert(
    meta.isDirectory() &&
      !meta.isSymbolicLink() &&
      meta.uid === process.getuid?.() &&
      (meta.mode & 0o777) === 0o700,
    "Evidence directory must be owner-only",
  );
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  assert(
    runtime.version === 1 &&
      runtime.syntheticOnly === true &&
      runtime.runtime === directory &&
      runtime.runId === runId &&
      String(runtime.ports.postgres) === target.port &&
      String(runtime.ports.meilisearch) === meili.port,
    "Service targets must match the selected runtime",
  );
  const receipt = join(directory, "synthetic-catalogue.json");
  await writeFile(
    join(directory, "catalogue-seed-claimed.json"),
    `${JSON.stringify({ runId, syntheticOnly: true, at: new Date().toISOString() })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const database = createDatabase({
    connectionString: target.toString(),
    maxConnections: 3,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    ssl: false,
  });
  const client = new MeilisearchHttpClient({
    host,
    apiKey: adminKey,
    taskApiKey: taskKey,
    requestTimeoutMs: 5000,
  });
  try {
    await assertDatabaseReady(database, { requireRestoreAttestation: false });
    assert(
      !(await client.indexExists("foods")),
      "Refusing to replace an existing search catalogue",
    );
    for (const table of ["app_user", "food_source", "food", "nutrient"] as const)
      assert(
        (await database.selectFrom(table).select("id").limit(1).execute()).length === 0,
        "Database is not an empty isolated fixture",
      );
    const registry = await database.transaction().execute(async (transaction) => {
      await lockActiveNutrientRegistryForWrite(transaction);
      const rows = await transaction
        .insertInto("nutrient")
        .values(
          CORE_NUTRIENTS.map((definition, displayOrder) => ({
            canonical_unit: definition.canonicalUnit,
            code: definition.id,
            dimension: definition.category === "energy" ? ("energy" as const) : ("mass" as const),
            display_order: displayOrder,
            is_core: true,
            is_targetable: definition.id !== "energy",
            name: definition.name,
          })),
        )
        .returning(["id", "code", "name", "canonical_unit"])
        .execute();
      return new Map(rows.map((row) => [row.code, row]));
    });
    const now = new Date();
    for (const fixture of fixtures)
      await seedPromotedPublicFood(database, { registry, now, fixture });
    const projection = await pageFoodSearchProjection(database, { limit: 50 });
    assert(
      projection.nextCursor === null && projection.documents.length === fixtures.length,
      "Authoritative projection did not admit every synthetic food",
    );
    assert(
      projection.documents.every(
        (food) => food.name.includes("(synthetic sample)") && food.servings.length === 2,
      ),
      "Projected foods or servings differ from the fixture",
    );
    const rebuilt = await rebuildFoodSearchNow({
      client,
      database,
      batchSize: 12,
      spoolDirectory: directory,
      spoolMaxBytes: 1048576,
      spoolMaxDocuments: 12,
      taskTimeoutMs: 30000,
      signal: AbortSignal.timeout(120000),
    });
    assert(
      rebuilt &&
        rebuilt.includedCount === 12 &&
        rebuilt.excludedCount === 0 &&
        rebuilt.cleanup.status === "completed",
      "Real database-backed index rebuild did not complete",
    );
    await writeFile(
      receipt,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId,
          syntheticOnly: true,
          fixtureExpiresAt: new Date(now.getTime() + 12 * 3600000).toISOString(),
          note: "Invented fixture values; no live catalogue or independent-review acceptance",
          foods: projection.documents.map((food) => ({
            foodId: food.foodId,
            foodVersionId: food.foodVersionId,
            name: food.name,
            servings: food.servings,
          })),
          coreNutrients: [...registry.values()].map((row) => ({
            id: row.id,
            code: row.code,
            unit: row.canonical_unit,
          })),
          index: {
            stableIndex: rebuilt.stableIndex,
            projectionRevision: rebuilt.projectionRevision,
            includedCount: rebuilt.includedCount,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      JSON.stringify({
        seeded: true,
        syntheticOnly: true,
        foods: 12,
        servings: 24,
        coreNutrients: 15,
        receipt,
      }),
    );
  } finally {
    await database.destroy();
  }
}
process.umask(0o077);
seed().catch((error: unknown) => {
  // Retain partial fixture state; never dump SQL, URLs, keys or stack.
  console.error(
    JSON.stringify({
      seeded: false,
      syntheticOnly: true,
      errorType: error instanceof Error ? error.name : "UnknownError",
      instruction:
        "Inspect the isolated fixture; do not rerun against partial data or alter authority guards.",
    }),
  );
  process.exitCode = 1;
});
