import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type {
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
} from "@nutrition-tracker/artifact-store";
import type {
  AccountErasureClaimRecord,
  AccountErasureExecutionEvidence,
  ClaimedPrivacyExportArtifactDeletionRecord,
  ClaimedStagedPrivacyExportArtifactDeletionRecord,
  CompletePrivacyExportJobInput,
  PrivacyExportJobRecord,
  PrivacyExportSnapshotContext,
  RetentionDeadLetterRecord,
  RetentionRetryDisposition,
  RetentionWorkLeaseKind,
  StagedPrivacyExportArtifactRecord,
} from "@nutrition-tracker/db";
import { RetentionExportTooLargeError } from "@nutrition-tracker/db";

import {
  materializePrivacyExportArtifacts,
  PRIVACY_EXPORT_ENTITIES,
  PrivacyExportCapacityError,
  type PrivacyExportEntity,
  type PrivacyExportRow,
  spoolPrivacyExportSnapshot,
} from "./privacy-export-format.js";

export interface RetentionWorkerRepository {
  acknowledgeRetentionDeadLetterEvent(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly acknowledgedAt: string;
  }): Promise<void>;
  claimRetentionDeadLetterEvents(input: {
    readonly workerId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly RetentionDeadLetterRecord[]>;
  renewRetentionWorkLease(input: {
    readonly kind: RetentionWorkLeaseKind;
    readonly targetId: string;
    readonly workerId: string;
    readonly renewedAt: string;
  }): Promise<void>;
  renewPrivacyExportStagedArtifactUploadLease(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly renewedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<void>;
  claimPrivacyExportJobs(input: {
    readonly workerId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly PrivacyExportJobRecord[]>;
  withPrivacyExportSnapshot<T>(
    input: {
      readonly userId: string;
      readonly jobId: string;
      readonly workerId: string;
      readonly maximumSnapshotBytes: number;
    },
    callback: (snapshot: PrivacyExportSnapshotContext) => Promise<T>,
  ): Promise<T>;
  completePrivacyExportJob(input: CompletePrivacyExportJobInput): Promise<void>;
  getPrivacyExportJob(input: {
    readonly userId: string;
    readonly jobId: string;
  }): Promise<PrivacyExportJobRecord>;
  stagePrivacyExportArtifacts(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifacts: readonly { readonly format: "csv" | "json"; readonly objectKey: string }[];
  }): Promise<readonly StagedPrivacyExportArtifactRecord[]>;
  beginPrivacyExportStagedArtifactUpload(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly startedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<StagedPrivacyExportArtifactRecord>;
  markPrivacyExportStagedArtifactUploaded(input: {
    readonly userId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly uploadedAt: string;
  }): Promise<StagedPrivacyExportArtifactRecord>;
  completePrivacyExportStagedArtifactDeletion(input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly deletedAt: string;
    readonly deletionEvidenceDigest: string;
  }): Promise<void>;
  claimCancelledPrivacyExportStagedArtifacts(input: {
    readonly workerId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly ClaimedStagedPrivacyExportArtifactDeletionRecord[]>;
  failPrivacyExportStagedArtifactDeletion(input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly errorCode: "STAGED_ARTIFACT_DELETE_FAILED";
    readonly retryAt: string;
  }): Promise<RetentionRetryDisposition>;
  withUserRetentionSerialization<T>(
    input: { readonly userId: string },
    callback: (repository: RetentionSerializedUserRepository) => Promise<T>,
  ): Promise<T>;
  failPrivacyExportJob(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly retryAt: string;
    readonly failureKind: "retryable" | "snapshot_too_large";
  }): Promise<RetentionRetryDisposition>;
  claimExpiredPrivacyExportArtifacts(input: {
    readonly workerId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly ClaimedPrivacyExportArtifactDeletionRecord[]>;
  completePrivacyExportArtifactDeletion(input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly deletedAt: string;
    readonly deletionEvidenceDigest: string;
  }): Promise<void>;
  failPrivacyExportArtifactDeletion(input: {
    readonly artifactId: string;
    readonly workerId: string;
    readonly errorCode: "ARTIFACT_DELETE_FAILED";
    readonly retryAt: string;
  }): Promise<RetentionRetryDisposition>;
  claimAccountErasureJobs(input: {
    readonly workerId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly AccountErasureClaimRecord[]>;
  failAccountErasureJob(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly errorCode: "ERASURE_FAILED";
    readonly retryAt: string;
  }): Promise<RetentionRetryDisposition>;
}

export interface RetentionSerializedUserRepository {
  listAccountPrivacyExportArtifactsForErasure(input: {
    readonly userId: string;
    readonly erasureJobId: string;
    readonly workerId: string;
    readonly now: string;
  }): Promise<
    readonly {
      readonly artifactId: string;
      readonly exportJobId: string;
      readonly format: "json" | "csv";
      readonly objectKey: string;
      readonly source: "completed" | "staged";
    }[]
  >;
  executeAccountErasureJob(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly completedAt: string;
    readonly evidence: AccountErasureExecutionEvidence;
  }): Promise<void>;
}

export interface RetentionWorkerEvent {
  readonly event:
    | "retention.erasure.completed"
    | "retention.erasure.retry_scheduled"
    | "retention.export_artifact.expired"
    | "retention.export_artifact.expiry_retry_scheduled"
    | "retention.export_staged_artifact.deleted"
    | "retention.export_staged_artifact.retry_scheduled"
    | "retention.export.completed"
    | "retention.export.retry_scheduled"
    | "retention.job.dead_lettered"
    | "retention.poll.slice_failed";
  readonly level: "info" | "warn";
  readonly jobId?: string;
  readonly operation?:
    | "exports"
    | "cancelled_staged_artifacts"
    | "expired_artifacts"
    | "erasures"
    | "dead_letters";
  readonly errorCode?: "ERASURE_FAILED" | "EXPORT_FAILED" | "RETENTION_POLL_FAILED";
  readonly attemptCount?: number;
  readonly deadLetterEventId?: string;
  readonly recoveryKind?: RetentionDeadLetterRecord["recoveryKind"];
  readonly targetId?: string;
}

export interface RetentionWorkerOptions {
  readonly repository: RetentionWorkerRepository;
  readonly exportArtifactStore: EncryptedArtifactStore;
  /** Injectable at the deterministic format boundary; production uses the built-in formatter. */
  readonly materializeExportArtifacts?: typeof materializePrivacyExportArtifacts;
  readonly erasureLedger: EncryptedErasureReplayLedger;
  readonly workerId: string;
  readonly spoolMaximumBytes: number;
  readonly exportTtlMs: number;
  /** Must exceed the bounded object-store request lifetime and be at most 15 minutes. */
  readonly uploadLeaseMs?: number;
  /** Must remain comfortably below the repository's 15-minute stale-claim boundary. */
  readonly workLeaseHeartbeatMs?: number;
  readonly clock?: () => Date;
  readonly temporaryDirectory?: string;
  readonly onEvent?: (event: RetentionWorkerEvent) => void;
}

function retryAt(now: Date): string {
  return new Date(now.getTime() + 5 * 60_000).toISOString();
}

function checkedRetryDisposition(value: RetentionRetryDisposition): RetentionRetryDisposition {
  if (
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 1 ||
    value.retryScheduled === value.deadLettered
  ) {
    throw new Error("Invalid retention retry disposition");
  }
  return value;
}

async function withRenewedWorkLease<T>(
  options: RetentionWorkerOptions,
  input: {
    readonly kind: RetentionWorkLeaseKind;
    readonly targetId: string;
    readonly signal?: AbortSignal;
  },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const intervalMs = options.workLeaseHeartbeatMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 5 * 60_000) {
    throw new RangeError("Invalid retention work lease heartbeat");
  }
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let stopped = false;
  let heartbeatFailure: unknown;
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async () => {
    await options.repository.renewRetentionWorkLease({
      kind: input.kind,
      renewedAt: (options.clock ?? (() => new Date()))().toISOString(),
      targetId: input.targetId,
      workerId: options.workerId,
    });
  };
  const schedule = () => {
    timer = setTimeout(() => {
      heartbeat = renew()
        .then(() => {
          if (!stopped) schedule();
        })
        .catch((error: unknown) => {
          heartbeatFailure = error;
          controller.abort(error);
        });
    }, intervalMs);
    timer.unref?.();
  };
  await renew();
  schedule();
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation(signal);
    if (heartbeatFailure) {
      operationFailed = true;
      operationError = heartbeatFailure;
    }
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }
  stopped = true;
  if (timer) clearTimeout(timer);
  await heartbeat;
  if (operationFailed) throw heartbeatFailure ?? operationError;
  return result as T;
}

async function withRenewedUploadLease<T>(
  options: RetentionWorkerOptions,
  input: {
    readonly userId: string;
    readonly jobId: string;
    readonly snapshotId: string;
    readonly artifactId: string;
    readonly uploadLeaseMs: number;
    readonly signal: AbortSignal;
  },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const intervalMs = Math.min(
    options.workLeaseHeartbeatMs ?? 5 * 60_000,
    Math.max(10, Math.floor(input.uploadLeaseMs / 3)),
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let stopped = false;
  let heartbeatFailure: unknown;
  let heartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async () => {
    const renewedAt = (options.clock ?? (() => new Date()))();
    await options.repository.renewPrivacyExportStagedArtifactUploadLease({
      artifactId: input.artifactId,
      jobId: input.jobId,
      leaseExpiresAt: new Date(renewedAt.getTime() + input.uploadLeaseMs).toISOString(),
      renewedAt: renewedAt.toISOString(),
      snapshotId: input.snapshotId,
      userId: input.userId,
      workerId: options.workerId,
    });
  };
  const schedule = () => {
    timer = setTimeout(() => {
      heartbeat = renew()
        .then(() => {
          if (!stopped) schedule();
        })
        .catch((error: unknown) => {
          heartbeatFailure = error;
          controller.abort(error);
        });
    }, intervalMs);
    timer.unref?.();
  };
  await renew();
  schedule();
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation(signal);
    if (heartbeatFailure) {
      operationFailed = true;
      operationError = heartbeatFailure;
    }
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }
  stopped = true;
  if (timer) clearTimeout(timer);
  await heartbeat;
  if (operationFailed) throw heartbeatFailure ?? operationError;
  return result as T;
}

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Privacy export count exceeds the worker's exact range");
  }
  return parsed;
}

