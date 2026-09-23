import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sql } from "kysely";
import { createDatabase } from "../src/client.js";

type Client = ReturnType<typeof createDatabase>;
const MAX_STREAM_BYTES = 4 * 1024 ** 3;
const COMMAND_TIMEOUT_MS = 120_000;
const PIPE_TIMEOUT_MS = 10 * 60_000;
const SAFE_DATABASE = /^(?:paged_catalogue_[a-f0-9]{16}|nutrition_restore_paged_[a-f0-9]{16})$/u;
const SAFE_OWNER = /^[a-z][a-z0-9_]{0,62}$/u;

export function validatePagedRestoreFixtureTarget(container: string | undefined, database: string) {
  if (!container || !/^nourishing-adr0104-[a-z0-9][a-z0-9-]{0,80}$/u.test(container)) {
    throw new Error(
      "Paged restore requires the explicitly approved nourishing-adr0104-* container",
    );
  }
  if (!SAFE_DATABASE.test(database))
    throw new Error("Paged restore requires an owned scratch database");
  return container;
}

export function validatePagedFingerprintCommand(
  command: string,
  args: readonly string[],
  container: string,
  owner: string,
): string[] {
  if (
    !SAFE_OWNER.test(owner) ||
    command !== "docker" ||
    args[0] !== "exec" ||
    args[1] !== container
  ) {
    throw new Error("Fixed fingerprint requested an unexpected subprocess");
  }
  const psqlIndex =
    args[2] === "psql"
      ? 2
      : args[2] === "env" &&
          args[3] === `PGOPTIONS=-c nutrition.expected_restore_owner=${owner}` &&
          args[4] === "psql"
        ? 4
        : -1;
  if (psqlIndex < 0)
    throw new Error("Fixed fingerprint requested an unexpected PostgreSQL environment");
  const fixed = [...args];
  fixed.splice(psqlIndex + 1, 0, "-X", "--no-password", "--set", "ON_ERROR_STOP=1");
  return fixed;
}

interface FixedAuthorityResult {
  readonly evidence: unknown;
  readonly fingerprint: unknown;
  readonly sha256: string;
}
interface TableDigest {
  readonly table: string;
  readonly count: string;
  readonly bytes: number;
  readonly sha256: string;
}

// Read-only schema authority preflight; an exact mismatch may retain private diagnostics.
export async function collectPagedCatalogueSourceAuthority(input: {
  readonly source: Client;
  readonly sourceDatabaseUrl: string;
  readonly container: string | undefined;
  readonly evidenceDirectory: string;
}) {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.sourceDatabaseUrl);
  } catch {
    // Node's ERR_INVALID_URL retains the input, which can contain credentials.
    throw new Error("Paged restore requires a valid authenticated loopback fixture URL");
  }
  const sourceName = decodeURIComponent(sourceUrl.pathname.slice(1));
  const container = validatePagedRestoreFixtureTarget(input.container, sourceName);
  if (
    !["postgres:", "postgresql:"].includes(sourceUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(sourceUrl.hostname) ||
    !sourceUrl.username ||
    !sourceUrl.password ||
    sourceUrl.search ||
    sourceUrl.hash
  ) {
    throw new Error("Paged restore requires the authenticated loopback fixture URL");
  }
  const identity = (
    await sql<{ name: string; owner: string; principal: string }>`
    select d.datname as name, pg_catalog.pg_get_userbyid(d.datdba) as owner,
      session_user as principal from pg_catalog.pg_database d
      where d.datname=pg_catalog.current_database()
  `.execute(input.source)
  ).rows[0];
  if (
    !identity ||
    identity.name !== sourceName ||
    identity.owner !== identity.principal ||
    !SAFE_OWNER.test(identity.owner)
  )
    throw new Error("Paged restore source owner identity differs");
  const owner = identity.owner;
  const sourceAuthority = await collectFixedPagedAuthority(
    container,
    owner,
    sourceName,
    input.evidenceDirectory,
  );
  return { sourceAuthority, sourceName, owner, container };
}

