import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const envFile = resolve(repositoryRoot, ".env");
const dotenvCli = resolve(repositoryRoot, "node_modules/dotenv-cli/cli.js");

function required(environment, field) {
  const value = environment[field];
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

export function assertRetentionPrivacyDrillEnvironment(environment) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED) {
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

export function runRetentionPrivacyDrill(spawn = spawnSync, environment = process.env) {
  assertRetentionPrivacyDrillEnvironment(environment);
  const localEnvironment = { ...environment };
  delete localEnvironment.ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID;
  delete localEnvironment.ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY;

  for (const step of retentionPrivacyDrillSteps) {
    const result = spawn("pnpm", step.args, {
      cwd: repositoryRoot,
      env: { ...localEnvironment, ...step.environment },
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
    runRetentionPrivacyDrill();
  } else if (process.argv.length === 2) {
    runRetentionPrivacyDrillWithPrivateEnv();
  } else {
    throw new Error("Unsupported retention privacy drill invocation");
  }
}
