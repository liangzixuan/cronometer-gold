import { createReadStream } from "node:fs";
import { chmod, type FileHandle, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

import {
  consumeFoodSearchProjectionSnapshot,
  type FoodSearchProjectionSnapshotPage,
} from "@nutrition-tracker/db";
import {
  assertFoodSearchDocument,
  type FoodSearchProjectionRow,
  type FoodSearchProjectionSource,
  toFoodSearchDocument,
} from "@nutrition-tracker/search";

type FoodSearchDatabase = Parameters<typeof consumeFoodSearchProjectionSnapshot>[0];

const DEFAULT_SPOOL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SPOOL_MAX_DOCUMENTS = 5_000_000;
const MAX_SPOOL_LINE_BYTES = 1_048_576;
const SPOOL_PREFIX = "nutrition-food-search-";

export interface FoodSearchProjectionSpoolOptions {
  /** Absolute encrypted/ephemeral volume path in production; OS temp by default. */
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly maxDocuments?: number;
}

export class FoodSearchProjectionSpoolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoodSearchProjectionSpoolLimitError";
  }
}

function positiveBound(value: number | undefined, fallback: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return candidate;
}

function parseExpectedCount(value: string, maximum: number): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error("food-search snapshot returned an invalid document count");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new Error("food-search snapshot is too large for this worker build");
  }
  if (count > maximum) {
    throw new FoodSearchProjectionSpoolLimitError(
      `food-search snapshot exceeds the configured ${maximum} document spool limit`,
    );
  }
  return count;
}

function projectionRows(
  page: FoodSearchProjectionSnapshotPage,
): readonly FoodSearchProjectionRow[] {
  return page.documents.map((document) => ({
    eligibility: "include" as const,
    document: toFoodSearchDocument(document),
  }));
}

function parseProjectionRow(line: string): FoodSearchProjectionRow {
  if (Buffer.byteLength(line, "utf8") > MAX_SPOOL_LINE_BYTES) {
    throw new Error("food-search projection spool line exceeds its safety bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error("food-search projection spool contains invalid JSON", { cause });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("eligibility" in value) ||
    value.eligibility !== "include" ||
    !("document" in value)
  ) {
    throw new Error("food-search projection spool contains an invalid row envelope");
  }
  assertFoodSearchDocument(value.document);
  return { eligibility: "include", document: value.document };
}

async function secureSpoolDirectory(directory: string | undefined): Promise<string> {
  const parent = directory ?? tmpdir();
  if (directory !== undefined) {
    if (!isAbsolute(directory)) {
      throw new Error("SEARCH_REBUILD_SPOOL_DIR must be an absolute path");
    }
    await mkdir(directory, { mode: 0o700, recursive: true });
  }
  const spoolDirectory = await mkdtemp(join(parent, SPOOL_PREFIX));
  try {
    await chmod(spoolDirectory, 0o700);
    return spoolDirectory;
  } catch (error) {
    await rm(spoolDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function closeFile(file: FileHandle | undefined): Promise<void> {
  if (!file) return;
  await file.close();
}

/**
 * Spool one coherent DB snapshot to a bounded 0600 NDJSON artifact, then close
 * PostgreSQL before Meilisearch task waits begin. The disposable file contains
 * only the public promoted projection and is deleted when the snapshot closes.
 */
export function createPostgresFoodSearchProjectionSource(
  database: FoodSearchDatabase,
  pageSize: number,
  options: FoodSearchProjectionSpoolOptions = {},
): FoodSearchProjectionSource {
  const maxBytes = positiveBound(options.maxBytes, DEFAULT_SPOOL_MAX_BYTES, "maxBytes");
  const maxDocuments = positiveBound(
    options.maxDocuments,
    DEFAULT_SPOOL_MAX_DOCUMENTS,
    "maxDocuments",
  );
  return {
    async openSnapshot(signal) {
      signal?.throwIfAborted();
      const spoolDirectory = await secureSpoolDirectory(options.directory);
      const spoolPath = join(spoolDirectory, "projection.ndjson");
      let file: FileHandle | undefined;
      let fileClosed = false;
      let bytesWritten = 0;
      let documentsWritten = 0;
      try {
        file = await open(spoolPath, "wx", 0o600);
        const result = await consumeFoodSearchProjectionSnapshot(
          database,
          {
            pageSize,
            async finalize(snapshotResult) {
              parseExpectedCount(snapshotResult.expectedDocumentCount, maxDocuments);
              if (documentsWritten !== Number(snapshotResult.consumedDocumentCount)) {
                throw new Error("food-search spool count changed before snapshot finalization");
              }
              await file?.sync();
              await closeFile(file);
              fileClosed = true;
              file = undefined;
            },
          },
          async (page) => {
            signal?.throwIfAborted();
            parseExpectedCount(page.snapshot.expectedDocumentCount, maxDocuments);
            const rows = projectionRows(page);
            if (documentsWritten + rows.length > maxDocuments) {
              throw new FoodSearchProjectionSpoolLimitError(
                `food-search projection exceeds the configured ${maxDocuments} document spool limit`,
              );
            }
            const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
            const payloadBytes = Buffer.byteLength(payload, "utf8");
            if (bytesWritten + payloadBytes > maxBytes) {
              throw new FoodSearchProjectionSpoolLimitError(
                `food-search projection exceeds the configured ${maxBytes} byte spool limit`,
              );
            }
            await file?.writeFile(payload, { encoding: "utf8" });
            bytesWritten += payloadBytes;
            documentsWritten += rows.length;
          },
        );
        const expectedIncludedCount = parseExpectedCount(
          result.expectedDocumentCount,
          maxDocuments,
        );
        if (!fileClosed) {
          throw new Error("food-search projection spool was not finalized inside its DB snapshot");
        }

        let closed = false;
        let streamStarted = false;
        return {
          expectedIncludedCount,
          projectionRevision: result.revision,
          async *stream(streamSignal) {
            if (closed) throw new Error("food-search projection spool is closed");
            if (streamStarted) throw new Error("food-search projection spool supports one reader");
            streamStarted = true;
            streamSignal?.throwIfAborted();
            const input = createReadStream(spoolPath, {
              encoding: "utf8",
              ...(streamSignal === undefined ? {} : { signal: streamSignal }),
            });
            const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
            try {
              for await (const line of lines) {
                streamSignal?.throwIfAborted();
                if (line.length === 0) continue;
                yield parseProjectionRow(line);
              }
            } finally {
              lines.close();
              input.destroy();
            }
          },
          async close() {
            if (closed) return;
            closed = true;
            await rm(spoolDirectory, { force: true, recursive: true });
          },
        };
      } catch (error) {
        try {
          if (!fileClosed) await closeFile(file);
        } finally {
          await rm(spoolDirectory, { force: true, recursive: true });
        }
        throw error;
      }
    },
  };
}
