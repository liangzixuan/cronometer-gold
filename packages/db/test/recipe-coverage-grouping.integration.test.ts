import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type Kysely, sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";

import {
  createCustomFood,
  createDatabase,
  createRecipe,
  type Database,
  registerPasswordAccount,
  runMigrations,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const nutrientId = (value: number) => String(value);
const PARENT = id(100);
const REASONS = ["not_reported", "not_analyzed", "not_applicable", "withheld"] as const;
const COUNT_FIELDS = [
  "quantified_count",
  "trace_count",
  "unknown_count",
  ...REASONS.map((reason) => `${reason}_count` as const),
] as const;
type Counts = Record<(typeof COUNT_FIELDS)[number], number>;
interface CoverageRow extends Counts {
  nutrient_id: string;
}
interface Ingredient {
  ingredient_kind: "food" | "recipe";
  food_version_id: string | null;
  custom_food_id: string | null;
  nested_recipe_version_id: string | null;
  recipe_version_id?: string;
}
interface ProjectionFixture {
  ingredients: readonly Ingredient[];
  nutrients: readonly { id: string; active: boolean }[];
  publicValues?: readonly {
    version: string;
    nutrient: string;
    status: string;
    amount: string | null;
  }[];
  customValues?: readonly {
    food: string;
    version: string;
    nutrient: string;
    state: string;
    reason?: string;
  }[];
  nestedValues?: readonly {
    version: string;
    nutrient: string;
    quantified: number;
    trace: number;
    unknown: number;
    reasons: Record<string, number>;
  }[];
}
const food = (version: number, custom?: number): Ingredient => ({
  ingredient_kind: "food",
  food_version_id: id(version),
  custom_food_id: custom === undefined ? null : id(custom),
  nested_recipe_version_id: null,
});
const nested = (version: number): Ingredient => ({
  ingredient_kind: "recipe",
  food_version_id: null,
  custom_food_id: null,
  nested_recipe_version_id: id(version),
});
const counters = (nutrient: number, values: Partial<Counts> = {}): CoverageRow => ({
  nutrient_id: nutrientId(nutrient),
  quantified_count: 0,
  trace_count: 0,
  unknown_count: 0,
  not_reported_count: 0,
  not_analyzed_count: 0,
  not_applicable_count: 0,
  withheld_count: 0,
  ...values,
});

// These typed relations exercise PostgreSQL arithmetic, not catalogue/source authority.
function relations(input: ProjectionFixture) {
  return sql`
    selected_version(id) as (values (${PARENT}::uuid)),
    nutrient(id, active) as (values ${sql.join(input.nutrients.map((row) => sql`(${row.id}::bigint, ${row.active}::boolean)`))}),
    recipe_ingredient(recipe_version_id, ingredient_kind, food_version_id, custom_food_id, nested_recipe_version_id, position, resolved_grams) as (
      values ${sql.join(input.ingredients.map((row, position) => sql`(${row.recipe_version_id ?? PARENT}::uuid, ${row.ingredient_kind}::text, ${row.food_version_id}::uuid, ${row.custom_food_id}::uuid, ${row.nested_recipe_version_id}::uuid, ${position}::integer, ${String(position + 1)}::numeric)`))}
    ),
    food_nutrient_value(food_version_id, nutrient_id, value_status, amount) as (
      values (null::uuid, null::bigint, null::text, null::numeric)
      ${sql.join(
        (input.publicValues ?? []).map(
          (row) =>
            sql`, (${row.version}::uuid, ${row.nutrient}::bigint, ${row.status}::text, ${row.amount}::numeric)`,
        ),
        sql``,
      )}
    ),
    custom_food_version_nutrient(custom_food_id, food_version_id, nutrient_id, value_state, unknown_reason) as (
      values (null::uuid, null::uuid, null::bigint, null::text, null::text)
      ${sql.join(
        (input.customValues ?? []).map(
          (row) =>
            sql`, (${row.food}::uuid, ${row.version}::uuid, ${row.nutrient}::bigint, ${row.state}::text, ${row.reason ?? null}::text)`,
        ),
        sql``,
      )}
    ),
    recipe_version_nutrient(recipe_version_id, nutrient_id, quantified_count, trace_count, unknown_count, unknown_reasons) as (
      values (null::uuid, null::bigint, null::integer, null::integer, null::integer, null::jsonb)
      ${sql.join(
        (input.nestedValues ?? []).map(
          (row) =>
            sql`, (${row.version}::uuid, ${row.nutrient}::bigint, ${row.quantified}::integer, ${row.trace}::integer, ${row.unknown}::integer, ${JSON.stringify(row.reasons)}::jsonb)`,
        ),
        sql``,
      )}
    )`;
}

function coverageProjection(body: string): string {
  const endMarker = "    select 1 from expected\n    join recipe_version_nutrient actual";
  expect(body.split(endMarker)).toHaveLength(2);
  const end = body.indexOf(endMarker);
  const startMarker = "  if exists (\n";
  const start = body.lastIndexOf(startMarker, end);
  expect(start).toBeGreaterThanOrEqual(0);
  const projection = body.slice(start + startMarker.length, end).trim();
  expect(projection.startsWith("with ")).toBe(true);
  expect(projection.match(/\bversion_id\b/gu)).toHaveLength(1);
  return projection;
}

async function readProjections(database: Kysely<Database>, schema: string) {
  const historical = await readFile(
    new URL("../migrations/0006_retention_features.sql", import.meta.url),
    "utf8",
  );
  const oldBody = historical
    .split("create or replace function reconcile_recipe_components_v2()")[1]
    ?.split("\n$$;")[0];
  if (!oldBody) throw new Error("Historical recipe reconciler was not found");
  const previous = coverageProjection(oldBody);
  expect(createHash("sha256").update(previous).digest("hex")).toBe(
    "043bac7b9aac6dd581dfbccf0b7b7db99ef476fd40573c2fc8d6cd1bee970f05",
  );
  const installed = await sql<{ prosrc: string }>`
    select p.prosrc from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema} and p.proname = 'reconcile_recipe_components_v2'
      and pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
  `.execute(database);
  expect(installed.rows).toHaveLength(1);
  const body = installed.rows[0]?.prosrc;
  if (!body) throw new Error("Installed recipe reconciler was not found");
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    "bd19e74f953196ffeb733c466bdf6f3a46a903d5a86f0121b5ba0af588af7128",
  );
  return [previous, coverageProjection(body)] as const;
}

