/** Host-source maintenance for the private synthetic runtime. No ambient credentials or target discovery. */
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { getCACertificates } from "node:tls";
import { runDatabaseReadinessProbeFromEnvironment } from "../apps/worker/dist/database-readiness-probe.js";
import { runErasureLedgerRestoreFromEnvironment } from "../apps/worker/dist/erasure-ledger-restore.js";
import { rebuildFoodSearchNow } from "../apps/worker/dist/food-search-worker.js";
import {
  assertDatabaseReady,
  type createDatabase,
  pageFoodSearchProjection,
} from "../packages/db/dist/index.js";
import { MeilisearchHttpClient } from "../packages/search/dist/index.js";
import {
  initializeSyntheticNutrientRegistry,
  seedPromotedPublicFood,
  syntheticFoodFixtures,
  validateSyntheticFoodFixtures,
} from "./synthetic-food-fixture.mts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { sql } =
  require("kysely") as typeof import("../packages/db/node_modules/kysely/dist/index.js");
type Database = ReturnType<typeof createDatabase>;
export interface DevelopmentDatabaseTarget {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly expectedOwner: string;
}
function targetSnapshot(input: DevelopmentDatabaseTarget) {
  const target = Object.freeze({ ...input });
  assert(Object.keys(target).sort().join(",") === "databaseName,databaseOid,expectedOwner");
  assert(/^nourishing_development_[a-z0-9]{8,24}$/u.test(target.databaseName));
  assert(
    /^[1-9][0-9]{0,9}$/u.test(target.databaseOid) && BigInt(target.databaseOid) <= 4294967295n,
  );
  assert(/^[a-z][a-z0-9_]{0,62}$/u.test(target.expectedOwner));
  return target;
}
function leaseGuard(notAfterUtc: string, signal: AbortSignal) {
  const stop = Date.parse(notAfterUtc),
    start = Date.now(),
    monotonic = performance.now();
  assert(signal instanceof AbortSignal && new Date(stop).toISOString() === notAfterUtc);
  assert(stop > start && stop - start <= 1_800_000);
  return () => {
    signal.throwIfAborted();
    assert(
      Date.now() >= start && Date.now() < stop && performance.now() - monotonic < stop - start,
    );
  };
}
async function observeOwnedDatabase(database: Database, target: DevelopmentDatabaseTarget) {
  const result = await sql<{
    databaseName: string;
    databaseOid: string;
    owner: string;
    principal: string;
    schema: string;
    tls: boolean;
    tlsVersion: string;
  }>`select current_database() as "databaseName", d.oid::text as "databaseOid",
      pg_get_userbyid(d.datdba) as owner, current_user as principal, current_schema() as schema,
      s.ssl as tls, s.version as "tlsVersion"
      from pg_database d join pg_stat_ssl s on s.pid = pg_backend_pid() where d.datname = current_database()`.execute(
    database,
  );
  assert(result.rows.length === 1);
  const row = result.rows[0];
  assert(
    row?.databaseName === target.databaseName &&
      row.databaseOid === target.databaseOid &&
      row.owner === target.expectedOwner &&
      row.principal === target.expectedOwner &&
      row.schema === "public" &&
      row.tls === true &&
      ["TLSv1.2", "TLSv1.3"].includes(row.tlsVersion),
  );
}

