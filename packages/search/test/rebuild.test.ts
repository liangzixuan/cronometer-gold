import { describe, expect, it } from "vitest";
import {
  FOOD_SEARCH_STABLE_INDEX,
  type FoodSearchDocument,
  FoodSearchError,
  type FoodSearchIndexAdmin,
  type FoodSearchProjectionRow,
  type FoodSearchProjectionSource,
  rebuildFoodSearchIndex,
} from "../src/index.js";
import { foodDocument } from "./fixtures.js";

class MemoryIndexAdmin implements FoodSearchIndexAdmin {
  readonly indexes = new Map<string, Map<string, FoodSearchDocument>>();
  readonly addedBatchSizes: number[] = [];
  readonly settingsIndexes: string[] = [];
  swapCount = 0;
  postSwapStatsOverride: number | null = null;
  failRollback = false;
  failDelete = false;
  failStableCreateResponse = false;
  #taskUid = 0;

  async createIndex(uid: string): Promise<number> {
    if (this.indexes.has(uid)) throw new Error("index exists");
    this.indexes.set(uid, new Map());
    if (uid === FOOD_SEARCH_STABLE_INDEX && this.failStableCreateResponse) {
      throw new Error("stable create response lost");
    }
    return this.#taskUid++;
  }

  async indexExists(uid: string): Promise<boolean> {
    return this.indexes.has(uid);
  }

  async updateSettings(uid: string): Promise<number> {
    this.settingsIndexes.push(uid);
    return this.#taskUid++;
  }

  async addDocuments(uid: string, documents: readonly FoodSearchDocument[]): Promise<number> {
    const index = this.indexes.get(uid);
    if (index === undefined) throw new Error("missing index");
    this.addedBatchSizes.push(documents.length);
    for (const document of documents) index.set(document.id, document);
    return this.#taskUid++;
  }

  async getIndexStats(uid: string): Promise<{ readonly numberOfDocuments: number }> {
    if (
      uid === FOOD_SEARCH_STABLE_INDEX &&
      this.swapCount === 1 &&
      this.postSwapStatsOverride !== null
    ) {
      return { numberOfDocuments: this.postSwapStatsOverride };
    }
    const index = this.indexes.get(uid);
    if (index === undefined) throw new Error("missing index");
    return { numberOfDocuments: index.size };
  }

  async swapIndexes(leftUid: string, rightUid: string): Promise<number> {
    if (this.failRollback && this.swapCount === 1) throw new Error("rollback unavailable");
    const left = this.indexes.get(leftUid);
    const right = this.indexes.get(rightUid);
    if (left === undefined || right === undefined) throw new Error("missing swap index");
    this.indexes.set(leftUid, right);
    this.indexes.set(rightUid, left);
    this.swapCount += 1;
    return this.#taskUid++;
  }

  async deleteIndex(uid: string): Promise<number> {
    if (this.failDelete) throw new Error("delete unavailable");
    this.indexes.delete(uid);
    return this.#taskUid++;
  }

  async waitForTask(): Promise<void> {}
}

function projectionSource(
  rows: readonly FoodSearchProjectionRow[],
  options: { readonly expected?: number; readonly throwDuringStream?: boolean } = {},
): { readonly source: FoodSearchProjectionSource; readonly wasClosed: () => boolean } {
  let closed = false;
  return {
    source: {
      async openSnapshot() {
        return {
          expectedIncludedCount:
            options.expected ?? rows.filter(({ eligibility }) => eligibility === "include").length,
          projectionRevision: "42",
          async *stream() {
            for (const row of rows) yield row;
            if (options.throwDuringStream === true) throw new Error("projection stream failed");
          },
          async close() {
            closed = true;
          },
        };
      },
    },
    wasClosed: () => closed,
  };
}

function included(document: FoodSearchDocument): FoodSearchProjectionRow {
  return { eligibility: "include", document };
}

