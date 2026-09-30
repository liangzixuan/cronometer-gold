import { randomBytes } from "node:crypto";
import { mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  EncryptedPostgresBackupStore,
  FileRawArtifactStore,
} from "../packages/artifact-store/dist/index.js";
import {
  assertDatabaseRestoreReplayObservation,
  DatabaseRestoreReplayNotReadyError,
  normalizePostgresBackupConnection,
  openOwnedPostgresSession,
  postgresBackupLibpqEnvironment,
  postgresBackupPasswordFile,
} from "../packages/db/dist/index.js";
import { parsePostgresBackupEvidence } from "./postgres-backup-evidence.mjs";
import { ChildCleanupError, runTool, trustedPath } from "./postgres-operator-process.mjs";
import {
  AUTHORITY_POLICY_SQL,
  compareRestoreEvidence,
  RESTORE_TARGET_BOUNDARY_QUERIES,
  validateTargetDatabaseBoundary,
} from "./postgres-restore-drill.mjs";
import { preparePostgresRestoreEvidence } from "./postgres-restore-evidence-collector.mjs";

const ROLE = /^[a-z][a-z0-9_]{0,62}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const failed = (phase) => new Error("PostgreSQL local restore " + phase + " failed");
function requireValue(condition) {
  if (!condition) throw failed("configuration");
}
function roles(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 32);
  requireValue(value.every((name) => typeof name === "string" && ROLE.test(name)));
  requireValue(new Set(value).size === value.length);
  return Object.freeze([...value].sort());
}
function settings(input) {
  const allowed = [
    "expectedBackup",
    "expectedOwner",
    "keyRing",
    "artifactDirectory",
    "tmpfsRoot",
    "maintenanceConnection",
    "targetConnection",
    "targetDatabase",
    "connectAllowlist",
    "deniedRuntimePrincipals",
    "tools",
    "maxDumpBytes",
    "timeoutMs",
    "signal",
  ];
  requireValue(
    input && typeof input === "object" && Object.keys(input).every((key) => allowed.includes(key)),
  );
  requireValue(process.platform === "linux" && typeof process.getuid === "function");
  requireValue(typeof input.expectedOwner === "string" && ROLE.test(input.expectedOwner));
  requireValue(
    typeof input.targetDatabase === "string" &&
      /^nutrition_restore_[a-z0-9_]{1,45}$/u.test(input.targetDatabase),
  );
  const expected = input.expectedBackup;
  requireValue(
    expected &&
      Object.keys(expected).sort().join(",") ===
        "backupId,databaseName,deploymentTarget,manifestSha256,snapshotId,sourceRevision",
  );
  requireValue(typeof expected.databaseName === "string" && ROLE.test(expected.databaseName));
  requireValue(input.targetDatabase !== expected.databaseName);
  const maintenanceConnection = normalizePostgresBackupConnection(input.maintenanceConnection);
  const targetConnection = normalizePostgresBackupConnection(input.targetConnection);
  requireValue(
    targetConnection.database === input.targetDatabase &&
      maintenanceConnection.database !== input.targetDatabase,
  );
  for (const key of ["host", "port", "sslMode", "caCertificate"])
    requireValue(maintenanceConnection[key] === targetConnection[key]);
  const connectAllowlist = roles(input.connectAllowlist);
  const deniedRuntimePrincipals = roles(input.deniedRuntimePrincipals);
  requireValue(
    connectAllowlist.includes(maintenanceConnection.user) &&
      connectAllowlist.includes(targetConnection.user),
  );
  requireValue(
    deniedRuntimePrincipals.every(
      (name) => !connectAllowlist.includes(name) && name !== input.expectedOwner,
    ),
  );
  requireValue(
    Number.isSafeInteger(input.maxDumpBytes) &&
      input.maxDumpBytes >= 5 &&
      input.maxDumpBytes <= 2_147_483_648,
  );
  requireValue(
    Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= 1_800_000,
  );
  requireValue(input.signal === undefined || input.signal instanceof AbortSignal);
  requireValue(input.tools && Object.keys(input.tools).sort().join(",") === "pgRestore,psql");
  const tools = {};
  for (const name of ["pgRestore", "psql"]) {
    const tool = input.tools[name];
    requireValue(tool && Object.keys(tool).sort().join(",") === "path,sha256,version");
    requireValue(
      typeof tool.path === "string" && isAbsolute(tool.path) && resolve(tool.path) === tool.path,
    );
    requireValue(typeof tool.sha256 === "string" && SHA.test(tool.sha256));
    requireValue(
      typeof tool.version === "string" &&
        new RegExp(
          "^" + (name === "pgRestore" ? "pg_restore" : "psql") + " \\(PostgreSQL\\) 17\\.[0-9]+$",
          "u",
        ).test(tool.version),
    );
    tools[name] = Object.freeze({ ...tool });
  }
  requireValue(tools.pgRestore.version.split(" ").at(-1) === tools.psql.version.split(" ").at(-1));
  requireValue(
    input.keyRing?.purpose === "postgres_backup" &&
      input.keyRing.keys instanceof Map &&
      input.keyRing.keys.size >= 1 &&
      input.keyRing.keys.size <= 16,
  );
  const keys = new Map();
  for (const [id, bytes] of input.keyRing.keys) {
    requireValue(typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id));
    requireValue(bytes instanceof Uint8Array && bytes.byteLength === 32);
    keys.set(id, Buffer.from(bytes));
  }
  requireValue(keys.has(input.keyRing.currentKeyId));
  return Object.freeze({
    ...input,
    expectedBackup: Object.freeze({ ...expected }),
    maintenanceConnection,
    targetConnection,
    connectAllowlist,
    deniedRuntimePrincipals,
    tools: Object.freeze(tools),
    keyRing: { purpose: "postgres_backup", currentKeyId: input.keyRing.currentKeyId, keys },
  });
}
async function scalar(session, text, values = [], signal = session.signal) {
  const result = await session.query({ text, values, rowMode: "array", signal });
  const value = result.rows?.[0]?.[0];
  if (
    result.rows?.length !== 1 ||
    result.rows[0]?.length !== 1 ||
    typeof value !== "string" ||
    Buffer.byteLength(value) > 65_536
  )
    throw failed("database observation");
  return value;
}
async function command(session, text, signal = session.signal) {
  const result = await session.query({ text, values: [], rowMode: "array", signal });
  if (!Array.isArray(result.rows) || result.rows.length !== 0) throw failed("database command");
}
function parsed(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw failed("database observation");
  }
}
async function targetIdentity(session, name) {
  const value = parsed(
    await scalar(
      session,
      "select coalesce((select pg_catalog.json_build_object('name',datname,'oid',oid::text," +
        "'allowConnections',datallowconn) from pg_catalog.pg_database where datname=$1)::text,'null')",
      [name],
    ),
  );
  if (value === null) return null;
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "allowConnections,name,oid" ||
    value.name !== name ||
    typeof value.oid !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(value.oid) ||
    typeof value.allowConnections !== "boolean"
  )
    throw failed("database identity");
  return value;
}
async function boundary(session, options, oid, allowConnections) {
  const observed = await targetIdentity(session, options.targetDatabase);
  requireValue(observed?.oid === oid && observed.allowConnections === allowConnections);
  await scalar(session, "select pg_catalog.set_config('nutrition.restore_target',$1,false)", [
    options.targetDatabase,
  ]);
  const result = {};
  for (const [name, parts] of Object.entries(RESTORE_TARGET_BOUNDARY_QUERIES)) {
    const value = await scalar(session, parts.join(" "));
    result[name] = ["acl", "effectiveConnectRoles"].includes(name) ? parsed(value) : value;
  }
  requireValue(
    Array.isArray(result.acl) &&
      result.acl.length <= 256 &&
      result.acl.every(
        (row) =>
          row &&
          Object.keys(row).sort().join(",") === "grantable,grantee,grantor,privilege" &&
          ["grantee", "grantor", "privilege"].every(
            (key) => typeof row[key] === "string" && row[key].length <= 63,
          ) &&
          typeof row.grantable === "boolean",
      ),
  );
  requireValue(
    Array.isArray(result.effectiveConnectRoles) &&
      result.effectiveConnectRoles.length <= 32 &&
      result.effectiveConnectRoles.every((value) => typeof value === "string" && ROLE.test(value)),
  );
  validateTargetDatabaseBoundary(result, options);
  const denied = parsed(
    await scalar(
      session,
      "select pg_catalog.json_agg(pg_catalog.json_build_object('name',requested.name,'connect'," +
        "case when role_row.oid is null then null else pg_catalog.has_database_privilege(role_row.oid,$2,'CONNECT') end)" +
        " order by requested.name)::text from pg_catalog.unnest($1::text[]) requested(name)" +
        " left join pg_catalog.pg_roles role_row on role_row.rolname=requested.name",
      ["{" + options.deniedRuntimePrincipals.join(",") + "}", options.targetDatabase],
    ),
  );
  requireValue(
    Array.isArray(denied) &&
      denied.length === options.deniedRuntimePrincipals.length &&
      denied.every(
        (row, index) =>
          row &&
          Object.keys(row).sort().join(",") === "connect,name" &&
          row.name === options.deniedRuntimePrincipals[index] &&
          row.connect === false,
      ),
  );
}
async function targetEvidence(options, signal, epoch, oid) {
  const session = await openOwnedPostgresSession({
    connection: options.targetConnection,
    timeoutMs: options.timeoutMs,
    signal,
  });
  let primary, value;
  let primaryFailed = false;
  const cleanup = [];
  try {
    await command(session, 'set role "' + options.expectedOwner + '"');
    const collector = await preparePostgresRestoreEvidence(session.query, {
      expectedOwner: options.expectedOwner,
      signal: session.signal,
    });
    await command(session, "begin isolation level repeatable read read only");
    value = await collector.collect({ signal: session.signal });
    const identity = parsed(
      await scalar(
        session,
        "select pg_catalog.json_build_object('databaseName',pg_catalog.current_database()," +
          "'databaseOid',(select oid::text from pg_catalog.pg_database " +
          "where datname=pg_catalog.current_database()))::text",
      ),
    );
    requireValue(
      identity &&
        Object.keys(identity).sort().join(",") === "databaseName,databaseOid" &&
        identity.databaseName === options.targetDatabase &&
        identity.databaseOid === oid,
    );
    const rows = parsed(
      await scalar(
        session,
        "select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(" +
          "'restore_epoch_hash',restore_epoch_hash,'database_oid',database_oid,'database_name',database_name))::text,'[]')" +
          " from public.database_restore_attestation where singleton=true",
      ),
    );
    requireValue(
      Array.isArray(rows) &&
        rows.length <= 1 &&
        rows.every(
          (row) =>
            row &&
            Object.keys(row).sort().join(",") === "database_name,database_oid,restore_epoch_hash" &&
            typeof row.restore_epoch_hash === "string" &&
            SHA.test(row.restore_epoch_hash) &&
            typeof row.database_oid === "string" &&
            /^[1-9][0-9]{0,9}$/u.test(row.database_oid) &&
            typeof row.database_name === "string" &&
            ROLE.test(row.database_name),
        ),
    );
    let denied = false;
    try {
      assertDatabaseRestoreReplayObservation(
        { ...identity, attestation: rows[0] },
        { restoreEpoch: epoch },
      );
    } catch (error) {
      if (!(error instanceof DatabaseRestoreReplayNotReadyError)) throw error;
      denied = true;
    }
    requireValue(denied);
    session.signal.throwIfAborted();
  } catch {
    primaryFailed = true;
    primary = failed("target evidence/readiness");
  } finally {
    try {
      await command(session, "rollback", AbortSignal.timeout(5_000));
    } catch {
      cleanup.push(failed("target rollback"));
    }
    try {
      await session.close();
    } catch {
      cleanup.push(failed("target session cleanup"));
    }
  }
  if (primaryFailed && cleanup.length)
    throw new AggregateError(
      [primary, ...cleanup],
      "PostgreSQL target operation and cleanup failed",
    );
  if (primaryFailed) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, "PostgreSQL target cleanup failed");
  return value;
}

