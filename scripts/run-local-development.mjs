import { spawn as spawnProcess } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  localDevelopmentSupervisorGraceMaximumMs,
  localDevelopmentSupervisorGraceMs,
  parseServiceShutdownGraceMs,
} from "./local-development-shutdown-budget.mjs";
import { bootstrapScopedMeiliKeys } from "./scoped-meili-keys.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const envFile = resolve(repositoryRoot, ".env");
const generatedKeyPattern = /^[a-f0-9]{64}$/u;
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const maximumPrivateEnvironmentBytes = 1_048_576;
const moduleRequire = createRequire(import.meta.url);
let pinnedDotenvParse;

const safeRuntimeEnvironmentFields = Object.freeze([
  "CI",
  "COLORTERM",
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NPM_CONFIG_CAFILE",
  "PATH",
  "PNPM_HOME",
  "PNPM_STORE_DIR",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "npm_config_cafile",
  "pnpm_config_store_dir",
]);

export const apiOnlyApplicationRuntimeEnvironmentFields = Object.freeze([
  "API_HOST",
  "API_PORT",
  "DATABASE_APPLICATION_NAME",
  "DATABASE_CONNECTION_TIMEOUT_MS",
  "DATABASE_POOL_MAX",
  "DATABASE_RESTORE_EPOCH",
  "DATABASE_SSL_MODE",
  "DATABASE_STATEMENT_TIMEOUT_MS",
  "DATABASE_URL",
  "DEVICE_CHALLENGE_HMAC_KEY",
  "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
  "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
  "ERASURE_STATUS_CAPABILITY_HMAC_KEY",
  "EXPORT_ARTIFACT_BUCKET",
  "EXPORT_ARTIFACT_CURRENT_KEY_ID",
  "EXPORT_ARTIFACT_DIRECTORY",
  "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
  "EXPORT_ARTIFACT_ENDPOINT",
  "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
  "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES",
  "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW",
  "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY",
  "EXPORT_ARTIFACT_READ_MAX_DOWNLOADS_PER_WINDOW",
  "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES",
  "EXPORT_ARTIFACT_READ_RATE_WINDOW_MS",
  "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
  "EXPORT_ARTIFACT_READ_SESSION_TOKEN",
  "EXPORT_ARTIFACT_READ_SPOOL_DIR",
  "EXPORT_ARTIFACT_READ_SPOOL_MAX_AGE_MS",
  "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION",
  "EXPORT_ARTIFACT_REGION",
  "EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS",
  "EXPORT_ARTIFACT_STORE",
  "LOG_LEVEL",
  "MEILI_SEARCH_KEY",
  "MEILI_URL",
  "NODE_ENV",
  "READINESS_TIMEOUT_MS",
  "RETENTION_FEATURES_ENABLED",
  "SEARCH_CURSOR_SECRET",
  "SEARCH_DB_MAX_CONCURRENCY",
  "SEARCH_DB_MAX_QUEUE",
  "SEARCH_REQUEST_TIMEOUT_MS",
  "SERVICE_VERSION",
  "SHUTDOWN_GRACE_MS",
]);