describe("atomic search index rebuild", () => {
  it("streams batches, excludes ineligible rows, verifies counts, swaps, and removes old data", async () => {
    const admin = new MemoryIndexAdmin();
    admin.indexes.set(
      FOOD_SEARCH_STABLE_INDEX,
      new Map([["old", foodDocument({ id: "old", foodId: "900", foodVersionId: "9001" })]]),
    );
    const first = foodDocument({ id: "new_1", foodId: "1", foodVersionId: "11" });
    const second = foodDocument({ id: "new_2", foodId: "2", foodVersionId: "21" });
    const snapshot = projectionSource([
      included(first),
      { eligibility: "exclude", foodId: "private-1", reason: "private" },
      included(second),
    ]);

    const result = await rebuildFoodSearchIndex({
      client: admin,
      source: snapshot.source,
      generationId: "release_20260815",
      batchSize: 1,
    });

    expect(result).toEqual({
      stableIndex: "foods",
      generationIndex: "foods__generation__release_20260815",
      projectionRevision: "42",
      includedCount: 2,
      excludedCount: 1,
      exclusions: {
        archived: 0,
        "inactive-source": 0,
        "not-current-version": 0,
        private: 1,
        quarantined: 0,
      },
      cleanup: { status: "completed" },
    });
    expect(admin.addedBatchSizes).toEqual([1, 1]);
    expect([...(admin.indexes.get("foods")?.keys() ?? [])]).toEqual(["new_1", "new_2"]);
    expect(admin.indexes.has(result.generationIndex)).toBe(false);
    expect(admin.swapCount).toBe(1);
    expect(snapshot.wasClosed()).toBe(true);
  });

  it("closes the snapshot and cleans the generation when streaming or source counts fail", async () => {
    const admin = new MemoryIndexAdmin();
    const snapshot = projectionSource([included(foodDocument())], {
      expected: 2,
      throwDuringStream: true,
    });
    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: snapshot.source,
        generationId: "stream_failure",
      }),
    ).rejects.toThrow("projection stream failed");
    expect(snapshot.wasClosed()).toBe(true);
    expect(admin.swapCount).toBe(0);
    expect(admin.indexes.has(FOOD_SEARCH_STABLE_INDEX)).toBe(false);
    expect(admin.indexes.has("foods__generation__stream_failure")).toBe(false);
  });

  it("detects duplicate primary keys through generation count verification", async () => {
    const admin = new MemoryIndexAdmin();
    const duplicate = foodDocument({ id: "same", foodId: "1" });
    const snapshot = projectionSource([
      included(duplicate),
      included({ ...duplicate, foodVersionId: "12" }),
    ]);
    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: snapshot.source,
        generationId: "duplicates",
        batchSize: 1,
      }),
    ).rejects.toMatchObject({ code: "INDEX_COUNT_MISMATCH" });
    expect(admin.swapCount).toBe(0);
    expect(admin.indexes.has("foods__generation__duplicates")).toBe(false);
  });

  it("atomically rolls back after post-swap verification failure before cleanup", async () => {
    const admin = new MemoryIndexAdmin();
    const old = foodDocument({ id: "old", foodId: "90", foodVersionId: "901" });
    admin.indexes.set("foods", new Map([[old.id, old]]));
    admin.postSwapStatsOverride = 999;
    const snapshot = projectionSource([
      included(foodDocument({ id: "new_1", foodId: "1" })),
      included(foodDocument({ id: "new_2", foodId: "2", foodVersionId: "21" })),
    ]);

    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: snapshot.source,
        generationId: "rollback",
      }),
    ).rejects.toMatchObject({ code: "POST_SWAP_COUNT_MISMATCH" });
    expect(admin.swapCount).toBe(2);
    expect([...(admin.indexes.get("foods")?.keys() ?? [])]).toEqual(["old"]);
    expect(admin.indexes.has("foods__generation__rollback")).toBe(false);
  });

  it("retains the known-good generation when rollback fails and reports both errors", async () => {
    const admin = new MemoryIndexAdmin();
    const old = foodDocument({ id: "old", foodId: "90", foodVersionId: "901" });
    admin.indexes.set("foods", new Map([[old.id, old]]));
    admin.postSwapStatsOverride = 999;
    admin.failRollback = true;
    const snapshot = projectionSource([included(foodDocument({ id: "new", foodId: "1" }))]);

    const error = await rebuildFoodSearchIndex({
      client: admin,
      source: snapshot.source,
      generationId: "rollback_failure",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toContain("atomic rollback also failed");
    expect(admin.indexes.has("foods__generation__rollback_failure")).toBe(true);
  });

  it("reports displaced-index cleanup debt without failing an already verified publication", async () => {
    const admin = new MemoryIndexAdmin();
    const old = foodDocument({ id: "old", foodId: "90", foodVersionId: "901" });
    admin.indexes.set("foods", new Map([[old.id, old]]));
    admin.failDelete = true;
    const current = foodDocument({ id: "new", foodId: "1" });

    const result = await rebuildFoodSearchIndex({
      client: admin,
      source: projectionSource([included(current)]).source,
      generationId: "cleanup_debt",
    });

    expect(result.cleanup).toEqual({
      status: "pending",
      indexUid: "foods__generation__cleanup_debt",
      errorCode: "DISPLACED_INDEX_DELETE_FAILED",
    });
    expect([...(admin.indexes.get("foods")?.keys() ?? [])]).toEqual(["new"]);
    expect(admin.indexes.has("foods__generation__cleanup_debt")).toBe(true);
    expect(admin.swapCount).toBe(1);
  });

  it("removes a just-in-time empty placeholder when first-publication verification rolls back", async () => {
    const admin = new MemoryIndexAdmin();
    admin.postSwapStatsOverride = 999;
    const snapshot = projectionSource([included(foodDocument({ id: "new", foodId: "1" }))]);

    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: snapshot.source,
        generationId: "initial_rollback",
      }),
    ).rejects.toMatchObject({ code: "POST_SWAP_COUNT_MISMATCH" });
    expect(admin.swapCount).toBe(2);
    expect(admin.indexes.has(FOOD_SEARCH_STABLE_INDEX)).toBe(false);
    expect(admin.indexes.has("foods__generation__initial_rollback")).toBe(false);
  });

  it("cleans an accepted cold-start placeholder when its create response is lost", async () => {
    const admin = new MemoryIndexAdmin();
    admin.failStableCreateResponse = true;

    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: projectionSource([included(foodDocument())]).source,
        generationId: "placeholder_response_loss",
      }),
    ).rejects.toThrow("stable create response lost");
    expect(admin.swapCount).toBe(0);
    expect(admin.indexes.has(FOOD_SEARCH_STABLE_INDEX)).toBe(false);
    expect(admin.indexes.has("foods__generation__placeholder_response_loss")).toBe(false);
  });

  it("refuses to overwrite a pre-existing generation index", async () => {
    const admin = new MemoryIndexAdmin();
    admin.indexes.set("foods__generation__collision", new Map());
    const snapshot = projectionSource([]);
    await expect(
      rebuildFoodSearchIndex({
        client: admin,
        source: snapshot.source,
        generationId: "collision",
      }),
    ).rejects.toBeInstanceOf(FoodSearchError);
    expect(snapshot.wasClosed()).toBe(false);
  });
});
