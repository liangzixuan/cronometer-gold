import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeClientEnvironment } from "./azure-development-runtime-client.mjs";
import { openRuntimeDocker } from "./azure-development-runtime-docker.mjs";
import {
  createRuntimeLease,
  openRuntimeJournal,
  readRuntimeJournal,
} from "./azure-development-runtime-journal.mjs";
import { observeRuntimeNetwork } from "./azure-development-runtime-ownership.mjs";

const source = resolve(fileURLToPath(new URL("../", import.meta.url)));
export const project = "nourishing-development-contract",
  owner = "11111111-1111-4111-8111-111111111111",
  revision = "a".repeat(40);
const components = {
  API: "api",
  WORKER: "worker",
  MIGRATOR: "migrator",
  CADDY: "caddy",
  POSTGRES: "postgres",
  MEILI: "meilisearch",
  MAILPIT: "mailpit",
};
export const references = Object.fromEntries(
  Object.entries(components).map(([key, component], index) => [
    `${key}_IMAGE`,
    `ghcr.io/liangzixuan/cronometer-gold-${component}@sha256:${String(index + 1).repeat(64)}`,
  ]),
);
const durations = { "5s": 5e9, "10s": 10e9, "15s": 15e9, "30s": 30e9 };
const defaultProject = project;
export async function runtimeDockerFixture(t, options = {}) {
  const project = options.project ?? defaultProject;
  const root =
    options.root ?? (await mkdtemp(join(options.parent ?? tmpdir(), "nutrition-owned-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { mode: 0o700 });
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
    await writeFile(
      join(root, "config", `${name}.env`),
      "NODE_ENV=development\nNOURISHING_API_PROFILE=hosted-development\n",
      { mode: 0o600, flag: "wx" },
    );
  const parsed = spawnSync(
    "docker",
    [
      "compose",
      "--profile",
      "*",
      "--project-directory",
      source,
      "--env-file",
      devNull,
      "-f",
      join(source, "infra/development/azure/runtime/compose.yaml"),
      ...(options.clientAccess
        ? ["-f", join(source, "infra/development/azure/runtime/compose.client.yaml")]
        : []),
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2_097_152,
      env: {
        ...process.env,
        ...references,
        ...(options.clientAccess
          ? runtimeClientEnvironment(options.clientAccess, options.apiDeadlineNs)
          : {}),
        RUNTIME_ROOT: root,
        RUNTIME_SOURCE: source,
        RUNTIME_PROJECT: project,
        RUNTIME_OWNER: owner,
        RUNTIME_REVISION: revision,
        DOCKER_HOST: "unix:///nonexistent-nourishing-contract.sock",
      },
    },
  );
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  const model = JSON.parse(parsed.stdout);
  return runtimeDockerObservations(root, model, options.imageObservations);
}

export function runtimeDockerObservations(root, model, imageObservations) {
  const project = model.name,
    rawNetworks = {},
    networks = {},
    containers = {},
    contracts = {};
  for (const [index, name] of ["backend", "capture", "azure_egress"].entries()) {
    rawNetworks[name] = {
      Id: String(index + 1).repeat(64),
      Name: `${project}_${name}`,
      Driver: "bridge",
      Scope: "local",
      Internal: name !== "azure_egress",
      EnableIPv6: false,
      Ingress: false,
      IPAM: {
        Driver: "default",
        Config: [
          {
            Subnet: model.networks[name].ipam.config[0].subnet,
            Gateway: model.networks[name].ipam.config[0].gateway,
          },
        ],
      },
      Options: {},
      Labels: { "com.docker.compose.project": project, "com.docker.compose.network": name },
    };
    networks[name] = observeRuntimeNetwork(rawNetworks[name], {
      project,
      name,
      internal: name !== "azure_egress",
    });
  }
  const relatedIds = Object.fromEntries(
    Object.keys(model.services).map((name, index) => [name, (index + 1).toString(16).repeat(64)]),
  );
  for (const [name, service] of Object.entries(model.services)) {
    const image = imageObservations?.[service.image] ?? {
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [service.image],
      Os: "linux",
      Architecture: "arm64",
      Config: {
        Cmd: ["node", "dist/fixed.js"],
        Entrypoint: null,
        Env: ["PATH=/usr/bin"],
        WorkingDir: "/app",
        ...(["client-edge", "internal-tls"].includes(name)
          ? { ExposedPorts: { "80/tcp": {}, "443/tcp": {}, "443/udp": {}, "2019/tcp": {} } }
          : {}),
      },
    };
    const health = service.healthcheck;
    const config = {
      Image: service.image,
      Cmd: service.command ?? image.Config.Cmd ?? null,
      Entrypoint: service.entrypoint ?? image.Config.Entrypoint ?? null,
      StopSignal: service.stop_signal ?? image.Config.StopSignal ?? null,
      Env: Object.entries({
        ...Object.fromEntries(
          (image.Config.Env ?? []).map((value) => {
            const at = value.indexOf("=");
            return [value.slice(0, at), value.slice(at + 1)];
          }),
        ),
        ...service.environment,
      }).map(([key, value]) => `${key}=${value}`),
      User: service.user,
      WorkingDir: service.working_dir ?? image.Config.WorkingDir ?? "",
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Labels: {
        ...service.labels,
        "com.docker.compose.project": project,
        "com.docker.compose.service": name,
        "com.docker.compose.oneoff": "False",
      },
      ...(health
        ? {
            Healthcheck: {
              Test: health.test,
              Interval: durations[health.interval] ?? 0,
              Timeout: durations[health.timeout] ?? 0,
              StartPeriod: durations[health.start_period] ?? 0,
              Retries: health.retries,
            },
          }
        : image.Config.Healthcheck
          ? { Healthcheck: structuredClone(image.Config.Healthcheck) }
          : {}),
    };
    const assigned = {};
    for (const key of Object.keys(service.networks ?? {}))
      assigned[networks[key].Name] = {
        NetworkID: networks[key].Id,
        IPAddress: "",
        GlobalIPv6Address: "",
      };
    const command = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])];
    const row = {
      Id: relatedIds[name],
      Image: image.Id,
      Created: "2026-10-17T22:00:00.000Z",
      Platform: "linux",
      RestartCount: 0,
      State: {
        Status: "created",
        Running: false,
        Paused: false,
        Dead: false,
        ExitCode: 0,
        OOMKilled: false,
      },
      Config: config,
      Path: command[0],
      Args: command.slice(1),
      AppArmorProfile: "docker-default",
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        Init: true,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        CapDrop: ["ALL"],
        CapAdd: null,
        PortBindings:
          name === "client-edge" ? { "8443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }] } : {},
        PublishAllPorts: false,
        Devices: [],
        DeviceRequests: null,
        GroupAdd: null,
        VolumesFrom: null,
        Links: null,
        ExtraHosts: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        UsernsMode: "",
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: service.pids_limit,
        Memory: service.mem_limit,
        NanoCpus: Math.round(Number(service.cpus) * 1e9),
        LogConfig: { Type: "json-file", Config: { "max-file": "2", "max-size": "2m" } },
        Tmpfs: Object.fromEntries(
          (service.tmpfs ?? []).map((value) => {
            const at = value.indexOf(":");
            return [value.slice(0, at), value.slice(at + 1)];
          }),
        ),
        NetworkMode: service.network_mode
          ? `container:${relatedIds.meilisearch}`
          : Object.keys(assigned)[0],
      },
      Mounts: (service.volumes ?? []).map((value) => ({
        Type: "bind",
        Source: value.source,
        Destination: value.target,
        RW: !(value.read_only ?? false),
        Propagation: "rprivate",
      })),
      NetworkSettings: {
        Networks: assigned,
        Ports: {
          ...Object.fromEntries(
            Object.keys(image.Config.ExposedPorts ?? {}).map((port) => [port, null]),
          ),
          [name === "client-edge" ? "8443/tcp" : "4000/tcp"]: null,
        },
      },
    };
    containers[name] = row;
    contracts[name] = {
      serviceName: name,
      service,
      image,
      project,
      owner,
      revision,
      networks,
      relatedIds,
    };
  }
  return { root, model, containers, contracts, rawNetworks };
}

