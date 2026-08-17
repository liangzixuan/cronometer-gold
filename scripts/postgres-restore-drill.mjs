import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_DATABASE = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_RESTORE_DATABASE = /^nutrition_restore_[a-z0-9_]{1,45}$/;
const SAFE_ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_ABSOLUTE_DIRECTORY = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const PROTECTED_DUMP_STORAGE = new Set(["encrypted_volume", "tmpfs"]);

export function parseRestoreDrillArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Restore drill arguments must be --name value pairs");
    }
    if (values.has(flag)) throw new Error(`Duplicate restore drill argument: ${flag}`);
    values.set(flag, value);
  }

  const allowed = new Set([
    "--container",
    "--dump-directory",
    "--dump-protection",
    "--source-db",
    "--target-db",
    "--user",
  ]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown restore drill argument: ${flag}`);
  }

  const container = required(values, "--container");
  const sourceDatabase = required(values, "--source-db");
  const targetDatabase = required(values, "--target-db");
  const user = values.get("--user") ?? "nutrition";
  const dumpDirectory = required(values, "--dump-directory");
  const dumpProtection = required(values, "--dump-protection");

  if (!SAFE_CONTAINER.test(container)) throw new Error("Invalid Docker container identifier");
  if (!SAFE_DATABASE.test(sourceDatabase)) throw new Error("Invalid source database name");
  if (!SAFE_RESTORE_DATABASE.test(targetDatabase)) {
    throw new Error("Restore target must be a bounded nutrition_restore_* database name");
  }
  if (sourceDatabase === targetDatabase) throw new Error("Source and restore target must differ");
  if (!SAFE_ROLE.test(user)) throw new Error("Invalid PostgreSQL role name");
  if (
    !SAFE_ABSOLUTE_DIRECTORY.test(dumpDirectory) ||
    dumpDirectory === "/tmp" ||
    dumpDirectory.startsWith("/tmp/") ||
    dumpDirectory.includes("/../")
  ) {
    throw new Error("Dump directory must be an explicit protected absolute directory");
  }
  if (!PROTECTED_DUMP_STORAGE.has(dumpProtection)) {
    throw new Error("Dump protection must be tmpfs or encrypted_volume");
  }

  return { container, dumpDirectory, dumpProtection, sourceDatabase, targetDatabase, user };
}

export function compareRestoreEvidence(source, target) {
  if (source.migrationLedger !== target.migrationLedger) {
    throw new Error("Restored migration ledger does not match the source");
  }
  if (source.unvalidatedConstraints !== "0" || target.unvalidatedConstraints !== "0") {
    throw new Error("Source or restore contains an unvalidated constraint");
  }
  if (source.tableCounts.size !== target.tableCounts.size) {
    throw new Error("Restored public-table set does not match the source");
  }
  for (const [table, sourceCount] of source.tableCounts) {
    const targetCount = target.tableCounts.get(table);
    if (targetCount !== sourceCount) {
      throw new Error(`Restored row count does not match for ${table}`);
    }
  }
}

export function runPostgresRestoreDrill(options, dependencies = {}) {
  const run = dependencies.run ?? runCommand;
  const startedAt = new Date();
  const dumpPath = `${options.dumpDirectory}/${options.targetDatabase}.dump`;
  const targetExists = psqlScalar(
    run,
    options,
    "postgres",
    [
      "select count(*) from pg_database where datname = current_setting('nutrition.restore_target')",
    ],
    ["PGOPTIONS", `-c nutrition.restore_target=${options.targetDatabase}`],
  );
  if (targetExists !== "0") {
    throw new Error(`Restore target ${options.targetDatabase} already exists`);
  }

  try {
    docker(run, options.container, [
      "pg_dump",
      "--username",
      options.user,
      "--dbname",
      options.sourceDatabase,
      "--format=custom",
      "--compress=9",
      "--no-owner",
      "--no-privileges",
      "--file",
      dumpPath,
    ]);
    const sha256 = docker(run, options.container, ["sha256sum", dumpPath]).trim().split(/\s+/u)[0];
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
      throw new Error("Backup artifact did not produce a SHA-256 digest");
    }

    docker(run, options.container, [
      "createdb",
      "--username",
      options.user,
      options.targetDatabase,
    ]);
    docker(run, options.container, [
      "pg_restore",
      "--username",
      options.user,
      "--dbname",
      options.targetDatabase,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      dumpPath,
    ]);

    const source = collectEvidence(run, options, options.sourceDatabase);
    const target = collectEvidence(run, options, options.targetDatabase);
    compareRestoreEvidence(source, target);

    return {
      artifactSha256: sha256,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      migrationCount: JSON.parse(source.migrationLedger).length,
      sourceDatabase: options.sourceDatabase,
      tableCount: source.tableCounts.size,
      targetDatabase: options.targetDatabase,
      totalRows: [...source.tableCounts.values()]
        .reduce((total, value) => total + BigInt(value), 0n)
        .toString(),
    };
  } finally {
    docker(run, options.container, ["rm", "--", dumpPath], { allowFailure: true });
  }
}

function collectEvidence(run, options, database) {
  const migrationLedger = psqlScalar(run, options, database, [
    "select coalesce(json_agg(row_to_json(m) order by m.name)::text, '[]')",
    "from (select name, checksum from app_schema_migration order by name) m",
  ]);
  const unvalidatedConstraints = psqlScalar(run, options, database, [
    "select count(*) from pg_constraint where not convalidated",
  ]);
  const tables = psqlScalar(run, options, database, [
    "select coalesce(string_agg(tablename, ',' order by tablename), '')",
    "from pg_tables where schemaname = 'public'",
  ]);
  const tableCounts = new Map();
  for (const table of tables === "" ? [] : tables.split(",")) {
    if (!SAFE_DATABASE.test(table)) throw new Error("Database returned an unsafe table name");
    tableCounts.set(
      table,
      psqlScalar(run, options, database, [`select count(*) from public."${table}"`]),
    );
  }
  return { migrationLedger, tableCounts, unvalidatedConstraints };
}

function psqlScalar(run, options, database, sqlParts, environmentPair) {
  const command = [
    "psql",
    "--username",
    options.user,
    "--dbname",
    database,
    "--tuples-only",
    "--no-align",
    "--command",
    sqlParts.join(" "),
  ];
  if (environmentPair) {
    command.unshift("env", `${environmentPair[0]}=${environmentPair[1]}`);
  }
  return docker(run, options.container, command).trim();
}

function docker(run, container, command, options = {}) {
  return run("docker", ["exec", container, ...command], options);
}

function runCommand(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const safeError = result.stderr.trim().split("\n")[0] || "command failed";
    throw new Error(`${command} exited ${result.status}: ${safeError}`);
  }
  return result.stdout;
}

function required(values, flag) {
  const value = values.get(flag);
  if (!value) throw new Error(`Missing required restore drill argument: ${flag}`);
  return value;
}

async function main() {
  const options = parseRestoreDrillArguments(process.argv.slice(2));
  const result = runPostgresRestoreDrill(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
