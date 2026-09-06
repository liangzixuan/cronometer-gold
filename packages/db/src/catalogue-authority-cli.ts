import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Kysely } from "kysely";
import {
  type CatalogueAuthorityDeploymentPolicy,
  catalogueAuthorityDeploymentPolicySha256,
  parseCatalogueAuthorityDeploymentPolicy,
} from "./catalogue-authority-deployment.js";
import {
  type CatalogueAuthorityCanaryConnections,
  runCatalogueReviewerCanaries,
} from "./catalogue-authority-deployment-runtime.js";
import { canonicalJson } from "./catalogue-validation.js";
import { assertDatabaseMigrationLedgerReady, createDatabase } from "./client.js";
import type { Database, JsonValue } from "./types.js";

const CONNECTION_ENVIRONMENT = {
  api: "CATALOGUE_AUTHORITY_API_DATABASE_URL",
  data: "CATALOGUE_AUTHORITY_DATA_REVIEWER_DATABASE_URL",
  owner: "CATALOGUE_AUTHORITY_OWNER_DATABASE_URL",
  quality: "CATALOGUE_AUTHORITY_QUALITY_REVIEWER_DATABASE_URL",
  rights: "CATALOGUE_AUTHORITY_RIGHTS_REVIEWER_DATABASE_URL",
  unassigned: "CATALOGUE_AUTHORITY_UNASSIGNED_DATABASE_URL",
  worker: "CATALOGUE_AUTHORITY_WORKER_DATABASE_URL",
} as const;

interface Arguments {
  readonly evidenceOut: string;
  readonly policy: string;
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const argumentsParsed = parseArguments(arguments_);
  await requirePrivateLocalPath(argumentsParsed.policy, "policy");
  await requirePrivateLocalPath(argumentsParsed.evidenceOut, "evidence output");
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Catalogue authority deployment refuses disabled Node TLS verification");
  }
  const policyBytes = await readPrivateFile(argumentsParsed.policy);
  const policy = parseCanonicalDeploymentPolicyBytes(policyBytes);
  const mode = environment.CATALOGUE_AUTHORITY_DATABASE_SSL_MODE ?? "verify-full";
  const urls = Object.fromEntries(
    Object.entries(CONNECTION_ENVIRONMENT).map(([name, variable]) => [
      name,
      requiredEnvironment(environment, variable),
    ]),
  ) as Record<keyof typeof CONNECTION_ENVIRONMENT, string>;
  const ssl = databaseSsl(mode, Object.values(urls));
  const clients: Kysely<Database>[] = [];
  const createClient = (name: keyof typeof CONNECTION_ENVIRONMENT): Kysely<Database> => {
    const client = createDatabase({
      applicationName: `catalogue-authority-deploy-zero-${name}`,
      connectionString: urls[name],
      connectionTimeoutMs: 5_000,
      maxConnections: 1,
      ssl,
      statementTimeoutMs: 15_000,
    });
    clients.push(client);
    return client;
  };
  let reportBytes: string | undefined;
  let verificationError: unknown;
  try {
    const connections: CatalogueAuthorityCanaryConnections = {
      nonReviewers: {
        api: createClient("api"),
        unassigned: createClient("unassigned"),
        worker: createClient("worker"),
      },
      owner: createClient("owner"),
      reviewers: {
        data: createClient("data"),
        quality: createClient("quality"),
        rights: createClient("rights"),
      },
    };
    await assertDatabaseMigrationLedgerReady(connections.owner);
    const canaries = await runCatalogueReviewerCanaries(connections, policy);
    const report = {
      applicationSchema: policy.applicationSchema,
      canaries,
      completedAt: new Date().toISOString(),
      databaseName: policy.databaseName,
      evidenceKind: "catalogue-authority-deployment-zero-write",
      policySha256: catalogueAuthorityDeploymentPolicySha256(policy),
      schemaVersion: 4,
    };
    reportBytes = `${canonicalJson(report as unknown as JsonValue)}\n`;
  } catch (error) {
    verificationError = error;
  }
  const cleanup = await Promise.allSettled(clients.map((client) => client.destroy()));
  if (cleanup.some((result) => result.status === "rejected")) {
    throw new Error("Catalogue authority verifier connection cleanup failed");
  }
  if (verificationError !== undefined) throw verificationError;
  if (reportBytes === undefined) {
    throw new Error("Catalogue authority deployment verification produced no evidence");
  }
  await requirePrivateLocalPath(argumentsParsed.evidenceOut, "evidence output");
  await writePrivateNewFile(argumentsParsed.evidenceOut, reportBytes);
}

