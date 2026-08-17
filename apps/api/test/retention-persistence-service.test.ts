import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";

import { canonicalJson, healthImportSignaturePayload } from "@nutrition-tracker/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  RetentionExportInProgressError: class RetentionExportInProgressError extends Error {},
  applyPlatformHealthImportBatch: vi.fn(),
  createPrivacyExportJob: vi.fn(),
  getActiveDeviceRegistration: vi.fn(),
  getPrivacyExportJob: vi.fn(),
  listPlatformIntegrations: vi.fn(),
  listBiometricEvents: vi.fn(),
  recordPrivacyExportArtifactDownloadAudit: vi.fn(),
  registerDevice: vi.fn(),
  requestAccountErasure: vi.fn(),
}));

vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  RetentionExportInProgressError: databaseMocks.RetentionExportInProgressError,
  applyPlatformHealthImportBatch: databaseMocks.applyPlatformHealthImportBatch,
  createPrivacyExportJob: databaseMocks.createPrivacyExportJob,
  getActiveDeviceRegistration: databaseMocks.getActiveDeviceRegistration,
  getPrivacyExportJob: databaseMocks.getPrivacyExportJob,
  listPlatformIntegrations: databaseMocks.listPlatformIntegrations,
  listBiometricEvents: databaseMocks.listBiometricEvents,
  recordPrivacyExportArtifactDownloadAudit: databaseMocks.recordPrivacyExportArtifactDownloadAudit,
  registerDevice: databaseMocks.registerDevice,
  requestAccountErasure: databaseMocks.requestAccountErasure,
}));

import {
  type PlatformIntegrationRecord,
  type PrivacyExportJobRecord,
  RetentionExportInProgressError,
  RetentionImportConflictError,
  RetentionNotFoundError,
} from "@nutrition-tracker/db";
import {
  RetentionDeviceAuthenticationServiceError,
  RetentionExportInProgressServiceError,
  RetentionImportConflictServiceError,
  RetentionRecentAuthenticationServiceError,
} from "../src/modules/retention/retention.routes.js";
import { DatabaseRetentionService } from "../src/retention-persistence-service.js";

const userId = "10000000-0000-4000-8000-000000000001";
const deviceId = "20000000-0000-4000-8000-000000000002";
const batchId = "30000000-0000-4000-8000-000000000003";
const now = "2026-08-16T12:00:00.000Z";

const exportArtifact: PrivacyExportJobRecord["artifacts"][number] = {
  ciphertextBytes: "128",
  encryptionKeyId: "export-v1",
  expiresAt: "2026-09-16T12:00:00.000Z",
  fileName: "account-export.json",
  format: "json",
  id: "31000000-0000-4000-8000-000000000003",
  mediaType: "application/json",
  objectKey: "exports/v1/job/json.enc",
  plaintextBytes: "10",
  plaintextSha256: "d".repeat(64),
};

function completedExportJob(
  artifacts: PrivacyExportJobRecord["artifacts"],
  expiresAt = "2026-09-16T12:00:00.000Z",
): PrivacyExportJobRecord {
  return {
    artifacts,
    completedAt: now,
    createdAt: now,
    entityCount: "1",
    expiresAt,
    failureCode: null,
    id: batchId,
    manifestDigest: "e".repeat(64),
    reconciliation: {
      entities: [],
      exportedSemanticDigest: "f".repeat(64),
      reconciled: true,
      snapshotWatermark: "1",
      sourceSemanticDigest: "f".repeat(64),
    },
    requestedFormats: ["json", "csv"],
    snapshotId: "snapshot-1",
    startedAt: "2026-08-16T12:00:01.000Z",
    status: "completed",
    updatedAt: now,
    userId,
    watermarkRevision: "1",
  };
}

function queuedExportJob(): PrivacyExportJobRecord {
  return {
    ...completedExportJob([]),
    completedAt: null,
    entityCount: null,
    expiresAt: null,
    manifestDigest: null,
    reconciliation: null,
    snapshotId: null,
    startedAt: null,
    status: "queued",
    watermarkRevision: null,
  };
}