async function project(database: Kysely<Database>, projection: string, input: ProjectionFixture) {
  const bound = projection
    .slice("with ".length)
    .replace(/\bversion_id\b/u, "(select id from selected_version)");
  return (
    await sql<CoverageRow>`with ${relations(input)}, ${sql.raw(bound)} select * from expected order by nutrient_id`.execute(
      database,
    )
  ).rows;
}

function mixedReferences(): ProjectionFixture {
  return {
    nutrients: Array.from({ length: 7 }, (_, i) => ({ id: nutrientId(i + 1), active: i < 6 })),
    ingredients: [
      food(10),
      food(10),
      food(11),
      food(20, 30),
      food(20, 30),
      food(20, 30),
      food(21, 30),
      nested(40),
      nested(40),
      nested(41),
      { ...food(99), recipe_version_id: id(101) },
    ],
    publicValues: [
      { version: id(10), nutrient: nutrientId(1), status: "measured", amount: "0" },
      { version: id(10), nutrient: nutrientId(2), status: "trace", amount: null },
      { version: id(11), nutrient: nutrientId(1), status: "estimated", amount: "2" },
    ],
    customValues: [
      { food: id(30), version: id(20), nutrient: nutrientId(1), state: "quantified" },
      { food: id(30), version: id(20), nutrient: nutrientId(2), state: "trace" },
      { food: id(30), version: id(21), nutrient: nutrientId(1), state: "trace" },
      {
        food: id(30),
        version: id(21),
        nutrient: nutrientId(2),
        state: "unknown",
        reason: "withheld",
      },
      {
        food: id(30),
        version: id(21),
        nutrient: nutrientId(3),
        state: "unknown",
        reason: "not_applicable",
      },
      { food: id(30), version: id(21), nutrient: nutrientId(6), state: "quantified" },
      ...(["not_analyzed", "not_reported", "withheld", "not_applicable"] as const).map(
        (reason, index) => ({
          food: id(30),
          version: id(20),
          nutrient: nutrientId(index + 3),
          state: "unknown",
          reason,
        }),
      ),
    ],
    nestedValues: [
      {
        version: id(40),
        nutrient: nutrientId(1),
        quantified: 2,
        trace: 1,
        unknown: 4,
        reasons: { not_reported: 1, not_analyzed: 1, not_applicable: 1, withheld: 1 },
      },
      {
        version: id(40),
        nutrient: nutrientId(2),
        quantified: 0,
        trace: 0,
        unknown: 2,
        reasons: { not_reported: 2 },
      },
      {
        version: id(41),
        nutrient: nutrientId(1),
        quantified: 0,
        trace: 0,
        unknown: 1,
        reasons: { not_reported: 1 },
      },
      {
        version: id(41),
        nutrient: nutrientId(2),
        quantified: 5,
        trace: 0,
        unknown: 0,
        reasons: {},
      },
    ],
  };
}

