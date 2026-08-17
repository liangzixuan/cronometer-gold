import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  type Database,
  getFoodSearchProjectionPublicationState,
  runMigrations,
} from "@nutrition-tracker/db";
import {
  FoodSearchService,
  MeilisearchFoodSearchBackend,
  MeilisearchHttpClient,
} from "@nutrition-tracker/search";
import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import { runFoodSearchWorkerPoll } from "./food-search-worker.js";
import {
  createPostgresFoodSearchProjectionSource,
  FoodSearchProjectionSpoolLimitError,
} from "./search-projection.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const meiliUrl = process.env.TEST_MEILI_URL;
const describeIntegration = databaseUrl && meiliUrl ? describe : describe.skip;

describeIntegration("food-search worker integration", () => {
  it("rebuilds an eligible PostgreSQL snapshot, swaps it, and acknowledges the outbox event", async () => {
    if (!databaseUrl || !meiliUrl) throw new Error("integration URLs are required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `worker_search_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const client = new MeilisearchHttpClient({
      host: meiliUrl,
      ...(process.env.TEST_MEILI_API_KEY === undefined
        ? {}
        : { apiKey: process.env.TEST_MEILI_API_KEY }),
      requestTimeoutMs: 10_000,
    });
    const spoolParent = await mkdtemp(join(tmpdir(), "nutrition-search-spool-test-"));

    try {
      await runMigrations(database);
      const eventId = await seedCatalogue(database);
      const projectionSource = createPostgresFoodSearchProjectionSource(database, 1, {
        directory: spoolParent,
        maxBytes: 10_000_000,
        maxDocuments: 100,
      });
      const projectionSnapshot = await projectionSource.openSnapshot();
      expect(projectionSnapshot.projectionRevision).toMatch(/^(?:0|[1-9]\d*)$/);
      const spoolDirectories = await readdir(spoolParent);
      expect(spoolDirectories).toHaveLength(1);
      const spoolDirectory = join(spoolParent, spoolDirectories[0] ?? "missing");
      expect((await stat(spoolDirectory)).mode & 0o777).toBe(0o700);
      const spoolFiles = await readdir(spoolDirectory);
      expect(spoolFiles).toEqual(["projection.ndjson"]);
      expect((await stat(join(spoolDirectory, "projection.ndjson"))).mode & 0o777).toBe(0o600);
      const projectionRows = [];
      for await (const row of projectionSnapshot.stream()) projectionRows.push(row);
      expect(projectionRows).toHaveLength(1);
      await projectionSnapshot.close();
      expect(await readdir(spoolParent)).toEqual([]);

      const boundedSource = createPostgresFoodSearchProjectionSource(database, 1, {
        directory: spoolParent,
        maxBytes: 1,
        maxDocuments: 100,
      });
      await expect(boundedSource.openSnapshot()).rejects.toBeInstanceOf(
        FoodSearchProjectionSpoolLimitError,
      );
      expect(await readdir(spoolParent)).toEqual([]);

      const pendingEventIds = (
        await database
          .selectFrom("outbox_event")
          .select("id")
          .where("event_type", "=", "catalogue.source_release_activated")
          .where("published_at", "is", null)
          .orderBy("occurred_at")
          .orderBy("id")
          .execute()
      ).map((event) => event.id);
      expect(pendingEventIds).toContain(eventId);
      if (await client.indexExists("foods")) {
        const task = await client.deleteIndex("foods");
        await client.waitForTask(task, { timeoutMs: 30_000 });
      }

      const result = await runFoodSearchWorkerPoll({
        client,
        config: {
          SEARCH_REBUILD_BATCH_SIZE: 1,
          SEARCH_REBUILD_EVENT_BATCH_SIZE: 100,
          SEARCH_REBUILD_SPOOL_DIR: spoolParent,
          SEARCH_REBUILD_SPOOL_MAX_BYTES: 10_000_000,
          SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS: 100,
          SEARCH_REBUILD_WORKER_ID: "worker:integration-search",
          SEARCH_TASK_TIMEOUT_MS: 30_000,
        },
        database,
      });
      expect(result).toMatchObject({
        status: "rebuilt",
        eventCount: pendingEventIds.length,
        includedCount: 1,
      });
      if (result.status !== "rebuilt") throw new Error("expected a successful rebuild");
      expect(pendingEventIds).toContain(result.eventId);
      expect(await readdir(spoolParent)).toEqual([]);

      const events = await database
        .selectFrom("outbox_event")
        .select(["published_at", "locked_by", "last_error"])
        .where("id", "in", pendingEventIds)
        .execute();
      expect(events).toHaveLength(pendingEventIds.length);
      expect(
        events.every(
          (event) =>
            event.published_at !== null && event.locked_by === null && event.last_error === null,
        ),
      ).toBe(true);
      expect(await getFoodSearchProjectionPublicationState(database)).toMatchObject({
        isCurrent: true,
      });

      const search = new FoodSearchService({
        backend: new MeilisearchFoodSearchBackend({ client }),
        cursorSecret: "worker-integration-cursor-secret-at-least-32-bytes",
      });
      expect((await search.search({ query: "bluebery oatmel" })).hits[0]).toMatchObject({
        name: "Blueberry Oatmeal",
      });
      expect((await search.lookupBarcode({ gtin: "036000291452" }))?.name).toBe(
        "Blueberry Oatmeal",
      );
      expect((await search.search({ query: "forbidden quarantine" })).hits).toHaveLength(0);
    } finally {
      if (await client.indexExists("foods")) {
        const task = await client.deleteIndex("foods");
        await client.waitForTask(task, { timeoutMs: 30_000 });
      }
      await database.destroy();
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
      await rm(spoolParent, { force: true, recursive: true });
    }
  }, 120_000);
});

