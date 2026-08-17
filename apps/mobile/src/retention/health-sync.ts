import type { HealthImportBatchResponse } from "@nutrition-tracker/contracts";

import {
  canonicalJson,
  createSignedHealthImportEnvelope,
  type DeviceSigner,
  type SignedHealthImportEnvelope,
} from "./device-signing";
import type { HealthSyncState, PendingHealthImport } from "./health-cursor";
import type { NativeHealthAdapter } from "./native-health.types";

export interface HealthSyncStore {
  load(): Promise<HealthSyncState>;
  /** Durable write must complete before the first network byte is sent. */
  stage(expectedServerDigest: string | null, pending: PendingHealthImport): Promise<void>;
  /** Atomically promotes pending.nextCursor and clears the exact envelope. */
  accept(batchId: string): Promise<void>;
}

export interface HealthImportTransport {
  send(envelope: SignedHealthImportEnvelope): Promise<HealthImportBatchResponse>;
}

/** Only an ambiguous transport failure is safe to replay with the exact same signed envelope. */
export class RetryableHealthImportTransportError extends Error {
  constructor(message = "The signed health-import response was not received.") {
    super(message);
    this.name = "RetryableHealthImportTransportError";
  }
}

export interface HealthSyncIds {
  nextUuid(): string;
  now(): Date;
}

function validCursorEpoch(value: string): boolean {
  return (
    /^[1-9][0-9]*$/u.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9_223_372_036_854_775_807n
  );
}

function assertImportResponse(
  value: HealthImportBatchResponse,
  recordCount: number,
): HealthImportBatchResponse["data"] {
  const data = value.data;
  if (
    typeof data.replayed !== "boolean" ||
    !Number.isSafeInteger(data.accepted) ||
    !Number.isSafeInteger(data.deleted) ||
    !Number.isSafeInteger(data.duplicates) ||
    data.accepted < 0 ||
    data.deleted < 0 ||
    data.duplicates < 0 ||
    !Array.isArray(data.conflicts) ||
    data.conflicts.length > 1_000 ||
    data.accepted + data.deleted + data.duplicates + data.conflicts.length !== recordCount
  ) {
    throw new TypeError("The signed health-import acknowledgement was invalid.");
  }
  if (data.conflicts.length > 0) {
    throw new Error("A provider revision conflicted with the accepted health-import history.");
  }
  return data;
}

async function sendStableRetry(
  transport: HealthImportTransport,
  envelope: SignedHealthImportEnvelope,
  recordCount: number,
) {
  let response: HealthImportBatchResponse;
  try {
    response = await transport.send(envelope);
  } catch (error) {
    if (!(error instanceof RetryableHealthImportTransportError)) throw error;
    try {
      response = await transport.send(envelope);
    } catch (retryError) {
      throw retryError instanceof RetryableHealthImportTransportError ? error : retryError;
    }
  }
  return assertImportResponse(response, recordCount);
}

/**
 * Imports bounded pages sequentially. Provider cursor advancement happens only on the final
 * accepted page; accepted known revisions are committed after every page so a partial failure
 * can reread the old provider range without resending already accepted revisions.
 */
