import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareLocalObjectStore } from "./local-object-store.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const envFile = resolve(repositoryRoot, ".env");
const composeFile = resolve(repositoryRoot, "infra/docker/compose.yml");
const projectName = "nutrition-tracker-local";
const composePrefix = [
  "compose",
  "--project-name",
  projectName,
  "--env-file",
  envFile,
  "-f",
  composeFile,
];
const persistentServices = ["postgres", "meilisearch", "object-store", "mailpit"];
const allServices = persistentServices;
const expectedTargetPorts = new Map([
  ["postgres", [5432]],
  ["meilisearch", [7700]],
  ["object-store", [9000]],
  ["mailpit", [1025, 8025]],
]);
const expectedVolumeMounts = new Map([
  ["postgres", { source: "postgres-data", target: "/var/lib/postgresql/data" }],
  ["meilisearch", { source: "meilisearch-data", target: "/meili_data" }],
  ["object-store", { source: "object-store-data", target: "/data" }],
  ["mailpit", null],
]);
const expectedHealthchecks = new Map([
  [
    "postgres",
    {
      interval: "5s",
      retries: 20,
      start_period: "10s",
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB} -h 127.0.0.1"],
      timeout: "5s",
    },
  ],
  [
    "meilisearch",
    {
      interval: "10s",
      retries: 20,
      start_period: "15s",
      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:7700/health >/dev/null"],
      timeout: "5s",
    },
  ],
  [
    "object-store",
    {
      interval: "10s",
      retries: 20,
      start_period: "10s",
      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:9000/readyz >/dev/null"],
      timeout: "5s",
    },
  ],
  [
    "mailpit",
    {
      interval: "10s",
      retries: 20,
      start_period: "5s",
      test: ["CMD", "/mailpit", "readyz"],
      timeout: "5s",
    },
  ],
]);
const expectedServiceRuntime = new Map([
  [
    "postgres",
    {
      command: null,
      entrypoint: null,
      environmentKeys: ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"],
      image:
        "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
      keys: [
        "command",
        "entrypoint",
        "environment",
        "healthcheck",
        "image",
        "networks",
        "ports",
        "restart",
        "volumes",
      ],
    },
  ],
  [
    "meilisearch",
    {
      command: null,
      entrypoint: null,
      environmentKeys: ["MEILI_ENV", "MEILI_MASTER_KEY", "MEILI_NO_ANALYTICS"],
      image:
        "getmeili/meilisearch:v1.32.0@sha256:61b1c86c459fa52d0653516f573702791e611574737dc76175ae9d2628c911f5",
      keys: [
        "command",
        "entrypoint",
        "environment",
        "healthcheck",
        "image",
        "networks",
        "ports",
        "restart",
        "volumes",
      ],
    },
  ],
  [
    "object-store",
    {
      command: [
        "server",
        "-dir=/data",
        "-ip=127.0.0.1",
        "-ip.bind=127.0.0.1",
        "-filer",
        "-s3",
        "-s3.ip.bind=0.0.0.0",
        "-s3.port=9000",
        "-s3.port.iceberg=0",
        "-s3.port.lance=0",
        "-s3.config=/config/s3.json",
        "-s3.iam.readOnly=true",
        "-s3.autoCreateBucket=false",
        "-s3.allowDeleteBucketNotEmpty=false",
        "-volume.max=16",
        "-master.volumeSizeLimitMB=64",
        "-master.telemetry=false",
      ],
      entrypoint: null,
      environmentKeys: null,
      image:
        "ghcr.io/chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882",
      keys: [
        "command",
        "entrypoint",
        "healthcheck",
        "image",
        "networks",
        "ports",
        "restart",
        "volumes",
        "cpus",
        "mem_limit",
        "pids_limit",
      ],
    },
  ],
  [
    "mailpit",
    {
      command: null,
      entrypoint: null,
      environmentKeys: null,
      image:
        "axllent/mailpit:v1.29.4@sha256:0530ab1c658a0f225f148e617522db84053bd1e4879e664c23de5fee44ad6819",
      keys: ["command", "entrypoint", "healthcheck", "image", "networks", "ports", "restart"],
    },
  ],
]);

const STAGE_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 330_000;
const BOOTSTRAP_TIMEOUT_MS = 300_000;

export class LocalInfrastructureError extends Error {
  constructor(stage) {
    super(`Local infrastructure failed during ${stage}.`);
    this.name = "LocalInfrastructureError";
    this.stage = stage;
  }
}

function fail(stage) {
  throw new LocalInfrastructureError(stage);
}

