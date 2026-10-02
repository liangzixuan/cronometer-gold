import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function fixture(t) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const python = { path: await realpath("/usr/bin/python3") };
  python.sha256 = hash(await readFile(python.path));
  // Actual pure policy and private fixture constructors; no cloud/tool process is substituted here.
  const setup = `import importlib.util,json\ns=importlib.util.spec_from_file_location('fixtures',${JSON.stringify(contract)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nf=m.SessionPolicy('runTest');f.setUp();f.temporary._finalizer.detach()\npins={'terraform':m.S.A.TF_SHA256,'provider':m.S.A.PROVIDER_FILES};m.Q.write_json(f.root/'fixture-pins.json',pins)\nprint(json.dumps({'root':str(f.root),'input':str(f.input),'terraform':str(f.tf),'profile':str(f.profile),'source':m.S.source_digest(),'responses':f.responses,'rendered':f.rendered_raw.decode(),'native':m.native_fixture(),'oldProfile':m.PROFILE,'expected':f.expected}))`;
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
      const program = `import importlib.util,json\nfrom pathlib import Path\nfrom datetime import datetime\ns=importlib.util.spec_from_file_location('policy',${JSON.stringify(helper)});q=importlib.util.module_from_spec(s);s.loader.exec_module(q)\np=json.loads(Path(${JSON.stringify(join(f.root, "fixture-pins.json"))}).read_text());q.A.TF_SHA256=p['terraform'];q.A.PROVIDER_FILES={k:tuple(v) for k,v in p['provider'].items()};q.P.tool_digest=lambda path:(q.P.CLI_SHA256,100);q.datetime=type('FixtureClock',(),{'now':staticmethod(lambda tz:datetime.fromisoformat('2026-10-01T08:00:00+00:00'))});raise SystemExit(q.main(${JSON.stringify(args)}))`;
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
            state.mode === "dispose" && phase === "final-state.json"
              ? { format_version: "1.0", terraform_version: "1.5.7" }
              : f.responses.state;
        else {
          assert.match(argv[2], /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
          assert.equal(
            await readFile(argv[2], "utf8"),
            state.mode === "execute"
              ? "private synthetic binary plan"
              : "synthetic destruction plan",
          );
          if (state.mode === "execute") text = f.rendered;
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
