import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapScopedMeiliKeys } from "./scoped-meili-keys.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const envFile = resolve(repositoryRoot, ".env");
const dotenvCli = resolve(repositoryRoot, "node_modules/dotenv-cli/cli.js");

const safeRuntimeEnvironmentFields = [
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
];

const artifactIntegrationEnvironmentFields = [
  "ERASURE_REPLAY_LEDGER_BUCKET",
  "ERASURE_REPLAY_LEDGER_ENDPOINT",
  "ERASURE_REPLAY_LEDGER_REGION",
  "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
  "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
  "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
  "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
  "EXPORT_ARTIFACT_BUCKET",
  "EXPORT_ARTIFACT_ENDPOINT",
  "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
  "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
  "EXPORT_ARTIFACT_REGION",
  "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
  "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
];

const retentionIntegrationEnvironmentFields = [
  "DATABASE_URL",
  "MEILI_ADMIN_KEY",
  "MEILI_PORT",
  "MEILI_SEARCH_KEY",
  "MEILI_TASK_OBSERVER_KEY",
  "MEILI_URL",
  "MINIO_API_PORT",
  "POSTGRES_DB",
  "POSTGRES_PASSWORD",
  "POSTGRES_PORT",
  "POSTGRES_USER",
  ...artifactIntegrationEnvironmentFields,
];

const globallyForbiddenEnvironmentFields = new Set([
  "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID",
  "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY",
  "DOCKER_AUTH_CONFIG",
  "EXPO_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HEALTH_REVIEWER_PEM",
  "HEALTH_REVIEWER_PRIVATE_KEY",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SENTRY_AUTH_TOKEN",
]);
const globallyForbiddenEnvironmentPrefixes = [
  "ANDROID_SIGNING_",
  "APPLE_SIGNING_",
  "ARM_",
  "AWS_",
  "AZURE_",
  "CLOUDFLARE_",
  "EAS_",
  "GCP_",
  "GOOGLE_CLOUD_",
  "KEYSTORE_",
  "NAMECOM_",
  "NAME_COM_",
  "OCI_",
  "SIGNING_",
  "TAILSCALE_",
  "TERRAFORM_",
  "TF_VAR_",
];

function required(environment, field) {
  return requiredValue(environment[field], field);
}

function requiredValue(value, field) {
  if (!value) throw new Error(`Retention privacy drill requires ${field}`);
  return value;
}

function exactPort(environment, field) {
  const value = required(environment, field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Retention privacy drill requires an exact ${field}`);
  }
  return value;
}

function parsedUrl(value, boundary) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Retention privacy drill requires the local ${boundary} target`);
  }
}

function pickEnvironment(environment, fields) {
  const picked = {};
  for (const field of fields) {
    if (environment[field] !== undefined) picked[field] = environment[field];
  }
  return picked;
}

function withoutExternalCredentials(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([field]) =>
        !globallyForbiddenEnvironmentFields.has(field) &&
        !globallyForbiddenEnvironmentPrefixes.some((prefix) => field.startsWith(prefix)),
    ),
  );
}

function environmentForStep(environment, step) {
  const sanitized = withoutExternalCredentials(environment);
  const safeRuntime = pickEnvironment(sanitized, safeRuntimeEnvironmentFields);
  if (step.args.length === 1 && step.args[0] === "infra:status") {
    return { ...safeRuntime, ...step.environment };
  }
  if (step.environment?.RUN_ARTIFACT_STORE_INTEGRATION === "1") {
    return {
      ...safeRuntime,
      ...pickEnvironment(sanitized, artifactIntegrationEnvironmentFields),
      ...step.environment,
    };
  }
  if (step.environment?.RUN_RETENTION_WORKER_INTEGRATION === "1") {
    return {
      ...safeRuntime,
      ...pickEnvironment(sanitized, retentionIntegrationEnvironmentFields),
      ...step.environment,
    };
  }
  return { ...safeRuntime, ...step.environment };
}