export const applicationRuntimeEnvironmentFields = Object.freeze([
  "API_HOST",
  "API_INTERNAL_URL",
  "API_PORT",
  "DATABASE_APPLICATION_NAME",
  "DATABASE_CONNECTION_TIMEOUT_MS",
  "DATABASE_POOL_MAX",
  "DATABASE_RESTORE_EPOCH",
  "DATABASE_SSL_MODE",
  "DATABASE_STATEMENT_TIMEOUT_MS",
  "DATABASE_URL",
  "DEVICE_CHALLENGE_HMAC_KEY",
  "ERASURE_REPLAY_LEDGER_BUCKET",
  "ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID",
  "ERASURE_REPLAY_LEDGER_DIRECTORY",
  "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS",
  "ERASURE_REPLAY_LEDGER_ENDPOINT",
  "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID",
  "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS",
  "ERASURE_REPLAY_LEDGER_REGION",
  "ERASURE_REPLAY_LEDGER_STORE",
  "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
  "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
  "ERASURE_REPLAY_LEDGER_WRITE_SESSION_TOKEN",
  "ERASURE_STATUS_CAPABILITY_HMAC_KEY",
  "EXPO_PUBLIC_API_URL",
  "EXPORT_ARTIFACT_BUCKET",
  "EXPORT_ARTIFACT_CURRENT_KEY_ID",
  "EXPORT_ARTIFACT_DELETE_VERSION_POLICY",
  "EXPORT_ARTIFACT_DIRECTORY",
  "EXPORT_ARTIFACT_ENCRYPTION_KEYS",
  "EXPORT_ARTIFACT_ENDPOINT",
  "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
  "EXPORT_ARTIFACT_READ_MAX_ARTIFACT_BYTES",
  "EXPORT_ARTIFACT_READ_MAX_BYTES_PER_WINDOW",
  "EXPORT_ARTIFACT_READ_MAX_CONCURRENCY",
  "EXPORT_ARTIFACT_READ_MAX_DOWNLOADS_PER_WINDOW",
  "EXPORT_ARTIFACT_READ_MAX_RESERVED_BYTES",
  "EXPORT_ARTIFACT_READ_RATE_WINDOW_MS",
  "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
  "EXPORT_ARTIFACT_READ_SESSION_TOKEN",
  "EXPORT_ARTIFACT_READ_SPOOL_DIR",
  "EXPORT_ARTIFACT_READ_SPOOL_MAX_AGE_MS",
  "EXPORT_ARTIFACT_READ_SPOOL_PROTECTION",
  "EXPORT_ARTIFACT_REGION",
  "EXPORT_ARTIFACT_REQUEST_TIMEOUT_MS",
  "EXPORT_ARTIFACT_STORE",
  "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
  "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
  "EXPORT_ARTIFACT_WRITE_SESSION_TOKEN",
  "LOG_LEVEL",
  "MEILI_ADMIN_KEY",
  "MEILI_SEARCH_KEY",
  "MEILI_TASK_OBSERVER_KEY",
  "MEILI_URL",
  "NODE_ENV",
  "POLL_INTERVAL_MS",
  "READINESS_TIMEOUT_MS",
  "RETENTION_EXPORT_SPOOL_DIR",
  "RETENTION_EXPORT_SPOOL_MAX_AGE_MS",
  "RETENTION_EXPORT_SPOOL_MAX_BYTES",
  "RETENTION_EXPORT_SPOOL_PROTECTION",
  "RETENTION_FEATURES_ENABLED",
  "RETENTION_WORKER_ID",
  "SEARCH_CURSOR_SECRET",
  "SEARCH_DB_MAX_CONCURRENCY",
  "SEARCH_DB_MAX_QUEUE",
  "SEARCH_REBUILD_BATCH_SIZE",
  "SEARCH_REBUILD_EVENT_BATCH_SIZE",
  "SEARCH_REBUILD_SPOOL_DIR",
  "SEARCH_REBUILD_SPOOL_MAX_BYTES",
  "SEARCH_REBUILD_SPOOL_MAX_DOCUMENTS",
  "SEARCH_REBUILD_WORKER_ID",
  "SEARCH_REQUEST_TIMEOUT_MS",
  "SEARCH_TASK_TIMEOUT_MS",
  "SERVICE_VERSION",
  "SHUTDOWN_GRACE_MS",
  "WEB_PUBLIC_ORIGIN",
]);

export const localDevelopmentProfiles = Object.freeze({
  apiOnly: Object.freeze({
    cliArguments: Object.freeze(["--api-only"]),
    serviceShutdownPhases: 1,
    turboArguments: Object.freeze([
      "exec",
      "turbo",
      "run",
      "dev",
      "--filter=@nutrition-tracker/api",
      "--concurrency=7",
    ]),
  }),
  full: Object.freeze({
    cliArguments: Object.freeze([]),
    serviceShutdownPhases: 2,
    turboArguments: Object.freeze(["exec", "turbo", "run", "dev", "--concurrency=11"]),
  }),
});

function required(environment, field) {
  const value = environment[field];
  if (!value) throw new Error(`Local development requires ${field}`);
  return value;
}

