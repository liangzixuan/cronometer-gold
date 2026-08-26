import { randomBytes, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  OciNativeObjectVersionResolver,
  S3ArtifactStoreError,
  S3RawArtifactStore,
  type S3RawArtifactStoreOptions,
  type SingletonObjectVersionResolver,
} from "@nutrition-tracker/artifact-store";

import { loadOciApiSigningPrivateKey } from "./oci-api-key-file.js";
import { assertOciS3CompatibilityEndpoint } from "./oci-object-storage-config.js";

const CANARY_PAYLOAD_BYTES = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MINIMUM_REQUEST_TIMEOUT_MS = 1_000;
const MAXIMUM_REQUEST_TIMEOUT_MS = 300_000;

export type ObjectStorageCredentialCanaryStore = Pick<
  S3RawArtifactStore,
  "delete" | "listObjectVersions" | "open" | "put"
>;

export interface ObjectStorageCredentialCanaryS3Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface ObjectStorageCredentialCanaryConfiguration {
  readonly exportBucket: string;
  readonly exportEndpoint: string;
  readonly exportReader: ObjectStorageCredentialCanaryS3Credential;
  readonly exportRegion: string;
  readonly exportWriter: ObjectStorageCredentialCanaryS3Credential;
  readonly ledgerBucket: string;
  readonly ledgerEndpoint: string;
  readonly ledgerRegion: string;
  readonly ledgerRestore: ObjectStorageCredentialCanaryS3Credential;
  readonly ledgerWriter: ObjectStorageCredentialCanaryS3Credential;
  readonly namespace: string;
  readonly privateKeyPem: string;
  readonly requestTimeoutMs: number;
  readonly restoreFingerprint: string;
  readonly restoreTenancyOcid: string;
  readonly restoreUserOcid: string;
  readonly versionListProvider: "oci_native";
}

export interface ObjectStorageCredentialCanaryClients {
  readonly exportReader: ObjectStorageCredentialCanaryStore;
  readonly exportWriter: ObjectStorageCredentialCanaryStore;
  readonly exportWriterLedger: ObjectStorageCredentialCanaryStore;
  readonly ledgerRestore: ObjectStorageCredentialCanaryStore;
  readonly ledgerRestoreExport: ObjectStorageCredentialCanaryStore;
  readonly ledgerVersionResolver: SingletonObjectVersionResolver;
  readonly ledgerWriter: ObjectStorageCredentialCanaryStore;
  readonly createExactLedgerRestore: (
    resolver: SingletonObjectVersionResolver,
  ) => ObjectStorageCredentialCanaryStore;
}

export interface ObjectStorageCredentialCanaryResult {
  readonly exportCleanupVerified: true;
  readonly ledgerCanaryRetained: true;
}

export class ObjectStorageCredentialCanaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectStorageCredentialCanaryError";
  }
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximumLength = 8_192,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > maximumLength ||
    /\s/u.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new ObjectStorageCredentialCanaryError(`Missing or invalid ${name}`);
  }
  return value;
}

function requiredLiteral(environment: NodeJS.ProcessEnv, name: string, expected: string): void {
  if (environment[name] !== expected) {
    throw new ObjectStorageCredentialCanaryError(`${name} must be ${expected}`);
  }
}

function versionListProvider(environment: NodeJS.ProcessEnv): "oci_native" | "s3_compatible" {
  const value = environment.ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER;
  if (value !== "oci_native" && value !== "s3_compatible") {
    throw new ObjectStorageCredentialCanaryError(
      "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER must be oci_native or s3_compatible",
    );
  }
  return value;
}

