import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import {
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  parseErasureLedgerLocatorKeyRing,
  type RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import { canonicalJson } from "@nutrition-tracker/contracts";
import type {
  AccountErasureClaimRecord,
  PrivacyExportJobRecord,
  PrivacyExportSnapshotContext,
} from "@nutrition-tracker/db";
import { RetentionExportTooLargeError } from "@nutrition-tracker/db";
import { describe, expect, it, vi } from "vitest";

import {
  materializePrivacyExportArtifacts,
  PRIVACY_EXPORT_ENTITIES,
} from "./privacy-export-format.js";
import {
  type RetentionSerializedUserRepository,
  type RetentionWorkerRepository,
  runRetentionWorkerPoll,
} from "./retention-worker.js";

const now = "2026-08-16T12:00:00.000Z";
const userId = "a0000000-0000-4000-8000-000000000001";
const exportId = "b0000000-0000-4000-8000-000000000002";
const erasureId = "c0000000-0000-4000-8000-000000000003";
const deadLetterEventId = "c1000000-0000-4000-8000-000000000003";
const retryDisposition = { attemptCount: 1, deadLettered: false, retryScheduled: true } as const;

class ImmutableMemoryRawStore implements RawArtifactStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: {
    readonly objectKey: string;
    readonly source: Readable;
    readonly contentLength: number;
  }): Promise<void> {
    if (this.objects.has(input.objectKey)) throw new Error("immutable-object-exists");
    const chunks: Buffer[] = [];
    for await (const chunk of input.source) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength !== input.contentLength) throw new Error("length-mismatch");
    this.objects.set(input.objectKey, bytes);
  }

  async open(input: { readonly objectKey: string }) {
    const bytes = this.objects.get(input.objectKey);
    return bytes
      ? { contentLength: bytes.byteLength, stream: Readable.from([Buffer.from(bytes)]) }
      : null;
  }

  async delete(input: { readonly objectKey: string }) {
    this.objects.delete(input.objectKey);
  }
}

class PausedPutRawStore extends ImmutableMemoryRawStore {
  readonly started: Promise<void>;
  #notifyStarted!: () => void;
  readonly release: () => void;
  #released: Promise<void>;
  #notifyReleased!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#notifyStarted = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#notifyReleased = resolve;
    });
    this.release = () => this.#notifyReleased();
  }

  override async put(input: Parameters<ImmutableMemoryRawStore["put"]>[0]): Promise<void> {
    this.#notifyStarted();
    await this.#released;
    await super.put(input);
  }
}

const exportJob: PrivacyExportJobRecord = {
  artifacts: [],
  completedAt: null,
  createdAt: now,
  entityCount: null,
  expiresAt: null,
  failureCode: null,
  id: exportId,
  manifestDigest: null,
  reconciliation: null,
  requestedFormats: ["json", "csv"],
  snapshotId: null,
  startedAt: now,
  status: "running",
  updatedAt: now,
  userId,
  watermarkRevision: null,
};

function snapshot(): PrivacyExportSnapshotContext {
  const payload = { exactDecimal: "72.125", preference: "private" } as const;
  const payloadSha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  const accountRecord = {
    deleted: false,
    entityId: userId,
    entityType: "account" as const,
    ordinal: "0",
    payload,
    payloadSha256,
    revision: "1",
    watermark: "7",
  };
  const accountRecordSetSha256 = createHash("sha256")
    .update(`${canonicalJson(accountRecord)}\n`, "utf8")
    .digest("hex");
  const emptyRecordSetSha256 = createHash("sha256").digest("hex");
  const semanticFacts = {
    biometricEventCount: "0",
    biometricRevisionCount: "0",
    diaryDailyNutrientGroupCount: "0",
    diaryDailyTotalsSha256: emptyRecordSetSha256,
    platformImportCount: "0",
    platformImportRevisionCount: "0",
    version: "retention-export-semantic-v1" as const,
  };
  return {
    entities: PRIVACY_EXPORT_ENTITIES.map((entity) => ({
      entity,
      sourceCount: entity === "account" ? "1" : "0",
      sourceRecordSetSha256: entity === "account" ? accountRecordSetSha256 : emptyRecordSetSha256,
      watermarkRevision: "7",
    })),
    jobId: exportId,
    page: async ({ entity }) => ({
      entity,
      entityWatermark: "7",
      nextCursor: null,
      records: entity === "account" ? [accountRecord] : [],
      sourceCount: entity === "account" ? "1" : "0",
    }),
    snapshotId: "1:2:",
    snapshotWatermark: "7",
    semanticEvidence: {
      ...semanticFacts,
      digest: createHash("sha256").update(canonicalJson(semanticFacts), "utf8").digest("hex"),
    },
  };
}