function exactPort(environment, field) {
  const value = required(environment, field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Local development requires an exact ${field}`);
  }
  return value;
}

function selectedProfile(arguments_) {
  if (arguments_.length === 0) return localDevelopmentProfiles.full;
  if (
    arguments_.length === localDevelopmentProfiles.apiOnly.cliArguments.length &&
    arguments_.every(
      (argument, index) => argument === localDevelopmentProfiles.apiOnly.cliArguments[index],
    )
  ) {
    return localDevelopmentProfiles.apiOnly;
  }
  throw new Error("Unsupported local development invocation");
}

function pickEnvironment(environment, fields) {
  const picked = {};
  for (const field of fields) {
    if (environment[field] !== undefined) picked[field] = environment[field];
  }
  return picked;
}

function parsePrivateEnvironment(source, dependencies) {
  const parse =
    dependencies.parseEnvironment ??
    (() => {
      pinnedDotenvParse ??= createRequire(moduleRequire.resolve("dotenv-cli/package.json"))(
        "dotenv",
      ).parse;
      return pinnedDotenvParse;
    })();
  const parsed = parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid private environment");
  }
  const environment = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) ||
      ["__proto__", "constructor", "prototype"].includes(field) ||
      typeof value !== "string"
    ) {
      throw new Error("invalid private environment");
    }
    environment[field] = value;
  }
  return environment;
}

function loopbackError(target) {
  return new Error(`Local development requires the loopback ${target} fixture`);
}

function exactLoopbackHttpUrl(environment, field, port, target) {
  const value = required(environment, field);
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw loopbackError(target);
  }
  if (
    value !== `http://127.0.0.1:${port}` ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port !== port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw loopbackError(target);
  }
  return value;
}

function exactOptionalLoopbackOrigin(environment, field, target) {
  if (environment[field] === undefined) return;
  const value = required(environment, field);
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw loopbackError(target);
  }
  const port = endpoint.port;
  if (
    !/^[1-9][0-9]{0,4}$/u.test(port) ||
    Number(port) > 65_535 ||
    String(Number(port)) !== port ||
    value !== `http://127.0.0.1:${port}` ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw loopbackError(target);
  }
}

function exactLocalDatabaseUrl(environment) {
  const value = required(environment, "DATABASE_URL");
  const port = exactPort(environment, "POSTGRES_PORT");
  const databaseName = required(environment, "POSTGRES_DB");
  const password = required(environment, "POSTGRES_PASSWORD");
  const user = required(environment, "POSTGRES_USER");
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw loopbackError("PostgreSQL");
  }
  let endpointUser;
  let endpointPassword;
  let endpointPath;
  try {
    endpointUser = decodeURIComponent(endpoint.username);
    endpointPassword = decodeURIComponent(endpoint.password);
    endpointPath = decodeURIComponent(endpoint.pathname);
  } catch {
    throw loopbackError("PostgreSQL");
  }
  if (
    endpoint.protocol !== "postgresql:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port !== port ||
    endpointUser !== user ||
    endpointPassword !== password ||
    endpointPath !== `/${databaseName}` ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw loopbackError("PostgreSQL");
  }
  if (required(environment, "DATABASE_SSL_MODE") !== "disable") {
    throw loopbackError("PostgreSQL");
  }
}

function assertLocalObjectStorage(environment) {
  const port = exactPort(environment, "MINIO_API_PORT");
  exactLoopbackHttpUrl(environment, "EXPORT_ARTIFACT_ENDPOINT", port, "export artifact store");
  exactLoopbackHttpUrl(
    environment,
    "ERASURE_REPLAY_LEDGER_ENDPOINT",
    port,
    "erasure replay ledger",
  );
  if (environment.S3_ENDPOINT !== undefined) {
    exactLoopbackHttpUrl(environment, "S3_ENDPOINT", port, "legacy S3-compatible store");
  }
  for (const field of ["EXPORT_ARTIFACT_STORE", "ERASURE_REPLAY_LEDGER_STORE"]) {
    if (!["filesystem", "s3"].includes(required(environment, field))) {
      throw loopbackError("object storage");
    }
  }

  const credentialFields = [
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
  ];
  const credentials = credentialFields.map((field) => required(environment, field));
  if (new Set(credentials).size !== credentials.length) {
    throw new Error("Local development requires split object-storage credentials");
  }
}

