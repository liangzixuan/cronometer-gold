import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertComposeConfiguration,
  LocalInfrastructureError,
  startLocalInfrastructure,
  statusLocalInfrastructure,
  stopLocalInfrastructure,
} from "./local-infra-up.mjs";

const testPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(testPath), "..");
const envFile = resolve(repositoryRoot, ".env");
const composeFile = resolve(repositoryRoot, "infra/docker/compose.yml");
const projectName = "nutrition-tracker-local";
const upScriptPath = resolve(repositoryRoot, "scripts/local-infra-up.mjs");
const downScriptPath = resolve(repositoryRoot, "scripts/local-infra-down.mjs");
const statusScriptPath = resolve(repositoryRoot, "scripts/local-infra-status.mjs");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const rootReadme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const dockerReadme = readFileSync(resolve(repositoryRoot, "infra/docker/README.md"), "utf8");
const localRunbook = readFileSync(
  resolve(repositoryRoot, "infra/runbooks/local-development.md"),
  "utf8",
);
const composeSource = readFileSync(composeFile, "utf8");

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

function success(stdout = "") {
  return { error: undefined, signal: null, status: 0, stderr: "", stdout };
}

function context({
  host = "unix:///var/run/docker.sock",
  name = "default",
  skipTlsVerify = false,
  tlsMaterial = {},
} = {}) {
  return JSON.stringify([
    {
      Endpoints: { docker: { Host: host, SkipTLSVerify: skipTlsVerify } },
      Name: name,
      TLSMaterial: tlsMaterial,
    },
  ]);
}

function safeMetadata(overrides = {}) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    nlink: 1,
    uid: 1000,
    ...overrides,
  };
}

function configPort(target, published = target, overrides = {}) {
  return {
    host_ip: "127.0.0.1",
    mode: "ingress",
    protocol: "tcp",
    published: String(published),
    target,
    ...overrides,
  };
}

function namedVolume(source, target) {
  return { source, target, type: "volume", volume: {} };
}

function healthcheck(serviceName) {
  const checks = {
    mailpit: {
      interval: "10s",
      retries: 20,
      start_period: "5s",
      test: ["CMD", "/mailpit", "readyz"],
      timeout: "5s",
    },
    meilisearch: {
      interval: "10s",
      retries: 20,
      start_period: "15s",
      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:7700/health >/dev/null"],
      timeout: "5s",
    },
    "object-store": {
      interval: "10s",
      retries: 20,
      start_period: "10s",
      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:9000/readyz >/dev/null"],
      timeout: "5s",
    },
    postgres: {
      interval: "5s",
      retries: 20,
      start_period: "10s",
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB} -h 127.0.0.1"],
      timeout: "5s",
    },
  };
  return checks[serviceName];
}

