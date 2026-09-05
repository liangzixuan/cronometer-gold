import { randomBytes } from "node:crypto";

import { type Kysely, sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import {
  claimFoodSearchRebuildEvents,
  consumeFoodSearchProjectionSnapshot,
  createDatabase,
  type Database,
  getFoodSearchProjectionPublicationState,
  lookupPromotedFoodByBarcode,
  markFoodSearchRebuildEventPublished,
  markFoodSearchRebuildEventsPublished,
  pageFoodSearchProjection,
  publishFoodSearchProjectionAndAcknowledgeEvents,
  releaseFoodSearchRebuildEvents,
  rollbackSourceRelease,
  runMigrations,
  searchPromotedFoodsPostgres,
  withFoodSearchRebuildLock,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const FIXTURE_EVIDENCE_VALID_UNTIL = new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("promoted food-search projection", () => {
  it("fails closed, resolves exact GTINs, searches typos, and rebuilds from one snapshot", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `food_search_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const writer = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    try {
      await runMigrations(database);
      expect(await getFoodSearchProjectionPublicationState(database)).toEqual({
        currentRevision: "0",
        isCurrent: false,
        publishedRevision: null,
      });
      const fixture = await seedSearchCatalogue(database);
      const setupEvents = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:search-setup",
      });
      expect(setupEvents.length).toBeGreaterThan(0);
      await markFoodSearchRebuildEventsPublished(database, {
        eventIds: setupEvents.map((event) => event.id),
        workerId: "worker:search-setup",
      });

      await expect(pageFoodSearchProjection(database, { limit: 501 })).rejects.toThrow(
        "between 1 and 500",
      );
      await expect(
        pageFoodSearchProjection(database, { afterFoodId: "01", limit: 1 }),
      ).rejects.toThrow("positive PostgreSQL bigint");
      await expect(
        searchPromotedFoodsPostgres(database, { limit: 51, query: "oatmeal" }),
      ).rejects.toThrow("between 1 and 50");

      const firstPage = await pageFoodSearchProjection(database, { limit: 2 });
      expect(firstPage.documents).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await pageFoodSearchProjection(database, {
        afterFoodId: firstPage.nextCursor,
        limit: 2,
      });
      const activeDocuments = [...firstPage.documents, ...secondPage.documents];
      expect(activeDocuments.map((document) => document.name).sort()).toEqual([
        "Global Protein Oatmeal",
        "Modern Steel Cut Oatmeal",
        "United States Protein Oatmeal",
      ]);
      expect(activeDocuments).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ foodVersionId: fixture.supersededVersionId }),
          expect.objectContaining({ foodVersionId: fixture.quarantinedVersionId }),
        ]),
      );
      expect(new Set(activeDocuments.map((document) => document.foodId)).size).toBe(3);

      const modern = activeDocuments.find(
        (document) => document.foodVersionId === fixture.modernVersionId,
      );
      expect(modern).toMatchObject({
        sourceArtifactSha256: "2".repeat(64),
        sourceCode: fixture.sourceCode,
        sourceReleaseId: fixture.modernReleaseId,
        servings: [
          expect.objectContaining({ isDefault: true, label: "1 cup" }),
          expect.objectContaining({ isDefault: false, label: "1 scoop" }),
        ],
      });

      await database
        .updateTable("food_source")
        .set({ redistribution_allowed: false })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect(await pageFoodSearchProjection(database, { limit: 10 })).toEqual({
        documents: [],
        nextCursor: null,
      });
      await database
        .updateTable("food_source")
        .set({
          attribution_text: "Updated search integration attribution",
          redistribution_allowed: true,
        })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect(
        (await pageFoodSearchProjection(database, { limit: 10 })).documents[0]?.attributionText,
      ).toBe("Updated search integration attribution");
      await database
        .updateTable("food_source")
        .set({ attribution_text: "😀".repeat(1_001) })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect(await pageFoodSearchProjection(database, { limit: 10 })).toEqual({
        documents: [],
        nextCursor: null,
      });
      await database
        .updateTable("food_source")
        .set({ attribution_text: "Updated search integration attribution" })
        .where("id", "=", fixture.sourceId)
        .execute();
      await database
        .updateTable("food_source")
        .set({ attribution_text: "   " })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect(await pageFoodSearchProjection(database, { limit: 10 })).toEqual({
        documents: [],
        nextCursor: null,
      });
      await database
        .updateTable("food_source")
        .set({ attribution_text: "Updated search integration attribution" })
        .where("id", "=", fixture.sourceId)
        .execute();
      await database
        .updateTable("food_source")
        .set({ display_name: "D".repeat(201) })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect(await pageFoodSearchProjection(database, { limit: 10 })).toEqual({
        documents: [],
        nextCursor: null,
      });
      await database
        .updateTable("food_source")
        .set({ display_name: "Restored exact source display name" })
        .where("id", "=", fixture.sourceId)
        .execute();
      await expect(
        database
          .updateTable("food_source")
          .set({ code: "invalid source code" })
          .where("id", "=", fixture.sourceId)
          .execute(),
      ).rejects.toMatchObject({ code: "23514" });
      const alternateSourceCode = `ALT_${fixture.sourceCode}`;
      await database
        .updateTable("food_source")
        .set({ code: alternateSourceCode })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect((await pageFoodSearchProjection(database, { limit: 10 })).documents[0]).toMatchObject({
        sourceCode: alternateSourceCode,
      });
      await database
        .updateTable("food_source")
        .set({ code: fixture.sourceCode, license_expression: "CC-BY-4.0" })
        .where("id", "=", fixture.sourceId)
        .execute();
      expect((await pageFoodSearchProjection(database, { limit: 10 })).documents[0]).toMatchObject({
        attributionText: "Updated search integration attribution",
        licenseExpression: "CC-BY-4.0",
        sourceCode: fixture.sourceCode,
        sourceDisplayName: "Restored exact source display name",
      });
      const sourceEligibilityEvents = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:source-eligibility",
      });
      expect(sourceEligibilityEvents).toHaveLength(10);
      await markFoodSearchRebuildEventsPublished(database, {
        eventIds: sourceEligibilityEvents.map((event) => event.id),
        workerId: "worker:source-eligibility",
      });

      if (!modern) throw new Error("expected modern projection document");
      await expect(
        database
          .insertInto("food_serving")
          .values({
            display_order: 99,
            food_version_id: modern.foodVersionId,
            gram_weight: "1",
            is_default: false,
            label: "late promoted serving",
            metadata: { fixture: "late-promoted-serving" },
            milliliter_volume: null,
            quantity: "1",
            source_serving_key: "late-promoted-serving",
            unit: "portion",
            unit_kind: "count",
          })
          .execute(),
      ).rejects.toMatchObject({ code: "55000" });
      const insertedBarcode = await database
        .insertInto("food_barcode")
        .values({
          food_id: modern.foodId,
          food_serving_id: null,
          food_version_id: modern.foodVersionId,
          gtin: "96385074",
          market_code: "CA",
          metadata: { fixture: "live-barcode-invalidation" },
          source_release_id: fixture.modernReleaseId,
          valid_from: new Date(),
          valid_to: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      expect(
        await lookupPromotedFoodByBarcode(database, { barcode: "96385074", marketCode: "CA" }),
      ).toMatchObject({ foodId: modern.foodId });
      await database
        .updateTable("food_barcode")
        .set({ valid_to: new Date() })
        .where("id", "=", insertedBarcode.id)
        .execute();
      expect(
        await lookupPromotedFoodByBarcode(database, { barcode: "96385074", marketCode: "CA" }),
      ).toBeNull();
      const childMutationEvents = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:child-mutations",
      });
      expect(childMutationEvents).toHaveLength(2);
      await markFoodSearchRebuildEventsPublished(database, {
        eventIds: childMutationEvents.map((event) => event.id),
        workerId: "worker:child-mutations",
      });

      await database
        .updateTable("food")
        .set({ archived_at: new Date() })
        .where("id", "=", modern.foodId)
        .execute();
      expect(
        (await pageFoodSearchProjection(database, { limit: 10 })).documents.map(
          (document) => document.foodId,
        ),
      ).not.toContain(modern.foodId);
      await database
        .updateTable("food")
        .set({ archived_at: null })
        .where("id", "=", modern.foodId)
        .execute();
      const foodEligibilityEvents = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:food-eligibility",
      });
      expect(foodEligibilityEvents).toHaveLength(2);
      await markFoodSearchRebuildEventsPublished(database, {
        eventIds: foodEligibilityEvents.map((event) => event.id),
        workerId: "worker:food-eligibility",
      });

      await expect(
        lookupPromotedFoodByBarcode(database, { barcode: "036000291453", marketCode: "US" }),
      ).rejects.toThrow("check digit");
      expect(
        await lookupPromotedFoodByBarcode(database, {
          barcode: "00036000291452",
          marketCode: "us",
        }),
      ).toMatchObject({ name: "United States Protein Oatmeal", marketCode: "US" });
      expect(
        await lookupPromotedFoodByBarcode(database, {
          barcode: "036000291452",
          marketCode: "CA",
        }),
      ).toMatchObject({ name: "Global Protein Oatmeal", marketCode: "001" });
      expect(
        await lookupPromotedFoodByBarcode(database, { barcode: "00036000291452" }),
      ).toMatchObject({ name: "Global Protein Oatmeal", marketCode: "001" });
      await expect(
        database
          .insertInto("food_barcode")
          .values({
            food_id: modern.foodId,
            food_serving_id: null,
            food_version_id: modern.foodVersionId,
            gtin: "036000291452",
            market_code: "US",
            metadata: { fixture: "canonical-collision" },
            source_release_id: fixture.modernReleaseId,
            valid_from: new Date(),
            valid_to: null,
          })
          .execute(),
      ).rejects.toMatchObject({ code: "23505" });

      const typoResults = await searchPromotedFoodsPostgres(database, {
        limit: 5,
        query: "globel protein oatmel",
      });
      expect(typoResults[0]).toMatchObject({
        document: { name: "Global Protein Oatmeal" },
      });
      expect(typoResults[0]?.score).toBeGreaterThan(0.3);
      await expect(
        searchPromotedFoodsPostgres(database, { limit: 1, query: "a" }),
      ).resolves.toBeDefined();
      await expect(
        searchPromotedFoodsPostgres(database, { limit: 1, query: "😀".repeat(128) }),
      ).resolves.toBeDefined();
      await expect(
        searchPromotedFoodsPostgres(database, { limit: 1, query: "😀".repeat(129) }),
      ).rejects.toThrow("between 1 and 128");
      expect(
        (await searchPromotedFoodsPostgres(database, { query: "heritage oatmeal" })).map(
          (result) => result.document.foodVersionId,
        ),
      ).not.toContain(fixture.supersededVersionId);

      const snapshotNames: string[] = [];
      let changedDuringSnapshot = false;
      const snapshot = await consumeFoodSearchProjectionSnapshot(
        database,
        { pageSize: 1 },
        async (page) => {
          snapshotNames.push(...page.documents.map((document) => document.name));
          expect(page.snapshot.expectedDocumentCount).toBe("3");
          if (!changedDuringSnapshot) {
            changedDuringSnapshot = true;
            await rollbackSourceRelease(writer, {
              performedBy: "service:search-integration-writer",
              reason: "Exercise a concurrent search snapshot rollback",
              sourceCode: fixture.sourceCode,
              targetReleaseId: fixture.supersededReleaseId,
            });
          }
        },
      );
      expect(snapshot).toMatchObject({
        consumedDocumentCount: "3",
        expectedDocumentCount: "3",
        pageCount: 3,
      });
      expect(snapshot.generation).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshotNames.sort()).toEqual([
        "Global Protein Oatmeal",
        "Modern Steel Cut Oatmeal",
        "United States Protein Oatmeal",
      ]);

      let announceLockAcquired: (() => void) | undefined;
      let releaseHeldLock: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        announceLockAcquired = resolve;
      });
      const holdLock = new Promise<void>((resolve) => {
        releaseHeldLock = resolve;
      });
      const firstBuilder = withFoodSearchRebuildLock(database, async () => {
        announceLockAcquired?.();
        await holdLock;
        return "first-builder";
      });
      await lockAcquired;
      expect(await withFoodSearchRebuildLock(writer, async () => "second-builder")).toBeNull();
      let announceWriterPid: ((pid: number) => void) | undefined;
      const writerPid = new Promise<number>((resolve) => {
        announceWriterPid = resolve;
      });
      const blockedRightsMutation = writer.connection().execute(async (connection) => {
        const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
          connection,
        );
        const pid = backend.rows[0]?.pid;
        if (pid === undefined) throw new Error("writer backend PID query returned no row");
        announceWriterPid?.(pid);
        await connection
          .updateTable("food_source")
          .set({ attribution_text: "Rights change serialized behind the search rebuild" })
          .where("id", "=", fixture.sourceId)
          .execute();
      });
      const blockedWriterPid = await writerPid;
      await sql`select pg_sleep(0.05)`.execute(database);
      const blockedWriter = await sql<{
        wait_event: string | null;
        wait_event_type: string | null;
      }>`
        select wait_event, wait_event_type
        from pg_stat_activity
        where pid = ${blockedWriterPid}
      `.execute(database);
      releaseHeldLock?.();
      expect(blockedWriter.rows[0]).toMatchObject({
        wait_event: "advisory",
        wait_event_type: "Lock",
      });
      expect(await firstBuilder).toEqual({ acquired: true, result: "first-builder" });
      await blockedRightsMutation;
      await expect(
        withFoodSearchRebuildLock(database, async () => {
          throw new Error("rebuild callback failed");
        }),
      ).rejects.toThrow("rebuild callback failed");
      expect(await withFoodSearchRebuildLock(writer, async () => "after-failure")).toEqual({
        acquired: true,
        result: "after-failure",
      });

      const claimedByFirstWorker = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:search-a",
      });
      expect(claimedByFirstWorker.length).toBeGreaterThanOrEqual(1);
      expect(claimedByFirstWorker).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            aggregateId: fixture.sourceId,
            attemptNumber: 1,
            workerId: "worker:search-a",
          }),
        ]),
      );
      const claimedEventIds = claimedByFirstWorker.map((event) => event.id);
      expect(
        await claimFoodSearchRebuildEvents(writer, {
          aggregateId: fixture.sourceId,
          limit: 500,
          workerId: "worker:search-b",
        }),
      ).toEqual([]);
      await database
        .updateTable("outbox_event")
        .set({ locked_at: new Date(Date.now() - 60_000) })
        .where("id", "in", claimedEventIds)
        .execute();
      const reclaimed = await claimFoodSearchRebuildEvents(writer, {
        aggregateId: fixture.sourceId,
        limit: 500,
        staleLockSeconds: 30,
        workerId: "worker:search-b",
      });
      expect(reclaimed.map((event) => event.id).sort()).toEqual([...claimedEventIds].sort());
      expect(reclaimed.every((event) => event.workerId === "worker:search-b")).toBe(true);
      const reclaimedIds = reclaimed.map((event) => event.id);
      await expect(
        markFoodSearchRebuildEventPublished(database, {
          eventId: reclaimedIds[0] ?? "missing",
          workerId: "worker:search-a",
        }),
      ).rejects.toThrow("owned by another worker");
      await expect(
        releaseFoodSearchRebuildEvents(writer, {
          errorCode: "source content leaked into an error",
          eventIds: reclaimedIds,
          workerId: "worker:search-b",
        }),
      ).rejects.toThrow("sanitized uppercase machine code");
      const released = await releaseFoodSearchRebuildEvents(writer, {
        errorCode: "SEARCH_REBUILD_FAILED",
        eventIds: reclaimedIds,
        workerId: "worker:search-b",
      });
      expect(released.every((event) => event.attemptCount === 1 && !event.deadLettered)).toBe(true);
      expect(
        released.every((event) => new Date(event.availableAt ?? 0).getTime() > Date.now()),
      ).toBe(true);
      await database
        .updateTable("outbox_event")
        .set({ available_at: new Date(Date.now() - 1_000) })
        .where("id", "in", reclaimedIds)
        .execute();
      const retry = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:search-b",
      });
      expect(retry.map((event) => event.id).sort()).toEqual([...reclaimedIds].sort());
      expect(retry.every((event) => event.attemptNumber === 2)).toBe(true);
      const beforeFirstPublication = await getFoodSearchProjectionPublicationState(database);
      expect(beforeFirstPublication).toMatchObject({
        isCurrent: false,
        publishedRevision: null,
      });
      expect(beforeFirstPublication.currentRevision).not.toBe("0");
      await expect(
        publishFoodSearchProjectionAndAcknowledgeEvents(database, {
          eventIds: retry.map((event) => event.id),
          expectedRevision: "0",
          workerId: "worker:search-b",
        }),
      ).rejects.toThrow("projection changed");
      await publishFoodSearchProjectionAndAcknowledgeEvents(database, {
        eventIds: retry.map((event) => event.id),
        expectedRevision: beforeFirstPublication.currentRevision,
        workerId: "worker:search-b",
      });
      expect(await getFoodSearchProjectionPublicationState(database)).toEqual({
        currentRevision: beforeFirstPublication.currentRevision,
        isCurrent: true,
        publishedRevision: beforeFirstPublication.currentRevision,
      });
      expect(
        await claimFoodSearchRebuildEvents(database, {
          aggregateId: fixture.sourceId,
          limit: 500,
          workerId: "worker:search-b",
        }),
      ).toEqual([]);

      const afterRollback = await pageFoodSearchProjection(database, { limit: 10 });
      expect(afterRollback.documents).toHaveLength(1);
      expect(afterRollback.documents[0]).toMatchObject({
        foodVersionId: fixture.supersededVersionId,
        name: "Heritage Rolled Oatmeal",
        sourceReleaseId: fixture.supersededReleaseId,
      });
      expect(
        await lookupPromotedFoodByBarcode(database, { barcode: "10012345000017" }),
      ).toMatchObject({ name: "Heritage Rolled Oatmeal" });
      expect(
        await lookupPromotedFoodByBarcode(database, { barcode: "036000291452", marketCode: "US" }),
      ).toBeNull();
      expect(
        await searchPromotedFoodsPostgres(database, { query: "heritage rollled oatmel" }),
      ).toEqual([
        expect.objectContaining({
          document: expect.objectContaining({ name: "Heritage Rolled Oatmeal" }),
        }),
      ]);

      await rollbackSourceRelease(database, {
        performedBy: "service:search-integration-writer",
        reason: "Exercise search fail-closed deactivation",
        sourceCode: fixture.sourceCode,
        targetReleaseId: null,
      });
      expect(await getFoodSearchProjectionPublicationState(database)).toMatchObject({
        isCurrent: false,
        publishedRevision: beforeFirstPublication.currentRevision,
      });
      expect(await pageFoodSearchProjection(database, { limit: 10 })).toEqual({
        documents: [],
        nextCursor: null,
      });
      expect(await lookupPromotedFoodByBarcode(database, { barcode: "10012345000017" })).toBeNull();
      expect(await searchPromotedFoodsPostgres(database, { query: "heritage oatmeal" })).toEqual(
        [],
      );

      const deactivationEvents = await claimFoodSearchRebuildEvents(database, {
        aggregateId: fixture.sourceId,
        limit: 500,
        workerId: "worker:search-a",
      });
      expect(deactivationEvents.length).toBeGreaterThanOrEqual(1);
      const deactivationEventIds = deactivationEvents.map((event) => event.id);
      await database
        .updateTable("outbox_event")
        .set({ attempt_count: 7 })
        .where("id", "in", deactivationEventIds)
        .execute();
      const deadLettered = await releaseFoodSearchRebuildEvents(database, {
        errorCode: "SEARCH_INDEX_UNAVAILABLE",
        eventIds: deactivationEventIds,
        workerId: "worker:search-a",
      });
      expect(deadLettered).toHaveLength(deactivationEventIds.length);
      expect(
        deadLettered.every(
          (event) => event.attemptCount === 8 && event.availableAt === null && event.deadLettered,
        ),
      ).toBe(true);
      expect(
        await claimFoodSearchRebuildEvents(database, {
          aggregateId: fixture.sourceId,
          limit: 500,
          workerId: "worker:search-a",
        }),
      ).toEqual([]);
      const terminalEvent = await database
        .selectFrom("outbox_event")
        .select(["dead_lettered_at", "last_error"])
        .where("id", "=", deactivationEventIds[0] ?? "missing")
        .executeTakeFirstOrThrow();
      expect(terminalEvent.last_error).toBe("SEARCH_INDEX_UNAVAILABLE");
      expect(terminalEvent.dead_lettered_at).not.toBeNull();
    } finally {
      await Promise.all([database.destroy(), writer.destroy()]);
      await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      await bootstrap.destroy();
    }
  }, 30_000);
});

interface SearchFixture {
  readonly modernReleaseId: string;
  readonly modernVersionId: string;
  readonly quarantinedVersionId: string;
  readonly sourceCode: string;
  readonly sourceId: string;
  readonly supersededReleaseId: string;
  readonly supersededVersionId: string;
}

async function seedSearchCatalogue(database: Kysely<Database>): Promise<SearchFixture> {
  return database.transaction().execute(async (transaction) => {
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const sourceCode = `FS${suffix}`;
    const source = await transaction
      .insertInto("food_source")
      .values({
        access_url: null,
        active: true,
        attribution_required: true,
        attribution_text: "Search integration fixture",
        code: sourceCode,
        commercial_use_allowed: true,
        database_rights_notes: "Test-only fixture",
        display_name: `Food-search source ${suffix}`,
        homepage_url: "https://example.invalid/search-fixture",
        kind: "government",
        license_expression: "CC0-1.0",
        license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistribution_allowed: true,
        rights_review_status: "approved",
        rights_reviewed_at: "2026-08-15T12:00:00Z",
        rights_reviewed_by: "principal:search-rights-review",
        terms_url: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const supersededReleaseId = await insertRelease(transaction, source.id, "release-1", "1");
    const modernReleaseId = await insertRelease(transaction, source.id, "release-2", "2");
    const supersededBatchId = await insertCompletedBatch(
      transaction,
      source.id,
      supersededReleaseId,
      "release-1",
      "1",
      1,
    );
    const modernBatchId = await insertCompletedBatch(
      transaction,
      source.id,
      modernReleaseId,
      "release-2",
      "2",
      4,
    );

    const sharedFood = await insertFood(transaction, source.id, "shared-oatmeal", "generic");
    const supersededVersionId = await insertVersion(transaction, {
      batchId: supersededBatchId,
      dataQuality: "verified",
      foodId: sharedFood,
      languageTag: "en-US",
      marketCode: "US",
      name: "Heritage Rolled Oatmeal",
      releaseId: supersededReleaseId,
      sequenceNumber: 0,
      sourceFoodKey: "shared-oatmeal",
      versionNumber: 1,
    });
    await insertBarcode(transaction, {
      foodId: sharedFood,
      foodVersionId: supersededVersionId,
      gtin: "10012345000017",
      marketCode: "US",
      releaseId: supersededReleaseId,
      validTo: "2026-08-16T00:00:00Z",
    });
    const modernVersionId = await insertVersion(transaction, {
      batchId: modernBatchId,
      dataQuality: "verified",
      foodId: sharedFood,
      languageTag: "en-US",
      marketCode: "US",
      name: "Modern Steel Cut Oatmeal",
      releaseId: modernReleaseId,
      sequenceNumber: 0,
      sourceFoodKey: "shared-oatmeal",
      versionNumber: 2,
    });
    await insertServing(transaction, modernVersionId, {
      displayOrder: 20,
      gramWeight: "81",
      isDefault: true,
      label: "1 cup",
      sourceServingKey: "cup",
      unit: "cup",
    });
    await insertServing(transaction, modernVersionId, {
      displayOrder: 0,
      gramWeight: "30",
      isDefault: false,
      label: "1 scoop",
      sourceServingKey: "scoop",
      unit: "scoop",
    });
    await insertBarcode(transaction, {
      foodId: sharedFood,
      foodVersionId: modernVersionId,
      gtin: "4006381333931",
      marketCode: "US",
      releaseId: modernReleaseId,
      validTo: null,
    });

    const globalFood = await insertFood(transaction, source.id, "global-oatmeal", "branded");
    const globalVersion = await insertVersion(transaction, {
      batchId: modernBatchId,
      brandName: "World Pantry",
      dataQuality: "curated",
      foodId: globalFood,
      languageTag: "en",
      marketCode: "001",
      name: "Global Protein Oatmeal",
      releaseId: modernReleaseId,
      sequenceNumber: 1,
      sourceFoodKey: "global-oatmeal",
      versionNumber: 1,
    });
    await insertBarcode(transaction, {
      foodId: globalFood,
      foodVersionId: globalVersion,
      gtin: "036000291452",
      marketCode: "001",
      releaseId: modernReleaseId,
      validTo: null,
    });

    const usFood = await insertFood(transaction, source.id, "us-oatmeal", "branded");
    const usVersion = await insertVersion(transaction, {
      batchId: modernBatchId,
      brandName: "Home Pantry",
      dataQuality: "verified",
      foodId: usFood,
      languageTag: "en-US",
      marketCode: "US",
      name: "United States Protein Oatmeal",
      releaseId: modernReleaseId,
      sequenceNumber: 2,
      sourceFoodKey: "us-oatmeal",
      versionNumber: 1,
    });
    await insertBarcode(transaction, {
      foodId: usFood,
      foodVersionId: usVersion,
      gtin: "00036000291452",
      marketCode: "US",
      releaseId: modernReleaseId,
      validTo: null,
    });

    const quarantinedFood = await insertFood(
      transaction,
      source.id,
      "quarantined-oatmeal",
      "generic",
    );
    const quarantinedVersionId = await insertVersion(transaction, {
      batchId: modernBatchId,
      dataQuality: "quarantined",
      foodId: quarantinedFood,
      languageTag: "en-US",
      marketCode: "US",
      name: "Forbidden Quarantine Oatmeal",
      releaseId: modernReleaseId,
      sequenceNumber: 3,
      sourceFoodKey: "quarantined-oatmeal",
      versionNumber: 1,
    });

    await transaction
      .updateTable("food_source_release")
      .set({ promoted_at: "2026-08-15T13:00:00Z", status: "promoted" })
      .where("id", "in", [supersededReleaseId, modernReleaseId])
      .execute();
    await transaction
      .updateTable("food_source")
      .set({ active_release_id: modernReleaseId })
      .where("id", "=", source.id)
      .execute();
    return {
      modernReleaseId,
      modernVersionId,
      quarantinedVersionId,
      sourceCode,
      sourceId: source.id,
      supersededReleaseId,
      supersededVersionId,
    };
  });
}

async function insertRelease(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseKey: string,
  hashCharacter: string,
): Promise<string> {
  const artifactSha256 = hashCharacter.repeat(64);
  return (
    await transaction
      .insertInto("food_source_release")
      .values({
        acquired_at: "2026-08-15T12:00:00Z",
        artifact_bytes: 1_024,
        artifact_sha256: artifactSha256,
        artifact_uri: `s3://search-fixture/sha256/${artifactSha256}.json`,
        evidence_bundle_sha256: "b".repeat(64),
        evidence_bundle_uri: `s3://search-fixture/sha256/${"b".repeat(64)}/${releaseKey}.json`,
        evidence_decision_sha256: "c".repeat(64),
        evidence_object_version_id: `search-fixture-${releaseKey}-v1`,
        evidence_valid_until: FIXTURE_EVIDENCE_VALID_UNTIL,
        food_source_id: sourceId,
        media_type: "application/json",
        parser_version: `search-fixture@${releaseKey}`,
        published_on: "2026-08-15",
        record_counts: { fixture: true },
        release_class: "live-reviewed",
        release_key: releaseKey,
        rights_manifest_sha256: "a".repeat(64),
        rights_manifest_uri: "repo://search-fixture-rights.json",
        status: "imported",
        upstream_schema_version: "fixture-v1",
        validation_summary: { fixture: true },
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function insertCompletedBatch(
  transaction: Transaction<Database>,
  sourceId: string,
  releaseId: string,
  releaseKey: string,
  hashCharacter: string,
  recordCount: number,
): Promise<string> {
  const artifactSha256 = hashCharacter.repeat(64);
  const batch = await transaction
    .insertInto("food_import_batch")
    .values({
      acquired_at: "2026-08-15T12:00:00Z",
      artifact_bytes: 1_024,
      artifact_sha256: artifactSha256,
      artifact_uri: `s3://search-fixture/sha256/${artifactSha256}.json`,
      evidence_bundle_sha256: "b".repeat(64),
      evidence_bundle_uri: `s3://search-fixture/sha256/${"b".repeat(64)}/${releaseKey}.json`,
      evidence_decision_sha256: "c".repeat(64),
      evidence_object_version_id: `search-fixture-${releaseKey}-v1`,
      evidence_valid_until: FIXTURE_EVIDENCE_VALID_UNTIL,
      food_source_id: sourceId,
      media_type: "application/json",
      parser_version: `search-fixture@${releaseKey}`,
      published_on: "2026-08-15",
      release_class: "live-reviewed",
      release_key: releaseKey,
      rights_manifest_sha256: "a".repeat(64),
      rights_manifest_uri: "repo://search-fixture-rights.json",
      staged_count: recordCount,
      upstream_schema_version: "fixture-v1",
      valid_count: recordCount,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("food_import_batch")
    .set({
      status: "ready",
      validated_at: "2026-08-15T12:30:00Z",
      validation_digest: "d".repeat(64),
    })
    .where("id", "=", batch.id)
    .execute();
  await transaction
    .updateTable("food_import_batch")
    .set({ release_id: releaseId, status: "promoting" })
    .where("id", "=", batch.id)
    .execute();
  await transaction
    .updateTable("food_import_batch")
    .set({
      completed_at: "2026-08-15T13:00:00Z",
      materialized_count: recordCount,
      status: "completed",
    })
    .where("id", "=", batch.id)
    .execute();
  return batch.id;
}

async function insertFood(
  transaction: Transaction<Database>,
  sourceId: string,
  sourceFoodKey: string,
  kind: "branded" | "generic",
): Promise<string> {
  return (
    await transaction
      .insertInto("food")
      .values({
        archived_at: null,
        food_source_id: sourceId,
        kind,
        owner_user_id: null,
        source_food_key: sourceFoodKey,
        visibility: "public",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

interface InsertVersionInput {
  readonly batchId: string;
  readonly brandName?: string;
  readonly dataQuality: "curated" | "quarantined" | "verified";
  readonly foodId: string;
  readonly languageTag: string;
  readonly marketCode: string;
  readonly name: string;
  readonly releaseId: string;
  readonly sequenceNumber: number;
  readonly sourceFoodKey: string;
  readonly versionNumber: number;
}

async function insertVersion(
  transaction: Transaction<Database>,
  input: InsertVersionInput,
): Promise<string> {
  const version = await transaction
    .insertInto("food_version")
    .values({
      attributes: { fixture: true },
      basis_quantity: "100",
      basis_unit: "g",
      brand_name: input.brandName ?? null,
      created_by_user_id: null,
      data_quality: input.dataQuality,
      description: `${input.name} description`,
      food_id: input.foodId,
      ingredients_text: null,
      language_tag: input.languageTag,
      market_code: input.marketCode,
      name: input.name,
      normalized_name: input.name.toLowerCase(),
      source_modified_at: "2026-08-15T00:00:00Z",
      source_release_id: input.releaseId,
      version_number: input.versionNumber,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("food")
    .set({ archived_at: null, current_version_id: version.id })
    .where("id", "=", input.foodId)
    .execute();
  await transaction
    .insertInto("food_import_record")
    .values({
      batch_id: input.batchId,
      canonical_payload: { fixture: true, name: input.name },
      canonical_payload_sha256: "b".repeat(64),
      food_version_id: version.id,
      materialized_at: "2026-08-15T13:00:00Z",
      sequence_number: input.sequenceNumber,
      source_payload_sha256: "c".repeat(64),
      source_record_key: `${input.sourceFoodKey}:${input.versionNumber}`,
      source_record_type: "fixture",
      validated_at: "2026-08-15T12:30:00Z",
      validation_issues: sql`'[]'::jsonb`,
      validation_status: "materialized",
    })
    .execute();
  return version.id;
}

interface InsertBarcodeInput {
  readonly foodId: string;
  readonly foodVersionId: string;
  readonly gtin: string;
  readonly marketCode: string;
  readonly releaseId: string;
  readonly validTo: string | null;
}

async function insertBarcode(
  transaction: Transaction<Database>,
  input: InsertBarcodeInput,
): Promise<void> {
  await transaction
    .insertInto("food_barcode")
    .values({
      food_id: input.foodId,
      food_serving_id: null,
      food_version_id: input.foodVersionId,
      gtin: input.gtin,
      market_code: input.marketCode,
      metadata: { fixture: true },
      source_release_id: input.releaseId,
      valid_from: "2026-08-15T00:00:00Z",
      valid_to: input.validTo,
    })
    .execute();
}

interface InsertServingInput {
  readonly displayOrder: number;
  readonly gramWeight: string;
  readonly isDefault: boolean;
  readonly label: string;
  readonly sourceServingKey: string;
  readonly unit: string;
}

async function insertServing(
  transaction: Transaction<Database>,
  foodVersionId: string,
  input: InsertServingInput,
): Promise<void> {
  await transaction
    .insertInto("food_serving")
    .values({
      display_order: input.displayOrder,
      food_version_id: foodVersionId,
      gram_weight: input.gramWeight,
      is_default: input.isDefault,
      label: input.label,
      metadata: { fixture: true },
      milliliter_volume: null,
      quantity: "1",
      source_serving_key: input.sourceServingKey,
      unit: input.unit,
      unit_kind: "count",
    })
    .execute();
}