function execute(run, environment, stage, args, timeout, command = "docker") {
  const result = run(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });

  if (
    result?.error !== undefined ||
    result?.signal !== null ||
    result?.status !== 0 ||
    typeof result?.stdout !== "string" ||
    typeof result?.stderr !== "string"
  ) {
    fail(stage);
  }
  return result.stdout;
}

function parseJson(stage, value) {
  try {
    return JSON.parse(value);
  } catch {
    fail(stage);
  }
}

function sameStrings(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function exactObjectKeys(value, expected, stage) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(stage);
  }
  const actual = Object.keys(value).sort();
  if (!sameStrings(actual, [...expected].sort())) fail(stage);
}

function currentUserId() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function inspectEnvironmentFile() {
  return lstatSync(envFile, { throwIfNoEntry: false });
}

function assertEnvironmentFile(metadata, uid) {
  if (
    !Number.isInteger(uid) ||
    typeof metadata?.isFile !== "function" ||
    typeof metadata?.isSymbolicLink !== "function" ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    fail("environment-file validation");
  }
}

function assertDockerBoundary(run, environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (
      (name.startsWith("DOCKER_") || name.startsWith("COMPOSE_")) &&
      value !== undefined &&
      (typeof value !== "string" || value.trim() !== "")
    ) {
      fail("Docker boundary validation");
    }
  }

  const inspected = parseJson(
    "Docker boundary validation",
    execute(
      run,
      environment,
      "Docker boundary validation",
      ["context", "inspect"],
      STAGE_TIMEOUT_MS,
    ),
  );
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    fail("Docker boundary validation");
  }

  const context = inspected[0];
  const endpoint = context?.Endpoints?.docker;
  const tlsMaterial = context?.TLSMaterial ?? {};
  if (
    context?.Name !== "default" ||
    endpoint?.Host !== "unix:///var/run/docker.sock" ||
    endpoint.SkipTLSVerify !== false ||
    typeof tlsMaterial !== "object" ||
    tlsMaterial === null ||
    Array.isArray(tlsMaterial) ||
    Object.keys(tlsMaterial).length !== 0
  ) {
    fail("Docker boundary validation");
  }

  const serverOs = execute(
    run,
    environment,
    "Docker boundary validation",
    ["version", "--format", "{{.Server.Os}}"],
    STAGE_TIMEOUT_MS,
  ).trim();
  const serverIdentity = execute(
    run,
    environment,
    "Docker boundary validation",
    ["info", "--format", "{{.Name}}|{{.OperatingSystem}}"],
    STAGE_TIMEOUT_MS,
  ).trim();
  if (serverOs !== "linux" || serverIdentity !== "docker-desktop|Docker Desktop") {
    fail("Docker boundary validation");
  }
}

function publishedPort(value, stage) {
  const parsed =
    typeof value === "string" && /^[1-9][0-9]{0,4}$/u.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) fail(stage);
  return parsed;
}

function assertNetworkAttachment(service, stage) {
  exactObjectKeys(service?.networks, ["nutrition-local"], stage);
  if (service.networks["nutrition-local"] !== null) fail(stage);
}

function assertServiceRuntime(serviceName, service, stage) {
  const expected = expectedServiceRuntime.get(serviceName);
  exactObjectKeys(service, expected.keys, stage);
  if (service.image !== expected.image) fail(stage);

  for (const name of ["command", "entrypoint"]) {
    const actual = service[name];
    const wanted = expected[name];
    if (wanted === null) {
      if (actual !== null) fail(stage);
    } else if (!Array.isArray(actual) || !sameStrings(actual, wanted)) {
      fail(stage);
    }
  }

  if (
    serviceName === "object-store" &&
    (service.cpus !== 2 || service.mem_limit !== "1073741824" || service.pids_limit !== 256)
  )
    fail(stage);
  if (expected.environmentKeys === null) {
    if (service.environment !== undefined) fail(stage);
  } else {
    exactObjectKeys(service.environment, expected.environmentKeys, stage);
  }
  if (
    serviceName === "meilisearch" &&
    (service.environment.MEILI_ENV !== "development" ||
      service.environment.MEILI_NO_ANALYTICS !== "true")
  ) {
    fail(stage);
  }
}

function assertHealthcheck(serviceName, service, stage) {
  const actual = service?.healthcheck;
  const expected = expectedHealthchecks.get(serviceName);
  exactObjectKeys(actual, Object.keys(expected), stage);
  if (!Array.isArray(actual.test) || !sameStrings(actual.test, expected.test)) fail(stage);
  for (const name of ["interval", "retries", "start_period", "timeout"]) {
    if (actual[name] !== expected[name]) fail(stage);
  }
}