function runtime(serviceName) {
  const common = { command: null, entrypoint: null };
  const runtimes = {
    mailpit: {
      ...common,
      image:
        "axllent/mailpit:v1.29.4@sha256:0530ab1c658a0f225f148e617522db84053bd1e4879e664c23de5fee44ad6819",
    },
    meilisearch: {
      ...common,
      environment: {
        MEILI_ENV: "development",
        MEILI_MASTER_KEY: "protected-test-value",
        MEILI_NO_ANALYTICS: "true",
      },
      image:
        "getmeili/meilisearch:v1.32.0@sha256:61b1c86c459fa52d0653516f573702791e611574737dc76175ae9d2628c911f5",
    },
    "object-store": {
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
      cpus: 2,
      mem_limit: "1073741824",
      pids_limit: 256,
      image:
        "ghcr.io/chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882",
    },
    postgres: {
      ...common,
      environment: {
        POSTGRES_DB: "protected-test-value",
        POSTGRES_PASSWORD: "protected-test-value",
        POSTGRES_USER: "protected-test-value",
      },
      image:
        "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    },
  };
  return runtimes[serviceName];
}

function composeConfiguration() {
  const network = { "nutrition-local": null };
  return {
    name: projectName,
    networks: {
      "nutrition-local": {
        driver: "bridge",
        ipam: {},
        name: `${projectName}_nutrition-local`,
      },
    },
    services: {
      mailpit: {
        ...runtime("mailpit"),
        healthcheck: healthcheck("mailpit"),
        networks: network,
        ports: [configPort(1025), configPort(8025)],
        restart: "unless-stopped",
      },
      meilisearch: {
        ...runtime("meilisearch"),
        healthcheck: healthcheck("meilisearch"),
        networks: network,
        ports: [configPort(7700)],
        restart: "unless-stopped",
        volumes: [namedVolume("meilisearch-data", "/meili_data")],
      },
      "object-store": {
        ...runtime("object-store"),
        healthcheck: healthcheck("object-store"),
        networks: network,
        ports: [configPort(9000)],
        restart: "unless-stopped",
        volumes: [
          namedVolume("object-store-data", "/data"),
          {
            bind: { create_host_path: false },
            read_only: true,
            source: resolve(repositoryRoot, ".local-data/object-store/s3.json"),
            target: "/config/s3.json",
            type: "bind",
          },
        ],
      },
      postgres: {
        ...runtime("postgres"),
        healthcheck: healthcheck("postgres"),
        networks: network,
        ports: [configPort(5432)],
        restart: "unless-stopped",
        volumes: [namedVolume("postgres-data", "/var/lib/postgresql/data")],
      },
    },
    volumes: {
      "meilisearch-data": { name: `${projectName}_meilisearch-data` },
      "object-store-data": { name: `${projectName}_object-store-data` },
      "postgres-data": { name: `${projectName}_postgres-data` },
    },
  };
}

function service(serviceName, targetPorts, { publishedPorts = targetPorts, ...overrides } = {}) {
  return {
    Health: "healthy",
    Publishers: targetPorts.map((targetPort, index) => ({
      Protocol: "tcp",
      PublishedPort: publishedPorts[index],
      TargetPort: targetPort,
      URL: "127.0.0.1",
    })),
    Service: serviceName,
    State: "running",
    ...overrides,
  };
}

function persistentStatus({ index, publishedPorts = new Map(), value } = {}) {
  const entries = [
    service("postgres", [5432], { publishedPorts: publishedPorts.get("postgres") }),
    service("meilisearch", [7700], { publishedPorts: publishedPorts.get("meilisearch") }),
    service("object-store", [9000], { publishedPorts: publishedPorts.get("object-store") }),
    service("mailpit", [1025, 8025], { publishedPorts: publishedPorts.get("mailpit") }),
  ];
  if (index !== undefined) entries[index] = { ...entries[index], ...value };
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function createRunner(replacements = new Map()) {
  const calls = [];
  const outputs = [
    success(context()),
    success("linux\n"),
    success("docker-desktop|Docker Desktop\n"),
    success(JSON.stringify(composeConfiguration())),
    success(),
    success(),
    success(persistentStatus()),
  ];
  return {
    calls,
    run(command, args, options) {
      const index = calls.length;
      calls.push({ args, command, options });
      return replacements.get(index) ?? outputs[index];
    },
  };
}

function callStart(
  runner,
  {
    currentUid = 1000,
    environment = { PATH: "/usr/bin" },
    fileMetadata = safeMetadata(),
    prepare = () => {},
  } = {},
) {
  const messages = [];
  let error;
  try {
    startLocalInfrastructure({
      currentUid,
      environment,
      inspectFile: () => fileMetadata,
      run: runner.run,
      prepare,
      write: (message) => messages.push(message),
    });
  } catch (raised) {
    error = raised;
  }
  return { error, messages };
}

function callStatus(
  runner,
  { currentUid = 1000, environment = { PATH: "/usr/bin" }, fileMetadata = safeMetadata() } = {},
) {
  const messages = [];
  let error;
  try {
    statusLocalInfrastructure({
      currentUid,
      environment,
      inspectFile: () => fileMetadata,
      run: runner.run,
      prepare: () => {},
      write: (message) => messages.push(message),
    });
  } catch (raised) {
    error = raised;
  }
  return { error, messages };
}

function runWith(runner, options = {}) {
  const outcome = callStart(runner, options);
  if (outcome.error !== undefined) throw outcome.error;
  return outcome.messages;
}

function callStop(
  runner,
  { currentUid = 1000, environment = { PATH: "/usr/bin" }, fileMetadata = safeMetadata() } = {},
) {
  const messages = [];
  let error;
  try {
    stopLocalInfrastructure({
      currentUid,
      environment,
      inspectFile: () => fileMetadata,
      run: runner.run,
      prepare: () => {},
      write: (message) => messages.push(message),
    });
  } catch (raised) {
    error = raised;
  }
  return { error, messages };
}

test("uses the exact shell-free fail-closed local lifecycle", () => {
  const runner = createRunner();
  const messages = runWith(runner);
  assert.deepEqual(
    runner.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", ["context", "inspect"]],
      ["docker", ["version", "--format", "{{.Server.Os}}"]],
      ["docker", ["info", "--format", "{{.Name}}|{{.OperatingSystem}}"]],
      ["docker", [...composePrefix, "config", "--format", "json"]],
      [
        "docker",
        [...composePrefix, "up", "-d", "--wait", "--wait-timeout", "300", ...persistentServices],
      ],
      [process.execPath, [resolve(repositoryRoot, "scripts/local-object-store.mjs"), "bootstrap"]],
      ["docker", [...composePrefix, "ps", "--format", "json"]],
    ],
  );
  assert.equal(
    runner.calls.every(({ options }) => options.shell === false && options.stdio[0] === "ignore"),
    true,
  );
  assert.equal(
    runner.calls.some(({ args }) => {
      return args.some((argument) =>
        ["down", "--volumes", "volume", "pull", "build", "--remove-orphans"].includes(argument),
      );
    }),
    false,
  );
  assert.deepEqual(messages, [
    "[local-infra] Docker boundary accepted.",
    "[local-infra] Compose configuration accepted.",
    "[local-infra] Persistent services are healthy.",
    "[local-infra] Object-store bootstrap completed.",
    "[local-infra] Four loopback-only persistent services remain healthy.",
  ]);
});

test("requires an owned regular mode-0600 single-link environment file before Docker", () => {
  const cases = [
    null,
    safeMetadata({ isFile: () => false }),
    safeMetadata({ isSymbolicLink: () => true }),
    safeMetadata({ mode: 0o100644 }),
    safeMetadata({ nlink: 2 }),
    safeMetadata({ uid: 1001 }),
  ];
  for (const fileMetadata of cases) {
    const runner = createRunner();
    const { error } = callStart(runner, { fileMetadata });
    assert.ok(error instanceof LocalInfrastructureError);
    assert.equal(error.stage, "environment-file validation");
    assert.equal(runner.calls.length, 0);
  }
});

test("binds Docker Desktop and rejects ambient Docker or Compose controls", () => {
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_REMOVE_ORPHANS",
    "COMPOSE_FILE",
  ]) {
    const runner = createRunner();
    const { error } = callStart(runner, {
      environment: { PATH: "/usr/bin", [name]: "unreviewed" },
    });
    assert.ok(error instanceof LocalInfrastructureError);
    assert.equal(error.stage, "Docker boundary validation");
    assert.equal(runner.calls.length, 0);
  }

  for (const output of [
    context({ host: "tcp://127.0.0.1:2375" }),
    context({ host: "unix:///tmp/alternate-engine.sock" }),
    context({ name: "alternate" }),
    context({ skipTlsVerify: true }),
    context({ tlsMaterial: { ca: ["unreviewed"] } }),
  ]) {
    const runner = createRunner(new Map([[0, success(output)]]));
    const { error } = callStart(runner);
    assert.ok(error instanceof LocalInfrastructureError);
    assert.equal(error.stage, "Docker boundary validation");
    assert.equal(runner.calls.length, 1);
  }

  const windows = createRunner(new Map([[1, success("windows\n")]]));
  assert.equal(callStart(windows).error?.stage, "Docker boundary validation");
  assert.equal(windows.calls.length, 3);

  const secondEngine = createRunner(new Map([[2, success("wsl-engine|Ubuntu\n")]]));
  assert.equal(callStart(secondEngine).error?.stage, "Docker boundary validation");
  assert.equal(secondEngine.calls.length, 3);

  const stopped = createRunner();
  const stopOutcome = callStop(stopped, {
    environment: { DOCKER_HOST: "tcp://remote.example:2375", PATH: "/usr/bin" },
  });
  assert.equal(stopOutcome.error?.stage, "Docker boundary validation");
  assert.equal(stopped.calls.length, 0);
});

