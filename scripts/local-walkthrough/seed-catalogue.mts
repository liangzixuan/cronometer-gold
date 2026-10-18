/**
 * Disposable synthetic local walkthrough fixture. Never target a real catalogue.
 * Adapted from apps/api/test/retention-worker.integration.test.ts seedPromotedPublicFood.
 * Public eligibility requires synthetic "live-reviewed" rows, as in that test.
 * They simulate contracts ONLY: no rights/scientific/independent-review approval exists.
 * No SQL trigger, constraint, role, authorization or application guard is disabled.
 *
 * Root supplies a fresh sanitized environment. This helper never reads .env.
 * Required names: WALKTHROUGH_RUN_ID, WALKTHROUGH_FIXTURE_ONLY, NODE_ENV,
 * DATABASE_URL, MEILI_URL, MEILI_ADMIN_KEY, MEILI_TASK_OBSERVER_KEY,
 * MEILI_SEARCH_KEY, WALKTHROUGH_EVIDENCE_DIR.
 * NODE_ENV=development; WALKTHROUGH_FIXTURE_ONLY=yes; run ID is 8-32 lowercase alphanumerics.
 * Database must be fresh, migrated and named nourishing_walkthrough_<run ID>.
 * Three Meili keys must be scoped and distinct; master key stays with bootstrap.
 * Evidence directory must be a fresh owner-only Linux directory from run.py.
 *
 * Use run.py create to provide the isolated runtime and sanitized environment.
 * Add --validate-only for offline fixture checks (no environment or services).
 * Fixture evidence expires after 12 hours; do not silently extend it.
 */
import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rebuildFoodSearchNow } from "../../apps/worker/dist/food-search-worker.js";
import {
  assertDatabaseReady,
  createDatabase,
  pageFoodSearchProjection,
} from "../../packages/db/dist/index.js";
import { MeilisearchHttpClient } from "../../packages/search/dist/index.js";
import {
  syntheticFoodFixtures as fixtures,
  initializeSyntheticNutrientRegistry,
  seedPromotedPublicFood,
  validateSyntheticFoodFixtures as validateFixtures,
} from "../synthetic-food-fixture.mts";
import { assertCatalogueRuntime } from "./runtime-contract.mjs";