export function assertLocalDevelopmentEnvironment(environment) {
  if (
    environment.NODE_TLS_REJECT_UNAUTHORIZED ||
    environment.GIT_SSL_NO_VERIFY ||
    environment.CURL_INSECURE ||
    [environment.NPM_CONFIG_STRICT_SSL, environment.npm_config_strict_ssl].some(
      (value) => value?.trim().toLowerCase() === "false",
    )
  ) {
    throw new Error("Local development refuses a TLS verification override");
  }

  parseServiceShutdownGraceMs(environment);

  if (required(environment, "API_HOST") !== "127.0.0.1") {
    throw loopbackError("API listener");
  }
  const apiPort = exactPort(environment, "API_PORT");
  exactLoopbackHttpUrl(environment, "API_INTERNAL_URL", apiPort, "internal API");
  exactOptionalLoopbackOrigin(environment, "WEB_PUBLIC_ORIGIN", "web origin");
  if (environment.EXPO_PUBLIC_API_URL !== undefined) {
    exactLoopbackHttpUrl(environment, "EXPO_PUBLIC_API_URL", apiPort, "mobile API");
  }

  exactLocalDatabaseUrl(environment);

  const port = exactPort(environment, "MEILI_PORT");
  exactLoopbackHttpUrl(environment, "MEILI_URL", port, "Meilisearch");
  const masterKey = required(environment, "MEILI_MASTER_KEY");
  if (
    masterKey.length < 16 ||
    masterKey.length > 512 ||
    masterKey.trim() !== masterKey ||
    /[\r\n]/u.test(masterKey)
  ) {
    throw loopbackError("Meilisearch");
  }

  assertLocalObjectStorage(environment);
}

export function localDevelopmentChildEnvironment(
  environment,
  scopedKeys,
  profile = localDevelopmentProfiles.full,
) {
  const searchKey = scopedKeys?.MEILI_SEARCH_KEY;
  const adminKey = scopedKeys?.MEILI_ADMIN_KEY;
  const taskObserverKey = scopedKeys?.MEILI_TASK_OBSERVER_KEY;
  if (
    typeof searchKey !== "string" ||
    typeof adminKey !== "string" ||
    typeof taskObserverKey !== "string" ||
    !generatedKeyPattern.test(searchKey) ||
    !generatedKeyPattern.test(adminKey) ||
    !generatedKeyPattern.test(taskObserverKey) ||
    searchKey === adminKey ||
    searchKey === taskObserverKey ||
    adminKey === taskObserverKey ||
    searchKey === environment.MEILI_MASTER_KEY ||
    adminKey === environment.MEILI_MASTER_KEY ||
    taskObserverKey === environment.MEILI_MASTER_KEY
  ) {
    throw new Error("Local development requires split scoped Meilisearch keys");
  }
  const environmentFields =
    profile === localDevelopmentProfiles.apiOnly
      ? apiOnlyApplicationRuntimeEnvironmentFields
      : profile === localDevelopmentProfiles.full
        ? applicationRuntimeEnvironmentFields
        : undefined;
  if (!environmentFields) throw new Error("Unsupported local development profile");
  const scopedEnvironment =
    profile === localDevelopmentProfiles.apiOnly
      ? { MEILI_SEARCH_KEY: searchKey }
      : {
          MEILI_ADMIN_KEY: adminKey,
          MEILI_SEARCH_KEY: searchKey,
          MEILI_TASK_OBSERVER_KEY: taskObserverKey,
        };
  return {
    ...pickEnvironment(environment, safeRuntimeEnvironmentFields),
    ...pickEnvironment(environment, environmentFields),
    ...scopedEnvironment,
  };
}

export class LocalDevelopmentProcessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "LocalDevelopmentProcessError";
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

class LocalDevelopmentLaunchError extends Error {}

function terminationGraceMs(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > localDevelopmentSupervisorGraceMaximumMs
  ) {
    throw new Error("Local development requires a bounded termination grace period");
  }
  return value;
}

