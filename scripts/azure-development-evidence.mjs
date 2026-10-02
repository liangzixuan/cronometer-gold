import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { limitedTool, PYTHON, rejectAmbient } from "./azure-development-plan.mjs";
import { trustedPath } from "./postgres-operator-process.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = resolve(REPO, "infra/development/azure/collect-evidence.py");
const SOURCES = [
  ...[
    ".terraform.lock.hcl",
    "versions.tf",
    "variables.tf",
    "main.tf",
    "outputs.tf",
    "audit-plan.py",
    "auth-preflight.py",
    "collect-evidence.py",
  ].map((name) => `infra/development/azure/${name}`),
  "infra/azure/tests/audit_saved_plan.py",
  "scripts/azure-development-evidence.mjs",
  "scripts/azure-development-plan.mjs",
  "scripts/postgres-operator-process.mjs",
];
const WORK_MS = 600_000;
const RESERVE_MS = 30_000;
const MAX_RESPONSE = 131_072;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (condition) => {
  if (!condition) throw new Error("Development evidence input or conservation check failed");
};

export async function sourceDigest() {
  const entries = [];
  for (const name of SOURCES) {
    const path = resolve(REPO, name);
    await trustedPath(path);
    entries.push([name, hash(await readFile(path)), (await lstat(path)).mode & 0o777]);
  }
  return hash(JSON.stringify(entries));
}

async function privateJson(path) {
  await trustedPath(dirname(path), { directory: true, privateLeaf: true });
  await trustedPath(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (value) =>
    [
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
      value.uid,
      value.mode,
      value.nlink,
    ]
      .map(String)
      .join(":");
  try {
    const before = await fd.stat({ bigint: true });
    requireValue(
      before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o777n) === 0o600n &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(MAX_RESPONSE),
    );
    const raw = await fd.readFile();
    requireValue(
      identity(before) === identity(await fd.stat({ bigint: true })) &&
        identity(before) === identity(await lstat(path, { bigint: true })),
    );
    return { value: JSON.parse(raw), sha256: hash(raw) };
  } finally {
    await fd.close();
  }
}

/** The CLI always uses the pinned limiter. The injected seam is for synthetic sequence tests. */
export async function collectDevelopmentEvidence(
  inputPath,
  { signal = new AbortController().signal, environment = process.env } = {},
  execute = limitedTool,
) {
  requireValue(process.platform === "linux" && process.arch === "x64");
  rejectAmbient(environment);
  requireValue(
    typeof inputPath === "string" &&
      resolve(inputPath) === inputPath &&
      (await realpath(inputPath)) === inputPath,
  );
  const input = await privateJson(inputPath);
  const source = await sourceDigest();
  requireValue(input.value.source_sha256 === source);
  const horizon = Date.parse(input.value.not_after_utc);
  requireValue(Number.isFinite(horizon) && Date.now() + WORK_MS + RESERVE_MS <= horizon);
  const deadline = performance.now() + WORK_MS;
  const baseEnvironment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
  let session;
  const phases = [];
  const conserve = async () => {
    requireValue(
      (await sourceDigest()) === source && (await privateJson(inputPath)).sha256 === input.sha256,
    );
    if (session)
      requireValue(
        (await privateJson(resolve(session.directory, "session.json"))).sha256 ===
          session.state_sha256,
      );
  };
  const command = async (
    tool,
    args,
    { label, outputPath, env = baseEnvironment, directory = dirname(inputPath) } = {},
  ) => {
    signal.throwIfAborted();
    await conserve();
    const remaining = Math.min(
      60_000,
      deadline - performance.now(),
      horizon - Date.now() - RESERVE_MS,
    );
    requireValue(remaining >= 1);
    const startedAt = new Date().toISOString();
    const result = await execute(tool, args, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.floor(remaining))]),
      env,
      directory,
      limit: MAX_RESPONSE,
      outputPath,
    });
    await conserve();
    if (label) {
      requireValue(
        Number.isSafeInteger(result.stderrBytes) &&
          result.stderrBytes >= 0 &&
          result.stderrBytes <= 65_536 &&
          /^[a-f0-9]{64}$/u.test(result.stderrSha256),
      );
      phases.push({
        label,
        arguments: args,
        executableSha256: tool.sha256,
        startedAt,
        endedAt: new Date().toISOString(),
        completed: true,
        exitCode: 0,
        stdoutBytes: result.bytes,
        stdoutSha256: result.sha256,
        stderrBytes: result.stderrBytes,
        stderrSha256: result.stderrSha256,
      });
    }
    return result;
  };
  const pure = async (mode, extra = []) =>
    JSON.parse((await command(PYTHON, ["-I", "-B", HELPER, mode, inputPath, ...extra])).text);
  session = await pure("prepare");
  requireValue(session.directory === resolve(dirname(inputPath), input.value.operation_name));
  const extra = [session.directory, session.state_sha256];
  const env = {
    ...baseEnvironment,
    HOME: resolve(session.directory, "home"),
    TMPDIR: resolve(session.directory, "tmp"),
    AZURE_CONFIG_DIR: session.profile_directory,
    AZURE_CORE_COLLECT_TELEMETRY: "no",
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
    AZURE_LOGGING_ENABLE_LOG_FILE: "no",
  };
  const read = async (label, args) => {
    await command(session.azure, args, {
      label,
      outputPath: resolve(session.directory, `${label}.json`),
      env,
      directory: resolve(session.directory, "work"),
    });
    await pure("verify", extra);
  };
  for (const [label, args] of session.auth_commands)
    await read(`auth-${label}`, [...args, "--only-show-errors", "--output", "json"]);
  await pure("authenticate", extra);
  for (const stage of ["requests", "remaining"]) {
    for (const descriptor of await pure(stage, extra))
      await read(`read-${descriptor.label}`, descriptor.arguments);
  }
  await writeFile(resolve(session.directory, "phases.json"), `${JSON.stringify(phases)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const result = await pure("finish", extra);
  const index = await privateJson(resolve(session.directory, "index.json"));
  requireValue(
    result.completed === true &&
      result.index_sha256 === index.sha256 &&
      index.value.completed === true &&
      index.value.source_sha256 === source,
  );
  return { directory: session.directory, indexSha256: index.sha256 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--source-digest") {
    console.log(await sourceDigest());
    return;
  }
  requireValue(args.length === 2 && args[0] === "--input");
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Collector interrupted"));
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, stop);
  try {
    await collectDevelopmentEvidence(args[1], { signal: controller.signal });
    console.log(
      "Private native evidence policy passed; no plan, allocation or runtime acceptance.",
    );
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      "Development evidence did not complete. Private partial or published files may remain; no acceptance established.",
    );
    process.exitCode = 1;
  });
}