test("rejects unsafe rendered Compose topology before any mutation or secret output", () => {
  const mutations = [
    (config) => {
      config.services["object-store"].mem_limit = "2147483648";
    },
    (config) => {
      config.services["object-store"].pids_limit = 512;
    },
    (config) => {
      config.services["object-store"].volumes[1].bind.create_host_path = true;
    },
    (config) => {
      config.services["object-store"].volumes[1].bind = {};
    },
    (config) => {
      config.services["object-store"].volumes[1].source = "/unreviewed/s3.json";
    },
    (config) => {
      config.name = "shadow-project";
    },
    (config) => {
      config.services.api = {};
    },
    (config) => {
      config.services.postgres.ports[0].host_ip = "0.0.0.0";
    },
    (config) => {
      config.services.postgres.ports[0].target = 5433;
    },
    (config) => {
      config.services.meilisearch.ports[0].published = "5432";
    },
    (config) => {
      config.services.postgres.healthcheck = null;
    },
    (config) => {
      config.services.meilisearch.healthcheck.test = ["NONE"];
    },
    (config) => {
      config.services["object-store"].healthcheck.test[1] =
        "curl --fail --silent http://127.0.0.1:9000/minio/health/live >/dev/null";
    },
    (config) => {
      config.services.mailpit.healthcheck.disable = true;
    },
    (config) => {
      config.services["object-store"].volumes[1].read_only = false;
    },
    (config) => {
      config.services["object-store"].ports.push(configPort(9001));
    },
    (config) => {
      config.volumes.unreviewed = {};
    },
    (config) => {
      config.volumes["postgres-data"].external = true;
    },
    (config) => {
      config.volumes["postgres-data"].name = "stale-or-sensitive-volume";
    },
    (config) => {
      config.networks["nutrition-local"].external = true;
    },
    (config) => {
      config.networks["nutrition-local"].name = "shared-network";
    },
    (config) => {
      config.services.postgres.privileged = true;
    },
    (config) => {
      config.services.postgres.volumes[0].volume.nocopy = true;
    },
    (config) => {
      config.services.postgres.ports[0].name = "unreviewed";
    },
    (config) => {
      config.services["object-store"].cpus = 3;
    },
    (config) => {
      config.services["object-store"].command.push("-s3.autoCreateBucket=true");
    },
  ];

  for (const mutate of mutations) {
    const config = composeConfiguration();
    config.services.postgres.environment.POSTGRES_PASSWORD = "protected-secret-config";
    mutate(config);
    const runner = createRunner(new Map([[3, success(JSON.stringify(config))]]));
    const outcome = callStart(runner);
    assert.ok(outcome.error instanceof LocalInfrastructureError);
    assert.equal(outcome.error.stage, "Compose boundary validation");
    assert.equal(runner.calls.length, 4);
    assert.equal(
      JSON.stringify({ error: outcome.error.message, messages: outcome.messages }).includes(
        "protected-secret",
      ),
      false,
    );
    assert.equal(
      runner.calls.some(({ args }) => args.includes("up") || args.includes("run")),
      false,
    );
  }
});

