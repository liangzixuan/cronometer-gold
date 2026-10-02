import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTool, trustedPath } from "./postgres-operator-process.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "infra/development/azure/prepare-plan-input.py";
const SOURCES = [
  ...[
    ".terraform.lock.hcl",
    "versions.tf",
    "variables.tf",
    "main.tf",
    "outputs.tf",
    "audit-plan.py",
    "auth-preflight.py",
    "prepare-plan-input.py",
  ].map((name) => `infra/development/azure/${name}`),
  "infra/azure/tests/audit_saved_plan.py",
  "scripts/azure-development-plan.mjs",
  "scripts/postgres-operator-process.mjs",
];
export const PRLIMIT = Object.freeze({
  path: "/usr/bin/prlimit",
  sha256: "17064f67e650d6152a6902b013aab496b54c87587c8eea6f5023aafee6154069",
});
const PYTHON = Object.freeze({
  path: "/usr/bin/python3.12",
  sha256: "e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f",
});
const MAX_FILE = 512 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const WORK_MS = 600_000;
const RESERVE_MS = 30_000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (condition) => {
  if (!condition) throw new Error("Development plan input or conservation check failed");
};

export function rejectAmbient(environment) {
  for (const name of Object.keys(environment)) {
    requireValue(
      !/^(?:TF_|ARM_|AZURE_|AWS_|GOOGLE_|CLOUDSDK_|PYTHON|LD_|DYLD_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$)/iu.test(
        name,
      ),
    );
    requireValue(!/^(?:https?|all|no)_proxy$/iu.test(name));
  }
}

export async function sourceDigest() {
  const entries = [];
  for (const name of SOURCES) {
    const path = resolve(REPO, name);
    await trustedPath(path);
    entries.push([name, sha(await readFile(path)), (await lstat(path)).mode & 0o777]);
  }
  return sha(JSON.stringify(entries));
}

async function executable(tool) {
  await trustedPath(tool.path);
  requireValue((await lstat(tool.path)).mode & 0o111);
  requireValue(sha(await readFile(tool.path)) === tool.sha256);
}

/** Pinned default process boundary; the command-line interface admits no override. */
export async function limitedTool(tool, args, options) {
  await executable(tool);
  const result = await runTool(
    PRLIMIT,
    [`--fsize=${MAX_FILE}:${MAX_FILE}`, "--", tool.path, ...args],
    options,
  );
  await executable(tool);
  return result;
}

async function privateJson(path) {
  await trustedPath(dirname(path), { directory: true, privateLeaf: true });
  await trustedPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    requireValue(
      before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o777n) === 0o600n &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(MAX_JSON),
    );
    const raw = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    requireValue(
      before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
    );
    return { value: JSON.parse(raw), sha256: sha(raw) };
  } finally {
    await handle.close();
  }
}

