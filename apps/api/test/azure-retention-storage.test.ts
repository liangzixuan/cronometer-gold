import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  ArtifactAuthenticationError,
  EncryptedArtifactStore,
  FileRawArtifactStore,
} from "@nutrition-tracker/artifact-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigValidationError, loadApiDependencyConfig } from "../src/config.js";
import { createApiRetentionArtifactRuntime } from "../src/retention-artifact-runtime.js";

const seen = vi.hoisted(() => ({
  options: [] as unknown[],
  opens: [] as unknown[],
  body: undefined as Buffer | undefined,
  missing: false,
}));
vi.mock("@nutrition-tracker/artifact-store", async (original) => {
  const actual = await original<typeof import("@nutrition-tracker/artifact-store")>();
  return {
    ...actual,
    AzureBlobRawArtifactStore: class extends actual.AzureBlobRawArtifactStore {
      constructor(options: ConstructorParameters<typeof actual.AzureBlobRawArtifactStore>[0]) {
        super(options);
        seen.options.push(options);
      }
      override async open(
        input: Parameters<InstanceType<typeof actual.AzureBlobRawArtifactStore>["open"]>[0],
      ): ReturnType<InstanceType<typeof actual.AzureBlobRawArtifactStore>["open"]> {
        seen.opens.push(input);
        if (seen.missing) return null;
        if (!seen.body) throw new Error("Synthetic raw response was not configured");
        return {
          stream: Readable.from([seen.body]),
          contentLength: seen.body.byteLength,
          readIdentity: Object.freeze({
            kind: "azure-blob-current" as const,
            containerUrl: "https://nourishingexports.blob.core.windows.net/exports",
            prefix: "development/exports/",
            objectKey: input.objectKey,
            blobName: `development/exports/${input.objectKey}`,
            contentLength: seen.body.byteLength,
          }),
        };
      }
    },
  };
});
const cleanup: string[] = [];
const now = Date.UTC(2026, 9, 9, 12);
function token(permission = "r") {
  return new URLSearchParams({
    sv: "2026-04-06",
    spr: "https",
    st: "2026-10-09T11:00:00Z",
    se: "2026-10-09T15:00:00Z",
    sr: "c",
    sp: permission,
    sig: "api-only-synthetic",
    skoid: "api-reader",
    sktid: "tenant",
    skt: "2026-10-09T10:00:00Z",
    ske: "2026-10-09T16:00:00Z",
    sks: "b",
    skv: "2026-04-06",
  }).toString();
}
function environment(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://synthetic.invalid/nutrition",
    RETENTION_FEATURES_ENABLED: "true",
    EXPORT_ARTIFACT_STORE: "azure",
    EXPORT_ARTIFACT_AZURE_CONTAINER_URL: "https://nourishingexports.blob.core.windows.net/exports",
    EXPORT_ARTIFACT_AZURE_PREFIX: "development/exports/",
    EXPORT_ARTIFACT_AZURE_READ_SAS: token(),
    EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-v1",
    EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({
      "export-v1": Buffer.alloc(32, 1).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-v1",
    ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
      "locator-v1": Buffer.alloc(32, 2).toString("base64"),
    }),
    DEVICE_CHALLENGE_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    ERASURE_STATUS_CAPABILITY_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  seen.options.length = 0;
  seen.opens.length = 0;
  seen.body = undefined;
  seen.missing = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("API Azure storage selection", () => {
  it("joins validated container, prefix and read-only SAS to the real factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-azure-storage-"));
    cleanup.push(root);
    const env = environment();
    env.EXPORT_ARTIFACT_READ_SPOOL_DIR = join(root, "read");
    const config = loadApiDependencyConfig(env).retention!;
    expect(config.artifactStore).toBe("azure");
    const runtime = await createApiRetentionArtifactRuntime(config);
    expect(seen.options).toEqual([
      expect.objectContaining({
        containerUrl: env.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
        prefix: "development/exports/",
        sasToken: env.EXPORT_ARTIFACT_AZURE_READ_SAS,
        role: "reader",
      }),
    ]);
    await expect(
      runtime.store.put({
        objectKey: "forbidden",
        mediaType: "application/json",
        plaintextBytes: 1,
        source: Readable.from(["x"]),
      }),
    ).rejects.toThrow();
  });
  it.each([
    "EXPORT_ARTIFACT_AZURE_CONTAINER_URL",
    "EXPORT_ARTIFACT_AZURE_PREFIX",
    "EXPORT_ARTIFACT_AZURE_READ_SAS",
  ])("requires explicit %s", (field) => {
    const env = environment();
    delete env[field];
    expect(() => loadApiDependencyConfig(env)).toThrow(ConfigValidationError);
  });
  it.each([
    "EXPORT_ARTIFACT_BUCKET",
    "EXPORT_ARTIFACT_ENDPOINT",
    "EXPORT_ARTIFACT_REGION",
    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_READ_SESSION_TOKEN",
    "EXPORT_ARTIFACT_AZURE_WRITE_SAS",
    "EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS",
  ])("rejects mixed or writer setting %s", (field) => {
    expect(() =>
      loadApiDependencyConfig({
        ...environment(),
        [field]: field.endsWith("ENDPOINT") ? "https://example.invalid" : "forbidden-private-value",
      }),
    ).toThrow(ConfigValidationError);
  });
  it("rejects a write-capable SAS without exposing its bytes", () => {
    const env = { ...environment(), EXPORT_ARTIFACT_AZURE_READ_SAS: token("rcd") };
    try {
      loadApiDependencyConfig(env);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).not.toContain("api-only-synthetic");
    }
  });
  it("rejects Azure credentials when another provider is selected", () => {
    expect(() =>
      loadApiDependencyConfig({ ...environment(), EXPORT_ARTIFACT_STORE: "filesystem" }),
    ).toThrow(ConfigValidationError);
  });
  it("keeps production transport, restore and protected-spool requirements", () => {
    expect(() => loadApiDependencyConfig({ ...environment(), NODE_ENV: "production" })).toThrow(
      ConfigValidationError,
    );
  });
});