describeDatabase("recipe coverage reference grouping", () => {
  it("matches the historical coverage projection for mixed and repeated references, missingness, reasons and integer limits", async () => {
    const fixture = await createFixture();
    try {
      const projections = await readProjections(fixture.database, fixture.schemaName);
      const input = mixedReferences();
      const expected = [
        counters(1, {
          quantified_count: 10,
          trace_count: 3,
          unknown_count: 9,
          not_reported_count: 3,
          not_analyzed_count: 2,
          not_applicable_count: 2,
          withheld_count: 2,
        }),
        counters(2, {
          quantified_count: 5,
          trace_count: 5,
          unknown_count: 6,
          not_reported_count: 5,
          withheld_count: 1,
        }),
        counters(3, {
          unknown_count: 10,
          not_reported_count: 6,
          not_analyzed_count: 3,
          not_applicable_count: 1,
        }),
        counters(4, { unknown_count: 10, not_reported_count: 10 }),
        counters(5, { unknown_count: 10, not_reported_count: 7, withheld_count: 3 }),
        counters(6, {
          quantified_count: 1,
          unknown_count: 9,
          not_reported_count: 6,
          not_applicable_count: 3,
        }),
      ];
      for (const projection of projections)
        expect(await project(fixture.database, projection, input)).toEqual(expected);
      for (const projection of projections) {
        expect(
          await project(fixture.database, projection, {
            ...input,
            ingredients: [{ ...food(10), recipe_version_id: id(101) }],
          }),
        ).toEqual([]);
        const nullReferences = {
          ...input,
          ingredients: [
            { ...food(10), food_version_id: null },
            { ...food(10), food_version_id: null },
            { ...nested(40), nested_recipe_version_id: null },
          ],
        };
        expect(await project(fixture.database, projection, nullReferences)).toEqual(
          [1, 2, 3, 4, 5, 6].map((nutrient) =>
            counters(nutrient, { unknown_count: 3, not_reported_count: 3 }),
          ),
        );
      }

      const repeated = { ...input, ingredients: Array.from({ length: 50 }, () => nested(40)) };
      const cardinality = await sql<{ rows: number; groups: number }>`
        with ${relations(repeated)}
        select (select count(*)::integer from recipe_ingredient) as rows,
          (select count(*)::integer from (select ingredient_kind, food_version_id, custom_food_id, nested_recipe_version_id
           from recipe_ingredient group by ingredient_kind, food_version_id, custom_food_id, nested_recipe_version_id) grouped) as groups
      `.execute(fixture.database);
      expect(cardinality.rows).toEqual([{ rows: 50, groups: 1 }]);
      const repeatedExpected = [
        counters(1, {
          quantified_count: 100,
          trace_count: 50,
          unknown_count: 200,
          not_reported_count: 50,
          not_analyzed_count: 50,
          not_applicable_count: 50,
          withheld_count: 50,
        }),
        counters(2, { unknown_count: 100, not_reported_count: 100 }),
        ...[3, 4, 5, 6].map((nutrient) =>
          counters(nutrient, { unknown_count: 50, not_reported_count: 50 }),
        ),
      ];
      for (const projection of projections)
        expect(await project(fixture.database, projection, repeated)).toEqual(repeatedExpected);

      for (const field of COUNT_FIELDS) {
        const row = (version: number, amount: number) => ({
          version: id(version),
          nutrient: nutrientId(1),
          quantified: field === "quantified_count" ? amount : 0,
          trace: field === "trace_count" ? amount : 0,
          unknown: field === "unknown_count" ? amount : 0,
          reasons: Object.fromEntries(
            REASONS.map((reason) => [reason, field === `${reason}_count` ? amount : 0]),
          ),
        });
        const boundary: ProjectionFixture = {
          nutrients: [{ id: nutrientId(1), active: true }],
          ingredients: [nested(40), nested(40), nested(41)],
          nestedValues: [row(40, 1_073_741_823), row(41, 1)],
        };
        for (const projection of projections) {
          expect(await project(fixture.database, projection, boundary)).toEqual([
            counters(1, { [field]: 2_147_483_647 }),
          ]);
          await expect(
            project(fixture.database, projection, {
              ...boundary,
              ingredients: Array.from({ length: 50 }, () => nested(40)),
              nestedValues: [row(40, 2_147_483_647)],
            }),
          ).rejects.toMatchObject({ code: "22003" });
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it("preserves stored rows and validates deferred children independently of the parent at explicit constraint flushes", async () => {
    const fixture = await createFixture();
    try {
      const nutrients = await fixture.database
        .insertInto("nutrient")
        .values([
          {
            code: "coverage_energy",
            name: "Coverage energy",
            canonical_unit: "kcal",
            dimension: "energy",
            is_targetable: false,
          },
          {
            code: "coverage_protein",
            name: "Coverage protein",
            canonical_unit: "g",
            dimension: "mass",
            is_targetable: true,
          },
        ])
        .returning(["id", "code"])
        .execute();
      const energy = nutrients.find((row) => row.code === "coverage_energy")?.id;
      const protein = nutrients.find((row) => row.code === "coverage_protein")?.id;
      if (!energy || !protein) throw new Error("Expected fixture nutrients");
      const owner = await registerPasswordAccount(fixture.database, {
        email: `coverage-${randomUUID()}@example.invalid`,
        passwordHash: "$argon2id$coverage-hash",
        passwordParameters: { algorithm: "argon2id" },
        passwordSalt: "coverage-salt-value",
        timeZone: "America/Chicago",
      });
      const custom = await createCustomFood(fixture.database, {
        clientOperationId: randomUUID(),
        requestDigest: "1".repeat(64),
        userId: owner.userId,
        food: {
          name: "Coverage custom food",
          brandName: null,
          notes: null,
          serving: null,
          nutrients: [
            { nutrientId: energy, state: "quantified", amountPer100Grams: "0" },
            {
              nutrientId: protein,
              state: "unknown",
              amountPer100Grams: null,
              reason: "not_analyzed",
            },
          ],
        },
      });
      const leaf = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        requestDigest: "2".repeat(64),
        userId: owner.userId,
        recipe: {
          name: "Coverage leaf",
          description: null,
          instructions: null,
          servingCount: null,
          servingLabel: null,
          yield: { grams: "100", source: "measured" },
          ingredients: [
            {
              kind: "food",
              foodVersionId: custom.food.currentVersion.id,
              portion: { kind: "grams", grams: "100" },
            },
          ],
        },
      });
      const parent = await createRecipe(fixture.database, {
        clientOperationId: randomUUID(),
        requestDigest: "3".repeat(64),
        userId: owner.userId,
        recipe: {
          name: "Repeated coverage",
          description: null,
          instructions: null,
          servingCount: null,
          servingLabel: null,
          yield: { grams: "1275", source: "measured" },
          ingredients: Array.from({ length: 50 }, (_, position) => ({
            kind: "recipe" as const,
            recipeVersionId: leaf.recipe.currentVersion.id,
            grams: String(position + 1),
            position,
            note: `Distinct entry ${position}`,
          })),
        },
      });
      expect(parent.recipe.currentVersion.sources).toEqual([]);
      expect(parent.recipe.currentVersion.ingredients).toHaveLength(50);
      expect(
        parent.recipe.currentVersion.ingredients.map((row) => {
          if (row.kind !== "recipe") {
            throw new Error("Expected a nested recipe ingredient");
          }
          return [row.position, row.note, row.grams];
        }),
      ).toEqual(
        Array.from({ length: 50 }, (_, position) => [
          position,
          `Distinct entry ${position}`,
          String(position + 1),
        ]),
      );
      expect(
        parent.recipe.currentVersion.nutrients.find((row) => row.nutrientId === energy),
      ).toMatchObject({
        knownAmount: "0",
        contributorCount: 50,
        quantifiedCount: 50,
        unknownCount: 0,
      });
      expect(
        parent.recipe.currentVersion.nutrients.find((row) => row.nutrientId === protein),
      ).toMatchObject({
        contributorCount: 50,
        unknownCount: 50,
        unknownReasons: { not_analyzed: 50 },
      });

      for (const constraint of [
        "recipe_ingredient_reconcile_v2",
        "recipe_nutrient_reconcile_v2",
        "all",
      ] as const) {
        await fixture.database.transaction().execute(async (transaction) => {
          await cloneVersion(transaction, leaf.recipe.currentVersion.id);
          await flushConstraints(transaction, constraint);
        });
        let reachedFlush = false;
        await expect(
          fixture.database.transaction().execute(async (transaction) => {
            await cloneVersion(transaction, leaf.recipe.currentVersion.id, "reason");
            reachedFlush = true;
            await flushConstraints(transaction, constraint);
          }),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining("recipe nutrient coverage"),
        });
        expect(reachedFlush).toBe(true);
      }
      for (const corruption of ["missing", "mass", "ontology"] as const) {
        let reachedFlush = false;
        await expect(
          fixture.database.transaction().execute(async (transaction) => {
            await cloneVersion(transaction, leaf.recipe.currentVersion.id, corruption);
            reachedFlush = true;
            await flushConstraints(transaction, "all");
          }),
        ).rejects.toMatchObject({ code: "23514" });
        expect(reachedFlush).toBe(true);
      }
      let excessReachedFlush = false;
      await expect(
        fixture.database.transaction().execute(async (transaction) => {
          await cloneVersion(transaction, leaf.recipe.currentVersion.id, "excess");
          excessReachedFlush = true;
          await flushConstraints(transaction, "all");
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("component count would exceed declaration"),
      });
      expect(excessReachedFlush).toBe(false);
      let parentWasChecked = false;
      await expect(
        fixture.database.transaction().execute(async (transaction) => {
          await cloneVersion(transaction, leaf.recipe.currentVersion.id);
          await flushConstraints(transaction, "recipe_version_components_reconcile_v2");
          parentWasChecked = true;
          await transaction
            .insertInto("nutrient")
            .values({
              code: "coverage_added",
              name: "New active coverage nutrient",
              canonical_unit: "g",
              dimension: "mass",
            })
            .execute();
          await flushConstraints(transaction, "recipe_nutrient_reconcile_v2");
        }),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("active ontology"),
      });
      expect(parentWasChecked).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

async function flushConstraints(transaction: Transaction<Database>, constraint: string) {
  const started = performance.now();
  try {
    if (constraint === "all") await sql`set constraints all immediate`.execute(transaction);
    else await sql`set constraints ${sql.id(constraint)} immediate`.execute(transaction);
  } finally {
    console.info(
      "[recipe-coverage-constraint]",
      JSON.stringify({ constraint, durationMs: Math.round(performance.now() - started) }),
    );
  }
}

async function cloneVersion(
  transaction: Transaction<Database>,
  sourceVersionId: string,
  corruption?: "reason" | "missing" | "excess" | "mass" | "ontology",
) {
  const source = await transaction
    .selectFrom("recipe_version")
    .selectAll()
    .where("id", "=", sourceVersionId)
    .executeTakeFirstOrThrow();
  const ingredients = await transaction
    .selectFrom("recipe_ingredient")
    .selectAll()
    .where("recipe_version_id", "=", sourceVersionId)
    .orderBy("position")
    .execute();
  const nutrients = await transaction
    .selectFrom("recipe_version_nutrient")
    .selectAll()
    .where("recipe_version_id", "=", sourceVersionId)
    .orderBy("nutrient_id")
    .execute();
  expect(
    await transaction
      .selectFrom("recipe_version_source")
      .selectAll()
      .where("recipe_version_id", "=", sourceVersionId)
      .execute(),
  ).toEqual([]);
  const recipeId = randomUUID();
  const versionId = randomUUID();
  await transaction
    .insertInto("recipe")
    .values({
      id: recipeId,
      owner_user_id: source.owner_user_id,
      current_version_id: versionId,
      status: "active",
    })
    .execute();
  await transaction
    .insertInto("recipe_version")
    .values({
      ...source,
      id: versionId,
      recipe_id: recipeId,
      version_number: 1,
      input_mass_grams: corruption === "mass" ? "101" : source.input_mass_grams,
      nutrient_component_count:
        corruption === "ontology"
          ? source.nutrient_component_count - 1
          : source.nutrient_component_count,
      warnings: sql`${JSON.stringify(source.warnings)}::jsonb`,
    })
    .execute();
  for (const [index, row] of ingredients.entries()) {
    if (corruption === "missing" && index === 0) continue;
    const { id: _id, ...copy } = row;
    await transaction
      .insertInto("recipe_ingredient")
      .values({ ...copy, recipe_version_id: versionId })
      .execute();
    if (corruption === "excess" && index === 0)
      await transaction
        .insertInto("recipe_ingredient")
        .values({ ...copy, recipe_version_id: versionId, position: 1 })
        .execute();
  }
  for (const [index, row] of nutrients.entries()) {
    if (corruption === "ontology" && index === 0) continue;
    await transaction
      .insertInto("recipe_version_nutrient")
      .values({
        ...row,
        recipe_version_id: versionId,
        unknown_reasons:
          corruption === "reason" && row.unknown_count === 1
            ? { withheld: 1 }
            : row.unknown_reasons,
      })
      .execute();
  }
}

async function createFixture() {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  const schemaName = `recipe_coverage_${randomBytes(6).toString("hex")}`;
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName},public`);
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
  let schemaCreated = false;
  const close = async () => {
    try {
      await database.destroy();
    } finally {
      try {
        if (schemaCreated) await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
      } finally {
        await bootstrap.destroy();
      }
    }
  };
  try {
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    schemaCreated = true;
    await runMigrations(database);
    return { database, schemaName, close };
  } catch (error) {
    await close();
    throw error;
  }
}
