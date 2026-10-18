/** Prepared-host recovery command. Installation phases are integrated in the same runtime increment. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import {
  admitRuntimeClientAccess,
  runtimeClientDeadline,
} from "./azure-development-runtime-client.mjs";
import { openRuntimeDocker } from "./azure-development-runtime-docker.mjs";
import { openRuntimeJournal, readRuntimeJournal } from "./azure-development-runtime-journal.mjs";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { runTool, trustedPath } from "./postgres-operator-process.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const failure = () =>
  new Error("Development runtime failed; retained resources or evidence may remain uncertain");

function invocation(args) {
  assert(
    args.length === 5 &&
      args[0] === "stop" &&
      args[1] === "--input" &&
      args[3] === "--input-sha256",
  );
  assert(
    typeof args[2] === "string" &&
      isAbsolute(args[2]) &&
      resolve(args[2]) === args[2] &&
      digest(args[4]),
  );
  return { path: args[2], sha256: args[4] };
}
function originalLease(input, admitted, signal) {
  assert(signal instanceof AbortSignal);
  assert(
    admitted.notAfterUtc === input.notAfterUtc &&
      new Date(Date.parse(input.notAfterUtc)).toISOString() === input.notAfterUtc,
  );
  assert(
    typeof admitted.startedAtUtc === "string" &&
      new Date(Date.parse(admitted.startedAtUtc)).toISOString() === admitted.startedAtUtc,
  );
  assert(
    typeof admitted.monotonicStartNs === "string" &&
      /^[1-9][0-9]{0,24}$/u.test(admitted.monotonicStartNs),
  );
  const started = Date.parse(admitted.startedAtUtc),
    stop = Date.parse(input.notAfterUtc),
    duration = stop - started;
  assert(duration >= 1_860_000 && duration <= 14_400_000);
  const origin = BigInt(admitted.monotonicStartNs);
  let latest = Date.now();
  const remaining = (maximum) => {
    assert(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1_800_000);
    const now = Date.now(),
      elapsedNs = process.hrtime.bigint() - origin;
    assert(elapsedNs >= 0n);
    const elapsed = Number(elapsedNs / 1_000_000n);
    assert(now >= started && now >= latest && now < stop && elapsed >= 0 && elapsed < duration);
    latest = now;
    const budget = Math.floor(Math.min(maximum, stop - now, duration - elapsed));
    assert(budget > 0);
    return budget;
  };
  const cleanupSignal = AbortSignal.timeout(remaining(1_800_000));
  // Cleanup is confined to the original remaining horizon; cancellation grants no new work.
  return Object.freeze({
    notAfterUtc: input.notAfterUtc,
    remaining,
    cleanupSignal,
    workSignal: AbortSignal.any([signal, cleanupSignal]),
    guardCleanup: () => remaining(1),
  });
}
function processToken(raw, pid) {
  assert(typeof raw === "string" && raw.length <= 8192 && raw.startsWith(`${pid} (`));
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  assert(fields.length >= 20 && /^[0-9]+$/u.test(fields[19]));
  return fields[19];
}

/** Stop only the durable known-ID prefix after hard controller loss. No service env/key is loaded. */
export async function recoverPreparedDevelopmentRuntime(args, execution = {}) {
  const cli = invocation(args),
    execute = execution.execute ?? runTool,
    readSystem = execution.readSystem ?? readFile;
  const signal = execution.signal ?? new AbortController().signal;
  let held,
    journal,
    result,
    primary,
    failed = false;
  const closureErrors = [];
  try {
    held = await heldOperatorInput(cli.path, cli.sha256, { privateFile: true, maximum: 2_097_152 });
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held.raw));
    assert(Buffer.from(`${canonicalJson(input)}\n`).equals(held.raw));
    const clientAccess = admitRuntimeClientAccess(input.clientAccess);
    assert(input.schemaVersion === 1 && input.kind === "nutrition-development-runtime-input-v1");
    assert(/^[a-f0-9]{40}$/u.test(input.sourceRevision) && uuid(input.owner));
    assert(input.project === `nourishing-development-${input.owner}`);
    assert(
      typeof input.root === "string" &&
        isAbsolute(input.root) &&
        resolve(input.root) === input.root &&
        input.root !== "/",
    );
    await trustedPath(input.root, { directory: true, privateLeaf: true });
    for (const name of ["docker", "git", "node"]) {
      const tool = input.tools?.[name];
      assert(
        tool &&
          Object.keys(tool).sort().join(",") === "path,sha256" &&
          isAbsolute(tool.path) &&
          resolve(tool.path) === tool.path &&
          digest(tool.sha256),
      );
    }
    assert(input.tools.node.path === process.execPath);
    assert(uuid(input.host?.bootId));
    const checkBoot = async () =>
      assert(
        (await readSystem("/proc/sys/kernel/random/boot_id", "utf8")).trim() === input.host.bootId,
        "Prepared host boot identity changed",
      );
    await checkBoot();
    const originalDirectory = join(input.root, "journal");
    const original = await readRuntimeJournal(originalDirectory, cli.sha256);
    assert(original.records.length > 0);
    const admitted = original.records[0].event;
    assert(
      admitted.phase === "admitted" &&
        admitted.inputSha256 === cli.sha256 &&
        admitted.sourceRevision === input.sourceRevision &&
        admitted.bootId === input.host.bootId,
    );
    assert(
      Number.isSafeInteger(admitted.controllerPid) &&
        admitted.controllerPid > 1 &&
        admitted.controllerPid <= 2_147_483_647,
    );
    assert(
      typeof admitted.controllerStartToken === "string" &&
        /^[1-9][0-9]{0,24}$/u.test(admitted.controllerStartToken),
    );
    let alive;
    try {
      alive = processToken(
        await readSystem(`/proc/${admitted.controllerPid}/stat`, "utf8"),
        admitted.controllerPid,
      );
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
    assert(alive !== admitted.controllerStartToken, "Original runtime controller is still active");
    const lease = originalLease(input, admitted, signal);
    const created = original.records.filter((record) => record.event.phase === "created");
    assert(
      created.length === 1,
      "No complete durable creation record; retain unknown creation for reconciliation",
    );
    const creationIntents = original.records.filter(
      (record) => record.event.phase === "create-intent" && record.sequence < created[0].sequence,
    );
    const configurations = original.records.filter(
      (record) => record.event.phase === "compose-config" && record.sequence < created[0].sequence,
    );
    assert(creationIntents.length === 1 && configurations.length === 1);
    const observed = configurations[0].event;
    assert(
      observed.completed === true &&
        typeof observed.stdout === "string" &&
        sha(observed.stdout) === observed.stdoutSha256,
    );
    const model = JSON.parse(observed.stdout);
    assert(sha(canonicalJson(model)) === creationIntents[0].event.modelSha256);
    const claim = created[0].event;
    const imageObservations = Object.fromEntries(
      Object.values(claim.contracts).map((contract) => [contract.service.image, contract.image]),
    );
    let evidenceIncomplete = !original.complete;
    const conserve = async () => {
      lease.guardCleanup();
      await checkBoot();
      try {
        (await held.conserve()).fill(0);
        const current = await readRuntimeJournal(originalDirectory, cli.sha256);
        assert(
          current.lastSha256 === original.lastSha256 &&
            current.records.length === original.records.length &&
            current.complete === original.complete,
        );
      } catch {
        evidenceIncomplete = true;
      }
      lease.guardCleanup();
    };
    journal = await openRuntimeJournal(join(input.root, "recovery-stop-journal"));
    await journal.publish({
      phase: "admitted",
      inputSha256: cli.sha256,
      sourceRevision: input.sourceRevision,
      originalJournalSha256: original.lastSha256,
      originalJournalComplete: original.complete,
      originalUncertainAt: original.uncertainAt,
      bootId: input.host.bootId,
      notAfterUtc: input.notAfterUtc,
    });
    const environment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const prerequisite = async (tool, argv, expected) => {
      await conserve();
      const began = new Date().toISOString();
      const raw = await execute(tool, argv, {
        signal: AbortSignal.any([
          lease.cleanupSignal,
          AbortSignal.timeout(lease.remaining(30_000)),
        ]),
        env: environment,
        directory: SOURCE,
        limit: 65_536,
      });
      assert(
        typeof raw.text === "string" &&
          Buffer.byteLength(raw.text) === raw.bytes &&
          sha(raw.text) === raw.sha256,
      );
      assert.equal(raw.text, expected);
      await conserve();
      await journal.publish({
        phase: "recovery-prerequisite",
        command: argv,
        startedAtUtc: began,
        endedAtUtc: new Date().toISOString(),
        stdout: raw.text,
        stdoutSha256: raw.sha256,
      });
    };
    await prerequisite(input.tools.node, ["--version"], "v22.23.2\n");
    await prerequisite(
      input.tools.git,
      ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
      `${input.sourceRevision}\n`,
    );
    await prerequisite(
      input.tools.git,
      ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"],
      "",
    );
    const driver = await openRuntimeDocker(
      {
        project: input.project,
        owner: input.owner,
        revision: input.sourceRevision,
        root: input.root,
        dockerConfig: join(input.root, "docker-config"),
        images: input.images,
        docker: input.tools.docker,
        imageObservations,
        clientAccess,
        apiDeadlineNs: runtimeClientDeadline(clientAccess, admitted),
        lease,
        journal,
        conserve,
        recovery: { model, createdRecord: claim },
      },
      execute,
    );
    const stopped = await driver.stop();
    await conserve();
    result = Object.freeze({
      kind: "nutrition-development-runtime-stop-v1",
      sourceRevision: input.sourceRevision,
      project: input.project,
      knownOwnedContainersSettled: stopped.length,
      originalJournalComplete: original.complete,
      originalJournalSha256: original.lastSha256,
      localOnly: true,
      operationalAcceptance: false,
    });
    await journal.publish({ phase: "recovery-stopped", result });
    assert(
      !evidenceIncomplete,
      "Known owned containers settled; retained original evidence remains incomplete",
    );
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    if (held) {
      held.raw.fill(0);
      try {
        await held.fd.close();
      } catch (error) {
        closureErrors.push(error);
      }
    }
    if (journal)
      try {
        await journal.close();
      } catch (error) {
        closureErrors.push(error);
      }
  }
  if (failed && closureErrors.length)
    throw new AggregateError([primary, ...closureErrors], failure().message);
  if (failed) throw primary;
  if (closureErrors.length) throw new AggregateError(closureErrors, failure().message);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const cancellation = new AbortController(),
    abort = () => cancellation.abort();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, abort);
  try {
    const args = process.argv.slice(2);
    const result =
      args[0] === "run"
        ? await (await import("./azure-development-runtime-run.mjs")).runPreparedDevelopmentRuntime(
            args,
            { signal: cancellation.signal },
          )
        : await recoverPreparedDevelopmentRuntime(args, { signal: cancellation.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${failure().message}\n`);
    process.exitCode = 1;
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, abort);
  }
}