function stores() {
  const exportRaw = new ImmutableMemoryRawStore();
  const ledgerRaw = new ImmutableMemoryRawStore();
  const exportArtifactStore = new EncryptedArtifactStore({
    keyRing: {
      currentKeyId: "export-v1",
      keys: new Map([["export-v1", Buffer.alloc(32, 1)]]),
      purpose: "export",
    },
    nonce: () => Buffer.alloc(12, 1),
    rawStore: exportRaw,
  });
  const ledgerArtifactStore = new EncryptedArtifactStore({
    keyRing: {
      currentKeyId: "ledger-v1",
      keys: new Map([["ledger-v1", Buffer.alloc(32, 2)]]),
      purpose: "erasure_replay_ledger",
    },
    nonce: () => Buffer.alloc(12, 2),
    rawStore: ledgerRaw,
  });
  const locatorKeyRing = parseErasureLedgerLocatorKeyRing({
    currentKeyId: "locator-v1",
    serializedKeys: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 3).toString("base64"),
    }),
  });
  const erasureLedger = new EncryptedErasureReplayLedger({
    artifactStore: ledgerArtifactStore,
    clock: () => new Date(now),
    locatorKeyRing,
  });
  return { erasureLedger, exportArtifactStore, exportRaw, ledgerRaw, locatorKeyRing };
}

function repository(
  overrides: Partial<RetentionWorkerRepository & RetentionSerializedUserRepository> = {},
): RetentionWorkerRepository {
  const serialized: RetentionSerializedUserRepository = {
    executeAccountErasureJob: vi.fn(async () => undefined),
    listAccountPrivacyExportArtifactsForErasure: vi.fn(async () => []),
    ...overrides,
  };
  const defaults: RetentionWorkerRepository = {
    acknowledgeRetentionDeadLetterEvent: vi.fn(async () => undefined),
    beginPrivacyExportStagedArtifactUpload: vi.fn<
      RetentionWorkerRepository["beginPrivacyExportStagedArtifactUpload"]
    >(async (input) => ({
      format: "json" as const,
      id: input.artifactId,
      jobId: input.jobId,
      objectKey: "unused",
      snapshotId: input.snapshotId,
      status: "uploading" as const,
    })),
    claimAccountErasureJobs: vi.fn(async () => []),
    claimCancelledPrivacyExportStagedArtifacts: vi.fn(async () => []),
    claimExpiredPrivacyExportArtifacts: vi.fn(async () => []),
    claimPrivacyExportJobs: vi.fn(async () => []),
    claimRetentionDeadLetterEvents: vi.fn(async () => []),
    completePrivacyExportArtifactDeletion: vi.fn(async () => undefined),
    completePrivacyExportJob: vi.fn(async () => undefined),
    completePrivacyExportStagedArtifactDeletion: vi.fn(async () => undefined),
    failAccountErasureJob: vi.fn(async () => retryDisposition),
    failPrivacyExportArtifactDeletion: vi.fn(async () => retryDisposition),
    failPrivacyExportJob: vi.fn(async () => retryDisposition),
    failPrivacyExportStagedArtifactDeletion: vi.fn(async () => retryDisposition),
    getPrivacyExportJob: vi.fn(async () => exportJob),
    markPrivacyExportStagedArtifactUploaded: vi.fn<
      RetentionWorkerRepository["markPrivacyExportStagedArtifactUploaded"]
    >(async (input) => ({
      format: "json" as const,
      id: input.artifactId,
      jobId: input.jobId,
      objectKey: "unused",
      snapshotId: input.snapshotId,
      status: "uploaded" as const,
    })),
    renewPrivacyExportStagedArtifactUploadLease: vi.fn(async () => undefined),
    renewRetentionWorkLease: vi.fn(async () => undefined),
    stagePrivacyExportArtifacts: vi.fn<RetentionWorkerRepository["stagePrivacyExportArtifacts"]>(
      async (input) =>
        input.artifacts.map((artifact, index) => ({
          ...artifact,
          id: `e0000000-0000-4000-8000-00000000000${index}`,
          jobId: input.jobId,
          snapshotId: input.snapshotId,
          status: "staged" as const,
        })),
    ),
    withPrivacyExportSnapshot: vi.fn(async (_input, callback) => callback(snapshot())),
    withUserRetentionSerialization: vi.fn(async (_input, callback) => callback(serialized)),
  };
  return { ...defaults, ...overrides } as RetentionWorkerRepository;
}

