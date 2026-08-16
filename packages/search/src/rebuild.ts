import { randomUUID } from "node:crypto";
import { assertFoodSearchDocument } from "./document.js";
import { FoodSearchError } from "./errors.js";
import { FOOD_SEARCH_INDEX_SETTINGS } from "./settings.js";
import type {
  FoodProjectionExclusionReason,
  FoodSearchDocument,
  FoodSearchProjectionSnapshot,
  FoodSearchProjectionSource,
} from "./types.js";
import { FOOD_SEARCH_STABLE_INDEX } from "./types.js";

export interface FoodSearchIndexAdmin {
  createIndex(uid: string, primaryKey?: string, signal?: AbortSignal): Promise<number>;
  indexExists(uid: string, signal?: AbortSignal): Promise<boolean>;
  updateSettings(uid: string, settings: unknown, signal?: AbortSignal): Promise<number>;
  addDocuments(
    uid: string,
    documents: readonly FoodSearchDocument[],
    signal?: AbortSignal,
  ): Promise<number>;
  getIndexStats(uid: string, signal?: AbortSignal): Promise<{ readonly numberOfDocuments: number }>;
  swapIndexes(leftUid: string, rightUid: string, signal?: AbortSignal): Promise<number>;
  deleteIndex(uid: string, signal?: AbortSignal): Promise<number>;
  waitForTask(
    taskUid: number,
    options?: {
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<void>;
}

export interface RebuildFoodSearchIndexOptions {
  readonly client: FoodSearchIndexAdmin;
  readonly source: FoodSearchProjectionSource;
  /** Production authority check performed after indexing and immediately before publication. */
  readonly assertProjectionCurrent?: (
    projectionRevision: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly generationId?: string;
  readonly batchSize?: number;
  readonly taskTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RebuildFoodSearchIndexResult {
  readonly stableIndex: typeof FOOD_SEARCH_STABLE_INDEX;
  readonly generationIndex: string;
  /** Authority revision whose exact rows were published. */
  readonly projectionRevision: string;
  readonly includedCount: number;
  readonly excludedCount: number;
  readonly exclusions: Readonly<Record<FoodProjectionExclusionReason, number>>;
  /** Cleanup debt never invalidates an already verified atomic publication. */
  readonly cleanup:
    | { readonly status: "completed" }
    | {
        readonly status: "pending";
        readonly indexUid: string;
        readonly errorCode: "DISPLACED_INDEX_DELETE_FAILED";
      };
}

const EMPTY_EXCLUSIONS: Readonly<Record<FoodProjectionExclusionReason, number>> = {
  archived: 0,
  "inactive-source": 0,
  "not-current-version": 0,
  private: 0,
  quarantined: 0,
};

function generationIndexUid(generationId: string | undefined): string {
  const id = generationId ?? `${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new TypeError("generationId contains unsupported characters");
  }
  return `${FOOD_SEARCH_STABLE_INDEX}__generation__${id}`;
}

async function waitForTask(
  client: FoodSearchIndexAdmin,
  taskUid: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await client.waitForTask(taskUid, { timeoutMs, signal });
}

async function closeSnapshot(
  snapshot: FoodSearchProjectionSnapshot,
  primaryError: unknown,
): Promise<void> {
  try {
    await snapshot.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "projection failed and snapshot close failed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

export async function rebuildFoodSearchIndex(
  options: RebuildFoodSearchIndexOptions,
): Promise<RebuildFoodSearchIndexResult> {
  const batchSize = options.batchSize ?? 1_000;
  const taskTimeoutMs = options.taskTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new TypeError("batchSize must be an integer between 1 and 10000");
  }
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1) {
    throw new TypeError("taskTimeoutMs must be a positive integer");
  }

  const generationIndex = generationIndexUid(options.generationId);
  if (await options.client.indexExists(generationIndex, options.signal)) {
    throw new FoodSearchError(
      "GENERATION_INDEX_EXISTS",
      `refusing to overwrite existing generation index ${generationIndex}`,
    );
  }

  let generationCreated = false;
  let stablePlaceholderCreated = false;
  let swapConfirmed = false;
  let swapRolledBack = false;
  let swapSubmitted = false;
  let operationError: unknown;
  let cleanup: RebuildFoodSearchIndexResult["cleanup"] = { status: "completed" };
  let result: Omit<RebuildFoodSearchIndexResult, "cleanup"> | undefined;
  try {
    const createTask = await options.client.createIndex(generationIndex, "id", options.signal);
    generationCreated = true;
    await waitForTask(options.client, createTask, taskTimeoutMs, options.signal);
    const settingsTask = await options.client.updateSettings(
      generationIndex,
      FOOD_SEARCH_INDEX_SETTINGS,
      options.signal,
    );
    await waitForTask(options.client, settingsTask, taskTimeoutMs, options.signal);

    const snapshot = await options.source.openSnapshot(options.signal);
    let snapshotError: unknown;
    let includedCount = 0;
    let excludedCount = 0;
    const exclusions: Record<FoodProjectionExclusionReason, number> = { ...EMPTY_EXCLUSIONS };
    try {
      if (
        !Number.isSafeInteger(snapshot.expectedIncludedCount) ||
        snapshot.expectedIncludedCount < 0
      ) {
        throw new FoodSearchError(
          "INVALID_PROJECTION_COUNT",
          "projection snapshot returned an invalid expected count",
        );
      }
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(snapshot.projectionRevision)) {
        throw new FoodSearchError(
          "INVALID_PROJECTION_REVISION",
          "projection snapshot returned an invalid authority revision",
        );
      }
      let batch: FoodSearchDocument[] = [];
      for await (const row of snapshot.stream(options.signal)) {
        options.signal?.throwIfAborted();
        if (row.eligibility === "exclude") {
          excludedCount += 1;
          exclusions[row.reason] += 1;
          continue;
        }
        assertFoodSearchDocument(row.document);
        batch.push(row.document);
        includedCount += 1;
        if (batch.length >= batchSize) {
          const task = await options.client.addDocuments(generationIndex, batch, options.signal);
          await waitForTask(options.client, task, taskTimeoutMs, options.signal);
          batch = [];
        }
      }
      if (batch.length > 0) {
        const task = await options.client.addDocuments(generationIndex, batch, options.signal);
        await waitForTask(options.client, task, taskTimeoutMs, options.signal);
      }
      if (includedCount !== snapshot.expectedIncludedCount) {
        throw new FoodSearchError(
          "PROJECTION_COUNT_MISMATCH",
          `projection expected ${snapshot.expectedIncludedCount} documents but emitted ${includedCount}`,
        );
      }
    } catch (error) {
      snapshotError = error;
    }
    await closeSnapshot(snapshot, snapshotError);

    const generationStats = await options.client.getIndexStats(generationIndex, options.signal);
    if (generationStats.numberOfDocuments !== includedCount) {
      throw new FoodSearchError(
        "INDEX_COUNT_MISMATCH",
        `generation index contains ${generationStats.numberOfDocuments} documents; expected ${includedCount}`,
      );
    }

    await options.assertProjectionCurrent?.(snapshot.projectionRevision, options.signal);

    // Do not expose a successful empty stable index while the first generation is still building.
    // Until this just-in-time placeholder exists, keyword requests fail and can use DB degradation.
    if (!(await options.client.indexExists(FOOD_SEARCH_STABLE_INDEX, options.signal))) {
      // Set before the POST because a lost response is ambiguous: cleanup must still enqueue a
      // delete after a possibly accepted create task.
      stablePlaceholderCreated = true;
      const stableTask = await options.client.createIndex(
        FOOD_SEARCH_STABLE_INDEX,
        "id",
        options.signal,
      );
      await waitForTask(options.client, stableTask, taskTimeoutMs, options.signal);
    }

    swapSubmitted = true;
    const swapTask = await options.client.swapIndexes(
      FOOD_SEARCH_STABLE_INDEX,
      generationIndex,
      options.signal,
    );
    await waitForTask(options.client, swapTask, taskTimeoutMs, options.signal);
    swapConfirmed = true;
    const stableStats = await options.client.getIndexStats(
      FOOD_SEARCH_STABLE_INDEX,
      options.signal,
    );
    if (stableStats.numberOfDocuments !== includedCount) {
      throw new FoodSearchError(
        "POST_SWAP_COUNT_MISMATCH",
        `stable index contains ${stableStats.numberOfDocuments} documents after swap; expected ${includedCount}`,
      );
    }

    result = {
      stableIndex: FOOD_SEARCH_STABLE_INDEX,
      generationIndex,
      projectionRevision: snapshot.projectionRevision,
      includedCount,
      excludedCount,
      exclusions,
    };
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    let mayDeleteGeneration = !swapSubmitted || operationError === undefined;
    if (operationError !== undefined && swapConfirmed) {
      try {
        const rollbackTask = await options.client.swapIndexes(
          FOOD_SEARCH_STABLE_INDEX,
          generationIndex,
        );
        await options.client.waitForTask(rollbackTask, { timeoutMs: taskTimeoutMs });
        swapConfirmed = false;
        swapRolledBack = true;
        mayDeleteGeneration = true;
      } catch (rollbackError) {
        mayDeleteGeneration = false;
        operationError = new AggregateError(
          [operationError, rollbackError],
          "post-swap verification failed and atomic rollback also failed",
        );
      }
    }
    // An unconfirmed swap task has ambiguous state; retain both indexes for operator recovery.
    if (generationCreated && mayDeleteGeneration) {
      try {
        const deleteTask = await options.client.deleteIndex(generationIndex);
        await options.client.waitForTask(deleteTask, { timeoutMs: taskTimeoutMs });
      } catch (cleanupError) {
        if (operationError === undefined && result !== undefined) {
          cleanup = {
            status: "pending",
            indexUid: generationIndex,
            errorCode: "DISPLACED_INDEX_DELETE_FAILED",
          };
        } else {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    const mayDeletePlaceholder =
      stablePlaceholderCreated &&
      operationError !== undefined &&
      (!swapSubmitted || swapRolledBack);
    if (mayDeletePlaceholder) {
      try {
        const deleteTask = await options.client.deleteIndex(FOOD_SEARCH_STABLE_INDEX);
        await options.client.waitForTask(deleteTask, { timeoutMs: taskTimeoutMs });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      operationError = new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "search rebuild failed and index cleanup also failed",
      );
    }
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (result === undefined) {
    throw new FoodSearchError("REBUILD_INCOMPLETE", "search rebuild completed without a result");
  }
  return { ...result, cleanup };
}
