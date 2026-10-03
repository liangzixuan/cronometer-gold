import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectDevelopmentEvidence,
  sourceDigest as evidenceSourceDigest,
} from "./azure-development-evidence.mjs";
import {
  limitedTool,
  openPlan,
  PYTHON,
  sourceDigest as planSourceDigest,
  rejectAmbient,
} from "./azure-development-plan.mjs";
import { trustedPath } from "./postgres-operator-process.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = resolve(REPO, "infra/development/azure/session-policy.py");
const SOURCES = [
  "infra/development/azure/session-policy.py",
  "scripts/azure-development-session.mjs",
];
const WORK_MS = 900_000;
const RESERVE_MS = 30_000;
const MAX_JSON = 20 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requireValue = (condition) => {
  if (!condition) throw new Error("Development session input or conservation check failed");
};

export async function sourceDigest() {
  const entries = [];
  for (const name of SOURCES) {
    const path = resolve(REPO, name);
    await trustedPath(path);
    entries.push([name, hash(await readFile(path)), (await lstat(path)).mode & 0o777]);
  }
  return hash(JSON.stringify([await planSourceDigest(), await evidenceSourceDigest(), entries]));
}

async function privateJson(path) {
  requireValue((await lstat(path)).size <= MAX_JSON);
  const held = await openPlan(path);
  try {
    const raw = await readFile(held.path);
    await held.verify();
    return { value: JSON.parse(raw), sha256: held.sha256 };
  } finally {
    await held.close();
  }
}

