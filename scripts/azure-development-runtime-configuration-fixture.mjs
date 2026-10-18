import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { runtimeClientEnvironment } from "./azure-development-runtime-client.mjs";
import { renderDevelopmentRuntimeDatabaseBootstrap } from "./azure-development-runtime-database.mts";
import { references, runtimeDockerFixture } from "./azure-development-runtime-fixture.mjs";
import { azureBackupFixture } from "./postgres-backup-azure-fixture.mjs";

const source = resolve(fileURLToPath(new URL("../", import.meta.url))),
  revision = "a".repeat(40),
  database = {
    databaseName: "nourishing_development_12345678",
    owner: "development_owner",
    api: "development_api",
    worker: "development_worker",
  };
const publicCA = rootCertificates.find((value) =>
  new X509Certificate(value).subject.split("\n").includes("CN=ISRG Root X1"),
);
assert(publicCA, "Pinned Node public root bundle must contain the public parser fixture");
const key = (value) => Buffer.alloc(32, value).toString("base64");
const sas = (permission) => {
  const value = new URLSearchParams(
    azureBackupFixture({ hosted: true }).storage(permission).sasToken,
  );
  value.set("se", new Date(Date.now() + 3 * 3_600_000).toISOString());
  value.set("ske", new Date(Date.now() + 4 * 3_600_000).toISOString());
  return value.toString();
};

