import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectDevelopmentBaseline,
  sourceDigest,
  verifyDevelopmentBaseline,
} from "./azure-development-baseline.mjs";
import { PYTHON } from "./azure-development-plan.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const environment = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const fixtureModule = fileURLToPath(
  new URL("../infra/development/azure/test-baseline.py", import.meta.url),
);
const fixedNow = "2026-10-18T08:00:00Z";
const root = () => mkdtemp(join(homedir(), "nourishing-baseline-sequence-"));

test("baseline entry binds source and rejects expired, public or overridden input before execution", async () => {
  assert.match(await sourceDigest(), /^[a-f0-9]{64}$/u);
  const directory = await root(),
    input = join(directory, "request.json");
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error("forbidden");
  };
  await writeFile(
    input,
    JSON.stringify({ source_sha256: await sourceDigest(), not_after_utc: "2000-01-01T00:00:00Z" }),
    { mode: 0o600 },
  );
  await assert.rejects(collectDevelopmentBaseline(input, { environment }, fail));
  await assert.rejects(
    collectDevelopmentBaseline(
      input,
      { environment: { AZURE_CONFIG_DIR: "PRIVATE_CANARY" } },
      fail,
    ),
  );
  await chmod(input, 0o644);
  await assert.rejects(collectDevelopmentBaseline(input, { environment }, fail));
  assert.equal(calls, 0);
});