async function seedCatalogue(database: Parameters<typeof runMigrations>[0]): Promise<string> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const source = await transaction
      .insertInto("food_source")
      .values({
        access_url: null,
        active: true,
        attribution_required: true,
        attribution_text: "Worker integration fixture",
        code: `WS${suffix}`,
        commercial_use_allowed: true,
        database_rights_notes: "Test-only fixture",
        display_name: `Worker search source ${suffix}`,
        homepage_url: "https://example.invalid/worker-search",
        kind: "government",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: "2026-08-15T12:00:00Z",
        rights_reviewed_by: "principal:worker-search-rights",
        terms_url: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const release = await transaction
      .insertInto("food_source_release")
      .values({
        acquired_at: "2026-08-15T12:00:00Z",
        artifact_bytes: 1024,
        artifact_sha256: "d".repeat(64),
        artifact_uri: `s3://worker-fixture/sha256/${"d".repeat(64)}.json`,
        food_source_id: source.id,
        media_type: "application/json",
        parser_version: "worker-search-fixture@1",
        promoted_at: null,
        published_on: "2026-08-15",
        record_counts: { fixture: true },
        release_key: "worker-release-1",
        rights_manifest_sha256: "e".repeat(64),
        rights_manifest_uri: "repo://worker-search-rights.json",
        status: "imported",
        upstream_schema_version: "fixture-v1",
        validation_summary: { fixture: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const batch = await transaction
      .insertInto("food_import_batch")
      .values({
        acquired_at: "2026-08-15T12:00:00Z",
        artifact_bytes: 1024,
        artifact_sha256: "d".repeat(64),
        artifact_uri: `s3://worker-fixture/sha256/${"d".repeat(64)}.json`,
        completed_at: "2026-08-15T13:00:00Z",
        food_source_id: source.id,
        materialized_count: 2,
        media_type: "application/json",
        parser_version: "worker-search-fixture@1",
        published_on: "2026-08-15",
        release_id: release.id,
        release_key: "worker-release-1",
        rights_manifest_sha256: "e".repeat(64),
        rights_manifest_uri: "repo://worker-search-rights.json",
        staged_count: 2,
        status: "completed",
        upstream_schema_version: "fixture-v1",
        valid_count: 2,
        validated_at: "2026-08-15T12:30:00Z",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await insertFood(transaction, {
      batchId: batch.id,
      dataQuality: "verified",
      foodSourceId: source.id,
      name: "Blueberry Oatmeal",
      releaseId: release.id,
      sequence: 0,
      sourceFoodKey: "blueberry-oatmeal",
    });
    await insertFood(transaction, {
      batchId: batch.id,
      dataQuality: "quarantined",
      foodSourceId: source.id,
      name: "Forbidden Quarantine Oatmeal",
      releaseId: release.id,
      sequence: 1,
      sourceFoodKey: "forbidden-oatmeal",
    });
    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: "2026-08-15T13:00:00Z", status: "promoted" })
      .where("id", "=", release.id)
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: release.id })
      .where("id", "=", source.id)
      .execute();

    return (
      await transaction
        .insertInto("outbox_event")
        .values({
          aggregate_id: source.id,
          aggregate_type: "food_source",
          attempt_count: 0,
          available_at: new Date(),
          dead_lettered_at: null,
          deduplication_key: `worker-search:${suffix}`,
          event_type: "catalogue.source_release_activated",
          event_version: 1,
          headers: {},
          last_error: null,
          locked_at: null,
          locked_by: null,
          payload: { sourceId: source.id, releaseId: release.id },
          published_at: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });
}

async function insertFood(
  transaction: Transaction<Database>,
  input: {
    readonly batchId: string;
    readonly dataQuality: "quarantined" | "verified";
    readonly foodSourceId: string;
    readonly name: string;
    readonly releaseId: string;
    readonly sequence: number;
    readonly sourceFoodKey: string;
  },
): Promise<void> {
  const food = await transaction
    .insertInto("food")
    .values({
      archived_at: null,
      food_source_id: input.foodSourceId,
      kind: input.dataQuality === "verified" ? "branded" : "generic",
      owner_user_id: null,
      source_food_key: input.sourceFoodKey,
      visibility: "public",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await transaction
    .insertInto("food_version")
    .values({
      attributes: { fixture: true },
      basis_quantity: "100",
      basis_unit: "g",
      brand_name: input.dataQuality === "verified" ? "Example Pantry" : null,
      created_by_user_id: null,
      data_quality: input.dataQuality,
      description: `${input.name} description`,
      food_id: food.id,
      ingredients_text: null,
      language_tag: "en-US",
      market_code: "US",
      name: input.name,
      normalized_name: input.name.toLowerCase(),
      source_modified_at: "2026-08-15T00:00:00Z",
      source_release_id: input.releaseId,
      version_number: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("food")
    .set({ current_version_id: version.id })
    .where("id", "=", food.id)
    .execute();
  await transaction
    .insertInto("food_import_record")
    .values({
      batch_id: input.batchId,
      canonical_payload: { fixture: true, name: input.name },
      canonical_payload_sha256: "f".repeat(64),
      food_version_id: version.id,
      materialized_at: "2026-08-15T13:00:00Z",
      sequence_number: input.sequence,
      source_payload_sha256: "a".repeat(64),
      source_record_key: input.sourceFoodKey,
      source_record_type: "fixture",
      validated_at: "2026-08-15T12:30:00Z",
      validation_issues: sql`'[]'::jsonb`,
      validation_status: "materialized",
    })
    .execute();
  if (input.dataQuality !== "verified") return;
  await transaction
    .insertInto("food_serving")
    .values({
      display_order: 0,
      food_version_id: version.id,
      gram_weight: "40",
      is_default: true,
      label: "1 bowl",
      metadata: { fixture: true },
      milliliter_volume: null,
      quantity: "1",
      source_serving_key: "bowl",
      unit: "bowl",
      unit_kind: "count",
    })
    .execute();
  await transaction
    .insertInto("food_barcode")
    .values({
      food_id: food.id,
      food_serving_id: null,
      food_version_id: version.id,
      gtin: "036000291452",
      market_code: "US",
      metadata: { fixture: true },
      source_release_id: input.releaseId,
      valid_from: "2026-08-15T00:00:00Z",
      valid_to: null,
    })
    .execute();
}
