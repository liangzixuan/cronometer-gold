/** Finite prepared-host pilot. Native execution requires its separate finite operational scope. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { createDatabase, normalizePostgresBackupConnection } from "../packages/db/dist/index.js";
import {
  admitRuntimeClientAccess,
  admitRuntimeClientCertificate,
  runtimeClientDeadline,
} from "./azure-development-runtime-client.mjs";
import { admitDevelopmentRuntimeConfiguration } from "./azure-development-runtime-configuration.mjs";
import { applyDevelopmentRuntimeDatabaseGrants } from "./azure-development-runtime-database.mts";
import { openRuntimeDocker } from "./azure-development-runtime-docker.mjs";
import { openPreparedDevelopmentHost } from "./azure-development-runtime-host.mjs";
import { createDevelopmentRuntimeHttp } from "./azure-development-runtime-http.mjs";
import { admitRuntimeImageObservations } from "./azure-development-runtime-images.mjs";
import { createRuntimeLease, openRuntimeJournal } from "./azure-development-runtime-journal.mjs";
import {
  attestDevelopmentRuntimeSource,
  seedDevelopmentRuntimeCatalogue,
} from "./azure-development-runtime-maintenance.mts";
import { openRuntimePreparedInputs } from "./azure-development-runtime-prepared.mjs";
import {
  initializeDevelopmentRuntimeJourney,
  readBackDevelopmentRuntimeJourney,
} from "./azure-development-runtime-probe.mjs";
import { openPreparedRuntimeSupervisor } from "./azure-development-runtime-supervision.mjs";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { runTool, trustedPath } from "./postgres-operator-process.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url))),
  hash = (value) => createHash("sha256").update(value).digest("hex"),
  exact = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b)),
  keys = (value, names) => exact(Object.keys(value).sort(), [...names].sort()),
  digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
  uuid = (value) =>
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value),
  failure = () =>
    new Error("Development runtime failed; retained resources or evidence may remain uncertain");
const require = createRequire(new URL("../packages/db/package.json", import.meta.url)),
  { sql } = require("kysely");
const cleanEnvironment = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
function invocation(args) {
  assert(
    args.length === 5 &&
      args[0] === "run" &&
      args[1] === "--input" &&
      args[3] === "--input-sha256" &&
      isAbsolute(args[2]) &&
      resolve(args[2]) === args[2] &&
      digest(args[4]),
  );
  return { path: args[2], sha256: args[4] };
}
function processToken(raw) {
  assert(typeof raw === "string" && raw.length <= 8192 && raw.startsWith(`${process.pid} (`));
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  assert(fields.length >= 20 && /^[1-9][0-9]{0,24}$/u.test(fields[19]));
  return fields[19];
}
function manifest(value) {
  keys(value, [
    "schemaVersion",
    "kind",
    "owner",
    "project",
    "root",
    "sourceRevision",
    "notAfterUtc",
    "holdSeconds",
    "clientAccess",
    "tools",
    "images",
    "files",
    "database",
    "mail",
    "journey",
    "host",
    "supervisor",
    "recovery",
  ]);
  assert(
    value.schemaVersion === 1 &&
      value.kind === "nutrition-development-runtime-input-v1" &&
      uuid(value.owner) &&
      value.project === `nourishing-development-${value.owner}` &&
      /^[a-f0-9]{40}$/u.test(value.sourceRevision),
  );
  assert(
    isAbsolute(value.root) &&
      resolve(value.root) === value.root &&
      value.root !== "/" &&
      Number.isSafeInteger(value.holdSeconds) &&
      value.holdSeconds >= 0 &&
      value.holdSeconds <= 900,
  );
  admitRuntimeClientAccess(value.clientAccess);
  if (value.clientAccess) assert(value.holdSeconds === 0);
  keys(value.tools, [
    "node",
    "git",
    "docker",
    "python",
    "busctl",
    "lsblk",
    "findmnt",
    "getent",
    "ip",
    "iptables",
    "realpath",
  ]);
  for (const tool of Object.values(value.tools)) {
    keys(tool, ["path", "sha256"]);
    assert(isAbsolute(tool.path) && resolve(tool.path) === tool.path && digest(tool.sha256));
  }
  assert(
    value.tools.node.path === process.execPath &&
      uuid(value.host.bootId) &&
      /^[a-f0-9]{32}$/u.test(value.host.machineId),
  );
  keys(value.supervisor, ["runtimeSeconds"]);
  assert(Number.isSafeInteger(value.supervisor.runtimeSeconds));
  keys(value.recovery, ["path", "sha256"]);
  assert(
    value.recovery.path === join(value.root, "recovery/settings.json") &&
      digest(value.recovery.sha256),
  );
  keys(value.host, [
    "bootId",
    "machineId",
    "qualification",
    "encryptedVolume",
    "dockerRoot",
    "dockerId",
  ]);
}

/** Raw native/file/HTTP boundaries may be controlled. No replaceable whole-phase operations. */
export async function runPreparedDevelopmentRuntime(args, execution = {}) {
  const cli = invocation(args),
    execute = execution.execute ?? runTool,
    readSystem = execution.readSystem ?? readFile,
    cancellation = execution.signal ?? new AbortController().signal;
  assert(cancellation instanceof AbortSignal);
  let held,
    prepared,
    journal,
    supervisor,
    host,
    driver,
    database,
    recoveryHeld,
    result,
    primary,
    created = false,
    evidenceIncomplete = false;
  const generated = [],
    closers = [];
  let admitted,
    input,
    lease,
    networks = {},
    containers = {};
  const startedAtUtc = new Date().toISOString(),
    monotonicStartNs = process.hrtime.bigint().toString();
  const conserve = async ({ cleanup = false } = {}) => {
    if (cleanup) lease.guardCleanup();
    else lease.guard();
    assert(
      (await readSystem("/proc/sys/kernel/random/boot_id", "utf8")).trim() === input.host.bootId,
    );
    try {
      (await held.conserve()).fill(0);
      if (prepared) await prepared.conserve();
      if (recoveryHeld) (await recoveryHeld.conserve()).fill(0);
      for (const file of generated) (await file.conserve()).fill(0);
    } catch (error) {
      if (!cleanup) throw error;
      evidenceIncomplete = true;
    }
    if (cleanup) lease.guardCleanup();
    else lease.guard();
  };
  const publish = async (event) => journal.publish(event);
  let observations = [];
  const flushObservations = async () => {
    if (!observations.length) return;
    const events = observations;
    await publish({ phase: "runtime-read-only-observations", events });
    observations = [];
  };
  const observeEvent = async (event) => {
    assert(
      Buffer.byteLength(
        canonicalJson({ phase: "runtime-read-only-observations", events: [event] }),
      ) <= 786_432,
    );
    if (
      Buffer.byteLength(
        canonicalJson({
          phase: "runtime-read-only-observations",
          events: [...observations, event],
        }),
      ) > 786_432
    )
      await flushObservations();
    observations.push(event);
  };
  const observeReadOnly = async (operation) => {
    let value,
      operationError,
      failed = false;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
      failed = true;
    }
    try {
      await flushObservations();
    } catch (error) {
      if (failed)
        throw new AggregateError(
          [operationError, error],
          "Runtime observation and evidence publication failed",
        );
      throw error;
    }
    if (failed) throw operationError;
    return value;
  };
  const command = async (
    phase,
    tool,
    argv,
    { milliseconds = 30_000, env = cleanEnvironment } = {},
  ) => {
    await conserve();
    const began = new Date().toISOString(),
      stderr = [];
    let count = 0,
      raw;
    try {
      raw = await execute(tool, argv, {
        env,
        directory: SOURCE,
        limit: 262_144,
        signal: AbortSignal.any([
          lease.workSignal,
          AbortSignal.timeout(lease.remaining(milliseconds)),
        ]),
        onStderr: (chunk) => {
          assert(Buffer.isBuffer(chunk));
          count += chunk.length;
          assert(count <= 65_536);
          stderr.push(Buffer.from(chunk));
        },
      });
      assert(
        typeof raw.text === "string" &&
          Buffer.byteLength(raw.text) === raw.bytes &&
          raw.bytes <= 262_144 &&
          hash(raw.text) === raw.sha256 &&
          raw.stderrBytes === count &&
          raw.stderrSha256 === hash(Buffer.concat(stderr)),
      );
      await conserve();
      await publish({
        phase,
        command: argv,
        startedAtUtc: began,
        endedAtUtc: new Date().toISOString(),
        completed: true,
        stdout: raw.text,
        stdoutSha256: raw.sha256,
        stderr: Buffer.concat(stderr).toString("base64"),
        stderrSha256: raw.stderrSha256,
      });
      return raw.text;
    } catch (error) {
      try {
        await publish({
          phase: "runtime-command-unconfirmed",
          attemptedPhase: phase,
          command: argv,
          startedAtUtc: began,
          endedAtUtc: new Date().toISOString(),
          completed: false,
          stderr: Buffer.concat(stderr).toString("base64"),
          ...(typeof raw?.text === "string" && Buffer.byteLength(raw.text) <= 262_144
            ? { stdout: raw.text, stdoutSha256: hash(raw.text) }
            : {}),
        });
      } catch {}
      throw error;
    }
  };
  const source = async () => {
    assert(
      (await command("source-head", input.tools.git, [
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "HEAD",
      ])) === `${input.sourceRevision}\n`,
    );
    assert(
      (await command("source-clean", input.tools.git, [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])) === "",
    );
  };
  const phaseGuard = async () => {
    await conserve();
    await source();
    await observeReadOnly(() => supervisor.conserve());
    await observeReadOnly(() =>
      host.conserve({ createdNetworks: networks, createdContainers: containers }),
    );
    await conserve();
  };
  const boundedEnd = (maximum) => new Date(Date.now() + lease.remaining(maximum)).toISOString();
  const mutation = (phase) => async () => {
    await conserve();
    await publish({ phase, target: admitted?.target ?? null });
  };
  const createPrivate = async (name, value) => {
    await conserve();
    const path = join(input.root, "recovery", name),
      bytes = Buffer.from(JSON.stringify(value));
    assert(bytes.length <= 262_144);
    await trustedPath(join(input.root, "recovery"), { directory: true, privateLeaf: true });
    const directory = await open(
      join(input.root, "recovery"),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let fd;
    try {
      fd = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await fd.writeFile(bytes);
      await fd.sync();
      await fd.close();
      fd = undefined;
      await directory.sync();
    } finally {
      if (fd) await fd.close();
      await directory.close();
    }
    const ref = { path, sha256: hash(bytes) };
    bytes.fill(0);
    const holder = await heldOperatorInput(path, ref.sha256, {
      privateFile: true,
      maximum: 262_144,
    });
    generated.push(holder);
    await publish({ phase: "recovery-input-created", reference: ref });
    await conserve();
    return ref;
  };
  try {
    held = await heldOperatorInput(cli.path, cli.sha256, { privateFile: true, maximum: 2_097_152 });
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held.raw));
    assert(Buffer.from(`${canonicalJson(input)}\n`).equals(held.raw));
    manifest(input);
    const clientAccess = admitRuntimeClientAccess(input.clientAccess);
    const apiDeadlineNs = runtimeClientDeadline(clientAccess, {
      startedAtUtc,
      monotonicStartNs,
      notAfterUtc: input.notAfterUtc,
    });
    lease = createRuntimeLease(input.notAfterUtc, cancellation);
    prepared = await openRuntimePreparedInputs(
      { root: input.root, files: input.files, clientAccess, signal: lease.workSignal },
      execution.prepared,
    );
    if (clientAccess) {
      assert(Date.now() < Date.parse(clientAccess.notAfterUtc) - 30_000);
      admitRuntimeClientCertificate(await prepared.text("pki/client.crt"), clientAccess);
    }
    journal = await openRuntimeJournal(join(input.root, "journal"));
    await publish({
      phase: "admitted",
      inputSha256: cli.sha256,
      sourceRevision: input.sourceRevision,
      startedAtUtc,
      monotonicStartNs,
      notAfterUtc: input.notAfterUtc,
      bootId: input.host.bootId,
      controllerPid: process.pid,
      controllerStartToken: processToken(await readSystem(`/proc/${process.pid}/stat`, "utf8")),
    });
    await source();
    assert((await command("node-version", input.tools.node, ["--version"])) === "v22.23.2\n");
    await observeReadOnly(async () => {
      supervisor = await openPreparedRuntimeSupervisor(
        {
          owner: input.owner,
          root: input.root,
          inputPath: cli.path,
          inputSha256: cli.sha256,
          nodePath: input.tools.node.path,
          controllerUid: process.getuid(),
          controllerGid: process.getgid(),
          runtimeSeconds: input.supervisor.runtimeSeconds,
          notAfterUtc: input.notAfterUtc,
          startedAtUtc,
          monotonicStartNs,
          busctl: input.tools.busctl,
          signal: lease.workSignal,
          onObservation: observeEvent,
        },
        { ...execution.supervision, execute, readSystem },
      );
      return supervisor;
    });
    // Reserve ordinary shutdown before fallback, and preserve the original further hard-loss reserve.
    const baseLease = lease,
      fallbackWorkNs = BigInt(supervisor.deadlineMonotonicUs - 1_800_000_000) * 1000n,
      originalWorkNs =
        BigInt(monotonicStartNs) +
        BigInt(Date.parse(input.notAfterUtc) - Date.parse(startedAtUtc) - 3_600_000) * 1_000_000n,
      workDeadlineNs = fallbackWorkNs < originalWorkNs ? fallbackWorkNs : originalWorkNs;
    if (clientAccess) assert(BigInt(apiDeadlineNs) + 15_000_000_000n <= workDeadlineNs);
    const budget = Math.floor(Number((workDeadlineNs - process.hrtime.bigint()) / 1_000_000n));
    assert(budget >= 60_000);
    const workSignal = AbortSignal.any([baseLease.workSignal, AbortSignal.timeout(budget)]);
    lease = Object.freeze({
      ...baseLease,
      workSignal,
      remaining(maximum, cleanup = false) {
        if (cleanup) return baseLease.remaining(maximum, true);
        workSignal.throwIfAborted();
        const value = Math.min(
          baseLease.remaining(maximum),
          Math.floor(Number((workDeadlineNs - process.hrtime.bigint()) / 1_000_000n)),
        );
        assert(value > 0);
        return value;
      },
      guard() {
        workSignal.throwIfAborted();
        assert(process.hrtime.bigint() < workDeadlineNs);
        baseLease.guard();
      },
    });
    const images = await admitRuntimeImageObservations(
      {
        images: input.images,
        sourceRevision: input.sourceRevision,
        root: input.root,
        tools: { docker: input.tools.docker, python: input.tools.python },
        signal: lease.workSignal,
        conserve,
        onObservation: publish,
      },
      { execute },
    );
    const driverJournal = {
      conserve: () => journal.conserve(),
      publish: async (event) => {
        const record = await publish(event);
        if (event.phase === "created") {
          networks = Object.fromEntries(
            Object.entries(event.networks).map(([name, row]) => [name, row.Id]),
          );
          containers = Object.fromEntries(
            Object.entries(event.containers).map(([name, row]) => [name, row.id]),
          );
          created = true;
        }
        return record;
      },
    };
    driver = await openRuntimeDocker(
      {
        project: input.project,
        owner: input.owner,
        revision: input.sourceRevision,
        root: input.root,
        dockerConfig: join(input.root, "docker-config"),
        images: input.images,
        docker: input.tools.docker,
        imageObservations: images.imageObservations,
        clientAccess,
        apiDeadlineNs,
        lease,
        journal: driverJournal,
        conserve,
      },
      execute,
    );
    const ca = await prepared.text("pki/ca.crt"),
      ownerEnvironment = parseEnv(await prepared.text("config/maintenance.env"));
    const config = admitDevelopmentRuntimeConfiguration({
      model: driver.model,
      database: input.database,
      ownerEnvironment,
      caCertificate: ca,
      sourceRevision: input.sourceRevision,
      root: input.root,
      notAfterUtc: input.notAfterUtc,
      databaseBootstrap: await prepared.text("config/database-bootstrap.sql"),
      mail: input.mail,
    });
    recoveryHeld = await heldOperatorInput(input.recovery.path, input.recovery.sha256, {
      privateFile: true,
      maximum: 262_144,
    });
    const recovery = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recoveryHeld.raw));
    assert(Buffer.from(`${canonicalJson(recovery)}\n`).equals(recoveryHeld.raw));
    keys(recovery, ["assemblyInput", "policySha256", "assemblySha256", "backup", "restore"]);
    assert(
      digest(recovery.policySha256) &&
        digest(recovery.assemblySha256) &&
        recovery.assemblyInput.path === join(input.root, "recovery/assembly-input.json") &&
        digest(recovery.assemblyInput.sha256),
    );
    const backup = {
        ...recovery.backup,
        expectedOwner: input.database.owner,
        sourceRevision: input.sourceRevision,
        deploymentTarget: "development",
        backupId: input.owner,
        tmpfsRoot: join(input.root, "tmpfs"),
      },
      restore = {
        ...recovery.restore,
        expectedOwner: input.database.owner,
        tmpfsRoot: join(input.root, "tmpfs"),
        targetDatabase: `nutrition_restore_${input.owner.replaceAll("-", "")}`,
      };
    const sourceConnection = normalizePostgresBackupConnection(backup.connection);
    assert(
      backup.connection.connectionString === ownerEnvironment.DATABASE_URL &&
        backup.connection.sslMode === "verify-full" &&
        backup.connection.caCertificate === ca &&
        sourceConnection.database === input.database.databaseName &&
        sourceConnection.user === input.database.owner,
    );
    for (const [name, expectedDatabase] of [
      ["maintenanceConnection", "postgres"],
      ["targetConnection", restore.targetDatabase],
    ]) {
      const connection = normalizePostgresBackupConnection(restore[name]);
      assert(
        connection.host === sourceConnection.host &&
          connection.port === sourceConnection.port &&
          connection.user === sourceConnection.user &&
          connection.password === sourceConnection.password &&
          connection.database === expectedDatabase &&
          restore[name].sslMode === "verify-full" &&
          restore[name].caCertificate === ca,
      );
    }
    exact(restore.connectAllowlist, [input.database.owner]);
    exact(
      [...restore.deniedRuntimePrincipals].sort(),
      [input.database.api, input.database.worker].sort(),
    );
    exact(backup.keyRing, restore.keyRing);
    assert(
      backup.storage?.kind === "azure-blob" &&
        restore.storage?.kind === "azure-blob" &&
        backup.storage.containerUrl === restore.storage.containerUrl &&
        backup.storage.prefix === restore.storage.prefix,
    );
    assert(
      restore.erasureReplay?.kind === "azure-blob" &&
        restore.erasureReplay.containerUrl ===
          ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL &&
        restore.erasureReplay.prefix === ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_PREFIX &&
        restore.erasureReplay.sasToken === ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS,
    );
    exact(restore.erasureReplay.encryptionKeyRing, {
      currentKeyId: ownerEnvironment.ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID,
      keys: JSON.parse(ownerEnvironment.ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS),
    });
    exact(restore.erasureReplay.locatorKeyRing, {
      currentKeyId: ownerEnvironment.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
      keys: JSON.parse(ownerEnvironment.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS),
    });
    const azureHosts = [
      ...new Set(
        [
          driver.model.services.api.environment.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
          ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
          backup.storage.containerUrl,
        ].map((value) => new URL(value).hostname),
      ),
    ].sort();
    await observeReadOnly(async () => {
      host = await openPreparedDevelopmentHost(
        {
          ...input.host,
          ...Object.fromEntries(
            ["node", "docker", "lsblk", "findmnt", "getent", "ip", "iptables", "realpath"].map(
              (name) => [name, input.tools[name]],
            ),
          ),
          root: input.root,
          sourceRevision: input.sourceRevision,
          owner: input.owner,
          notAfterUtc: input.notAfterUtc,
          azureHosts,
          clientAccess,
          signal: lease.workSignal,
          conserve,
          onObservation: observeEvent,
        },
        { ...execution.host, execute, readSystem },
      );
      return host;
    });
    await phaseGuard();
    await driver.create();
    await phaseGuard();
    const healthy = async (name) => {
      const end = Date.now() + lease.remaining(180_000);
      while (true) {
        await conserve();
        const row = (await driver.observe([name]))[name];
        assert(row.status === "running" && !row.oomKilled);
        if (row.healthy) return;
        assert(Date.now() < end);
        await delay(1000, undefined, { signal: lease.workSignal });
      }
    };
    const oneShot = async (name, milliseconds = 180_000) => {
      await phaseGuard();
      await driver.start(name);
      return (await driver.waitForExit(name, lease.remaining(milliseconds))).text;
    };
    for (const name of ["postgres", "meilisearch", "internal-tls"]) {
      await phaseGuard();
      await driver.start(name);
      await healthy(name);
    }
    await phaseGuard();
    await driver.start("capture");
    await oneShot("migrate");
    const secondMigration = await oneShot("migrate");
    assert(secondMigration.endsWith("Database is current; no migrations applied.\n"));
    await phaseGuard();
    database = createDatabase({
      connectionString: ownerEnvironment.DATABASE_URL,
      applicationName: "nourishing-development-controller",
      maxConnections: 1,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 15_000,
      ssl: { ca, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    const observed =
      await sql`select current_database() as "databaseName",d.oid::text as "databaseOid",pg_get_userbyid(d.datdba) as owner,current_user as principal,current_schema() as schema,s.ssl as tls,s.version as "tlsVersion" from pg_database d join pg_stat_ssl s on s.pid=pg_backend_pid() where d.datname=current_database()`.execute(
        database,
      );
    assert(observed.rows.length === 1);
    const row = observed.rows[0];
    assert(
      row.databaseName === input.database.databaseName &&
        row.owner === input.database.owner &&
        row.principal === input.database.owner &&
        row.schema === "public" &&
        row.tls === true &&
        ["TLSv1.2", "TLSv1.3"].includes(row.tlsVersion) &&
        /^[1-9][0-9]{0,9}$/u.test(row.databaseOid),
    );
    admitted = {
      target: {
        databaseName: row.databaseName,
        databaseOid: row.databaseOid,
        expectedOwner: row.owner,
      },
    };
    await publish({ phase: "database-target-bound", target: admitted.target });
    const canary = (await oneShot("azure-canary", 120_000))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert(
      canary.length === 2 &&
        canary[0].event === "azure_object_storage.credentials.started" &&
        canary[1].event === "azure_object_storage.credentials.attested" &&
        canary[0].canaryId === canary[1].canaryId &&
        canary[1].exportCleanupVerified === true &&
        canary[1].ledgerCanaryRetained === true &&
        canary[1].ledgerVersionVerified === true,
    );
    assert((await oneShot("search-bootstrap")).trim() === "");
    const transport = (maximum) =>
      createDevelopmentRuntimeHttp(
        {
          ca,
          addresses: { api: "172.28.0.5", capture: "172.29.0.2", meili: "172.28.0.4" },
          notAfterUtc: boundedEnd(maximum),
          signal: lease.workSignal,
          assertOwnership: async (channel, address, signal) => {
            signal.throwIfAborted();
            const names =
                channel === "api"
                  ? ["api"]
                  : channel === "capture"
                    ? ["capture"]
                    : ["internal-tls", "meilisearch"],
              rows = await driver.observe(names, signal);
            signal.throwIfAborted();
            for (const name of names)
              assert(rows[name].status === "running" && !rows[name].oomKilled);
            assert(
              address ===
                { api: "172.28.0.5", capture: "172.29.0.2", meili: "172.28.0.4" }[channel],
            );
          },
        },
        execution.http,
      );
    await phaseGuard();
    const maintenanceSpool = join(input.root, "data/erasure-replay-spool");
    const catalogue = await seedDevelopmentRuntimeCatalogue({
      database,
      expectedTarget: admitted.target,
      searchKeys: config.keys,
      http: transport(600_000),
      spoolDirectory: maintenanceSpool,
      notAfterUtc: boundedEnd(600_000),
      signal: lease.workSignal,
      onMutationStart: mutation("catalogue-seed-intent"),
    });
    assert((await readdir(maintenanceSpool)).length === 0);
    await publish({ phase: "catalogue-ready", catalogue });
    await phaseGuard();
    const assemblyScript = join(SOURCE, "infra/development/azure/storage-recovery-assembly.py"),
      bundlePath = join(input.root, "recovery/assembly.json"),
      assemblyEnd = input.notAfterUtc,
      now = new Date().toISOString();
    assert(
      (await command("assembly-source", input.tools.python, [
        "-I",
        "-B",
        assemblyScript,
        "source-digest",
      ])) === `${recovery.assemblySha256}\n`,
    );
    const assemblyArgs = [
      recovery.assemblyInput.path,
      recovery.assemblyInput.sha256,
      recovery.policySha256,
      recovery.assemblySha256,
      now,
      assemblyEnd,
      bundlePath,
    ];
    const assemblyReceipt = JSON.parse(
      await command("assembly-prepare", input.tools.python, [
        "-I",
        "-B",
        assemblyScript,
        "prepare",
        ...assemblyArgs,
      ]),
    );
    assert(
      assemblyReceipt.kind === "nutrition-storage-recovery-assembly-readback-v1" &&
        digest(assemblyReceipt.bundle_sha256) &&
        assemblyReceipt.component_count === 0 &&
        assemblyReceipt.operationalAcceptance === false,
    );
    const assembly = { path: bundlePath, sha256: assemblyReceipt.bundle_sha256 };
    const bundle = await heldOperatorInput(bundlePath, assembly.sha256, {
      privateFile: true,
      maximum: 65_536,
    });
    generated.push(bundle);
    const qualified = JSON.parse(
      await command("assembly-qualify", input.tools.python, [
        "-I",
        "-B",
        assemblyScript,
        "qualify",
        ...assemblyArgs,
        assembly.sha256,
      ]),
    );
    assert(
      qualified.bundle_sha256 === assembly.sha256 &&
        qualified.operationalAcceptance === false &&
        qualified.component_count === 0,
    );
    const operator = async (operation, settings) => {
      await phaseGuard();
      const timeoutMs = Math.min(settings.timeoutMs, lease.remaining(900_000) - 90_000);
      assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
      const ref = await createPrivate(`${operation}-input.json`, {
        schemaVersion: 1,
        operation,
        notAfterUtc: new Date(Date.now() + timeoutMs + 75_000).toISOString(),
        assembly,
        settings: { ...settings, timeoutMs },
        ...(operation === "restore"
          ? {
              restoreHandoffPath: join(input.root, "recovery/restore-handoff.json"),
              restoreEvidencePath: join(input.root, "recovery/restore-evidence.json"),
            }
          : {}),
      });
      await publish({ phase: `${operation}-intent`, input: ref, target: admitted.target });
      const receipt = JSON.parse(
        await command(
          `postgres-${operation}`,
          input.tools.node,
          [
            join(SOURCE, "scripts/postgres-operator.mjs"),
            operation,
            "--input",
            ref.path,
            "--input-sha256",
            ref.sha256,
          ],
          { milliseconds: Math.min(1_800_000, timeoutMs + 80_000) },
        ),
      );
      assert(
        receipt.kind === "nutrition-postgres-operator-receipt-v1" &&
          receipt.operation === operation &&
          receipt.inputSha256 === ref.sha256 &&
          receipt.assemblySha256 === assembly.sha256 &&
          receipt.result.localOnly === (operation === "restore") &&
          receipt.result.operationalRecoveryAccepted === false,
      );
      return receipt;
    };
    const backed = await operator("backup", backup);
    assert(
      backed.expectedBackup.sourceRevision === input.sourceRevision &&
        backed.expectedBackup.databaseName === input.database.databaseName &&
        backed.expectedBackup.backupId === input.owner &&
        backed.result.storage === "azure-blob",
    );
    const restored = await operator("restore", {
      ...restore,
      expectedBackup: backed.expectedBackup,
    });
    assert(
      restored.result.status === "local-restore-replayed" &&
        restored.result.sourceStorage === "azure-blob" &&
        restored.result.erasureReplayRequired === false &&
        restored.result.applicationTrafficBlocked === true &&
        restored.result.targetDatabase === restore.targetDatabase &&
        restored.result.manifestSha256 === backed.expectedBackup.manifestSha256 &&
        restored.result.sourceRevision === input.sourceRevision,
    );
    for (const ref of [restored.handoff, restored.evidence]) {
      assert(ref?.path.startsWith(`${input.root}/recovery/`) && digest(ref.sha256));
      generated.push(
        await heldOperatorInput(ref.path, ref.sha256, { privateFile: true, maximum: 1_572_864 }),
      );
    }
    await phaseGuard();
    assert((await readdir(maintenanceSpool)).length === 0);
    // Preserve the maintained owner-only backup authority through the fenced restore.
    // Runtime roles receive their finite privileges only before original-source readiness.
    await applyDevelopmentRuntimeDatabaseGrants({
      database,
      expectedTarget: admitted.target,
      principals: { api: input.database.api, worker: input.database.worker },
      notAfterUtc: boundedEnd(180_000),
      signal: lease.workSignal,
      onMutationStart: mutation("database-grants-intent"),
    });
    const attestation = await attestDevelopmentRuntimeSource({
      expectedTarget: admitted.target,
      caCertificate: ca,
      ownerEnvironment: config.ownerEnvironment,
      runtimeEnvironments: config.runtimeEnvironments,
      notAfterUtc: boundedEnd(300_000),
      signal: lease.workSignal,
    });
    await publish({ phase: "source-replay-ready", attestation });
    await database.destroy();
    database = undefined;
    for (const name of ["api", "worker"]) {
      await phaseGuard();
      await driver.start(name);
      await healthy(name);
    }
    const journeyInput = () => ({
      configuration: {
        ...input.journey,
        runId: input.owner,
        nodeEnv: "development",
        profile: "hosted-development",
        syntheticOnly: true,
        catalogue,
        captureSend: input.mail.send,
        captureReview: input.mail.review,
        notAfterUtc: boundedEnd(300_000),
      },
      http: transport(300_000),
      signal: lease.workSignal,
      onMutationStart: mutation("journey-mutation-intent"),
    });
    await phaseGuard();
    const journey = await initializeDevelopmentRuntimeJourney(journeyInput());
    await publish({ phase: "journey-written", journey });
    await phaseGuard();
    await driver.stop(["api", "worker"]);
    await conserve();
    for (const name of ["api", "worker"]) {
      await phaseGuard();
      await driver.start(name);
      await healthy(name);
    }
    const readback = await readBackDevelopmentRuntimeJourney(journeyInput(), journey);
    assert(readback.persisted === true);
    await publish({ phase: "journey-readback", readback });
    const applicationReady = async (edgeRequired = false) => {
      await phaseGuard();
      const rows = await driver.observe([
        "api",
        "worker",
        ...(edgeRequired ? ["client-edge"] : []),
      ]);
      for (const name of ["api", "worker"])
        assert(rows[name].status === "running" && rows[name].healthy && !rows[name].oomKilled);
      if (edgeRequired)
        assert(
          rows["client-edge"].status === "running" &&
            rows["client-edge"].healthy &&
            !rows["client-edge"].oomKilled,
        );
      const readiness = await transport(30_000).request("api", "/ready", {
        signal: lease.workSignal,
      });
      assert(
        readiness.status === 200 && canonicalJson(await readiness.json()) === '{"status":"ok"}',
      );
    };
    if (clientAccess) {
      const start = Date.parse(clientAccess.notBeforeUtc),
        end = Date.parse(clientAccess.notAfterUtc) - 30_000;
      const wallOrigin = Date.parse(startedAtUtc),
        monoOrigin = BigInt(monotonicStartNs);
      const clientNow = () =>
        Math.max(
          Date.now(),
          wallOrigin + Number((process.hrtime.bigint() - monoOrigin) / 1_000_000n),
        );
      await publish({ phase: "client-window-wait", clientAccess });
      while (clientNow() < start) {
        // There is no public listener during this wait. Conserve held inputs and the
        // original lease, then repeat full source/host/application checks before opening.
        await conserve();
        await delay(Math.min(30_000, Math.max(1, start - clientNow())), undefined, {
          signal: lease.workSignal,
        });
      }
      await applicationReady();
      assert(clientNow() < end);
      await publish({ phase: "client-admission-intent", clientAccess });
      await driver.start("client-edge");
      await healthy("client-edge");
      assert(clientNow() < end);
      await publish({ phase: "client-admitted", clientAccess, runtimeAcceptanceRecorded: false });
      while (clientNow() < end) {
        await applicationReady(true);
        await delay(Math.min(30_000, Math.max(1, end - clientNow())), undefined, {
          signal: lease.workSignal,
        });
      }
      await driver.stop(["client-edge"]);
      await publish({
        phase: "client-admission-closed",
        clientAccess,
        runtimeAcceptanceRecorded: false,
      });
    } else {
      const holdUntil =
        performance.now() + Math.min(input.holdSeconds * 1000, lease.remaining(900_000));
      while (performance.now() < holdUntil) {
        await phaseGuard();
        await delay(Math.min(15_000, Math.ceil(holdUntil - performance.now())), undefined, {
          signal: lease.workSignal,
        });
      }
    }
    result = {
      kind: "nutrition-development-runtime-v1",
      sourceRevision: input.sourceRevision,
      owner: input.owner,
      project: input.project,
      entryId: readback.entryId,
      diarySha256: readback.diarySha256,
      persisted: true,
      syntheticOnly: true,
      localOnly: true,
      operationalAcceptance: false,
      applicationTrafficBlocked: true,
    };
  } catch (error) {
    primary = error;
  } finally {
    if (database)
      try {
        await database.destroy();
      } catch (error) {
        closers.push(error);
      }
    let nativeStopFailed = false;
    if (driver && created)
      for (const name of [
        ...(input.clientAccess ? ["client-edge"] : []),
        "api",
        "worker",
        "migrate",
        "azure-canary",
        "search-bootstrap",
        "capture",
        "internal-tls",
        "meilisearch",
        "postgres",
      ])
        try {
          await driver.stop([name]);
        } catch (error) {
          nativeStopFailed = true;
          closers.push(error);
        }
    if (journal)
      try {
        await flushObservations();
      } catch (error) {
        closers.push(error);
      }
    if (journal && created)
      try {
        await publish({
          phase: "native-resources-stopped",
          nativeStopSucceeded: !nativeStopFailed,
          runtimeAcceptanceRecorded: false,
          cleanupErrorCount: closers.length,
          ...(result ? { observedJourney: result } : {}),
        });
      } catch (error) {
        closers.push(error);
      }
    for (const holder of [host, supervisor, prepared])
      if (holder)
        try {
          await holder.close();
        } catch (error) {
          closers.push(error);
        }
    if (journal)
      try {
        await journal.close();
      } catch (error) {
        closers.push(error);
      }
    for (const holder of [...generated, recoveryHeld, held])
      if (holder)
        try {
          holder.raw.fill(0);
          await holder.fd.close();
        } catch (error) {
          closers.push(error);
        }
  }
  if (primary || closers.length || evidenceIncomplete)
    throw new AggregateError([...(primary ? [primary] : []), ...closers], failure().message);
  assert(result && created);
  return Object.freeze(result);
}
