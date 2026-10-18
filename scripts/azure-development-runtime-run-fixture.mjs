// Source acceptance only: actual controller and validators, controlled raw host/FS/SQL/native replies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { runtimeApiWire } from "./azure-development-runtime-api-fixture.mjs";
import { runtimeAssemblyFixture } from "./azure-development-runtime-assembly-fixture.mjs";
import { runtimeClientEnvironment } from "./azure-development-runtime-client.mjs";
import { clientCertificateFixture } from "./azure-development-runtime-client-fixture.mjs";
import { fixture as configurationFixture } from "./azure-development-runtime-configuration-fixture.mjs";
import {
  owner,
  runtimeDockerFixture,
  runtimeDockerObservations,
} from "./azure-development-runtime-fixture.mjs";
import { fixture as hostFixture } from "./azure-development-runtime-host-fixture.mjs";
import { fixture as imageFixture } from "./azure-development-runtime-images-fixture.mjs";
import { readRuntimeJournal } from "./azure-development-runtime-journal.mjs";
import { runtimeMeiliWire } from "./azure-development-runtime-meili-fixture.mjs";
import {
  runtimeOperatorFiles,
  runtimeOperatorWire,
} from "./azure-development-runtime-operator-fixture.mjs";
import { fixture as preparedFixture } from "./azure-development-runtime-prepared-fixture.mjs";
import { runtimeSeedSql } from "./azure-development-runtime-sql-fixture.mjs";
import { fixture as supervisorFixture } from "./azure-development-runtime-supervision-fixture.mjs";
import { runtimeWireServices } from "./azure-development-runtime-wire-fixture.mjs";
import { runtimeWorkerWire } from "./azure-development-runtime-worker-fixture.mjs";
import { azureBackupFixture } from "./postgres-backup-azure-fixture.mjs";
import { withOperatorTestEnvironment } from "./postgres-operator-fixture.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const output = (text) => ({
  text,
  bytes: Buffer.byteLength(text),
  sha256: hash(text),
  stderrBytes: 0,
  stderrSha256: hash(""),
});
const envText = (env) =>
  Object.entries(env)
    .map(([name, value]) => ` ${name}='${value}'`.trimStart())
    .join("\n") + "\n";