test("stops at the first failed lifecycle stage without exposing child output", () => {
  const stages = [
    { call: 3, count: 4, stage: "Compose configuration" },
    { call: 4, count: 5, stage: "persistent-service startup" },
    { call: 5, count: 6, stage: "object-store bootstrap" },
    { call: 6, count: 7, stage: "persistent-service postcondition" },
  ];
  for (const { call, count, stage } of stages) {
    const runner = createRunner(
      new Map([
        [
          call,
          {
            error: undefined,
            signal: null,
            status: 1,
            stderr: "protected-secret-child-output",
            stdout: "protected-secret-child-output",
          },
        ],
      ]),
    );
    const outcome = callStart(runner);
    assert.ok(outcome.error instanceof LocalInfrastructureError);
    assert.equal(outcome.error.stage, stage);
    assert.equal(runner.calls.length, count);
    assert.equal(
      JSON.stringify({ messages: outcome.messages, raised: outcome.error.message }).includes(
        "protected-secret",
      ),
      false,
    );
  }
});

test("matches healthy loopback publishers to the rendered host-port mapping", () => {
  const cases = [
    persistentStatus({ index: 0, value: { State: "exited" } }),
    persistentStatus({ index: 1, value: { Health: "starting" } }),
    persistentStatus({
      index: 2,
      value: {
        Publishers: [
          {
            Protocol: "tcp",
            PublishedPort: 9000,
            TargetPort: 9000,
            URL: "0.0.0.0",
          },
          {
            Protocol: "tcp",
            PublishedPort: 9001,
            TargetPort: 9001,
            URL: "127.0.0.1",
          },
        ],
      },
    }),
    persistentStatus({ index: 3, value: { Service: "minio-bootstrap" } }),
    persistentStatus({ index: 0, value: { Publishers: [] } }),
    persistentStatus({
      index: 0,
      value: {
        Publishers: [{ ...service("postgres", [5432]).Publishers[0], PublishedPort: "5432" }],
      },
    }),
    persistentStatus({
      index: 0,
      value: {
        Publishers: [{ ...service("postgres", [5432]).Publishers[0], PublishedPort: 15_432 }],
      },
    }),
    persistentStatus({
      index: 1,
      value: { Publishers: service("meilisearch", [7701]).Publishers },
    }),
  ];

  for (const output of cases) {
    const runner = createRunner(new Map([[6, success(output)]]));
    const outcome = callStart(runner);
    assert.ok(outcome.error instanceof LocalInfrastructureError);
    assert.equal(outcome.error.stage, "persistent-service postcondition");
  }

  const custom = composeConfiguration();
  custom.services.postgres.ports[0].published = "15432";
  const customStatus = persistentStatus({
    publishedPorts: new Map([["postgres", [15_432]]]),
  });
  const customRunner = createRunner(
    new Map([
      [3, success(JSON.stringify(custom))],
      [6, success(customStatus)],
    ]),
  );
  assert.equal(
    runWith(customRunner).at(-1),
    "[local-infra] Four loopback-only persistent services remain healthy.",
  );
});

