import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
const persistentServices = ["postgres", "meilisearch", "minio", "mailpit"];

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
    minio: {
      interval: "10s",
      retries: 20,
      start_period: "10s",
      test: [
        "CMD-SHELL",
        "curl --fail --silent http://127.0.0.1:9000/minio/health/ready >/dev/null",
      ],
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

function bootstrapCommand() {
  return `${[
    'mc alias set local http://minio:9000 "$${MINIO_ROOT_USER}" "$${MINIO_ROOT_PASSWORD}"',
    "mc mb --ignore-existing local/nutrition-private-exports",
    "mc mb --ignore-existing local/nutrition-erasure-ledger",
    "mc anonymous set none local/nutrition-private-exports",
    "mc anonymous set none local/nutrition-erasure-ledger",
    "mc admin policy create local nutrition-export-writer /policies/export-writer-policy.json",
    "mc admin policy create local nutrition-export-reader /policies/export-reader-policy.json",
    "mc admin policy create local nutrition-erasure-writer /policies/erasure-writer-policy.json",
    "mc admin policy create local nutrition-erasure-restore /policies/erasure-restore-policy.json",
    'mc admin user add local "$${EXPORT_WRITE_USER}" "$${EXPORT_WRITE_PASSWORD}"',
    'mc admin user add local "$${EXPORT_READ_USER}" "$${EXPORT_READ_PASSWORD}"',
    'mc admin user add local "$${ERASURE_WRITE_USER}" "$${ERASURE_WRITE_PASSWORD}"',
    'mc admin user add local "$${ERASURE_RESTORE_USER}" "$${ERASURE_RESTORE_PASSWORD}"',
    'mc admin policy attach local nutrition-export-writer --user "$${EXPORT_WRITE_USER}"',
    'mc admin policy attach local nutrition-export-reader --user "$${EXPORT_READ_USER}"',
    'mc admin policy attach local nutrition-erasure-writer --user "$${ERASURE_WRITE_USER}"',
    'mc admin policy attach local nutrition-erasure-restore --user "$${ERASURE_RESTORE_USER}"',
    "mc version suspend local/nutrition-private-exports",
    "mc version enable local/nutrition-erasure-ledger",
  ].join("\n")}\n`;
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
    minio: {
      command: ["server", "/data", "--console-address", ":9001"],
      entrypoint: null,
      environment: {
        MINIO_ROOT_PASSWORD: "protected-test-value",
        MINIO_ROOT_USER: "protected-test-value",
      },
      image:
        "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
    },
    "minio-bootstrap": {
      command: [bootstrapCommand()],
      entrypoint: ["/bin/sh", "-eu", "-c"],
      environment: {
        ERASURE_RESTORE_PASSWORD: "protected-test-value",
        ERASURE_RESTORE_USER: "protected-test-value",
        ERASURE_WRITE_PASSWORD: "protected-test-value",
        ERASURE_WRITE_USER: "protected-test-value",
        EXPORT_READ_PASSWORD: "protected-test-value",
        EXPORT_READ_USER: "protected-test-value",
        EXPORT_WRITE_PASSWORD: "protected-test-value",
        EXPORT_WRITE_USER: "protected-test-value",
        MINIO_ROOT_PASSWORD: "protected-test-value",
        MINIO_ROOT_USER: "protected-test-value",
      },
      image:
        "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
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
      minio: {
        ...runtime("minio"),
        healthcheck: healthcheck("minio"),
        networks: network,
        ports: [configPort(9000), configPort(9001)],
        restart: "unless-stopped",
        volumes: [namedVolume("minio-data", "/data")],
      },
      "minio-bootstrap": {
        ...runtime("minio-bootstrap"),
        depends_on: { minio: { condition: "service_healthy", required: true } },
        networks: network,
        restart: "no",
        volumes: [
          {
            bind: {},
            read_only: true,
            source: resolve(repositoryRoot, "infra/minio"),
            target: "/policies",
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
      "minio-data": { name: `${projectName}_minio-data` },
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
    service("minio", [9000, 9001], { publishedPorts: publishedPorts.get("minio") }),
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
  { currentUid = 1000, environment = { PATH: "/usr/bin" }, fileMetadata = safeMetadata() } = {},
) {
  const messages = [];
  let error;
  try {
    startLocalInfrastructure({
      currentUid,
      environment,
      inspectFile: () => fileMetadata,
      run: runner.run,
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
      ["docker", [...composePrefix, "run", "--rm", "--no-deps", "--no-tty", "minio-bootstrap"]],
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
    "[local-infra] MinIO bootstrap completed.",
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
      config.services.minio.healthcheck.test[1] =
        "curl --fail --silent http://127.0.0.1:9000/minio/health/live >/dev/null";
    },
    (config) => {
      config.services.mailpit.healthcheck.disable = true;
    },
    (config) => {
      config.services["minio-bootstrap"].volumes[0].read_only = false;
    },
    (config) => {
      config.services["minio-bootstrap"].ports = [configPort(9000)];
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
      config.services["minio-bootstrap"].command[0] +=
        "mc rb --force local/nutrition-private-exports\n";
    },
    (config) => {
      config.services["minio-bootstrap"].command[0] = config.services[
        "minio-bootstrap"
      ].command[0].replace("mc mb --ignore-existing", "mc mb");
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
    { call: 5, count: 6, stage: "MinIO bootstrap" },
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
  assert.match(composeSource, /http:\/\/127\.0\.0\.1:9000\/minio\/health\/ready/u);
  assert.doesNotMatch(composeSource, /minio\/health\/live/u);
  assert.match(localRunbook, /http:\/\/127\.0\.0\.1:9000\/minio\/health\/ready/u);
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
