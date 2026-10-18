import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverMigrations } from "../packages/db/dist/migrator.js";
import { CORE_NUTRIENTS } from "../packages/domain/dist/index.js";
import { seedDevelopmentRuntimeCatalogue } from "./azure-development-runtime-maintenance.mts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = require("kysely");
const target = {
  databaseName: "nourishing_development_12345678",
  databaseOid: "12345",
  expectedOwner: "development_owner",
};

/** Real Kysely/compiler, readiness, publication, projection, spool, HTTP client and rebuild.
 * Only database driver rows and Meili HTTP replies are controlled; no server is started. */
async function fixture(t, options = {}) {
  const queries = [],
    requests = [],
    transactions = [],
    rowsByTable = new Map(),
    indexes = new Map(),
    tasks = new Set();
  let nextId = 100,
    nextTask = 0,
    claimed = false,
    published = false;
  const migrations = await discoverMigrations();
  const spoolDirectory = await mkdtemp(join(tmpdir(), "nutrition-maintenance-positive-"));
  t.after(() => rm(spoolDirectory, { recursive: true, force: true }));
  const row = (table) => {
    assert(rowsByTable.has(table), `Missing fixture table ${table}`);
    return rowsByTable.get(table)[0];
  };
  const catalogue = () => {
    const food = row("food"),
      version = row("food_version"),
      source = row("food_source"),
      release = row("food_source_release");
    return {
      food_id: food.id,
      food_version_id: version.id,
      version_number: version.version_number,
      kind: food.kind,
      source_food_key: food.source_food_key,
      name: version.name,
      normalized_name: version.normalized_name,
      brand_name: version.brand_name,
      description: version.description,
      language_tag: version.language_tag,
      market_code: version.market_code,
      data_quality: version.data_quality,
      basis_quantity: version.basis_quantity,
      basis_unit: version.basis_unit,
      source_modified_at: null,
      food_source_id: source.id,
      source_code: source.code,
      source_display_name: source.display_name,
      license_expression: source.license_expression,
      attribution_required: source.attribution_required,
      attribution_text: source.attribution_text,
      source_release_id: release.id,
      source_release_key: release.release_key,
      source_artifact_sha256: release.artifact_sha256,
    };
  };
  const connection = {
    async executeQuery(query) {
      queries.push(query);
      const sql = query.sql;
      if (sql.includes("pg_stat_ssl"))
        return {
          rows: [
            {
              ...target,
              owner: target.expectedOwner,
              principal: target.expectedOwner,
              schema: "public",
              tls: true,
              tlsVersion: "TLSv1.3",
            },
          ],
        };
      if (sql.includes("pg_catalog.pg_settings"))
        return { rows: [{ setting: "public", source: "default" }] };
      if (sql.includes("app_schema_migration"))
        return { rows: migrations.map(({ name, checksum }) => ({ name, checksum })) };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
      if (sql.includes("with releases as"))
        return { rows: [{ document_count: "1", generation: "f".repeat(64), revision: "1" }] };
      if (sql.startsWith('select "current_revision"'))
        return { rows: [{ current_revision: options.revisionDrift ? "2" : "1" }] };
      if (sql.startsWith('update "food_search_projection_revision"')) {
        published = true;
        return { rows: [], numAffectedRows: 1n };
      }
      if (sql.startsWith('select * from "promoted_food_search_catalogue_v1"')) {
        const food = row("food"),
          version = row("food_version"),
          source = row("food_source"),
          release = row("food_source_release");
        const eligible =
          food.current_version_id === version.id &&
          source.active_release_id === release.id &&
          release.status === "promoted" &&
          version.food_id === food.id &&
          version.source_release_id === release.id;
        return { rows: eligible ? [catalogue()] : [] };
      }
      if (sql.includes("join food_barcode")) return { rows: [] };
      if (sql.includes("join food_serving"))
        return {
          rows: rowsByTable.get("food_serving").map((value, index) => ({
            ...value,
            food_id: row("food").id,
            ordinal: String(index + 1),
          })),
        };
      if (sql.startsWith("insert into")) {
        assert(claimed, "Publication cannot precede the durable mutation claim");
        const operation = query.query;
        assert.equal(operation.kind, "InsertQueryNode");
        const table = operation.into.table.identifier.name;
        if (table === "nutrient") {
          const values = CORE_NUTRIENTS.map((item, index) => ({
            id: String(index + 1),
            code: item.id,
            name: item.name,
            canonical_unit: item.canonicalUnit,
          }));
          rowsByTable.set(table, values);
          return { rows: values };
        }
        const columns = operation.columns.map((item) => item.column.name);
        const inserted = operation.values.values.map((values) => {
          const literals =
            values.kind === "PrimitiveValueListNode"
              ? values.values
              : values.values.map((value) => {
                  assert.equal(value.kind, "ValueNode");
                  return value.value;
                });
          const record = Object.fromEntries(columns.map((name, index) => [name, literals[index]]));
          return { ...record, id: record.id ?? String(nextId++) };
        });
        rowsByTable.set(table, inserted);
        return {
          rows: sql.includes("returning") ? inserted : [],
          numAffectedRows: BigInt(inserted.length),
        };
      }
      if (
        /^update "(?:food|food_import_record|food_import_batch|food_source_release|food_source)" set /u.test(
          sql,
        )
      ) {
        const operation = query.query;
        assert.equal(operation.kind, "UpdateQueryNode");
        const table = operation.table.table.identifier.name,
          stored = row(table);
        assert.equal(query.parameters.at(-1), stored.id);
        for (const assignment of operation.updates) {
          const name = assignment.column.column.name;
          if (options.omitTransition === `${table}.${name}`) continue;
          if (assignment.value.kind === "ValueNode") stored[name] = assignment.value.value;
          else assert(!["current_version_id", "active_release_id", "status"].includes(name));
        }
        return { rows: [], numAffectedRows: 1n };
      }
      assert(
        /^select "id" from "(?:app_user|food_source|food|nutrient)" limit \$1$/u.test(sql) ||
          /^update "(?:food|food_import_record|food_import_batch|food_source_release|food_source)" set /u.test(
            sql,
          ) ||
          sql.includes("pg_catalog.set_config") ||
          sql.includes("pg_advisory_xact_lock"),
        `Unexpected controlled SQL: ${sql}`,
      );
      return { rows: [], numAffectedRows: 1n };
    },
    streamQuery() {
      throw new Error("Unexpected database stream");
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
          transactions.push("begin");
        },
        async commitTransaction() {
          transactions.push("commit");
        },
        async rollbackTransaction() {
          transactions.push("rollback");
        },
      }),
    },
  });
  t.after(() => database.destroy());
  async function meiliFetch(input, init = {}) {
    const url = new URL(input);
    assert.equal(url.origin, "https://meili.internal:8443");
    init.signal?.throwIfAborted();
    const path = url.pathname,
      method = init.method ?? "GET",
      header = new Headers(init.headers).get("authorization");
    assert.equal(header, `Bearer ${(path.startsWith("/tasks/") ? "b" : "a").repeat(64)}`);
    requests.push([method, path]);
    const body = init.body === undefined ? null : JSON.parse(init.body);
    if (path.startsWith("/tasks/")) {
      const uid = Number(path.split("/").at(-1));
      assert(tasks.has(uid));
      return Response.json({ uid, status: "succeeded" });
    }
    if (path === "/indexes" && method === "POST") {
      assert(!indexes.has(body.uid));
      indexes.set(body.uid, []);
    } else if (path === "/swap-indexes") {
      const [left, right] = body[0].indexes;
      assert(indexes.has(left) && indexes.has(right));
      const previous = indexes.get(left);
      indexes.set(left, indexes.get(right));
      indexes.set(right, previous);
    } else {
      const uid = path.split("/")[2];
      if (method === "GET" && path.endsWith("/stats"))
        return Response.json({
          numberOfDocuments: options.wrongCount ? 99 : indexes.get(uid).length,
        });
      if (method === "GET")
        return indexes.has(uid)
          ? Response.json({ uid })
          : Response.json(
              { code: options.wrongAbsence ? "route_not_found" : "index_not_found" },
              { status: 404 },
            );
      assert(indexes.has(uid));
      if (method === "POST" && path.endsWith("/documents")) {
        assert.equal(url.search, "?primaryKey=id");
        indexes.get(uid).push(...body);
      } else if (method === "DELETE") indexes.delete(uid);
      else {
        assert.equal(method, "PATCH");
        assert(path.endsWith("/settings"));
      }
    }
    const taskUid = ++nextTask;
    tasks.add(taskUid);
    return Response.json({ taskUid }, { status: 202 });
  }
  return {
    queries,
    requests,
    indexes,
    rowsByTable,
    transactions,
    spoolDirectory,
    claimed: () => claimed,
    published: () => published,
    input: {
      database,
      expectedTarget: target,
      searchKeys: { worker: "a".repeat(64), observer: "b".repeat(64), search: "c".repeat(64) },
      http: { meiliFetch },
      spoolDirectory,
      notAfterUtc: new Date(Date.now() + 60_000).toISOString(),
      signal: new AbortController().signal,
      async onMutationStart() {
        assert(!claimed);
        claimed = true;
      },
    },
  };
}