function assertPersistentVolume(serviceName, service, stage) {
  const expected = expectedVolumeMounts.get(serviceName);
  const volumes = service?.volumes ?? [];
  if (!Array.isArray(volumes)) fail(stage);
  if (expected === null) {
    if (volumes.length !== 0) fail(stage);
    return;
  }
  if (volumes.length !== (serviceName === "object-store" ? 2 : 1)) fail(stage);
  if (serviceName === "object-store") {
    const configMount = volumes[1];
    exactObjectKeys(configMount, ["bind", "read_only", "source", "target", "type"], stage);
    exactObjectKeys(configMount.bind, ["create_host_path"], stage);
    if (configMount.bind.create_host_path !== false) fail(stage);
    if (
      configMount.type !== "bind" ||
      configMount.source !== resolve(repositoryRoot, ".local-data/object-store/s3.json") ||
      configMount.target !== "/config/s3.json" ||
      configMount.read_only !== true
    )
      fail(stage);
  }
  const mount = volumes[0];
  exactObjectKeys(mount, ["source", "target", "type", "volume"], stage);
  exactObjectKeys(mount.volume, [], stage);
  if (
    mount?.type !== "volume" ||
    mount.source !== expected.source ||
    mount.target !== expected.target
  ) {
    fail(stage);
  }
}

export function assertComposeConfiguration(value) {
  const stage = "Compose boundary validation";
  const config = parseJson(stage, value);
  exactObjectKeys(config, ["name", "networks", "services", "volumes"], stage);
  if (config?.name !== projectName) fail(stage);
  exactObjectKeys(config?.services, allServices, stage);
  exactObjectKeys(
    config?.volumes,
    ["postgres-data", "meilisearch-data", "object-store-data"],
    stage,
  );
  exactObjectKeys(config?.networks, ["nutrition-local"], stage);

  const network = config.networks["nutrition-local"];
  exactObjectKeys(network, ["driver", "ipam", "name"], stage);
  exactObjectKeys(network.ipam, [], stage);
  if (network.driver !== "bridge" || network.name !== `${projectName}_nutrition-local`) {
    fail(stage);
  }
  for (const volumeName of ["postgres-data", "meilisearch-data", "object-store-data"]) {
    const volume = config.volumes[volumeName];
    exactObjectKeys(volume, ["name"], stage);
    if (volume.name !== `${projectName}_${volumeName}`) fail(stage);
  }

  const seenHostPorts = new Set();
  const expectedPublishedPorts = new Map();
  for (const serviceName of persistentServices) {
    const service = config.services[serviceName];
    const targets = expectedTargetPorts.get(serviceName);
    if (
      typeof service !== "object" ||
      service === null ||
      Array.isArray(service) ||
      service.restart !== "unless-stopped"
    ) {
      fail(stage);
    }
    assertServiceRuntime(serviceName, service, stage);
    assertHealthcheck(serviceName, service, stage);
    assertNetworkAttachment(service, stage);
    assertPersistentVolume(serviceName, service, stage);

    if (!Array.isArray(service.ports) || service.ports.length !== targets.length) fail(stage);
    const mappings = service.ports
      .map((port) => {
        exactObjectKeys(port, ["host_ip", "mode", "protocol", "published", "target"], stage);
        if (
          port?.mode !== "ingress" ||
          port.host_ip !== "127.0.0.1" ||
          port.protocol !== "tcp" ||
          !Number.isInteger(port.target)
        ) {
          fail(stage);
        }
        const published = publishedPort(port.published, stage);
        if (seenHostPorts.has(published)) fail(stage);
        seenHostPorts.add(published);
        return { published, target: port.target };
      })
      .sort((left, right) => left.target - right.target);
    if (mappings.some(({ target }, index) => target !== targets[index])) fail(stage);
    expectedPublishedPorts.set(serviceName, mappings);
  }

  return expectedPublishedPorts;
}

