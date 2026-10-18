/** Current parser admission for the fixed private development stack. No network or mutation. */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { loadApiDependencyConfig, loadConfig } from "../apps/api/dist/config.js";
import { parseAzureObjectStorageCanaryConfiguration } from "../apps/worker/dist/azure-object-storage-credential-canary.js";
import { parseWorkerConfig } from "../apps/worker/dist/config.js";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { renderDevelopmentRuntimeDatabaseBootstrap } from "./azure-development-runtime-database.mts";

const exact = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b));
const credential = (value) => typeof value === "string" && /^[a-f0-9]{64,128}$/u.test(value);
function environment(value) {
  assert(value && Object.getPrototypeOf(value) === Object.prototype);
  assert(Object.keys(value).length <= 128);
  for (const [key, field] of Object.entries(value)) {
    assert(
      /^[A-Z][A-Z0-9_]{0,127}$/u.test(key) &&
        typeof field === "string" &&
        Buffer.byteLength(field) <= 65_536 &&
        !field.includes("\0"),
    );
    assert(!/^(?:LD_|DYLD_|DOCKER_|AZURE_|AWS_|OCI_|DOPPLER_|PG)/u.test(key));
    assert(
      !/^(?:PATH|HOME|ENV|BASH_ENV|SHELLOPTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/u.test(
        key,
      ),
    );
    assert(!key.startsWith("NODE_") || ["NODE_ENV", "NODE_EXTRA_CA_CERTS"].includes(key));
  }
  return Object.freeze({ ...value });
}
function noFields(value, pattern) {
  assert(!Object.keys(value).some((key) => pattern.test(key)));
}
function database(environment, name, principal) {
  assert(environment.DATABASE_SSL_MODE === "verify-full");
  const url = new URL(environment.DATABASE_URL);
  assert(
    url.protocol === "postgresql:" &&
      url.hostname === "postgres" &&
      url.port === "5432" &&
      url.pathname === `/${name}` &&
      !url.search &&
      !url.hash &&
      decodeURIComponent(url.username) === principal,
  );
  const password = decodeURIComponent(url.password);
  assert(credential(password));
  return Object.freeze({ url: url.href, password });
}
function discardParsedKeys(value, visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  if (value instanceof Uint8Array) value.fill(0);
  else if (value instanceof Map)
    for (const field of value.values()) discardParsedKeys(field, visited);
  else for (const field of Object.values(value)) discardParsedKeys(field, visited);
}

/** Use the actual Compose model and already held private owner/bootstrap inputs. */
function admitConfiguration(input) {
  const model = structuredClone(input.model),
    target = Object.freeze({ ...input.database }),
    owner = environment(input.ownerEnvironment),
    ca = input.caCertificate;
  assert(Object.keys(target).sort().join(",") === "api,databaseName,owner,worker");
  assert(/^nourishing_development_[a-z0-9]{8,24}$/u.test(target.databaseName));
  for (const name of [target.owner, target.api, target.worker])
    assert(/^[a-z][a-z0-9_]{0,62}$/u.test(name));
  assert(new Set([target.owner, target.api, target.worker]).size === 3);
  assert(/^[a-f0-9]{40}$/u.test(input.sourceRevision));
  assert(typeof ca === "string" && Buffer.byteLength(ca) <= 65_536);
  const certificate = new X509Certificate(ca),
    now = Date.now();
  assert(
    certificate.ca &&
      Date.parse(certificate.validFrom) <= now &&
      Date.parse(certificate.validTo) > Date.parse(input.notAfterUtc),
  );
  const services = {};
  for (const name of [
    "api",
    "worker",
    "migrate",
    "azure-canary",
    "postgres",
    "meilisearch",
    "search-bootstrap",
  ])
    services[name] = environment(model.services[name].environment);
  const api = services.api,
    worker = services.worker,
    migrate = services.migrate,
    canary = services["azure-canary"],
    postgres = services.postgres,
    meili = services.meilisearch,
    scoped = services["search-bootstrap"];
  for (const env of [api, worker, migrate, canary, owner]) {
    assert(
      env.NODE_ENV === "development" &&
        env.NOURISHING_API_PROFILE === "hosted-development" &&
        env.SERVICE_VERSION === input.sourceRevision,
    );
  }
  for (const env of [api, worker, migrate, canary])
    assert(env.NODE_EXTRA_CA_CERTS === "/run/internal-ca/ca.crt");
  assert(owner.NODE_EXTRA_CA_CERTS === join(input.root, "pki/ca.crt"));
  assert(owner.ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER === "azure_blob");
  assert(
    owner.ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR === join(input.root, "data/erasure-replay-spool"),
  );
  assert(owner.ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_PROTECTION === "encrypted_volume");
  assert(
    owner.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY === "1" && owner.DATABASE_POOL_MAX === "1",
  );
  noFields(
    owner,
    /^(?:ERASURE_REPLAY_LEDGER_(?:ENDPOINT|BUCKET|REGION)|ERASURE_REPLAY_LEDGER_(?:RESTORE|WRITE)_(?:OCI_|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|ERASURE_REPLAY_LEDGER_AZURE_(?:WRITE|READ)_SAS)/u,
  );

  const epoch = api.DATABASE_RESTORE_EPOCH;
  assert(
    typeof epoch === "string" &&
      epoch.length >= 32 &&
      epoch.length <= 500 &&
      epoch.trim() === epoch,
  );
  for (const env of [worker, migrate, owner]) assert(env.DATABASE_RESTORE_EPOCH === epoch);
  assert(api.RETENTION_FEATURES_ENABLED === "true" && worker.RETENTION_FEATURES_ENABLED === "true");
  assert(api.REFERENCE_TARGETS_ENABLED === "false");
  const apiDb = database(api, target.databaseName, target.api),
    workerDb = database(worker, target.databaseName, target.worker),
    ownerDb = database(owner, target.databaseName, target.owner),
    migrationDb = database(migrate, target.databaseName, target.owner);
  assert(
    ownerDb.url === migrationDb.url &&
      new Set([ownerDb.password, apiDb.password, workerDb.password]).size === 3,
  );
  exact(Object.keys(postgres).sort(), ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
  assert(
    postgres.POSTGRES_DB === target.databaseName &&
      postgres.POSTGRES_USER === target.owner &&
      postgres.POSTGRES_PASSWORD === ownerDb.password,
  );
  const bootstrap = renderDevelopmentRuntimeDatabaseBootstrap({
    databaseName: target.databaseName,
    owner: target.owner,
    principals: { api: target.api, worker: target.worker },
    passwords: { api: apiDb.password, worker: workerDb.password },
  });
  assert(typeof input.databaseBootstrap === "string" && input.databaseBootstrap === bootstrap);
  noFields(
    api,
    /^(?:MEILI_(?:ADMIN_KEY|MASTER_KEY|TASK_OBSERVER_KEY)|ERASURE_REPLAY_LEDGER_AZURE_.*SAS)$/u,
  );
  noFields(
    worker,
    /^(?:MEILI_(?:SEARCH_KEY|MASTER_KEY)|EMAIL_CAPTURE_|SMTP_|ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS)/u,
  );
  noFields(migrate, /(?:_SAS$|ENCRYPTION_KEYS$|HMAC_KEYS$|^MEILI_|^EMAIL_CAPTURE_|^SMTP_)/u);
  noFields(canary, /^(?:DATABASE_|MEILI_|EMAIL_CAPTURE_|SMTP_)|(?:ENCRYPTION_KEYS|HMAC_KEYS)$/u);
  assert(api.MEILI_URL === "https://meili.internal:8443" && worker.MEILI_URL === api.MEILI_URL);
  const keys = {
    search: api.MEILI_SEARCH_KEY,
    worker: worker.MEILI_ADMIN_KEY,
    observer: worker.MEILI_TASK_OBSERVER_KEY,
  };
  assert(
    Object.values(keys).every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    ) && new Set(Object.values(keys)).size === 3,
  );
  assert(
    credential(meili.MEILI_MASTER_KEY) && !Object.values(keys).includes(meili.MEILI_MASTER_KEY),
  );
  exact(Object.keys(meili).sort(), ["MEILI_ENV", "MEILI_MASTER_KEY", "MEILI_NO_ANALYTICS"]);
  assert(meili.MEILI_ENV === "production" && meili.MEILI_NO_ANALYTICS === "true");
  exact(scoped, {
    MEILI_MASTER_KEY: meili.MEILI_MASTER_KEY,
    MEILI_SEARCH_KEY: keys.search,
    MEILI_ADMIN_KEY: keys.worker,
    MEILI_TASK_OBSERVER_KEY: keys.observer,
    MEILI_URL: "http://127.0.0.1:7700",
    MEILI_PORT: "7700",
  });
  assert(
    api.EMAIL_DELIVERY_TRANSPORT === "https-capture" &&
      api.EMAIL_CAPTURE_URL === "https://mail-capture:8025/api/v1/send" &&
      api.EMAIL_CAPTURE_CA === ca,
  );
  assert(
    api.EMAIL_VERIFICATION_PUBLIC_ORIGIN === "https://localhost:3443" &&
      api.PASSWORD_RECOVERY_PUBLIC_ORIGIN === "https://localhost:3443",
  );
  const mail = input.mail;
  assert(mail && Object.keys(mail).sort().join(",") === "review,send");
  for (const item of [mail.review, mail.send])
    assert(
      item &&
        Object.keys(item).sort().join(",") === "password,username" &&
        /^[A-Za-z0-9._-]{1,128}$/u.test(item.username) &&
        /^[A-Za-z0-9_-]{32,256}$/u.test(item.password),
    );
  assert(
    mail.review.username !== mail.send.username && mail.review.password !== mail.send.password,
  );
  assert(
    api.EMAIL_CAPTURE_USERNAME === mail.send.username &&
      api.EMAIL_CAPTURE_PASSWORD === mail.send.password,
  );
  for (const env of [api, worker, canary]) assert(env.EXPORT_ARTIFACT_STORE === "azure");
  for (const env of [worker, canary, owner]) assert(env.ERASURE_REPLAY_LEDGER_STORE === "azure");
  for (const key of ["EXPORT_ARTIFACT_AZURE_CONTAINER_URL", "EXPORT_ARTIFACT_AZURE_PREFIX"])
    for (const env of [worker, canary]) assert(env[key] === api[key]);
  for (const key of [
    "ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL",
    "ERASURE_REPLAY_LEDGER_AZURE_PREFIX",
  ])
    for (const env of [canary, owner]) assert(env[key] === worker[key]);
  for (const [source, key] of [
    [api, "EXPORT_ARTIFACT_AZURE_READ_SAS"],
    [worker, "EXPORT_ARTIFACT_AZURE_WRITE_SAS"],
    [worker, "EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS"],
    [worker, "ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS"],
    [owner, "ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS"],
  ])
    assert(canary[key] === source[key]);
  for (const key of [
    "EXPORT_ARTIFACT_CURRENT_KEY_ID",
    "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
    "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
    "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
  ])
    assert(api[key] === worker[key]);
  for (const key of [
    "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID",
    "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS",
    "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
    "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
  ])
    assert(owner[key] === worker[key]);
  let appConfig, apiConfig, workerConfig;
  try {
    appConfig = loadConfig(api);
    apiConfig = loadApiDependencyConfig(api);
    workerConfig = parseWorkerConfig(worker);
    const probe = parseAzureObjectStorageCanaryConfiguration(canary);
    assert(
      apiConfig.retention?.artifactStore === "azure" &&
        workerConfig.EXPORT_ARTIFACT_STORE === "azure" &&
        apiConfig.databaseRestoreEpoch === epoch &&
        apiConfig.emailVerification?.transport === "https-capture",
    );
    assert(apiConfig.databaseUrl === apiDb.url && workerConfig.DATABASE_URL === workerDb.url);
    assert(
      appConfig.apiHost === "0.0.0.0" &&
        appConfig.apiPort === 4000 &&
        appConfig.shutdownGraceMs <= 300_000 &&
        workerConfig.SHUTDOWN_GRACE_MS <= 600_000,
    );
    assert(
      Date.parse(new URLSearchParams(probe.ledger.restoreSas).get("se")) >
        Date.parse(input.notAfterUtc),
    );
    for (const [env, name] of [
      [api, "EXPORT_ARTIFACT_AZURE_READ_SAS"],
      [worker, "EXPORT_ARTIFACT_AZURE_WRITE_SAS"],
      [worker, "EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS"],
      [worker, "ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS"],
    ])
      assert(Date.parse(new URLSearchParams(env[name]).get("se")) > Date.parse(input.notAfterUtc));
    return Object.freeze({
      kind: "nutrition-development-runtime-configuration-v1",
      database: target,
      epoch,
      keys: Object.freeze(keys),
      ownerEnvironment: owner,
      runtimeEnvironments: Object.freeze([
        Object.freeze({ ...api, NODE_EXTRA_CA_CERTS: owner.NODE_EXTRA_CA_CERTS }),
        Object.freeze({ ...worker, NODE_EXTRA_CA_CERTS: owner.NODE_EXTRA_CA_CERTS }),
      ]),
      operationalAcceptance: false,
    });
  } finally {
    discardParsedKeys(apiConfig);
    discardParsedKeys(workerConfig);
  }
}

export function admitDevelopmentRuntimeConfiguration(input) {
  try {
    return admitConfiguration(input);
  } catch {
    throw new Error("Development runtime configuration admission failed");
  }
}