test("actual maintenance publishes the full fixture, reads authority, spools/rebuilds/swaps and acknowledges exact revision", async (t) => {
  const f = await fixture(t);
  const receipt = await seedDevelopmentRuntimeCatalogue(f.input);
  assert(f.claimed() && f.published());
  assert.equal(receipt.coreNutrients.length, 15);
  assert.equal(receipt.foodId, f.rowsByTable.get("food")[0].id);
  assert.equal(receipt.foodVersionId, f.rowsByTable.get("food_version")[0].id);
  assert.equal(receipt.servings.length, 2);
  assert.equal(receipt.projectionRevision, "1");
  assert.equal(f.indexes.size, 1);
  assert.equal(f.indexes.get("foods").length, 1);
  assert.equal(f.indexes.get("foods")[0].name, "Blueberries (synthetic sample)");
  assert.deepEqual(await readdir(f.spoolDirectory), []);
  assert(f.requests.some(([method, path]) => method === "POST" && path === "/swap-indexes"));
  assert(
    f.requests.some(([method, path]) => method === "DELETE" && path.includes("__generation__")),
  );
});

test("a generic404 cannot masquerade as an empty search target before any publication", async (t) => {
  const f = await fixture(t, { wrongAbsence: true });
  await assert.rejects(seedDevelopmentRuntimeCatalogue(f.input));
  assert(!f.claimed() && !f.published());
  assert.equal(f.rowsByTable.size, 0);
});