/**
 * Restores only a new, isolated local target. It does not replay the external
 * erasure ledger, write readiness attestation, grant runtime access, or cut over.
 */
export async function runPostgresRestore(input) {
  const options = settings(input);
  const controller = new AbortController();
  const cancel = () => controller.abort(failed("cancellation"));
  const timer = setTimeout(cancel, options.timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let directory, recovered, admin, identity, result;
  let created = false,
    creationAttempted = false,
    primaryFailed = false,
    primary;
  let phase = "setup";
  const cleanup = [];
  try {
    controller.signal.throwIfAborted();
    await trustedPath(options.tmpfsRoot, { directory: true, privateLeaf: true });
    requireValue(Number((await statfs(options.tmpfsRoot)).type) === 0x01021994);
    await trustedPath(options.artifactDirectory, { directory: true, privateLeaf: true });
    directory = await mkdtemp(join(options.tmpfsRoot, "nutrition-pg-restore-"));
    await trustedPath(directory, { directory: true, privateLeaf: true });
    phase = "authentication";
    const store = new EncryptedPostgresBackupStore({
      rawStore: new FileRawArtifactStore(options.artifactDirectory),
      keyRing: options.keyRing,
      temporaryDirectory: directory,
      maxDumpBytes: options.maxDumpBytes,
    });
    recovered = await store.recover({ ...options.expectedBackup, signal: controller.signal });
    requireValue(recovered);
    const sourceEvidence = parsePostgresBackupEvidence(
      recovered.sourceEvidence,
      options.expectedOwner,
    );
    const sourceEvidenceSha256 = recovered.manifest.sourceEvidenceSha256;
    const environment = postgresBackupLibpqEnvironment(options.targetConnection, directory);
    await writeFile(
      join(directory, "pgpass"),
      postgresBackupPasswordFile(options.targetConnection),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(join(directory, "root.crt"), options.targetConnection.caCertificate, {
      flag: "wx",
      mode: 0o600,
    });
    phase = "tools";
    for (const tool of Object.values(options.tools)) {
      const version = await runTool(tool, ["--version"], {
        signal: controller.signal,
        env: environment,
        directory,
        limit: 1024,
      });
      requireValue(version.text?.trim() === tool.version);
    }
    phase = "creation";
    admin = await openOwnedPostgresSession({
      connection: options.maintenanceConnection,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
    });
    requireValue((await targetIdentity(admin, options.targetDatabase)) === null);
    creationAttempted = true;
    await command(
      admin,
      'create database "' +
        options.targetDatabase +
        '" with template template0 owner "' +
        options.expectedOwner +
        '" allow_connections false',
    );
    created = true;
    identity = await targetIdentity(admin, options.targetDatabase);
    requireValue(identity && identity.allowConnections === false);
    await command(admin, 'revoke connect on database "' + options.targetDatabase + '" from public');
    phase = "initial fence";
    await boundary(admin, options, identity.oid, false);
    await command(admin, 'alter database "' + options.targetDatabase + '" allow_connections true');
    await boundary(admin, options, identity.oid, true);
    phase = "restore";
    await runTool(
      options.tools.pgRestore,
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--no-password",
        "--role=" + options.expectedOwner,
        "--dbname=" + options.targetDatabase,
      ],
      {
        signal: controller.signal,
        env: environment,
        directory,
        limit: 65_536,
        input: recovered.dump,
        inputBytes: recovered.manifest.dumpBytes,
      },
    );
    await recovered.dispose();
    recovered = undefined;
    await boundary(admin, options, identity.oid, true);
    phase = "authority policy";
    const policy = Buffer.from(
      'set role "' + options.expectedOwner + '";\n' + AUTHORITY_POLICY_SQL,
    );
    requireValue(policy.byteLength <= 1_048_576);
    await runTool(
      options.tools.psql,
      ["-X", "--no-password", "--set=ON_ERROR_STOP=1", "--file=-"],
      {
        signal: controller.signal,
        env: Object.freeze({
          ...environment,
          PGOPTIONS: "-c nutrition.expected_restore_owner=" + options.expectedOwner,
        }),
        directory,
        limit: 65_536,
        input: Readable.from([policy]),
        inputBytes: policy.byteLength,
      },
    );
    await boundary(admin, options, identity.oid, true);
    phase = "evidence";
    const restoreEpoch = randomBytes(32).toString("hex");
    const restored = await targetEvidence(options, controller.signal, restoreEpoch, identity.oid);
    compareRestoreEvidence(sourceEvidence, restored);
    phase = "final fence";
    await boundary(admin, options, identity.oid, true);
    controller.signal.throwIfAborted();
    result = Object.freeze({
      localOnly: true,
      status: "local-restore-verified",
      erasureReplayRequired: true,
      applicationTrafficBlocked: true,
      targetDatabase: options.targetDatabase,
      databaseOid: identity.oid,
      restoreEpoch,
      sourceRevision: options.expectedBackup.sourceRevision,
      manifestSha256: options.expectedBackup.manifestSha256,
      sourceEvidenceSha256,
    });
  } catch (error) {
    primaryFailed = true;
    primary = error instanceof ChildCleanupError ? error : failed(phase);
    if (error instanceof AggregateError && !(error instanceof ChildCleanupError))
      primary = new AggregateError(
        [failed(phase), failed("owned operation cleanup")],
        "PostgreSQL local restore operation and cleanup failed",
      );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (admin) {
      try {
        await admin.close();
      } catch {
        cleanup.push(failed("maintenance session cleanup"));
      }
    }
    if (recovered) {
      try {
        await recovered.dispose();
      } catch {
        cleanup.push(failed("authenticated spool cleanup"));
      }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: false });
      } catch {
        cleanup.push(failed("plaintext cleanup"));
      }
    }
    if ((primaryFailed || cleanup.length) && creationAttempted) {
      if (!created || !identity) cleanup.push(failed("target creation/fence outcome unknown"));
      else {
        let fence;
        try {
          fence = await openOwnedPostgresSession({
            connection: options.maintenanceConnection,
            timeoutMs: 15_000,
            signal: AbortSignal.timeout(15_000),
          });
          const current = await targetIdentity(fence, options.targetDatabase);
          requireValue(current?.oid === identity.oid);
          await command(
            fence,
            'alter database "' + options.targetDatabase + '" allow_connections false',
          );
          await boundary(fence, options, identity.oid, false);
        } catch {
          cleanup.push(failed("retained target fence"));
        } finally {
          if (fence) {
            try {
              await fence.close();
            } catch {
              cleanup.push(failed("fence session cleanup"));
            }
          }
        }
      }
    }
    for (const key of options.keyRing.keys.values()) key.fill(0);
  }
  const error =
    primaryFailed && cleanup.length
      ? new AggregateError(
          [primary, ...cleanup],
          "PostgreSQL local restore operation and cleanup failed",
        )
      : primaryFailed
        ? primary
        : cleanup.length
          ? new AggregateError(cleanup, "PostgreSQL local restore cleanup failed")
          : undefined;
  if (error) {
    error.phase = phase;
    error.targetOutcome = created ? "retained" : creationAttempted ? "unknown" : "not-created";
    throw error;
  }
  return result;
}