async function collectFixedPagedAuthority(
  container: string,
  owner: string,
  database: string,
  evidenceDirectory?: string,
): Promise<FixedAuthorityResult> {
  const moduleUrl = new URL("../../../scripts/postgres-restore-drill.mjs", import.meta.url).href;
  const restoreModule: unknown = await import(moduleUrl);
  if (
    !restoreModule ||
    typeof restoreModule !== "object" ||
    !("collectAuthorityFingerprint" in restoreModule) ||
    typeof restoreModule.collectAuthorityFingerprint !== "function" ||
    !("retainRestoreAuthorityConstraintMismatch" in restoreModule) ||
    typeof restoreModule.retainRestoreAuthorityConstraintMismatch !== "function"
  ) {
    throw new Error("Fixed restore fingerprint verifier is unavailable");
  }
  const collect = restoreModule.collectAuthorityFingerprint as (
    run: typeof runFixedCommand,
    options: { container: string; user: string; expectedOwner: string },
    database: string,
  ) => FixedAuthorityResult;
  function runFixedCommand(command: string, args: string[]) {
    const fixedArgs = validatePagedFingerprintCommand(command, args, container, owner);
    const result = spawnSync(command, fixedArgs, {
      encoding: "utf8",
      maxBuffer: 10_000_000,
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0)
      throw new Error("Fixed PostgreSQL fingerprint command failed", { cause: result.error });
    return result.stdout;
  }
  const options = { container, user: owner, expectedOwner: owner };
  const retainMismatch = restoreModule.retainRestoreAuthorityConstraintMismatch as (
    operation: () => FixedAuthorityResult,
    directory: string,
  ) => Promise<FixedAuthorityResult>;
  if (evidenceDirectory === undefined) return collect(runFixedCommand, options, database);
  return retainMismatch(() => collect(runFixedCommand, options, database), evidenceDirectory);
}

// Only the opt-in harness calls this. It creates no engine and installs nothing.
export async function rehearsePagedCatalogueLogicalRestore(input: {
  readonly admin: Client;
  readonly source: Client;
  readonly sourceDatabaseUrl: string;
  readonly container: string | undefined;
  readonly evidenceDirectory: string;
}) {
  const { sourceAuthority, sourceName, owner, container } =
    await collectPagedCatalogueSourceAuthority(input);
  const restoredName = `nutrition_restore_paged_${randomBytes(8).toString("hex")}`;
  validatePagedRestoreFixtureTarget(container, restoredName);
  const sourceBefore = await digestTables(input.source, container, owner, sourceName);
  let restored: Client | undefined;
  let created = false;
  let result:
    | {
        readonly sourceDatabase: string;
        readonly restoredDatabase: string;
        readonly sourceAuthoritySha256: string;
        readonly restoredAuthoritySha256: string;
        readonly dumpBytes: number;
        readonly tables: readonly TableDigest[];
      }
    | undefined;
  return runPagedRestoreProofAfterCleanup(
    async () => {
      const collision = (
        await sql<{ exists: boolean }>`select exists(
      select 1 from pg_catalog.pg_database where datname=${restoredName}) as exists
    `.execute(input.admin)
      ).rows[0]?.exists;
      if (collision !== false) throw new Error("Restore scratch database collision");
      await sql`create database ${sql.id(restoredName)} owner ${sql.id(owner)} template template0 encoding 'UTF8'`.execute(
        input.admin,
      );
      created = true;
      await sql`revoke connect on database ${sql.id(restoredName)} from public`.execute(
        input.admin,
      );
      const dumpBytes = await copyLogicalDump(container, owner, sourceName, restoredName);
      const restoredUrl = new URL(input.sourceDatabaseUrl);
      restoredUrl.pathname = `/${restoredName}`;
      restored = createDatabase({
        connectionString: restoredUrl.toString(),
        maxConnections: 1,
        statementTimeoutMs: 120_000,
      });
      await sql`select pg_catalog.set_config('nutrition.expected_restore_owner',${owner},false)`.execute(
        restored,
      );
      const policy = await readFile(
        new URL("../restore/0014_catalogue_authority_policy.sql", import.meta.url),
        "utf8",
      );
      await sql.raw(policy).execute(restored);
      const restoredAuthority = await collectFixedPagedAuthority(container, owner, restoredName);
      const restoredRows = await digestTables(restored, container, owner, restoredName);
      const sourceAfter = await digestTables(input.source, container, owner, sourceName);
      if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter))
        throw new Error("Source catalogue changed during logical restore proof");
      if (JSON.stringify(sourceBefore) !== JSON.stringify(restoredRows))
        throw new Error("Logical restore changed retained catalogue rows or receipts");
      if (sourceAuthority.sha256 !== restoredAuthority.sha256)
        throw new Error("Restored fixed authority fingerprint differs from source");
      result = {
        sourceDatabase: sourceName,
        restoredDatabase: restoredName,
        sourceAuthoritySha256: sourceAuthority.sha256,
        restoredAuthoritySha256: restoredAuthority.sha256,
        dumpBytes,
        tables: restoredRows,
      };
      return result;
    },
    async () => {
      const cleanupFailures: unknown[] = [];
      if (restored)
        try {
          await restored.destroy();
        } catch (error) {
          cleanupFailures.push(error);
        }
      if (created)
        try {
          await sql`drop database ${sql.id(restoredName)}`.execute(input.admin);
        } catch (error) {
          cleanupFailures.push(error);
        }
      if (cleanupFailures.length)
        throw new AggregateError(cleanupFailures, "Paged logical restore owned cleanup failed");
    },
    async (completed) => {
      const file = await open(join(input.evidenceDirectory, "logical-restore.json"), "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(completed)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
    },
  );
}

/** A success proof is publishable only after all required owned cleanup succeeds. */
export async function runPagedRestoreProofAfterCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  publish: (result: T) => Promise<void>,
): Promise<T> {
  let outcome: { readonly value: T } | { readonly error: unknown };
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailure: { readonly error: unknown } | undefined;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = { error };
  }
  if ("error" in outcome || cleanupFailure)
    throw new AggregateError(
      [
        ...("error" in outcome ? [outcome.error] : []),
        ...(cleanupFailure ? [cleanupFailure.error] : []),
      ],
      "Paged logical restore or owned cleanup failed",
    );
  await publish(outcome.value);
  return outcome.value;
}