test("uses the same guarded boundary and effective model for status", () => {
  const runner = createRunner(new Map([[4, success(persistentStatus())]]));
  const outcome = callStatus(runner);
  assert.equal(outcome.error, undefined);
  assert.deepEqual(
    runner.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", ["context", "inspect"]],
      ["docker", ["version", "--format", "{{.Server.Os}}"]],
      ["docker", ["info", "--format", "{{.Name}}|{{.OperatingSystem}}"]],
      ["docker", [...composePrefix, "config", "--format", "json"]],
      ["docker", [...composePrefix, "ps", "--format", "json"]],
    ],
  );
  assert.equal(
    runner.calls.every(({ options }) => options.shell === false),
    true,
  );
  assert.deepEqual(outcome.messages, [
    "[local-infra] Docker boundary accepted.",
    "[local-infra] Compose configuration accepted.",
    "[local-infra] Four loopback-only persistent services remain healthy.",
  ]);
});

test("uses the same guarded boundary for shutdown and retains named volumes", () => {
  const runner = createRunner();
  const outcome = callStop(runner);
  assert.equal(outcome.error, undefined);
  assert.deepEqual(
    runner.calls.map(({ command, args }) => [command, args]),
    [
      ["docker", ["context", "inspect"]],
      ["docker", ["version", "--format", "{{.Server.Os}}"]],
      ["docker", ["info", "--format", "{{.Name}}|{{.OperatingSystem}}"]],
      ["docker", [...composePrefix, "down"]],
    ],
  );
  assert.equal(
    runner.calls.every(({ options }) => options.shell === false),
    true,
  );
  assert.equal(
    runner.calls.some(
      ({ args }) => args.includes("--volumes") || args.includes("--remove-orphans"),
    ),
    false,
  );
  assert.deepEqual(outcome.messages, [
    "[local-infra] Docker boundary accepted.",
    "[local-infra] Persistent services stopped; named volumes retained.",
  ]);
});

