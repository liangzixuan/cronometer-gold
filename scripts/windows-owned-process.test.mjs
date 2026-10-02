import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runWindowsOwnedProcess, validateWindowsProcessRequest } from "./windows-owned-process.mjs";

function request(extra = {}) {
  return {
    executable: process.execPath,
    arguments: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    environment: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
    timeoutMs: 3_000,
    maxOutputBytes: 100_000,
    ...extra,
  };
}

test("validates finite limits, literal arguments and own case-unique environment before creation", () => {
  for (const extra of [
    { timeoutMs: 0 },
    { timeoutMs: 240_001 },
    { maxOutputBytes: 20_000_001 },
    { maxOutputBytes: 0 },
    { executable: "relative.exe" },
    { arguments: ["bad\0argument"] },
    { environment: { Path: "one", PATH: "two" } },
    { environment: Object.assign(Object.create({ INHERITED: "value" }), { OWN: "value" }) },
    {
      environment: {
        get DANGEROUS() {
          throw new Error("Getter must not execute");
        },
      },
    },
    { arguments: ["x".repeat(70_000)] },
  ])
    assert.throws(() => validateWindowsProcessRequest(request(extra)));
});

test("waits for close and verified complete terminal state while retaining trailing output", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  const observed = [];
  let spawnOptions;
  let finished = false;
  const promise = runWindowsOwnedProcess(
    request(),
    { onOutput: ({ bytes }) => observed.push(bytes.toString()) },
    {
      platform: "win32",
      resolvePowerShell: () => process.execPath,
      spawn: (_executable, _arguments, options) => {
        spawnOptions = options;
        return child;
      },
      signalRuntime: new EventEmitter(),
    },
  ).then((value) => {
    finished = true;
    return value;
  });
  child.stdout.write("S:101\nO:b25l\n");
  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  child.stdout.write(
    'O:dHdv\nR:{"status":0,"reason":"completed","activeZero":true,"outputDrained":true,"forcedCleanup":false}\n',
  );
  child.emit("close", 0, null);
  assert.equal((await promise).stdout, "onetwo");
  assert.deepEqual(observed, ["one", "two"]);
  assert.equal(spawnOptions.detached, false);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
});

test("an observer failure requests cancellation and still waits for controller settlement", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  const input = [];
  child.stdin.on("data", (bytes) => input.push(bytes.toString()));
  const promise = runWindowsOwnedProcess(
    request(),
    {
      onStarted() {
        throw new Error("private detail");
      },
    },
    {
      platform: "win32",
      resolvePowerShell: () => process.execPath,
      spawn: () => child,
      signalRuntime: new EventEmitter(),
    },
  );
  const rejected = assert.rejects(promise, /observer failed/u);
  child.stdout.write("S:101\n");
  assert.equal(input.at(-1), "C");
  child.stdout.write(
    'R:{"status":124,"reason":"cancelled","activeZero":true,"outputDrained":true,"forcedCleanup":true}\n',
  );
  child.emit("close", 0, null);
  await rejected;
});

test("never accepts forced cleanup or exit-only success as natural completion", async () => {
  for (const terminal of [
    null,
    { status: 0, reason: "completed", activeZero: true, outputDrained: true, forcedCleanup: true },
  ]) {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    const promise = runWindowsOwnedProcess(
      request(),
      {},
      {
        platform: "win32",
        resolvePowerShell: () => process.execPath,
        spawn: () => child,
        signalRuntime: new EventEmitter(),
      },
    );
    const rejected = assert.rejects(promise, /did not complete naturally/u);
    if (terminal) child.stdout.write(`R:${JSON.stringify(terminal)}\n`);
    child.emit("close", 0, null);
    await rejected;
  }
});

