import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import {
  observeRuntimeContainer,
  observeRuntimeNetwork,
  requireSameRuntimeContainer,
} from "./azure-development-runtime-ownership.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SERVICES = [
  "api",
  "azure-canary",
  "capture",
  "internal-tls",
  "meilisearch",
  "migrate",
  "postgres",
  "search-bootstrap",
  "worker",
];
const STOP_ORDER = [
  "api",
  "worker",
  "migrate",
  "azure-canary",
  "search-bootstrap",
  "capture",
  "internal-tls",
  "meilisearch",
  "postgres",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b));
const parse = (text) => {
  const value = JSON.parse(text);
  assert(value !== null);
  return value;
};

/** Native Docker boundary for the prepared-host controller. Admission and actual maintenance belong
 * to the caller; this object has no public-edge, pull, build, removal or arbitrary command operation. */
export async function openRuntimeDocker(input, execute = runTool) {
  const { lease, journal, conserve } = input;
  const recovery = input.recovery === undefined ? undefined : structuredClone(input.recovery);
  const config = structuredClone({
    project: input.project,
    owner: input.owner,
    revision: input.revision,
    root: input.root,
    dockerConfig: input.dockerConfig,
    images: input.images,
    docker: input.docker,
    imageObservations: input.imageObservations,
  });
  assert(
    lease && journal && typeof journal.conserve === "function" && typeof conserve === "function",
  );
  assert(
    /^[a-z][a-z0-9-]{0,62}$/u.test(config.project) &&
      /^[a-f0-9-]{36}$/u.test(config.owner) &&
      /^[a-f0-9]{40}$/u.test(config.revision),
  );
  assert(
    resolve(config.root) === config.root && resolve(config.dockerConfig) === config.dockerConfig,
  );
  const components = {
    API: "api",
    WORKER: "worker",
    MIGRATOR: "migrator",
    CADDY: "caddy",
    POSTGRES: "postgres",
    MEILI: "meilisearch",
    MAILPIT: "mailpit",
  };
  exact(
    Object.keys(config.images).sort(),
    Object.keys(components)
      .map((name) => `${name}_IMAGE`)
      .sort(),
  );
  for (const [name, component] of Object.entries(components))
    assert(
      new RegExp(
        `^ghcr\\.io/liangzixuan/cronometer-gold-${component}@sha256:[a-f0-9]{64}$`,
        "u",
      ).test(config.images[`${name}_IMAGE`]),
    );
  const prefix = ["--host", "unix:///var/run/docker.sock", "--config", config.dockerConfig];
  const compose = [
    ...prefix,
    "compose",
    "--profile",
    "*",
    "--project-directory",
    SOURCE,
    "--env-file",
    "/dev/null",
    "-f",
    resolve(SOURCE, "infra/development/azure/runtime/compose.yaml"),
  ];
  const env = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    ...config.images,
    RUNTIME_PROJECT: config.project,
    RUNTIME_OWNER: config.owner,
    RUNTIME_REVISION: config.revision,
    RUNTIME_SOURCE: SOURCE,
    RUNTIME_ROOT: config.root,
  };
  let model,
    networks = {},
    contracts = {},
    recorded = {},
    created = false,
    busy = false,
    creationUncertain = false,
    evidenceIncomplete = false;
  async function publish(event, cleanup = false) {
    try {
      return await journal.publish(event);
    } catch (error) {
      if (!cleanup) throw error;
      evidenceIncomplete = true;
    }
  }
  async function conserveJournal(cleanup) {
    try {
      await journal.conserve();
    } catch (error) {
      if (!cleanup) throw error;
      evidenceIncomplete = true;
    }
  }
  async function command(phase, args, { cleanup = false, milliseconds = 30_000, signal } = {}) {
    assert(signal === undefined || signal instanceof AbortSignal);
    signal?.throwIfAborted();
    const budget = lease.remaining(milliseconds, cleanup);
    await conserve({ cleanup });
    await conserveJournal(cleanup);
    signal?.throwIfAborted();
    const diagnostics = [];
    let stderrBytes = 0;
    const startedAtUtc = new Date().toISOString();
    try {
      const result = await execute(config.docker, args, {
        signal: AbortSignal.any([
          cleanup ? lease.cleanupSignal : lease.workSignal,
          ...(signal ? [signal] : []),
          AbortSignal.timeout(budget),
        ]),
        env,
        directory: SOURCE,
        limit: 262_144,
        onStderr: (chunk) => {
          assert(Buffer.isBuffer(chunk));
          stderrBytes += chunk.length;
          assert(stderrBytes <= 65_536);
          diagnostics.push(Buffer.from(chunk));
        },
      });
      assert(
        typeof result.text === "string" &&
          Buffer.byteLength(result.text) === result.bytes &&
          sha(result.text) === result.sha256 &&
          result.stderrBytes === stderrBytes &&
          result.stderrSha256 === sha(Buffer.concat(diagnostics)),
      );
      await conserve({ cleanup });
      await conserveJournal(cleanup);
      lease.remaining(1, cleanup);
      signal?.throwIfAborted();
      await publish(
        {
          phase,
          command: args,
          startedAtUtc,
          endedAtUtc: new Date().toISOString(),
          completed: true,
          stdout: result.text,
          stdoutSha256: result.sha256,
          stderr: Buffer.concat(diagnostics).toString("base64"),
          stderrSha256: result.stderrSha256,
        },
        cleanup,
      );
      return result.text;
    } catch (error) {
      try {
        await journal.publish({
          phase: "command-unconfirmed",
          attemptedPhase: phase,
          command: args,
          startedAtUtc,
          endedAtUtc: new Date().toISOString(),
          completed: false,
          stderr: Buffer.concat(diagnostics).toString("base64"),
        });
      } catch {}
      throw error;
    }
  }
  async function exclusive(operation) {
    assert(!busy);
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }
  async function readNetworks(cleanup = false, signal) {
    const rows = parse(
      await command(
        "observe-networks",
        [
          ...prefix,
          "network",
          "inspect",
          ...Object.keys(model.networks).map((name) => `${config.project}_${name}`),
        ],
        { cleanup, signal },
      ),
    );
    assert(Array.isArray(rows) && rows.length === 3);
    const result = {};
    for (const name of Object.keys(model.networks)) {
      const matches = rows.filter((row) => row.Name === `${config.project}_${name}`);
      assert(matches.length === 1);
      result[name] = observeRuntimeNetwork(matches[0], {
        project: config.project,
        name,
        internal: model.networks[name].internal ?? false,
      });
      if (networks[name]) exact(result[name], networks[name]);
    }
    return result;
  }
  async function inspect(names, cleanup = false, signal) {
    signal?.throwIfAborted();
    assert(names.length > 0 && names.every((name) => Object.hasOwn(recorded, name)));
    await readNetworks(cleanup, signal);
    const rows = parse(
      await command(
        "observe-containers",
        [...prefix, "container", "inspect", ...names.map((name) => recorded[name].id)],
        { cleanup, signal },
      ),
    );
    assert(Array.isArray(rows) && rows.length === names.length);
    const result = {};
    for (const name of names) {
      const matching = rows.filter((row) => row.Id === recorded[name].id);
      assert(matching.length === 1);
      result[name] = requireSameRuntimeContainer(matching[0], contracts[name], recorded[name]);
    }
    return result;
  }
  if (recovery === undefined) {
    const rendered = await command("compose-config", [...compose, "config", "--format", "json"]);
    model = parse(rendered);
  } else {
    exact(Object.keys(recovery).sort(), ["createdRecord", "model"]);
    model = recovery.model;
  }
  exact(Object.keys(model.services).sort(), SERVICES);
  assert(
    model.name === config.project &&
      Object.keys(model.networks).sort().join(",") === "azure_egress,backend,capture",
  );
  for (const [name, number] of [
    ["backend", 28],
    ["capture", 29],
    ["azure_egress", 30],
  ]) {
    exact(model.networks[name].ipam, {
      driver: "default",
      config: [{ subnet: `172.${number}.0.0/24`, gateway: `172.${number}.0.1` }],
    });
  }
  for (const [name, service] of Object.entries(model.services)) {
    assert(
      service.platform === "linux/arm64" &&
        service.pull_policy === "never" &&
        service.restart === "no" &&
        service.read_only === true &&
        !service.ports &&
        !service.build &&
        (service.privileged ?? false) === false,
    );
    if (name === "search-bootstrap") {
      assert(service.network_mode === "service:meilisearch");
      exact(service.depends_on, {
        meilisearch: { condition: "service_started", restart: true, required: true },
      });
    } else assert(service.depends_on === undefined);

    assert(Object.values(config.images).includes(service.image));
  }
  exact(
    [...new Set(Object.values(model.services).map((service) => service.image))].sort(),
    Object.values(config.images).sort(),
  );
  if (recovery !== undefined) {
    const claim = recovery.createdRecord;
    assert(claim.phase === "created" && claim.project === config.project);
    exact(Object.keys(claim).sort(), ["containers", "contracts", "networks", "phase", "project"]);
    exact(Object.keys(claim.containers).sort(), SERVICES);
    exact(Object.keys(claim.contracts).sort(), SERVICES);
    exact(Object.keys(claim.networks).sort(), Object.keys(model.networks).sort());
    const relatedIds = Object.fromEntries(
      SERVICES.map((name) => [name, claim.containers[name].id]),
    );
    assert(
      Object.values(relatedIds).every(id) &&
        new Set(Object.values(relatedIds)).size === SERVICES.length,
    );
    for (const name of SERVICES) {
      const row = claim.containers[name],
        contract = claim.contracts[name],
        service = model.services[name];
      assert(row.service === name && row.status === "created" && id(row.identity));
      assert(
        contract.serviceName === name &&
          contract.project === config.project &&
          contract.owner === config.owner &&
          contract.revision === config.revision,
      );
      exact(contract.service, service);
      exact(contract.image, config.imageObservations[service.image]);
      assert(row.imageId === contract.image.Id);
      exact(contract.networks, claim.networks);
      exact(contract.relatedIds, relatedIds);
    }
    networks = claim.networks;
    contracts = claim.contracts;
    recorded = claim.containers;
    created = true;
  }
  return Object.freeze({
    model: structuredClone(model),
    async create() {
      return exclusive(async () => {
        assert(recovery === undefined && !created && !creationUncertain);
        assert(
          (
            await command("project-containers-absent", [
              ...prefix,
              "container",
              "ls",
              "--all",
              "--quiet",
              "--no-trunc",
              "--filter",
              `label=com.docker.compose.project=${config.project}`,
            ])
          ).trim() === "",
        );
        assert(
          (
            await command("project-networks-absent", [
              ...prefix,
              "network",
              "ls",
              "--quiet",
              "--no-trunc",
              "--filter",
              `label=com.docker.compose.project=${config.project}`,
            ])
          ).trim() === "",
        );
        await journal.publish({
          phase: "create-intent",
          project: config.project,
          owner: config.owner,
          revision: config.revision,
          modelSha256: sha(canonicalJson(model)),
        });
        creationUncertain = true;
        await command("compose-create", [
          ...compose,
          "create",
          "--no-build",
          "--no-recreate",
          "--pull",
          "never",
        ]);
        const ids = (
          await command("project-created-identities", [
            ...prefix,
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${config.project}`,
          ])
        )
          .trim()
          .split("\n");
        assert(ids.length === SERVICES.length && new Set(ids).size === ids.length && ids.every(id));
        networks = await readNetworks();
        const rows = parse(
          await command("created-container-observations", [
            ...prefix,
            "container",
            "inspect",
            ...ids,
          ]),
        );
        assert(Array.isArray(rows) && rows.length === SERVICES.length);
        const relatedIds = Object.fromEntries(
          rows.map((row) => [row.Config?.Labels?.["com.docker.compose.service"], row.Id]),
        );
        exact(Object.keys(relatedIds).sort(), SERVICES);
        const accepted = {};
        for (const name of SERVICES) {
          const matches = rows.filter((row) => row.Id === relatedIds[name]);
          assert(matches.length === 1);
          const service = model.services[name],
            image = config.imageObservations[service.image];
          assert(image);
          contracts[name] = {
            serviceName: name,
            service,
            image,
            project: config.project,
            owner: config.owner,
            revision: config.revision,
            networks,
            relatedIds,
          };
          accepted[name] = observeRuntimeContainer(matches[0], contracts[name]);
          assert(accepted[name].status === "created");
        }
        await journal.publish({
          phase: "created",
          project: config.project,
          networks,
          containers: accepted,
          contracts,
        });
        recorded = accepted;
        created = true;
        creationUncertain = false;
        return structuredClone(recorded);
      });
    },
    async start(name) {
      return exclusive(async () => {
        assert(recovery === undefined && created && Object.hasOwn(recorded, name));
        const before = (await inspect([name]))[name];
        assert(["created", "exited"].includes(before.status));
        await journal.publish({
          phase: "start-intent",
          service: name,
          id: before.id,
          identity: before.identity,
        });
        const output = await command("start-container", [
          ...prefix,
          "container",
          "start",
          before.id,
        ]);
        assert(output.trim() === before.id);
        const after = (await inspect([name]))[name];
        assert(["running", "exited"].includes(after.status));
        await journal.publish({ phase: "started", container: after });
        return after;
      });
    },
    async observe(names, signal = lease.workSignal) {
      assert(recovery === undefined && signal instanceof AbortSignal);
      signal.throwIfAborted();
      return exclusive(() => inspect(names, false, signal));
    },
    async waitForExit(name, milliseconds) {
      return exclusive(async () => {
        assert(
          recovery === undefined &&
            created &&
            Object.hasOwn(recorded, name) &&
            ["migrate", "azure-canary", "search-bootstrap"].includes(name),
        );
        const start = performance.now();
        while (true) {
          assert(performance.now() - start < milliseconds);
          const row = (await inspect([name]))[name];
          assert(!row.oomKilled);
          if (row.status === "exited") {
            assert(row.exitCode === 0);
            const text = await command("maintenance-output", [
              ...prefix,
              "container",
              "logs",
              "--tail",
              "1000",
              row.id,
            ]);
            await journal.publish({
              phase: "maintenance-exited",
              service: name,
              id: row.id,
              exitCode: row.exitCode,
              outputSha256: sha(text),
            });
            return { container: row, text };
          }
          assert(row.status === "running");
          await delay(1000, undefined, { signal: lease.workSignal });
        }
      });
    },
    async stop(names = STOP_ORDER) {
      return exclusive(async () => {
        assert(created);
        assert(
          Array.isArray(names) &&
            new Set(names).size === names.length &&
            names.every((name) => Object.hasOwn(recorded, name)),
        );
        const requested = new Set(names),
          stopped = [];
        for (const name of STOP_ORDER.filter((value) => requested.has(value))) {
          const current = (await inspect([name], true))[name];
          if (current.status === "created" || current.status === "exited") {
            stopped.push(current);
            continue;
          }
          assert(current.status === "running");
          const seconds = name === "worker" ? 610 : name === "api" ? 305 : 30;
          await publish(
            {
              phase: "stop-intent",
              service: name,
              id: current.id,
              identity: current.identity,
              seconds,
            },
            true,
          );
          const text = await command(
            "stop-container",
            [...prefix, "container", "stop", "--timeout", String(seconds), current.id],
            { cleanup: true, milliseconds: (seconds + 15) * 1000 },
          );
          assert(text.trim() === current.id);
          const after = (await inspect([name], true))[name];
          assert(after.status === "exited");
          await publish({ phase: "stopped", container: after }, true);
          stopped.push(after);
        }
        assert(
          !evidenceIncomplete,
          "Owned stop observations may be complete but journal publication failed",
        );
        return stopped;
      });
    },
  });
}
