import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDevelopmentPlan,
  limitedTool,
  openPlan,
  rejectAmbient,
  sourceDigest,
} from "./azure-development-plan.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
async function fixture(t) {
  const directory = await mkdtemp(join(homedir(), "nourishing-plan-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function copyNodeTool(directory) {
  const originalPath = await realpath(process.execPath);
  const path = join(directory, "node");
  await copyFile(originalPath, path, constants.COPYFILE_EXCL);
  await chmod(path, 0o700);
  const sha256 = hash(await readFile(originalPath));
  assert.equal(hash(await readFile(path)), sha256, "fixture executable matches current Node");
  return { path, sha256 };
}
const pause = () => new Promise((done) => setTimeout(done, 20));
async function identity(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      group: Number(fields[2]),
      session: Number(fields[3]),
      start: fields[19],
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}
const running = (value) => value && !["X", "Z"].includes(value.state);
async function ready(path, timeout = 4000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await pause();
  }
  throw new Error("synthetic child did not establish readiness");
}
const execute = (node, directory, body, options = {}) =>
  limitedTool(node, ["-e", body], {
    signal: AbortSignal.timeout(7000),
    env,
    directory,
    limit: 4096,
    ...options,
  });

test("rejects ambient Terraform, credential, proxy and code-loading overrides", () => {
  for (const name of [
    "TF_CLI_ARGS",
    "ARM_CLIENT_SECRET",
    "AZURE_CONFIG_DIR",
    "HTTPS_PROXY",
    "no_proxy",
    "PYTHONPATH",
    "NODE_OPTIONS",
    "LD_PRELOAD",
  ])
    assert.throws(() => rejectAmbient({ [name]: "PRIVATE_CANARY" }));
  assert.doesNotThrow(() =>
    rejectAmbient({ PATH: "/untrusted", HOME: "/untrusted", OTHER_SECRET: "PRIVATE_CANARY" }),
  );
});
test("source digest binds the pure helper and no execution is needed to calculate it", async () => {
  assert.match(await sourceDigest(), /^[a-f0-9]{64}$/u);
});
test("rejects unsafe request before any command", async (t) => {
  const directory = await fixture(t);
  const path = join(directory, "request.json");
  await writeFile(path, JSON.stringify({ source_sha256: "0".repeat(64) }), { mode: 0o600 });
  await assert.rejects(createDevelopmentPlan(path, { environment: {} }));
  await chmod(path, 0o644);
  await assert.rejects(createDevelopmentPlan(path, { environment: {} }));
});
test("actual limiter applies inherited file limit and a narrow child environment", {
  timeout: 10000,
}, async (t) => {
  const directory = await fixture(t);
  const node = await copyNodeTool(directory);
  const result = await execute(
    node,
    directory,
    "const fs=require('node:fs');console.log(JSON.stringify({limits:fs.readFileSync('/proc/self/limits','utf8'),env:process.env}));",
  );
  const value = JSON.parse(result.text);
  assert.match(value.limits, /Max file size\s+536870912\s+536870912\s+bytes/u);
  assert.deepEqual(value.env, env);
  assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.equal(result.sha256, hash(result.text));
});
test("actual per-file growth cannot exceed the inherited fsize bound", {
  timeout: 10000,
}, async (t) => {
  const directory = await fixture(t);
  const node = await copyNodeTool(directory);
  const path = join(directory, "growth");
  await assert.rejects(
    execute(
      node,
      directory,
      `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(path)},'wx',0o600);fs.writeSync(fd,Buffer.from('x'),0,1,536870912);`,
    ),
  );
  assert.ok((await stat(path)).size <= 536870912);
});
for (const [name, body] of [
  ["nonzero", "process.exit(2)"],
  ["stdout overflow", "process.stdout.write('x'.repeat(4097))"],
  ["stderr overflow", "process.stderr.write('x'.repeat(65537))"],
]) {
  test(`actual ${name} rejects without publishing a result`, { timeout: 10000 }, async (t) => {
    const directory = await fixture(t);
    const node = await copyNodeTool(directory);
    const started = join(directory, "child-started");
    const childBody = `require('node:fs').writeFileSync(${JSON.stringify(started)},${JSON.stringify(name)},{flag:'wx',mode:0o600});${body}`;
    await assert.rejects(execute(node, directory, childBody));
    assert.equal(await readFile(started, "utf8"), name);
    await assert.rejects(lstat(join(directory, "result.json")), { code: "ENOENT" });
  });
}
test("actual deadline rejects and settles a TERM-resistant tool", { timeout: 10000 }, async (t) => {
  const directory = await fixture(t);
  const node = await copyNodeTool(directory);
  const path = join(directory, "timeout-ready.json");
  await assert.rejects(
    execute(
      node,
      directory,
      `require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
      { signal: AbortSignal.timeout(500) },
    ),
  );
  const state = await ready(path);
  assert.equal(Boolean(running(await identity(state.pid))), false);
});
for (const mode of ["normal", "abort"]) {
  test(`real TERM-resistant descendant settles after leader ${mode}`, {
    timeout: 12000,
  }, async (t) => {
    const directory = await fixture(t);
    const node = await copyNodeTool(directory);
    const path = join(directory, "ready.json");
    const controller = new AbortController();
    const grandchild =
      "process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000)";
    const body = `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',pid=>{fs.writeFileSync(${JSON.stringify(path)},JSON.stringify({pid,leader:process.pid}));${mode === "normal" ? "process.exit(0);" : ""}});setInterval(()=>{},1000);`;
    let result, state, before, work;
    const watchdog = setTimeout(() => controller.abort(), 6000);
    try {
      work = execute(node, directory, body, { signal: controller.signal }).then(
        (v) => {
          result = { value: v };
        },
        (e) => {
          result = { error: e };
        },
      );
      state = await ready(path);
      before = await identity(state.pid);
      if (mode === "abort") {
        assert.ok(running(before));
        controller.abort();
      }
      await work;
      assert.equal(Boolean(result.error), mode === "abort");
      assert.equal(Boolean(running(await identity(state.pid))), false);
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      await work;
      if (state) {
        const current = await identity(state.pid);
        if (
          running(current) &&
          before &&
          current.start === before.start &&
          current.group === before.group &&
          current.session === before.session
        )
          process.kill(current.pid, "SIGKILL");
      }
    }
  });
}
test("parent loss closes supervisor IPC and settles its actual descendant group", {
  timeout: 14000,
}, async (t) => {
  const directory = await fixture(t);
  const node = await copyNodeTool(directory);
  const path = join(directory, "ready.json");
  const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(path)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const driver = join(directory, "driver.mjs");
  await writeFile(
    driver,
    `import{limitedTool}from ${JSON.stringify(new URL("./azure-development-plan.mjs", import.meta.url).href)};await limitedTool(${JSON.stringify(node)},['-e',${JSON.stringify(childCode)}],{signal:AbortSignal.timeout(9000),env:${JSON.stringify(env)},directory:${JSON.stringify(directory)},limit:1000});`,
  );
  const child = spawn(node.path, [driver], { env, stdio: "ignore", detached: true });
  const closed = new Promise((done) => child.once("close", done));
  let state, before, group;
  try {
    state = await ready(path);
    before = await identity(state.pid);
    group = await identity(before.group);
    assert.ok(running(before));
    assert.notEqual(before.group, child.pid);
    child.kill("SIGKILL");
    await closed;
    const end = performance.now() + 5000;
    while (running(await identity(state.pid)) && performance.now() < end) await pause();
    assert.equal(Boolean(running(await identity(state.pid))), false);
    assert.equal(Boolean(running(await identity(before.group))), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    if (before) {
      const current = await identity(before.group);
      if (running(current) && current.start === group?.start)
        process.kill(-before.group, "SIGKILL");
    }
  }
});
test("actual renderer opens retained plan descriptor and replacement cannot validate", {
  timeout: 10000,
}, async (t) => {
  const directory = await fixture(t);
  const node = await copyNodeTool(directory);
  const path = join(directory, "plan.tfplan");
  await writeFile(path, "original plan", { mode: 0o600 });
  const plan = await openPlan(path);
  try {
    const result = await execute(
      node,
      directory,
      `console.log(require('node:fs').readFileSync(${JSON.stringify(plan.path)},'utf8'))`,
    );
    assert.equal(result.text, "original plan\n");
    await plan.verify();
    await rename(path, join(directory, "old.tfplan"));
    await writeFile(path, "replacement", { mode: 0o600 });
    await assert.rejects(plan.verify());
  } finally {
    await plan.close();
  }
});
test("mutated wrapped executable is rejected before limiter spawn", async (t) => {
  const directory = await fixture(t);
  const path = join(directory, "tool");
  await writeFile(path, "#!/bin/false\n", { mode: 0o700 });
  await assert.rejects(
    limitedTool({ path, sha256: "0".repeat(64) }, [], {
      signal: AbortSignal.timeout(1000),
      env,
      directory,
      limit: 10,
    }),
  );
});

test("complete operator with actual pure stages and intercepted Azure/Terraform execution", {
  timeout: 90000,
}, async (t) => {
  const directory = await fixture(t);
  const source = await sourceDigest();
  const helper = fileURLToPath(
    new URL("../infra/development/azure/test-contract.py", import.meta.url),
  );
  const python = { path: await realpath("/usr/bin/python3") };
  python.sha256 = hash(await readFile(python.path));
  const program = `import importlib.util,json,os,configparser\nfrom pathlib import Path\nfrom datetime import datetime,timezone,timedelta\ns=importlib.util.spec_from_file_location('fixture',${JSON.stringify(helper)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=Path(${JSON.stringify(directory)});tf=r/'terraform';tf.write_text('#!/bin/false\\n');tf.chmod(0o755);provider=r/'provider';provider.mkdir(mode=0o700);pins={}\nfor name,mode in [('terraform-provider-azurerm_v4.79.0_x5',0o755),('LICENSE.txt',0o644)]:\n p=provider/name;p.write_text('synthetic '+name);p.chmod(mode);pins[name]=[m.A.sha(p.read_bytes()),mode]\nm.Q.write_json(r/'fixture-pins.json',{'terraform':m.A.sha(tf.read_bytes()),'provider':pins,'now':datetime.now(timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0).isoformat()})\nnow=datetime.now(timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0);deadline=(now+timedelta(hours=2)).replace(second=0);assert deadline.date()==now.date()\ndocs=m.evidence();old=m.NOW\ndef times(v):\n if isinstance(v,dict): return {k:times(x) for k,x in v.items()}\n if isinstance(v,list): return [times(x) for x in v]\n if isinstance(v,str) and (v.startswith('2026-10-01T07:') or v.startswith('2026-10-01T08:')): return (datetime.fromisoformat(v.replace('Z','+00:00'))+(now-old)).isoformat().replace('+00:00','Z')\n return v\npaths={};hashes={}\nfor k,v in times(docs).items():\n p=r/(k+'.json');m.Q.write_json(p,v);paths[k]=str(p);hashes[k]=m.A.sha(p.read_bytes())\nprofile=r/'profile';profile.mkdir(mode=0o700);config=configparser.ConfigParser();config.read_dict(m.P.SETTINGS)\nwith (profile/'config').open('w') as f:config.write(f)\n(profile/'config').chmod(0o600);(profile/'clouds.config').write_text('[AzureCloud]\\nsubscription = '+m.SUB+'\\n');(profile/'clouds.config').chmod(0o600)\nexpected={'subscriptionId':m.SUB,'tenantId':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};m.Q.write_json(r/'identity.json',expected)\nrequest={'schema_version':1,'source_sha256':${JSON.stringify(source)},'identity_file':str(r/'identity.json'),'profile_directory':str(profile),'terraform':str(tf),'provider_directory':str(provider),'operation_name':m.PREFIX,'admin_ipv4_cidr':'8.8.8.8/32','ssh_public_key':m.B.SSH_KEY,'shutdown_deadline_utc':deadline.isoformat().replace('+00:00','Z'),'not_after_utc':(datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat().replace('+00:00','Z'),'evidence_paths':paths};m.Q.write_json(r/'request.json',request)\nprint('{}')`;
  const fixtureScript = join(directory, "fixture.py");
  await writeFile(
    fixtureScript,
    `try:\n${program
      .split("\n")
      .map((line) => ` ${line}`)
      .join(
        "\n",
      )}\nexcept Exception:\n import traceback,sys;traceback.print_exc(file=sys.stdout);raise\n`,
  );
  const fixtureLog = join(directory, "fixture.log");
  try {
    await runTool(python, ["-I", "-B", fixtureScript], {
      signal: AbortSignal.timeout(15000),
      env,
      directory,
      limit: 65536,
      outputPath: fixtureLog,
    });
  } catch (error) {
    throw new Error(await readFile(fixtureLog, "utf8"), { cause: error });
  }
  const state = { calls: [], failure: undefined };
  const run = async (tool, argv, options) => {
    const file = tool.path;
    if (file === "/usr/bin/python3.12") {
      const helperPath = argv[2];
      const helperArgs = argv.slice(3);
      const patchProgram = `import importlib.util,json\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('pure',${JSON.stringify(helperPath)});q=importlib.util.module_from_spec(s);s.loader.exec_module(q)\np=json.loads(Path(${JSON.stringify(join(directory, "fixture-pins.json"))}).read_text());q.A.TF_SHA256=p['terraform'];q.A.PROVIDER_FILES={k:tuple(v) for k,v in p['provider'].items()};q.P.tool_digest=lambda path:(q.P.CLI_SHA256,100);q.datetime=type('FixtureClock',(),{'now':staticmethod(lambda tz:__import__('datetime').datetime.fromisoformat(p['now']))});raise SystemExit(q.main(${JSON.stringify(helperArgs)}))`;
      if (state.failure === "cleanup" && helperArgs[0] === "finish") {
        const rejected = patchProgram.replace(
          "raise SystemExit(q.main",
          "q.shutil.rmtree=lambda path:(_ for _ in ()).throw(OSError('synthetic cleanup rejection'));raise SystemExit(q.main",
        );
        return runTool(python, ["-I", "-B", "-c", rejected], options);
      }
      const result = await runTool(python, ["-I", "-B", "-c", patchProgram], options);
      if (state.failure === "after-publication" && helperArgs[0] === "finish")
        throw new Error("synthetic post-publication boundary rejection");
      return result;
    }
    state.calls.push({ file, argv, env: options.env });
    if (state.failure === argv[0])
      throw new Error("synthetic command failure between owned phases");
    assert.ok(!JSON.stringify(options.env).includes("PRIVATE_CANARY"));
    assert.equal(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
    let value;
    if (file === "/usr/bin/az") {
      const expected = {
        subscriptionId: "11111111-2222-3333-4444-555555555555",
        tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      };
      value =
        argv[0] === "version"
          ? {
              "azure-cli": "2.90.0",
              "azure-cli-core": "2.90.0",
              "azure-cli-telemetry": "1",
              extensions: {},
            }
          : argv[0] === "extension"
            ? []
            : argv[0] === "account"
              ? {
                  id: expected.subscriptionId,
                  tenantId: expected.tenantId,
                  state: "Enabled",
                  environmentName: "AzureCloud",
                }
              : {
                  ...expected,
                  state: "Enabled",
                  subscriptionPolicies: {
                    quotaId: "AzureForStudents_2018-01-01",
                    spendingLimit: "On",
                  },
                };
    } else {
      assert.equal(file, join(directory, "terraform"));
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
        let current = parent;
        while (current !== options.env.TF_DATA_DIR) {
          await chmod(current, 0o700);
          current = current.slice(0, current.lastIndexOf("/"));
        }
        await symlink(
          join(
            directory,
            "nourishing-dev-0123456789ab/terraform/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64",
          ),
          join(parent, "linux_amd64"),
        );
      }
      if (argv[0] === "plan") {
        assert.ok(!argv.includes("-detailed-exitcode"));
        assert.ok(argv.includes("-parallelism=1"));
        await writeFile(argv.find((a) => a.startsWith("-out=")).slice(5), "synthetic binary plan", {
          mode: 0o600,
          flag: "wx",
        });
      }
      if (argv[0] === "show") {
        assert.match(argv[2], /^\/proc\/[0-9]+\/fd\/[0-9]+$/u);
        assert.equal(await readFile(argv[2], "utf8"), "synthetic binary plan");
        const fixtureProgram = `import importlib.util,json\nfrom pathlib import Path\nfrom datetime import datetime,timezone\ns=importlib.util.spec_from_file_location('fixture',${JSON.stringify(helper)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nd=m.plan();d['timestamp']=datetime.now(timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0).isoformat().replace('+00:00','Z');v=json.loads(Path(${JSON.stringify(join(directory, "nourishing-dev-0123456789ab/work/inputs.tfvars.json"))}).read_text());d['variables']={k:{'value':x} for k,x in v.items()};d['resource_changes']=[dict(x,change=dict(x['change'],after=m.A.expected_values(v)[x['address']])) for x in d['resource_changes']];print(json.dumps(d))`;
        const rendered = await runTool(python, ["-I", "-B", "-c", fixtureProgram], {
          signal: AbortSignal.timeout(10000),
          env,
          directory,
          limit: 65536,
        });
        value = JSON.parse(rendered.text);
      }
    }
    const text = value === undefined ? "synthetic complete\n" : `${JSON.stringify(value)}\n`;
    if (options.outputPath) await writeFile(options.outputPath, text, { flag: "wx", mode: 0o600 });
    return {
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
      text: options.outputPath ? undefined : text,
    };
  };
  // The normal default boundary cannot run fixture pins; it must reject before any Azure call.
  await assert.rejects(createDevelopmentPlan(join(directory, "request.json"), { environment: {} }));
  for (const failure of [
    "account",
    "init",
    "plan",
    "show",
    "cleanup",
    "after-publication",
    undefined,
  ]) {
    state.failure = failure;
    state.calls = [];
    const operation = join(directory, "nourishing-dev-0123456789ab");
    try {
      if (failure) {
        await assert.rejects(
          createDevelopmentPlan(
            join(directory, "request.json"),
            { environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
            run,
          ),
        );
        if (["cleanup", "after-publication"].includes(failure))
          assert.equal(state.calls.length, 8, "failure must reach the selected final stage");
        else
          assert.equal(
            state.calls.at(-1)?.argv[0],
            failure,
            "failure must reach the selected command",
          );
        if (failure === "after-publication")
          assert.equal(
            JSON.parse(await readFile(join(operation, "result.json"), "utf8")).completed,
            true,
          );
        else await assert.rejects(lstat(join(operation, "result.json")), { code: "ENOENT" });
        if (failure === "cleanup")
          assert.equal(
            await readFile(join(operation, "plan.tfplan"), "utf8"),
            "synthetic binary plan",
          );
      } else {
        const result = await createDevelopmentPlan(
          join(directory, "request.json"),
          { environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
          run,
        );
        const receipt = JSON.parse(await readFile(join(result.directory, "result.json"), "utf8"));
        assert.equal(receipt.completed, true);
        assert.equal(receipt.resource_count, 11);
        assert.equal(receipt.source_sha256, source);
        assert.equal(receipt.phases.length, 10);
        assert.equal(state.calls.length, 8);
        assert.equal(
          await readFile(join(result.directory, "plan.tfplan"), "utf8"),
          "synthetic binary plan",
        );
        assert.ok(!JSON.stringify(receipt).includes("PRIVATE_CANARY"));
      }
    } finally {
      await rm(operation, { recursive: true, force: true });
    }
  }
});
