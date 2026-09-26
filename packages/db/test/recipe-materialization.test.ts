import { randomUUID } from "node:crypto";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
  createRecipe,
  type RecipeIngredientInput,
  RecipeNotFoundError,
  RecipeValidationError,
} from "../src/recipes.js";
import type { Database } from "../src/types.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const SECOND_VERSION = "44444444-4444-4444-8444-444444444444";
const ROOT = "55555555-5555-4555-8555-555555555555";
const materialized = new Error("Captured materialization before recipe-head update");

function snapshot(id = VERSION, energy = "100", owner = OWNER) {
  return {
    nutrients: [
      {
        completeness: "complete",
        contributor_count: 1,
        is_exact: true,
        known_amount: energy,
        nutrient_code: "energy",
        nutrient_id: "1",
        nutrient_name: "Energy",
        quantified_count: 1,
        recipe_version_id: id,
        trace_count: 0,
        unit: "kcal",
        unknown_count: 0,
        unknown_reasons: {},
      },
    ],
    version: {
      id,
      name: id === VERSION ? "First immutable recipe" : "Second immutable recipe",
      owner_user_id: owner,
      recipe_id: ROOT,
      serving_count: null,
      serving_label: null,
      total_weight_grams: "100",
      version_number: id === VERSION ? 1 : 2,
    },
  };
}

function fixture(snapshots = [snapshot()]) {
  const queries: CompiledQuery[] = [];
  const respond = (query: CompiledQuery): unknown[] => {
    const { sql, parameters } = query;
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.startsWith('select "id" from "app_user"')) return [{ id: parameters[0] }];
    if (sql.includes('from "recipe_operation"')) return [];
    if (sql.startsWith('select "id", "recipe_id", "owner_user_id" from "recipe_version"')) {
      return snapshots
        .filter((item) => parameters.includes(item.version.id))
        .map((item) => item.version);
    }
    if (sql.includes('from "recipe_ingredient"')) return [];
    if (sql.includes('from "recipe_version_source"')) return [];
    if (sql.startsWith('select "id" from "recipe"')) return [{ id: ROOT }];
    if (sql.includes('from "nutrient"')) {
      return [{ id: "1", code: "energy", name: "Energy", canonical_unit: "kcal" }];
    }
    if (sql.startsWith('select * from "recipe_version"')) {
      expect(sql).toContain('"owner_user_id" = $2');
      return snapshots
        .filter(
          (item) =>
            item.version.id === parameters[0] && item.version.owner_user_id === parameters[1],
        )
        .map((item) => item.version);
    }
    if (sql.startsWith('select * from "recipe_version_nutrient"')) {
      return snapshots.find((item) => item.version.id === parameters[0])?.nutrients ?? [];
    }
    if (sql.startsWith("insert into ")) return [];
    // Exercise the real materialization and compiled inserts, then stop before unrelated readback.
    if (sql.startsWith('update "recipe"')) throw materialized;
    throw new Error(`Unexpected database query: ${sql}`);
  };
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          return { rows: respond(query) as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("No streaming expected");
        },
      };
    }
  }
  const database = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    database,
    queries,
    run: (ingredients: readonly RecipeIngredientInput[], userId = OWNER) =>
      createRecipe(database, {
        clientOperationId: randomUUID(),
        recipe: {
          description: null,
          ingredients,
          instructions: null,
          name: "Materialization regression",
          servingCount: null,
          servingLabel: null,
          yield: { grams: "100", source: "measured" },
        },
        requestDigest: "a".repeat(64),
        userId,
      }),
  };
}

function insertedRows(queries: readonly CompiledQuery[], table: string) {
  return queries
    .filter((query) => query.sql.startsWith(`insert into "${table}"`))
    .flatMap((query) => {
      const columns = query.sql
        .slice(query.sql.indexOf("(") + 1, query.sql.indexOf(")"))
        .split(", ")
        .map((column) => column.replaceAll('"', ""));
      expect(query.parameters.length % columns.length).toBe(0);
      return Array.from({ length: query.parameters.length / columns.length }, (_, row) =>
        Object.fromEntries(
          columns.map((column, index) => [column, query.parameters[row * columns.length + index]]),
        ),
      );
    });
}

function snapshotReads(queries: readonly CompiledQuery[], table: string) {
  return queries.filter((query) => query.sql.startsWith(`select * from "${table}"`));
}