function psqlArgs(container: string, owner: string, database: string, command: string) {
  return [
    "exec",
    container,
    "psql",
    "-X",
    "--no-password",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    owner,
    "--dbname",
    database,
    "--no-align",
    "--tuples-only",
    "--command",
    command,
  ];
}

// attname is PostgreSQL name: cast each element to text so pg uses its text[]
// parser, then validate the boundary without changing primary-key ordinal order.
export async function readPagedRestoreTableInventory(client: Client) {
  const tables = (
    await sql<{ table_name: unknown; primary_columns: unknown }>`
    select c.relname as table_name, array(select a.attname::text
      from pg_catalog.pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,position)
      join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
      where i.indrelid=c.oid and i.indisprimary order by k.position) as primary_columns
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname
  `.execute(client)
  ).rows;
  if (tables.length < 10 || tables.length > 250)
    throw new Error("Unexpected restore table inventory");
  return tables.map((table) => {
    if (!table || typeof table !== "object" || !isRestoreIdentifier(table.table_name))
      throw new Error("Restore table inventory has an invalid identifier");
    const columns = table.primary_columns;
    if (
      !Array.isArray(columns) ||
      !columns.length ||
      columns.length > 16 ||
      !columns.every(isRestoreIdentifier) ||
      new Set(columns).size !== columns.length
    )
      throw new Error("Restore table requires bounded primary-key ordering");
    return { table_name: table.table_name, primary_columns: columns };
  });
}

function isRestoreIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 63 &&
    !value.includes("\0")
  );
}

async function digestTables(
  client: Client,
  container: string,
  owner: string,
  database: string,
): Promise<TableDigest[]> {
  const tables = await readPagedRestoreTableInventory(client);
  const results: TableDigest[] = [];
  for (const table of tables) {
    const count = (
      await sql<{
        count: string;
      }>`select count(*)::text as count from ${sql.id("public", table.table_name)}`.execute(client)
    ).rows[0]?.count;
    if (!count || !/^(0|[1-9][0-9]*)$/u.test(count))
      throw new Error("Restore table count is invalid");
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const command = `COPY (SELECT row_to_json(t)::text FROM public.${quote(table.table_name)} AS t ORDER BY ${table.primary_columns.map(quote).join(",")}) TO STDOUT`;
    const child = spawn("docker", psqlArgs(container, owner, database, command), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    const complete = exited(child, "row fingerprint");
    // Attach immediately while stdout is consumed; the later await still reports
    // a failed subprocess without an intervening unhandled rejection.
    void complete.catch(() => {});
    drainBounded(child.stderr, child, 64 * 1024);
    const hash = createHash("sha256");
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    try {
      for await (const raw of child.stdout) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > MAX_STREAM_BYTES)
          throw new Error("Restore row fingerprint exceeds fixed synthetic stream budget");
        hash.update(chunk);
      }
      await complete;
    } catch (error) {
      child.kill("SIGKILL");
      await complete.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    results.push({ table: table.table_name, count, bytes, sha256: hash.digest("hex") });
  }
  return results;
}

async function copyLogicalDump(container: string, owner: string, source: string, target: string) {
  const dump = spawn(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "--no-password",
      "--no-owner",
      "--no-privileges",
      "--username",
      owner,
      "--dbname",
      source,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const restore = spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "--no-password",
      "--set",
      "ON_ERROR_STOP=1",
      "--username",
      owner,
      "--dbname",
      target,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  dump.stdin.end();
  drainBounded(dump.stderr, dump, 64 * 1024);
  drainBounded(restore.stderr, restore, 64 * 1024);
  drainBounded(restore.stdout, restore, 4 * 1024 * 1024);
  const dumpComplete = exited(dump, "logical dump"),
    restoreComplete = exited(restore, "logical restore");
  let bytes = 0;
  const budget = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(
        bytes > MAX_STREAM_BYTES
          ? new Error("Logical dump exceeds fixed synthetic stream budget")
          : null,
        chunk,
      );
    },
  });
  const transfer = pipeline(dump.stdout, budget, restore.stdin);
  const timer = setTimeout(() => {
    dump.kill("SIGKILL");
    restore.kill("SIGKILL");
  }, PIPE_TIMEOUT_MS);
  try {
    await Promise.all([transfer, dumpComplete, restoreComplete]);
  } catch (error) {
    dump.kill("SIGKILL");
    restore.kill("SIGKILL");
    await Promise.allSettled([transfer, dumpComplete, restoreComplete]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return bytes;
}

function drainBounded(
  stream: NodeJS.ReadableStream,
  child: ChildProcessWithoutNullStreams,
  maximum: number,
) {
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maximum) child.kill("SIGKILL");
  });
}
function exited(child: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(`Owned ${label} subprocess could not start`)));
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Owned ${label} subprocess failed (${code ?? signal ?? "unknown"})`)),
    );
  });
}