export function assertRetentionPrivacyDrillEnvironment(environment) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED) {
    throw new Error("Retention privacy drill refuses a TLS verification override");
  }
  if (
    [environment.NPM_CONFIG_STRICT_SSL, environment.npm_config_strict_ssl].some(
      (value) => value?.trim().toLowerCase() === "false",
    ) ||
    environment.GIT_SSL_NO_VERIFY ||
    environment.CURL_INSECURE
  ) {
    throw new Error("Retention privacy drill refuses a TLS verification override");
  }
  const postgresPort = exactPort(environment, "POSTGRES_PORT");
  const databaseUrlValue = required(environment, "DATABASE_URL");
  const databaseUrl = parsedUrl(databaseUrlValue, "PostgreSQL Compose");
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== "127.0.0.1" ||
    databaseUrl.port !== postgresPort ||
    databaseUrl.username !== required(environment, "POSTGRES_USER") ||
    databaseUrl.password !== required(environment, "POSTGRES_PASSWORD") ||
    databaseUrl.pathname !== `/${required(environment, "POSTGRES_DB")}` ||
    databaseUrl.search ||
    databaseUrl.hash
  ) {
    throw new Error("Retention privacy drill requires the local PostgreSQL Compose target");
  }

  const minioPort = exactPort(environment, "MINIO_API_PORT");
  const expectedEndpoint = `http://127.0.0.1:${minioPort}`;
  for (const field of ["EXPORT_ARTIFACT_ENDPOINT", "ERASURE_REPLAY_LEDGER_ENDPOINT"]) {
    const value = required(environment, field);
    const url = parsedUrl(value, "MinIO Compose");
    if (
      value !== expectedEndpoint ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== minioPort ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      throw new Error("Retention privacy drill requires the local MinIO Compose target");
    }
  }
  if (
    required(environment, "EXPORT_ARTIFACT_REGION") !== "us-east-1" ||
    required(environment, "ERASURE_REPLAY_LEDGER_REGION") !== "us-east-1" ||
    required(environment, "EXPORT_ARTIFACT_BUCKET") !== "nutrition-private-exports" ||
    required(environment, "ERASURE_REPLAY_LEDGER_BUCKET") !== "nutrition-erasure-ledger"
  ) {
    throw new Error("Retention privacy drill requires the local MinIO fixture");
  }

  const meiliPort = exactPort(environment, "MEILI_PORT");
  const meiliUrlValue = required(environment, "MEILI_URL");
  const meiliUrl = parsedUrl(meiliUrlValue, "Meilisearch Compose");
  if (
    meiliUrlValue !== `http://127.0.0.1:${meiliPort}` ||
    meiliUrl.protocol !== "http:" ||
    meiliUrl.hostname !== "127.0.0.1" ||
    meiliUrl.port !== meiliPort ||
    meiliUrl.username ||
    meiliUrl.password ||
    meiliUrl.search ||
    meiliUrl.hash ||
    (meiliUrl.pathname !== "" && meiliUrl.pathname !== "/")
  ) {
    throw new Error("Retention privacy drill requires the local Meilisearch Compose target");
  }
  required(environment, "MEILI_MASTER_KEY");

  const credentialIds = [
    required(environment, "MINIO_ROOT_USER"),
    required(environment, "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID"),
    required(environment, "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID"),
    required(environment, "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID"),
    required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID"),
  ];
  const credentialSecrets = [
    required(environment, "MINIO_ROOT_PASSWORD"),
    required(environment, "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY"),
    required(environment, "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY"),
    required(environment, "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY"),
    required(environment, "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY"),
  ];
  if (
    new Set(credentialIds).size !== credentialIds.length ||
    new Set(credentialSecrets).size !== credentialSecrets.length
  ) {
    throw new Error("Retention privacy drill requires split MinIO credentials");
  }
}

export const retentionPrivacyDrillSteps = [
  {
    args: ["infra:status"],
    label: "local dependency boundary",
  },
  {
    args: [
      "--filter",
      "@nutrition-tracker/api...",
      "--filter",
      "@nutrition-tracker/worker...",
      "build",
    ],
    label: "retention workspace build",
  },
  {
    args: ["--filter", "@nutrition-tracker/artifact-store", "test:integration"],
    environment: { RUN_ARTIFACT_STORE_INTEGRATION: "1" },
    label: "split encrypted artifact-store integration",
  },
  {
    args: ["--filter", "@nutrition-tracker/api", "test:retention-integration"],
    environment: { RUN_RETENTION_WORKER_INTEGRATION: "1" },
    label: "retention export and erasure integration",
  },
];