function required(name: string): string {
  const value = process.env[name];
  assert(value && value.trim() === value, `Missing or invalid ${name}`);
  return value;
}
async function seed() {
  validateFixtures();
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--validate-only") {
    console.log(
      JSON.stringify({
        valid: true,
        syntheticOnly: true,
        foods: 12,
        servings: 24,
        coreNutrients: 15,
        serviceAccess: false,
      }),
    );
    return;
  }
  assert(process.argv.length === 2, "Only --validate-only is supported");
  assert(required("WALKTHROUGH_FIXTURE_ONLY") === "yes");
  assert(required("NODE_ENV") === "development");
  assert(!process.env.MEILI_MASTER_KEY, "Master key must stay with scoped-key bootstrap");
  const runId = required("WALKTHROUGH_RUN_ID");
  assert(/^[a-z0-9]{8,32}$/.test(runId), "Invalid walkthrough run ID");
  const target = new URL(required("DATABASE_URL"));
  assert(
    target.protocol === "postgresql:" &&
      target.hostname === "127.0.0.1" &&
      Number(target.port) >= 1024 &&
      Number(target.port) <= 65535 &&
      target.username &&
      target.password &&
      target.pathname === `/nourishing_walkthrough_${runId}` &&
      !target.search &&
      !target.hash,
    "Requires the selected fresh walkthrough database on loopback",
  );
  const host = required("MEILI_URL"),
    meili = new URL(host);
  assert(
    meili.protocol === "http:" &&
      meili.hostname === "127.0.0.1" &&
      Number(meili.port) >= 1024 &&
      Number(meili.port) <= 65535 &&
      host === `http://127.0.0.1:${meili.port}`,
    "Requires exact loopback Meilisearch",
  );
  const adminKey = required("MEILI_ADMIN_KEY"),
    taskKey = required("MEILI_TASK_OBSERVER_KEY"),
    searchKey = required("MEILI_SEARCH_KEY");
  assert(
    new Set([adminKey, taskKey, searchKey]).size === 3 &&
      [adminKey, taskKey, searchKey].every((key) => /^[a-f0-9]{64}$/.test(key)),
    "Requires distinct generated scoped Meilisearch keys",
  );
  const directory = required("WALKTHROUGH_EVIDENCE_DIR");
  assert(
    directory.startsWith("/") &&
      !directory.startsWith("/mnt/") &&
      (await realpath(directory)) === directory,
    "Evidence must be a Linux-filesystem directory",
  );
  const meta = await lstat(directory);
  assert(
    meta.isDirectory() &&
      !meta.isSymbolicLink() &&
      meta.uid === process.getuid?.() &&
      (meta.mode & 0o777) === 0o700,
    "Evidence directory must be owner-only",
  );
  const runtime = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
  assertCatalogueRuntime(runtime, {
    directory,
    runId,
    postgresPort: target.port,
    meiliPort: meili.port,
  });
  const receipt = join(directory, "synthetic-catalogue.json");
  await writeFile(
    join(directory, "catalogue-seed-claimed.json"),
    `${JSON.stringify({ runId, syntheticOnly: true, at: new Date().toISOString() })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const database = createDatabase({
    connectionString: target.toString(),
    maxConnections: 3,
    connectionTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    ssl: false,
  });
  const client = new MeilisearchHttpClient({
    host,
    apiKey: adminKey,
    taskApiKey: taskKey,
    requestTimeoutMs: 5000,
  });
  try {
    await assertDatabaseReady(database, { requireRestoreAttestation: false });
    assert(
      !(await client.indexExists("foods")),
      "Refusing to replace an existing search catalogue",
    );
    for (const table of ["app_user", "food_source", "food", "nutrient"] as const)
      assert(
        (await database.selectFrom(table).select("id").limit(1).execute()).length === 0,
        "Database is not an empty isolated fixture",
      );
    const registry = await initializeSyntheticNutrientRegistry(database);
    const now = new Date();
    for (const fixture of fixtures)
      await seedPromotedPublicFood(database, { registry, now, fixture });
    const projection = await pageFoodSearchProjection(database, { limit: 50 });
    assert(
      projection.nextCursor === null && projection.documents.length === fixtures.length,
      "Authoritative projection did not admit every synthetic food",
    );
    assert(
      projection.documents.every(
        (food) => food.name.includes("(synthetic sample)") && food.servings.length === 2,
      ),
      "Projected foods or servings differ from the fixture",
    );
    const rebuilt = await rebuildFoodSearchNow({
      client,
      database,
      batchSize: 12,
      spoolDirectory: directory,
      spoolMaxBytes: 1048576,
      spoolMaxDocuments: 12,
      taskTimeoutMs: 30000,
      signal: AbortSignal.timeout(120000),
    });
    assert(
      rebuilt &&
        rebuilt.includedCount === 12 &&
        rebuilt.excludedCount === 0 &&
        rebuilt.cleanup.status === "completed",
      "Real database-backed index rebuild did not complete",
    );
    await writeFile(
      receipt,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId,
          syntheticOnly: true,
          fixtureExpiresAt: new Date(now.getTime() + 12 * 3600000).toISOString(),
          note: "Invented fixture values; no live catalogue or independent-review acceptance",
          foods: projection.documents.map((food) => ({
            foodId: food.foodId,
            foodVersionId: food.foodVersionId,
            name: food.name,
            servings: food.servings,
          })),
          coreNutrients: [...registry.values()].map((row) => ({
            id: row.id,
            code: row.code,
            unit: row.canonical_unit,
          })),
          index: {
            stableIndex: rebuilt.stableIndex,
            projectionRevision: rebuilt.projectionRevision,
            includedCount: rebuilt.includedCount,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      JSON.stringify({
        seeded: true,
        syntheticOnly: true,
        foods: 12,
        servings: 24,
        coreNutrients: 15,
        receipt,
      }),
    );
  } finally {
    await database.destroy();
  }
}
process.umask(0o077);
seed().catch((error: unknown) => {
  // Retain partial fixture state; never dump SQL, URLs, keys or stack.
  console.error(
    JSON.stringify({
      seeded: false,
      syntheticOnly: true,
      errorType: error instanceof Error ? error.name : "UnknownError",
      instruction:
        "Inspect the isolated fixture; do not rerun against partial data or alter authority guards.",
    }),
  );
  process.exitCode = 1;
});