function workerOptions(repo: RetentionWorkerRepository, storage = stores()) {
  return {
    clock: () => new Date(now),
    erasureLedger: storage.erasureLedger,
    exportArtifactStore: storage.exportArtifactStore,
    exportTtlMs: 7 * 86_400_000,
    repository: repo,
    spoolMaximumBytes: 100 * 1_024 * 1_024,
    workerId: "retention-worker-test",
  } as const;
}

describe("retention worker poll", () => {
  it("never preclaims sequential long-running work whose lease it cannot yet renew", async () => {
    const repo = repository();
    await runRetentionWorkerPoll(workerOptions(repo));
    for (const claim of [
      repo.claimPrivacyExportJobs,
      repo.claimCancelledPrivacyExportStagedArtifacts,
      repo.claimExpiredPrivacyExportArtifacts,
      repo.claimAccountErasureJobs,
    ]) {
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    }
  });

  it("emits a bounded event for a failed claim slice and continues later retention work", async () => {
    const events = vi.fn();
    const expiryClaim = vi.fn(async () => []);
    const repo = repository({
      claimExpiredPrivacyExportArtifacts: expiryClaim,
      claimPrivacyExportJobs: vi.fn(async () => {
        throw new Error("database secret must not be logged");
      }),
    });
    await runRetentionWorkerPoll({ ...workerOptions(repo), onEvent: events });
    expect(events).toHaveBeenCalledWith({
      errorCode: "RETENTION_POLL_FAILED",
      event: "retention.poll.slice_failed",
      level: "warn",
      operation: "exports",
    });
    expect(expiryClaim).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events.mock.calls)).not.toContain("database secret");
  });

  it("does not claim or mark OS-local reminders as server-delivered", async () => {
    const serverReminderWork = vi.fn(async () => 1);
    const repo = Object.assign(repository(), {
      enqueueDueReminderDeliveries: serverReminderWork,
      markReminderDeliverySucceeded: serverReminderWork,
    });
    await runRetentionWorkerPoll(workerOptions(repo));
    expect(serverReminderWork).not.toHaveBeenCalled();
  });

  it("retains readable ciphertext across an ambiguous completion commit and recovers exactly", async () => {
    const storage = stores();
    const complete = vi
      .fn<RetentionWorkerRepository["completePrivacyExportJob"]>()
      .mockRejectedValueOnce(new Error("database-unavailable-after-upload"))
      .mockResolvedValueOnce(undefined);
    const fail = vi.fn(async () => retryDisposition);
    const repo = repository({
      claimPrivacyExportJobs: vi.fn(async () => [exportJob]),
      completePrivacyExportJob: complete,
      failPrivacyExportJob: fail,
      getPrivacyExportJob: vi.fn(async () => {
        throw new Error("status-probe-unavailable-after-ambiguous-commit");
      }),
    });

    await runRetentionWorkerPoll(workerOptions(repo, storage));
    expect(storage.exportRaw.objects.size).toBe(2);
    expect(fail).toHaveBeenCalledTimes(1);

    await runRetentionWorkerPoll(workerOptions(repo, storage));
    expect(storage.exportRaw.objects.size).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0]).toMatchObject({
      artifacts: [
        expect.objectContaining({ format: "csv", mediaType: "application/zip" }),
        expect.objectContaining({ format: "json", mediaType: "application/json" }),
      ],
      manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      reconciliation: { reconciled: true, snapshotWatermark: "7" },
    });
    for (const artifact of complete.mock.calls[1]?.[0].artifacts ?? []) {
      const opened = await storage.exportArtifactStore.openAuthenticated({
        ciphertextBytes: Number(artifact.ciphertextBytes),
        encryptionKeyId: artifact.encryptionKeyId,
        envelopeVersion: 1,
        mediaType: artifact.mediaType,
        objectKey: artifact.objectKey,
        plaintextBytes: Number(artifact.plaintextBytes),
        plaintextSha256: artifact.plaintextSha256,
      });
      expect(opened).not.toBeNull();
      await opened?.dispose();
    }
  });

  it("deletes uploaded ciphertext only after an authoritative uncommitted publication probe", async () => {
    const storage = stores();
    const repo = repository({
      claimPrivacyExportJobs: vi.fn(async () => [exportJob]),
      completePrivacyExportJob: vi.fn(async () => {
        throw new Error("publication-transaction-rolled-back");
      }),
      getPrivacyExportJob: vi.fn(async () => exportJob),
    });

    await runRetentionWorkerPoll(workerOptions(repo, storage));

    expect(storage.exportRaw.objects.size).toBe(0);
    expect(repo.failPrivacyExportJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: exportId }),
    );
  });

  it("claims one export at a time and lets a later poll isolate poison work", async () => {
    const second = { ...exportJob, id: "d0000000-0000-4000-8000-000000000004" };
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => retryDisposition);
    const withSnapshot = vi.fn(async (input, callback) => {
      if (input.jobId === exportId) throw new Error("poison-job");
      const next = snapshot();
      return callback({ ...next, jobId: second.id });
    }) as RetentionWorkerRepository["withPrivacyExportSnapshot"];
    const repo = repository({
      claimPrivacyExportJobs: vi
        .fn()
        .mockResolvedValueOnce([exportJob])
        .mockResolvedValueOnce([second])
        .mockResolvedValue([]),
      completePrivacyExportJob: complete,
      failPrivacyExportJob: fail,
      withPrivacyExportSnapshot: withSnapshot,
    });
    await runRetentionWorkerPoll(workerOptions(repo));
    await runRetentionWorkerPoll(workerOptions(repo));
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ jobId: exportId }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ jobId: second.id }));
    expect(repo.claimPrivacyExportJobs).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(repo.withPrivacyExportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ maximumSnapshotBytes: 100 * 1_024 * 1_024 }),
      expect.any(Function),
    );
  });

  it("emits a terminal export event when the durable attempt cap is reached", async () => {
    const events = vi.fn();
    const repo = repository({
      claimPrivacyExportJobs: vi.fn().mockResolvedValueOnce([exportJob]).mockResolvedValue([]),
      claimRetentionDeadLetterEvents: vi
        .fn()
        .mockResolvedValueOnce([
          {
            attemptCount: 20 as const,
            id: deadLetterEventId,
            occurredAt: now,
            recoveryKind: "privacy_export" as const,
            targetId: exportId,
          },
        ])
        .mockResolvedValue([]),
      failPrivacyExportJob: vi.fn(async () => ({
        attemptCount: 20,
        deadLettered: true,
        retryScheduled: false,
      })),
      withPrivacyExportSnapshot: vi.fn(async () => {
        throw new Error("poison-export");
      }),
    });

    await runRetentionWorkerPoll({ ...workerOptions(repo), onEvent: events });
    await runRetentionWorkerPoll({ ...workerOptions(repo), onEvent: events });

    expect(events).toHaveBeenCalledWith({
      attemptCount: 20,
      deadLetterEventId,
      event: "retention.job.dead_lettered",
      level: "warn",
      recoveryKind: "privacy_export",
      targetId: exportId,
    });
    expect(events).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "retention.export.retry_scheduled" }),
    );
    expect(
      events.mock.calls.filter(([event]) => event.event === "retention.job.dead_lettered"),
    ).toHaveLength(1);
    expect(repo.acknowledgeRetentionDeadLetterEvent).toHaveBeenCalledWith({
      acknowledgedAt: now,
      eventId: deadLetterEventId,
      workerId: "retention-worker-test",
    });
  });

  it("dead-letters a deterministic DB snapshot byte-cap failure without retrying it", async () => {
    const fail = vi.fn(async () => ({
      attemptCount: 20,
      deadLettered: true,
      retryScheduled: false,
    }));
    const repo = repository({
      claimPrivacyExportJobs: vi.fn(async () => [exportJob]),
      failPrivacyExportJob: fail,
      withPrivacyExportSnapshot: vi.fn(async () => {
        throw new RetentionExportTooLargeError();
      }),
    });

    await runRetentionWorkerPoll(workerOptions(repo));

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: "snapshot_too_large", jobId: exportId }),
    );
  });

  it("dead-letters deterministic local artifact expansion without retrying it", async () => {
    const fail = vi.fn(async () => ({
      attemptCount: 20,
      deadLettered: true,
      retryScheduled: false,
    }));
    const repo = repository({
      claimPrivacyExportJobs: vi.fn(async () => [exportJob]),
      failPrivacyExportJob: fail,
    });
    const materialize = vi.fn(
      async (input: Parameters<typeof materializePrivacyExportArtifacts>[0]) =>
        materializePrivacyExportArtifacts({
          ...input,
          // A DB-accepted snapshot may consume the full source byte cap. Make
          // that exact boundary observable without allocating a 100 MiB row;
          // the first generated JSON byte must fail the real workspace budget.
          spool: { ...input.spool, byteLength: input.maximumWorkspaceBytes as number },
        }),
    );

    await runRetentionWorkerPoll({
      ...workerOptions(repo),
      materializeExportArtifacts: materialize,
    });

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith({
      failureKind: "snapshot_too_large",
      jobId: exportId,
      retryAt: "2026-08-16T12:05:00.000Z",
      workerId: "retention-worker-test",
    });
  });

  it("reclaims a cancelled staged key even when the exporter lost the PUT response", async () => {
    const storage = stores();
    const objectKey = `exports/v1/${exportId}/lost-response/json.enc`;
    const plaintext = Buffer.from("committed ciphertext with an ambiguous PUT response");
    await storage.exportArtifactStore.put({
      mediaType: "application/json",
      objectKey,
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    const completeDeletion = vi.fn(async () => undefined);
    const repo = repository({
      claimCancelledPrivacyExportStagedArtifacts: vi.fn(async () => [
        {
          artifactId: "e0000000-0000-4000-8000-000000000009",
          attemptCount: 1,
          format: "json" as const,
          jobId: exportId,
          objectKey,
          snapshotId: "snapshot-lost-response",
        },
      ]),
      completePrivacyExportStagedArtifactDeletion: completeDeletion,
    });
    await runRetentionWorkerPoll(workerOptions(repo, storage));
    expect(storage.exportRaw.objects.has(objectKey)).toBe(false);
    expect(completeDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "e0000000-0000-4000-8000-000000000009",
        deletionEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        workerId: "retention-worker-test",
      }),
    );
  });

  it("requires ledger acknowledgement and object deletion before executing erasure", async () => {
    const storage = stores();
    const artifactId = "d0000000-0000-4000-8000-000000000004";
    const objectKey = "exports/v1/job/json.enc";
    const plaintext = Buffer.from("private export pending erasure");
    await storage.exportArtifactStore.put({
      mediaType: "application/json",
      objectKey,
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    const restoreLocator = storage.erasureLedger.locatorForSubject(userId);
    const job: AccountErasureClaimRecord = {
      completedAt: null,
      executeAfter: now,
      id: erasureId,
      lastErrorCode: null,
      requestedAt: now,
      restoreLocator,
      startedAt: now,
      status: "running",
      statusCapabilityExpiresAt: "2026-09-16T12:00:00.000Z",
      userId,
    };
    const order: string[] = [];
    const repo = repository({
      claimAccountErasureJobs: vi.fn(async () => [job]),
      listAccountPrivacyExportArtifactsForErasure: vi.fn(async () => {
        order.push("list-objects");
        expect(storage.ledgerRaw.objects.size).toBe(1);
        return [
          {
            artifactId,
            exportJobId: exportId,
            format: "json" as const,
            objectKey,
            source: "completed" as const,
          },
        ];
      }),
      executeAccountErasureJob: vi.fn(async (input) => {
        order.push("erase-database");
        expect(storage.exportRaw.objects.has(objectKey)).toBe(false);
        expect(input.evidence).toMatchObject({
          objectDeletionEvidence: {
            artifacts: [
              {
                artifactId,
                deletionEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
                objectKey,
              },
            ],
          },
          restoreLedgerDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          restoreLedgerReference: expect.stringMatching(/^erasure-ledger\/v1\//),
        });
      }),
    });
    await runRetentionWorkerPoll(workerOptions(repo, storage));
    expect(order).toEqual(["list-objects", "erase-database"]);
    const rawLedger = [...storage.ledgerRaw.objects.values()][0];
    expect(rawLedger?.includes(Buffer.from(userId))).toBe(false);
  });

  it("does not execute erasure if the encrypted ledger sink fails", async () => {
    const storage = stores();
    const restoreLocator = storage.erasureLedger.locatorForSubject(userId);
    const fail = vi.fn(async () => ({
      attemptCount: 20,
      deadLettered: true,
      retryScheduled: false,
    }));
    const events = vi.fn();
    const execute = vi.fn(async () => undefined);
    const job = {
      completedAt: null,
      executeAfter: now,
      id: erasureId,
      lastErrorCode: null,
      requestedAt: now,
      restoreLocator,
      startedAt: now,
      status: "running" as const,
      statusCapabilityExpiresAt: "2026-09-16T12:00:00.000Z",
      userId,
    };
    const brokenLedger = new EncryptedErasureReplayLedger({
      artifactStore: new EncryptedArtifactStore({
        keyRing: {
          currentKeyId: "ledger-v1",
          keys: new Map([["ledger-v1", Buffer.alloc(32, 2)]]),
          purpose: "erasure_replay_ledger",
        },
        rawStore: {
          open: async () => null,
          put: async () => {
            throw new Error("ledger-offline");
          },
        },
      }),
      locatorKeyRing: storage.locatorKeyRing,
    });
    const repo = repository({
      claimAccountErasureJobs: vi.fn(async () => [job]),
      claimRetentionDeadLetterEvents: vi.fn(async () => [
        {
          attemptCount: 20 as const,
          id: deadLetterEventId,
          occurredAt: now,
          recoveryKind: "account_erasure" as const,
          targetId: erasureId,
        },
      ]),
      executeAccountErasureJob: execute,
      failAccountErasureJob: fail,
    });
    await runRetentionWorkerPoll({
      ...workerOptions(repo, storage),
      erasureLedger: brokenLedger,
      onEvent: events,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "ERASURE_FAILED", jobId: erasureId }),
    );
    expect(events).toHaveBeenCalledWith({
      attemptCount: 20,
      deadLetterEventId,
      event: "retention.job.dead_lettered",
      level: "warn",
      recoveryKind: "account_erasure",
      targetId: erasureId,
    });
  });

  it("reuses the first durable claim timestamp when retrying after the ledger append", async () => {
    const storage = stores();
    const restoreLocator = storage.erasureLedger.locatorForSubject(userId);
    const job = {
      completedAt: null,
      executeAfter: now,
      id: erasureId,
      lastErrorCode: null,
      requestedAt: "2026-08-15T12:00:00.000Z",
      restoreLocator,
      startedAt: now,
      status: "running" as const,
      statusCapabilityExpiresAt: "2026-09-16T12:00:00.000Z",
      userId,
    };
    const execute = vi
      .fn<RetentionSerializedUserRepository["executeAccountErasureJob"]>()
      .mockRejectedValueOnce(new Error("database-unavailable-after-ledger"))
      .mockResolvedValueOnce(undefined);
    const repo = repository({
      claimAccountErasureJobs: vi.fn(async () => [job]),
      executeAccountErasureJob: execute,
    });
    await runRetentionWorkerPoll(workerOptions(repo, storage));
    await runRetentionWorkerPoll({
      ...workerOptions(repo, storage),
      clock: () => new Date("2026-08-16T13:00:00.000Z"),
    });
    expect(storage.ledgerRaw.objects.size).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never completes erasure before a paused PUT is acknowledged and verified absent", async () => {
    const base = stores();
    const lateRaw = new PausedPutRawStore();
    const exportArtifactStore = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "export-v1",
        keys: new Map([["export-v1", Buffer.alloc(32, 1)]]),
        purpose: "export",
      },
      nonce: () => Buffer.alloc(12, 1),
      rawStore: lateRaw,
    });
    const restoreLocator = base.erasureLedger.locatorForSubject(userId);
    const erasureJob: AccountErasureClaimRecord = {
      completedAt: null,
      executeAfter: now,
      id: erasureId,
      lastErrorCode: null,
      requestedAt: now,
      restoreLocator,
      startedAt: now,
      status: "running",
      statusCapabilityExpiresAt: "2026-09-16T12:00:00.000Z",
      userId,
    };
    let uploadInFlight = false;
    let cancellationRequested = false;
    let stagedDeleted = false;
    let exportClaimed = false;
    let firstErasureClaimed = false;
    let allowFinalErasure = false;
    const execute = vi.fn(async () => {
      expect(stagedDeleted).toBe(true);
      expect(lateRaw.objects.size).toBe(0);
    });
    const repo = repository({
      beginPrivacyExportStagedArtifactUpload: vi.fn(async (input) => {
        uploadInFlight = true;
        return {
          format: "json" as const,
          id: input.artifactId,
          jobId: input.jobId,
          objectKey: "planned",
          snapshotId: input.snapshotId,
          status: "uploading" as const,
        };
      }),
      claimAccountErasureJobs: vi.fn(async () => {
        if (!firstErasureClaimed) {
          firstErasureClaimed = true;
          return [erasureJob];
        }
        return allowFinalErasure ? [erasureJob] : [];
      }),
      claimPrivacyExportJobs: vi.fn(async () => {
        if (exportClaimed) return [];
        exportClaimed = true;
        return [exportJob];
      }),
      completePrivacyExportStagedArtifactDeletion: vi.fn(async () => {
        stagedDeleted = true;
      }),
      executeAccountErasureJob: execute,
      listAccountPrivacyExportArtifactsForErasure: vi.fn(async () => {
        if (uploadInFlight) {
          cancellationRequested = true;
          throw new Error("active upload lease");
        }
        return stagedDeleted
          ? []
          : [
              {
                artifactId: "e0000000-0000-4000-8000-000000000009",
                exportJobId: exportId,
                format: "json" as const,
                objectKey: [...lateRaw.objects.keys()][0] ?? `exports/v1/${exportId}/late/json.enc`,
                source: "staged" as const,
              },
            ];
      }),
      markPrivacyExportStagedArtifactUploaded: vi.fn(async () => {
        uploadInFlight = false;
        if (cancellationRequested) throw new Error("upload was fenced by erasure");
        throw new Error("expected erasure cancellation");
      }),
    });
    const options = {
      ...workerOptions(repo, { ...base, exportArtifactStore, exportRaw: lateRaw }),
      exportArtifactStore,
    };
    const exporter = runRetentionWorkerPoll(options);
    await lateRaw.started;
    await runRetentionWorkerPoll(options);
    expect(execute).not.toHaveBeenCalled();
    lateRaw.release();
    await exporter;
    expect(lateRaw.objects.size).toBe(0);

    allowFinalErasure = true;
    await runRetentionWorkerPoll(options);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lateRaw.objects.size).toBe(0);
  });

  it("renews job and PUT fences across more than fifteen logical minutes", async () => {
    const base = stores();
    const pausedRaw = new PausedPutRawStore();
    const exportArtifactStore = new EncryptedArtifactStore({
      keyRing: {
        currentKeyId: "export-v1",
        keys: new Map([["export-v1", Buffer.alloc(32, 1)]]),
        purpose: "export",
      },
      nonce: () => Buffer.alloc(12, 1),
      rawStore: pausedRaw,
    });
    let logicalTime = Date.parse(now) - 5 * 60_000;
    const clock = () => {
      logicalTime += 5 * 60_000;
      return new Date(logicalTime);
    };
    let firstClaimAt: number | null = null;
    let latestRenewal = 0;
    let claims = 0;
    const complete = vi.fn(async () => undefined);
    const renewWork = vi.fn(async (input) => {
      if (input.kind === "privacy_export") latestRenewal = Date.parse(input.renewedAt);
    });
    const repo = repository({
      claimPrivacyExportJobs: vi.fn(async (input) => {
        claims += 1;
        const claimAt = Date.parse(input.now);
        if (claims === 1) {
          firstClaimAt = claimAt;
          latestRenewal = claimAt;
          return [exportJob];
        }
        return claimAt - latestRenewal > 15 * 60_000 ? [exportJob] : [];
      }),
      completePrivacyExportJob: complete,
      renewRetentionWorkLease: renewWork,
    });
    const options = {
      ...workerOptions(repo, { ...base, exportArtifactStore, exportRaw: pausedRaw }),
      clock,
      exportArtifactStore,
      uploadLeaseMs: 15 * 60_000,
      workLeaseHeartbeatMs: 10,
    };

    const firstWorker = runRetentionWorkerPoll(options);
    await pausedRaw.started;
    await new Promise((resolve) => setTimeout(resolve, 55));
    const secondWorker = runRetentionWorkerPoll(options);
    await secondWorker;

    expect(firstClaimAt).not.toBeNull();
    expect(logicalTime - (firstClaimAt ?? logicalTime)).toBeGreaterThan(15 * 60_000);
    expect(renewWork.mock.calls.length).toBeGreaterThan(2);
    expect(repo.renewPrivacyExportStagedArtifactUploadLease).toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    pausedRaw.release();
    await firstWorker;
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