/** The CLI admits only fixed modes; injection is confined to synthetic child execution. */
export async function runDevelopmentSession(
  mode,
  inputPath,
  { signal = new AbortController().signal, environment = process.env } = {},
  execute = limitedTool,
) {
  requireValue(process.platform === "linux" && process.arch === "x64");
  requireValue(
    [
      "execute",
      "reconcile",
      "reconcile-partial",
      "reconcile-dispose",
      "prepare-dispose",
      "dispose",
    ].includes(mode),
  );
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
  const phases = [];
  let session;
  const baseEnvironment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
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
  const remaining = (maximum) => {
    signal.throwIfAborted();
    const milliseconds = Math.floor(
      Math.min(maximum, deadline - performance.now(), horizon - Date.now() - RESERVE_MS),
    );
    requireValue(milliseconds > 0);
    return AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]);
  };
  const command = async (label, tool, args, options = {}) => {
    await conserve();
    const startedAt = new Date().toISOString();
    const result = await execute(tool, args, {
      signal: remaining(options.milliseconds ?? 60_000),
      env: options.env ?? baseEnvironment,
      directory: options.directory ?? dirname(inputPath),
      limit: options.limit ?? MAX_JSON,
      outputPath: options.outputPath,
    });
    await conserve();
    if (label)
      phases.push({
        phase: label,
        completed: true,
        exitCode: 0,
        startedAt,
        endedAt: new Date().toISOString(),
        executableSha256: tool.sha256,
        arguments: args,
        argumentsSha256: hash(JSON.stringify(args)),
        stdoutBytes: result.bytes,
        stdoutSha256: result.sha256,
      });
    return result;
  };
  const pure = async (stage, extra = []) =>
    JSON.parse(
      (
        await command(undefined, PYTHON, ["-I", "-B", HELPER, stage, mode, inputPath, ...extra], {
          limit: MAX_JSON,
        })
      ).text,
    );
  session = await pure("prepare");
  requireValue(session.directory === resolve(dirname(inputPath), input.value.operation_name));
  const extra = [session.directory, session.state_sha256];
  const verify = () => pure("verify", extra);
  const directory = resolve(session.directory, "work");
  const env = {
    ...baseEnvironment,
    HOME: resolve(session.directory, "home"),
    TMPDIR: resolve(session.directory, "tmp"),
    AZURE_CONFIG_DIR: session.profile_directory,
    AZURE_CORE_COLLECT_TELEMETRY: "no",
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
  const tool = async (label, args, output, milliseconds) => {
    await command(label, session.terraform, args, {
      env,
      directory,
      outputPath: output && resolve(session.directory, output),
      milliseconds,
    });
    await verify();
  };
  const reads = async (stage, prefix) => {
    for (const row of await pure(stage, extra)) {
      await command(`${prefix}-${row.label}`, session.azure, row.arguments, {
        env,
        directory,
        outputPath: resolve(session.directory, `${prefix}-${row.label}.json`),
      });
      await verify();
    }
  };
  if (mode === "execute") {
    await collectDevelopmentEvidence(
      resolve(session.directory, "evidence-request.json"),
      {
        signal: remaining(WORK_MS),
        environment: {},
      },
      execute,
    );
    await verify();
  } else {
    for (const [label, args] of session.auth_commands) {
      await command(
        `auth-${label}`,
        session.azure,
        [...args, "--only-show-errors", "--output", "json"],
        {
          env,
          directory,
          outputPath: resolve(session.directory, `auth-${label}.json`),
          limit: 65536,
        },
      );
      await verify();
    }
    await pure("authenticate", extra);
  }
  await tool("version", ["version", "-json"], "version.json");
  await tool(
    "init",
    ["init", "-backend=false", "-lockfile=readonly", "-input=false", "-no-color"],
    "init.stdout",
    90_000,
  );
  if (mode !== "execute" && mode !== "reconcile-dispose") {
    await tool("state", ["show", "-json", resolve(directory, "terraform.tfstate")], "state.json");
    await reads("resources", "before");
  }
  if (mode === "prepare-dispose") {
    await pure("audit", extra);
    await tool(
      "prepare-dispose",
      [
        "plan",
        "-destroy",
        "-input=false",
        "-no-color",
        "-lock-timeout=0s",
        "-parallelism=1",
        "-var-file=inputs.tfvars.json",
        `-out=${resolve(session.directory, "destroy.tfplan")}`,
      ],
      "prepare-dispose.stdout",
      180_000,
    );
    const held = await openPlan(resolve(session.directory, "destroy.tfplan"));
    try {
      await tool("show-dispose", ["show", "-json", held.path], "rendered.json");
      await held.verify();
      phases.at(-1).binaryPlanSha256 = held.sha256;
    } finally {
      await held.close();
    }
  } else {
    const held = await openPlan(session.binary_plan_path);
    try {
      requireValue(held.sha256 === session.binary_plan_sha256);
      await tool("show", ["show", "-json", held.path], "rendered.json");
      await held.verify();
      phases.at(-1).binaryPlanSha256 = held.sha256;
      if (mode === "execute") await reads("groups", "before");
      if (!["reconcile", "reconcile-partial", "reconcile-dispose"].includes(mode)) {
        // Publish unknown outcome durably before the only mutating command.
        await pure("intent", extra);
        await held.verify();
        await tool(
          "apply",
          ["apply", "-input=false", "-no-color", "-lock-timeout=0s", "-parallelism=1", held.path],
          "apply.stdout",
          300_000,
        );
        await held.verify();
        phases.at(-1).binaryPlanSha256 = held.sha256;
      }
    } finally {
      await held.close();
    }
    if (!["reconcile", "reconcile-partial", "reconcile-dispose"].includes(mode)) {
      await tool(
        "state-after",
        ["show", "-json", resolve(directory, "terraform.tfstate")],
        mode === "execute" ? "state.json" : "final-state.json",
      );
      await reads(mode === "execute" ? "resources" : "groups", "after");
    }
  }
  if (mode === "reconcile-dispose") {
    await tool(
      "state-after",
      ["show", "-json", resolve(directory, "terraform.tfstate")],
      "final-state.json",
    );
    await reads("groups", "after");
  }
  await writeFile(resolve(session.directory, "phases.json"), `${JSON.stringify(phases)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const result = await pure("finish", extra);
  const receipt = await privateJson(resolve(session.directory, "result.json"));
  requireValue(
    result.completed === true &&
      receipt.sha256 === result.result_sha256 &&
      receipt.value.completed === true &&
      receipt.value.mode === mode &&
      receipt.value.source_sha256 === source,
  );
  return { directory: session.directory, resultSha256: receipt.sha256 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--source-digest") {
    console.log(await sourceDigest());
    return;
  }
  requireValue(args.length === 3 && args[1] === "--input");
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Session interrupted"));
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, stop);
  try {
    await runDevelopmentSession(args[0], args[2], { signal: controller.signal });
    console.log(
      args[0] === "prepare-dispose"
        ? "Private deletion plan prepared for separate review; no deletion attempted."
        : args[0] === "reconcile-dispose"
          ? "Private current disposal observation recorded; original disposal outcome remains unconfirmed."
          : ["reconcile", "reconcile-partial"].includes(args[0])
            ? "Private current ownership recorded; original execution outcome remains unconfirmed."
            : "Private empty-host lifecycle result recorded; no application runtime or release acceptance.",
    );
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      "Session did not complete. Retain private state and any published artifacts; local process exit does not establish the remote outcome.",
    );
    process.exitCode = 1;
  });
}
