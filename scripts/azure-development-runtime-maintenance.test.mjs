import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seedDevelopmentRuntimeCatalogue } from "./azure-development-runtime-maintenance.mts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = require("kysely");
const target = {
  databaseName: "nourishing_development_12345678",
  databaseOid: "12345",
  expectedOwner: "development_owner",
};
async function fixture(t, mutation = {}) {
  const queries = [],
    calls = [];
  const spoolDirectory = await mkdtemp(join(tmpdir(), "nutrition-maintenance-spool-"));
  t.after(() => rm(spoolDirectory, { recursive: true, force: true }));
  const connection = {
    async executeQuery(query) {
      queries.push(query);
      return {
        rows: [
          {
            databaseName: target.databaseName,
            databaseOid: target.databaseOid,
            owner: target.expectedOwner,
            principal: target.expectedOwner,
            schema: "public",
            tls: true,
            tlsVersion: "TLSv1.3",
            ...mutation,
          },
        ],
      };
    },
    streamQuery() {
      throw new Error("No stream admitted");
    },
  };
  const database = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        async init() {},
        async acquireConnection() {
          return connection;
        },
        async releaseConnection() {},
        async destroy() {},
        async beginTransaction() {
          throw new Error("No transaction is admitted after wrong identity");
        },
        async commitTransaction() {},
        async rollbackTransaction() {},
      }),
    },
  });
  t.after(() => database.destroy());
  return {
    queries,
    calls,
    input: {
      database,
      expectedTarget: target,
      searchKeys: { worker: "a".repeat(64), observer: "b".repeat(64), search: "c".repeat(64) },
      http: {
        async meiliFetch() {
          calls.push("http");
          throw new Error("No search request admitted after wrong identity");
        },
      },
      spoolDirectory,
      notAfterUtc: new Date(Date.now() + 60_000).toISOString(),
      signal: new AbortController().signal,
      async onMutationStart() {
        calls.push("mutation");
      },
    },
  };
}
for (const [label, mutation] of Object.entries({
  databaseName: { databaseName: "unowned_database" },
  databaseOid: { databaseOid: "54321" },
  owner: { owner: "unowned_owner" },
  principal: { principal: "unowned_principal" },
  schema: { schema: "unowned_schema" },
  unencrypted: { tls: false },
  obsoleteTls: { tlsVersion: "TLSv1" },
}))
  test(`rejects observed ${label} before search, publication or rebuild`, async (t) => {
    const f = await fixture(t, mutation);
    await assert.rejects(seedDevelopmentRuntimeCatalogue(f.input));
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0].sql, /pg_stat_ssl/u);
    assert.deepEqual(f.calls, []);
  });

test("expired lease and pre-cancellation refuse even the first database dispatch", async (t) => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t);
    if (cancelled) {
      const controller = new AbortController();
      controller.abort();
      f.input.signal = controller.signal;
    } else f.input.notAfterUtc = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(seedDevelopmentRuntimeCatalogue(f.input));
    assert.equal(f.queries.length, 0);
    assert.deepEqual(f.calls, []);
  }
});

test("non-distinct or master-shaped search input cannot reach an owned database", async (t) => {
  const f = await fixture(t);
  f.input.searchKeys.observer = f.input.searchKeys.worker;
  await assert.rejects(seedDevelopmentRuntimeCatalogue(f.input));
  assert.equal(f.queries.length, 0);
  assert.deepEqual(f.calls, []);
});
