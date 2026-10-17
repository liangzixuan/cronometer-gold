import { randomBytes } from "node:crypto";
import { createDatabase } from "@nutrition-tracker/db";
import { sql } from "kysely";

type Client = ReturnType<typeof createDatabase>;
interface State {
  readonly database_name: string;
  readonly database_oid: string;
  readonly database_owner: string;
  readonly session_principal: string;
}
interface Ownership {
  readonly database_oid: string;
  readonly database_owner: string;
}
function oid(value: string) {
  return /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295;
}
async function connectionState(database: Client): Promise<State> {
  const result = await sql<State>`
    select pg_catalog.current_database() as database_name,
      database_row.oid::pg_catalog.text as database_oid,
      pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
      session_user as session_principal
    from pg_catalog.pg_database as database_row
    where database_row.datname = pg_catalog.current_database()
  `.execute(database);
  const state = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !state ||
    !oid(state.database_oid) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(state.database_name) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(state.database_owner) ||
    state.database_owner !== state.session_principal
  )
    throw new Error("Restore integration requires the local database owner identity");
  return state;
}
async function exists(database: Client, name: string) {
  const result = await sql<{ exists: boolean }>`select exists (
    select 1 from pg_catalog.pg_database where datname = ${name}
  ) as exists`.execute(database);
  if (result.rows.length !== 1 || typeof result.rows[0]?.exists !== "boolean")
    throw new Error("Restore integration database inventory is unavailable");
  return result.rows[0].exists;
}
async function ownership(database: Client, name: string): Promise<Ownership> {
  const result = await sql<Ownership>`select oid::pg_catalog.text as database_oid,
    pg_catalog.pg_get_userbyid(datdba) as database_owner
    from pg_catalog.pg_database where datname = ${name}`.execute(database);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !oid(row.database_oid) || !row.database_owner)
    throw new Error("Owned restore integration database identity is unavailable");
  return row;
}

async function dropOwnedDatabase(bootstrap: Client, name: string, bound: Ownership) {
  const current = await ownership(bootstrap, name);
  if (
    current.database_oid !== bound.database_oid ||
    current.database_owner !== bound.database_owner
  )
    throw new Error("Restore integration cleanup target changed");
  await sql`drop database ${sql.id(name)}`.execute(bootstrap);
  if (await exists(bootstrap, name))
    throw new Error("Restore integration cleanup left database residue");
}

/** Test-only: actual public migrations/readback need an isolated database, not a search-path schema. */
export async function withRestoreIntegrationDatabase<T>(
  connectionString: string,
  work: (
    input: Readonly<{
      database: Client;
      databaseUrl: string;
      identity: Readonly<{ databaseName: string; databaseOid: string }>;
    }>,
  ) => Promise<T>,
): Promise<T> {
  let source: URL;
  try {
    source = new URL(connectionString);
  } catch {
    throw new Error("Restore integration requires a literal loopback PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(source.protocol) ||
    !["127.0.0.1", "[::1]"].includes(source.hostname) ||
    source.search ||
    source.hash
  )
    throw new Error("Restore integration requires a literal loopback PostgreSQL URL");
  const name = `restore_replay_${randomBytes(12).toString("hex")}`;
  const bootstrap = createDatabase({ connectionString, maxConnections: 1 });
  const failures: unknown[] = [];
  let isolated: Client | undefined;
  let bound: Ownership | undefined;
  let creationAttempted = false;
  let result!: T;
  try {
    const initial = await connectionState(bootstrap);
    if (
      initial.database_name !== decodeURIComponent(source.pathname.slice(1)) ||
      initial.database_name === name
    )
      throw new Error("Restore integration bootstrap target does not match");
    if (await exists(bootstrap, name))
      throw new Error("Generated restore integration database already exists");
    creationAttempted = true;
    await sql`create database ${sql.id(name)} owner ${sql.id(initial.database_owner)} template template0`.execute(
      bootstrap,
    );
    const observed = await ownership(bootstrap, name);
    if (observed.database_owner !== initial.database_owner)
      throw new Error("Owned restore integration database owner does not match");
    bound = Object.freeze({ ...observed });
    const target = new URL(source);
    target.pathname = `/${name}`;
    target.searchParams.set("options", "-csearch_path=public");
    isolated = createDatabase({ connectionString: target.toString(), maxConnections: 4 });
    const connected = await connectionState(isolated);
    if (
      connected.database_name !== name ||
      connected.database_oid !== bound.database_oid ||
      connected.database_owner !== bound.database_owner
    )
      throw new Error("Restore integration connection target does not match");
    result = await work(
      Object.freeze({
        database: isolated,
        databaseUrl: target.toString(),
        identity: Object.freeze({ databaseName: name, databaseOid: bound.database_oid }),
      }),
    );
  } catch (error) {
    failures.push(error);
  } finally {
    let closed = isolated === undefined;
    if (isolated) {
      try {
        await isolated.destroy();
        closed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (bound && closed) {
      try {
        await dropOwnedDatabase(bootstrap, name, bound);
      } catch (error) {
        failures.push(error);
      }
    } else if (creationAttempted) {
      failures.push(new Error(`Restore integration database ${name} requires reconciliation`));
    }
    try {
      await bootstrap.destroy();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `Restore integration database ${name} or cleanup failed`);
  return result;
}
