import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDevelopmentSession, sourceDigest } from "./azure-development-session.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
const contract = fileURLToPath(
  new URL("../infra/development/azure/test-contract.py", import.meta.url),
);
const now = new Date("2026-10-01T08:00:00Z");
const absent = (path) => assert.rejects(lstat(path), { code: "ENOENT" });
async function json(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}

async function fixture(t, subset) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const python = { path: await realpath("/usr/bin/python3") };
  python.sha256 = hash(await readFile(python.path));
  // Actual pure policy and private fixture constructors; no cloud/tool process is substituted here.
  const responses =
    subset === undefined
      ? "f.responses"
      : `m.partial_responses(json.loads(f.rendered_raw),${JSON.stringify(subset)})`;
  const setup = `import importlib.util,json\ns=importlib.util.spec_from_file_location('fixtures',${JSON.stringify(contract)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nf=m.SessionPolicy('runTest');f.setUp();f.temporary._finalizer.detach()\npins={'terraform':m.S.A.TF_SHA256,'provider':m.S.A.PROVIDER_FILES};m.Q.write_json(f.root/'fixture-pins.json',pins)\nprint(json.dumps({'root':str(f.root),'input':str(f.input),'terraform':str(f.tf),'profile':str(f.profile),'source':m.S.source_digest(),'responses':${responses},'rendered':f.rendered_raw.decode(),'native':m.native_fixture(),'oldProfile':m.PROFILE,'expected':f.expected}))`;
  const made = await runTool(python, ["-I", "-B", "-c", setup], {
    signal: AbortSignal.timeout(10000),
    env,
    directory: dirname(contract),
    limit: 200000,
  });
  const f = JSON.parse(made.text);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal(f.source, await sourceDigest(), "Python and Node bind the same actual source");
  const commands = [];
  const state = { fail: undefined, mutationStarted: false, mode: "execute", calls: commands };
  const controller = new AbortController();
  const run = async (tool, argv, options) => {
    if (tool.path === "/usr/bin/python3.12") {
      const helper = argv[2];
      const args = argv.slice(3);
      const program = `import importlib.util,json\nfrom pathlib import Path\nfrom datetime import datetime\ns=importlib.util.spec_from_file_location('policy',${JSON.stringify(helper)});q=importlib.util.module_from_spec(s);s.loader.exec_module(q)\np=json.loads(Path(${JSON.stringify(join(f.root, "fixture-pins.json"))}).read_text());q.A.TF_SHA256=p['terraform'];q.A.PROVIDER_FILES={k:tuple(v) for k,v in p['provider'].items()};q.P.tool_digest=lambda path:(q.P.CLI_SHA256,100);q.datetime=type('FixtureClock',(),{'now':staticmethod(lambda tz:datetime.fromisoformat(${JSON.stringify(state.instant ?? "2026-10-01T08:00:00+00:00")}))});raise SystemExit(q.main(${JSON.stringify(args)}))`;
      const result = await runTool(python, ["-I", "-B", "-c", program], options);
      if (
        args[0] === "finish" &&
        helper.endsWith("session-policy.py") &&
        state.fail === "publication"
      )
        throw new Error("synthetic post-publication rejection");
      return result;
    }
    const phase = basename(options.outputPath ?? "");
    commands.push({ tool: tool.path, argv: [...argv], output: phase });
    assert.ok(!JSON.stringify(options.env).includes("PRIVATE_CANARY"));
    assert.equal(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
    let value, text;
    if (tool.path === "/usr/bin/az") {
      if (argv[0] === "version")
        value = {
          "azure-cli": "2.90.0",
          "azure-cli-core": "2.90.0",
          "azure-cli-telemetry": "1",
          extensions: {},
        };
      else if (argv[0] === "extension") value = [];
      else if (argv[0] === "account")
        value = {
          id: f.expected.subscriptionId,
          tenantId: f.expected.tenantId,
          state: "Enabled",
          environmentName: "AzureCloud",
        };
      else if (phase === "auth-subscription.json")
        value = {
          ...f.expected,
          state: "Enabled",
          subscriptionPolicies: { quotaId: "AzureForStudents_2018-01-01", spendingLimit: "On" },
        };
      else if (/^(before|after)-/u.test(phase)) {
        const label = phase.replace(/^(before|after)-/u, "").replace(/\.json$/u, "");
        if (state.fail === "readback" && phase === "after-vm.json")
          throw new Error("synthetic lost readback after mutation");
        if (state.fail === "readback-child" && phase === "after-vm.json")
          await runTool(
            python,
            [
              "-I",
              "-B",
              "-c",
              `from pathlib import Path; Path(${JSON.stringify(join(f.root, "readback-child-started"))}).write_text('started'); raise SystemExit(7)`,
            ],
            {
              ...options,
              outputPath: undefined,
            },
          );
        value = label === "groups" ? { value: [] } : f.responses.live[label];
      } else {
        const record = Object.values(f.native)
          .flatMap((d) => d.commands)
          .find(
            (r) =>
              JSON.stringify(r.arguments.map((v) => (v === f.oldProfile ? f.profile : v))) ===
              JSON.stringify(argv),
          );
        assert.ok(record, `only fixed fixture request admitted: ${phase}`);
        value = record.selected;
      }
    } else {
      assert.equal(tool.path, f.terraform);
      assert.equal(options.env.TF_INPUT, "0");
      assert.equal(options.env.ARM_USE_MSI, "false");
      const operation = dirname(options.directory);
      if (argv[0] === "version") value = { terraform_version: "1.5.7", platform: "linux_amd64" };
      if (argv[0] === "init") {
        assert.deepEqual(argv, [
          "init",
          "-backend=false",
          "-lockfile=readonly",
          "-input=false",
          "-no-color",
        ]);
        const parent = join(
          options.env.TF_DATA_DIR,
          "providers/registry.terraform.io/hashicorp/azurerm/4.79.0",
        );
        await mkdir(parent, { recursive: true, mode: 0o700 });
        for (let p = parent; p !== options.env.TF_DATA_DIR; p = dirname(p)) await chmod(p, 0o700);
        await symlink(
          join(
            operation,
            "terraform/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64",
          ),
          join(parent, "linux_amd64"),
        );
      }
      if (argv[0] === "plan") {
        assert.equal(state.mode, "prepare-dispose");
        assert.deepEqual(argv.slice(0, -1), [
          "plan",
          "-destroy",
          "-input=false",
          "-no-color",
          "-lock-timeout=0s",
          "-parallelism=1",
          "-var-file=inputs.tfvars.json",
        ]);
        await writeFile(argv.at(-1).slice(5), "synthetic destruction plan", {
          mode: 0o600,
          flag: "wx",
        });
      }
      if (argv[0] === "show") {
        if (argv[2].endsWith("terraform.tfstate"))
          value =
            ["dispose", "reconcile-dispose"].includes(state.mode) && phase === "final-state.json"
              ? { format_version: "1.0", terraform_version: "1.5.7" }
              : f.responses.state;
        else {
          assert.match(argv[2], /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
          assert.equal(
            await readFile(argv[2], "utf8"),
            ["execute", "reconcile", "reconcile-partial", "observe-shutdown"].includes(state.mode)
              ? "private synthetic binary plan"
              : "synthetic destruction plan",
          );
          if (
            ["execute", "reconcile", "reconcile-partial", "observe-shutdown"].includes(state.mode)
          )
            text = f.rendered;
          else value = f.responses.destroy;
        }
      }
      if (argv[0] === "apply") {
        assert.notEqual(state.mode, "prepare-dispose");
        assert.deepEqual(argv.slice(0, -1), [
          "apply",
          "-input=false",
          "-no-color",
          "-lock-timeout=0s",
          "-parallelism=1",
        ]);
        assert.match(argv.at(-1), /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
        const intent = JSON.parse(await readFile(join(operation, "mutation-intent.json"), "utf8"));
        assert.equal(intent.outcome, "unknown-until-reconciled");
        assert.equal(intent.binary_plan_sha256, hash(await readFile(argv.at(-1))));
        state.mutationStarted = true;
        if (state.fail === "apply" || state.fail === "cleanup") {
          await writeFile(join(options.directory, "errored.tfstate"), "partial retained state", {
            flag: "wx",
            mode: 0o600,
          });
          if (options.outputPath)
            await writeFile(options.outputPath, "partial private stdout", {
              flag: "wx",
              mode: 0o600,
            });
          throw new Error(
            state.fail === "cleanup"
              ? "synthetic failed group settlement"
              : "synthetic failed apply",
          );
        }
        const raw =
          state.mode === "dispose"
            ? { ...f.responses.raw, serial: 2, resources: [] }
            : f.responses.raw;
        // Preserve the actual state bytes across read-only sessions; create/apply alone writes state.
        const statePath = join(options.directory, "terraform.tfstate");
        await writeFile(statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
        if (["apply-complete", "apply-partial"].includes(state.fail))
          await runTool(
            python,
            [
              "-I",
              "-B",
              "-c",
              `from pathlib import Path; Path(${JSON.stringify(join(f.root, "apply-child-started"))}).write_text('started'); raise SystemExit(7)`,
            ],
            {
              ...options,
              outputPath: undefined,
            },
          );
        if (state.fail === "abort")
          controller.abort(new Error("synthetic interruption after actual boundary reached"));
      }
    }
    text ??= value === undefined ? "synthetic completed\n" : `${JSON.stringify(value)}\n`;
    if (options.outputPath) await writeFile(options.outputPath, text, { mode: 0o600, flag: "wx" });
    return {
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
      text: options.outputPath ? undefined : text,
      stderrBytes: 0,
      stderrSha256: hash(""),
    };
  };
  const execute = () =>
    runDevelopmentSession(
      state.mode,
      f.input,
      { signal: controller.signal, environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
      run,
    );
  return { ...f, state, run, execute };
}

test("session refuses invalid mode, source, deadline and ambient authority before any child", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const forbidden = async () => {
    calls++;
    throw new Error("must not execute");
  };
  await assert.rejects(runDevelopmentSession("destroy", f.input, { environment: {} }, forbidden));
  await assert.rejects(
    runDevelopmentSession(
      "execute",
      f.input,
      { environment: { ARM_CLIENT_SECRET: "PRIVATE_CANARY" } },
      forbidden,
    ),
  );
  const original = await readFile(f.input);
  for (const change of [
    { source_sha256: "0".repeat(64) },
    { not_after_utc: "2026-10-01T08:01:00Z" },
  ]) {
    await writeFile(f.input, JSON.stringify({ ...JSON.parse(original), ...change }));
    await assert.rejects(runDevelopmentSession("execute", f.input, { environment: {} }, forbidden));
  }
  assert.equal(calls, 0);
});

test("maintained three-mode sequence uses actual pure child helpers and retained exact plans", {
  timeout: 120000,
}, async (t) => {
  const f = await fixture(t);
  let result = await f.execute();
  let retained = join(result.directory, "result.json");
  assert.equal(JSON.parse(await readFile(retained)).mode, "execute");
  const originalOwned = retained;
  for (const mode of ["prepare-dispose", "dispose"]) {
    f.state.mode = mode;
    const input = join(f.root, `${mode}-request.json`);
    const field = mode === "prepare-dispose" ? "ownership" : "disposal";
    await json(input, {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${mode === "prepare-dispose" ? "a" : "b"}`.replace(
        /([ab])$/u,
        "$1$1$1$1$1$1$1$1$1$1$1$1",
      ),
      not_after_utc: "2026-10-01T08:18:00Z",
      [`${field}_result`]: retained,
      [`${field}_result_sha256`]: hash(await readFile(retained)),
    });
    const before = f.state.calls.length;
    result = await runDevelopmentSession(mode, input, { environment: {} }, f.run);
    const calls = f.state.calls.slice(before);
    assert.equal(calls.filter((c) => c.argv[0] === "apply").length, mode === "dispose" ? 1 : 0);
    assert.equal(
      calls.filter((c) => c.argv[0] === "plan").length,
      mode === "prepare-dispose" ? 1 : 0,
    );
    retained = join(result.directory, "result.json");
    const receipt = JSON.parse(await readFile(retained));
    assert.equal(receipt.mode, mode);
    if (mode === "prepare-dispose") await absent(join(result.directory, "mutation-intent.json"));
    else assert.equal(receipt.disposed, true);
  }
  assert.equal(f.state.calls.filter((c) => c.argv[0] === "apply").length, 2);
  assert.equal(
    JSON.parse(await readFile(originalOwned)).completed,
    true,
    "original ownership remains retained",
  );
});

for (const failure of ["apply", "readback", "abort", "cleanup", "publication"]) {
  test(`session retains unknown or published outcome after ${failure} without retry`, {
    timeout: 60000,
  }, async (t) => {
    const f = await fixture(t);
    f.state.fail = failure;
    await assert.rejects(f.execute());
    assert.equal(f.state.mutationStarted, true, "failure must reach the single mutation boundary");
    assert.equal(f.state.calls.filter((c) => c.argv[0] === "apply").length, 1);
    const directory = join(f.root, "nourishing-session-0123456789ab");
    assert.equal(
      JSON.parse(await readFile(join(directory, "mutation-intent.json"))).outcome,
      "unknown-until-reconciled",
    );
    if (failure === "publication")
      assert.equal(JSON.parse(await readFile(join(directory, "result.json"))).completed, true);
    else await absent(join(directory, "result.json"));
    if (["apply", "cleanup"].includes(failure))
      assert.equal(
        await readFile(join(directory, "work/errored.tfstate"), "utf8"),
        "partial retained state",
      );
    assert.equal(
      await readFile(join(f.root, "nourishing-dev-0123456789ab/plan.tfplan"), "utf8"),
      "private synthetic binary plan",
    );
  });
}

async function snapshot(path) {
  const entries = {};
  for (const name of (await readdir(path, { recursive: true })).sort()) {
    const full = join(path, name),
      info = await lstat(full);
    entries[name] = {
      mode: info.mode & 0o777,
      value: info.isSymbolicLink()
        ? await readlink(full)
        : info.isFile()
          ? hash(await readFile(full))
          : "directory",
    };
  }
  return entries;
}

for (const failure of ["apply-complete", "readback-child", "publication"]) {
  test(`read-only reconciliation after ${failure} preserves failure and supports separate disposal`, {
    timeout: 120000,
  }, async (t) => {
    const f = await fixture(t);
    f.state.fail = failure;
    await assert.rejects(f.execute());
    if (failure === "readback-child")
      assert.equal(await readFile(join(f.root, "readback-child-started"), "utf8"), "started");
    if (failure === "apply-complete")
      assert.equal(await readFile(join(f.root, "apply-child-started"), "utf8"), "started");
    const original = join(f.root, "nourishing-session-0123456789ab"),
      before = await snapshot(original);
    f.state.fail = undefined;
    f.state.mode = "reconcile";
    const input = join(f.root, "reconcile.json");
    await json(input, {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${"c".repeat(12)}`,
      not_after_utc: "2026-10-01T08:18:00Z",
      execute_request: f.input,
      execute_directory: original,
      execute_session_sha256: hash(await readFile(join(original, "session.json"))),
      execute_intent_sha256: hash(await readFile(join(original, "mutation-intent.json"))),
    });
    if (failure === "readback-child") {
      for (const [kind, suffix] of [
        ["child", "d"],
        ["abort", "e"],
      ]) {
        const failedInput = join(f.root, `reconcile-${kind}.json`);
        const request = JSON.parse(await readFile(input));
        request.operation_name = `nourishing-session-${suffix.repeat(12)}`;
        await json(failedInput, request);
        const stop = new AbortController();
        const start = f.state.calls.length;
        const reject = async (tool, argv, options) => {
          if (basename(options.outputPath ?? "") === "before-vm.json") {
            if (kind === "child") {
              const python = { path: await realpath("/usr/bin/python3") };
              python.sha256 = hash(await readFile(python.path));
              return runTool(
                python,
                [
                  "-I",
                  "-B",
                  "-c",
                  `from pathlib import Path; Path(${JSON.stringify(join(f.root, "reconcile-child-started"))}).write_text('started'); raise SystemExit(7)`,
                ],
                { ...options, outputPath: undefined },
              );
            }
            const observed = await f.run(tool, argv, options);
            stop.abort(new Error("synthetic reconciliation interruption"));
            return observed;
          }
          return f.run(tool, argv, options);
        };
        await assert.rejects(
          runDevelopmentSession(
            "reconcile",
            failedInput,
            { environment: {}, signal: stop.signal },
            reject,
          ),
        );
        if (kind === "child")
          assert.equal(await readFile(join(f.root, "reconcile-child-started"), "utf8"), "started");
        await absent(join(f.root, request.operation_name, "result.json"));
        await absent(join(f.root, request.operation_name, "mutation-intent.json"));
        assert.ok(
          f.state.calls
            .slice(start)
            .every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])),
        );
        assert.deepEqual(await snapshot(original), before);
      }
    }
    const start = f.state.calls.length;
    let result = await runDevelopmentSession("reconcile", input, { environment: {} }, f.run);
    const calls = f.state.calls.slice(start);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])));
    let retained = join(result.directory, "result.json"),
      receipt = JSON.parse(await readFile(retained));
    assert.equal(receipt.mode, "reconcile");
    assert.equal(receipt.original_execution_outcome, "unconfirmed");
    assert.equal(receipt.external_quiescence_verified, false);
    assert.equal(receipt.reconciled, true);
    await absent(join(result.directory, "mutation-intent.json"));
    assert.deepEqual(await snapshot(original), before);
    if (failure === "readback-child") {
      await absent(join(original, "result.json"));
      await absent(join(original, "phases.json"));
    }
    for (const mode of ["prepare-dispose", "dispose"]) {
      f.state.mode = mode;
      const next = join(f.root, `${mode}.json`),
        key = mode === "prepare-dispose" ? "ownership" : "disposal";
      await json(next, {
        schema_version: 1,
        source_sha256: await sourceDigest(),
        operation_name: `nourishing-session-${(mode === "prepare-dispose" ? "a" : "b").repeat(12)}`,
        not_after_utc: "2026-10-01T08:18:00Z",
        [`${key}_result`]: retained,
        [`${key}_result_sha256`]: hash(await readFile(retained)),
      });
      result = await runDevelopmentSession(mode, next, { environment: {} }, f.run);
      retained = join(result.directory, "result.json");
    }
    assert.equal(JSON.parse(await readFile(retained)).disposed, true);
    assert.deepEqual(await snapshot(original), before);
  });
}