function assertHttpsS3Endpoint(endpoint: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ObjectStorageCredentialCanaryError(`Missing or invalid ${name}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new ObjectStorageCredentialCanaryError(`${name} must be a bare HTTPS endpoint`);
  }
}

function optionalEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximumLength: number,
): string | undefined {
  if (environment[name] === undefined) return undefined;
  return requiredEnvironment(environment, name, maximumLength);
}

function requestTimeout(environment: NodeJS.ProcessEnv): number {
  const raw =
    environment.ERASURE_REPLAY_LEDGER_RESTORE_REQUEST_TIMEOUT_MS ??
    environment.EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new ObjectStorageCredentialCanaryError("Invalid Object Storage request timeout");
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_REQUEST_TIMEOUT_MS ||
    value > MAXIMUM_REQUEST_TIMEOUT_MS
  ) {
    throw new ObjectStorageCredentialCanaryError("Invalid Object Storage request timeout");
  }
  return value;
}

function credential(
  environment: NodeJS.ProcessEnv,
  accessKeyName: string,
  secretKeyName: string,
  sessionTokenName: string,
): ObjectStorageCredentialCanaryS3Credential {
  const accessKeyId = requiredEnvironment(environment, accessKeyName, 256);
  const secretAccessKey = requiredEnvironment(environment, secretKeyName, 256);
  if (accessKeyId.length < 16 || secretAccessKey.length < 16) {
    throw new ObjectStorageCredentialCanaryError("Object Storage credential is too short");
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(optionalEnvironment(environment, sessionTokenName, 8_192)
      ? { sessionToken: requiredEnvironment(environment, sessionTokenName, 8_192) }
      : {}),
  };
}

function assertDistinctCredentials(
  credentials: readonly ObjectStorageCredentialCanaryS3Credential[],
): void {
  if (
    new Set(credentials.map(({ accessKeyId }) => accessKeyId)).size !== credentials.length ||
    new Set(credentials.map(({ secretAccessKey }) => secretAccessKey)).size !== credentials.length
  ) {
    throw new ObjectStorageCredentialCanaryError(
      "Every Object Storage principal must use distinct credentials",
    );
  }
}

/**
 * Loads the existing runtime/api/worker/restore environment contract. No secret
 * is accepted through argv or stdin.
 */
export async function loadObjectStorageCredentialCanaryConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  loadPrivateKey: (path: string) => Promise<string> = loadOciApiSigningPrivateKey,
): Promise<ObjectStorageCredentialCanaryConfiguration> {
  requiredLiteral(environment, "NODE_ENV", "production");
  requiredLiteral(environment, "EXPORT_ARTIFACT_STORE", "s3");
  requiredLiteral(environment, "EXPORT_ARTIFACT_DELETE_VERSION_POLICY", "latest");
  requiredLiteral(environment, "ERASURE_REPLAY_LEDGER_STORE", "s3");
  const provider = versionListProvider(environment);
  if (provider === "s3_compatible") {
    throw new ObjectStorageCredentialCanaryError(
      "Generic S3 production canary is blocked until export-bucket version state and exact cleanup are reviewed",
    );
  }

  const exportEndpoint = requiredEnvironment(environment, "EXPORT_ARTIFACT_ENDPOINT", 2_048);
  const exportRegion = requiredEnvironment(environment, "EXPORT_ARTIFACT_REGION", 64);
  const ledgerEndpoint = requiredEnvironment(environment, "ERASURE_REPLAY_LEDGER_ENDPOINT", 2_048);
  const ledgerRegion = requiredEnvironment(environment, "ERASURE_REPLAY_LEDGER_REGION", 64);
  let namespace: string | undefined;
  if (provider === "oci_native") {
    namespace = requiredEnvironment(
      environment,
      "ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE",
      100,
    );
    assertOciS3CompatibilityEndpoint({
      endpoint: exportEndpoint,
      namespace,
      region: exportRegion,
    });
    assertOciS3CompatibilityEndpoint({
      endpoint: ledgerEndpoint,
      namespace,
      region: ledgerRegion,
    });
  } else {
    assertHttpsS3Endpoint(exportEndpoint, "EXPORT_ARTIFACT_ENDPOINT");
    assertHttpsS3Endpoint(ledgerEndpoint, "ERASURE_REPLAY_LEDGER_ENDPOINT");
  }

  const exportReader = credential(
    environment,
    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_READ_SESSION_TOKEN",
  );
  const exportWriter = credential(
    environment,
    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_WRITE_SESSION_TOKEN",
  );
  const ledgerWriter = credential(
    environment,
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN",
  );
  const ledgerRestore = credential(
    environment,
    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_RESTORE_SESSION_TOKEN",
  );
  assertDistinctCredentials([exportReader, exportWriter, ledgerWriter, ledgerRestore]);

  const exportBucket = requiredEnvironment(environment, "EXPORT_ARTIFACT_BUCKET", 63);
  const ledgerBucket = requiredEnvironment(environment, "ERASURE_REPLAY_LEDGER_BUCKET", 63);
  if (exportBucket === ledgerBucket) {
    throw new ObjectStorageCredentialCanaryError(
      "Export and ledger Object Storage buckets must be distinct",
    );
  }

  const baseConfiguration = {
    exportBucket,
    exportEndpoint,
    exportReader,
    exportRegion,
    exportWriter,
    ledgerBucket,
    ledgerEndpoint,
    ledgerRegion,
    ledgerRestore,
    ledgerWriter,
    requestTimeoutMs: requestTimeout(environment),
  };
  if (namespace === undefined) {
    throw new ObjectStorageCredentialCanaryError(
      "Missing or invalid ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE",
    );
  }
  return {
    ...baseConfiguration,
    namespace,
    privateKeyPem: await loadPrivateKey(
      requiredEnvironment(environment, "ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE", 4_096),
    ),
    restoreFingerprint: requiredEnvironment(
      environment,
      "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT",
      47,
    ),
    restoreTenancyOcid: requiredEnvironment(
      environment,
      "ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID",
      300,
    ),
    restoreUserOcid: requiredEnvironment(
      environment,
      "ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID",
      300,
    ),
    versionListProvider: provider,
  };
}

function storeOptions(input: {
  readonly bucket: string;
  readonly credential: ObjectStorageCredentialCanaryS3Credential;
  readonly endpoint: string;
  readonly region: string;
  readonly requestTimeoutMs: number;
}): S3RawArtifactStoreOptions {
  return {
    accessKeyId: input.credential.accessKeyId,
    bucket: input.bucket,
    endpoint: input.endpoint,
    region: input.region,
    requestTimeoutMs: input.requestTimeoutMs,
    secretAccessKey: input.credential.secretAccessKey,
    ...(input.credential.sessionToken ? { sessionToken: input.credential.sessionToken } : {}),
  };
}

export function createObjectStorageCredentialCanaryClients(
  configuration: ObjectStorageCredentialCanaryConfiguration,
): ObjectStorageCredentialCanaryClients {
  const exportOptions = (
    credential: ObjectStorageCredentialCanaryS3Credential,
  ): S3RawArtifactStoreOptions =>
    storeOptions({
      bucket: configuration.exportBucket,
      credential,
      endpoint: configuration.exportEndpoint,
      region: configuration.exportRegion,
      requestTimeoutMs: configuration.requestTimeoutMs,
    });
  const ledgerOptions = (
    credential: ObjectStorageCredentialCanaryS3Credential,
  ): S3RawArtifactStoreOptions =>
    storeOptions({
      bucket: configuration.ledgerBucket,
      credential,
      endpoint: configuration.ledgerEndpoint,
      region: configuration.ledgerRegion,
      requestTimeoutMs: configuration.requestTimeoutMs,
    });
  const ledgerRestore = new S3RawArtifactStore(ledgerOptions(configuration.ledgerRestore));
  const resolver: SingletonObjectVersionResolver = new OciNativeObjectVersionResolver({
    bucket: configuration.ledgerBucket,
    fingerprint: configuration.restoreFingerprint,
    namespace: configuration.namespace,
    privateKeyPem: configuration.privateKeyPem,
    region: configuration.ledgerRegion,
    requestTimeoutMs: configuration.requestTimeoutMs,
    tenancyOcid: configuration.restoreTenancyOcid,
    userOcid: configuration.restoreUserOcid,
  });

  return {
    createExactLedgerRestore: (singletonVersionResolver) =>
      new S3RawArtifactStore({
        ...ledgerOptions(configuration.ledgerRestore),
        readVersionPolicy: "require_singleton",
        singletonVersionResolver,
      }),
    exportReader: new S3RawArtifactStore(exportOptions(configuration.exportReader)),
    exportWriter: new S3RawArtifactStore(exportOptions(configuration.exportWriter)),
    exportWriterLedger: new S3RawArtifactStore(ledgerOptions(configuration.exportWriter)),
    ledgerRestore,
    ledgerRestoreExport: new S3RawArtifactStore(exportOptions(configuration.ledgerRestore)),
    ledgerVersionResolver: resolver,
    ledgerWriter: new S3RawArtifactStore(ledgerOptions(configuration.ledgerWriter)),
  };
}

function canaryError(message: string, cause?: unknown): ObjectStorageCredentialCanaryError {
  return new ObjectStorageCredentialCanaryError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isAuthorizationDenial(error: unknown, allowConcealedNotFound = false): boolean {
  return (
    error instanceof S3ArtifactStoreError &&
    (error.statusCode === 401 ||
      error.statusCode === 403 ||
      (allowConcealedNotFound && error.statusCode === 404))
  );
}

async function put(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  payload: Buffer,
): Promise<void> {
  await store.put({
    contentLength: payload.byteLength,
    objectKey,
    source: Readable.from([payload]),
  });
}

async function readAndVerify(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  expected: Buffer,
): Promise<void> {
  const opened = await store.open({ objectKey });
  if (!opened) throw canaryError("Required Object Storage canary object was not found");
  if (opened.contentLength !== expected.byteLength) {
    opened.stream.destroy();
    throw canaryError("Object Storage canary content length did not match");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of opened.stream) {
    const value = Buffer.from(chunk as Uint8Array);
    bytes += value.byteLength;
    if (bytes > expected.byteLength) {
      opened.stream.destroy();
      throw canaryError("Object Storage canary response exceeded its bound");
    }
    chunks.push(value);
  }
  const actual = Buffer.concat(chunks);
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw canaryError("Object Storage canary payload did not match");
  }
}

async function assertPutDenied(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  payload: Buffer,
): Promise<void> {
  try {
    await put(store, objectKey, payload);
  } catch (error) {
    if (isAuthorizationDenial(error)) return;
    throw canaryError("Object Storage PUT denial returned an unexpected result", error);
  }
  throw canaryError("Object Storage PUT unexpectedly succeeded");
}

async function assertImmutableOverwritePrevented(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  payload: Buffer,
  verifyUnchanged: () => Promise<void>,
): Promise<void> {
  let prevented = false;
  try {
    await put(store, objectKey, payload);
  } catch (error) {
    if (
      error instanceof S3ArtifactStoreError &&
      (error.statusCode === 403 || error.statusCode === 412)
    ) {
      prevented = true;
    } else {
      throw canaryError("Immutable Object Storage overwrite returned an unexpected result", error);
    }
  }
  await verifyUnchanged();
  if (!prevented) throw canaryError("Immutable Object Storage overwrite unexpectedly succeeded");
}

async function assertListDenied(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  verifyStillExists: () => Promise<void>,
): Promise<void> {
  let denialObserved = false;
  try {
    await store.listObjectVersions({ objectKey });
  } catch (error) {
    if (!isAuthorizationDenial(error, true)) {
      throw canaryError("Object Storage list denial returned an unexpected result", error);
    }
    denialObserved = true;
  }
  await verifyStillExists();
  if (!denialObserved) throw canaryError("Object Storage list unexpectedly succeeded");
}

async function assertReadDenied(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  verifyStillExists: () => Promise<void>,
): Promise<void> {
  let denialObserved = false;
  try {
    const opened = await store.open({ objectKey });
    if (opened) {
      opened.stream.destroy();
      throw canaryError("Cross-bucket Object Storage read unexpectedly succeeded");
    }
    denialObserved = true;
  } catch (error) {
    if (error instanceof ObjectStorageCredentialCanaryError) throw error;
    if (!isAuthorizationDenial(error, true)) {
      throw canaryError("Cross-bucket Object Storage read returned an unexpected result", error);
    }
    denialObserved = true;
  }
  await verifyStillExists();
  if (!denialObserved) throw canaryError("Cross-bucket Object Storage read was not denied");
}

async function assertDeleteDenied(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
  verifyStillExists: () => Promise<void>,
): Promise<void> {
  try {
    await store.delete({ objectKey });
  } catch (error) {
    if (!isAuthorizationDenial(error, true)) {
      throw canaryError("Object Storage DELETE denial returned an unexpected result", error);
    }
  }
  // S3RawArtifactStore deliberately maps HTTP 404 DELETE to success. The
  // authorized read postcondition distinguishes concealed denial from deletion.
  await verifyStillExists();
}

async function verifyDeleted(
  store: ObjectStorageCredentialCanaryStore,
  objectKey: string,
): Promise<void> {
  const opened = await store.open({ objectKey });
  if (opened) {
    opened.stream.destroy();
    throw canaryError("Export Object Storage canary cleanup did not delete the object");
  }
}

/** Runs the live allow/deny matrix against injected clients without starting the worker. */
export async function runObjectStorageCredentialCanary(
  clients: ObjectStorageCredentialCanaryClients,
  random: (size: number) => Buffer = randomBytes,
): Promise<ObjectStorageCredentialCanaryResult> {
  const token = random(12).toString("hex");
  const payload = random(CANARY_PAYLOAD_BYTES);
  if (token.length !== 24 || payload.byteLength !== CANARY_PAYLOAD_BYTES) {
    throw canaryError("Object Storage canary randomness provider returned an invalid result");
  }
  const exportObject = `exports/v1/.credential-canary/${token}`;
  const exportReaderCreateProbe = `${exportObject}-reader-create`;
  const ledgerObject = `erasure-ledger/v1/.credential-canary/${token}`;
  const ledgerRestoreCreateProbe = `${ledgerObject}-restore-create`;
  let exportCreated = false;
  let failure: unknown;
  let cleanupFailure: unknown;

  try {
    await put(clients.exportWriter, exportObject, payload);
    exportCreated = true;
    await put(clients.ledgerWriter, ledgerObject, payload);

    // Both targets are proved present before either cross-bucket denial runs.
    await readAndVerify(clients.exportWriter, exportObject, payload);
    await readAndVerify(clients.exportReader, exportObject, payload);
    await readAndVerify(clients.ledgerWriter, ledgerObject, payload);
    const inventoryVersion = await clients.ledgerVersionResolver.resolveSingletonVersion({
      objectKey: ledgerObject,
    });
    if (!inventoryVersion) {
      throw canaryError("Version inventory did not return the ledger canary version");
    }
    const frozenResolver: SingletonObjectVersionResolver = {
      resolveSingletonVersion: async ({ objectKey }) => {
        if (objectKey !== ledgerObject) {
          throw canaryError("Exact-version restore requested an unexpected object key");
        }
        return inventoryVersion;
      },
    };
    const exactLedgerRestore = clients.createExactLedgerRestore(frozenResolver);
    const verifyExport = () => readAndVerify(clients.exportWriter, exportObject, payload);
    const verifyLedgerExact = () => readAndVerify(exactLedgerRestore, ledgerObject, payload);
    const verifyLedgerInventory = async () => {
      let currentVersion: { readonly versionId: string } | null;
      try {
        currentVersion = await clients.ledgerVersionResolver.resolveSingletonVersion({
          objectKey: ledgerObject,
        });
      } catch (error) {
        throw canaryError("Version inventory changed after a denied ledger operation", error);
      }
      if (!currentVersion || currentVersion.versionId !== inventoryVersion.versionId) {
        throw canaryError("Version inventory changed after a denied ledger operation");
      }
      await verifyLedgerExact();
    };
    await verifyLedgerExact();

    await assertPutDenied(clients.exportReader, exportReaderCreateProbe, payload);
    const readerProbe = await clients.exportWriter.open({ objectKey: exportReaderCreateProbe });
    if (readerProbe) {
      readerProbe.stream.destroy();
      throw canaryError("Export reader created an object despite its denial");
    }
    await assertDeleteDenied(clients.exportReader, exportObject, verifyExport);
    await assertImmutableOverwritePrevented(
      clients.exportWriter,
      exportObject,
      payload,
      verifyExport,
    );
    await assertPutDenied(clients.exportWriter, `outside-reviewed-prefix/${token}-export`, payload);
    await assertListDenied(clients.exportWriter, exportObject, verifyExport);

    await assertImmutableOverwritePrevented(
      clients.ledgerWriter,
      ledgerObject,
      payload,
      verifyLedgerInventory,
    );
    await assertPutDenied(clients.ledgerWriter, `outside-reviewed-prefix/${token}-ledger`, payload);
    await assertDeleteDenied(clients.ledgerWriter, ledgerObject, verifyLedgerInventory);
    await assertListDenied(clients.ledgerWriter, ledgerObject, verifyLedgerExact);
    await assertPutDenied(clients.ledgerRestore, ledgerRestoreCreateProbe, payload);
    const restoreProbe = await clients.ledgerWriter.open({ objectKey: ledgerRestoreCreateProbe });
    if (restoreProbe) {
      restoreProbe.stream.destroy();
      throw canaryError("Ledger restore principal created an object despite its denial");
    }
    await assertDeleteDenied(clients.ledgerRestore, ledgerObject, verifyLedgerInventory);

    await assertReadDenied(clients.exportWriterLedger, ledgerObject, verifyLedgerExact);
    await assertReadDenied(clients.ledgerRestoreExport, exportObject, verifyExport);
  } catch (error) {
    failure = error;
  } finally {
    if (exportCreated) {
      try {
        await clients.exportWriter.delete({ objectKey: exportObject });
        await verifyDeleted(clients.exportWriter, exportObject);
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }

  if (failure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [failure, cleanupFailure],
      "Object Storage canary and mandatory export cleanup both failed",
    );
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) {
    throw canaryError("Mandatory export canary cleanup failed", cleanupFailure);
  }
  return { exportCleanupVerified: true, ledgerCanaryRetained: true };
}

export async function runObjectStorageCredentialCanaryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ObjectStorageCredentialCanaryResult> {
  const configuration = await loadObjectStorageCredentialCanaryConfiguration(environment);
  return runObjectStorageCredentialCanary(
    createObjectStorageCredentialCanaryClients(configuration),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runObjectStorageCredentialCanaryFromEnvironment()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: "object_storage.credentials.attested", level: "info", ...result })}\n`,
      );
    })
    .catch((error: unknown) => {
      const errorType =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name
          : "UnknownError";
      process.stderr.write(
        `${JSON.stringify({ event: "object_storage.credentials.failed", errorType, level: "fatal" })}\n`,
      );
      process.exitCode = 1;
    });
}