for (const [label, options] of Object.entries({
  countMismatch: { wrongCount: true },
  revisionDrift: { revisionDrift: true },
}))
  test(`${label} after real seed/rebuild cannot acknowledge readiness or swap`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(seedDevelopmentRuntimeCatalogue(f.input), (error) =>
      label === "countMismatch"
        ? error.code === "INDEX_COUNT_MISMATCH"
        : error.name === "FoodSearchProjectionRevisionChangedError",
    );
    assert(f.requests.some(([method, path]) => method === "POST" && path.endsWith("/documents")));
    assert(f.claimed() && !f.published());
    assert(f.rowsByTable.has("food_nutrient_value"));
    assert(!f.requests.some(([, path]) => path === "/swap-indexes"));
    assert.deepEqual(await readdir(f.spoolDirectory), []);
  });

for (const omitTransition of [
  "food.current_version_id",
  "food_source.active_release_id",
  "food_source_release.status",
])
  test(`omitted publication transition ${omitTransition} stays absent from the controlled authority view`, async (t) => {
    const f = await fixture(t, { omitTransition });
    await assert.rejects(
      seedDevelopmentRuntimeCatalogue(f.input),
      (error) => error.name === "AssertionError",
    );
    assert(f.claimed() && !f.published());
    assert(f.rowsByTable.has("food_nutrient_value"));
    assert(!f.requests.some(([method]) => method === "POST"));
    assert.equal(f.indexes.size, 0);
  });
