import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig, WorkerConfigValidationError } from "./config.js";
import { createRetentionStorageRuntime } from "./retention-storage.js";

const seen = vi.hoisted(() => ({
  options: [] as unknown[],
  objects: new Map<string, Buffer>(),
  operations: [] as Array<{ kind: string; scope: string; key: string }>,
}));
vi.mock("@nutrition-tracker/artifact-store", async (original) => {
  const actual = await original<typeof import("@nutrition-tracker/artifact-store")>();
  return {
    ...actual,
    AzureBlobRawArtifactStore: class extends actual.AzureBlobRawArtifactStore {
      readonly #fixtureOptions: ConstructorParameters<typeof actual.AzureBlobRawArtifactStore>[0];
      constructor(options: ConstructorParameters<typeof actual.AzureBlobRawArtifactStore>[0]) {
        super(options);
        this.#fixtureOptions = options;
        seen.options.push(options);
      }
      #scope() {
        return `${this.#fixtureOptions.containerUrl}/${this.#fixtureOptions.prefix}`;
      }
      override async put(
        input: Parameters<InstanceType<typeof actual.AzureBlobRawArtifactStore>["put"]>[0],
      ): Promise<void> {
        const scope = this.#scope(),
          key = scope + input.objectKey;
        if (seen.objects.has(key)) throw new Error("Synthetic create-only conflict");
        const chunks: Buffer[] = [];
        for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (bytes.byteLength !== input.contentLength) throw new Error("Synthetic length mismatch");
        seen.objects.set(key, bytes);
        seen.operations.push({ kind: "put", scope, key: input.objectKey });
      }
      override async open(
        input: Parameters<InstanceType<typeof actual.AzureBlobRawArtifactStore>["open"]>[0],
      ): ReturnType<InstanceType<typeof actual.AzureBlobRawArtifactStore>["open"]> {
        const scope = this.#scope();
        seen.operations.push({ kind: "open", scope, key: input.objectKey });
        const bytes = seen.objects.get(scope + input.objectKey);
        if (!bytes) return null;
        return {
          stream: Readable.from([Buffer.from(bytes)]),
          contentLength: bytes.byteLength,
          readIdentity: Object.freeze({
            kind: "azure-blob-current" as const,
            containerUrl: this.#fixtureOptions.containerUrl,
            prefix: this.#fixtureOptions.prefix,
            objectKey: input.objectKey,
            blobName: this.#fixtureOptions.prefix + input.objectKey,
            contentLength: bytes.byteLength,
          }),
        };
      }
    },
  };
});
const cleanup: string[] = [];
function token(permission: string, identity: string) {
  return new URLSearchParams({
    sv: "2026-04-06",
    spr: "https",
    st: "2026-10-09T11:00:00Z",
    se: "2026-10-09T15:00:00Z",
    sr: "c",
    sp: permission,
    sig: identity,
    skoid: identity,
    sktid: "tenant",
    skt: "2026-10-09T10:00:00Z",
    ske: "2026-10-09T16:00:00Z",
    sks: "b",
    skv: "2026-04-06",
  }).toString();
}
function environment(): NodeJS.ProcessEnv {
  return {
    RETENTION_FEATURES_ENABLED: "true",
    EXPORT_ARTIFACT_STORE: "azure",
    ERASURE_REPLAY_LEDGER_STORE: "azure",
    EXPORT_ARTIFACT_AZURE_CONTAINER_URL: "https://nourishingexports.blob.core.windows.net/exports",
    EXPORT_ARTIFACT_AZURE_PREFIX: "development/exports/",
    EXPORT_ARTIFACT_AZURE_WRITE_SAS: token("rcd", "export-writer"),
    EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS: token("l", "export-observer"),
    ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
      "https://nourishingrecovery.blob.core.windows.net/ledger",
    ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "development/ledger/",
    ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS: token("rc", "ledger-writer"),
    EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
    EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
      "export-v1": Buffer.alloc(32, 1).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "ledger-v1",
    ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
      "ledger-v1": Buffer.alloc(32, 2).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
    ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 3).toString("base64"),
    }),
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 9, 12));
  seen.options.length = 0;
  seen.objects.clear();
  seen.operations.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("worker Azure storage selection", () => {
  it("constructs separate export and durable ledger consumers with exact prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-azure-storage-"));
    cleanup.push(root);
    const config = parseWorkerConfig({
      ...environment(),
      RETENTION_EXPORT_SPOOL_DIR: join(root, "spool"),
    });
    await createRetentionStorageRuntime(config);
    expect(seen.options).toEqual([
      expect.objectContaining({
        containerUrl: config.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
        prefix: "development/exports/",
        sasToken: config.EXPORT_ARTIFACT_AZURE_WRITE_SAS,
        deletionObserverSasToken: config.EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS,
        role: "export-writer",
      }),
      expect.objectContaining({
        containerUrl: config.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
        prefix: "development/ledger/",
        sasToken: config.ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS,
        role: "ledger-writer",
      }),
    ]);
  });
  it.each(["EXPORT_ARTIFACT", "ERASURE_REPLAY_LEDGER"])(
    "requires the exact %s settings",
    (namespace) => {
      for (const suffix of ["AZURE_CONTAINER_URL", "AZURE_PREFIX", "AZURE_WRITE_SAS"]) {
        const env = environment();
        delete env[namespace + "_" + suffix];
        expect(() => parseWorkerConfig(env)).toThrow(WorkerConfigValidationError);
      }
    },
  );
  it.each(["EXPORT_ARTIFACT", "ERASURE_REPLAY_LEDGER"])(
    "rejects mixed %s credentials",
    (namespace) => {
      for (const suffix of [
        "BUCKET",
        "REGION",
        "WRITE_ACCESS_KEY_ID",
        "WRITE_SECRET_ACCESS_KEY",
        "WRITE_SESSION_TOKEN",
        "AZURE_READ_SAS",
        "AZURE_RESTORE_SAS",
      ]) {
        expect(() =>
          parseWorkerConfig({ ...environment(), [namespace + "_" + suffix]: "forbidden" }),
        ).toThrow(WorkerConfigValidationError);
      }
    },
  );
  it("requires a separate list-only export observer and rejects unrelated consumers", () => {
    for (const sas of [
      undefined,
      token("r", "observer"),
      token("rl", "observer"),
      token("rcd", "export-writer"),
    ]) {
      const env = environment();
      if (sas === undefined) delete env.EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS;
      else env.EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS = sas;
      expect(() => parseWorkerConfig(env)).toThrow(WorkerConfigValidationError);
    }
    expect(() =>
      parseWorkerConfig({
        ...environment(),
        ERASURE_REPLAY_LEDGER_AZURE_DELETE_OBSERVER_SAS: token("l", "observer"),
      }),
    ).toThrow(WorkerConfigValidationError);
  });
  it("rejects export and ledger storage in the same account", () => {
    expect(() =>
      parseWorkerConfig({
        ...environment(),
        ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
          "https://nourishingexports.blob.core.windows.net/ledger",
      }),
    ).toThrow(WorkerConfigValidationError);
  });
  it("rejects a delete-capable ledger credential", () => {
    expect(() =>
      parseWorkerConfig({
        ...environment(),
        ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS: token("rcd", "ledger-writer"),
      }),
    ).toThrow(WorkerConfigValidationError);
  });
  it("rejects undeclared provider selection and old delete-version controls", () => {
    expect(() =>
      parseWorkerConfig({ ...environment(), EXPORT_ARTIFACT_STORE: "filesystem" }),
    ).toThrow(WorkerConfigValidationError);
    expect(() =>
      parseWorkerConfig({ ...environment(), EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "latest" }),
    ).toThrow(WorkerConfigValidationError);
  });
  it("retains production database, search and protected spool requirements", () => {
    expect(() => parseWorkerConfig({ ...environment(), NODE_ENV: "production" })).toThrow(
      WorkerConfigValidationError,
    );
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-azure-consumers-"));
  cleanup.push(root);
  const config = parseWorkerConfig({
    ...environment(),
    RETENTION_EXPORT_SPOOL_DIR: join(root, "spool"),
  });
  const clock = new Date("2026-10-09T12:00:00.000Z");
  return {
    root,
    config,
    clock,
    runtime: await createRetentionStorageRuntime(config, { clock: () => clock }),
  };
}
describe("worker Azure encrypted consumers", () => {
  it("publishes and authenticates an encrypted export in the selected export namespace", async () => {
    const f = await fixture(),
      plaintext = Buffer.from('{"diary":"synthetic worker export"}');
    const metadata = await f.runtime.exportArtifactStore.put({
      objectKey: "synthetic-export",
      mediaType: "application/json",
      plaintextBytes: plaintext.byteLength,
      source: Readable.from([plaintext]),
    });
    expect(metadata.encryptionKeyId).toBe("export-v1");
    expect(seen.objects.size).toBe(1);
    const cipher = Array.from(seen.objects.values())[0];
    if (!cipher) throw new Error("Synthetic encrypted publication is missing");
    expect(cipher.subarray(0, 8).toString("ascii")).toBe("NTAE0001");
    expect(cipher.includes(plaintext)).toBe(false);
    expect(cipher.byteLength).toBe(metadata.ciphertextBytes);
    const opened = await f.runtime.exportArtifactStore.openAuthenticated(metadata);
    if (!opened) throw new Error("Synthetic encrypted read is missing");
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    await opened.dispose();
    expect(seen.operations.map((o) => o.kind)).toEqual(["put", "open"]);
    expect(
      seen.operations.every(
        (o) => o.scope === `${f.config.EXPORT_ARTIFACT_AZURE_CONTAINER_URL}/development/exports/`,
      ),
    ).toBe(true);
    expect(await readdir(f.config.RETENTION_EXPORT_SPOOL_DIR)).toEqual([]);
  });
  it("appends and authenticates the ledger entry in its separate purpose and namespace", async () => {
    const f = await fixture(),
      subjectUserId = "11111111-1111-4111-8111-111111111111",
      jobId = "22222222-2222-4222-8222-222222222222";
    const restoreLocator = f.runtime.erasureLedger.locatorForSubject(subjectUserId);
    const receipt = await f.runtime.erasureLedger.append({
      subjectUserId,
      jobId,
      restoreLocator,
      recordedAt: f.clock.toISOString(),
    });
    expect(receipt.acknowledgedAt).toBe(f.clock.toISOString());
    expect(await f.runtime.erasureLedger.findForSubject({ subjectUserId })).toMatchObject({
      subjectUserId,
      jobId,
      restoreLocator,
      recordedAt: f.clock.toISOString(),
    });
    expect(seen.objects.size).toBe(1);
    expect(seen.operations.some((o) => o.kind === "put")).toBe(true);
    expect(
      seen.operations.every(
        (o) =>
          o.scope === `${f.config.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL}/development/ledger/`,
      ),
    ).toBe(true);
    expect(await readdir(f.config.RETENTION_EXPORT_SPOOL_DIR)).toEqual([]);
  });
  it("accepts fully specified production-shaped Azure stores without old provider credentials", () => {
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://service:synthetic@postgres.invalid/nutrition",
      DATABASE_RESTORE_EPOCH: "synthetic-production-restore-epoch-2026-10-09",
      MEILI_ADMIN_KEY: "synthetic-search-admin-key",
      MEILI_TASK_OBSERVER_KEY: "synthetic-distinct-search-observer",
      MEILI_URL: "https://search.invalid",
      RETENTION_EXPORT_SPOOL_DIR: "/tmp/synthetic-azure-worker",
      RETENTION_EXPORT_SPOOL_PROTECTION: "encrypted_volume",
    };
    expect(parseWorkerConfig(env)).toMatchObject({
      EXPORT_ARTIFACT_STORE: "azure",
      ERASURE_REPLAY_LEDGER_STORE: "azure",
      RETENTION_FEATURES_ENABLED: true,
    });
  });
});