/** Hold the exact private plan inode across the renderer's /proc parent-FD open. */
export async function openPlan(path) {
  await trustedPath(dirname(path), { directory: true, privateLeaf: true });
  await trustedPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (s) =>
    [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].map(String).join(":");
  try {
    const before = await handle.stat({ bigint: true });
    requireValue(
      before.uid === BigInt(process.getuid()) &&
        (before.mode & 0o777n) === 0o600n &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(MAX_FILE),
    );
    const digest = async () => {
      const hash = createHash("sha256");
      for await (const block of handle.createReadStream({ start: 0, autoClose: false }))
        hash.update(block);
      return hash.digest("hex");
    };
    const expected = await digest();
    const verify = async () => {
      requireValue(
        identity(before) === identity(await handle.stat({ bigint: true })) &&
          identity(before) === identity(await lstat(path, { bigint: true })) &&
          (await digest()) === expected,
      );
    };
    await verify();
    return {
      path: `/proc/${process.pid}/fd/${handle.fd}`,
      sha256: expected,
      verify,
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function createDevelopmentPlan(
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
  const expectedSource = await sourceDigest();
  requireValue(input.value.source_sha256 === expectedSource);
  const horizon = Date.parse(input.value.not_after_utc);
  requireValue(Number.isFinite(horizon) && Date.now() + WORK_MS + RESERVE_MS <= horizon);
  const deadline = performance.now() + WORK_MS;
  const phases = [];
  let session;
  const baseEnvironment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
  const conserve = async () => {
    requireValue(
      (await sourceDigest()) === expectedSource &&
        (await privateJson(inputPath)).sha256 === input.sha256,
    );
    if (session)
      requireValue(
        (await privateJson(resolve(session.directory, "session.json"))).sha256 ===
          session.state_sha256,
      );
  };
  const command = async (
    phase,
    tool,
    args,
    { directory, env, outputPath, limit = 65536, milliseconds = 60_000, record = true } = {},
  ) => {
    signal.throwIfAborted();
    await conserve();
    const remaining = Math.min(
      deadline - performance.now(),
      horizon - Date.now() - RESERVE_MS,
      milliseconds,
    );
    requireValue(remaining >= 1);
    const startedAt = new Date().toISOString();
    const result = await execute(tool, args, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.floor(remaining))]),
      env: env ?? baseEnvironment,
      directory: directory ?? dirname(inputPath),
      limit,
      outputPath,
    });
    await conserve();
    if (record)
      phases.push({
        phase,
        completed: true,
        exitCode: 0,
        startedAt,
        endedAt: new Date().toISOString(),
        executableSha256: tool.sha256,
        argumentsSha256: sha(JSON.stringify(args)),
        stdoutSha256: result.sha256,
        stdoutBytes: result.bytes,
      });
    return result;
  };
  const pure = (mode, extra = [], record = false) =>
    command(mode, PYTHON, ["-I", "-B", resolve(REPO, HELPER), mode, inputPath, ...extra], {
      record,
    });
  session = JSON.parse((await pure("prepare", [], true)).text);
  requireValue(session.directory === resolve(dirname(inputPath), input.value.operation_name));
  const extra = [session.directory, session.state_sha256];
  const verify = () => pure("verify", extra);
  const env = {
    ...baseEnvironment,
    HOME: resolve(session.directory, "home"),
    TMPDIR: resolve(session.directory, "tmp"),
    AZURE_CONFIG_DIR: session.profile_directory,
    AZURE_CORE_COLLECT_TELEMETRY: "0",
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
    AZURE_LOGGING_ENABLE_LOG_FILE: "no",
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    CHECKPOINT_DISABLE: "1",
    TF_CLI_CONFIG_FILE: resolve(session.directory, "terraform.rc"),
    TF_DATA_DIR: resolve(session.directory, "data"),
    ARM_USE_CLI: "true",
    ARM_USE_OIDC: "false",
    ARM_USE_MSI: "false",
    ARM_SUBSCRIPTION_ID: session.subscription_id,
    ARM_TENANT_ID: session.tenant_id,
  };
  const work = resolve(session.directory, "work");
  for (const [label, args] of session.auth_commands) {
    await command(
      `auth-${label}`,
      session.azure,
      [...args, "--only-show-errors", "--output", "json"],
      { directory: work, env, outputPath: resolve(session.directory, `auth-${label}.json`) },
    );
    await verify();
  }
  await pure("authenticate", extra, true);
  await command("version", session.terraform, ["version", "-json"], {
    directory: work,
    env,
    outputPath: resolve(session.directory, "version.json"),
  });
  const version = (await privateJson(resolve(session.directory, "version.json"))).value;
  requireValue(version.terraform_version === "1.5.7" && version.platform === "linux_amd64");
  await verify();
  await command(
    "init",
    session.terraform,
    ["init", "-backend=false", "-lockfile=readonly", "-input=false", "-no-color"],
    { directory: work, env },
  );
  await verify();
  await command(
    "plan",
    session.terraform,
    [
      "plan",
      "-input=false",
      "-no-color",
      "-lock-timeout=0s",
      "-parallelism=1",
      "-var-file=inputs.tfvars.json",
      `-out=${resolve(session.directory, "plan.tfplan")}`,
    ],
    { directory: work, env, milliseconds: 240_000 },
  );
  await verify();
  const plan = await openPlan(resolve(session.directory, "plan.tfplan"));
  try {
    await command("show", session.terraform, ["show", "-json", plan.path], {
      directory: work,
      env,
      limit: MAX_JSON,
      outputPath: resolve(session.directory, "rendered.json"),
    });
    await plan.verify();
    phases.at(-1).binaryPlanSha256 = plan.sha256;
  } finally {
    await plan.close();
  }
  await verify();
  await writeFile(resolve(session.directory, "phases.json"), `${JSON.stringify(phases)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  // finish removes the session binding before create-only publication; verify outer source/input separately.
  const completed = session;
  session = undefined;
  const result = JSON.parse((await pure("finish", extra)).text);
  requireValue(result.completed === true);
  const receipt = await privateJson(resolve(completed.directory, "result.json"));
  requireValue(
    receipt.sha256 === result.result_sha256 &&
      receipt.value.completed === true &&
      receipt.value.source_sha256 === expectedSource,
  );
  return { directory: completed.directory, resultSha256: receipt.sha256 };
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
  const stop = () => controller.abort(new Error("Operator interrupted"));
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, stop);
  try {
    await createDevelopmentPlan(args[1], { signal: controller.signal });
    console.log("Private development plan policy passed; no apply or runtime acceptance.");
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      "Development plan did not complete. Inspect the private operation directory; partial or published output may remain.",
    );
    process.exitCode = 1;
  });
}