export function parseCanonicalDeploymentPolicyBytes(
  bytes: string,
): CatalogueAuthorityDeploymentPolicy {
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(bytes);
  } catch {
    throw new Error("Catalogue authority deployment policy is not valid JSON");
  }
  const policy = parseCatalogueAuthorityDeploymentPolicy(policyValue);
  if (bytes !== `${canonicalJson(policy as unknown as JsonValue)}\n`) {
    throw new Error("Catalogue authority deployment policy is not canonical JSON");
  }
  return policy;
}

export function parseArguments(arguments_: readonly string[]): Arguments {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--policy" ||
    arguments_[2] !== "--evidence-out" ||
    !arguments_[1] ||
    !arguments_[3]
  ) {
    throw new Error(
      "Usage: catalogue-authority-verify --policy <mode-0600.json> --evidence-out <new-mode-0600.json>",
    );
  }
  return { evidenceOut: resolve(arguments_[3]), policy: resolve(arguments_[1]) };
}

export function databaseSsl(
  mode: string,
  connectionStrings: readonly string[],
): false | { readonly rejectUnauthorized: true } {
  const urls = connectionStrings.map((connectionString) => {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new Error("Catalogue authority database URLs must be valid PostgreSQL URLs");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("Catalogue authority database URLs must use PostgreSQL");
    }
    if (url.search.length !== 0 || url.hash.length !== 0) {
      throw new Error("Catalogue authority database URLs must not contain query parameters");
    }
    return url;
  });
  if (mode === "verify-full") return { rejectUnauthorized: true };
  if (
    mode === "disable" &&
    urls.every((url) => url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  ) {
    return false;
  }
  throw new Error(
    "CATALOGUE_AUTHORITY_DATABASE_SSL_MODE must be verify-full, or disable for literal loopback only",
  );
}

export async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertPrivateRegularFile(before, "policy");
    const bytes = await handle.readFile("utf8");
    const after = await handle.stat();
    assertPrivateRegularFile(after, "policy");
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.uid !== after.uid
    ) {
      throw new Error("Catalogue authority deployment policy changed while it was read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writePrivateNewFile(path: string, bytes: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let complete = false;
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    const state = await handle.stat();
    assertPrivateRegularFile(state, "evidence output");
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(path).catch(() => undefined);
  }
  const finalState = await lstat(path);
  assertPrivateRegularFile(finalState, "evidence output");
}

function assertPrivateRegularFile(state: Stats, label: string): void {
  const expectedUid = process.getuid?.();
  if (
    expectedUid === undefined ||
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    state.uid !== expectedUid ||
    (state.mode & 0o777) !== 0o600
  ) {
    throw new Error(`Catalogue authority ${label} must be a mode-0600 single-link file`);
  }
}

export async function requirePrivateLocalPath(path: string, label: string): Promise<void> {
  const normalized = resolve(path);
  const segments = normalized.split(sep);
  const markerIndex = segments.lastIndexOf(".local-data");
  if (!isAbsolute(path) || path !== normalized || markerIndex < 0) {
    throw new Error(`Catalogue authority ${label} must be under an ignored .local-data path`);
  }
  const markerPath = segments.slice(0, markerIndex + 1).join(sep) || sep;
  const parentPath = dirname(normalized);
  for (const directory of new Set([markerPath, parentPath])) {
    let state: Stats;
    let canonical: string;
    try {
      [state, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
    } catch {
      throw new Error(`Catalogue authority ${label} parent directory is unavailable`);
    }
    if (!state.isDirectory() || state.isSymbolicLink() || canonical !== directory) {
      throw new Error(`Catalogue authority ${label} parent path must not contain symlinks`);
    }
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error("Catalogue authority database connection environment is incomplete");
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error && error.message.startsWith("Catalogue authority")
        ? error.message
        : "Catalogue authority deployment verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