test("control-pipe failure bounds unsuccessful controller termination without claiming cleanup", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let killed = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      killed += 1;
      return false;
    },
    unref() {},
  });
  const promise = runWindowsOwnedProcess(
    request(),
    {},
    {
      platform: "win32",
      resolvePowerShell: () => process.execPath,
      spawn: () => child,
      signalRuntime: new EventEmitter(),
    },
  );
  const rejected = assert.rejects(promise, (error) => {
    assert.equal(error.result.forcedController, true);
    assert.equal(error.result.cleanupVerified, false);
    assert.equal(error.result.activeZero, undefined);
    return true;
  });
  child.stdin.destroy();
  child.stdin.emit("error", new Error("synthetic control loss"));
  context.mock.timers.tick(10_000);
  assert.equal(killed, 1);
  context.mock.timers.tick(3_000);
  await rejected;
});

function nativeRequest(source, extra = {}) {
  const environment = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (Object.hasOwn(process.env, name)) environment[name] = process.env[name];
  }
  return request({
    arguments: ["-e", source],
    environment,
    timeoutMs: 8_000,
    powershellPath: process.env.NOURISHING_POWERSHELL,
    ...extra,
  });
}
const native = { skip: process.platform !== "win32", timeout: 35_000 };

test(
  "native owner drains trailing stdout/stderr after natural zero and rejects nonzero",
  native,
  async () => {
    const result = await runWindowsOwnedProcess(
      nativeRequest(
        "process.stdout.write('first'); setTimeout(()=>{process.stdout.write('last');process.stderr.write('error-channel')},40)",
      ),
    );
    assert.equal(result.stdout, "firstlast");
    assert.equal(result.stderr, "error-channel");
    assert.equal(result.activeZero, true);
    assert.equal(result.outputDrained, true);
    assert.equal(result.forcedCleanup, false);
    await assert.rejects(runWindowsOwnedProcess(nativeRequest("process.exitCode=7")), (error) => {
      assert.equal(error.result.status, 7);
      assert.equal(error.result.activeZero, true);
      assert.equal(error.result.forcedCleanup, false);
      return true;
    });
  },
);

test(
  "native owner rejects failed process creation and immediately bounds output overflow",
  native,
  async () => {
    await assert.rejects(
      runWindowsOwnedProcess(nativeRequest("", { executable: `${process.execPath}.missing` })),
    );
    await assert.rejects(
      runWindowsOwnedProcess(
        nativeRequest("process.stdout.write('x'.repeat(50000));setInterval(()=>{},1000)", {
          maxOutputBytes: 100,
        }),
      ),
      (error) => {
        assert.equal(error.result.reason, "output limit exceeded");
        assert.equal(error.result.activeZero, true);
        assert.equal(error.result.forcedCleanup, true);
        assert.ok(Buffer.byteLength(error.result.stdout) <= 100);
        return true;
      },
    );
  },
);

test(
  "native owner bounds a timeout and a lingering descendant after leader exit",
  native,
  async () => {
    await assert.rejects(
      runWindowsOwnedProcess(nativeRequest("setInterval(()=>{},1000)", { timeoutMs: 400 })),
      (error) => {
        assert.equal(error.result.reason, "timeout");
        assert.equal(error.result.activeZero, true);
        return true;
      },
    );
    const child = "process.on('SIGINT',()=>{});setInterval(()=>{},1000);process.send(process.pid)";
    const leader = `
      const assert=require('node:assert/strict');
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{
        detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']
      });
      const readyTimeout=setTimeout(()=>process.exit(91),3000);
      child.once('error',()=>process.exit(92));
      child.once('exit',()=>process.exit(93));
      child.once('message',pid=>{
        assert.equal(pid,child.pid);
        clearTimeout(readyTimeout);
        child.disconnect();
        child.unref();
        process.stdout.write('child-ready:'+pid+'\\n',()=>process.exit(0));
      });
    `;
    await assert.rejects(runWindowsOwnedProcess(nativeRequest(leader)), (error) => {
      assert.match(error.result.stdout, /^child-ready:[1-9]\d*\n$/);
      assert.equal(error.result.reason, "lingering descendant or output");
      assert.equal(error.result.activeZero, true);
      assert.equal(error.result.forcedCleanup, true);
      return true;
    });
  },
);

