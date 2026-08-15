import { sha256CanonicalJson } from "./deterministic.js";
import { IngestionError, invariant } from "./errors.js";

export interface BatchIdentity {
  readonly sourceCode: string;
  readonly releaseKey: string;
  readonly artifactSha256: string;
  readonly parserVersion: string;
}

export interface BatchCheckpoint extends BatchIdentity {
  readonly revision: number;
  readonly lastCursor: string | null;
  readonly processedRecords: number;
  readonly acceptedRecords: number;
  readonly quarantinedRecords: number;
  readonly updatedAt: string;
}

export interface BatchCheckpointStore {
  readonly load: (identity: BatchIdentity) => Promise<BatchCheckpoint | null>;
  /** Optimistic compare-and-set; implementations must reject stale revisions. */
  readonly save: (
    checkpoint: BatchCheckpoint,
    expectedRevision: number | null,
  ) => Promise<BatchCheckpoint>;
}

export interface BatchPage<T> {
  readonly cursor: string;
  readonly records: readonly T[];
  readonly acceptedRecords: number;
  readonly quarantinedRecords: number;
}

export interface IdempotentBatchSink<T> {
  /**
   * The sink must atomically remember idempotencyKey with its writes. Replaying
   * an applied key returns already-applied without duplicating records.
   */
  readonly apply: (input: {
    readonly identity: BatchIdentity;
    readonly cursor: string;
    readonly idempotencyKey: string;
    readonly records: readonly T[];
  }) => Promise<"already-applied" | "applied">;
}