export async function syncNativeWeight(input: {
  readonly adapter: NativeHealthAdapter;
  readonly cursorStore: HealthSyncStore;
  readonly signer: DeviceSigner;
  readonly transport: HealthImportTransport;
  readonly ids: HealthSyncIds;
  readonly deviceId: string;
  readonly cursorEpoch: string;
  readonly recordedTimeZone: string;
}): Promise<{
  readonly batches: number;
  readonly records: number;
  readonly accepted: number;
  readonly deleted: number;
  readonly duplicates: number;
  readonly fullReconciliation: boolean;
  readonly deletionSemantics: "explicit_only" | "full_snapshot";
  readonly recoveredPendingBatch: boolean;
}> {
  if (!validCursorEpoch(input.cursorEpoch)) {
    throw new TypeError("The health cursor epoch was invalid.");
  }
  let journal = await input.cursorStore.load();
  let batchCount = 0;
  let recordCount = 0;
  let acceptedCount = 0;
  let deletedCount = 0;
  let duplicateCount = 0;
  const recoveredPendingBatch = journal.pending !== null;
  if (journal.pending) {
    const pending = journal.pending;
    if (
      pending.envelope.body.deviceId !== input.deviceId ||
      pending.envelope.body.platform !== input.adapter.platform ||
      pending.envelope.body.cursorEpoch !== input.cursorEpoch
    ) {
      throw new Error(
        "The protected pending health batch belongs to another device registration or cursor epoch.",
      );
    }
    const acknowledgement = await sendStableRetry(
      input.transport,
      pending.envelope,
      pending.envelope.body.records.length,
    );
    await input.cursorStore.accept(pending.envelope.body.batchId);
    batchCount += 1;
    recordCount += pending.envelope.body.records.length;
    acceptedCount += acknowledgement.accepted;
    deletedCount += acknowledgement.deleted;
    duplicateCount += acknowledgement.duplicates;
    journal = await input.cursorStore.load();
    if (journal.pending !== null) {
      throw new Error("The accepted health batch remained in the protected journal.");
    }
    return {
      batches: batchCount,
      records: recordCount,
      accepted: acceptedCount,
      deleted: deletedCount,
      duplicates: duplicateCount,
      fullReconciliation: pending.fullReconciliation,
      deletionSemantics: pending.deletionSemantics,
      recoveredPendingBatch: true,
    };
  }
  let cursor = journal.cursor;
  const plan = await input.adapter.readWeightChanges({
    providerCursor: cursor.providerCursor,
    knownRevisions: cursor.knownRevisions,
    recordedTimeZone: input.recordedTimeZone,
  });
  for (let index = 0; index < plan.pages.length; index += 1) {
    const page = plan.pages[index];
    if (!page || page.records.length > 1_000) {
      throw new RangeError("A native health page exceeded the signed server batch bound.");
    }
    const finalPage = index === plan.pages.length - 1;
    const nextSourceCursor = await input.signer.sha256Hex(
      canonicalJson({
        protocol: "nutrition-tracker-health-cursor-v1",
        priorServerDigest: cursor.serverDigest,
        providerCursor: plan.providerCursor,
        pageIndex: index,
        pageCount: plan.pages.length,
        finalPage,
        records: page.records,
      }),
    );
    const batchId = input.ids.nextUuid();
    const timestamp = input.ids.now().toISOString();
    const nonce = input.ids.nextUuid();
    const envelope = await createSignedHealthImportEnvelope(
      input.signer,
      {
        deviceId: input.deviceId,
        batchId,
        cursorEpoch: input.cursorEpoch,
        platform: input.adapter.platform,
        sourceCursor: cursor.serverDigest,
        nextSourceCursor,
        records: page.records,
      },
      timestamp,
      nonce,
    );
    const next = {
      version: 1 as const,
      providerCursor: finalPage ? plan.providerCursor : cursor.providerCursor,
      serverDigest: nextSourceCursor,
      knownRevisions: page.nextKnownRevisions,
    };
    await input.cursorStore.stage(cursor.serverDigest, {
      envelope,
      nextCursor: next,
      fullReconciliation: plan.fullReconciliation,
      deletionSemantics: plan.deletionSemantics,
    });
    const acknowledgement = await sendStableRetry(input.transport, envelope, page.records.length);
    await input.cursorStore.accept(batchId);
    cursor = next;
    batchCount += 1;
    recordCount += page.records.length;
    acceptedCount += acknowledgement.accepted;
    deletedCount += acknowledgement.deleted;
    duplicateCount += acknowledgement.duplicates;
  }
  return {
    batches: batchCount,
    records: recordCount,
    accepted: acceptedCount,
    deleted: deletedCount,
    duplicates: duplicateCount,
    fullReconciliation: plan.fullReconciliation,
    deletionSemantics: plan.deletionSemantics,
    recoveredPendingBatch,
  };
}