test("native cancellation settles a Ctrl+C-resistant grandchild", native, async () => {
  const resistant =
    "process.on('SIGINT',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)";
  const middle = `const {spawn}=require('node:child_process');process.on('SIGINT',()=>{});spawn(process.execPath,['-e',${JSON.stringify(resistant)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  const leader = `const {spawn}=require('node:child_process');process.on('SIGINT',()=>{});spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  let output = "";
  await assert.rejects(
    runWindowsOwnedProcess(nativeRequest(leader, { signal: controller.signal }), {
      onOutput({ bytes }) {
        output += bytes.toString();
        if (output.includes("ready\n")) controller.abort();
      },
    }),
    (error) => {
      assert.equal(error.result.reason, "cancelled");
      assert.equal(error.result.activeZero, true);
      assert.equal(error.result.forcedCleanup, true);
      return true;
    },
  );
});

test("session lifetime requires an explicit own boolean and never widens finite limits", () => {
  assert.equal(
    validateWindowsProcessRequest(request({ session: true, timeoutMs: 3_600_000 })).session,
    true,
  );
  for (const extra of [
    { session: true, timeoutMs: 3_600_001 },
    { session: false, timeoutMs: 240_001 },
    { session: "true" },
    { session: 1 },
  ])
    assert.throws(() => validateWindowsProcessRequest(request(extra)));
  const inherited = Object.assign(Object.create({ session: true }), request());
  assert.throws(() => validateWindowsProcessRequest(inherited), /session/u);
  const getter = request();
  Object.defineProperty(getter, "session", {
    get() {
      assert.fail("session getter must not run");
    },
  });
  assert.throws(() => validateWindowsProcessRequest(getter), /session/u);
});

function simulatedSession(extra = {}, observers = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  const controller = new AbortController();
  const input = [];
  child.stdin.on("data", (value) => input.push(value.toString()));
  const promise = runWindowsOwnedProcess(
    request({ session: true, signal: controller.signal, ...extra }),
    observers,
    {
      platform: "win32",
      resolvePowerShell: () => process.execPath,
      spawn: () => child,
      signalRuntime: new EventEmitter(),
    },
  );
  child.stdout.write("S:101\n");
  return { child, controller, input, promise };
}
function stoppedTerminal(extra = {}) {
  return {
    status: 0,
    reason: "cancelled",
    activeZero: true,
    outputDrained: true,
    forcedCleanup: false,
    parentLost: false,
    watchdogFired: false,
    ctrlCDelivered: true,
    leaderExitedAfterCtrlC: true,
    ...extra,
  };
}
function finishSession(child, terminal) {
  child.stdout.write(`R:${JSON.stringify(terminal)}\n`);
  child.emit("close", 0, null);
}

test("session live output precedes a separately verified requested stop", async () => {
  const chunks = [];
  const { child, controller, input, promise } = simulatedSession(
    {},
    { onOutput: ({ bytes }) => chunks.push(bytes.toString()) },
  );
  child.stdout.write("O:bGl2ZQo=\n");
  assert.deepEqual(chunks, ["live\n"]);
  controller.abort();
  assert.equal(input.at(-1), "C");
  finishSession(child, stoppedTerminal());
  const result = await promise;
  assert.equal(result.completion, "stopped");
  assert.equal(result.stdout, "live\n");
  assert.equal(result.reason, "cancelled");
});

test("session ordinary completion remains distinct and finite cancellation still rejects", async () => {
  const natural = simulatedSession();
  finishSession(
    natural.child,
    stoppedTerminal({ reason: "completed", ctrlCDelivered: false, leaderExitedAfterCtrlC: false }),
  );
  assert.equal((await natural.promise).completion, "completed");
  const finite = simulatedSession({ session: false });
  const rejected = assert.rejects(finite.promise, /cancelled/u);
  finite.controller.abort();
  finishSession(finite.child, stoppedTerminal());
  await rejected;
});