/** Call only after a durable create-only bootstrap claim and fixed dependency/scoped-key admission. */
export async function seedDevelopmentRuntimeCatalogue(input: {
  readonly database: Database;
  readonly expectedTarget: DevelopmentDatabaseTarget;
  readonly searchKeys: {
    readonly worker: string;
    readonly observer: string;
    readonly search: string;
  };
  readonly http: { meiliFetch(input: string, init?: RequestInit): Promise<Response> };
  readonly spoolDirectory: string;
  readonly notAfterUtc: string;
  readonly signal: AbortSignal;
  readonly onMutationStart: () => Promise<void>;
}) {
  const target = targetSnapshot(input.expectedTarget),
    keys = Object.freeze({ ...input.searchKeys });
  const { signal, spoolDirectory, onMutationStart, http, database } = input;
  const guard = leaseGuard(input.notAfterUtc, signal);
  guard();
  assert(
    Object.keys(keys).sort().join(",") === "observer,search,worker" &&
      new Set(Object.values(keys)).size === 3,
  );
  assert(Object.values(keys).every((key) => /^[a-f0-9]{64}$/u.test(key)));
  assert(typeof onMutationStart === "function");
  assert(
    isAbsolute(spoolDirectory) &&
      resolve(spoolDirectory) === spoolDirectory &&
      (await realpath(spoolDirectory)) === spoolDirectory,
  );
  const spool = await lstat(spoolDirectory);
  guard();
  assert(
    spool.isDirectory() &&
      !spool.isSymbolicLink() &&
      spool.uid === process.getuid?.() &&
      (spool.mode & 0o7777) === 0o700,
  );
  assert((await readdir(spoolDirectory)).length === 0);
  guard();
  validateSyntheticFoodFixtures();
  const fixture = syntheticFoodFixtures.find(
    (food) => food.name === "Blueberries (synthetic sample)",
  );
  assert(fixture && fixture.grams === "150" && fixture.amounts.energy === "60");
  const client = new MeilisearchHttpClient({
    host: "https://meili.internal:8443",
    apiKey: keys.worker,
    taskApiKey: keys.observer,
    requestTimeoutMs: 5000,
    fetch: http.meiliFetch,
  });
  // Keep admission, publication and rebuild on the same physical database connection.
  return database.connection().execute(async (owned) => {
    await observeOwnedDatabase(owned, target);
    guard();
    await assertDatabaseReady(owned, { requireRestoreAttestation: false });
    guard();
    const absent = await http.meiliFetch("https://meili.internal:8443/indexes/foods", {
      signal,
      headers: { authorization: `Bearer ${keys.worker}` },
    });
    assert(absent.status === 404 && (await absent.json()).code === "index_not_found");
    guard();
    for (const table of ["app_user", "food_source", "food", "nutrient"] as const) {
      assert((await owned.selectFrom(table).select("id").limit(1).execute()).length === 0);
      guard();
    }
    await onMutationStart();
    guard();
    await observeOwnedDatabase(owned, target);
    guard();
    const registry = await initializeSyntheticNutrientRegistry(owned);
    guard();
    const now = new Date();
    const published = await seedPromotedPublicFood(owned, { registry, fixture, now });
    guard();
    const projection = await pageFoodSearchProjection(owned, { limit: 50 });
    guard();
    assert(projection.nextCursor === null && projection.documents.length === 1);
    const food = projection.documents[0];
    assert(
      food &&
        food.foodId === published.foodId &&
        food.foodVersionId === published.foodVersionId &&
        food.name === fixture.name &&
        food.servings.length === 2,
    );
    const rebuilt = await rebuildFoodSearchNow({
      client,
      database: owned,
      batchSize: 1,
      spoolDirectory,
      spoolMaxBytes: 1_048_576,
      spoolMaxDocuments: 1,
      taskTimeoutMs: 30_000,
      signal,
    });
    guard();
    assert(
      rebuilt &&
        rebuilt.includedCount === 1 &&
        rebuilt.excludedCount === 0 &&
        rebuilt.cleanup.status === "completed",
    );
    await observeOwnedDatabase(owned, target);
    guard();
    return Object.freeze({
      kind: "nutrition-development-catalogue-v1",
      syntheticOnly: true,
      target,
      foodId: published.foodId,
      foodVersionId: published.foodVersionId,
      name: food.name,
      servings: food.servings,
      coreNutrients: [...registry.values()].map((row) => ({
        id: row.id,
        code: row.code,
        unit: row.canonical_unit,
      })),
      fixtureExpiresAt: new Date(now.getTime() + 12 * 3_600_000).toISOString(),
      projectionRevision: rebuilt.projectionRevision,
    });
  });
}