const driverFixtureHash = (value) => createHash("sha256").update(value).digest("hex");
export async function runtimeDriverFixture(t, options = {}) {
  const inputSha256 = options.inputSha256 ?? "a".repeat(64);
  const f = options.base ?? (await runtimeDockerFixture(t, options)),
    directory = join(f.root, "journal");
  await mkdir(directory, { mode: 0o700 });
  const journal = await openRuntimeJournal(directory);
  t.after(() => journal.close());
  await journal.publish({
    ...options.admission,
    phase: "admitted",
    inputSha256,
    sourceRevision: "a".repeat(40),
  });
  let stopEvidenceDirectory = directory,
    stopEvidenceSha256 = inputSha256;
  const controller = new AbortController(),
    lease = createRuntimeLease(
      options.notAfterUtc ?? new Date(Date.now() + 3_600_000).toISOString(),
      controller.signal,
    );
  const calls = [],
    starts = [],
    stops = [],
    lookup = new Map(Object.values(f.containers).map((row) => [row.Id, row]));
  let created = false,
    conserved = true,
    evidenceFailed = false;
  const execute = async (_tool, args, configuration) => {
    configuration.signal.throwIfAborted();
    calls.push([...args]);
    assert.deepEqual(args.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    assert.equal(configuration.env.DOCKER_CONTEXT, undefined);
    assert.equal(configuration.env.DOCKER_HOST, undefined);
    let text;
    if (args.includes("compose")) {
      if (args.includes("config")) {
        assert(args.includes("--format") && args.at(-1) === "json");
        text = JSON.stringify(f.model);
      } else {
        assert(
          args.includes("create") &&
            args.includes("--no-build") &&
            args.includes("--no-recreate") &&
            args.at(-1) === "never",
        );
        const state = await readRuntimeJournal(directory, inputSha256);
        assert(state.complete && state.records.at(-1).event.phase === "create-intent");
        created = true;
        for (const row of Object.values(f.containers))
          for (const network of Object.values(row.NetworkSettings.Networks)) network.NetworkID = "";
        if (options.unknownCreate) throw new Error("Synthetic lost create response");
        text = "Owned synthetic containers created\n";
      }
    } else {
      const at = args.findIndex((value) => ["container", "network"].includes(value));
      assert(at >= 0);
      const [family, operation, ...rest] = args.slice(at);
      if (operation === "ls")
        text =
          family === "network" || !created
            ? ""
            : `${Object.keys(f.containers)
                .map((name) => f.contracts[name].relatedIds[name])
                .join("\n")}\n`;
      else if (family === "network" && operation === "inspect")
        text = JSON.stringify(Object.values(f.rawNetworks));
      else if (operation === "inspect")
        text = JSON.stringify(
          rest.map((id) => {
            assert(lookup.has(id));
            return lookup.get(id);
          }),
        );
      else if (operation === "start") {
        const row = lookup.get(rest[0]);
        assert(row);
        const state = await readRuntimeJournal(directory, inputSha256);
        assert(state.complete && state.records.at(-1).event.phase === "start-intent");
        const name = row.Config.Labels["com.docker.compose.service"];
        starts.push(name);
        const oneShot = ["migrate", "azure-canary", "search-bootstrap"].includes(name);
        row.State = {
          ...row.State,
          Status: oneShot ? "exited" : "running",
          Running: !oneShot,
          Health: { Status: "healthy" },
        };
        for (const [networkName, network] of Object.entries(row.NetworkSettings.Networks)) {
          const raw = Object.values(f.rawNetworks).find((item) => item.Name === networkName);
          network.NetworkID = raw.Id;
          network.IPAddress =
            f.model.services[name].networks[
              networkName.slice(f.model.name.length + 1)
            ].ipv4_address;
        }
        if (name === "client-edge")
          row.NetworkSettings.Ports = {
            ...row.NetworkSettings.Ports,
            "8443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
          };
        text = `${row.Id}\n`;
      } else if (operation === "stop") {
        const row = lookup.get(rest.at(-1));
        assert(row);
        const name = row.Config.Labels["com.docker.compose.service"];
        assert.equal(rest[0], "--timeout");
        assert.equal(rest[1], name === "worker" ? "610" : name === "api" ? "305" : "30");
        if (!evidenceFailed && !options.brokenJournalCleanup) {
          const state = await readRuntimeJournal(stopEvidenceDirectory, stopEvidenceSha256);
          assert(state.records.at(-1).event.phase === "stop-intent");
        }
        stops.push(name);
        if (options.stopFailure === name) throw new Error("Controlled native stop refusal");
        row.State = { ...row.State, Status: "exited", Running: false, ExitCode: 0 };
        if (name === "client-edge")
          row.NetworkSettings.Ports = Object.fromEntries(
            Object.keys(row.NetworkSettings.Ports).map((port) => [port, null]),
          );
        text = `${row.Id}\n`;
      } else {
        assert.equal(operation, "logs");
        text = '{"kind":"synthetic-maintenance-output"}\n';
      }
    }
    return {
      text,
      bytes: Buffer.byteLength(text),
      sha256: driverFixtureHash(text),
      stderrBytes: 0,
      stderrSha256: driverFixtureHash(""),
    };
  };
  const activeJournal = {
    conserve: () => journal.conserve(),
    publish: async (event) => {
      if (options.failStopEvidence && ["stop-intent", "stopped"].includes(event.phase)) {
        evidenceFailed = true;
        throw new Error("Synthetic journal loss");
      }
      return journal.publish(event);
    },
  };
  const imageObservations = Object.fromEntries(
    Object.values(f.contracts).map((contract) => [contract.service.image, contract.image]),
  );
  const driverInput = {
    root: f.root,
    clientAccess: options.clientAccess ?? null,
    apiDeadlineNs: options.apiDeadlineNs,
    dockerConfig: join(f.root, "docker-config"),
    project: f.model.name,
    owner: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(40),
    images: references,
    docker: { path: "/usr/bin/docker", sha256: "d".repeat(64) },
    imageObservations,
    lease,
    journal: activeJournal,
    async conserve() {
      assert(conserved, "Protected input changed");
    },
  };
  const driver = await openRuntimeDocker(driverInput, execute);
  return {
    useStopEvidence(path, sha256) {
      stopEvidenceDirectory = path;
      stopEvidenceSha256 = sha256;
    },
    driverInput,
    execute,
    ...f,
    driver,
    journal,
    directory,
    calls,
    starts,
    stops,
    controller,
    substitute: () => {
      conserved = false;
    },
  };
}