function service(publicKeySpkiBase64: string, artifacts: unknown = {}) {
  databaseMocks.getActiveDeviceRegistration.mockResolvedValue({ publicKeySpkiBase64 });
  databaseMocks.applyPlatformHealthImportBatch.mockResolvedValue({
    accepted: 0,
    conflicts: [],
    deleted: 0,
    duplicates: 0,
    replayed: false,
  });
  return new DatabaseRetentionService({
    artifacts: artifacts as never,
    database: {} as never,
    deviceChallengeHmacKey: Buffer.alloc(32, 1),
    erasureLedgerLocatorKeyRing: {
      currentKeyId: "locator-v1",
      keys: new Map([["locator-v1", Buffer.alloc(32, 2)]]),
    },
    erasureStatusCapabilityHmacKey: Buffer.alloc(32, 3),
    clock: () => new Date(now),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("database retention service", () => {
  it("maps the authoritative cursor epoch on integration reads", async () => {
    const record: PlatformIntegrationRecord = {
      consentGrantedAt: now,
      consentHistory: [
        {
          dataTypeCodes: ["body_weight"],
          id: batchId,
          recordedAt: now,
          status: "granted",
        },
      ],
      currentRevision: "3",
      currentSourceCursor: null,
      cursorEpoch: "7",
      dataTypeCodes: ["body_weight"],
      deviceId,
      disconnectedAt: null,
      id: batchId,
      lastImportAt: null,
      platform: "apple_healthkit",
      status: "connected",
    };
    databaseMocks.listPlatformIntegrations.mockResolvedValueOnce([record]);

    await expect(service("unused").listPlatformIntegrations({ userId })).resolves.toMatchObject({
      data: [{ cursorEpoch: "7", deviceId, currentSourceCursor: null }],
    });
  });

  it("uses canonical body bytes for signed import replay despite wire-key order", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeySpkiBase64 = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const first = {
      deviceId,
      batchId,
      platform: "apple_healthkit" as const,
      cursorEpoch: "1",
      sourceCursor: null,
      nextSourceCursor: "next-anchor-digest",
      records: [],
    };
    const reordered = {
      records: [],
      nextSourceCursor: "next-anchor-digest",
      sourceCursor: null,
      cursorEpoch: "1",
      platform: "apple_healthkit" as const,
      batchId,
      deviceId,
    };
    const signedAt = "2026-08-16T12:00:00.000Z";
    const nonce = "n".repeat(22);
    const payload = healthImportSignaturePayload({
      batchId,
      bodySha256: createHash("sha256").update(canonicalJson(first)).digest("hex"),
      deviceId,
      nonce,
      platform: "apple_healthkit",
      signedAt,
    });
    const signature = sign("sha256", Buffer.from(payload), privateKey).toString("base64url");
    const retention = service(publicKeySpkiBase64);
    for (const request of [first, reordered]) {
      await retention.importPlatformHealth({
        canonicalSignaturePayload: payload,
        clientOperationId: batchId,
        nonce,
        request,
        requestDigest: "a".repeat(64),
        signature,
        signedAt,
        timestampFresh: true,
        userId,
      });
    }
    const digests = databaseMocks.applyPlatformHealthImportBatch.mock.calls.map(
      ([, input]) => input.batchDigest,
    );
    expect(digests).toEqual([digests[0], digests[0]]);
    expect(digests[0]).toBe(
      createHash("sha256").update(canonicalJson(first), "utf8").digest("hex"),
    );
    expect(databaseMocks.applyPlatformHealthImportBatch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cursorEpoch: "1" }),
    );
  });

  it("rejects a correctly signed pre-rebind epoch after the integration advances", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeySpkiBase64 = publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const request = {
      batchId,
      cursorEpoch: "1",
      deviceId,
      nextSourceCursor: "next-anchor-digest",
      platform: "apple_healthkit" as const,
      records: [],
      sourceCursor: null,
    };
    const nonce = "n".repeat(22);
    const canonicalSignaturePayload = healthImportSignaturePayload({
      batchId,
      bodySha256: createHash("sha256").update(canonicalJson(request), "utf8").digest("hex"),
      deviceId,
      nonce,
      platform: request.platform,
      signedAt: now,
    });
    const signature = sign("sha256", Buffer.from(canonicalSignaturePayload), privateKey).toString(
      "base64url",
    );
    databaseMocks.applyPlatformHealthImportBatch.mockRejectedValueOnce(
      new RetentionImportConflictError(),
    );

    await expect(
      service(publicKeySpkiBase64).importPlatformHealth({
        canonicalSignaturePayload,
        clientOperationId: batchId,
        nonce,
        request,
        requestDigest: "a".repeat(64),
        signature,
        signedAt: now,
        timestampFresh: true,
        userId,
      }),
    ).rejects.toBeInstanceOf(RetentionImportConflictServiceError);
    expect(databaseMocks.applyPlatformHealthImportBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursorEpoch: "1" }),
    );
  });

  it("maps a missing, expired, consumed, or copied registration challenge to device authentication", async () => {
    databaseMocks.registerDevice.mockRejectedValue(new RetentionNotFoundError());
    const retention = service("unused");
    await expect(
      retention.registerDevice({
        clientOperationId: batchId,
        requestDigest: "a".repeat(64),
        userId,
        request: {
          attestation: null,
          challenge: "q".repeat(43),
          challengeId: batchId,
          challengeSignature: "c2lnbmF0dXJl",
          displayName: "Test phone",
          platform: "apple_healthkit",
          publicKey: { algorithm: "ES256", derBase64: "c3BraQ==", format: "spki" },
        },
        verification: {
          canonicalSignaturePayload: "device-registration-frame",
          keyFingerprint: "b".repeat(64),
          proofSignatureDigest: "c".repeat(64),
          publicKeySpkiBase64: "c3BraQ==",
        },
      }),
    ).rejects.toBeInstanceOf(RetentionDeviceAuthenticationServiceError);
  });

  it("maps a revoked, wrong-owner, or wrong-platform import key to device authentication", async () => {
    databaseMocks.getActiveDeviceRegistration.mockRejectedValue(new RetentionNotFoundError());
    const retention = service("unused");
    databaseMocks.getActiveDeviceRegistration.mockRejectedValue(new RetentionNotFoundError());
    await expect(
      retention.importPlatformHealth({
        canonicalSignaturePayload: "signed-frame",
        clientOperationId: batchId,
        nonce: "n".repeat(22),
        request: {
          batchId,
          cursorEpoch: "1",
          deviceId,
          nextSourceCursor: "next",
          platform: "apple_healthkit",
          records: [],
          sourceCursor: null,
        },
        requestDigest: "a".repeat(64),
        signature: "c2lnbmF0dXJl",
        signedAt: now,
        timestampFresh: true,
        userId,
      }),
    ).rejects.toBeInstanceOf(RetentionDeviceAuthenticationServiceError);
  });

  it("maps unusable recent-auth proofs to the dedicated 401 service error", async () => {
    const retention = service("unused");
    databaseMocks.createPrivacyExportJob.mockRejectedValue(new RetentionNotFoundError());
    await expect(
      retention.createExport({
        clientOperationId: batchId,
        reauthenticationToken: "r".repeat(43),
        request: { formats: ["json"] },
        requestDigest: "a".repeat(64),
        sessionTokenHash: "b".repeat(64),
        userId,
      }),
    ).rejects.toBeInstanceOf(RetentionRecentAuthenticationServiceError);

    databaseMocks.requestAccountErasure.mockRejectedValue(new RetentionNotFoundError());
    await expect(
      retention.requestErasure({
        clientOperationId: batchId,
        reauthenticationToken: "r".repeat(43),
        request: { confirmation: "DELETE_MY_ACCOUNT" },
        requestDigest: "a".repeat(64),
        sessionTokenHash: "b".repeat(64),
        userId,
      }),
    ).rejects.toBeInstanceOf(RetentionRecentAuthenticationServiceError);
  });

  it("preserves exact export replay and maps a distinct active job to bounded capacity", async () => {
    const retention = service("unused");
    databaseMocks.createPrivacyExportJob.mockResolvedValueOnce({
      job: queuedExportJob(),
      replayed: true,
    });
    const input = {
      clientOperationId: batchId,
      reauthenticationToken: "r".repeat(43),
      request: { formats: ["json" as const] },
      requestDigest: "a".repeat(64),
      sessionTokenHash: "b".repeat(64),
      userId,
    };
    await expect(retention.createExport(input)).resolves.toMatchObject({
      data: { export: { status: "queued" }, replayed: true },
    });

    databaseMocks.createPrivacyExportJob.mockRejectedValueOnce(
      new RetentionExportInProgressError(),
    );
    await expect(
      retention.createExport({
        ...input,
        clientOperationId: "40000000-0000-4000-8000-000000000004",
      }),
    ).rejects.toBeInstanceOf(RetentionExportInProgressServiceError);
  });

  it("preserves imported biometric device provenance while manual events remain device-free", async () => {
    const base = {
      createdAt: now,
      currentRevision: "1",
      definition: { id: batchId },
      id: batchId,
      localDate: "2026-08-16",
      measuredAt: now,
      timeZone: "America/Chicago",
      updatedAt: now,
      value: "72.125",
    };
    databaseMocks.listBiometricEvents.mockResolvedValue({
      nextCursor: null,
      records: [
        {
          ...base,
          source: {
            deviceId: null,
            externalRevision: null,
            externalSourceId: null,
            kind: "manual",
            provider: null,
          },
        },
        {
          ...base,
          id: deviceId,
          source: {
            deviceId,
            externalRevision: "2",
            externalSourceId: "health-record-1",
            kind: "platform",
            provider: "apple_healthkit",
          },
        },
      ],
    });
    await expect(
      service("unused").listBiometricEvents({
        from: "2026-08-01T00:00:00.000Z",
        limit: 100,
        to: "2026-08-31T23:59:59.999Z",
        userId,
      }),
    ).resolves.toMatchObject({
      data: [
        { source: { deviceId: null, kind: "manual" } },
        { source: { deviceId, kind: "apple_healthkit" } },
      ],
    });
  });

  it("durably audits authenticated artifact open and missing-ciphertext outcomes", async () => {
    databaseMocks.getPrivacyExportJob.mockResolvedValue(completedExportJob([exportArtifact]));
    const dispose = vi.fn(async () => undefined);
    const openAuthenticated = vi
      .fn()
      .mockResolvedValueOnce({ contentLength: 10, dispose, stream: Readable.from(["0123456789"]) })
      .mockResolvedValueOnce(null);
    const retention = service("unused", { bulkhead: { openAuthenticated }, store: {} });
    const opened = await retention.getExportArtifact({ exportId: batchId, format: "json", userId });
    expect(opened).toMatchObject({ contentLength: 10, mediaType: "application/json" });
    await expect(
      retention.getExportArtifact({ exportId: batchId, format: "json", userId }),
    ).resolves.toBeNull();
    expect(
      databaseMocks.recordPrivacyExportArtifactDownloadAudit.mock.calls.map(
        ([, input]) => input.outcome,
      ),
    ).toEqual(["opened", "not_found"]);
    expect(
      databaseMocks.recordPrivacyExportArtifactDownloadAudit.mock.calls[0]?.[1],
    ).not.toHaveProperty("objectKey");
  });

  it("maps the durable first-start timestamp rather than a later job update", async () => {
    databaseMocks.getPrivacyExportJob.mockResolvedValue({
      ...completedExportJob([exportArtifact]),
      startedAt: "2026-08-16T11:55:00.000Z",
      updatedAt: "2026-08-16T12:30:00.000Z",
    });
    await expect(service("unused").getExport({ exportId: batchId, userId })).resolves.toMatchObject(
      {
        data: { export: { startedAt: "2026-08-16T11:55:00.000Z" } },
      },
    );
  });

  it("returns ownership-indistinguishable absence after partial or complete TTL purge", async () => {
    const bulkheadOpen = vi.fn();
    const retention = service("unused", {
      bulkhead: { openAuthenticated: bulkheadOpen },
      store: {},
    });
    for (const artifacts of [[exportArtifact], []] as const) {
      databaseMocks.getPrivacyExportJob.mockResolvedValueOnce(
        completedExportJob(artifacts, "2026-08-16T11:59:59.999Z"),
      );
      await expect(retention.getExport({ exportId: batchId, userId })).resolves.toBeNull();
    }
    databaseMocks.getPrivacyExportJob.mockResolvedValueOnce(
      completedExportJob([exportArtifact], "2026-08-16T11:59:59.999Z"),
    );
    await expect(
      retention.getExportArtifact({ exportId: batchId, format: "json", userId }),
    ).resolves.toBeNull();
    expect(bulkheadOpen).not.toHaveBeenCalled();
    expect(databaseMocks.recordPrivacyExportArtifactDownloadAudit).not.toHaveBeenCalled();
  });
});
