import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { EncryptedArtifactMetadata, EncryptedArtifactStore } from "./artifact-encryption.js";
import {
  deriveErasureLedgerLocator,
  type ErasureLedgerLocatorKeyRing,
  erasureLedgerLocatorCandidates,
} from "./erasure-ledger-locator.js";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LEDGER_PLAINTEXT_BYTES = 16_384;

export interface ErasureReplayLedgerEntry {
  readonly formatVersion: "nutrition-erasure-replay-ledger-v1";
  readonly jobId: string;
  readonly ledgerEntryId: string;
  /** Time the durable restore tombstone was authenticated, before destructive deletion. */
  readonly recordedAt: string;
  readonly restoreLocator: string;
  readonly subjectUserId: string;
}

export interface ErasureReplayLedgerReceipt {
  readonly acknowledgedAt: string;
  readonly ackDigest: string;
  readonly metadata: EncryptedArtifactMetadata;
  readonly reference: string;
  readonly replayed: boolean;
}

export class ErasureReplayLedgerAuthenticationError extends Error {
  constructor() {
    super("Erasure replay ledger authentication failed");
    this.name = "ErasureReplayLedgerAuthenticationError";
  }
}

export class ErasureReplayLedgerConflictError extends Error {
  constructor() {
    super("Conflicting erasure replay ledger entry");
    this.name = "ErasureReplayLedgerConflictError";
  }
}

function canonicalInstant(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError("Erasure replay ledger timestamp must be canonical UTC");
  }
  return value;
}

function canonicalUuid(value: string): string {
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError("Erasure replay ledger identifier must be a canonical UUID");
  }
  return value;
}

function entryJson(entry: ErasureReplayLedgerEntry): string {
  // Keys are deliberately emitted in Unicode/code-point order. The closed shape
  // avoids a dependency on application contracts in this Node-only package.
  return JSON.stringify({
    formatVersion: entry.formatVersion,
    jobId: canonicalUuid(entry.jobId),
    ledgerEntryId: canonicalUuid(entry.ledgerEntryId),
    recordedAt: canonicalInstant(entry.recordedAt),
    restoreLocator: entry.restoreLocator,
    subjectUserId: canonicalUuid(entry.subjectUserId),
  });
}

/** Digest persisted in the application receipt and supplied during offline restore replay. */
export function erasureReplayLedgerEntryDigest(entry: ErasureReplayLedgerEntry): string {
  return createHash("sha256").update(entryJson(entry), "utf8").digest("hex");
}

async function collectBounded(stream: Readable, expectedLength: number): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    expectedLength > MAX_LEDGER_PLAINTEXT_BYTES
  ) {
    throw new ErasureReplayLedgerAuthenticationError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > expectedLength) throw new ErasureReplayLedgerAuthenticationError();
    chunks.push(bytes);
  }
  if (length !== expectedLength) throw new ErasureReplayLedgerAuthenticationError();
  return Buffer.concat(chunks);
}

function parseEntry(value: Buffer): ErasureReplayLedgerEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new ErasureReplayLedgerAuthenticationError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype ||
    Object.keys(parsed).sort().join(",") !==
      "formatVersion,jobId,ledgerEntryId,recordedAt,restoreLocator,subjectUserId"
  ) {
    throw new ErasureReplayLedgerAuthenticationError();
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.formatVersion !== "nutrition-erasure-replay-ledger-v1" ||
    typeof candidate.jobId !== "string" ||
    typeof candidate.ledgerEntryId !== "string" ||
    typeof candidate.recordedAt !== "string" ||
    typeof candidate.restoreLocator !== "string" ||
    typeof candidate.subjectUserId !== "string"
  ) {
    throw new ErasureReplayLedgerAuthenticationError();
  }
  try {
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: candidate.formatVersion,
      jobId: canonicalUuid(candidate.jobId),
      ledgerEntryId: canonicalUuid(candidate.ledgerEntryId),
      recordedAt: canonicalInstant(candidate.recordedAt),
      restoreLocator: candidate.restoreLocator,
      subjectUserId: canonicalUuid(candidate.subjectUserId),
    };
    if (entryJson(entry) !== value.toString("utf8")) {
      throw new ErasureReplayLedgerAuthenticationError();
    }
    return entry;
  } catch (error) {
    if (error instanceof ErasureReplayLedgerAuthenticationError) throw error;
    throw new ErasureReplayLedgerAuthenticationError();
  }
}

export class EncryptedErasureReplayLedger {
  readonly #artifactStore: EncryptedArtifactStore;
  readonly #locatorKeyRing: ErasureLedgerLocatorKeyRing;
  readonly #clock: () => Date;

