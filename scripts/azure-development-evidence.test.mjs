import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectDevelopmentEvidence, sourceDigest } from "./azure-development-evidence.mjs";
import { PYTHON } from "./azure-development-plan.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
async function fixture(t) {
  const directory = await mkdtemp(join(homedir(), "nourishing-evidence-sequence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("unsafe input, ambient override and expired horizon fail before execution", async (t) => {
  const directory = await fixture(t),
    input = join(directory, "request.json");
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error("not permitted");
  };
  await writeFile(
    input,
    JSON.stringify({ source_sha256: await sourceDigest(), not_after_utc: "2000-01-01T00:00:00Z" }),
    { mode: 0o600 },
  );
  await assert.rejects(collectDevelopmentEvidence(input, { environment: {} }, fail));
  await assert.rejects(
    collectDevelopmentEvidence(
      input,
      { environment: { AZURE_CONFIG_DIR: "PRIVATE_CANARY" } },
      fail,
    ),
  );
  await chmod(input, 0o644);
  await assert.rejects(collectDevelopmentEvidence(input, { environment: {} }, fail));
  assert.equal(calls, 0);
});

test("actual pure stages plus synthetic native reads preserve sequencing, diagnostics and complete-index semantics", {
  timeout: 110_000,
}, async (t) => {
  // A fixed clock makes same-day shutdown policy deterministic. No Azure process is started.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T08:00:00Z") });
  const directory = await fixture(t),
    input = join(directory, "request.json");
  const source = await sourceDigest();
  const testModule = fileURLToPath(
    new URL("../infra/development/azure/test-contract.py", import.meta.url),
  );
  const program = `import importlib.util,json,configparser\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('fixture',${JSON.stringify(testModule)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=Path(${JSON.stringify(directory)});p=r/'profile';p.mkdir(mode=0o700);c=configparser.ConfigParser();c.read_dict(m.P.SETTINGS)\nwith (p/'config').open('w') as out:c.write(out)\n(p/'config').chmod(0o600);(p/'clouds.config').write_text('[AzureCloud]\\nsubscription = '+m.SUB+'\\n');(p/'clouds.config').chmod(0o600)\nidentity={'subscriptionId':m.SUB,'tenantId':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};m.E.write_json(r/'identity.json',identity)\nrequest={'schema_version':1,'source_sha256':${JSON.stringify(source)},'identity_file':str(r/'identity.json'),'profile_directory':str(p),'operation_name':'nourishing-evidence-0123456789ab','not_after_utc':'2026-10-01T08:12:00Z','shutdown_deadline_utc':'2026-10-01T10:00:00Z'};m.E.write_json(r/'request.json',request)\nvalues={'auth-version':{'azure-cli':'2.90.0','azure-cli-core':'2.90.0','azure-cli-telemetry':'1','extensions':{}},'auth-extensions':[],'auth-account':{'id':m.SUB,'tenantId':identity['tenantId'],'state':'Enabled','environmentName':'AzureCloud'},'auth-subscription':dict(identity,state='Enabled',subscriptionPolicies={'quotaId':'AzureForStudents_2018-01-01','spendingLimit':'On'})}\nold=m.evidence()\nfor kind,label,*_ in m.A.NATIVE_READS:values['read-'+label]=m.selected(old,kind,label)\nm.E.write_json(r/'synthetic.json',values)\nprint('{}')`;
  await runTool(PYTHON, ["-I", "-B", "-c", program], {
    signal: AbortSignal.timeout(10000),
    env,
    directory,
    limit: 1024,
  });
  const values = JSON.parse(await readFile(join(directory, "synthetic.json"), "utf8"));
  const operation = join(directory, "nourishing-evidence-0123456789ab");
  const expectedLabels = [
    "auth-version",
    "auth-extensions",
    "auth-account",
    "auth-subscription",
    "read-after-subscription-policy",
    "read-after-billing-property",
    "read-credit-balance-summary",
    "read-credit-lots",
    "read-after-compute-registration-once",
    "read-after-Microsoft.Network-once",
    "read-after-Microsoft.DevTestLab-once",
    "read-centralus-positive-and-arm-family-quotas",
    "read-centralus-Standard_B4ps_v2-exact",
    "read-selected-exact-CentralUS-Canonical-Arm64-image",
  ];
  const state = { calls: [], failure: undefined };
  const run = async (tool, args, options) => {
    if (tool.path === PYTHON.path) {
      const stage = args[3];
      const patch = `import importlib.util\nfrom datetime import datetime,timezone\ns=importlib.util.spec_from_file_location('pure',${JSON.stringify(args[2])});q=importlib.util.module_from_spec(s);s.loader.exec_module(q)\nq.P.tool_digest=lambda path:(q.P.CLI_SHA256,100)\nq.datetime=type('FixtureClock',(),{'now':staticmethod(lambda tz:datetime(2026,10,1,8,tzinfo=timezone.utc))})\nraise SystemExit(q.main(${JSON.stringify(args.slice(3))}))`;
      const result = await runTool(PYTHON, ["-I", "-B", "-c", patch], options);
      if (stage === "finish" && state.failure === "after-publication")
        throw new Error("synthetic caller rejection after publication");
      return result;
    }
    assert.equal(tool.path, "/usr/bin/az");
    const label = options.outputPath.slice(operation.length + 1, -5);
    state.calls.push(label);
    assert.equal(label, expectedLabels[state.calls.length - 1]);
    assert.equal(args.includes("-IBm"), false);
    assert.deepEqual(args.slice(-3), ["--only-show-errors", "--output", "json"]);
    assert.equal(args.includes("register"), false);
    assert.equal(options.limit, 131072);
    assert.deepEqual(Object.keys(options.env).sort(), [
      "AZURE_CONFIG_DIR",
      "AZURE_CORE_COLLECT_TELEMETRY",
      "AZURE_EXTENSION_USE_DYNAMIC_INSTALL",
      "AZURE_LOGGING_ENABLE_LOG_FILE",
      "HOME",
      "LANG",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
      "TMPDIR",
    ]);
    assert.ok(!JSON.stringify(options.env).includes("PRIVATE_CANARY"));
    assert.equal(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
    const value =
      state.failure === "authentication" && label === "auth-account" ? {} : values[label];
    const text = `${JSON.stringify(value)}\n`;
    if (state.failure === "read-nonzero" && label === "read-credit-balance-summary") {
      return runTool(
        PYTHON,
        ["-I", "-B", "-c", "import sys;sys.stderr.write('PRIVATE_CANARY');sys.exit(2)"],
        options,
      );
    }
    if (state.failure === "read-overflow" && label === "read-credit-balance-summary") {
      return runTool(PYTHON, ["-I", "-B", "-c", "print('x'*131073)"], options);
    }
    // Actual owned synthetic child creates stdout and stderr; observed metadata is not fabricated.
    return runTool(
      PYTHON,
      [
        "-I",
        "-B",
        "-c",
        `import sys;sys.stdout.write(${JSON.stringify(text)});sys.stderr.write('PRIVATE_CANARY')`,
      ],
      options,
    );
  };
  for (const failure of [
    "authentication",
    "read-nonzero",
    "read-overflow",
    "after-publication",
    undefined,
  ]) {
    state.failure = failure;
    state.calls = [];
    try {
      if (failure) {
        await assert.rejects(
          collectDevelopmentEvidence(
            input,
            { environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
            run,
          ),
        );
        if (failure === "authentication") assert.equal(state.calls.length, 4);
        else if (failure.startsWith("read-"))
          assert.equal(state.calls.at(-1), "read-credit-balance-summary");
        else assert.equal(state.calls.length, 14);
        if (failure === "after-publication")
          assert.equal(
            JSON.parse(await readFile(join(operation, "index.json"), "utf8")).completed,
            true,
          );
        else await assert.rejects(lstat(join(operation, "index.json")), { code: "ENOENT" });
      } else {
        const result = await collectDevelopmentEvidence(
          input,
          { environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
          run,
        );
        const indexRaw = await readFile(join(operation, "index.json")),
          index = JSON.parse(indexRaw);
        assert.equal(result.indexSha256, hash(indexRaw));
        assert.equal(index.completed, true);
        assert.equal(index.source_sha256, source);
        assert.equal(Object.keys(index.evidence_sha256).length, 6);
        assert.equal(state.calls.length, 14);
        assert.ok(!indexRaw.includes("PRIVATE_CANARY"));
        const family = JSON.parse(await readFile(join(operation, "credit.json"), "utf8"));
        assert.equal(family.commands[0].stderrBytes, 14);
        assert.equal(family.commands[0].stderrSha256, hash("PRIVATE_CANARY"));
        assert.ok(!JSON.stringify(family).includes("PRIVATE_CANARY"));
      }
    } finally {
      await rm(operation, { recursive: true, force: true });
    }
  }
});