async function encryptedFixture() {
  const root = await mkdtemp(join(tmpdir(), "api-azure-read-"));
  cleanup.push(root);
  const env = { ...environment(), EXPORT_ARTIFACT_READ_SPOOL_DIR: join(root, "read") };
  const config = loadApiDependencyConfig(env).retention!;
  const writer = new EncryptedArtifactStore({
    keyRing: config.artifactEncryptionKeyRing,
    rawStore: new FileRawArtifactStore(join(root, "encrypted")),
  });
  const plaintext = Buffer.from('{"diary":"synthetic export"}');
  const metadata = await writer.put({
    objectKey: "export-fixture",
    mediaType: "application/json",
    plaintextBytes: plaintext.byteLength,
    source: Readable.from([plaintext]),
  });
  seen.body = await readFile(join(root, "encrypted", metadata.objectKey));
  return {
    root,
    config,
    plaintext,
    metadata,
    runtime: await createApiRetentionArtifactRuntime(config),
  };
}
describe("API Azure encrypted export read", () => {
  it("authenticates selected raw bytes through the configured runtime and removes the owned read spool", async () => {
    const f = await encryptedFixture();
    const opened = await f.runtime.store.openAuthenticated(f.metadata);
    expect(opened).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(f.plaintext);
    expect(opened!.contentLength).toBe(f.plaintext.byteLength);
    expect(seen.opens).toEqual([{ objectKey: f.metadata.objectKey }]);
    await opened!.dispose();
    expect(await readdir(f.config.artifactReadSpoolDirectory)).toEqual([]);
  });
  it("refuses altered encrypted bytes without returning a plaintext stream", async () => {
    const f = await encryptedFixture();
    const last = seen.body![seen.body!.length - 1];
    if (last === undefined) throw new Error("Synthetic ciphertext is empty");
    seen.body![seen.body!.length - 1] = last ^ 1;
    await expect(f.runtime.store.openAuthenticated(f.metadata)).rejects.toEqual(
      new ArtifactAuthenticationError(),
    );
    expect(seen.opens).toEqual([{ objectKey: f.metadata.objectKey }]);
    expect(await readdir(f.config.artifactReadSpoolDirectory)).toEqual([]);
  });
  it("preserves a missing object response", async () => {
    const f = await encryptedFixture();
    seen.missing = true;
    await expect(f.runtime.store.openAuthenticated(f.metadata)).resolves.toBeNull();
    expect(seen.opens).toEqual([{ objectKey: f.metadata.objectKey }]);
  });
  it("accepts Azure while retaining all fully specified production-shaped prerequisites", () => {
    const env: NodeJS.ProcessEnv = {
      ...environment(),
      NODE_ENV: "production",
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_RESTORE_EPOCH: "synthetic-production-restore-epoch-2026-10-09",
      SEARCH_CURSOR_SECRET: "synthetic-cursor-secret-with-at-least-32-bytes",
      MEILI_SEARCH_KEY: "synthetic-read-only-search-key",
      MEILI_URL: "https://search.invalid",
      EXPORT_ARTIFACT_READ_SPOOL_DIR: "/tmp/synthetic-api-azure-read",
      EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: "encrypted_volume",
    };
    expect(loadApiDependencyConfig(env)).toMatchObject({
      requireDatabaseRestoreAttestation: true,
      retention: {
        artifactStore: "azure",
        artifactAzureContainerUrl: env.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
        artifactAzurePrefix: env.EXPORT_ARTIFACT_AZURE_PREFIX,
        artifactAzureReadSas: env.EXPORT_ARTIFACT_AZURE_READ_SAS,
      },
    });
  });
});
