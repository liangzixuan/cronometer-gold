/** Observe an already prepared service. This module never configures or controls systemd. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const safePath = (value) =>
  typeof value === "string" &&
  isAbsolute(value) &&
  resolve(value) === value &&
  /^\/[A-Za-z0-9_./-]+$/u.test(value);
const exact = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b));
const types = {
  Unit: {
    Id: "s",
    LoadState: "s",
    ActiveState: "s",
    SubState: "s",
    FragmentPath: "s",
    DropInPaths: "as",
    Transient: "b",
    NeedDaemonReload: "b",
  },
  Service: {
    Type: "s",
    Restart: "s",
    MainPID: "u",
    ExecMainStartTimestampMonotonic: "t",
    RuntimeMaxUSec: "t",
    RuntimeRandomizedExtraUSec: "t",
    TimeoutStopUSec: "t",
    TimeoutStopFailureMode: "s",
    KillMode: "s",
    KillSignal: "i",
    FinalKillSignal: "i",
    SendSIGKILL: "b",
    NotifyAccess: "s",
    RemainAfterExit: "b",
    Delegate: "b",
    User: "s",
    Group: "s",
    Environment: "as",
    WorkingDirectory: "s",
    UMask: "u",
    ExecStart: "a(sasbttttuii)",
    ExecStopPost: "a(sasbttttuii)",
    ExecStartPre: "a(sasbttttuii)",
    ExecStartPost: "a(sasbttttuii)",
    ExecStop: "a(sasbttttuii)",
    ExecReload: "a(sasbttttuii)",
    ControlGroup: "s",
  },
};

/** Return bytes for separately authorized host preparation; no file or service is created. */
export function renderPreparedRuntimeService(input) {
  assert(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.owner),
  );
  for (const value of [input.root, input.inputPath, input.nodePath, SOURCE])
    assert(safePath(value));
  assert(/^[a-f0-9]{64}$/u.test(input.inputSha256));
  for (const value of [input.controllerUid, input.controllerGid])
    assert(Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647);
  assert(
    Number.isSafeInteger(input.runtimeSeconds) &&
      input.runtimeSeconds >= 60 &&
      input.runtimeSeconds <= 12_600,
  );
  const unit = `nourishing-development-${input.owner}.service`,
    path = join(input.root, "supervision", unit),
    command = (action) => [
      input.nodePath,
      join(SOURCE, "scripts/azure-development-runtime.mjs"),
      action,
      "--input",
      input.inputPath,
      "--input-sha256",
      input.inputSha256,
    ],
    environment = [`NODE_EXTRA_CA_CERTS=${join(input.root, "pki/ca.crt")}`];
  const fragment = [
    "[Unit]",
    "Description=Nourishing finite private development runtime",
    "StartLimitIntervalSec=0",
    "[Service]",
    "Type=exec",
    `User=${input.controllerUid}`,
    `Group=${input.controllerGid}`,
    "Slice=system.slice",
    `WorkingDirectory=${SOURCE}`,
    "UMask=0077",
    "LimitCORE=0",
    `Environment=${environment[0]}`,
    `ExecStart=${command("run").join(" ")}`,
    `ExecStopPost=${command("stop").join(" ")}`,
    `RuntimeMaxSec=${input.runtimeSeconds}s`,
    "RuntimeRandomizedExtraSec=0",
    "TimeoutStartSec=30s",
    "TimeoutStopSec=1500s",
    "TimeoutStopFailureMode=kill",
    "KillMode=control-group",
    "KillSignal=SIGKILL",
    "FinalKillSignal=SIGKILL",
    "SendSIGKILL=yes",
    "Restart=no",
    "NotifyAccess=none",
    "RemainAfterExit=no",
    "Delegate=no",
    "StandardOutput=null",
    "StandardError=journal",
    "",
  ].join("\n");
  return Object.freeze({
    unit,
    path,
    fragment,
    sha256: sha(fragment),
    start: command("run"),
    stop: command("stop"),
    environment,
  });
}