describe("nested recipe materialization", () => {
  it("loads one immutable snapshot for 50 distinct contributions without collapsing entries", async () => {
    const test = fixture();
    const ingredients = Array.from({ length: 50 }, (_, index) => ({
      grams: String(index + 1),
      kind: "recipe" as const,
      note: `Entry ${index}`,
      position: 49 - index,
      recipeVersionId: VERSION,
    }));
    try {
      await expect(test.run(ingredients)).rejects.toBe(materialized);
      expect(insertedRows(test.queries, "recipe_ingredient")).toEqual(
        ingredients.map((entry) =>
          expect.objectContaining({
            nested_recipe_version_id: VERSION,
            nested_recipe_version_number: 1,
            note: entry.note,
            position: entry.position,
            quantity: entry.grams,
            resolved_grams: entry.grams,
          }),
        ),
      );
      expect(insertedRows(test.queries, "recipe_version_nutrient")).toEqual([
        expect.objectContaining({
          completeness: "complete",
          contributor_count: 50,
          known_amount: "1275",
          quantified_count: 50,
          unknown_count: 0,
        }),
      ]);
      const reads = snapshotReads(test.queries, "recipe_version");
      expect(reads).toHaveLength(1);
      expect(reads[0]?.parameters).toEqual([VERSION, OWNER]);
      expect(snapshotReads(test.queries, "recipe_version_nutrient")).toHaveLength(1);
      const firstRead = test.queries.indexOf(reads[0] as CompiledQuery);
      const rootLock = test.queries.findIndex(
        (query) => query.sql.includes('from "recipe"') && query.sql.endsWith("for share"),
      );
      const registryLock = test.queries.findIndex((query) =>
        query.sql.includes("pg_advisory_xact_lock_shared"),
      );
      expect(rootLock).toBeGreaterThanOrEqual(0);
      expect(registryLock).toBeGreaterThan(rootLock);
      expect(registryLock).toBeLessThan(firstRead);
    } finally {
      await test.database.destroy();
    }
  });

  it("keeps different immutable versions separate even when they share a recipe root", async () => {
    const test = fixture([snapshot(), snapshot(SECOND_VERSION, "200")]);
    try {
      await expect(
        test.run([
          { kind: "recipe", recipeVersionId: VERSION, grams: "10" },
          { kind: "recipe", recipeVersionId: SECOND_VERSION, grams: "20" },
          { kind: "recipe", recipeVersionId: VERSION, grams: "30" },
        ]),
      ).rejects.toBe(materialized);
      expect(
        insertedRows(test.queries, "recipe_ingredient").map((row) => [
          row.nested_recipe_version_id,
          row.nested_recipe_version_number,
          row.nested_recipe_name,
        ]),
      ).toEqual([
        [VERSION, 1, "First immutable recipe"],
        [SECOND_VERSION, 2, "Second immutable recipe"],
        [VERSION, 1, "First immutable recipe"],
      ]);
      expect(insertedRows(test.queries, "recipe_version_nutrient")[0]).toMatchObject({
        contributor_count: 3,
        known_amount: "80",
        quantified_count: 3,
      });
      expect(snapshotReads(test.queries, "recipe_version")).toHaveLength(2);
      expect(snapshotReads(test.queries, "recipe_version_nutrient")).toHaveLength(2);
    } finally {
      await test.database.destroy();
    }
  });

  it("reloads snapshots for each operation and still rejects another owner", async () => {
    const test = fixture();
    const ingredients = [
      { kind: "recipe" as const, recipeVersionId: VERSION, grams: "10" },
      { kind: "recipe" as const, recipeVersionId: VERSION, grams: "20" },
    ];
    try {
      await expect(test.run(ingredients)).rejects.toBe(materialized);
      await expect(test.run(ingredients)).rejects.toBe(materialized);
      expect(snapshotReads(test.queries, "recipe_version")).toHaveLength(2);
      expect(snapshotReads(test.queries, "recipe_version_nutrient")).toHaveLength(2);
      await expect(test.run(ingredients, OTHER)).rejects.toBeInstanceOf(RecipeNotFoundError);
      expect(insertedRows(test.queries, "recipe_ingredient")).toHaveLength(4);
      expect(snapshotReads(test.queries, "recipe_version")).toHaveLength(2);
    } finally {
      await test.database.destroy();
    }
  });

  it.each([0, 257])(
    "rejects an invalid %i-row nutrient vector before storing any ingredient",
    async (count) => {
      const item = snapshot();
      const nutrient = item.nutrients[0];
      if (!nutrient) throw new Error("Missing synthetic nutrient");
      item.nutrients = Array.from({ length: count }, () => ({ ...nutrient }));
      const test = fixture([item]);
      try {
        await expect(
          test.run([
            { kind: "recipe", recipeVersionId: VERSION, grams: "10" },
            { kind: "recipe", recipeVersionId: VERSION, grams: "20" },
          ]),
        ).rejects.toBeInstanceOf(RecipeValidationError);
        expect(insertedRows(test.queries, "recipe_ingredient")).toHaveLength(0);
      } finally {
        await test.database.destroy();
      }
    },
  );

  it.each([
    { label: "amount", invalid: { grams: "0" } },
    { label: "note", invalid: { note: "x".repeat(2001) } },
    { label: "position", invalid: { position: 0 } },
  ])("validates each repeated contribution's $label before database work", async ({ invalid }) => {
    const test = fixture();
    try {
      await expect(
        test.run([
          { kind: "recipe", recipeVersionId: VERSION, grams: "10", position: 0 },
          { kind: "recipe", recipeVersionId: VERSION, grams: "20", position: 1, ...invalid },
        ]),
      ).rejects.toBeInstanceOf(RecipeValidationError);
      expect(test.queries).toHaveLength(0);
    } finally {
      await test.database.destroy();
    }
  });
});
