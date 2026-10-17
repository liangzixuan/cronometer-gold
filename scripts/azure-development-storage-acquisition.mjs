import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { limitedTool, openPlan, PYTHON, rejectAmbient } from "./azure-development-plan.mjs";
import { ChildCleanupError, MAX_STDERR_BYTES, trustedPath } from "./postgres-operator-process.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = resolve(ROOT, "infra/development/azure/storage-acquisition.py");
const MANIFEST = resolve(ROOT, "infra/development/azure/storage/source-files.json");
const WORK_MS = 900_000,
  RESERVE_MS = 30_000,
  MAX_JSON = 20 * 1024 * 1024;
const sha = (v) => createHash("sha256").update(v).digest("hex");
const check = (v) => {
  if (!v) throw new Error("Azure storage acquisition rejected");
};
export async function sourceDigest() {
  await trustedPath(MANIFEST);
  const names = JSON.parse(await readFile(MANIFEST));
  check(
    Array.isArray(names) &&
      names.length <= 100 &&
      JSON.stringify(names) === JSON.stringify([...new Set(names)].sort()),
  );
  const entries = [];
  for (const name of names) {
    check(typeof name === "string" && !name.startsWith("/") && !name.split("/").includes(".."));
    const path = resolve(ROOT, name);
    await trustedPath(path);
    const before = await lstat(path, { bigint: true });
    check(before.isFile() && (before.mode & 0o777n) === 0o644n && before.size <= 1_048_576n);
    const raw = await readFile(path),
      after = await lstat(path, { bigint: true });
    check(["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((k) => before[k] === after[k]));
    entries.push([name, sha(raw), Number(before.mode & 0o777n)]);
  }
  check(names.includes("infra/development/azure/storage/source-files.json"));
  return sha(JSON.stringify(entries));
}
async function privateJson(path) {
  check((await lstat(path)).size <= MAX_JSON);
  const held = await openPlan(path);
  try {
    const raw = await readFile(held.path);
    await held.verify();
    return { value: JSON.parse(raw), sha256: held.sha256 };
  } finally {
    await held.close();
  }
}
async function syncParent(path) {
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function durable(path, value) {
  const file = await open(path, "wx+", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await syncParent(path);
}
/** Fixed local command; execution injection exists only for synthetic tests. */
export async function runStorageAcquisition(
  mode,
  inputPath,
  inputSha256,
  { signal = new AbortController().signal, environment = process.env } = {},
  execute = limitedTool,
) {
  check(process.platform === "linux" && process.arch === "x64");
  check(["plan", "execute", "reconcile"].includes(mode));
  rejectAmbient(environment);
  check(
    typeof inputPath === "string" &&
      resolve(inputPath) === inputPath &&
      /^[a-f0-9]{64}$/.test(inputSha256),
  );
  const loadingStarted = performance.now();
  check((await lstat(inputPath)).size <= 65536);
  const heldInput = await openPlan(inputPath);
  let session,
    heldPlan,
    heldState,
    source,
    uncertainCleanup = false;
  let horizon, deadline, last;
  const phases = [];
  let phasesAttempted = false;
  const publishPhases = async () => {
    phasesAttempted = true;
    await durable(resolve(session.directory, "phases.json"), phases);
  };

  const base = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
  const clock = (maximum, cleanup = false) => {
    const now = Date.now();
    check(Number.isFinite(horizon) && now >= last);
    last = now;
    if (!cleanup) signal.throwIfAborted();
    const remaining = Math.floor(
      Math.min(
        maximum,
        deadline + (cleanup ? RESERVE_MS : 0) - performance.now(),
        horizon - now - (cleanup ? 0 : RESERVE_MS),
      ),
    );
    check(remaining > 0);
    return remaining;
  };
  const conserve = async () => {
    check((await sourceDigest()) === source);
    await heldInput.verify();
    if (session)
      check(
        (await privateJson(resolve(session.directory, "session.json"))).sha256 ===
          session.state_sha256,
      );
  };
  try {
    source = await sourceDigest();
    check(performance.now() - loadingStarted < 20000);
    check(heldInput.sha256 === inputSha256 && (await lstat(inputPath)).size <= 65536);
    const input = JSON.parse(await readFile(heldInput.path));
    check(input.source_sha256 === source);
    horizon = Date.parse(input.not_after_utc);
    last = Date.now();
    deadline = performance.now() + WORK_MS;
    check(
      Number.isFinite(horizon) &&
        last + WORK_MS + RESERVE_MS <= horizon &&
        horizon - last <= 4 * 3600000,
    );
    const command = async (label, tool, args, options = {}) => {
      await conserve();
      const invoke = (onStderr) =>
        execute(tool, args, {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(clock(options.milliseconds ?? 30000)),
          ]),
          env: options.env ?? base,
          directory: options.directory ?? dirname(inputPath),
          limit: options.limit ?? MAX_JSON,
          outputPath: options.outputPath,
          onStderr,
        });
      if (!label) {
        let result;
        try {
          result = await invoke();
        } catch (error) {
          if (error instanceof ChildCleanupError) uncertainCleanup = true;
          throw error;
        }
        await conserve();
        clock(30000);
        return result;
      }
      const phase = {
        phase: label,
        completed: false,
        exitCode: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        sourceSha256: source,
        requestSha256: inputSha256,
        executableSha256: tool.sha256,
        arguments: args,
        argumentsSha256: sha(JSON.stringify(args)),
        executionReturned: false,
        cleanup: "unknown",
        failure: null,
        stdoutBytes: null,
        stdoutSha256: null,
        stderrBytes: 0,
        stderrSha256: sha(Buffer.alloc(0)),
        stderrComplete: false,
        stderrPublished: false,
        stderrCaptureOverflow: false,
      };
      const path = resolve(session.directory, label + ".stderr");
      const chunks = [];
      let captured = 0,
        file,
        identity,
        result,
        failure,
        step = "evidence-publication";
      try {
        // Reserve the exact private output before dispatch; do not overwrite old evidence.
        file = await open(path, "wx+", 0o600);
        identity = await file.stat({ bigint: true });
        await file.sync();
        await syncParent(path);
        step = "command";
        result = await invoke((chunk) => {
          check(Buffer.isBuffer(chunk));
          const count = Math.min(chunk.length, MAX_STDERR_BYTES - captured);
          if (count) chunks.push(Buffer.from(chunk.subarray(0, count)));
          captured += count;
          if (count !== chunk.length) {
            phase.stderrCaptureOverflow = true;
            throw new Error("Storage diagnostic limit exceeded");
          }
        });
        phase.executionReturned = true;
        phase.exitCode = 0;
        phase.cleanup = "settled";
        phase.stdoutBytes = result.bytes;
        phase.stdoutSha256 = result.sha256;
        step = "stderr-binding";
        check(
          !phase.stderrCaptureOverflow &&
            result.stderrBytes === captured &&
            result.stderrSha256 === sha(Buffer.concat(chunks, captured)),
        );
        phase.stderrComplete = true;
        step = "guard";
        await conserve();
        clock(30000);
      } catch (error) {
        failure = error;
        if (error instanceof ChildCleanupError) {
          uncertainCleanup = true;
          phase.cleanup = "unconfirmed";
        }
        phase.failure =
          error instanceof ChildCleanupError
            ? "cleanup-unconfirmed"
            : phase.stderrCaptureOverflow
              ? "capture-overflow"
              : step;
      }
      const raw = Buffer.concat(chunks, captured);
      phase.stderrBytes = raw.length;
      phase.stderrSha256 = sha(raw);
      try {
        if (file) {
          await file.writeFile(raw);
          await file.sync();
          const observed = Buffer.alloc(raw.length);
          let offset = 0;
          while (offset < observed.length) {
            const { bytesRead } = await file.read(
              observed,
              offset,
              observed.length - offset,
              offset,
            );
            check(bytesRead > 0);
            offset += bytesRead;
          }
          const held = await file.stat({ bigint: true });
          const named = await lstat(path, { bigint: true });
          check(
            held.dev === identity.dev &&
              held.ino === identity.ino &&
              held.dev === named.dev &&
              held.ino === named.ino &&
              held.size === BigInt(raw.length) &&
              named.size === held.size &&
              named.isFile() &&
              named.nlink === 1n &&
              named.uid === BigInt(process.getuid()) &&
              (named.mode & 0o777n) === 0o600n &&
              sha(observed) === phase.stderrSha256,
          );
          await file.close();
          file = undefined;
          await syncParent(path);
          phase.stderrPublished = true;
        }
      } catch (error) {
        phase.failure ??= "evidence-publication";
        failure = failure
          ? new AggregateError([failure, error], "Storage evidence publication failed")
          : error;
      } finally {
        if (file) {
          try {
            await file.close();
          } catch (error) {
            phase.failure ??= "evidence-publication";
            failure = failure
              ? new AggregateError([failure, error], "Storage evidence close failed")
              : error;
          }
        }
      }
      phase.endedAt = new Date().toISOString();
      phase.completed = !failure && phase.stderrPublished;
      phases.push(phase);
      if (failure) throw failure;
      check(phase.completed);
      return result;
    };
    const pure = async (stage, extra = []) =>
      JSON.parse(
        (
          await command(undefined, PYTHON, ["-I", "-B", HELPER, stage, mode, inputPath, ...extra], {
            limit: 65536,
            milliseconds: 30000,
          })
        ).text,
      );
    session = await pure("prepare");
    check(session.directory === resolve(dirname(inputPath), input.operation_name));
    const extra = [session.directory, session.state_sha256];
    const verify = () => pure("verify", extra);
    const work = resolve(session.directory, "work");
    const env = {
      ...base,
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
    const tool = async (label, args, output, ms = 30000) => {
      const result = await command(label, session.terraform, args, {
        env,
        directory: work,
        outputPath: resolve(session.directory, output),
        milliseconds: ms,
      });
      await verify();
      return result;
    };
    for (const [name, args] of session.auth_commands) {
      await command(
        "auth-" + name,
        session.azure,
        [...args, "--only-show-errors", "--output", "json"],
        {
          env,
          directory: work,
          outputPath: resolve(session.directory, "auth-" + name + ".json"),
          limit: 65536,
        },
      );
      await verify();
    }
    await tool("version", ["version", "-json"], "version.json");
    await pure("authenticate", extra);
    await tool(
      "init",
      ["init", "-backend=false", "-lockfile=readonly", "-input=false", "-no-color"],
      "init.stdout",
      90000,
    );
    if (mode === "plan")
      await tool(
        "plan",
        [
          "plan",
          "-input=false",
          "-no-color",
          "-lock-timeout=0s",
          "-parallelism=1",
          "-var-file=inputs.tfvars.json",
          "-out=" + resolve(session.directory, "plan.tfplan"),
        ],
        "plan.stdout",
        240000,
      );
    heldPlan = await openPlan(resolve(session.directory, "plan.tfplan"));
    await tool("show", ["show", "-json", heldPlan.path], "rendered.json");
    await heldPlan.verify();
    phases.at(-1).binaryPlanSha256 = heldPlan.sha256;
    if (mode !== "plan") {
      if (mode === "execute") {
        await command(
          "group-absent",
          session.azure,
          [
            "group",
            "exists",
            "--name",
            session.group_name,
            "--subscription",
            session.subscription_id,
            "--only-show-errors",
            "--output",
            "json",
          ],
          {
            env,
            directory: work,
            outputPath: resolve(session.directory, "group-absent.json"),
            limit: 65536,
          },
        );
        await verify();
        await pure("intent", extra);
        await heldPlan.verify();
        await tool(
          "apply",
          [
            "apply",
            "-input=false",
            "-no-color",
            "-lock-timeout=0s",
            "-parallelism=1",
            heldPlan.path,
          ],
          "apply.stdout",
          360000,
        );
        await heldPlan.verify();
        phases.at(-1).binaryPlanSha256 = heldPlan.sha256;
      }
      heldState = await openPlan(resolve(work, "terraform.tfstate"));
      await tool("state", ["show", "-json", heldState.path], "state.json");
      await heldState.verify();
      for (const prefix of ["first", "second"]) {
        for (const row of await pure("reads", extra)) {
          await command(prefix + "-" + row.label, session.azure, row.arguments, {
            env,
            directory: work,
            outputPath: resolve(session.directory, prefix + "-" + row.label + ".json"),
            limit: 131072,
          });
          await verify();
          await heldState.verify();
        }
      }
    }
    await publishPhases();
    const result = await pure(mode === "plan" ? "plan-finish" : "finish", extra);
    const receipt = await privateJson(resolve(session.directory, "result.json"));
    check(
      result.completed === true &&
        receipt.sha256 === result.result_sha256 &&
        receipt.value.completed === true &&
        receipt.value.source_sha256 === source,
    );
    await heldPlan.verify();
    if (heldState) await heldState.verify();
    clock(30000);
    return { directory: session.directory, resultSha256: receipt.sha256 };
  } catch (error) {
    if (session && phases.length && !phasesAttempted) {
      try {
        clock(RESERVE_MS, true);
        await publishPhases();
      } catch (publication) {
        throw new AggregateError([error, publication], "Storage phase evidence incomplete");
      }
    }
    throw error;
  } finally {
    const errors = [];
    for (const held of [heldState, heldPlan])
      if (held) {
        try {
          await held.close();
        } catch (e) {
          errors.push(e);
        }
      }
    if (session && mode === "execute" && !uncertainCleanup && !errors.length) {
      try {
        clock(RESERVE_MS, true);
        await conserve();
        await durable(resolve(session.directory, "local-settlement.json"), {
          kind: "nutrition-storage-local-settlement-v1",
          session_sha256: session.state_sha256,
          request_sha256: inputSha256,
          local_process_settled: true,
        });
      } catch (e) {
        errors.push(e);
      }
    }
    try {
      await heldInput.close();
    } catch (e) {
      errors.push(e);
    }
    if (Number.isFinite(horizon)) {
      try {
        clock(RESERVE_MS, true);
      } catch (e) {
        errors.push(e);
      }
    }
    check(errors.length === 0);
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--source-digest") {
    console.log(await sourceDigest());
    return;
  }
  check(args.length === 5 && args[1] === "--input" && args[3] === "--input-sha256");
  process.umask(0o077);
  const controller = new AbortController(),
    stop = () => controller.abort(new Error("Storage action interrupted"));
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, stop);
  try {
    await runStorageAcquisition(args[0], args[2], args[4], { signal: controller.signal });
    console.log(
      "Private Azure storage transaction recorded; operational admission remains separate.",
    );
  } finally {
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(s, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error("Storage transaction incomplete; retain private state and any partial output.");
    process.exitCode = 1;
  });
