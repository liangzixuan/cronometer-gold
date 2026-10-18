import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { limitedTool, PYTHON, rejectAmbient } from "./azure-development-plan.mjs";
import { trustedPath } from "./postgres-operator-process.mjs";

const WORK_MS = 600_000;
const RESERVE_MS = 30_000;
export const AUTH_RESPONSE_LIMIT = 131_072;
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const requireValue = (condition) => {
  if (!condition) throw new Error("Collector input or conservation check failed");
};

export async function collectorSourceDigest(repo, sources) {
  const entries = [];
  for (const name of sources) {
    const path = resolve(repo, name);
    await trustedPath(path);
    entries.push([name, hash(await readFile(path)), (await lstat(path)).mode & 0o777]);
  }
  return hash(JSON.stringify(entries));
}

export async function collectorPrivateJson(path) {
  await trustedPath(dirname(path), { directory: true, privateLeaf: true });
  await trustedPath(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (info) =>
    [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.uid, info.mode, info.nlink]
      .map(String)
      .join(":");
  try {
    const before = await fd.stat({ bigint: true });
    requireValue(
      before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o777n) === 0o600n &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(AUTH_RESPONSE_LIMIT),
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

/** Internal shared process boundary. Fixed entrypoints own helpers, source lists and stage order. */
export async function openDevelopmentCollector(
  inputPath,
  { helper, sourceDigest },
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
  const input = await collectorPrivateJson(inputPath);
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
      (await sourceDigest()) === source &&
        (await collectorPrivateJson(inputPath)).sha256 === input.sha256,
    );
    if (session)
      requireValue(
        (await collectorPrivateJson(resolve(session.directory, "session.json"))).sha256 ===
          session.state_sha256,
      );
  };
  const command = async (
    tool,
    args,
    {
      label,
      outputPath,
      env = baseEnvironment,
      directory = dirname(inputPath),
      limit = AUTH_RESPONSE_LIMIT,
    } = {},
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
      limit,
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
    JSON.parse((await command(PYTHON, ["-I", "-B", helper, mode, inputPath, ...extra])).text);
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
  const stage = (mode, more = []) => pure(mode, [...extra, ...more]);
  const read = async (label, args, limit = AUTH_RESPONSE_LIMIT) => {
    await command(session.azure, args, {
      label,
      outputPath: resolve(session.directory, `${label}.json`),
      env,
      directory: resolve(session.directory, "work"),
      limit,
    });
    await stage("verify");
  };
  const finish = async () => {
    await writeFile(resolve(session.directory, "phases.json"), `${JSON.stringify(phases)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const result = await stage("finish");
    const index = await collectorPrivateJson(resolve(session.directory, "index.json"));
    requireValue(
      result.completed === true &&
        result.index_sha256 === index.sha256 &&
        index.value.completed === true &&
        index.value.source_sha256 === source,
    );
    return { directory: session.directory, indexSha256: index.sha256 };
  };
  return { session, stage, read, finish };
}