function parseComposePs(value) {
  const trimmed = value.trim();
  if (trimmed === "") fail("persistent-service postcondition");

  if (trimmed.startsWith("[")) {
    const parsed = parseJson("persistent-service postcondition", trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  return trimmed.split(/\r?\n/u).map((line) => {
    return parseJson("persistent-service postcondition", line);
  });
}

function assertPersistentServices(value, expectedPublishedPorts) {
  const entries = parseComposePs(value);
  if (entries.length !== persistentServices.length) {
    fail("persistent-service postcondition");
  }

  const seen = new Set();
  for (const entry of entries) {
    const service = entry?.Service;
    const expectedPorts = expectedPublishedPorts.get(service);
    if (
      expectedPorts === undefined ||
      seen.has(service) ||
      entry.State !== "running" ||
      entry.Health !== "healthy" ||
      !Array.isArray(entry.Publishers)
    ) {
      fail("persistent-service postcondition");
    }
    seen.add(service);

    const publishers = entry.Publishers.map((publisher) => {
      if (
        publisher?.URL !== "127.0.0.1" ||
        publisher.Protocol !== "tcp" ||
        !Number.isInteger(publisher.PublishedPort) ||
        publisher.PublishedPort < 1 ||
        publisher.PublishedPort > 65_535 ||
        !Number.isInteger(publisher.TargetPort)
      ) {
        fail("persistent-service postcondition");
      }
      return { published: publisher.PublishedPort, target: publisher.TargetPort };
    }).sort((left, right) => left.target - right.target);

    if (
      publishers.length !== expectedPorts.length ||
      publishers.some(({ published, target }, index) => {
        return (
          target !== expectedPorts[index].target || published !== expectedPorts[index].published
        );
      })
    ) {
      fail("persistent-service postcondition");
    }
  }

  if (persistentServices.some((service) => !seen.has(service))) {
    fail("persistent-service postcondition");
  }
}

function defaults(options) {
  return {
    currentUid: currentUserId(),
    environment: process.env,
    inspectFile: inspectEnvironmentFile,
    run: spawnSync,
    prepare: prepareLocalObjectStore,
    write: (message) => process.stdout.write(`${message}\n`),
    ...options,
  };
}

export function startLocalInfrastructure(options = {}) {
  const { currentUid, environment, inspectFile, run, write, prepare } = defaults(options);
  assertEnvironmentFile(inspectFile(), currentUid);
  assertDockerBoundary(run, environment);
  write("[local-infra] Docker boundary accepted.");

  const renderedConfig = execute(
    run,
    environment,
    "Compose configuration",
    [...composePrefix, "config", "--format", "json"],
    STAGE_TIMEOUT_MS,
  );
  const expectedPublishedPorts = assertComposeConfiguration(renderedConfig);
  write("[local-infra] Compose configuration accepted.");
  try {
    prepare({ port: expectedPublishedPorts.get("object-store")[0].published });
  } catch {
    fail("object-store preparation");
  }

  execute(
    run,
    environment,
    "persistent-service startup",
    [...composePrefix, "up", "-d", "--wait", "--wait-timeout", "300", ...persistentServices],
    START_TIMEOUT_MS,
  );
  write("[local-infra] Persistent services are healthy.");

  execute(
    run,
    environment,
    "object-store bootstrap",
    [resolve(repositoryRoot, "scripts/local-object-store.mjs"), "bootstrap"],
    BOOTSTRAP_TIMEOUT_MS,
    process.execPath,
  );
  write("[local-infra] Object-store bootstrap completed.");

  const status = execute(
    run,
    environment,
    "persistent-service postcondition",
    [...composePrefix, "ps", "--format", "json"],
    STAGE_TIMEOUT_MS,
  );
  assertPersistentServices(status, expectedPublishedPorts);
  write("[local-infra] Four loopback-only persistent services remain healthy.");
}

export function statusLocalInfrastructure(options = {}) {
  const { currentUid, environment, inspectFile, run, write } = defaults(options);
  assertEnvironmentFile(inspectFile(), currentUid);
  assertDockerBoundary(run, environment);
  write("[local-infra] Docker boundary accepted.");

  const renderedConfig = execute(
    run,
    environment,
    "Compose configuration",
    [...composePrefix, "config", "--format", "json"],
    STAGE_TIMEOUT_MS,
  );
  const expectedPublishedPorts = assertComposeConfiguration(renderedConfig);
  write("[local-infra] Compose configuration accepted.");

  const status = execute(
    run,
    environment,
    "persistent-service postcondition",
    [...composePrefix, "ps", "--format", "json"],
    STAGE_TIMEOUT_MS,
  );
  assertPersistentServices(status, expectedPublishedPorts);
  write("[local-infra] Four loopback-only persistent services remain healthy.");
}

export function stopLocalInfrastructure(options = {}) {
  const { currentUid, environment, inspectFile, run, write } = defaults(options);
  assertEnvironmentFile(inspectFile(), currentUid);
  assertDockerBoundary(run, environment);
  write("[local-infra] Docker boundary accepted.");

  execute(
    run,
    environment,
    "local infrastructure shutdown",
    [...composePrefix, "down"],
    START_TIMEOUT_MS,
  );
  write("[local-infra] Persistent services stopped; named volumes retained.");
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  if (process.argv.length !== 2) {
    process.stderr.write("[local-infra] No arguments are accepted.\n");
    process.exitCode = 1;
  } else {
    try {
      startLocalInfrastructure();
    } catch (error) {
      const message =
        error instanceof LocalInfrastructureError
          ? error.message
          : "Local infrastructure failed before completion.";
      process.stderr.write(`[local-infra] ${message}\n`);
      process.exitCode = 1;
    }
  }
}