function exportRows(snapshot: PrivacyExportSnapshotContext): AsyncIterable<PrivacyExportRow> {
  return {
    async *[Symbol.asyncIterator]() {
      const evidence = new Map(snapshot.entities.map((entity) => [entity.entity, entity]));
      for (const entity of PRIVACY_EXPORT_ENTITIES) {
        const expected = evidence.get(entity);
        if (!expected) throw new Error("Privacy export entity registry drifted");
        let cursor: string | null = null;
        const seen = new Set<string>();
        let observed = 0;
        do {
          const page = await snapshot.page({ entity, cursor, limit: 1_000 });
          if (
            page.entity !== entity ||
            page.sourceCount !== expected.sourceCount ||
            page.entityWatermark !== expected.watermarkRevision
          ) {
            throw new Error("Privacy export page evidence drifted");
          }
          for (const record of page.records) {
            observed += 1;
            yield {
              deleted: record.deleted,
              entityId: record.entityId,
              entityType: record.entityType as PrivacyExportEntity,
              ordinal: record.ordinal,
              payload: record.payload as PrivacyExportRow["payload"],
              payloadSha256: record.payloadSha256,
              revision: record.revision,
              watermark: record.watermark,
            };
          }
          cursor = page.nextCursor;
          if (cursor !== null && (seen.has(cursor) || cursor.length > 4_096)) {
            throw new Error("Privacy export cursor did not advance");
          }
          if (cursor !== null) seen.add(cursor);
        } while (cursor !== null);
        if (observed !== count(expected.sourceCount)) {
          throw new Error("Privacy export entity count drifted");
        }
      }
    },
  };
}