/** Only raw process/file/D-Bus boundaries may be controlled in source acceptance. */
export async function openPreparedRuntimeSupervisor(input, execution = {}) {
  const specification = structuredClone({ ...input, signal: undefined, onObservation: undefined });
  const signal = input.signal,
    onObservation = input.onObservation;
  assert(signal instanceof AbortSignal && typeof onObservation === "function");
  assert(specification.nodePath === process.execPath);
  assert(
    specification.controllerUid === process.getuid() &&
      specification.controllerGid === process.getgid(),
  );
  assert(
    specification.busctl && Object.keys(specification.busctl).sort().join(",") === "path,sha256",
  );
  assert(
    safePath(specification.busctl.path) && /^[a-f0-9]{64}$/u.test(specification.busctl.sha256),
  );
  const expected = renderPreparedRuntimeService(specification),
    stop = Date.parse(specification.notAfterUtc),
    started = Date.parse(specification.startedAtUtc),
    origin = BigInt(specification.monotonicStartNs);
  assert(
    new Date(stop).toISOString() === specification.notAfterUtc &&
      new Date(started).toISOString() === specification.startedAtUtc,
  );
  assert(stop - started >= 1_860_000 && stop - started <= 14_400_000 && origin > 0n);
  const workDeadline = origin + BigInt(stop - started - 1_800_000) * 1_000_000n;
  const execute = execution.execute ?? runTool,
    readSystem = execution.readSystem ?? readFile;
  const held = await heldOperatorInput(expected.path, expected.sha256, {
    privateFile: true,
    maximum: 16_384,
  });
  let closed = false,
    pinnedStart;
  const guard = () => {
    signal.throwIfAborted();
    assert(!closed);
    const now = Date.now(),
      mono = process.hrtime.bigint();
    assert(now >= started && now < stop - 1_800_000 && mono >= origin && mono < workDeadline);
  };
  const objectPath = `/org/freedesktop/systemd1/unit/${expected.unit.replaceAll("-", "_2d").replaceAll(".", "_2e")}`;
  async function properties(family) {
    guard();
    const names = Object.keys(types[family]),
      diagnostics = [];
    let stderrBytes = 0;
    const args = [
      "--system",
      "--json=short",
      "--no-pager",
      "--auto-start=no",
      "--allow-interactive-authorization=no",
      "--timeout=5s",
      "get-property",
      "org.freedesktop.systemd1",
      objectPath,
      `org.freedesktop.systemd1.${family}`,
      ...names,
    ];
    const raw = await execute(specification.busctl, args, {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Math.min(5000, stop - Date.now() - 1_800_000))),
      ]),
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      directory: SOURCE,
      limit: 65_536,
      onStderr: (chunk) => {
        assert(Buffer.isBuffer(chunk));
        stderrBytes += chunk.length;
        assert(stderrBytes <= 16_384);
        diagnostics.push(Buffer.from(chunk));
      },
    });
    guard();
    assert(
      typeof raw.text === "string" &&
        Buffer.byteLength(raw.text) === raw.bytes &&
        sha(raw.text) === raw.sha256 &&
        raw.stderrBytes === stderrBytes &&
        raw.stderrSha256 === sha(Buffer.concat(diagnostics)),
    );
    assert(raw.text.endsWith("\n"));
    const rows = raw.text.slice(0, -1).split("\n");
    assert(rows.length === names.length);
    const result = {};
    for (const [index, name] of names.entries()) {
      const row = JSON.parse(rows[index]);
      exact(Object.keys(row).sort(), ["data", "type"]);
      assert(row.type === types[family][name]);
      result[name] = row.data;
    }
    await onObservation({
      phase: "prepared-supervisor-properties",
      family,
      command: args,
      stdout: raw.text,
      stdoutSha256: raw.sha256,
    });
    guard();
    return result;
  }
  const exec = (rows, argv, running) => {
    assert(Array.isArray(rows) && rows.length === 1);
    const row = rows[0];
    assert(Array.isArray(row) && row.length === 10 && row[0] === argv[0] && row[2] === false);
    exact(row[1], argv);
    for (const value of row.slice(3)) assert(Number.isSafeInteger(value) && value >= 0);
    if (running)
      assert(
        row[3] > 0 &&
          row[4] === pinnedStart &&
          row[5] === 0 &&
          row[6] === 0 &&
          row[7] === process.pid &&
          row[8] === 0 &&
          row[9] === 0,
      );
    else exact(row.slice(3), [0, 0, 0, 0, 0, 0, 0]);
  };
  async function conserve() {
    guard();
    (await held.conserve()).fill(0);
    const unit = await properties("Unit");
    exact(unit, {
      Id: expected.unit,
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      FragmentPath: expected.path,
      DropInPaths: [],
      Transient: false,
      NeedDaemonReload: false,
    });
    const service = await properties("Service");
    const observedStart = service.ExecMainStartTimestampMonotonic;
    assert(Number.isSafeInteger(observedStart) && observedStart > 0);
    if (pinnedStart === undefined) pinnedStart = observedStart;
    assert(observedStart === pinnedStart);
    const deadline = BigInt(observedStart + specification.runtimeSeconds * 1_000_000) * 1000n;
    const now = process.hrtime.bigint();
    assert(deadline > now + 60_000_000_000n && deadline <= workDeadline);
    assert(Date.now() + Number((deadline - now) / 1_000_000n) <= stop - 1_800_000);
    exec(service.ExecStart, expected.start, true);
    exec(service.ExecStopPost, expected.stop, false);
    for (const name of ["ExecStartPre", "ExecStartPost", "ExecStop", "ExecReload"])
      exact(service[name], []);
    exact(service, {
      Type: "exec",
      Restart: "no",
      MainPID: process.pid,
      ExecMainStartTimestampMonotonic: observedStart,
      RuntimeMaxUSec: specification.runtimeSeconds * 1_000_000,
      RuntimeRandomizedExtraUSec: 0,
      TimeoutStopUSec: 1_500_000_000,
      TimeoutStopFailureMode: "kill",
      KillMode: "control-group",
      KillSignal: 9,
      FinalKillSignal: 9,
      SendSIGKILL: true,
      NotifyAccess: "none",
      RemainAfterExit: false,
      Delegate: false,
      User: String(specification.controllerUid),
      Group: String(specification.controllerGid),
      Environment: expected.environment,
      WorkingDirectory: SOURCE,
      UMask: 63,
      ExecStart: service.ExecStart,
      ExecStopPost: service.ExecStopPost,
      ExecStartPre: [],
      ExecStartPost: [],
      ExecStop: [],
      ExecReload: [],
      ControlGroup: `/system.slice/${expected.unit}`,
    });
    assert(
      (await readSystem(`/proc/${process.pid}/cgroup`, "utf8")) ===
        `0::/system.slice/${expected.unit}\n`,
    );
    (await held.conserve()).fill(0);
    guard();
    return Object.freeze({
      unit: expected.unit,
      fragmentSha256: expected.sha256,
      deadlineMonotonicUs: observedStart + specification.runtimeSeconds * 1_000_000,
    });
  }
  try {
    const observation = await conserve();
    return Object.freeze({
      ...observation,
      conserve,
      async close() {
        assert(!closed);
        closed = true;
        held.raw.fill(0);
        await held.fd.close();
      },
    });
  } catch (error) {
    held.raw.fill(0);
    try {
      await held.fd.close();
    } catch (closure) {
      throw new AggregateError([error, closure], "Prepared supervisor admission failed");
    }
    throw error;
  }
}
