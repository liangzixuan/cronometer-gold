// Controlled PG and Azure HTTP boundaries; actual runtime replay, SQL, SDK and readiness run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { Readable } from "node:stream";

const mode = process.argv[2];
assert(
  [
    "positive",
    "wrong-target",
    "stale-migration",
    "wrong-runtime-epoch",
    "changed-readback",
  ].includes(mode),
);
const pools = [],
  queries = [],
  requests = [];
const target = {
  databaseName: "nourishing_development_12345678",
  databaseOid: "12345",
  expectedOwner: "development_owner",
};
const subject = "11111111-1111-4111-8111-111111111111";
const epoch = "synthetic-development-runtime-restore-epoch-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
let migrations, persisted, coreUrl;
globalThis.runtimeReplayPool = class {
  constructor(options) {
    this.options = options;
    this.principal = new URL(options.connectionString).username;
    this.closed = false;
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(options.max, 1);
    assert.equal(new URL(options.connectionString).hostname, "postgres");
    pools.push(this);
  }
  async connect() {
    const pool = this;
    return {
      async query(sql, values = []) {
        assert(!pool.closed);
        queries.push({ sql, values, principal: pool.principal });
        let rows = [];
        if (sql.startsWith("set role ")) {
          assert.equal(pool.principal, target.expectedOwner);
          assert.equal(sql, `set role "${target.expectedOwner}"`);
        } else if (sql.includes("current_user::pg_catalog.text as role"))
          rows = [{ role: pool.principal }];
        else if (sql.includes("pg_catalog.current_database() database_name"))
          rows = [
            {
              database_name: target.databaseName,
              database_oid: mode === "wrong-target" ? "54321" : target.databaseOid,
            },
          ];
        else if (sql.includes("pg_catalog.pg_settings"))
          rows = [{ setting: "public", source: "default" }];
        else if (sql.includes("app_schema_migration"))
          rows = (mode === "stale-migration" ? migrations.slice(0, -1) : migrations).map(
            ({ name, checksum }) => ({ name, checksum }),
          );
        else if (sql.startsWith('select "id" from "app_user"')) {
          assert.equal(pool.principal, target.expectedOwner);
          assert(sql.endsWith('order by "id" limit $1') && values[0] === 500);
          rows = [{ id: subject }];
        } else if (sql.startsWith('insert into "database_restore_attestation"')) {
          assert.equal(pool.principal, target.expectedOwner);
          assert.equal(values.length, 12);
          persisted = Object.fromEntries(
            [
              "completed_at",
              "database_name",
              "database_oid",
              "reconciliation_digest",
              "replayed_subject_count",
              "restore_epoch_hash",
            ].map((name, index) => [name, values[index]]),
          );
          assert.equal(persisted.database_name, target.databaseName);
          assert.equal(persisted.database_oid, target.databaseOid);
          assert.equal(persisted.restore_epoch_hash, hash(epoch));
          assert.equal(persisted.replayed_subject_count, "0");
          persisted.completed_at = new Date(persisted.completed_at);
          rows = [{ ...persisted }];
        } else if (sql.startsWith('select "restore_epoch_hash", "database_oid", "database_name"')) {
          assert(persisted, "Readiness cannot fabricate an attestation before the actual INSERT");
          rows = [
            {
              ...persisted,
              ...(mode === "wrong-runtime-epoch" && pool.principal === "development_worker"
                ? { restore_epoch_hash: "b".repeat(64) }
                : {}),
            },
          ];
        } else if (sql.includes('from "public"."database_restore_attestation"')) {
          assert.equal(
            sql,
            'select "database_name" as "databaseName", "database_oid" as "databaseOid", "restore_epoch_hash" as "restoreEpochHash", "replayed_subject_count" as "replayedSubjectCount", "reconciliation_digest" as "reconciliationDigest", "completed_at" as "completedAt" from "public"."database_restore_attestation" where "singleton" = $1 limit $2',
          );
          assert.deepEqual(values, [true, 2]);
          assert(persisted);
          rows = [
            {
              completedAt: persisted.completed_at,
              databaseName: persisted.database_name,
              databaseOid: persisted.database_oid,
              reconciliationDigest:
                mode === "changed-readback" ? "b".repeat(64) : persisted.reconciliation_digest,
              replayedSubjectCount: persisted.replayed_subject_count,
              restoreEpochHash: persisted.restore_epoch_hash,
            },
          ];
        } else
          assert(
            ["begin", "commit", "rollback"].includes(sql) || sql.includes("pg_catalog.set_config"),
            `Unexpected controlled SQL: ${sql}`,
          );
        return { rows, rowCount: rows.length, command: sql.split(" ")[0].toUpperCase() };
      },
      release() {},
    };
  }
  async end() {
    this.closed = true;
  }
};
globalThis.runtimeReplayAzure = {
  async sendRequest(request) {
    requests.push(request);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://runtimeledger.blob.core.windows.net");
    assert.equal(request.method, "GET");
    assert.equal(url.pathname, "/ledger");
    assert.equal(url.searchParams.get("comp"), "list");
    assert.equal(url.searchParams.get("sp"), "rl");
    assert(url.searchParams.get("include").includes("versions"));
    assert(url.searchParams.get("prefix").startsWith("development/ledger/erasure-ledger/"));
    assert.equal(request.allowInsecureConnection, false);
    assert.equal(request.requestOverrides.rejectUnauthorized, true);
    const { createHttpHeaders } = await import(coreUrl);
    return {
      request,
      status: 200,
      headers: createHttpHeaders({
        "content-type": "application/xml",
        "x-ms-request-id": "synthetic-runtime-list",
      }),
      readableStreamBody: Readable.from([
        `<EnumerationResults ServiceEndpoint="${url.origin}/" ContainerName="ledger"><Prefix>${url.searchParams.get("prefix")}</Prefix><MaxResults>${url.searchParams.get("maxresults")}</MaxResults><Blobs/><NextMarker/></EnumerationResults>`,
      ]),
    };
  },
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "pg" && context.parentURL.endsWith("/packages/db/dist/client.js"))
      return {
        url: "data:text/javascript,export const Pool = globalThis.runtimeReplayPool;",
        shortCircuit: true,
      };
    const real = next(specifier, context);
    if (specifier === "@azure/core-rest-pipeline") {
      coreUrl = real.url;
      return {
        url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real.url)}; export const createDefaultHttpClient = () => globalThis.runtimeReplayAzure;`)}`,
        shortCircuit: true,
      };
    }
    return real;
  },
});
try {
  const { discoverMigrations } = await import("../packages/db/dist/migrator.js");
  migrations = await discoverMigrations();
  const { attestDevelopmentRuntimeSource } = await import(
    "./azure-development-runtime-maintenance.mts"
  );
  const ca = await readFile(process.env.NODE_EXTRA_CA_CERTS, "utf8");
  const now = Date.now(),
    st = new Date(now - 60_000).toISOString(),
    se = new Date(now + 3_600_000).toISOString();
  const ownerEnvironment = {
    NODE_ENV: "development",
    NOURISHING_API_PROFILE: "hosted-development",
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    DATABASE_URL: `postgresql://${target.expectedOwner}:synthetic-password@postgres:5432/${target.databaseName}`,
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_POOL_MAX: "1",
    DATABASE_RESTORE_EPOCH: epoch,
    ERASURE_REPLAY_LEDGER_STORE: "azure",
    ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "azure_blob",
    ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL: "https://runtimeledger.blob.core.windows.net/ledger",
    ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "development/ledger/",
    ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: new URLSearchParams({
      sv: "2026-04-06",
      spr: "https",
      st,
      se,
      sr: "c",
      sp: "rl",
      sig: "synthetic-runtime-restore",
      skoid: "synthetic-restore",
      sktid: "synthetic-tenant",
      skt: st,
      ske: se,
      sks: "b",
      skv: "2026-04-06",
    }).toString(),
    ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: process.env.RUNTIME_REPLAY_SPOOL,
    ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY: "1",
    ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "synthetic-k1",
    ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
      "synthetic-k1": Buffer.alloc(32, 1).toString("base64"),
    }),
    ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "synthetic-l1",
    ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
      "synthetic-l1": Buffer.alloc(32, 2).toString("base64"),
    }),
  };
  const runtimeEnvironments = ["development_api", "development_worker"].map((principal) => ({
    NODE_ENV: ownerEnvironment.NODE_ENV,
    NOURISHING_API_PROFILE: ownerEnvironment.NOURISHING_API_PROFILE,
    NODE_EXTRA_CA_CERTS: ownerEnvironment.NODE_EXTRA_CA_CERTS,
    DATABASE_URL: `postgresql://${principal}:synthetic-password@postgres:5432/${target.databaseName}`,
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_POOL_MAX: "1",
    DATABASE_RESTORE_EPOCH: epoch,
  }));
  let result, failure;
  try {
    result = await attestDevelopmentRuntimeSource({
      expectedTarget: target,
      caCertificate: ca,
      ownerEnvironment,
      runtimeEnvironments,
      notAfterUtc: new Date(Date.now() + 60_000).toISOString(),
      signal: new AbortController().signal,
    });
  } catch (error) {
    failure = error;
  }
  if (mode === "positive") {
    assert.ifError(failure);
    assert.equal(result.kind, "nutrition-development-source-ready-v1");
    assert.deepEqual(result.target, target);
    assert.equal(result.attestation.restoreEpochHash, hash(epoch));
    assert.equal(result.attestation.replayedSubjectCount, "0");
    assert.deepEqual(
      pools.map((pool) => pool.principal),
      [target.expectedOwner, "development_api", "development_worker"],
    );
    assert(
      requests.length > 0,
      "A subject's absent tombstone must be observed through the real Azure SDK",
    );
    assert(
      queries.some((query) => query.sql.includes('from "public"."database_restore_attestation"')),
    );
  } else {
    assert(failure, "A failed raw observation must prevent source readiness");
    const messages = {
      "wrong-target": "Database target identity does not match",
      "stale-migration": "Database schema migration ledger is not current",
      "wrong-runtime-epoch": "Database restore replay attestation is not current",
      "changed-readback": "Restore attestation changed after readiness",
    };
    assert.equal(failure.message, messages[mode]);
    if (["wrong-target", "stale-migration"].includes(mode)) assert.equal(persisted, undefined);
    if (mode !== "wrong-runtime-epoch") assert.equal(pools.length, 1);
  }
  assert(
    pools.length > 0 && pools.every((pool) => pool.closed),
    "Every real Kysely pool must close before return",
  );
  console.log(
    JSON.stringify({
      mode,
      ready: !failure,
      pools: pools.length,
      azureRequests: requests.length,
      queries: queries.length,
    }),
  );
} finally {
  hooks.deregister();
  delete globalThis.runtimeReplayPool;
  delete globalThis.runtimeReplayAzure;
}