async function putOrReuseExact(input: {
  readonly artifactStore: EncryptedArtifactStore;
  readonly objectKey: string;
  readonly artifact: {
    readonly path: string;
    readonly mediaType: "application/json" | "application/zip";
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly signal?: AbortSignal;
}) {
  try {
    return {
      created: true,
      metadata: await input.artifactStore.put({
        mediaType: input.artifact.mediaType,
        objectKey: input.objectKey,
        plaintextBytes: input.artifact.byteLength,
        source: createReadStream(input.artifact.path),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    };
  } catch (writeError) {
    const existing = await input.artifactStore.verifyAuthenticatedByObject({
      expectedPlaintextBytes: input.artifact.byteLength,
      expectedPlaintextSha256: input.artifact.sha256,
      mediaType: input.artifact.mediaType,
      objectKey: input.objectKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!existing) throw writeError;
    return { created: false, metadata: existing };
  }
}

async function processExportJob(
  options: RetentionWorkerOptions,
  job: PrivacyExportJobRecord,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const uploadLeaseMs = options.uploadLeaseMs ?? 2 * 60_000;
  if (
    !Number.isSafeInteger(uploadLeaseMs) ||
    uploadLeaseMs < 1_000 ||
    uploadLeaseMs > 15 * 60_000
  ) {
    throw new RangeError("Invalid export upload lease");
  }
  const uploadedObjectKeys: string[] = [];
  let completionAttempted = false;
  let spool: Awaited<ReturnType<typeof spoolPrivacyExportSnapshot>> | undefined;
  try {
    const capture = await options.repository.withPrivacyExportSnapshot(
      {
        jobId: job.id,
        maximumSnapshotBytes: options.spoolMaximumBytes,
        userId: job.userId,
        workerId: options.workerId,
      },
      async (snapshot) => ({
        snapshotId: snapshot.snapshotId,
        spool: await spoolPrivacyExportSnapshot({
          maximumBytes: options.spoolMaximumBytes,
          snapshot: {
            capturedAt: now.toISOString(),
            entities: snapshot.entities.map((entity) => ({
              entity: entity.entity as PrivacyExportEntity,
              sourceCount: count(entity.sourceCount),
              sourceRecordSetSha256: entity.sourceRecordSetSha256,
              watermark: entity.watermarkRevision,
            })),
            records: exportRows(snapshot),
            semanticEvidence: snapshot.semanticEvidence,
            snapshotWatermark: snapshot.snapshotWatermark,
          },
          ...(options.temporaryDirectory ? { temporaryDirectory: options.temporaryDirectory } : {}),
          ...(signal ? { signal } : {}),
        }),
      }),
    );
    spool = capture.spool;
    const materialized = await (
      options.materializeExportArtifacts ?? materializePrivacyExportArtifacts
    )({
      formats: job.requestedFormats,
      maximumArtifactBytes: options.spoolMaximumBytes,
      maximumWorkspaceBytes: options.spoolMaximumBytes,
      spool,
      ...(signal ? { signal } : {}),
    });
    const expiresAt = new Date(Date.parse(job.createdAt) + options.exportTtlMs).toISOString();
    const snapshotKey = createHash("sha256").update(capture.snapshotId, "utf8").digest("hex");
    const plannedArtifacts = materialized.artifacts.map((artifact) => ({
      artifact,
      objectKey: `exports/v1/${job.id}/${snapshotKey}/${artifact.format}.enc`,
    }));
    const stagedArtifacts = await options.repository.stagePrivacyExportArtifacts({
      artifacts: plannedArtifacts.map(({ artifact, objectKey }) => ({
        format: artifact.format,
        objectKey,
      })),
      jobId: job.id,
      snapshotId: capture.snapshotId,
      userId: job.userId,
      workerId: options.workerId,
    });
    const persistedArtifacts: CompletePrivacyExportJobInput["artifacts"] extends readonly (infer A)[]
      ? A[]
      : never = [];
    for (const { artifact, objectKey } of plannedArtifacts) {
      const staged = stagedArtifacts.find(
        (candidate) => candidate.format === artifact.format && candidate.objectKey === objectKey,
      );
      if (!staged) throw new Error("Staged export artifact evidence drifted");
      const uploadStartedAt = (options.clock ?? (() => new Date()))();
      await options.repository.beginPrivacyExportStagedArtifactUpload({
        artifactId: staged.id,
        jobId: job.id,
        leaseExpiresAt: new Date(uploadStartedAt.getTime() + uploadLeaseMs).toISOString(),
        snapshotId: capture.snapshotId,
        startedAt: uploadStartedAt.toISOString(),
        userId: job.userId,
        workerId: options.workerId,
      });
      const stored = await withRenewedUploadLease(
        options,
        {
          artifactId: staged.id,
          jobId: job.id,
          signal: signal ?? new AbortController().signal,
          snapshotId: capture.snapshotId,
          uploadLeaseMs,
          userId: job.userId,
        },
        async (uploadSignal) =>
          putOrReuseExact({
            artifact,
            artifactStore: options.exportArtifactStore,
            objectKey,
            signal: uploadSignal,
          }),
      );
      uploadedObjectKeys.push(stored.metadata.objectKey);
      await options.repository.markPrivacyExportStagedArtifactUploaded({
        artifactId: staged.id,
        jobId: job.id,
        snapshotId: capture.snapshotId,
        uploadedAt: (options.clock ?? (() => new Date()))().toISOString(),
        userId: job.userId,
        workerId: options.workerId,
      });
      persistedArtifacts.push({
        ciphertextBytes: stored.metadata.ciphertextBytes,
        encryptionKeyId: stored.metadata.encryptionKeyId,
        expiresAt,
        fileName: artifact.fileName,
        format: artifact.format,
        mediaType: artifact.mediaType,
        objectKey: stored.metadata.objectKey,
        plaintextBytes: stored.metadata.plaintextBytes,
        plaintextSha256: stored.metadata.plaintextSha256,
      });
    }
    try {
      // From this point a lost database response is a commit ambiguity. Never
      // remove immutable ciphertext based only on a failed status probe; the
      // durable staged/cancelled/expiry workflows decide its fate.
      completionAttempted = true;
      await options.repository.completePrivacyExportJob({
        artifacts: persistedArtifacts,
        jobId: job.id,
        manifestDigest: materialized.manifestSha256,
        reconciliation: {
          entities: materialized.manifest.entities.map((entity) => ({
            entity: entity.entity,
            exportedRecordSetSha256: entity.exportedRecordSetSha256,
            exportedCount: entity.exportedCount,
            sourceRecordSetSha256: entity.sourceRecordSetSha256,
            sourceCount: entity.sourceCount,
            watermarkRevision: entity.watermark,
          })),
          exportedSemanticDigest: materialized.manifest.semanticEvidence.digest,
          reconciled: true,
          snapshotWatermark: materialized.manifest.snapshotWatermark,
          sourceSemanticDigest: materialized.manifest.semanticEvidence.digest,
        },
        snapshotId: capture.snapshotId,
        userId: job.userId,
      });
    } catch (completionError) {
      try {
        const persisted = await options.repository.getPrivacyExportJob({
          jobId: job.id,
          userId: job.userId,
        });
        if (persisted.status === "completed") return;
        // A successful, authoritative probe proves the publication did not
        // commit, so the immutable upload can be removed on the failure path.
        completionAttempted = false;
      } catch {
        // Ambiguous means retain: a delayed/committed DB response must never
        // be followed by deletion of the artifacts it published.
      }
      throw completionError;
    }
  } catch (error) {
    if (!completionAttempted) {
      await Promise.allSettled(
        uploadedObjectKeys.map(async (objectKey) =>
          options.exportArtifactStore.deleteVerified({
            objectKey,
            ...(signal ? { signal } : {}),
          }),
        ),
      );
    }
    throw error;
  } finally {
    await spool?.dispose();
  }
}

async function runExportJobs(
  options: RetentionWorkerOptions,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const jobs = await options.repository.claimPrivacyExportJobs({
    limit: 1,
    now: now.toISOString(),
    workerId: options.workerId,
  });
  for (const job of jobs) {
    try {
      await withRenewedWorkLease(
        options,
        { kind: "privacy_export", targetId: job.id, ...(signal ? { signal } : {}) },
        async (leaseSignal) => processExportJob(options, job, now, leaseSignal),
      );
      options.onEvent?.({ event: "retention.export.completed", jobId: job.id, level: "info" });
    } catch (error: unknown) {
      const disposition = checkedRetryDisposition(
        await options.repository.failPrivacyExportJob({
          failureKind:
            error instanceof RetentionExportTooLargeError ||
            error instanceof PrivacyExportCapacityError
              ? "snapshot_too_large"
              : "retryable",
          jobId: job.id,
          retryAt: retryAt(now),
          workerId: options.workerId,
        }),
      );
      if (disposition.retryScheduled) {
        options.onEvent?.({
          attemptCount: disposition.attemptCount,
          errorCode: "EXPORT_FAILED",
          event: "retention.export.retry_scheduled",
          jobId: job.id,
          level: "warn",
        });
      }
    }
  }
}

async function runExpiredArtifacts(
  options: RetentionWorkerOptions,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const artifacts = await options.repository.claimExpiredPrivacyExportArtifacts({
    limit: 1,
    now: now.toISOString(),
    workerId: options.workerId,
  });
  for (const artifact of artifacts) {
    try {
      await withRenewedWorkLease(
        options,
        {
          kind: "artifact_deletion",
          targetId: artifact.artifactId,
          ...(signal ? { signal } : {}),
        },
        async (leaseSignal) => {
          const evidence = await options.exportArtifactStore.deleteVerified({
            objectKey: artifact.objectKey,
            signal: leaseSignal,
          });
          await options.repository.completePrivacyExportArtifactDeletion({
            artifactId: artifact.artifactId,
            deletedAt: now.toISOString(),
            deletionEvidenceDigest: evidence.deletionEvidenceDigest,
            workerId: options.workerId,
          });
        },
      );
      options.onEvent?.({
        event: "retention.export_artifact.expired",
        jobId: artifact.jobId,
        level: "info",
      });
    } catch {
      const disposition = checkedRetryDisposition(
        await options.repository.failPrivacyExportArtifactDeletion({
          artifactId: artifact.artifactId,
          errorCode: "ARTIFACT_DELETE_FAILED",
          retryAt: retryAt(now),
          workerId: options.workerId,
        }),
      );
      if (disposition.retryScheduled) {
        options.onEvent?.({
          attemptCount: disposition.attemptCount,
          errorCode: "EXPORT_FAILED",
          event: "retention.export_artifact.expiry_retry_scheduled",
          jobId: artifact.jobId,
          level: "warn",
        });
      }
    }
  }
}

async function runCancelledStagedArtifacts(
  options: RetentionWorkerOptions,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const artifacts = await options.repository.claimCancelledPrivacyExportStagedArtifacts({
    limit: 1,
    now: now.toISOString(),
    workerId: options.workerId,
  });
  for (const artifact of artifacts) {
    try {
      await withRenewedWorkLease(
        options,
        {
          kind: "staged_artifact_deletion",
          targetId: artifact.artifactId,
          ...(signal ? { signal } : {}),
        },
        async (leaseSignal) => {
          const evidence = await options.exportArtifactStore.deleteVerified({
            objectKey: artifact.objectKey,
            signal: leaseSignal,
          });
          await options.repository.completePrivacyExportStagedArtifactDeletion({
            artifactId: artifact.artifactId,
            deletedAt: now.toISOString(),
            deletionEvidenceDigest: evidence.deletionEvidenceDigest,
            workerId: options.workerId,
          });
        },
      );
      options.onEvent?.({
        event: "retention.export_staged_artifact.deleted",
        jobId: artifact.jobId,
        level: "info",
      });
    } catch {
      const disposition = checkedRetryDisposition(
        await options.repository.failPrivacyExportStagedArtifactDeletion({
          artifactId: artifact.artifactId,
          errorCode: "STAGED_ARTIFACT_DELETE_FAILED",
          retryAt: retryAt(now),
          workerId: options.workerId,
        }),
      );
      if (disposition.retryScheduled) {
        options.onEvent?.({
          attemptCount: disposition.attemptCount,
          errorCode: "EXPORT_FAILED",
          event: "retention.export_staged_artifact.retry_scheduled",
          jobId: artifact.jobId,
          level: "warn",
        });
      }
    }
  }
}

async function runErasureJobs(
  options: RetentionWorkerOptions,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const jobs = await options.repository.claimAccountErasureJobs({
    limit: 1,
    now: now.toISOString(),
    workerId: options.workerId,
  });
  for (const job of jobs) {
    try {
      await withRenewedWorkLease(
        options,
        { kind: "account_erasure", targetId: job.id, ...(signal ? { signal } : {}) },
        async (leaseSignal) =>
          options.repository.withUserRetentionSerialization(
            { userId: job.userId },
            async (repository) => {
              // `startedAt` is persisted on the first durable claim and never changes.
              // Reusing it makes the immutable external ledger append byte-identical
              // after a crash in any later erasure step.
              const recordedAt = job.startedAt ?? job.requestedAt;
              const ledger = await options.erasureLedger.append({
                jobId: job.id,
                recordedAt,
                restoreLocator: job.restoreLocator,
                subjectUserId: job.userId,
                signal: leaseSignal,
              });
              const artifacts = await repository.listAccountPrivacyExportArtifactsForErasure({
                erasureJobId: job.id,
                now: (options.clock ?? (() => new Date()))().toISOString(),
                userId: job.userId,
                workerId: options.workerId,
              });
              const deletedArtifacts: Array<
                AccountErasureExecutionEvidence["objectDeletionEvidence"]["artifacts"][number]
              > = [];
              for (const artifact of artifacts) {
                const deletion = await options.exportArtifactStore.deleteVerified({
                  objectKey: artifact.objectKey,
                  signal: leaseSignal,
                });
                if (artifact.source === "staged") {
                  await options.repository.completePrivacyExportStagedArtifactDeletion({
                    artifactId: artifact.artifactId,
                    deletedAt: (options.clock ?? (() => new Date()))().toISOString(),
                    deletionEvidenceDigest: deletion.deletionEvidenceDigest,
                    workerId: options.workerId,
                  });
                } else {
                  // DB erasure evidence is set-equal to promoted artifacts. Cancelled
                  // upload rows retain their own durable verified-deletion evidence.
                  deletedArtifacts.push({
                    artifactId: artifact.artifactId,
                    deletionEvidenceDigest: deletion.deletionEvidenceDigest,
                    objectKey: artifact.objectKey,
                  });
                }
              }
              await repository.executeAccountErasureJob({
                completedAt: (options.clock ?? (() => new Date()))().toISOString(),
                evidence: {
                  objectDeletionEvidence: { artifacts: deletedArtifacts },
                  restoreLedgerAcknowledgedAt: ledger.acknowledgedAt,
                  restoreLedgerDigest: ledger.ackDigest,
                  restoreLedgerReference: ledger.reference,
                },
                jobId: job.id,
                workerId: options.workerId,
              });
            },
          ),
      );
      options.onEvent?.({ event: "retention.erasure.completed", jobId: job.id, level: "info" });
    } catch {
      const disposition = checkedRetryDisposition(
        await options.repository.failAccountErasureJob({
          errorCode: "ERASURE_FAILED",
          jobId: job.id,
          retryAt: retryAt(now),
          workerId: options.workerId,
        }),
      );
      if (disposition.retryScheduled) {
        options.onEvent?.({
          attemptCount: disposition.attemptCount,
          errorCode: "ERASURE_FAILED",
          event: "retention.erasure.retry_scheduled",
          jobId: job.id,
          level: "warn",
        });
      }
    }
  }
}

async function runDeadLetterEvents(options: RetentionWorkerOptions, now: Date): Promise<void> {
  const events = await options.repository.claimRetentionDeadLetterEvents({
    limit: 100,
    now: now.toISOString(),
    workerId: options.workerId,
  });
  for (const event of events) {
    options.onEvent?.({
      attemptCount: event.attemptCount,
      deadLetterEventId: event.id,
      event: "retention.job.dead_lettered",
      level: "warn",
      recoveryKind: event.recoveryKind,
      targetId: event.targetId,
    });
    await options.repository.acknowledgeRetentionDeadLetterEvent({
      acknowledgedAt: now.toISOString(),
      eventId: event.id,
      workerId: options.workerId,
    });
  }
}

/** One bounded poll; every slice and every claimed job is isolated from poison work. */
export async function runRetentionWorkerPoll(
  options: RetentionWorkerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const now = (options.clock ?? (() => new Date()))();
  for (const [operationName, operation] of [
    ["exports", runExportJobs],
    ["cancelled_staged_artifacts", runCancelledStagedArtifacts],
    ["expired_artifacts", runExpiredArtifacts],
    ["erasures", runErasureJobs],
    ["dead_letters", runDeadLetterEvents],
  ] as const) {
    if (signal?.aborted) return;
    try {
      await operation(options, now, signal);
    } catch {
      // A claim/enqueue outage in one slice must not prevent other retention work.
      options.onEvent?.({
        errorCode: "RETENTION_POLL_FAILED",
        event: "retention.poll.slice_failed",
        level: "warn",
        operation: operationName,
      });
    }
  }
}
