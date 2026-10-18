import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { admitDevelopmentRuntimeConfiguration } from "./azure-development-runtime-configuration.mjs";
import { database, fixture, sas } from "./azure-development-runtime-configuration-fixture.mjs";

const key = (value) => Buffer.alloc(32, value).toString("base64");

test("genuine Compose resolution passes actual API/worker/canary parsers and exact finite SQL bootstrap", async (t) => {
  const f = await fixture(t),
    result = admitDevelopmentRuntimeConfiguration(f.input);
  assert.equal(result.kind, "nutrition-development-runtime-configuration-v1");
  assert.equal(result.operationalAcceptance, false);
  assert.equal(result.database.databaseName, database.databaseName);
  assert.equal(result.keys.search, "a".repeat(64));
  assert.equal(result.ownerEnvironment.NODE_EXTRA_CA_CERTS, join(f.input.root, "pki/ca.crt"));
  assert(
    result.runtimeEnvironments.every(
      (env) => env.NODE_EXTRA_CA_CERTS === result.ownerEnvironment.NODE_EXTRA_CA_CERTS,
    ),
  );
});
test("real parser or exact cross-role binding refuses invalid API transport, worker policy or canary grants", async (t) => {
  const changes = [
    (f) => {
      f.model.services.api.environment.EMAIL_CAPTURE_TIMEOUT_MS = "10001";
    },
    (f) => {
      f.model.services.worker.environment.EXPORT_ARTIFACT_AZURE_WRITE_SAS = "invalid";
      f.model.services["azure-canary"].environment.EXPORT_ARTIFACT_AZURE_WRITE_SAS = "invalid";
    },
    (f) => {
      f.model.services["azure-canary"].environment.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS =
        sas("r");
    },
    (f) => {
      f.model.services.api.environment.DATABASE_SSL_MODE = "require";
    },
    (f) => {
      f.model.services.worker.environment.DATABASE_URL += "?sslmode=disable";
    },
  ];
  for (const change of changes) {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    change(f);
    assert.throws(() => admitDevelopmentRuntimeConfiguration(f.input));
  }
});
test("maintenance owner, principal passwords, original epoch and exact rendered bootstrap cannot drift", async (t) => {
  for (const change of [
    (f) => {
      f.model.services.api.environment.DATABASE_URL =
        f.model.services.worker.environment.DATABASE_URL;
    },
    (f) => {
      f.ownerEnvironment.DATABASE_URL = f.ownerEnvironment.DATABASE_URL.replace(
        "development_owner",
        "development_other",
      );
    },
    (f) => {
      f.model.services.postgres.environment.POSTGRES_PASSWORD = "4".repeat(64);
    },
    (f) => {
      f.model.services.worker.environment.DATABASE_RESTORE_EPOCH += "different";
    },
    (f) => {
      f.input.databaseBootstrap += "GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;\n";
    },
  ]) {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    change(f);
    assert.throws(() => admitDevelopmentRuntimeConfiguration(f.input));
  }
});
test("same actual protected mail identity, issuer keys and split SAS must reach the intended consumers", async (t) => {
  for (const change of [
    (f) => {
      f.model.services.api.environment.EMAIL_CAPTURE_PASSWORD =
        "unmatched-password-0123456789abcdef";
    },
    (f) => {
      f.input.mail.review.password = f.input.mail.send.password;
    },
    (f) => {
      f.model.services["search-bootstrap"].environment.MEILI_ADMIN_KEY = "e".repeat(64);
    },
    (f) => {
      f.model.services["azure-canary"].environment.EXPORT_ARTIFACT_AZURE_READ_SAS = sas("rl");
    },
    (f) => {
      f.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_PREFIX = "development/unrelated/";
    },
    (f) => {
      f.model.services.worker.environment.EXPORT_ARTIFACT_ENCRYPTION_KEYS = JSON.stringify({
        other: key(6),
      });
    },
  ]) {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    change(f);
    assert.throws(() => admitDevelopmentRuntimeConfiguration(f.input));
  }
});
test("raw resolved environments cannot inject loaders/proxies or leak maintenance and master credentials", async (t) => {
  for (const [service, key, value] of [
    ["api", "NODE_OPTIONS", "--import=/tmp/hook.mjs"],
    ["worker", "HTTPS_PROXY", "https://proxy.invalid"],
    ["migrate", "ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS", sas("rl")],
    ["api", "MEILI_MASTER_KEY", "d".repeat(64)],
    ["worker", "ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS", sas("rl")],
    ["postgres", "POSTGRES_HOST_AUTH_METHOD", "trust"],
  ]) {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    f.model.services[service].environment[key] = value;
    assert.throws(() => admitDevelopmentRuntimeConfiguration(f.input));
  }
});

test("configuration failures expose no protected values from parser or cross-role comparisons", async (t) => {
  const f = await fixture(t);
  admitDevelopmentRuntimeConfiguration(f.input);
  f.model.services["search-bootstrap"].environment.MEILI_ADMIN_KEY = "e".repeat(64);
  assert.throws(
    () => admitDevelopmentRuntimeConfiguration(f.input),
    (error) =>
      error.message === "Development runtime configuration admission failed" &&
      !Object.hasOwn(error, "cause") &&
      !Object.hasOwn(error, "actual"),
  );
});

for (const field of [
  "ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER",
  "ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR",
])
  test(`owner replay admission refuses omitted ${field}`, async (t) => {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    delete f.ownerEnvironment[field];
    assert.throws(
      () => admitDevelopmentRuntimeConfiguration(f.input),
      /Development runtime configuration admission failed/u,
    );
  });

test("owner replay rejects a foreign spool, foreign provider or nonserial target session", async (t) => {
  for (const [field, value] of [
    ["ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER", "unqualified"],
    ["ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR", "/tmp/unrelated-spool"],
    ["ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY", "2"],
    ["DATABASE_POOL_MAX", "2"],
    ["ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_PROTECTION", "unverified"],
  ]) {
    const f = await fixture(t);
    admitDevelopmentRuntimeConfiguration(f.input);
    f.ownerEnvironment[field] = value;
    assert.throws(
      () => admitDevelopmentRuntimeConfiguration(f.input),
      /Development runtime configuration admission failed/u,
    );
  }
});

test("source replay receives no mixed writer or alternative provider credentials", async (t) => {
  const f = await fixture(t);
  admitDevelopmentRuntimeConfiguration(f.input);
  f.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS =
    f.model.services.worker.environment.ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS;
  assert.throws(
    () => admitDevelopmentRuntimeConfiguration(f.input),
    /Development runtime configuration admission failed/u,
  );
});