test("locks package scripts, docs, readiness health, and no-argument CLIs", () => {
  assert.equal(packageJson.scripts["infra:up"], "node scripts/local-infra-up.mjs");
  assert.equal(packageJson.scripts["infra:down"], "node scripts/local-infra-down.mjs");
  assert.equal(packageJson.scripts["infra:status"], "node scripts/local-infra-status.mjs");
  assert.equal(
    packageJson.scripts["infra:config"],
    "docker compose --project-name nutrition-tracker-local --env-file .env -f infra/docker/compose.yml config --quiet",
  );
  for (const document of [dockerReadme, localRunbook]) {
    assert.match(document, /pnpm infra:up/u);
    assert.match(document, /pnpm infra:down/u);
    assert.match(document, /pnpm infra:status/u);
    assert.doesNotMatch(document, /up -d --wait/u);
    assert.doesNotMatch(document, /docker compose/u);
  }
  for (const document of [rootReadme, dockerReadme, localRunbook]) {
    assert.match(document, /install -m 600 \.env\.example \.env/u);
    assert.doesNotMatch(document, /cp \.env\.example \.env/u);
  }
  assert.match(composeSource, /http:\/\/127\.0\.0\.1:9000\/readyz/u);
  assert.doesNotMatch(composeSource, /minio\/health\/live/u);
  assert.match(localRunbook, /http:\/\/127\.0\.0\.1:9000\/readyz/u);
  assert.doesNotMatch(localRunbook, /minio\/health\/live/u);

  for (const path of [upScriptPath, downScriptPath, statusScriptPath]) {
    const rejected = spawnSync(process.execPath, [path, "--unreviewed"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "[local-infra] No arguments are accepted.\n");
  }
});

function composeBoundaryDiagnostic(rendered, dockerVersion, composeVersion) {
  let config;
  try {
    config = JSON.parse(rendered);
  } catch {
    config = undefined;
  }
  const mount = config?.services?.["object-store"]?.volumes?.[1];
  const bind = mount?.bind;
  const shape = (value) =>
    typeof value === "boolean"
      ? value
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;
  const keys = bind && typeof bind === "object" && !Array.isArray(bind) ? Object.keys(bind) : [];
  const known = new Set(["create_host_path", "propagation", "recursive", "selinux"]);
  return JSON.stringify({
    bindKeys: keys.filter((key) => known.has(key)).sort(),
    bindType: shape(bind),
    composeVersion: /^v?(\d+\.\d+\.\d+)\b/u.exec(composeVersion)?.[1] ?? "unavailable",
    createHostPath: shape(bind?.create_host_path),
    dockerVersion: /^Docker version (\d+\.\d+\.\d+)\b/u.exec(dockerVersion)?.[1] ?? "unavailable",
    readOnly: shape(mount?.read_only),
    unknownBindKeyCount: keys.filter((key) => !known.has(key)).length,
  });
}

test("Compose boundary diagnostics expose only versions, known keys, and boolean shapes", () => {
  const config = composeConfiguration();
  config.services.postgres.environment.POSTGRES_PASSWORD = "protected-secret";
  const mount = config.services["object-store"].volumes[1];
  mount.source = "/protected-secret";
  mount.bind = { create_host_path: "protected-secret", "protected-secret": true };
  const diagnostic = composeBoundaryDiagnostic(
    JSON.stringify(config),
    "Docker version 29.7.2, build protected-secret",
    "v5.5.0 protected-secret",
  );
  assert.doesNotMatch(diagnostic, /protected-secret/u);
  assert.deepEqual(JSON.parse(diagnostic), {
    bindKeys: ["create_host_path"],
    bindType: "object",
    composeVersion: "5.5.0",
    createHostPath: "string",
    dockerVersion: "29.7.2",
    readOnly: true,
    unknownBindKeyCount: 1,
  });
  for (const bind of [{}, { create_host_path: false }, { create_host_path: true }, null, []]) {
    mount.bind = bind;
    const summary = JSON.parse(composeBoundaryDiagnostic(JSON.stringify(config), "", ""));
    assert.equal(summary.createHostPath, bind?.create_host_path ?? "undefined");
    assert.equal(summary.dockerVersion, "unavailable");
    assert.equal(summary.composeVersion, "unavailable");
  }
  assert.equal(
    JSON.parse(composeBoundaryDiagnostic("protected-secret", "", "")).bindType,
    "undefined",
  );
});

test("accepts the genuine offline Compose render at the exact startup boundary", () => {
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--env-file",
      devNull,
      "-f",
      composeFile,
      "config",
      "--format",
      "json",
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: process.env, shell: false, timeout: 15000 },
  );
  assert.equal(rendered.status, 0, "offline Compose render must succeed");
  try {
    assertComposeConfiguration(rendered.stdout);
  } catch (error) {
    const version = (args) =>
      spawnSync("docker", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: process.env,
        shell: false,
        timeout: 15000,
      }).stdout ?? "";
    assert.fail(
      `Compose boundary rejected the genuine offline render: ${composeBoundaryDiagnostic(
        rendered.stdout,
        version(["--version"]),
        version(["compose", "version", "--short"]),
      )}; stage=${error instanceof LocalInfrastructureError ? error.stage : "unknown"}`,
    );
  }
});

test("prepares the validated rendered port and stops before service startup on private-state failure", () => {
  const config = composeConfiguration();
  config.services["object-store"].ports[0].published = "19000";
  const runner = createRunner(new Map([[3, success(JSON.stringify(config))]]));
  let selectedPort;
  const outcome = callStart(runner, {
    prepare: ({ port }) => {
      selectedPort = port;
      assert.equal(runner.calls.length, 4);
      throw new Error("protected-state");
    },
  });
  assert.equal(selectedPort, 19000);
  assert.equal(outcome.error?.stage, "object-store preparation");
  assert.equal(runner.calls.length, 4);
  assert.doesNotMatch(outcome.error.message, /protected-state/u);
});