  constructor(input: {
    readonly artifactStore: EncryptedArtifactStore;
    readonly locatorKeyRing: ErasureLedgerLocatorKeyRing;
    readonly clock?: () => Date;
  }) {
    this.#artifactStore = input.artifactStore;
    this.#locatorKeyRing = input.locatorKeyRing;
    this.#clock = input.clock ?? (() => new Date());
  }

  locatorForSubject(userId: string): string {
    return deriveErasureLedgerLocator(this.#locatorKeyRing, userId).value;
  }

  async append(input: {
    readonly subjectUserId: string;
    readonly jobId: string;
    readonly recordedAt: string;
    readonly restoreLocator: string;
    readonly signal?: AbortSignal;
  }): Promise<ErasureReplayLedgerReceipt> {
    const parsedLocator = /^v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([0-9a-f]{64})$/.exec(
      input.restoreLocator,
    );
    if (!parsedLocator) throw new ErasureReplayLedgerConflictError();
    const locatorKeyId = parsedLocator[1];
    if (!locatorKeyId) throw new ErasureReplayLedgerConflictError();
    // A queued job remains executable after current-key rotation as long as the
    // exact locator key generation used at request time is still retained.
    const locator = deriveErasureLedgerLocator(
      this.#locatorKeyRing,
      input.subjectUserId,
      locatorKeyId,
    );
    if (input.restoreLocator !== locator.value) throw new ErasureReplayLedgerConflictError();
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: "nutrition-erasure-replay-ledger-v1",
      jobId: input.jobId,
      ledgerEntryId: input.jobId,
      recordedAt: input.recordedAt,
      restoreLocator: locator.value,
      subjectUserId: input.subjectUserId,
    };
    const bytes = Buffer.from(entryJson(entry), "utf8");
    if (bytes.byteLength > MAX_LEDGER_PLAINTEXT_BYTES) {
      throw new ErasureReplayLedgerConflictError();
    }
    let metadata: EncryptedArtifactMetadata | null = null;
    let replayed = false;
    let writeError: unknown;
    try {
      metadata = await this.#artifactStore.put({
        mediaType: "application/json",
        objectKey: locator.objectKey,
        plaintextBytes: bytes.byteLength,
        source: Readable.from([bytes]),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      writeError = error;
      replayed = true;
    }

    const verified = await this.#artifactStore.openAuthenticatedByObject({
      mediaType: "application/json",
      objectKey: locator.objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!verified) {
      if (writeError) throw writeError;
      throw new ErasureReplayLedgerAuthenticationError();
    }
    try {
      const existing = await collectBounded(verified.stream, verified.contentLength);
      if (!existing.equals(bytes)) throw new ErasureReplayLedgerConflictError();
      metadata = verified.metadata;
    } finally {
      await verified.dispose();
    }
    if (
      !metadata ||
      !SHA256_PATTERN.test(metadata.plaintextSha256) ||
      metadata.plaintextSha256 !== erasureReplayLedgerEntryDigest(entry)
    ) {
      throw new ErasureReplayLedgerAuthenticationError();
    }
    return {
      acknowledgedAt: this.#clock().toISOString(),
      ackDigest: metadata.plaintextSha256,
      metadata,
      reference: locator.objectKey,
      replayed,
    };
  }

  async findForSubject(input: {
    readonly subjectUserId: string;
    readonly signal?: AbortSignal;
  }): Promise<ErasureReplayLedgerEntry | null> {
    const matches: ErasureReplayLedgerEntry[] = [];
    for (const locator of erasureLedgerLocatorCandidates(
      this.#locatorKeyRing,
      input.subjectUserId,
    )) {
      const opened = await this.#artifactStore.openAuthenticatedByObject({
        mediaType: "application/json",
        objectKey: locator.objectKey,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!opened) continue;
      try {
        const entry = parseEntry(await collectBounded(opened.stream, opened.contentLength));
        if (
          entry.subjectUserId !== input.subjectUserId ||
          entry.restoreLocator !== locator.value ||
          entryJson(entry).length !== opened.contentLength
        ) {
          throw new ErasureReplayLedgerAuthenticationError();
        }
        matches.push(entry);
      } finally {
        await opened.dispose();
      }
    }
    if (matches.length > 1) throw new ErasureReplayLedgerConflictError();
    return matches[0] ?? null;
  }

  async replaySubject<
    T extends {
      readonly reconciled: boolean;
      readonly remainingRows: Readonly<Record<string, string>>;
    },
  >(input: {
    readonly subjectUserId: string;
    readonly apply: (entry: ErasureReplayLedgerEntry) => Promise<T>;
    readonly signal?: AbortSignal;
  }): Promise<T | null> {
    const entry = await this.findForSubject(input);
    if (!entry) return null;
    const result = await input.apply(entry);
    if (
      result.reconciled !== true ||
      Object.values(result.remainingRows).some((count) => count !== "0")
    ) {
      throw new ErasureReplayLedgerConflictError();
    }
    return result;
  }
}