export async function fixture(t, options = {}) {
  const f = options.base ?? (await runtimeDockerFixture(t)),
    root = f.root,
    common = {
      NODE_ENV: "development",
      NOURISHING_API_PROFILE: "hosted-development",
      SERVICE_VERSION: revision,
    },
    dbCommon = {
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_RESTORE_EPOCH: "synthetic-development-runtime-original-epoch-v1",
    },
    dbUrl = (role, char) =>
      `postgresql://${role}:${char.repeat(64)}@postgres:5432/${database.databaseName}`;
  const exportCommon = {
      EXPORT_ARTIFACT_STORE: "azure",
      EXPORT_ARTIFACT_AZURE_CONTAINER_URL:
        "https://nourishingexports.blob.core.windows.net/nourishing-development-exports",
      EXPORT_ARTIFACT_AZURE_PREFIX: "development/exports/",
      EXPORT_ARTIFACT_CURRENT_KEY_ID: "export-key-v1",
      EXPORT_ARTIFACT_ENCRYPTION_KEYS: JSON.stringify({ "export-key-v1": key(1) }),
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator-key-v1",
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({ "locator-key-v1": key(2) }),
    },
    ledger = {
      ERASURE_REPLAY_LEDGER_STORE: "azure",
      ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
        options.ledgerContainerUrl ??
        "https://nourishingledger.blob.core.windows.net/nourishing-development-erasure",
      ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "development/erasure/",
      ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "ledger-key-v1",
      ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({ "ledger-key-v1": key(3) }),
      ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID:
        exportCommon.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
      ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: exportCommon.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS,
    },
    mail = {
      send: { username: "capture-send", password: "synthetic-send-password-0123456789abcdef" },
      review: {
        username: "capture-review",
        password: "synthetic-review-password-0123456789abcdef",
      },
    };
  const api = {
      DATABASE_URL: dbUrl(database.api, "1"),
      ...exportCommon,
      RETENTION_FEATURES_ENABLED: "true",
      REFERENCE_TARGETS_ENABLED: "false",
      EXPORT_ARTIFACT_AZURE_READ_SAS: sas("r"),
      SEARCH_CURSOR_SECRET: "synthetic-runtime-search-cursor-secret-v1",
      DEVICE_CHALLENGE_HMAC_KEY: key(4),
      ERASURE_STATUS_CAPABILITY_HMAC_KEY: key(5),
      EXPORT_ARTIFACT_READ_SPOOL_DIR: "/var/lib/nutrition-tracker/export-read-spool",
      EXPORT_ARTIFACT_READ_SPOOL_PROTECTION: "encrypted_volume",
      MEILI_URL: "https://meili.internal:8443",
      MEILI_SEARCH_KEY: "a".repeat(64),
      EMAIL_DELIVERY_TRANSPORT: "https-capture",
      EMAIL_CAPTURE_URL: "https://mail-capture:8025/api/v1/send",
      EMAIL_CAPTURE_CA: publicCA,
      EMAIL_CAPTURE_USERNAME: mail.send.username,
      EMAIL_CAPTURE_PASSWORD: mail.send.password,
      EMAIL_CAPTURE_FROM: "Nourishing Development <no-reply@example.invalid>",
      EMAIL_CAPTURE_TIMEOUT_MS: "1000",
      EMAIL_VERIFICATION_PUBLIC_ORIGIN: "https://localhost:3443",
      PASSWORD_RECOVERY_PUBLIC_ORIGIN: "https://localhost:3443",
    },
    worker = {
      DATABASE_URL: dbUrl(database.worker, "2"),
      ...exportCommon,
      ...ledger,
      RETENTION_FEATURES_ENABLED: "true",
      EXPORT_ARTIFACT_AZURE_WRITE_SAS: sas("rcd"),
      EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS: sas("l"),
      ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS: sas("rc"),
      MEILI_URL: "https://meili.internal:8443",
      MEILI_ADMIN_KEY: "b".repeat(64),
      MEILI_TASK_OBSERVER_KEY: "c".repeat(64),
      RETENTION_EXPORT_SPOOL_DIR: "/var/lib/nutrition-tracker/export-spool",
      RETENTION_EXPORT_SPOOL_PROTECTION: "encrypted_volume",
      SEARCH_REBUILD_SPOOL_DIR: "/var/lib/nutrition-tracker/search-spool",
    },
    ownerEnvironment = {
      ...common,
      ...dbCommon,
      ...ledger,
      DATABASE_URL: dbUrl(database.owner, "3"),
      NODE_EXTRA_CA_CERTS: join(root, "pki/ca.crt"),
      ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: sas("rl"),
      ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY: "1",
      DATABASE_POOL_MAX: "1",
      ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "azure_blob",
      ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: join(root, "data/erasure-replay-spool"),
      ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_PROTECTION: "encrypted_volume",
    },
    canary = {
      EXPORT_ARTIFACT_STORE: "azure",
      ERASURE_REPLAY_LEDGER_STORE: "azure",
      EXPORT_ARTIFACT_AZURE_CONTAINER_URL: exportCommon.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
      EXPORT_ARTIFACT_AZURE_PREFIX: exportCommon.EXPORT_ARTIFACT_AZURE_PREFIX,
      EXPORT_ARTIFACT_AZURE_READ_SAS: api.EXPORT_ARTIFACT_AZURE_READ_SAS,
      EXPORT_ARTIFACT_AZURE_WRITE_SAS: worker.EXPORT_ARTIFACT_AZURE_WRITE_SAS,
      EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS: worker.EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS,
      ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL: ledger.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
      ERASURE_REPLAY_LEDGER_AZURE_PREFIX: ledger.ERASURE_REPLAY_LEDGER_AZURE_PREFIX,
      ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS: worker.ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS,
      ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS:
        ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS,
    },
    files = {
      runtime: common,
      database: dbCommon,
      api,
      worker,
      migrate: { DATABASE_URL: ownerEnvironment.DATABASE_URL, ...dbCommon },
      canary,
      postgres: {
        POSTGRES_DB: database.databaseName,
        POSTGRES_USER: database.owner,
        POSTGRES_PASSWORD: "3".repeat(64),
      },
      meili: { MEILI_MASTER_KEY: "d".repeat(64) },
      "scoped-meili": {
        MEILI_SEARCH_KEY: api.MEILI_SEARCH_KEY,
        MEILI_ADMIN_KEY: worker.MEILI_ADMIN_KEY,
        MEILI_TASK_OBSERVER_KEY: worker.MEILI_TASK_OBSERVER_KEY,
      },
    };
  for (const [name, env] of Object.entries(files))
    await writeFile(
      join(root, "config", `${name}.env`),
      `${Object.entries(env)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join("\n")}\n`,
    );
  const output = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      source,
      "--env-file",
      devNull,
      "-f",
      join(source, "infra/development/azure/runtime/compose.yaml"),
      ...(options.clientAccess
        ? ["-f", join(source, "infra/development/azure/runtime/compose.client.yaml")]
        : []),
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2_097_152,
      env: {
        ...process.env,
        ...references,
        ...(options.clientAccess
          ? runtimeClientEnvironment(options.clientAccess, options.apiDeadlineNs)
          : {}),
        RUNTIME_ROOT: root,
        RUNTIME_SOURCE: source,
        RUNTIME_PROJECT: f.model.name,
        RUNTIME_OWNER: "11111111-1111-4111-8111-111111111111",
        RUNTIME_REVISION: revision,
        DOCKER_HOST: "unix:///nonexistent-nourishing-contract.sock",
      },
    },
  );
  assert.ifError(output.error);
  assert.equal(output.status, 0, output.stderr);
  const model = JSON.parse(output.stdout);
  const input = {
    model,
    root,
    sourceRevision: revision,
    notAfterUtc: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    database,
    caCertificate: publicCA,
    ownerEnvironment,
    mail,
    databaseBootstrap: renderDevelopmentRuntimeDatabaseBootstrap({
      databaseName: database.databaseName,
      owner: database.owner,
      principals: { api: database.api, worker: database.worker },
      passwords: { api: "1".repeat(64), worker: "2".repeat(64) },
    }),
  };
  return { input, model, ownerEnvironment, base: f };
}

export { database, sas };