test("baseline complete caller retains original proof and consumer rejects changed evidence", {
  timeout: 180_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(fixedNow) });
  for (const failure of [
    "authentication",
    "query-nonzero",
    "query-overflow",
    "pagination",
    "no-content",
    "after-publication",
    undefined,
  ]) {
    const directory = await root(),
      input = join(directory, "request.json"),
      source = await sourceDigest();
    const program = `import importlib.util,json\nfrom pathlib import Path\nfrom datetime import datetime,timezone\ns=importlib.util.spec_from_file_location('fixture',${JSON.stringify(fixtureModule)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.make_fixture(Path(${JSON.stringify(directory)}),${JSON.stringify(source)},datetime(2026,10,18,8,tzinfo=timezone.utc))\nprint('{}')`;
    await runTool(PYTHON, ["-I", "-B", "-c", program], {
      signal: AbortSignal.timeout(10_000),
      env: environment,
      directory,
      limit: 1024,
    });
    const values = JSON.parse(await readFile(join(directory, "synthetic.json"), "utf8"));
    const operation = join(directory, "nourishing-baseline-0123456789ab"),
      calls = [];
    const labels = [
      "auth-version",
      "auth-extensions",
      "auth-account",
      "auth-subscription",
      "read-resources",
      "read-cost",
    ];
    const execute = async (tool, args, options) => {
      if (tool.path === PYTHON.path) {
        const patch = `import importlib.util\nfrom datetime import datetime,timezone\ns=importlib.util.spec_from_file_location('pure',${JSON.stringify(args[2])});q=importlib.util.module_from_spec(s);s.loader.exec_module(q)\nq.P.tool_digest=lambda path:(q.P.CLI_SHA256,100)\nq.datetime=type('FixtureClock',(),{'now':staticmethod(lambda tz:datetime(2026,10,18,8,tzinfo=timezone.utc))})\nraise SystemExit(q.main(${JSON.stringify(args.slice(3))}))`;
        const result = await runTool(PYTHON, ["-I", "-B", "-c", patch], options);
        if (failure === "after-publication" && args[3] === "finish")
          throw new Error("synthetic post-publication failure");
        return result;
      }
      assert.equal(tool.path, "/usr/bin/az");
      const label = options.outputPath.slice(operation.length + 1, -5);
      calls.push(label);
      assert.equal(label, labels[calls.length - 1]);
      assert.equal(options.limit, label.startsWith("auth-") ? 131_072 : 1_048_576);
      assert.equal(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
      assert.equal(options.env.AZURE_CONFIG_DIR, join(directory, "profile"));
      assert.ok(!JSON.stringify(options.env).includes("PRIVATE_CANARY"));
      assert.equal(args.includes("register"), false);
      if (label === "read-resources") {
        assert.equal(args[2], "get");
        assert.ok(args[4].endsWith("/resources?api-version=2021-04-01&%24top=200"));
      }
      if (label === "read-cost") {
        assert.equal(args[2], "post");
        assert.equal(args[args.indexOf("--body") + 1], `@${join(operation, "cost-query.json")}`);
        assert.deepEqual(JSON.parse(await readFile(join(operation, "cost-query.json"), "utf8")), {
          type: "Usage",
          timeframe: "MonthToDate",
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
            grouping: [{ name: "ResourceGroup", type: "Dimension" }],
          },
        });
      }
      let value = values[label];
      if (failure === "authentication" && label === "auth-account") value = {};
      if (failure === "pagination" && label === "read-resources")
        value = { ...value, nextLink: "https://management.azure.com/next" };
      let text = `${JSON.stringify(value)}\n`,
        exit = 0;
      if (label === "read-cost") {
        if (failure === "query-nonzero") exit = 2;
        if (failure === "query-overflow")
          return runTool(
            PYTHON,
            ["-I", "-B", "-c", "import sys;sys.stdout.write('x'*1048577)"],
            options,
          );
        if (failure === "no-content") text = "";
      }
      return runTool(
        PYTHON,
        [
          "-I",
          "-B",
          "-c",
          `import sys;sys.stdout.write(${JSON.stringify(text)});sys.stderr.write('PRIVATE_CANARY');sys.exit(${exit})`,
        ],
        options,
      );
    };
    if (failure) {
      await assert.rejects(
        collectDevelopmentBaseline(
          input,
          { environment: { OTHER_SECRET: "PRIVATE_CANARY" } },
          execute,
        ),
      );
      assert.equal(calls.length, failure === "authentication" ? 4 : 6);
      if (failure === "after-publication")
        assert.equal(
          JSON.parse(await readFile(join(operation, "index.json"), "utf8")).completed,
          true,
        );
      else await assert.rejects(lstat(join(operation, "index.json")), { code: "ENOENT" });
    } else {
      const result = await collectDevelopmentBaseline(input, { environment }, execute);
      assert.equal(calls.length, 6);
      const raw = await readFile(join(operation, "index.json")),
        index = JSON.parse(raw);
      assert.equal(result.indexSha256, hash(raw));
      assert.equal(index.observations.resourceCount, 1);
      assert.deepEqual(index.observations.currencies, ["USD"]);
      assert.ok(!raw.includes("PRIVATE_CANARY"));
      assert.equal(Object.keys(index.retained_evidence).length, 12);
      assert.equal(
        (await verifyDevelopmentBaseline(input, result.indexSha256, { environment }, execute))
          .completed,
        true,
      );
      assert.equal(calls.length, 6);
      const cancelled = new AbortController();
      cancelled.abort(new Error("synthetic cancellation"));
      let cancelledExecution = false;
      await assert.rejects(
        verifyDevelopmentBaseline(
          input,
          result.indexSha256,
          { environment, signal: cancelled.signal },
          async (...args) => {
            cancelledExecution = true;
            return execute(...args);
          },
        ),
      );
      assert.equal(cancelledExecution, false);
      t.mock.timers.tick(660_000);
      try {
        await assert.rejects(
          verifyDevelopmentBaseline(input, result.indexSha256, { environment }, async (...args) => {
            const observed = await execute(...args);
            t.mock.timers.tick(61_000);
            return observed;
          }),
        );
      } finally {
        t.mock.timers.setTime(Date.parse(fixedNow));
      }
      await writeFile(join(operation, "read-cost.json"), `${JSON.stringify({})}\n`);
      await assert.rejects(
        verifyDevelopmentBaseline(input, result.indexSha256, { environment }, execute),
      );
      assert.equal(calls.length, 6);
    }
    // Keep every synthetic operation, including failures and the deliberately changed consumer fixture.
  }
});

test("subscription baseline Python policy regressions run in canonical CI", {
  timeout: 300_000,
}, async (t) => {
  const result = await runTool(PYTHON, ["-I", "-B", fixtureModule], {
    signal: AbortSignal.timeout(240_000),
    env: environment,
    directory: homedir(),
    limit: 131_072,
  });
  t.diagnostic(result.text.trim());
});