export async function runRetentionPrivacyDrill(
  spawn = spawnSync,
  environment = process.env,
  bootstrapMeiliKeys = bootstrapScopedMeiliKeys,
) {
  assertRetentionPrivacyDrillEnvironment(environment);
  let scopedEnvironment = environment;

  for (const [index, step] of retentionPrivacyDrillSteps.entries()) {
    const result = spawn("pnpm", step.args, {
      cwd: repositoryRoot,
      env: environmentForStep(scopedEnvironment, step),
      shell: false,
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`Unable to start ${step.label}`);
    }
    if (result.status !== 0) {
      if (result.signal) throw new Error(`${step.label} stopped on signal ${result.signal}`);
      throw new Error(`${step.label} failed with exit code ${result.status ?? "unknown"}`);
    }
    if (index === 0) {
      const keys = await bootstrapMeiliKeys({
        endpoint: required(environment, "MEILI_URL"),
        masterKey: required(environment, "MEILI_MASTER_KEY"),
        port: required(environment, "MEILI_PORT"),
      });
      const searchKey = requiredValue(keys?.MEILI_SEARCH_KEY, "scoped MEILI_SEARCH_KEY");
      const adminKey = requiredValue(keys?.MEILI_ADMIN_KEY, "scoped MEILI_ADMIN_KEY");
      const taskObserverKey = requiredValue(
        keys?.MEILI_TASK_OBSERVER_KEY,
        "scoped MEILI_TASK_OBSERVER_KEY",
      );
      if (
        new Set([searchKey, adminKey, taskObserverKey]).size !== 3 ||
        [searchKey, adminKey, taskObserverKey].some((key) => key === environment.MEILI_MASTER_KEY)
      ) {
        throw new Error("Retention privacy drill requires split scoped Meilisearch keys");
      }
      scopedEnvironment = {
        ...environment,
        MEILI_ADMIN_KEY: adminKey,
        MEILI_SEARCH_KEY: searchKey,
        MEILI_TASK_OBSERVER_KEY: taskObserverKey,
      };
    }
  }
}

export function runRetentionPrivacyDrillWithPrivateEnv(dependencies = {}) {
  const open = dependencies.open ?? openSync;
  const fstat = dependencies.fstat ?? fstatSync;
  const close = dependencies.close ?? closeSync;
  const spawn = dependencies.spawn ?? spawnSync;
  const getuid =
    dependencies.getuid ??
    (() => (typeof process.getuid === "function" ? process.getuid() : undefined));
  let descriptor;
  try {
    descriptor = open(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstat(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.uid !== getuid()
    ) {
      throw new Error("invalid metadata");
    }
  } catch {
    if (descriptor !== undefined) {
      try {
        close(descriptor);
      } catch {
        // The generic metadata error remains the fail-closed result.
      }
    }
    throw new Error("Retention privacy drill requires an owner-only regular .env file");
  }

  let result;
  let launchFailed = false;
  let closeFailed = false;
  try {
    result = spawn(
      process.execPath,
      [
        dotenvCli,
        "-o",
        "--no-expand",
        "-e",
        "/proc/self/fd/3",
        "--",
        process.execPath,
        scriptPath,
        "--loaded",
      ],
      {
        cwd: repositoryRoot,
        shell: false,
        stdio: ["inherit", "inherit", "inherit", descriptor],
      },
    );
  } catch {
    launchFailed = true;
  } finally {
    try {
      close(descriptor);
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) throw new Error("Unable to close the private retention drill environment");
  if (launchFailed || !result || result.error) {
    throw new Error("Unable to load the private retention drill environment");
  }
  if (result.status !== 0) {
    if (result.signal) throw new Error(`Retention privacy drill stopped on ${result.signal}`);
    throw new Error(`Retention privacy drill failed with exit code ${result.status ?? "unknown"}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === "--loaded" && process.argv.length === 3) {
    await runRetentionPrivacyDrill();
  } else if (process.argv.length === 2) {
    runRetentionPrivacyDrillWithPrivateEnv();
  } else {
    throw new Error("Unsupported retention privacy drill invocation");
  }
}