for (const [label, subset] of [
  ["group only", ["group"]],
  ["unattached disk and IP", ["group", "data", "pip"]],
  ["network before VM", ["group", "vnet", "subnet", "nsg", "association", "pip", "nic"]],
  ["VM before attachment and schedule", ["group", "vnet", "subnet", "pip", "nic", "vm", "data"]],
]) {
  test(`partial reconciliation and separately reviewed disposal: ${label}`, {
    timeout: 120000,
  }, async (t) => {
    const f = await fixture(t, subset);
    f.state.fail = "apply-partial";
    await assert.rejects(f.execute());
    assert.equal(await readFile(join(f.root, "apply-child-started"), "utf8"), "started");
    const original = join(f.root, "nourishing-session-0123456789ab");
    await absent(join(original, "result.json"));
    await absent(join(original, "phases.json"));
    await absent(join(original, "work/errored.tfstate"));
    const before = await snapshot(original);
    const raw = JSON.parse(await readFile(join(original, "work/terraform.tfstate"), "utf8"));
    assert.equal(raw.resources.length, subset.length);
    const intent = JSON.parse(await readFile(join(original, "mutation-intent.json"), "utf8"));
    assert.equal(intent.outcome, "unknown-until-reconciled");
    f.state.fail = undefined;
    f.state.mode = "reconcile-partial";
    const input = join(f.root, "partial-request.json");
    const request = {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${"c".repeat(12)}`,
      not_after_utc: "2026-10-01T08:18:00Z",
      execute_request: f.input,
      execute_directory: original,
      execute_session_sha256: hash(await readFile(join(original, "session.json"))),
      execute_intent_sha256: hash(await readFile(join(original, "mutation-intent.json"))),
    };
    await json(input, request);
    if (label === "group only") {
      for (const [kind, suffix] of [
        ["child", "d"],
        ["abort", "e"],
      ]) {
        const failedInput = join(f.root, `partial-${kind}.json`);
        const operation = `nourishing-session-${suffix.repeat(12)}`;
        await json(failedInput, { ...request, operation_name: operation });
        const stop = new AbortController();
        const start = f.state.calls.length;
        const reject = async (tool, args, options) => {
          if (basename(options.outputPath ?? "") === "before-members.json") {
            if (kind === "child") {
              const python = { path: await realpath("/usr/bin/python3") };
              python.sha256 = hash(await readFile(python.path));
              return runTool(
                python,
                [
                  "-I",
                  "-B",
                  "-c",
                  `from pathlib import Path; Path(${JSON.stringify(join(f.root, "partial-child-started"))}).write_text('started'); raise SystemExit(7)`,
                ],
                { ...options, outputPath: undefined },
              );
            }
            const result = await f.run(tool, args, options);
            stop.abort(new Error("synthetic partial read interruption"));
            return result;
          }
          return f.run(tool, args, options);
        };
        await assert.rejects(
          runDevelopmentSession(
            "reconcile-partial",
            failedInput,
            { environment: {}, signal: stop.signal },
            reject,
          ),
        );
        if (kind === "child")
          assert.equal(await readFile(join(f.root, "partial-child-started"), "utf8"), "started");
        await absent(join(f.root, operation, "result.json"));
        await absent(join(f.root, operation, "mutation-intent.json"));
        assert.ok(
          f.state.calls
            .slice(start)
            .every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])),
        );
        assert.deepEqual(await snapshot(original), before);
      }
    }
    const start = f.state.calls.length;
    let result = await runDevelopmentSession(
      "reconcile-partial",
      input,
      { environment: {} },
      f.run,
    );
    const calls = f.state.calls.slice(start);
    assert.ok(calls.every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])));
    const labels = [
      "group",
      "vnet",
      "subnet",
      "nsg",
      "pip",
      "nic",
      "vm",
      "os",
      "data",
      "schedule",
    ].filter((n) => subset.includes(n) || (n === "os" && subset.includes("vm")));
    labels.push("members");
    if (subset.includes("vm")) labels.push("extensions");
    assert.deepEqual(
      calls.filter((c) => c.output.startsWith("before-")).map((c) => c.output),
      labels.map((n) => `before-${n}.json`),
    );
    let retained = join(result.directory, "result.json");
    let receipt = JSON.parse(await readFile(retained));
    assert.equal(receipt.mode, "reconcile-partial");
    assert.equal(receipt.ownership_scope, "partial");
    assert.equal(receipt.state_addresses.length, subset.length);
    assert.deepEqual(
      receipt.state_addresses,
      raw.resources.map((r) => `${r.type}.${r.name}`).sort(),
    );
    assert.equal(receipt.original_execution_outcome, "unconfirmed");
    assert.equal(receipt.external_quiescence_verified, false);
    await absent(join(result.directory, "mutation-intent.json"));
    assert.deepEqual(await snapshot(original), before);
    for (const mode of ["prepare-dispose", "dispose"]) {
      f.state.mode = mode;
      const next = join(f.root, `${mode}-partial.json`);
      const key = mode === "prepare-dispose" ? "ownership" : "disposal";
      await json(next, {
        schema_version: 1,
        source_sha256: await sourceDigest(),
        operation_name: `nourishing-session-${(mode === "prepare-dispose" ? "a" : "b").repeat(12)}`,
        not_after_utc: "2026-10-01T08:18:00Z",
        [`${key}_result`]: retained,
        [`${key}_result_sha256`]: hash(await readFile(retained)),
      });
      const begin = f.state.calls.length;
      result = await runDevelopmentSession(mode, next, { environment: {} }, f.run);
      retained = join(result.directory, "result.json");
      receipt = JSON.parse(await readFile(retained));
      if (mode === "prepare-dispose") {
        assert.ok(f.state.calls.slice(begin).every((c) => c.argv[0] !== "apply"));
        assert.deepEqual(
          receipt.state_addresses,
          raw.resources.map((r) => `${r.type}.${r.name}`).sort(),
        );
        await absent(join(result.directory, "mutation-intent.json"));
      }
    }
    assert.equal(receipt.disposed, true);
    assert.deepEqual(await snapshot(original), before);
  });
}

for (const [failure, partial] of [
  ["apply-complete", false],
  ["readback-child", false],
  ["publication", false],
  ["apply-complete", true],
]) {
  test(`terminal disposal reconciliation after ${failure}, partial origin ${partial}`, {
    timeout: 120000,
  }, async (t) => {
    const f = await fixture(t, partial ? ["group", "data", "pip"] : undefined);
    let owned;
    if (partial) {
      f.state.fail = "apply-partial";
      await assert.rejects(f.execute());
      f.state.fail = undefined;
      f.state.mode = "reconcile-partial";
      const original = join(f.root, "nourishing-session-0123456789ab");
      const input = join(f.root, "partial-ownership.json");
      await json(input, {
        schema_version: 1,
        source_sha256: await sourceDigest(),
        operation_name: `nourishing-session-${"c".repeat(12)}`,
        not_after_utc: "2026-10-01T08:18:00Z",
        execute_request: f.input,
        execute_directory: original,
        execute_session_sha256: hash(await readFile(join(original, "session.json"))),
        execute_intent_sha256: hash(await readFile(join(original, "mutation-intent.json"))),
      });
      owned = await runDevelopmentSession("reconcile-partial", input, { environment: {} }, f.run);
    } else owned = await f.execute();
    f.state.mode = "prepare-dispose";
    const prepareInput = join(f.root, "prepare-dispose-recovery.json"),
      ownership = join(owned.directory, "result.json");
    await json(prepareInput, {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${"a".repeat(12)}`,
      not_after_utc: "2026-10-01T08:18:00Z",
      ownership_result: ownership,
      ownership_result_sha256: hash(await readFile(ownership)),
    });
    const prepared = await runDevelopmentSession(
      "prepare-dispose",
      prepareInput,
      { environment: {} },
      f.run,
    );
    const disposal = join(prepared.directory, "result.json"),
      input = join(f.root, "uncertain-dispose.json");
    await json(input, {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${"b".repeat(12)}`,
      not_after_utc: "2026-10-01T08:18:00Z",
      disposal_result: disposal,
      disposal_result_sha256: hash(await readFile(disposal)),
    });
    f.state.mode = "dispose";
    f.state.fail = failure;
    const failRead = async (tool, args, options) => {
      if (
        failure === "readback-child" &&
        basename(options.outputPath ?? "") === "after-groups.json"
      ) {
        const python = { path: await realpath("/usr/bin/python3") };
        python.sha256 = hash(await readFile(python.path));
        return runTool(
          python,
          [
            "-I",
            "-B",
            "-c",
            `from pathlib import Path;Path(${JSON.stringify(join(f.root, "disposal-readback-child-started"))}).write_text('started');raise SystemExit(7)`,
          ],
          { ...options, outputPath: undefined },
        );
      }
      return f.run(tool, args, options);
    };
    await assert.rejects(runDevelopmentSession("dispose", input, { environment: {} }, failRead));
    const original = join(f.root, `nourishing-session-${"b".repeat(12)}`);
    assert.deepEqual(
      JSON.parse(await readFile(join(original, "work/terraform.tfstate"))).resources,
      [],
    );
    if (failure === "apply-complete")
      assert.equal(await readFile(join(f.root, "apply-child-started"), "utf8"), "started");
    if (failure === "readback-child")
      assert.equal(
        await readFile(join(f.root, "disposal-readback-child-started"), "utf8"),
        "started",
      );
    if (failure === "publication")
      assert.equal(JSON.parse(await readFile(join(original, "result.json"))).disposed, true);
    else {
      await absent(join(original, "result.json"));
      await absent(join(original, "phases.json"));
    }
    const before = await snapshot(original);
    f.state.fail = undefined;
    f.state.mode = "reconcile-dispose";
    const request = {
      schema_version: 1,
      source_sha256: await sourceDigest(),
      operation_name: `nourishing-session-${"d".repeat(12)}`,
      not_after_utc: "2026-10-01T08:18:00Z",
      dispose_request: input,
      dispose_directory: original,
      dispose_session_sha256: hash(await readFile(join(original, "session.json"))),
      dispose_intent_sha256: hash(await readFile(join(original, "mutation-intent.json"))),
    };
    if (failure === "apply-complete" && !partial) {
      for (const [kind, suffix] of [
        ["child", "e"],
        ["abort", "f"],
        ["publication", "1"],
      ]) {
        const failed = join(f.root, `observation-${kind}.json`),
          directory = join(f.root, `nourishing-session-${suffix.repeat(12)}`);
        await json(failed, { ...request, operation_name: basename(directory) });
        const stop = new AbortController(),
          start = f.state.calls.length;
        f.state.fail = kind === "publication" ? "publication" : undefined;
        const reject = async (tool, args, options) => {
          if (
            basename(options.outputPath ?? "") === "after-groups.json" &&
            kind !== "publication"
          ) {
            if (kind === "abort") {
              stop.abort(new Error("synthetic observation abort"));
              options.signal.throwIfAborted();
            }
            const python = { path: await realpath("/usr/bin/python3") };
            python.sha256 = hash(await readFile(python.path));
            return runTool(
              python,
              [
                "-I",
                "-B",
                "-c",
                `from pathlib import Path;Path(${JSON.stringify(join(f.root, "absence-child-started"))}).write_text('started');raise SystemExit(7)`,
              ],
              { ...options, outputPath: undefined },
            );
          }
          return f.run(tool, args, options);
        };
        await assert.rejects(
          runDevelopmentSession(
            "reconcile-dispose",
            failed,
            { environment: {}, signal: stop.signal },
            reject,
          ),
        );
        if (kind === "child")
          assert.equal(await readFile(join(f.root, "absence-child-started"), "utf8"), "started");
        if (kind === "publication")
          assert.equal(
            JSON.parse(await readFile(join(directory, "result.json"))).disposal_observed,
            true,
          );
        else await absent(join(directory, "result.json"));
        await absent(join(directory, "mutation-intent.json"));
        assert.ok(
          f.state.calls
            .slice(start)
            .every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])),
        );
        assert.deepEqual(await snapshot(original), before);
      }
    }
    f.state.fail = undefined;
    const recoveryInput = join(f.root, "reconcile-dispose.json");
    await json(recoveryInput, request);
    const start = f.state.calls.length;
    const recovered = await runDevelopmentSession(
      "reconcile-dispose",
      recoveryInput,
      { environment: {} },
      f.run,
    );
    const calls = f.state.calls.slice(start);
    assert.deepEqual(
      calls.map((c) => c.output),
      [
        "auth-version.json",
        "auth-extensions.json",
        "auth-account.json",
        "auth-subscription.json",
        "version.json",
        "init.stdout",
        "rendered.json",
        "final-state.json",
        "after-groups.json",
      ],
    );
    assert.ok(calls.every((c) => !["apply", "plan", "refresh", "import"].includes(c.argv[0])));
    assert.ok(
      calls
        .filter((c) => c.argv[0] === "rest")
        .every((c) => c.argv[1] === "--method" && c.argv[2] === "get"),
    );
    const result = JSON.parse(await readFile(join(recovered.directory, "result.json")));
    assert.equal(result.mode, "reconcile-dispose");
    assert.equal(result.disposal_observed, true);
    assert.equal(result.original_disposal_outcome, "unconfirmed");
    assert.equal(result.external_quiescence_verified, false);
    assert.equal(result.remote_operation_completion_verified, false);
    assert.equal("disposed" in result, false);
    await absent(join(recovered.directory, "mutation-intent.json"));
    assert.deepEqual(await snapshot(original), before);
    assert.deepEqual(
      result.input_sha256.disposal_reconciliation.retained_files,
      JSON.parse(await readFile(join(recovered.directory, "session.json"))).snapshot
        .disposal_reconciliation.retained_files,
    );
  });
}

async function shutdownFixture(t) {
  const f = await fixture(t);
  const execution = await f.execute();
  const ownership = join(execution.directory, "result.json");
  const original = await snapshot(execution.directory);
  const instant = "2026-10-01T10:01:00.000Z";
  t.mock.timers.setTime(new Date(instant).getTime());
  f.state.instant = instant;
  f.state.mode = "observe-shutdown";
  f.responses.live.vm.etag = "new response bytes, unchanged generation";
  f.responses.live.vm.properties.instanceView = {
    statuses: [{ code: "PowerState/deallocated" }],
  };
  const request = {
    schema_version: 1,
    source_sha256: await sourceDigest(),
    operation_name: "nourishing-session-" + "d".repeat(12),
    not_after_utc: "2026-10-01T10:19:00Z",
    ownership_result: ownership,
    ownership_result_sha256: hash(await readFile(ownership)),
  };
  return { ...f, execution, ownership, original, request };
}

test("shutdown observation uses one identity-bound expanded VM GET without mutation", {
  timeout: 120000,
}, async (t) => {
  const f = await shutdownFixture(t);
  const input = join(f.root, "observe.json");
  await json(input, f.request);
  const start = f.state.calls.length;
  const observed = await runDevelopmentSession(
    "observe-shutdown",
    input,
    { environment: {} },
    f.run,
  );
  const calls = f.state.calls.slice(start);
  const vm = calls.filter((c) => c.output === "before-vm.json");
  assert.equal(vm.length, 1);
  assert.deepEqual(vm[0].argv, [
    "rest",
    "--method",
    "get",
    "--url",
    "https://management.azure.com" +
      f.responses.live.vm.id +
      "?api-version=2026-03-01&$expand=instanceView",
    "--subscription",
    f.expected.subscriptionId,
    "--only-show-errors",
    "--output",
    "json",
  ]);
  assert.ok(
    calls.every(
      (c) => !["apply", "plan", "refresh", "import", "deallocate", "stop"].includes(c.argv[0]),
    ),
  );
  assert.ok(calls.filter((c) => c.argv[0] === "rest").every((c) => c.argv[2] === "get"));
  const result = JSON.parse(await readFile(join(observed.directory, "result.json")));
  assert.equal(result.deallocation_observed, true);
  assert.equal(result.power_state, "PowerState/deallocated");
  assert.equal(result.ownership_result_sha256, hash(await readFile(f.ownership)));
  assert.equal(
    result.vm_response_sha256,
    hash(await readFile(join(observed.directory, "before-vm.json"))),
  );
  const phases = JSON.parse(await readFile(join(observed.directory, "phases.json")));
  assert.deepEqual(phases.find((p) => p.phase === "before-vm").arguments, vm[0].argv);
  assert.equal(result.schedule_causation_verified, false);
  assert.equal(result.transition_time_verified, false);
  assert.equal(result.permanent_shutdown_verified, false);
  assert.equal(result.remote_operation_completion_verified, false);
  assert.equal(result.zero_remaining_cost_verified, false);
  await absent(join(observed.directory, "mutation-intent.json"));
  assert.deepEqual(await snapshot(f.execution.directory), f.original);
});

test("shutdown observation child failure, interruption and publication uncertainty retain custody", {
  timeout: 180000,
}, async (t) => {
  const f = await shutdownFixture(t);
  for (const [kind, suffix] of [
    ["child", "e"],
    ["abort", "f"],
    ["publication", "1"],
  ]) {
    const request = { ...f.request, operation_name: "nourishing-session-" + suffix.repeat(12) };
    const input = join(f.root, "observe-" + kind + ".json");
    await json(input, request);
    const directory = join(f.root, request.operation_name);
    const controller = new AbortController();
    const start = f.state.calls.length;
    f.state.fail = kind === "publication" ? "publication" : undefined;
    const injected = async (tool, argv, options) => {
      if (basename(options.outputPath ?? "") === "before-vm.json" && kind !== "publication") {
        if (kind === "abort") {
          controller.abort(new Error("synthetic shutdown observation interrupted"));
          options.signal.throwIfAborted();
        }
        const python = { path: await realpath("/usr/bin/python3") };
        python.sha256 = hash(await readFile(python.path));
        return runTool(
          python,
          [
            "-I",
            "-B",
            "-c",
            "from pathlib import Path;Path(" +
              JSON.stringify(join(f.root, "shutdown-child-started")) +
              ").write_text('started');raise SystemExit(7)",
          ],
          { ...options, outputPath: undefined },
        );
      }
      return f.run(tool, argv, options);
    };
    await assert.rejects(
      runDevelopmentSession(
        "observe-shutdown",
        input,
        { environment: {}, signal: controller.signal },
        injected,
      ),
    );
    if (kind === "child")
      assert.equal(await readFile(join(f.root, "shutdown-child-started"), "utf8"), "started");
    if (kind === "publication")
      assert.equal(
        JSON.parse(await readFile(join(directory, "result.json"))).deallocation_observed,
        true,
      );
    else await absent(join(directory, "result.json"));
    await absent(join(directory, "mutation-intent.json"));
    assert.ok(
      f.state.calls
        .slice(start)
        .every(
          (c) => !["apply", "plan", "refresh", "import", "deallocate", "stop"].includes(c.argv[0]),
        ),
    );
    assert.deepEqual(await snapshot(f.execution.directory), f.original);
  }
});

test("shutdown observation rejects an allocated stopped VM without publishing success", {
  timeout: 120000,
}, async (t) => {
  const f = await shutdownFixture(t);
  f.responses.live.vm.properties.instanceView.statuses = [
    { code: "PowerState/stopped", displayStatus: "VM deallocated" },
  ];
  const input = join(f.root, "observe-stopped.json");
  await json(input, f.request);
  const start = f.state.calls.length;
  await assert.rejects(
    runDevelopmentSession("observe-shutdown", input, { environment: {} }, f.run),
  );
  await absent(join(f.root, f.request.operation_name, "result.json"));
  assert.ok(
    f.state.calls
      .slice(start)
      .every(
        (c) => !["apply", "plan", "refresh", "import", "deallocate", "stop"].includes(c.argv[0]),
      ),
  );
  assert.deepEqual(await snapshot(f.execution.directory), f.original);
});