export interface RunResumableBatchOptions<T> {
  readonly identity: BatchIdentity;
  readonly checkpoints: BatchCheckpointStore;
  readonly sink: IdempotentBatchSink<T>;
  readonly pagesAfter: (cursor: string | null) => AsyncIterable<BatchPage<T>>;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface BatchRunResult {
  readonly checkpoint: BatchCheckpoint;
  readonly appliedPages: number;
  readonly replayedPages: number;
}

/**
 * Coordinates resumable pages without pretending checkpoint storage alone is
 * exactly-once. Exactly-once effects come from the sink's idempotency key; a
 * crash after sink.apply but before checkpoint.save safely replays that key.
 */
export async function runResumableBatch<T>(
  options: RunResumableBatchOptions<T>,
): Promise<BatchRunResult> {
  validateIdentity(options.identity);
  let checkpoint = await options.checkpoints.load(options.identity);
  if (checkpoint) {
    validateCheckpoint(checkpoint, options.identity);
  } else {
    checkpoint = initialCheckpoint(options.identity, options.now);
  }
  let appliedPages = 0;
  let replayedPages = 0;
  const seenCursors = new Set<string>();
  for await (const page of options.pagesAfter(checkpoint.lastCursor)) {
    throwIfAborted(options.signal);
    validatePage(page);
    invariant(
      page.cursor !== checkpoint.lastCursor && !seenCursors.has(page.cursor),
      "DUPLICATE_KEY",
      "Batch page cursor did not advance",
      { cursor: page.cursor },
    );
    seenCursors.add(page.cursor);
    const idempotencyKey = createBatchIdempotencyKey(options.identity, page);
    const result = await options.sink.apply({
      identity: options.identity,
      cursor: page.cursor,
      idempotencyKey,
      records: page.records,
    });
    if (result === "applied") {
      appliedPages += 1;
    } else {
      replayedPages += 1;
    }
    const expectedRevision = checkpoint.revision === 0 ? null : checkpoint.revision;
    const next: BatchCheckpoint = Object.freeze({
      ...options.identity,
      revision: checkpoint.revision + 1,
      lastCursor: page.cursor,
      processedRecords: checkpoint.processedRecords + page.records.length,
      acceptedRecords: checkpoint.acceptedRecords + page.acceptedRecords,
      quarantinedRecords: checkpoint.quarantinedRecords + page.quarantinedRecords,
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    });
    try {
      checkpoint = await options.checkpoints.save(next, expectedRevision);
    } catch (error) {
      throw new IngestionError(
        "CHECKPOINT_CONFLICT",
        "Failed to advance the ingestion checkpoint",
        { expectedRevision, cursor: page.cursor, idempotencyKey },
        { cause: error },
      );
    }
    validateCheckpoint(checkpoint, options.identity);
    invariant(
      checkpoint.revision === next.revision &&
        checkpoint.lastCursor === next.lastCursor &&
        checkpoint.processedRecords === next.processedRecords &&
        checkpoint.acceptedRecords === next.acceptedRecords &&
        checkpoint.quarantinedRecords === next.quarantinedRecords,
      "CHECKPOINT_CONFLICT",
      "Checkpoint store did not persist the requested advancement",
      { cursor: page.cursor },
    );
  }
  return Object.freeze({ checkpoint, appliedPages, replayedPages });
}

export function createBatchIdempotencyKey<T>(identity: BatchIdentity, page: BatchPage<T>): string {
  return sha256CanonicalJson({
    schemaVersion: 1,
    identity,
    cursor: page.cursor,
    acceptedRecords: page.acceptedRecords,
    quarantinedRecords: page.quarantinedRecords,
    records: page.records,
  });
}

function initialCheckpoint(identity: BatchIdentity, now?: () => Date): BatchCheckpoint {
  return Object.freeze({
    ...identity,
    revision: 0,
    lastCursor: null,
    processedRecords: 0,
    acceptedRecords: 0,
    quarantinedRecords: 0,
    updatedAt: (now?.() ?? new Date()).toISOString(),
  });
}

function validateIdentity(identity: BatchIdentity): void {
  invariant(
    identity.sourceCode.trim().length > 0,
    "INVALID_RECORD",
    "Batch source code is required",
  );
  invariant(
    identity.releaseKey.trim().length > 0,
    "INVALID_RECORD",
    "Batch release key is required",
  );
  invariant(
    /^[0-9a-f]{64}$/.test(identity.artifactSha256),
    "INVALID_RECORD",
    "Batch artifact SHA-256 is invalid",
  );
  invariant(
    identity.parserVersion.trim().length > 0,
    "INVALID_RECORD",
    "Batch parser version is required",
  );
}

function validateCheckpoint(checkpoint: BatchCheckpoint, identity: BatchIdentity): void {
  invariant(
    checkpoint.sourceCode === identity.sourceCode &&
      checkpoint.releaseKey === identity.releaseKey &&
      checkpoint.artifactSha256 === identity.artifactSha256 &&
      checkpoint.parserVersion === identity.parserVersion,
    "CHECKPOINT_CONFLICT",
    "Checkpoint belongs to a different import identity",
  );
  for (const [field, value] of Object.entries({
    revision: checkpoint.revision,
    processedRecords: checkpoint.processedRecords,
    acceptedRecords: checkpoint.acceptedRecords,
    quarantinedRecords: checkpoint.quarantinedRecords,
  })) {
    invariant(
      Number.isSafeInteger(value) && value >= 0,
      "CHECKPOINT_CONFLICT",
      `Checkpoint ${field} is invalid`,
    );
  }
  invariant(
    checkpoint.acceptedRecords + checkpoint.quarantinedRecords === checkpoint.processedRecords,
    "CHECKPOINT_CONFLICT",
    "Checkpoint counters are inconsistent",
  );
}

function validatePage<T>(page: BatchPage<T>): void {
  invariant(page.cursor.trim().length > 0, "INVALID_RECORD", "Batch page cursor is required");
  invariant(page.records.length > 0, "INVALID_RECORD", "Batch page cannot be empty");
  invariant(
    Number.isSafeInteger(page.acceptedRecords) &&
      Number.isSafeInteger(page.quarantinedRecords) &&
      page.acceptedRecords >= 0 &&
      page.quarantinedRecords >= 0 &&
      page.acceptedRecords + page.quarantinedRecords === page.records.length,
    "INVALID_RECORD",
    "Batch page counters are inconsistent",
    { cursor: page.cursor },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IngestionError(
      "ABORTED",
      "Batch processing was aborted",
      {},
      { cause: signal.reason },
    );
  }
}
