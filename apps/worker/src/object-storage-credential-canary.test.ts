import { Readable } from "node:stream";

import {
  S3ArtifactStoreError,
  type SingletonObjectVersionResolver,
} from "@nutrition-tracker/artifact-store";
import { describe, expect, it } from "vitest";

import {
  loadObjectStorageCredentialCanaryConfiguration,
  type ObjectStorageCredentialCanaryClients,
  type ObjectStorageCredentialCanaryStore,
  runObjectStorageCredentialCanary,
} from "./object-storage-credential-canary.js";

const token = Buffer.alloc(12, 1).toString("hex");
const exportObject = `exports/v1/.credential-canary/${token}`;
const ledgerObject = `erasure-ledger/v1/.credential-canary/${token}`;
const versionId = "native-version-1";

async function body(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function opened(value: Buffer): Awaited<ReturnType<ObjectStorageCredentialCanaryStore["open"]>> {
  return {
    contentLength: value.byteLength,
    stream: Readable.from([value]),
  };
}

function denied(statusCode = 403): S3ArtifactStoreError {
  return new S3ArtifactStoreError(statusCode);
}

function unusedStore(): ObjectStorageCredentialCanaryStore {
  return {
    delete: async () => {
      throw new Error("Unexpected DELETE");
    },
    listObjectVersions: async () => {
      throw new Error("Unexpected list");
    },
    open: async () => {
      throw new Error("Unexpected GET");
    },
    put: async () => {
      throw new Error("Unexpected PUT");
    },
  };
}

interface FakeCanary {
  readonly clients: ObjectStorageCredentialCanaryClients;
  readonly exportObjects: Map<string, Buffer>;
  readonly ledgerObjects: Map<string, Buffer>;
  readonly nativeCalls: { count: number };
  setLedgerDeleteBehavior(behavior: "deny" | "delete-marker"): void;
  setOverwriteStatus(statusCode: number): void;
}

function fakeCanary(): FakeCanary {
  const exportObjects = new Map<string, Buffer>();
  const ledgerObjects = new Map<string, Buffer>();
  const nativeCalls = { count: 0 };
  let overwriteStatus = 412;
  let ledgerDeleteBehavior: "deny" | "delete-marker" = "deny";
  let ledgerDeleteMarker = false;

  const read = async (objects: Map<string, Buffer>, objectKey: string) => {
    const value = objects.get(objectKey);
    return value ? opened(value) : null;
  };
  const exportWriter: ObjectStorageCredentialCanaryStore = {
    delete: async ({ objectKey }) => {
      exportObjects.delete(objectKey);
    },
    listObjectVersions: async () => {
      throw denied();
    },
    open: async ({ objectKey }) => read(exportObjects, objectKey),
    put: async ({ objectKey, source }) => {
      if (!objectKey.startsWith("exports/v1/") || exportObjects.has(objectKey)) {
        throw denied(exportObjects.has(objectKey) ? overwriteStatus : 403);
      }
      exportObjects.set(objectKey, await body(source));
    },
  };
  const ledgerWriter: ObjectStorageCredentialCanaryStore = {
    delete: async () => {
      if (ledgerDeleteBehavior === "deny") throw denied();
      ledgerDeleteMarker = true;
    },
    listObjectVersions: async () => {
      throw denied();
    },
    open: async ({ objectKey }) => read(ledgerObjects, objectKey),
    put: async ({ objectKey, source }) => {
      if (!objectKey.startsWith("erasure-ledger/v1/") || ledgerObjects.has(objectKey)) {
        throw denied(ledgerObjects.has(objectKey) ? overwriteStatus : 403);
      }
      ledgerObjects.set(objectKey, await body(source));
    },
  };
  const nativeResolver: SingletonObjectVersionResolver = {
    resolveSingletonVersion: async ({ objectKey }) => {
      nativeCalls.count += 1;
      if (!exportObjects.has(exportObject)) {
        throw new Error("Native inventory ran before the export target existed");
      }
      if (objectKey !== ledgerObject || !ledgerObjects.has(objectKey)) return null;
      if (ledgerDeleteMarker) throw denied(409);
      return { versionId };
    },
  };
  const clients: ObjectStorageCredentialCanaryClients = {
    createExactLedgerRestore: (resolver) => ({
      ...unusedStore(),
      open: async ({ objectKey }) => {
        const resolved = await resolver.resolveSingletonVersion({ objectKey });
        if (!resolved || resolved.versionId !== versionId) throw denied(409);
        return read(ledgerObjects, objectKey);
      },
    }),
    exportReader: {
      ...unusedStore(),
      delete: async () => {
        throw denied();
      },
      open: async ({ objectKey }) => read(exportObjects, objectKey),
      put: async () => {
        throw denied();
      },
    },
    exportWriter,
    exportWriterLedger: {
      ...unusedStore(),
      open: async () => null,
    },
    ledgerRestore: {
      ...unusedStore(),
      delete: async () => {
        if (ledgerDeleteBehavior === "deny") throw denied();
        ledgerDeleteMarker = true;
      },
      open: async ({ objectKey }) => read(ledgerObjects, objectKey),
      put: async () => {
        throw denied();
      },
    },
    ledgerRestoreExport: {
      ...unusedStore(),
      open: async () => {
        throw denied();
      },
    },
    ledgerVersionResolver: nativeResolver,
    ledgerWriter,
  };
  return {
    clients,
    exportObjects,
    ledgerObjects,
    nativeCalls,
    setLedgerDeleteBehavior: (behavior) => {
      ledgerDeleteBehavior = behavior;
    },
    setOverwriteStatus: (statusCode) => {
      overwriteStatus = statusCode;
    },
  };
}

function deterministicRandom(size: number): Buffer {
  return Buffer.alloc(size, size === 12 ? 1 : 2);
}

describe("OCI Object Storage credential canary", () => {
  it("proves both objects, strict denials, native exact-version reads, and export cleanup", async () => {
    const fake = fakeCanary();
    await expect(
      runObjectStorageCredentialCanary(fake.clients, deterministicRandom),
    ).resolves.toEqual({ exportCleanupVerified: true, ledgerCanaryRetained: true });
    expect(fake.exportObjects.size).toBe(0);
    expect(fake.ledgerObjects.has(ledgerObject)).toBe(true);
    expect(fake.nativeCalls.count).toBeGreaterThanOrEqual(4);
  });

  it("accepts an immutable 412 overwrite only after the authorized object remains readable", async () => {
    const fake = fakeCanary();
    fake.setOverwriteStatus(412);
    await expect(
      runObjectStorageCredentialCanary(fake.clients, deterministicRandom),
    ).resolves.toMatchObject({ exportCleanupVerified: true });
    expect(fake.exportObjects.size).toBe(0);
  });

  it("rejects an unexpected overwrite status and still cleans the export object", async () => {
    const fake = fakeCanary();
    fake.setOverwriteStatus(409);
    await expect(
      runObjectStorageCredentialCanary(fake.clients, deterministicRandom),
    ).rejects.toThrow("overwrite returned an unexpected result");
    expect(fake.exportObjects.size).toBe(0);
  });

  it("detects a successful ledger delete marker even though the frozen exact version is readable", async () => {
    const fake = fakeCanary();
    fake.setLedgerDeleteBehavior("delete-marker");
    await expect(
      runObjectStorageCredentialCanary(fake.clients, deterministicRandom),
    ).rejects.toThrow("Native OCI inventory changed after a denied ledger operation");
    expect(fake.exportObjects.size).toBe(0);
    expect(fake.ledgerObjects.has(ledgerObject)).toBe(true);
  });

  it("loads only the existing production env contract and keeps private-key material off argv", async () => {
    const namespace = "axaxnpcrorw5";
    const region = "us-ashburn-1";
    const endpoint = "https://axaxnpcrorw5.compat.objectstorage.us-ashburn-1.oci.customer-oci.com";
    const environment: NodeJS.ProcessEnv = {
      ERASURE_REPLAY_LEDGER_BUCKET: "nutrition-erasure-ledger",
      ERASURE_REPLAY_LEDGER_ENDPOINT: endpoint,
      ERASURE_REPLAY_LEDGER_REGION: region,
      ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: "restore-access-id-4",
      ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT:
        "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
      ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE: namespace,
      ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE: "/run/oci/restore-private-key.pem",
      ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID: "ocid1.tenancy.oc1..aaaaaaaaaaaaaaaa",
      ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID: "ocid1.user.oc1..bbbbbbbbbbbbbbbb",
      ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: "restore-secret-key-4",
      ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "oci_native",
      ERASURE_REPLAY_LEDGER_STORE: "s3",
      ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: "ledger-access-id-3",
      ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: "ledger-secret-key-3",
      EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
      EXPORT_ARTIFACT_DELETE_VERSION_POLICY: "latest",
      EXPORT_ARTIFACT_ENDPOINT: endpoint,
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "reader-access-id-1",
      EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "reader-secret-key-1",
      EXPORT_ARTIFACT_REGION: region,
      EXPORT_ARTIFACT_STORE: "s3",
      EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: "writer-access-id-2",
      EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "writer-secret-key-2",
      NODE_ENV: "production",
    };
    const loadedPaths: string[] = [];
    const configuration = await loadObjectStorageCredentialCanaryConfiguration(
      environment,
      async (path) => {
        loadedPaths.push(path);
        return "private-key-material";
      },
    );
    expect(loadedPaths).toEqual(["/run/oci/restore-private-key.pem"]);
    expect(configuration.privateKeyPem).toBe("private-key-material");
    expect(configuration.exportReader.accessKeyId).toBe("reader-access-id-1");
    await expect(
      loadObjectStorageCredentialCanaryConfiguration(
        { ...environment, EXPORT_ARTIFACT_STORE: "filesystem" },
        async () => "private-key-material",
      ),
    ).rejects.toThrow("EXPORT_ARTIFACT_STORE must be s3");
  });
});
