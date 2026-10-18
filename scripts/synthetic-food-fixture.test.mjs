import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CORE_NUTRIENTS } from "../packages/domain/dist/index.js";
import {
  initializeSyntheticNutrientRegistry,
  seedPromotedPublicFood,
  syntheticFoodFixtures,
  validateSyntheticFoodFixtures,
} from "./synthetic-food-fixture.mts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = require("kysely");

function controlledDatabase(failTable) {
  const queries = [],
    transactions = [];
  let id = 100;
  const registryRows = CORE_NUTRIENTS.map((definition, index) => ({
    id: String(index + 1),
    code: definition.id,
    name: definition.name,
    canonical_unit: definition.canonicalUnit,
  }));
  const connection = {
    async executeQuery(query) {
      queries.push(query);
      if (failTable && query.sql.startsWith(`insert into "${failTable}"`))
        throw new Error("Synthetic transaction interruption");
      if (query.sql.startsWith('insert into "nutrient"')) return { rows: registryRows };
      return { rows: query.sql.includes('returning "id"') ? [{ id: String(id++) }] : [] };
    },
    streamQuery() {
      throw new Error("No fixture stream is admitted");
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
        async beginTransaction() {
          transactions.push("begin");
        },
        async commitTransaction() {
          transactions.push("commit");
        },
        async rollbackTransaction() {
          transactions.push("rollback");
        },
        async releaseConnection() {},
        async destroy() {},
      }),
    },
  });
  return { database, queries, transactions };
}

test("shared fixture import is inert and retains all checked-in nutrient definitions and missingness", () => {
  validateSyntheticFoodFixtures();
  assert.equal(syntheticFoodFixtures.length, 12);
  const blueberries = syntheticFoodFixtures.find(
    (food) => food.name === "Blueberries (synthetic sample)",
  );
  assert.equal(blueberries.grams, "150");
  assert.equal(blueberries.amounts.energy, "60");
  assert.equal(Object.keys(blueberries.amounts).length, 15);
  assert.equal(
    syntheticFoodFixtures.find((food) => food.name.startsWith("Rolled oats")).amounts["vitamin-d"],
    null,
  );
});

test("initializes the full registry under its actual database writer lock", async () => {
  const f = controlledDatabase();
  try {
    const registry = await initializeSyntheticNutrientRegistry(f.database);
    assert.equal(registry.size, 15);
    assert.deepEqual(
      [...registry.keys()],
      CORE_NUTRIENTS.map((nutrient) => nutrient.id),
    );
    const inserted = f.queries.findIndex((query) => query.sql.startsWith('insert into "nutrient"'));
    assert.ok(inserted > 0, "The maintained registry lock must execute before insert");
    assert.match(
      f.queries
        .slice(0, inserted)
        .map((query) => query.sql)
        .join("\n"),
      /lock|advisory/iu,
    );
    assert.deepEqual(f.transactions, ["begin", "commit"]);
  } finally {
    await f.database.destroy();
  }
});

test("publishes one complete synthetic public food through the maintained transaction", async () => {
  const f = controlledDatabase();
  try {
    const registry = await initializeSyntheticNutrientRegistry(f.database);
    const fixture = syntheticFoodFixtures.find(
      (food) => food.name === "Blueberries (synthetic sample)",
    );
    const now = new Date();
    const result = await seedPromotedPublicFood(f.database, { registry, fixture, now });
    assert.deepEqual(Object.keys(result).sort(), [
      "foodId",
      "foodVersionId",
      "releaseId",
      "sourceId",
    ]);
    for (const table of [
      "food_source",
      "source_nutrient_map",
      "source_nutrient_map_revision",
      "food_source_release",
      "food_import_batch",
      "food",
      "food_version",
      "food_import_record",
      "food_nutrient_value",
      "food_serving",
    ])
      assert.ok(
        f.queries.some((query) => query.sql.startsWith(`insert into "${table}"`)),
        table,
      );
    const text = JSON.stringify(f.queries, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    assert.ok(text.includes("live-reviewed"));
    assert.ok(text.includes("Test-only synthetic fixture"));
    assert.ok(text.includes("not independent source review"));
    const servings = f.queries.find((query) => query.sql.startsWith('insert into "food_serving"'));
    assert.ok(servings.parameters.includes("150"));
    assert.ok(servings.parameters.includes("100"));
    const release = f.queries.find((query) =>
      query.sql.startsWith('insert into "food_source_release"'),
    );
    const expiry = release.parameters.find((value) => value instanceof Date && value > now);
    assert.ok(expiry instanceof Date);
    assert.ok(Math.abs(expiry.getTime() - now.getTime() - 12 * 3600000) < 1000);
    assert.deepEqual(f.transactions, ["begin", "commit", "begin", "commit"]);
    assert.doesNotMatch(text, /disable trigger|session_replication_role|drop|truncate/iu);
  } finally {
    await f.database.destroy();
  }
});

test("a publication failure rolls back without a later promotion or cleanup mutation", async () => {
  const f = controlledDatabase("food_version");
  try {
    const registry = await initializeSyntheticNutrientRegistry(f.database);
    await assert.rejects(
      seedPromotedPublicFood(f.database, {
        registry,
        fixture: syntheticFoodFixtures[3],
        now: new Date(),
      }),
      /Synthetic transaction interruption/u,
    );
    assert.deepEqual(f.transactions, ["begin", "commit", "begin", "rollback"]);
    assert.ok(
      !f.queries.some((query) => query.sql.startsWith('insert into "food_nutrient_value"')),
    );
    assert.ok(!f.queries.some((query) => query.sql.startsWith('update "food_source"')));
  } finally {
    await f.database.destroy();
  }
});

test("the existing local executable still validates offline without environment or services", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./local-walkthrough/seed-catalogue.mts", import.meta.url)),
      "--validate-only",
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 32768,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    syntheticOnly: true,
    foods: 12,
    servings: 24,
    coreNutrients: 15,
    serviceAccess: false,
  });
});
