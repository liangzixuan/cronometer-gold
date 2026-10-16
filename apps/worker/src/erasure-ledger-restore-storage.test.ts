import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AZURE_LEDGER_RESTORE_READ_BUDGET,
  AzureBlobRawArtifactStore,
  EncryptedArtifactStore,
  EncryptedErasureReplayLedger,
  FileRawArtifactStore,
  S3RawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as restore from "./erasure-ledger-restore.js";

const operations = vi.hoisted(() => ({
  azure: [] as unknown[],
  s3: [] as unknown[],
  create: vi.fn(),
  migration: vi.fn(),
  replay: vi.fn(),
  reconcile: vi.fn(),
  attest: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("@nutrition-tracker/artifact-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nutrition-tracker/artifact-store")>();
  return {
    ...actual,
    AzureBlobRawArtifactStore: class extends actual.AzureBlobRawArtifactStore {
      constructor(options: ConstructorParameters<typeof actual.AzureBlobRawArtifactStore>[0]) {
        operations.azure.push(options);
        super(options);
      }
    },
    S3RawArtifactStore: class extends actual.S3RawArtifactStore {
      constructor(options: ConstructorParameters<typeof actual.S3RawArtifactStore>[0]) {
        operations.s3.push(options);
        super(options);
      }
    },
  };
});
vi.mock("@nutrition-tracker/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: operations.create,
  assertDatabaseMigrationLedgerReady: operations.migration,
  replayExternalErasureLedgerEntry: operations.replay,
  reconcileErasedAccountRows: operations.reconcile,
  completeDatabaseRestoreReplayAttestation: operations.attest,
  assertDatabaseReady: operations.ready,
}));

const first = "10000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const epoch = "synthetic-private-restore-epoch-".repeat(3);
function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_RESTORE_EPOCH: epoch,
    ERASURE_REPLAY_LEDGER_STORE: "azure",
    ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "azure_blob",
    ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
      "https://nourishingrecovery.blob.core.windows.net/ledger",
    ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "development/ledger/",
    ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: new URLSearchParams({
      sv: "2026-04-06",
      spr: "https",
      sr: "c",
      sp: "rl",
      sig: "synthetic-signature",
      st: "2026-10-09T11:00:00Z",
      se: "2026-10-09T15:00:00Z",
      skoid: "11111111-1111-4111-8111-111111111111",
      sktid: "22222222-2222-4222-8222-222222222222",
      skt: "2026-10-09T10:00:00Z",
      ske: "2026-10-09T16:00:00Z",
      sks: "b",
      skv: "2026-04-06",
    }).toString(),
    ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "aes",
    ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
      aes: Buffer.alloc(32, 7).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator",
    ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
      locator: Buffer.alloc(32, 8).toString("base64"),
    }),
  };
}
async function factory(env: NodeJS.ProcessEnv) {
  return restore.createErasureRestoreRawStore(env);
}

beforeEach(() => {
  vi.resetAllMocks();
  operations.azure.length = 0;
  operations.s3.length = 0;
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 9, 12));
});
afterEach(() => vi.restoreAllMocks());