function monitorChild(child, dependencies, requestedGraceMs) {
  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.kill !== "function" ||
    !Number.isInteger(child.pid) ||
    child.pid < 1
  ) {
    throw new LocalDevelopmentLaunchError();
  }
  const runtime = dependencies.signalRuntime ?? process;
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const platform = dependencies.platform ?? process.platform;
  const groupExists =
    dependencies.groupExists ??
    ((pid) => {
      try {
        if (platform === "win32") return child.exitCode === null && child.signalCode === null;
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    });
  const graceMs = terminationGraceMs(requestedGraceMs);
  let forceTimer;
  let postKillTimer;
  let pollTimer;
  let forwardedSignal;
  let signalCount = 0;
  let settled = false;
  let terminalOutcome;
  let escalationComplete = false;
  let terminationStarted = false;
  let cleanupFailed = false;
  let killSent = false;
  const groupPollIntervalMs = Math.max(1, Math.min(25, Math.floor(graceMs / 4)));
  const postKillVerificationMs = Math.max(100, Math.min(1_000, graceMs));
  const signalHandlers = new Map();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });

  const dispose = () => {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (postKillTimer !== undefined) clearTimeout(postKillTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    for (const [signal, handler] of signalHandlers) runtime.removeListener(signal, handler);
    signalHandlers.clear();
  };
  const groupStillExists = () => {
    try {
      return groupExists(child.pid);
    } catch {
      cleanupFailed = true;
      return true;
    }
  };
  const signalTree = (signal) => {
    try {
      if (platform !== "win32") {
        kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error?.code !== "ESRCH") return false;
    }
    return true;
  };
  const completeEscalation = () => {
    if (settled || escalationComplete || killSent) return;
    if (!groupStillExists()) {
      escalationComplete = true;
      settleIfReady();
      return;
    }
    if (!signalTree("SIGKILL")) cleanupFailed = true;
    killSent = true;
    postKillTimer = setTimeout(() => {
      postKillTimer = undefined;
      if (settled || escalationComplete) return;
      if (!groupStillExists()) {
        escalationComplete = true;
        terminalOutcome ??= { kind: "error" };
        settleIfReady();
        return;
      }
      cleanupFailed = true;
      escalationComplete = true;
      terminalOutcome ??= { kind: "error" };
      settleIfReady();
    }, postKillVerificationMs);
    startGroupPolling();
  };
  const startTermination = (signal) => {
    if (terminationStarted) return;
    terminationStarted = true;
    if (!signalTree(signal)) cleanupFailed = true;
    forceTimer = setTimeout(completeEscalation, graceMs);
  };
  const pollGroup = () => {
    pollTimer = undefined;
    if (settled || escalationComplete || terminalOutcome === undefined) return;
    if (!groupStillExists()) {
      escalationComplete = true;
      settleIfReady();
      return;
    }
    pollTimer = setTimeout(pollGroup, groupPollIntervalMs);
  };
  const startGroupPolling = () => {
    if (pollTimer === undefined && !escalationComplete && terminalOutcome !== undefined) {
      pollTimer = setTimeout(pollGroup, groupPollIntervalMs);
    }
  };
  const settleIfReady = () => {
    if (settled || terminalOutcome === undefined) return;
    if (!escalationComplete) {
      if (!groupStillExists()) {
        escalationComplete = true;
      } else {
        startTermination(forwardedSignal ?? "SIGTERM");
        startGroupPolling();
        return;
      }
    }
    settled = true;
    dispose();
    if (terminalOutcome.kind === "error" || cleanupFailed) {
      rejectCompletion(new LocalDevelopmentLaunchError());
      return;
    }
    resolveCompletion({
      signal: forwardedSignal ?? terminalOutcome.signal ?? null,
      status: terminalOutcome.status,
    });
  };
  const fail = () => {
    terminalOutcome ??= { kind: "error" };
    settleIfReady();
  };
  const forward = (signal) => {
    if (settled) return;
    forwardedSignal ??= signal;
    signalCount += 1;
    if (signalCount === 1) {
      startTermination(signal);
    } else {
      completeEscalation();
    }
    settleIfReady();
  };

  for (const signal of forwardedSignals) {
    const handler = () => forward(signal);
    signalHandlers.set(signal, handler);
    runtime.on(signal, handler);
  }
  child.once("error", fail);
  child.once("exit", (status, signal) => {
    terminalOutcome ??= { kind: "exit", signal, status };
    settleIfReady();
  });

  return {
    completion,
    terminate() {
      forward("SIGTERM");
      return completion;
    },
  };
}

function startMonitoredChild(command, arguments_, options, dependencies, graceMs) {
  const spawn = dependencies.spawn ?? spawnProcess;
  let child;
  try {
    child = spawn(command, arguments_, { ...options, detached: true });
  } catch {
    throw new LocalDevelopmentLaunchError();
  }
  try {
    return monitorChild(child, dependencies, graceMs);
  } catch {
    try {
      child?.kill?.("SIGKILL");
    } catch {
      // The generic launch failure remains authoritative.
    }
    throw new LocalDevelopmentLaunchError();
  }
}