export async function runtimeRunFixture(t, options = {}) {
  const base = await runtimeDockerFixture(t, {
    project: `nourishing-development-${owner}`,
    root: options.root,
    parent: options.validAssembly ? homedir() : undefined,
    clientAccess: options.clientAccess,
    apiDeadlineNs: options.apiDeadlineNs,
  });
  const assembly = options.validAssembly ? await runtimeAssemblyFixture(base.root) : null;
  const config = await configurationFixture(t, {
    base,
    clientAccess: options.clientAccess,
    apiDeadlineNs: options.apiDeadlineNs,
    ledgerContainerUrl: assembly?.destinations.erasure.container_url,
  });
  const { root } = base,
    notAfterUtc = config.input.notAfterUtc;
  const values = {};
  for (const name of [
    "runtime",
    "postgres",
    "migrate",
    "database",
    "api",
    "worker",
    "canary",
    "meili",
    "scoped-meili",
  ])
    values[`config/${name}.env`] = await readFile(join(root, "config", `${name}.env`), "utf8");
  values["config/maintenance.env"] = envText(config.ownerEnvironment);
  values["config/database-bootstrap.sql"] = config.input.databaseBootstrap;
  values["pki/ca.crt"] = config.input.caCertificate;
  if (options.clientAccess)
    values["pki/client.crt"] = clientCertificateFixture(options.clientCertificateOptions);
  const prepared = await preparedFixture(t, { root, values, clientAccess: options.clientAccess });
  const images = imageFixture();
  const imageObservations = Object.fromEntries(
    images.rows.flatMap((row) => row.RepoDigests.map((ref) => [ref, row])),
  );
  const observed = runtimeDockerObservations(root, config.model, imageObservations);
  const host = await hostFixture(t, {
    root,
    owner,
    notAfterUtc,
    clientAccess: options.clientAccess,
    mountPoint: options.validAssembly ? homedir() : undefined,
    azureHosts: [
      ...new Set(
        [
          config.model.services.api.environment.EXPORT_ARTIFACT_AZURE_CONTAINER_URL,
          config.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
          assembly?.destinations.backup.container_url ??
            "https://nourishingbackup.blob.core.windows.net/nourishing-development-backup",
        ].map((value) => new URL(value).hostname),
      ),
    ],
  });
  for (const row of Object.values(observed.containers)) {
    const base = `${host.input.dockerRoot}/overlay2/`,
      layer = row.Id;
    row.GraphDriver = {
      Name: "overlay2",
      Data: {
        LowerDir: `${base}${"f".repeat(64)}/diff`,
        MergedDir: `${base}${layer}/merged`,
        UpperDir: `${base}${layer}/diff`,
        WorkDir: `${base}${layer}/work`,
      },
    };
  }
  const storage = azureBackupFixture({
    hosted: true,
    containerUrl: assembly?.destinations.backup.container_url,
  });
  const operatorFiles = options.validOperator ? await runtimeOperatorFiles(root) : null;
  t.after(() => storage.dispose());
  const connection = {
    connectionString: config.ownerEnvironment.DATABASE_URL,
    sslMode: "verify-full",
    caCertificate: config.input.caCertificate,
  };
  const keyRing = {
    currentKeyId: "synthetic-backup-v1",
    keys: { "synthetic-backup-v1": Buffer.alloc(32, 9).toString("base64") },
  };
  const recovery = {
    assemblyInput: assembly?.assemblyInput ?? {
      path: join(root, "recovery/assembly-input.json"),
      sha256: "a".repeat(64),
    },
    policySha256: assembly?.contextSource ?? "b".repeat(64),
    assemblySha256: assembly?.assemblySource ?? "c".repeat(64),
    backup: {
      connection,
      keyRing,
      storage: storage.storage("c"),
      maxDumpBytes: 1048576,
      timeoutMs: 60000,
      tools: {},
    },
    restore: {
      maintenanceConnection: {
        ...connection,
        connectionString: connection.connectionString.replace(/\/[^/]+$/u, "/postgres"),
      },
      targetConnection: {
        ...connection,
        connectionString: connection.connectionString.replace(
          /\/[^/]+$/u,
          `/nutrition_restore_${owner.replaceAll("-", "")}`,
        ),
      },
      connectAllowlist: [config.input.database.owner],
      deniedRuntimePrincipals: [config.input.database.api, config.input.database.worker],
      keyRing,
      storage: storage.storage("rl"),
      maxDumpBytes: 1048576,
      timeoutMs: 60000,
      tools: {},
      erasureReplay: {
        kind: "azure-blob",
        containerUrl: config.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
        prefix: config.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_PREFIX,
        sasToken: config.ownerEnvironment.ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS,
        encryptionKeyRing: {
          currentKeyId: config.ownerEnvironment.ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID,
          keys: JSON.parse(config.ownerEnvironment.ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS),
        },
        locatorKeyRing: {
          currentKeyId: config.ownerEnvironment.ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID,
          keys: JSON.parse(config.ownerEnvironment.ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS),
        },
      },
    },
  };
  if (assembly)
    for (const operation of ["backup", "restore"])
      recovery[operation].storage.containerUrl = assembly.destinations.backup.container_url;
  if (operatorFiles)
    for (const operation of ["backup", "restore"]) {
      recovery[operation].tmpfsRoot = operatorFiles.tmpfsRoot;
      recovery[operation].tools =
        operation === "backup"
          ? { pgDump: operatorFiles.tools.pgDump, pgRestore: operatorFiles.tools.pgRestore }
          : { pgRestore: operatorFiles.tools.pgRestore, psql: operatorFiles.tools.psql };
    }
  const recoveryRaw = `${canonicalJson(recovery)}\n`,
    recoveryPath = join(root, "recovery/settings.json");
  await writeFile(recoveryPath, recoveryRaw, { mode: 0o600, flag: "wx" });
  const tools = Object.fromEntries(
    [
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
    ].map((name) => [
      name,
      {
        path:
          name === "node"
            ? process.execPath
            : name === "python"
              ? "/usr/bin/python3.12"
              : `/usr/bin/${name}`,
        sha256: name === "python" ? images.input.tools.python.sha256 : "f".repeat(64),
      },
    ]),
  );
  tools.node.sha256 = hash(await readFile(process.execPath));
  const input = {
    schemaVersion: 1,
    kind: "nutrition-development-runtime-input-v1",
    owner,
    project: observed.model.name,
    root,
    sourceRevision: "a".repeat(40),
    notAfterUtc,
    holdSeconds: options.holdSeconds ?? 0,
    clientAccess: options.clientAccess ?? null,
    tools,
    images: images.input.images,
    files: prepared.files,
    database: config.input.database,
    mail: config.input.mail,
    journey: {
      owners: [1, 2].map((n) => ({
        email: `nourishing-${owner}-${n}@example.invalid`,
        password: `synthetic password for owner ${n}`,
      })),
      recoveryPassword: "synthetic replacement password",
    },
    host: Object.fromEntries(
      ["bootId", "machineId", "qualification", "encryptedVolume", "dockerRoot", "dockerId"].map(
        (name) => [name, host.input[name]],
      ),
    ),
    supervisor: { runtimeSeconds: 4500 },
    recovery: { path: recoveryPath, sha256: hash(recoveryRaw) },
  };
  const inputPath = join(root, "runtime.json"),
    raw = `${canonicalJson(input)}\n`,
    inputSha256 = hash(raw);
  await writeFile(inputPath, raw, { mode: 0o600, flag: "wx" });
  const supervisor = await supervisorFixture(t, {
    root,
    inputPath,
    inputSha256,
    runtimeSeconds: 4500,
    notAfterUtc,
  });
  const calls = [],
    starts = [],
    stops = [],
    lookup = new Map(Object.values(observed.containers).map((row) => [row.Id, row]));
  let created = false,
    migrations = 0;
  const state = {
    options,
    assembly,
    observed,
    input,
    pools: [],
    queries: [],
    calls,
    starts,
    stops,
    prepared,
    supervisor,
    host,
    images,
    config,
    created: () => created,
  };
  state.sql = await runtimeSeedSql(state);
  if (operatorFiles) state.operator = await runtimeOperatorWire(state, operatorFiles, storage);
  state.meili = runtimeMeiliWire(state);
  state.api = runtimeApiWire(state);
  t.after(() => state.api.close());
  state.wire = runtimeWireServices(t, state);
  state.worker = runtimeWorkerWire(state);
  t.after(() => state.worker.close());
  state.serviceOutputs = new Map();
  state.serviceErrors = [];
  const execute = async (tool, args, configuration) => {
    configuration.signal.throwIfAborted();
    calls.push([tool.path, [...args]]);
    if (tool.path === tools.git.path) {
      assert(args.includes("rev-parse") || args.includes("status"));
      return output(
        args.includes("rev-parse")
          ? (options.wrongSource ? "b".repeat(40) : input.sourceRevision) + "\n"
          : options.dirtySource
            ? " M unexpected\n"
            : "",
      );
    }
    if (tool.path === tools.busctl.path)
      return supervisor.execution.execute(supervisor.input.busctl, args, configuration);
    if (tool.path === tools.node.path && args[0] === "--version") return output("v22.23.2\n");
    if (tool.path === tools.node.path && args[0].endsWith("/postgres-operator.mjs")) {
      if (!state.operator) return runTool(tool, args, configuration);
      const { runPostgresOperator } = await import("./postgres-operator.mjs");
      const result = await withOperatorTestEnvironment(() =>
        runPostgresOperator(args.slice(1), { signal: configuration.signal }),
      );
      return output(JSON.stringify(result) + "\n");
    }
    if (tool.path === tools.python.path) {
      if (assembly && args[2].endsWith("/storage-recovery-assembly.py"))
        return output(await assembly.command(args.slice(3)));
      return runTool(tool, args, configuration);
    }
    if (tool.path === tools.docker.path && args.includes("image"))
      return output(JSON.stringify(images.rows));
    if (tool.path === tools.docker.path && !args.includes("info")) {
      assert.equal(args[1], "unix:///var/run/docker.sock");
      if (args.includes("compose")) {
        if (args.includes("config")) {
          if (input.clientAccess) {
            const env = runtimeClientEnvironment(
              input.clientAccess,
              configuration.env.RUNTIME_API_DEADLINE_NS,
            );
            const fields = {
              NOURISHING_RUNTIME_NOT_AFTER_UTC: env.RUNTIME_API_END,
              NOURISHING_RUNTIME_DEADLINE_NS: env.RUNTIME_API_DEADLINE_NS,
            };
            Object.assign(config.model.services.api.environment, fields);
            const raw = observed.containers.api.Config.Env.filter(
              (item) => !Object.keys(fields).includes(item.split("=", 1)[0]),
            );
            observed.containers.api.Config.Env = [
              ...raw,
              ...Object.entries(fields).map(([key, value]) => `${key}=${value}`),
            ];
          }
          return output(JSON.stringify(config.model));
        }
        assert(
          args.includes("create") &&
            args.includes("--no-build") &&
            args.includes("--no-recreate") &&
            args.at(-1) === "never",
        );
        const journal = await readRuntimeJournal(join(root, "journal"), inputSha256);
        assert(journal.complete && journal.records.at(-1).event.phase === "create-intent");
        created = true;
        for (const row of lookup.values())
          for (const network of Object.values(row.NetworkSettings.Networks)) network.NetworkID = "";
        if (options.unknownCreate) throw new Error("Controlled lost create response");
        return output("Owned synthetic containers created\n");
      }
      const at = args.findIndex((value) => ["container", "network"].includes(value));
      assert(at >= 0);
      const [family, operation, ...rest] = args.slice(at);
      if (operation === "ls")
        return output(
          family === "network" || !created
            ? ""
            : Object.keys(observed.containers)
                .map((name) => observed.containers[name].Id)
                .join("\n") + "\n",
        );
      if (family === "network" && operation === "inspect")
        return output(JSON.stringify(Object.values(observed.rawNetworks)));
      if (operation === "inspect")
        return output(
          JSON.stringify(
            rest.map((id) => {
              assert(lookup.has(id));
              return lookup.get(id);
            }),
          ),
        );
      const row = lookup.get(rest.at(-1));
      assert(row);
      const name = row.Config.Labels["com.docker.compose.service"];
      if (operation === "start") {
        const journal = await readRuntimeJournal(join(root, "journal"), inputSha256);
        assert(journal.complete && journal.records.at(-1).event.phase === "start-intent");
        starts.push(name);
        const oneShot = ["migrate", "azure-canary", "search-bootstrap"].includes(name);
        row.State = {
          ...row.State,
          Status: oneShot ? "exited" : "running",
          Running: !oneShot,
          Health: { Status: "healthy" },
        };
        for (const [networkName, network] of Object.entries(row.NetworkSettings.Networks)) {
          const raw = Object.values(observed.rawNetworks).find(
            (value) => value.Name === networkName,
          );
          network.NetworkID = raw.Id;
          network.IPAddress =
            config.model.services[name].networks[
              networkName.slice(config.model.name.length + 1)
            ].ipv4_address;
        }
        if (name === "client-edge" && options.clientReadinessFailure)
          observed.containers.worker.State.Health.Status = "unhealthy";
        if (name === "client-edge")
          row.NetworkSettings.Ports = { "8443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }] };
        if (name === "api" && options.realApi) {
          state.apiDeadlineBindings ??= [];
          state.apiDeadlineBindings.push([
            config.model.services.api.environment.NOURISHING_RUNTIME_NOT_AFTER_UTC,
            config.model.services.api.environment.NOURISHING_RUNTIME_DEADLINE_NS,
          ]);
          if (input.clientAccess) {
            const utc = config.model.services.api.environment.NOURISHING_RUNTIME_NOT_AFTER_UTC;
            const ns = config.model.services.api.environment.NOURISHING_RUNTIME_DEADLINE_NS;
            const wall = Date.parse(utc) - Date.now();
            const mono = Number((BigInt(ns) - process.hrtime.bigint()) / 1_000_000n);
            const original = (await state.journal()).records[0].event;
            assert(
              Math.abs(wall - mono) <= 1000,
              JSON.stringify({
                stage: "api-start-clock-binding",
                original,
                originalApiDeadlineNs: (
                  await import("./azure-development-runtime-client.mjs")
                ).runtimeClientDeadline(input.clientAccess, original),
                nativeConstructorUtc: new Date().toISOString(),
                wall,
                mono,
                ns,
                utc,
                currentUtc: new Date(Date.now()).toISOString(),
                clientDelays: state.clientDelays ?? [],
              }),
            );
          }
          await state.api.start();
        }
        if (name === "worker" && options.realWorker) {
          await state.worker.start();
          await state.worker.poll(configuration.signal);
        }
        if (["azure-canary", "search-bootstrap"].includes(name)) {
          try {
            state.serviceOutputs.set(name, await state.wire.run(name, configuration.signal));
          } catch (error) {
            state.serviceErrors.push(error);
            row.State.ExitCode = 1;
          }
        }
        return output(row.Id + "\n");
      }
      if (operation === "stop") {
        assert.equal(rest[0], "--timeout");
        assert.equal(rest[1], name === "worker" ? "610" : name === "api" ? "305" : "30");
        stops.push(name);
        if (
          options.stopFailure === name ||
          (options.stopAfterReadback === name &&
            (await state.journal()).records.some((row) => row.event.phase === "journey-readback"))
        )
          throw new Error("Controlled stop refusal");
        if (name === "api" && options.realApi) await state.api.close();
        if (name === "worker" && options.realWorker) await state.worker.close();
        row.State = { ...row.State, Status: "exited", Running: false, ExitCode: 0 };
        if (name === "client-edge") row.NetworkSettings.Ports = { "8443/tcp": null };
        return output(row.Id + "\n");
      }
      assert.equal(operation, "logs");
      if (state.serviceOutputs.has(name)) return output(state.serviceOutputs.get(name));
      assert.equal(name, "migrate");
      migrations++;
      return output(
        migrations === 1
          ? "Migrations applied.\n"
          : "Database is current; no migrations applied.\n",
      );
    }
    return host.execution.execute(tool, args, configuration);
  };
  const readSystem = async (path, ...args) => {
    if (path === `/proc/${process.pid}/stat`) return readFile(path, ...args);
    if (path === `/proc/${process.pid}/cgroup`)
      return supervisor.execution.readSystem(path, ...args);
    return host.execution.readSystem(path, ...args);
  };
  state.execution = {
    execute,
    readSystem,
    prepared: prepared.io,
    host: { readdir: host.execution.readdir },
    http: { request: options.realApi ? state.api.request : state.meili.request },
  };
  state.args = ["run", "--input", inputPath, "--input-sha256", inputSha256];
  state.journal = () => readRuntimeJournal(join(root, "journal"), inputSha256);
  return state;
}