describe("Azure ledger restore storage", () => {
  it("constructs the real exact-version reader with shared limits and no S3 configuration", async () => {
    const env = environment();
    env.ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS = "1234";
    const raw = await factory(env);
    expect(raw).toBeInstanceOf(AzureBlobRawArtifactStore);
    expect(operations.azure).toEqual([
      {
        containerUrl: env.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
        prefix: env.ERASURE_REPLAY_LEDGER_AZURE_PREFIX,
        sasToken: env.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS,
        role: "restore-reader",
        requestTimeoutMs: 1234,
        maximumObjectBytes: 16_384 + 128,
        restoreReadBudget: AZURE_LEDGER_RESTORE_READ_BUDGET,
      },
    ]);
    expect(operations.s3).toHaveLength(0);
    expect(operations.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "s3_compatible", "latest"])(
    "requires explicit Azure inventory %s",
    async (value) => {
      const env = environment();
      env.ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER = value;
      await expect(factory(env)).rejects.toThrow("Explicit Azure version inventory");
    },
  );
  it.each([
    "ERASURE_REPLAY_LEDGER_ENDPOINT",
    "ERASURE_REPLAY_LEDGER_BUCKET",
    "ERASURE_REPLAY_LEDGER_REGION",
    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_RESTORE_SESSION_TOKEN",
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN",
    "ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE",
    "ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS",
    "ERASURE_REPLAY_LEDGER_AZURE_READ_SAS",
  ])("rejects mixed storage field %s", async (name) => {
    await expect(
      factory({ ...environment(), [name]: "synthetic-private-conflict" }),
    ).rejects.toThrow("Mixed erasure restore storage");
    expect(operations.azure).toHaveLength(0);
    expect(operations.create).not.toHaveBeenCalled();
  });
  it.each([undefined, "s3", "other"])(
    "refuses undeclared or invalid Azure provider %s",
    async (provider) => {
      await expect(
        factory({ ...environment(), ERASURE_REPLAY_LEDGER_STORE: provider }),
      ).rejects.toThrow(/explicitly selected|Invalid erasure restore storage/u);
    },
  );
  it("does not accept writer permissions or expose supplied values in the error", async () => {
    const env = environment();
    env.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS =
      env.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS?.replace("sp=rl", "sp=rcd");
    await expect(factory(env)).rejects.toThrow("Azure artifact storage operation failed");
    await factory(env).catch((error) => expect(String(error)).not.toContain("synthetic-signature"));
  });
  it("preserves the existing explicit S3 reader and HTTPS policy", async () => {
    const env = {
      NODE_ENV: "production",
      ERASURE_REPLAY_LEDGER_STORE: "s3",
      ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "s3_compatible",
      ERASURE_REPLAY_LEDGER_ENDPOINT: "https://objects.example.test",
      ERASURE_REPLAY_LEDGER_BUCKET: "ledger",
      ERASURE_REPLAY_LEDGER_REGION: "us-east-1",
      ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: "synthetic-key",
      ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: "synthetic-secret",
    };
    expect(await factory(env)).toBeInstanceOf(S3RawArtifactStore);
    expect(operations.s3).toEqual([
      expect.objectContaining({ readVersionPolicy: "require_singleton", requestTimeoutMs: 30000 }),
    ]);
    await expect(
      factory({ ...env, ERASURE_REPLAY_LEDGER_ENDPOINT: "http://objects.example.test" }),
    ).rejects.toThrow("HTTPS");
    expect(operations.azure).toHaveLength(0);
  });
});

describe("Azure environment replay consumer", () => {
  it.each(["valid", "tampered"])(
    "authenticates %s ciphertext before replay/attestation and closes the DB",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "nutrition-azure-ledger-source-"));
      try {
        const ciphertext = join(root, "ciphertext");
        await mkdir(ciphertext, { mode: 0o700 });
        const file = new FileRawArtifactStore(ciphertext);
        const writer = new EncryptedErasureReplayLedger({
          artifactStore: new EncryptedArtifactStore({
            rawStore: file,
            keyRing: {
              purpose: "erasure_replay_ledger",
              currentKeyId: "aes",
              keys: new Map([["aes", Buffer.alloc(32, 7)]]),
            },
            maxPlaintextBytes: 16384,
            temporaryDirectory: root,
          }),
          locatorKeyRing: {
            currentKeyId: "locator",
            keys: new Map([["locator", Buffer.alloc(32, 8)]]),
          },
        });
        await writer.append({
          subjectUserId: first,
          jobId: "30000000-0000-4000-8000-000000000003",
          recordedAt: "2026-10-09T12:00:00.000Z",
          restoreLocator: writer.locatorForSubject(first),
        });
        const open = vi
          .spyOn(AzureBlobRawArtifactStore.prototype, "open")
          .mockImplementation(async (input) => {
            const value = await file.open(input);
            if (!value) return null;
            const readIdentity = {
              kind: "azure-blob-version" as const,
              containerUrl: "https://nourishingrecovery.blob.core.windows.net/ledger",
              prefix: "development/ledger/",
              objectKey: input.objectKey,
              blobName: "development/ledger/" + input.objectKey,
              contentLength: value.contentLength,
              versionId: "synthetic-version",
            };
            if (mode === "valid") return { ...value, readIdentity };
            const chunks: Buffer[] = [];
            for await (const chunk of value.stream) chunks.push(Buffer.from(chunk));
            const bytes = Buffer.concat(chunks);
            expect(bytes.length).toBeGreaterThan(0);
            bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
            const { Readable } = await import("node:stream");
            return { ...value, readIdentity, stream: Readable.from([bytes]) };
          });
        let cursor: string | undefined;
        const remaining = new Set([first, second]);
        const query = {
          select: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          where: vi.fn((_field: unknown, _op: unknown, value: string) => {
            cursor = value;
            return query;
          }),
          execute: vi.fn(async () =>
            [...remaining]
              .filter((id) => cursor === undefined || id > cursor)
              .map((id) => ({ id })),
          ),
        };
        const db = { selectFrom: vi.fn(() => query), destroy: vi.fn(async () => undefined) };
        operations.create.mockReturnValue(db);
        operations.replay.mockImplementation(async (_db, input) => {
          remaining.delete(input.subjectUserId);
          return { reconciled: true };
        });
        operations.reconcile.mockResolvedValue({
          reconciled: true,
          remainingRows: { app_user: "0" },
        });
        const env = {
          ...environment(),
          ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: join(root, "spool"),
        };
        if (mode === "valid") {
          const result = await restore.runErasureLedgerRestoreFromEnvironment(env);
          expect(result).toMatchObject({
            reconciled: true,
            scannedSubjects: 2,
            replayedTombstones: 1,
          });
          expect([...remaining]).toEqual([second]);
          expect(operations.replay).toHaveBeenCalledOnce();
          expect(operations.replay).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ subjectUserId: first }),
          );
          expect(operations.reconcile).toHaveBeenCalledWith(db, { userId: first });
          expect(operations.attest).toHaveBeenCalledWith(
            db,
            expect.objectContaining({
              restoreEpoch: epoch,
              replayedSubjectCount: 1,
              reconciliationDigest: result.reconciliationDigest,
            }),
          );
          expect(operations.ready).toHaveBeenCalledWith(db, {
            requireRestoreAttestation: true,
            restoreEpoch: epoch,
          });
          expect(JSON.stringify(result)).not.toContain("synthetic-signature");
          expect(JSON.stringify(result)).not.toContain(epoch);
        } else {
          await expect(restore.runErasureLedgerRestoreFromEnvironment(env)).rejects.toThrow();
          expect(operations.replay).not.toHaveBeenCalled();
          expect(operations.attest).not.toHaveBeenCalled();
          expect(operations.ready).not.toHaveBeenCalled();
        }
        expect(open).toHaveBeenCalled();
        expect(operations.migration).toHaveBeenCalledWith(db);
        expect(db.destroy).toHaveBeenCalledOnce();
        expect(await readdir(join(root, "spool"))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("keeps production protected-spool admission before DB creation or reads", async () => {
    const open = vi.spyOn(AzureBlobRawArtifactStore.prototype, "open");
    await expect(
      restore.runErasureLedgerRestoreFromEnvironment({
        ...environment(),
        NODE_ENV: "production",
        ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: join(tmpdir(), "unused-ledger-spool"),
      }),
    ).rejects.toThrow("SPOOL_PROTECTION");
    expect(operations.create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