/** The independent restore drill does not attest or promote this original application database. */
export async function attestDevelopmentRuntimeSource(input: {
  readonly expectedTarget: DevelopmentDatabaseTarget;
  readonly caCertificate: string;
  readonly ownerEnvironment: NodeJS.ProcessEnv;
  readonly runtimeEnvironments: readonly [NodeJS.ProcessEnv, NodeJS.ProcessEnv];
  readonly notAfterUtc: string;
  readonly signal: AbortSignal;
}) {
  const target = targetSnapshot(input.expectedTarget),
    { signal } = input;
  const guard = leaseGuard(input.notAfterUtc, signal);
  const owner = Object.freeze({ ...input.ownerEnvironment });
  assert(
    typeof input.caCertificate === "string" && Buffer.byteLength(input.caCertificate) <= 65_536,
  );
  const certificate = new X509Certificate(input.caCertificate);
  const activeExtra = getCACertificates("extra");
  assert(
    certificate.ca &&
      activeExtra.length === 1 &&
      new X509Certificate(activeExtra[0] ?? "").fingerprint256 === certificate.fingerprint256,
  );
  assert(
    typeof process.env.NODE_EXTRA_CA_CERTS === "string" &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
  );
  const runtimes = input.runtimeEnvironments.map((environment) =>
    Object.freeze({ ...environment }),
  );
  guard();
  const source = new URL(owner.DATABASE_URL ?? "");
  assert(
    source.protocol === "postgresql:" &&
      source.hostname === "postgres" &&
      source.port === "5432" &&
      source.pathname === `/${target.databaseName}` &&
      !source.search &&
      !source.hash &&
      source.username === target.expectedOwner,
  );
  assert(
    owner.NODE_ENV === "development" &&
      owner.NOURISHING_API_PROFILE === "hosted-development" &&
      owner.DATABASE_SSL_MODE === "verify-full" &&
      owner.ERASURE_REPLAY_LEDGER_STORE === "azure" &&
      owner.ERASURE_REPLAY_LEDGER_RESTORE_MAX_CONCURRENCY === "1",
  );
  assert(runtimes.length === 2);
  const principals = new Set<string>();
  for (const environment of runtimes) {
    const url = new URL(environment.DATABASE_URL ?? "");
    assert(
      url.protocol === source.protocol &&
        url.host === source.host &&
        url.pathname === source.pathname &&
        !url.search &&
        !url.hash &&
        url.username !== target.expectedOwner &&
        url.username.length > 0,
    );
    assert(
      environment.NODE_ENV === "development" &&
        environment.NOURISHING_API_PROFILE === "hosted-development" &&
        environment.DATABASE_SSL_MODE === "verify-full" &&
        environment.NODE_EXTRA_CA_CERTS === owner.NODE_EXTRA_CA_CERTS &&
        environment.NODE_EXTRA_CA_CERTS === process.env.NODE_EXTRA_CA_CERTS &&
        environment.DATABASE_RESTORE_EPOCH === owner.DATABASE_RESTORE_EPOCH,
    );
    principals.add(url.username);
  }
  assert(principals.size === 2);
  const replay = await runErasureLedgerRestoreFromEnvironment(owner, {
    expectedTarget: target,
    signal,
  });
  guard();
  assert(
    replay.reconciled &&
      replay.attestation.databaseName === target.databaseName &&
      replay.attestation.databaseOid === target.databaseOid &&
      replay.attestation.restoreEpochHash ===
        createHash("sha256")
          .update(owner.DATABASE_RESTORE_EPOCH ?? "")
          .digest("hex"),
  );
  for (const environment of runtimes) {
    await runDatabaseReadinessProbeFromEnvironment(environment);
    guard();
  }
  return Object.freeze({
    kind: "nutrition-development-source-ready-v1",
    target,
    attestation: replay.attestation,
  });
}
