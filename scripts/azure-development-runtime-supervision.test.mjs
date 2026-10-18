import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { renderPreparedRuntimeService } from "./azure-development-runtime-supervision.mjs";
import { fixture } from "./azure-development-runtime-supervision-fixture.mjs";

const sha = (raw) => createHash("sha256").update(raw).digest("hex");

test("prepared service definition is finite, invokes only fixed protected run/stop and creates no host setting", async (t) => {
  const f = await fixture(t);
  assert(f.definition.fragment.includes("Type=exec\n"));
  assert(f.definition.fragment.includes("RuntimeMaxSec=1800s\n"));
  assert(f.definition.fragment.includes("TimeoutStopSec=1500s\n"));
  assert(f.definition.fragment.includes("KillMode=control-group\nKillSignal=SIGKILL\n"));
  assert(f.definition.fragment.includes("ExecStopPost=" + f.definition.stop.join(" ") + "\n"));
  assert(
    !f.definition.fragment.includes("[Install]") && !f.definition.fragment.includes("OnCalendar="),
  );
  assert.deepEqual(f.calls, []);
  for (const change of [
    { runtimeSeconds: 12_601 },
    { nodePath: "/tmp/node %i" },
    { inputPath: "/tmp/$INPUT" },
    { owner: "wrong" },
  ])
    assert.throws(() => renderPreparedRuntimeService({ ...f.input, ...change }));
});
test("actual held fragment plus typed observed service/PID/cgroup and two lease horizons admit read-only supervision", async (t) => {
  const f = await fixture(t),
    admitted = await f.open();
  try {
    assert.equal(admitted.unit, f.definition.unit);
    assert.equal(admitted.fragmentSha256, sha(await readFile(f.definition.path)));
    assert.equal(f.calls.length, 2);
    assert.equal(f.observations.length, 2);
    assert.equal(f.observations[0].phase, "prepared-supervisor-properties");
    await admitted.conserve();
    assert.equal(f.calls.length, 4);
  } finally {
    await admitted.close();
  }
  await assert.rejects(admitted.conserve());
});
test("wrong unit, drop-ins, transient overrides, stale manager load and unrelated cgroup refuse", async (t) => {
  for (const [name, value] of [
    ["Id", "unrelated.service"],
    ["FragmentPath", "/tmp/other.service"],
    ["DropInPaths", ["/etc/systemd/system/override.conf"]],
    ["Transient", true],
    ["NeedDaemonReload", true],
    ["ActiveState", "inactive"],
  ]) {
    const f = await fixture(t);
    f.fields.Unit[name][1] = value;
    await assert.rejects(f.open());
  }
  const f = await fixture(t, { wrongCgroup: true });
  await assert.rejects(f.open());
});
test("restart, notify extension, random delay, weak kill policy, wrong UID or main PID refuse", async (t) => {
  for (const [name, value] of [
    ["Type", "notify"],
    ["Restart", "on-failure"],
    ["RuntimeRandomizedExtraUSec", 1],
    ["KillSignal", 15],
    ["FinalKillSignal", 15],
    ["KillMode", "process"],
    ["SendSIGKILL", false],
    ["NotifyAccess", "all"],
    ["TimeoutStopUSec", 1_800_000_000],
    ["User", "unrelated"],
    ["MainPID", process.pid + 1],
  ]) {
    const f = await fixture(t);
    f.fields.Service[name][1] = value;
    await assert.rejects(f.open());
  }
});
test("loaded start/stop must use exact qualified Node/source/manifest digest and cannot ignore failure or add phases", async (t) => {
  for (const mutate of [
    (f) => {
      f.fields.Service.ExecStart[1][0][1][1] = "/tmp/other.mjs";
    },
    (f) => {
      f.fields.Service.ExecStopPost[1][0][1][6] = "c".repeat(64);
    },
    (f) => {
      f.fields.Service.ExecStopPost[1][0][2] = true;
    },
    (f) => {
      f.fields.Service.ExecStopPost[1].push(structuredClone(f.fields.Service.ExecStopPost[1][0]));
    },
    (f) => {
      f.fields.Service.ExecStartPost[1] = structuredClone(f.fields.Service.ExecStopPost[1]);
    },
    (f) => {
      f.fields.Service.Environment[1].push("NODE_OPTIONS=--import=/tmp/hook.mjs");
    },
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.open());
  }
});
test("a supervisor deadline inside cleanup reserve, changed start or replaced fragment cannot admit further work", async (t) => {
  const late = await fixture(t);
  late.input.notAfterUtc = new Date(Date.parse(late.input.startedAtUtc) + 3_000_000).toISOString();
  await assert.rejects(late.open());
  const f = await fixture(t),
    admitted = await f.open();
  try {
    f.fields.Service.ExecMainStartTimestampMonotonic[1]++;
    await assert.rejects(admitted.conserve());
    f.fields.Service.ExecMainStartTimestampMonotonic[1]--;
    await writeFile(f.definition.path, f.definition.fragment + "\n");
    await assert.rejects(admitted.conserve());
  } finally {
    await admitted.close();
  }
});
test("malformed typed output, wrong raw digest and cancellation cannot become supervisor admission", async (t) => {
  for (const options of [{ malformed: true }, { wrongDigest: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.open());
  }
  const f = await fixture(t),
    cancellation = new AbortController();
  cancellation.abort();
  f.input.signal = cancellation.signal;
  await assert.rejects(f.open());
  assert.deepEqual(f.calls, []);
});