function assertChildSuccess(result) {
  if (result.signal) {
    throw new LocalDevelopmentProcessError(`Local development stopped on ${result.signal}`, {
      signal: result.signal,
    });
  }
  if (result.status !== 0) {
    const exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw new LocalDevelopmentProcessError(
      `Local development failed with exit code ${result.status ?? "unknown"}`,
      { exitCode },
    );
  }
}

export async function runLocalDevelopment(arguments_ = [], dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const bootstrap = dependencies.bootstrap ?? bootstrapScopedMeiliKeys;
  const profile = selectedProfile(arguments_);
  assertLocalDevelopmentEnvironment(environment);
  const supervisorGraceMs =
    dependencies.terminationGraceMs ??
    localDevelopmentSupervisorGraceMs(
      parseServiceShutdownGraceMs(environment),
      profile.serviceShutdownPhases,
    );
  const scopedKeys = await bootstrap({
    endpoint: required(environment, "MEILI_URL"),
    masterKey: required(environment, "MEILI_MASTER_KEY"),
    port: required(environment, "MEILI_PORT"),
  });
  const childEnvironment = localDevelopmentChildEnvironment(environment, scopedKeys, profile);

  let monitor;
  try {
    monitor = startMonitoredChild(
      "pnpm",
      profile.turboArguments,
      {
        cwd: repositoryRoot,
        env: childEnvironment,
        shell: false,
        stdio: "inherit",
      },
      dependencies,
      supervisorGraceMs,
    );
  } catch {
    throw new Error("Unable to start local development");
  }
  let result;
  try {
    result = await monitor.completion;
  } catch {
    throw new Error("Unable to start local development");
  }
  assertChildSuccess(result);
}

export async function runLocalDevelopmentWithPrivateEnv(arguments_ = [], dependencies = {}) {
  selectedProfile(arguments_);
  const open = dependencies.open ?? openSync;
  const fstat = dependencies.fstat ?? fstatSync;
  const close = dependencies.close ?? closeSync;
  const read = dependencies.read ?? ((descriptor) => readFileSync(descriptor, "utf8"));
  const getuid =
    dependencies.getuid ??
    (() => (typeof process.getuid === "function" ? process.getuid() : undefined));
  let descriptor;
  let source;
  try {
    descriptor = open(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstat(descriptor);
    const uid = getuid();
    if (
      uid === undefined ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.uid !== uid ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 1 ||
      metadata.size > maximumPrivateEnvironmentBytes
    ) {
      throw new Error("invalid metadata");
    }
    source = read(descriptor);
    const sourceBytes = typeof source === "string" ? Buffer.byteLength(source, "utf8") : -1;
    if (
      typeof source !== "string" ||
      sourceBytes !== metadata.size ||
      sourceBytes > maximumPrivateEnvironmentBytes
    ) {
      throw new Error("invalid private environment");
    }
  } catch {
    if (descriptor !== undefined) {
      try {
        close(descriptor);
      } catch {
        // The generic metadata failure remains authoritative.
      }
    }
    throw new Error("Local development requires an owner-only regular .env file");
  }

  try {
    close(descriptor);
  } catch {
    throw new Error("Unable to close the private local development environment");
  }

  let privateEnvironment;
  try {
    privateEnvironment = parsePrivateEnvironment(source, dependencies);
  } catch {
    throw new Error("Unable to load the private local development environment");
  }
  await runLocalDevelopment(arguments_, {
    ...dependencies,
    environment: {
      ...(dependencies.environment ?? process.env),
      ...privateEnvironment,
    },
  });
}

const entrypoint = process.argv[1];
if (entrypoint && resolve(entrypoint) === scriptPath) {
  try {
    await runLocalDevelopmentWithPrivateEnv(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LocalDevelopmentProcessError) {
      if (error.signal && forwardedSignals.includes(error.signal)) {
        try {
          process.kill(process.pid, error.signal);
        } catch {
          process.exitCode = 1;
        }
      } else {
        process.stderr.write(`${error.message}.\n`);
        process.exitCode = error.exitCode ?? 1;
      }
    } else {
      process.stderr.write("Local development bootstrap failed.\n");
      process.exitCode = 1;
    }
  }
}