test("session stop cannot hide missing Ctrl+C, nonzero exit, parent loss, timeout or cleanup failure", async () => {
  for (const extra of [
    { ctrlCDelivered: false },
    { leaderExitedAfterCtrlC: false },
    { status: 130 },
    { parentLost: true },
    { watchdogFired: true },
    { reason: "timeout" },
    { reason: "output limit exceeded" },
    { reason: "parent lost" },
    { forcedCleanup: true },
    { activeZero: false },
    { outputDrained: false },
  ]) {
    const run = simulatedSession();
    const rejected = assert.rejects(run.promise, /did not complete naturally/u);
    run.controller.abort();
    finishSession(run.child, stoppedTerminal(extra));
    await rejected;
  }
  const unsolicited = simulatedSession();
  const rejected = assert.rejects(unsolicited.promise, /did not complete naturally/u);
  finishSession(unsolicited.child, stoppedTerminal());
  await rejected;
});

test("session observer failure remains a failure after otherwise clean Ctrl+C cleanup", async () => {
  const run = simulatedSession(
    {},
    {
      onOutput() {
        throw new Error("synthetic observer failure");
      },
    },
  );
  const rejected = assert.rejects(run.promise, /observer failed/u);
  run.child.stdout.write("O:bGl2ZQo=\n");
  run.controller.abort();
  finishSession(run.child, stoppedTerminal());
  await rejected;
});

test(
  "native session accepts only a requested real Ctrl+C exit with drained output and empty job",
  native,
  async () => {
    const stop = new AbortController();
    let output = "";
    const result = await runWindowsOwnedProcess(
      nativeRequest(
        "const timer=setInterval(()=>{},1000);process.on('SIGINT',()=>{clearInterval(timer);process.stdout.write('stopped\\n')});process.stdout.write('session-ready\\n')",
        { session: true, signal: stop.signal },
      ),
      {
        onOutput({ bytes }) {
          output += bytes.toString();
          if (output.includes("session-ready\n")) stop.abort();
        },
      },
    );
    assert.equal(result.completion, "stopped");
    assert.equal(result.status, 0);
    assert.equal(result.ctrlCDelivered, true);
    assert.equal(result.leaderExitedAfterCtrlC, true);
    assert.equal(result.activeZero, true);
    assert.equal(result.outputDrained, true);
    assert.equal(result.forcedCleanup, false);
    assert.equal(result.parentLost, false);
    assert.equal(result.watchdogFired, false);
    assert.match(result.stdout, /stopped\n$/u);
  },
);

test(
  "native session timeout and resistant cancellation remain failed, settled outcomes",
  native,
  async () => {
    await assert.rejects(
      runWindowsOwnedProcess(
        nativeRequest("setInterval(()=>{},1000)", {
          session: true,
          timeoutMs: 400,
        }),
      ),
      (error) => {
        assert.equal(error.result.reason, "timeout");
        assert.equal(error.result.activeZero, true);
        assert.equal(error.result.completion, undefined);
        return true;
      },
    );
    const stop = new AbortController();
    let output = "";
    await assert.rejects(
      runWindowsOwnedProcess(
        nativeRequest(
          "process.on('SIGINT',()=>{});setInterval(()=>{},1000);process.stdout.write('ready\\n')",
          { session: true, signal: stop.signal },
        ),
        {
          onOutput({ bytes }) {
            output += bytes.toString();
            if (output.includes("ready\n")) stop.abort();
          },
        },
      ),
      (error) => {
        assert.equal(error.result.reason, "cancelled");
        assert.equal(error.result.forcedCleanup, true);
        assert.equal(error.result.activeZero, true);
        assert.equal(error.result.completion, undefined);
        return true;
      },
    );
  },
);
