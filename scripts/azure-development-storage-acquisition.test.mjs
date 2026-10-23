import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { openPlan } from "./azure-development-plan.mjs";
import { runStorageAcquisition, sourceDigest } from "./azure-development-storage-acquisition.mjs";
import { withOperatorTestEnvironment } from "./postgres-operator-fixture.mjs";
import { ChildCleanupError } from "./postgres-operator-process.mjs";

const child = promisify(execFile);
const gateway = resolve("infra/development/azure/test-storage-acquisition.py");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const initial = Date.parse("2026-10-10T12:00:00Z");
async function fixture(now = initial) {
  const r = await child("/usr/bin/python3.12", ["-I", "-B", gateway, "--fixture"], {
    env: { PATH: "/usr/bin:/bin", NOURISHING_TEST_CLOCK: new Date(now).toISOString() },
    timeout: 15000,
    maxBuffer: 1048576,
  });
  return JSON.parse(r.stdout);
}
async function privateDoc(path, value) {
  const raw = JSON.stringify(value) + "\n";
  await writeFile(path, raw, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha(raw) };
}
async function failedPlanEvidence(scenario) {
  const dir = await mkdtemp(join(homedir(), "nourishing-storage-diagnostic-"));
  await chmod(dir, 0o700);
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [initial]));
    }
    static now() {
      return initial;
    }
  };
  const diagnostic = Buffer.from([0xff, 0x00, ...Buffer.from("synthetic private diagnostic")]);
  const messages = [],
    oldError = console.error,
    oldLog = console.log;
  console.error = (...args) => messages.push(args);
  console.log = (...args) => messages.push(args);
  try {
    const f = await fixture();
    const identity = await privateDoc(join(dir, "identity.json"), {
      subscriptionId: f.sub,
      tenantId: f.sub,
    });
    const profile = join(dir, "synthetic-profile");
    await mkdir(profile, { mode: 0o700 });
    await privateDoc(join(profile, "config"), { synthetic: true });
    await privateDoc(join(profile, "clouds.config"), { synthetic: true });
    const source = await sourceDigest();
    const input = {
      schema_version: 1,
      source_sha256: source,
      operation_name: "nourishing-storage-plan-123456abcdef",
      not_after_utc: new Date(initial + 3600000).toISOString(),
      identity_file: identity.path,
      profile_directory: profile,
      terraform: join(dir, "synthetic-terraform"),
      provider_directory: join(dir, "synthetic-provider"),
      storage: f.storage,
    };
    const request = await privateDoc(join(dir, "request.json"), input);
    const directory = join(dir, input.operation_name),
      actions = [];
    const execute = async (tool, args, options) => {
      let text;
      if (tool.path === "/usr/bin/python3.12") {
        actions.push(args[3]);
        const result = await child(
          tool.path,
          ["-I", "-B", gateway, "--gateway", ...args.slice(3)],
          {
            env: { ...options.env, NOURISHING_TEST_CLOCK: new Date(initial).toISOString() },
            timeout: 20000,
            maxBuffer: 1048576,
          },
        );
        assert.equal(result.stderr, "");
        text = result.stdout;
      } else if (tool.path === "/usr/bin/az") {
        text = JSON.stringify(f.auth[options.outputPath.split("/").at(-1).slice(5, -5)]);
      } else {
        actions.push(args[0]);
        if (args[0] === "version")
          text = JSON.stringify({ terraform_version: "1.5.7", platform: "linux_amd64" });
        else if (args[0] === "init") {
          text = "initialized";
          if (scenario === "reservation")
            await writeFile(join(directory, "plan.stderr"), "foreign", { flag: "wx", mode: 0o600 });
        } else if (args[0] === "plan") {
          options.onStderr(diagnostic);
          if (scenario === "overflow") options.onStderr(Buffer.alloc(65536, 0xfe));
          if (scenario === "phases")
            await privateDoc(join(directory, "phases.json"), { retained: true });
          if (scenario === "cleanup") throw new ChildCleanupError();
          if (scenario === "join")
            return {
              bytes: 0,
              sha256: sha(""),
              stderrBytes: diagnostic.length,
              stderrSha256: sha("wrong"),
            };
          throw new Error("synthetic private diagnostic");
        } else throw new Error("Unexpected native stage");
      }
      if (options.outputPath)
        await writeFile(options.outputPath, text, { flag: "wx", mode: 0o600 });
      return {
        text,
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
        stderrBytes: 0,
        stderrSha256: sha(""),
      };
    };
    await assert.rejects(
      runStorageAcquisition("plan", request.path, request.sha256, { environment: {} }, execute),
    );
    assert.deepEqual(messages, []);
    assert.equal(actions.includes("show"), false);
    assert.equal(actions.includes("plan-finish"), false);
    await assert.rejects(lstat(join(directory, "result.json")), { code: "ENOENT" });
    const raw = await readFile(join(directory, "plan.stderr"));
    assert.equal((await lstat(join(directory, "plan.stderr"))).mode & 0o777, 0o600);
    if (scenario === "reservation") {
      assert.equal(actions.includes("plan"), false);
      assert.equal(raw.toString(), "foreign");
    } else {
      assert.deepEqual(raw.subarray(0, diagnostic.length), diagnostic);
      assert.equal(raw.length, scenario === "overflow" ? 65536 : diagnostic.length);
    }
    const phases = JSON.parse(await readFile(join(directory, "phases.json"), "utf8"));
    if (scenario === "phases") {
      assert.deepEqual(phases, { retained: true });
      return;
    }
    assert.equal(phases.length, 7);
    assert.equal(
      phases.slice(0, -1).every((p) => p.completed && p.stderrPublished && p.stderrComplete),
      true,
    );
    const last = phases.at(-1);
    assert.equal(last.phase, "plan");
    assert.equal(last.completed, false);
    assert.equal(last.exitCode, scenario === "join" ? 0 : null);
    assert.equal(last.executionReturned, scenario === "join");
    assert.equal(
      last.cleanup,
      scenario === "cleanup" ? "unconfirmed" : scenario === "join" ? "settled" : "unknown",
    );
    assert.equal(last.stderrComplete, false);
    assert.equal(last.stderrPublished, scenario !== "reservation");
    assert.equal(last.stderrCaptureOverflow, scenario === "overflow");
    assert.equal(last.sourceSha256, source);
    assert.equal(last.requestSha256, request.sha256);
    assert.equal(last.arguments[0], "plan");
    assert.equal(last.argumentsSha256, sha(JSON.stringify(last.arguments)));
    assert.match(last.executableSha256, /^[a-f0-9]{64}$/);
    assert.equal(last.startedAt, new Date(initial).toISOString());
    assert.equal(last.endedAt, last.startedAt);
    assert.equal(JSON.stringify(phases).includes("synthetic private diagnostic"), false);
    if (scenario !== "reservation") {
      assert.equal(last.stderrBytes, raw.length);
      assert.equal(last.stderrSha256, sha(raw));
    }
    assert.equal(
      last.failure,
      {
        command: "command",
        cleanup: "cleanup-unconfirmed",
        overflow: "capture-overflow",
        join: "stderr-binding",
        reservation: "evidence-publication",
      }[scenario],
    );
  } finally {
    globalThis.Date = OriginalDate;
    console.error = oldError;
    console.log = oldLog;
    await rm(dir, { recursive: true, force: true });
  }
}
for (const scenario of ["command", "cleanup", "overflow", "join", "reservation", "phases"]) {
  test(`private storage failure evidence: ${scenario}`, () => failedPlanEvidence(scenario));
}

test("source closure agrees between actual Python and Node", async () => {
  assert.equal((await fixture()).source, await sourceDigest());
});
test("actual acquisition producers join held historical qualification and expired-origin reconciliation", async (t) => {
  const dir = await mkdtemp(join(homedir(), "nourishing-acquisition-test-"));
  await chmod(dir, 0o700);
  const OriginalDate = globalThis.Date;
  let now = initial;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  try {
    const f = await fixture(now);
    const identity = await privateDoc(join(dir, "identity.json"), {
      subscriptionId: f.sub,
      tenantId: f.sub,
    });
    await mkdir(join(dir, "synthetic-profile"), { mode: 0o700 });
    await privateDoc(join(dir, "synthetic-profile/config"), { synthetic: true });
    await privateDoc(join(dir, "synthetic-profile/clouds.config"), { synthetic: true });
    const source = await sourceDigest();
    const input = {
      schema_version: 1,
      source_sha256: source,
      operation_name: "nourishing-storage-plan-abcdef123456",
      not_after_utc: new Date(initial + 3600000).toISOString(),
      identity_file: identity.path,
      profile_directory: join(dir, "synthetic-profile"),
      terraform: join(dir, "synthetic-terraform"),
      provider_directory: join(dir, "synthetic-provider"),
      storage: f.storage,
    };
    const request = await privateDoc(join(dir, "plan-request.json"), input);
    const readsPerPass = 15; // Fixed selected management commands, not HTTP or billing counts.
    let applies = 0,
      resourceReads = 0;
    let fault = null;
    const actions = [];
    const execute = async (tool, args, options) => {
      let text;
      if (tool.path === "/usr/bin/python3.12") {
        const r = await child(tool.path, ["-I", "-B", gateway, "--gateway", ...args.slice(3)], {
          env: { ...options.env, NOURISHING_TEST_CLOCK: new Date(now).toISOString() },
          timeout: 20000,
          maxBuffer: 1048576,
        });
        assert.equal(r.stderr, "");
        text = r.stdout;
      } else if (tool.path === "/usr/bin/az") {
        const output = options.outputPath?.split("/").at(-1);
        if (!output) {
          const url = args[args.indexOf("--url") + 1];
          const live = Object.values(f.live).find(
            (row) =>
              row.id && url === "https://management.azure.com" + row.id + "?api-version=2025-06-01",
          );
          const auth =
            args[0] === "version"
              ? "version"
              : args[0] === "extension"
                ? "extensions"
                : args[0] === "account"
                  ? "account"
                  : "subscription";
          text = JSON.stringify(live ?? f.auth[auth]);
        } else if (output.startsWith("auth-")) text = JSON.stringify(f.auth[output.slice(5, -5)]);
        else if (args[0] === "group" && args[1] === "exists") text = "false";
        else {
          resourceReads++;
          const label = output.replace(/^(first|second)-/, "").replace(/\.json$/, "");
          const value = structuredClone(f.live[label]);
          if (fault === "foreign" && output === "second-artifact-containers.json")
            value.value[0].id += "-foreign";
          if (fault === "freshness" && output === "second-backup-containers.json") now += 180000;
          if (fault === "horizon" && output === "first-group.json") now += 3600000;
          text = JSON.stringify(value);
          assert.notEqual(text, undefined);
        }
      } else {
        actions.push(args[0]);
        if (args[0] === "version")
          text = JSON.stringify({ terraform_version: "1.5.7", platform: "linux_amd64" });
        else if (args[0] === "init") text = "initialized";
        else if (args[0] === "plan") {
          const planPath = args.find((x) => x.startsWith("-out=")).slice(5);
          await writeFile(planPath, "synthetic-saved-plan", { mode: 0o600, flag: "wx" });
          text = "planned";
        } else if (args[0] === "show") {
          assert.match(args[2], /^\/proc\/\d+\/fd\/\d+$/);
          text = JSON.stringify(
            options.outputPath.endsWith("/state.json") ? f.renderedState : f.plan,
          );
        } else if (args[0] === "apply") {
          applies++;
          assert.equal(await readFile(args.at(-1), "utf8"), "synthetic-saved-plan");
          const action = resolve(options.directory, "..");
          const intent = JSON.parse(await readFile(join(action, "mutation-intent.json"), "utf8"));
          const claim = JSON.parse(
            await readFile(join(dir, input.operation_name, "execution-claim.json"), "utf8"),
          );
          assert.equal(intent.remote_outcome, "unknown");
          assert.equal(claim.directory, action);
          await writeFile(
            join(options.directory, "terraform.tfstate"),
            JSON.stringify(f.rawState) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          text = "applied";
        } else throw new Error("Unexpected synthetic tool");
      }
      if (options.outputPath)
        await writeFile(options.outputPath, text, { mode: 0o600, flag: "wx" });
      return {
        text,
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
        stderrBytes: 0,
        stderrSha256: sha(""),
      };
    };
    const prepared = await runStorageAcquisition(
      "plan",
      request.path,
      request.sha256,
      { environment: {} },
      execute,
    );
    assert.equal(applies, 0);
    // Actual Python verification rejects unselected, nested and renamed diagnostics.
    const sessionBytes = await readFile(join(prepared.directory, "session.json"));
    const verifyArgs = [
      "-I",
      "-B",
      gateway,
      "verify",
      "plan",
      request.path,
      prepared.directory,
      sha(sessionBytes),
    ];
    for (const name of ["unexpected.stderr", "apply.stderr", "work/init.stderr"]) {
      const path = join(prepared.directory, name);
      await writeFile(path, "synthetic", { flag: "wx", mode: 0o600 });
      await assert.rejects(
        execute({ path: "/usr/bin/python3.12" }, verifyArgs, { env: { PATH: "/usr/bin:/bin" } }),
        /unexpected private output/,
      );
      await rm(path);
    }
    const planResult = {
      path: join(prepared.directory, "result.json"),
      sha256: prepared.resultSha256,
    };
    const execution = {
      schema_version: 1,
      source_sha256: source,
      operation_name: "nourishing-storage-execute-111111111111",
      not_after_utc: new Date(initial + 3600000).toISOString(),
      plan_request: request,
      plan_result: planResult,
      origin: null,
    };
    const exref = await privateDoc(join(dir, "execute-request.json"), execution);
    const done = await runStorageAcquisition(
      "execute",
      exref.path,
      exref.sha256,
      { environment: {} },
      execute,
    );
    assert.equal(applies, 1);
    assert.equal(resourceReads, 2 * readsPerPass);
    const result = JSON.parse(await readFile(join(done.directory, "result.json"), "utf8"));
    assert.equal(result.operationalAcceptance, false);
    assert.equal(result.terraform_resource_count, 5);
    assert.equal(result.azure_object_count, 8);
    assert.equal(Object.keys(result.resource_ids).length, 5);
    assert.equal(Object.keys(result.container_ids).length, 3);
    assert.equal(result.deployment.provisioningState, "Succeeded");
    assert.deepEqual(
      result.deployment.outputResources,
      Object.values(result.container_ids)
        .map((x) => x.toLowerCase())
        .sort(),
    );
    const savedPlanResult = JSON.parse(await readFile(planResult.path, "utf8"));
    assert.equal(savedPlanResult.resource_count, 5);
    assert.equal(savedPlanResult.azure_object_count, 8);

    for (const n of ["artifact", "erasure", "backup"]) {
      const owner = JSON.parse(await readFile(result.ownership[n].path, "utf8"));
      assert.deepEqual(Object.keys(owner).sort(), [
        "account_id",
        "container_id",
        "creation_time",
        "location",
        "policy",
        "sku",
      ]);
      assert.equal(owner.policy.service.isVersioningEnabled, n !== "artifact");
    }
    const qualify = async (operation, ownership) => {
      const reference = {
        path: join(operation.directory, "result.json"),
        sha256: operation.resultSha256,
      };
      const output = await execute(
        { path: "/usr/bin/python3.12" },
        [
          "-I",
          "-B",
          resolve("infra/development/azure/storage-acquisition.py"),
          "qualify",
          reference.path,
          reference.sha256,
        ],
        { env: { PATH: "/usr/bin:/bin" } },
      );
      const binding = JSON.parse(output.text);
      assert.equal(binding.kind, "nutrition-azure-storage-acquisition-binding-v1");
      assert.deepEqual(binding.receipt, reference);
      assert.deepEqual(binding.ownership, ownership);
      assert.equal(binding.source_sha256, source);
      assert.equal(binding.external_quiescence_verified, false);
      assert.ok(binding.evidence.files.length > 0);
      return binding;
    };
    const beforeQualification = await readFile(join(done.directory, "result.json"));
    const binding = await qualify(done, result.ownership);
    assert.equal(binding.original_execution_outcome, "observed-complete");

    // This consumer uses real retained-acquisition regeneration, not a mocked context.
    const contextCommand = async (args, replacement) => {
      const response = await child(
        "/usr/bin/python3.12",
        ["-I", "-B", gateway, "--context-gateway", ...args],
        {
          env: {
            PATH: "/usr/bin:/bin",
            NOURISHING_TEST_CLOCK: new Date(now).toISOString(),
            ...(replacement ? { NOURISHING_TEST_CONTEXT_REPLACE: replacement } : {}),
          },
          timeout: 20000,
          maxBuffer: 1048576,
        },
      );
      assert.equal(response.stderr, "");
      return response.stdout;
    };
    const contextSource = (await contextCommand(["source-digest"])).trim();
    assert.match(contextSource, /^[a-f0-9]{64}$/u);
    const acquisition = { path: join(done.directory, "result.json"), sha256: done.resultSha256 };
    const contextManifest = {
      schema_version: 1,
      kind: "nutrition-azure-storage-observation-manifest-v1",
      storage: Object.fromEntries(
        ["artifact", "erasure", "backup"].map((name) => [
          name,
          {
            provider: "azure-blob",
            container_url:
              f.live[name + "-account"].properties.primaryEndpoints.blob +
              "nourishing-development-" +
              name,
            prefix: "development/" + name + "/",
            ownership_sha256: result.ownership[name].sha256,
          },
        ]),
      ),
      lease: {
        started_at_utc: new Date(initial).toISOString(),
        shutdown_at_utc: new Date(initial + 7200000).toISOString(),
        cleanup_seconds: 900,
      },
    };
    const manifestRef = await privateDoc(join(dir, "recovery-manifest.json"), contextManifest);
    const observation = {
      kind: "nutrition-azure-storage-observation-request-v1",
      schema_version: 1,
      source_sha256: contextSource,
      acquisition,
      identity_file: identity.path,
      identity_sha256: identity.sha256,
      profile_directory: input.profile_directory,
      profile_sha256: { synthetic: true },
      manifest_sha256: manifestRef.sha256,
      not_after_utc: new Date(initial + 3600000).toISOString(),
      lifecycle_not_after_utc: contextManifest.lease.shutdown_at_utc,
    };
    const observationRef = await privateDoc(join(dir, "recovery-request.json"), observation);
    const readContext = async (
      requestRef = observationRef,
      selectedManifest = manifestRef,
      selectedAcquisition = acquisition,
      replacement,
    ) =>
      JSON.parse(
        await contextCommand(
          [
            "qualify",
            requestRef.path,
            requestRef.sha256,
            selectedManifest.path,
            selectedManifest.sha256,
            selectedAcquisition.path,
            selectedAcquisition.sha256,
            contextSource,
            new Date(now).toISOString(),
          ],
          replacement,
        ),
      );
    await t.test(
      "recovery context regenerates acquisition and binds all original destinations",
      async () => {
        const value = await readContext();
        assert.equal(value.kind, "nutrition-azure-storage-recovery-context-v1");
        assert.equal(value.localOnly, true);
        assert.equal(value.operationalAcceptance, false);
        assert.equal(value.source_sha256, contextSource);
        assert.equal(value.request_sha256, observationRef.sha256);
        assert.equal(value.acquisition_sha256, acquisition.sha256);
        assert.equal(value.manifest_sha256, manifestRef.sha256);
        assert.deepEqual(value.manifest, contextManifest);
        assert.deepEqual(value.expected, { subscriptionId: f.sub, tenantId: f.sub });
        assert.match(value.storage_context_sha256, /^[a-f0-9]{64}$/u);
        assert.deepEqual(await readContext(), value);
        assert.deepEqual(await readFile(acquisition.path), beforeQualification);
        assert.equal(applies, 1);
      },
    );
    let rejectedIndex = 0;
    const changedObservation = async (change, changeManifest) => {
      const requestValue = structuredClone(observation);
      const manifestValue = structuredClone(contextManifest);
      let selectedManifest = manifestRef;
      if (changeManifest) {
        changeManifest(manifestValue);
        selectedManifest = await privateDoc(
          join(dir, `recovery-manifest-${++rejectedIndex}.json`),
          manifestValue,
        );
        requestValue.manifest_sha256 = selectedManifest.sha256;
      }
      if (change) change(requestValue);
      const ref = await privateDoc(
        join(dir, `recovery-request-${++rejectedIndex}.json`),
        requestValue,
      );
      await assert.rejects(readContext(ref, selectedManifest));
    };
    for (const [label, change] of [
      [
        "source",
        (v) => {
          v.source_sha256 = "0".repeat(64);
        },
      ],
      [
        "acquisition",
        (v) => {
          v.acquisition.sha256 = "0".repeat(64);
        },
      ],
      [
        "identity",
        (v) => {
          v.identity_sha256 = "0".repeat(64);
        },
      ],
      [
        "profile",
        (v) => {
          v.profile_sha256 = { changed: true };
        },
      ],
      [
        "manifest",
        (v) => {
          v.manifest_sha256 = "0".repeat(64);
        },
      ],
      [
        "expired observation",
        (v) => {
          v.not_after_utc = new Date(initial).toISOString();
        },
      ],
      [
        "unreviewed field",
        (v) => {
          v.unreviewed = true;
        },
      ],
    ])
      await t.test(`recovery context refuses changed ${label}`, () => changedObservation(change));
    for (const [label, change] of [
      [
        "destination",
        (v) => {
          v.storage.backup.container_url += "-foreign";
        },
      ],
      [
        "ownership",
        (v) => {
          v.storage.backup.ownership_sha256 = "0".repeat(64);
        },
      ],
      [
        "prefix",
        (v) => {
          v.storage.erasure.prefix = "foreign/";
        },
      ],
      [
        "storage field",
        (v) => {
          v.storage.unreviewed = {};
        },
      ],
      [
        "zero cleanup",
        (v) => {
          v.lease.cleanup_seconds = 0;
        },
      ],
      [
        "boolean cleanup",
        (v) => {
          v.lease.cleanup_seconds = true;
        },
      ],
      [
        "overlong lease",
        (v) => {
          v.lease.shutdown_at_utc = new Date(initial + 18000000).toISOString();
        },
      ],
      [
        "fractional minute lease",
        (v) => {
          v.lease.started_at_utc = new Date(initial - 1000).toISOString();
        },
      ],
    ])
      await t.test(`recovery context refuses changed ${label}`, () =>
        changedObservation(null, change),
      );
    await t.test(
      "recovery context refuses changed original state through genuine regeneration",
      async () => {
        const path = join(done.directory, "work/terraform.tfstate");
        const raw = await readFile(path);
        try {
          await writeFile(path, Buffer.concat([raw, Buffer.from(" ")]));
          await assert.rejects(readContext());
        } finally {
          await writeFile(path, raw);
        }
      },
    );
    await t.test(
      "recovery context refuses self-consistent forged acquisition metadata",
      async () => {
        const forged = JSON.parse(beforeQualification);
        forged.phases_sha256 = "0".repeat(64);
        const raw = JSON.stringify(forged) + "\n";
        try {
          await writeFile(acquisition.path, raw);
          const ref = { ...acquisition, sha256: sha(raw) };
          const requestRef = await privateDoc(join(dir, "recovery-forged-request.json"), {
            ...observation,
            acquisition: ref,
          });
          await assert.rejects(readContext(requestRef, manifestRef, ref));
        } finally {
          await writeFile(acquisition.path, beforeQualification);
        }
      },
    );
    await t.test(
      "recovery context conserves a held request against same-byte replacement",
      async () => {
        await assert.rejects(
          readContext(observationRef, manifestRef, acquisition, observationRef.path),
        );
        assert.equal(sha(await readFile(observationRef.path)), observationRef.sha256);
        assert.deepEqual((await readContext()).manifest, contextManifest);
      },
    );

    await t.test("recovery context does not renew an expired lease", async () => {
      const previous = now;
      now = initial + 7200000;
      try {
        await assert.rejects(readContext());
      } finally {
        now = previous;
      }
    });
    await t.test("recovery context requires the independent source digest", async () => {
      await assert.rejects(
        contextCommand([
          "qualify",
          observationRef.path,
          observationRef.sha256,
          manifestRef.path,
          manifestRef.sha256,
          acquisition.path,
          acquisition.sha256,
          "0".repeat(64),
          new Date(now).toISOString(),
        ]),
      );
    });

    // Actual producer -> independent regeneration -> protected parser; native work is mocked.
    const assemblyCommand = async (args, fault = {}) => {
      const response = await child(
        "/usr/bin/python3.12",
        ["-I", "-B", gateway, "--assembly-gateway", ...args],
        {
          env: {
            PATH: "/usr/bin:/bin",
            NOURISHING_TEST_CLOCK: new Date(now).toISOString(),
            ...(fault.replace ? { NOURISHING_TEST_CONTEXT_REPLACE: fault.replace } : {}),
            ...(fault.postRead ? { NOURISHING_TEST_ASSEMBLY_POST_READ: "1" } : {}),
          },
          timeout: 60000,
          maxBuffer: 1048576,
        },
      );
      assert.equal(response.stderr, "");
      return response.stdout;
    };
    const assemblySource = (await assemblyCommand(["source-digest"])).trim();
    const recoverySources = [
      "infra/development/azure/storage-recovery-assembly.py",
      "infra/development/azure/storage-recovery-context.py",
      "infra/development/azure/storage-acquisition.py",
      "scripts/postgres-operator.mjs",
    ];
    const sourceFiles = Object.fromEntries(
      await Promise.all(
        recoverySources.map(async (name) => {
          const path = resolve(name);
          return [name, { path, sha256: sha(await readFile(path)) }];
        }),
      ),
    );
    const assemblyInput = {
      schema_version: 1,
      kind: "nutrition-storage-recovery-assembly-input-v1",
      target: "development",
      classification: "synthetic",
      source_revision: "a".repeat(40),
      source_files: sourceFiles,
      acquisition,
      storage_request: observationRef,
      storage_manifest: manifestRef,
      not_after_utc: new Date(initial + 600000).toISOString(),
    };
    const assemblyInputRef = await privateDoc(join(dir, "assembly-input.json"), assemblyInput);
    const bundlePath = join(dir, "recovery-bundle.json");
    const assemblyArgs = (mode, inputRef = assemblyInputRef, output = bundlePath) => [
      mode,
      inputRef.path,
      inputRef.sha256,
      contextSource,
      assemblySource,
      new Date(now).toISOString(),
      new Date(initial + 900000).toISOString(),
      output,
    ];
    let bundleRef, generated;
    await t.test(
      "maintained recovery prepare and independent qualify regenerate exact bundle",
      async () => {
        const preparedBundle = JSON.parse(await assemblyCommand(assemblyArgs("prepare")));
        const raw = await readFile(bundlePath);
        bundleRef = { path: bundlePath, sha256: sha(raw) };
        generated = JSON.parse(raw);
        const qualified = JSON.parse(
          await assemblyCommand([...assemblyArgs("qualify"), bundleRef.sha256]),
        );
        assert.deepEqual(qualified, preparedBundle);
        assert.equal(qualified.bundle_sha256, bundleRef.sha256);
        assert.equal(qualified.localOnly, true);
        assert.equal(qualified.operationalAcceptance, false);
        assert.equal(qualified.executable, false);
        assert.equal(qualified.component_count, 0);
        assert.equal(
          generated.storage_context_sha256,
          (await readContext()).storage_context_sha256,
        );
        assert.deepEqual(generated.source_files, sourceFiles);
        assert.deepEqual(generated.admitted_components, []);
        assert.equal(generated.members["recovery-references.json"].mode, "0600");
        assert.equal(applies, 1);
      },
    );
    await t.test("recovery prepare is create-only and conserves published bytes", async () => {
      const raw = await readFile(bundlePath);
      await assert.rejects(assemblyCommand(assemblyArgs("prepare")));
      assert.deepEqual(await readFile(bundlePath), raw);
    });
    await t.test(
      "independent recovery qualification refuses self-consistent member substitution",
      async () => {
        const changed = structuredClone(generated);
        const member = changed.members["recovery-references.json"];
        const refs = JSON.parse(member.content);
        refs.postgres_backup_destination.prefix = "foreign/";
        member.content = JSON.stringify(refs);
        member.sha256 = sha(member.content);
        const forgedRef = await privateDoc(join(dir, "forged-bundle.json"), changed);
        await assert.rejects(
          assemblyCommand([
            ...assemblyArgs("qualify", assemblyInputRef, forgedRef.path),
            forgedRef.sha256,
          ]),
        );
      },
    );
    await t.test(
      "recovery prepare preserves a published bundle after readback failure",
      async () => {
        const output = join(dir, "uncertain-bundle.json");
        await assert.rejects(
          assemblyCommand(assemblyArgs("prepare", assemblyInputRef, output), { postRead: true }),
          (error) => {
            assert.match(error.stderr, /published; final readback unconfirmed/u);
            return true;
          },
        );
        assert.equal(sha(await readFile(output)), bundleRef.sha256);
      },
    );
    await t.test("recovery prepare refuses same-byte held input replacement", async () => {
      const output = join(dir, "replaced-input-bundle.json");
      await assert.rejects(
        assemblyCommand(assemblyArgs("prepare", assemblyInputRef, output), {
          replace: assemblyInputRef.path,
        }),
      );
      await assert.rejects(readFile(output), { code: "ENOENT" });
      assert.equal(sha(await readFile(assemblyInputRef.path)), assemblyInputRef.sha256);
    });
    for (const [label, change] of [
      [
        "source reference",
        (v) => {
          v.source_files[recoverySources[0]].path += ".copied";
        },
      ],
      [
        "source digest",
        (v) => {
          v.source_files[recoverySources[0]].sha256 = "0".repeat(64);
        },
      ],
      [
        "expiry",
        (v) => {
          v.not_after_utc = new Date(initial).toISOString();
        },
      ],
      [
        "kind",
        (v) => {
          v.classification = "actual";
        },
      ],
    ])
      await t.test(`recovery prepare refuses changed ${label}`, async () => {
        const changed = structuredClone(assemblyInput);
        change(changed);
        const ref = await privateDoc(
          join(dir, `assembly-${label.replaceAll(" ", "-")}.json`),
          changed,
        );
        const output = join(dir, `refused-${label.replaceAll(" ", "-")}-bundle.json`);
        await assert.rejects(assemblyCommand(assemblyArgs("prepare", ref, output)));
        await assert.rejects(readFile(output), { code: "ENOENT" });
      });
    await t.test("recovery prepare requires independent producer and context digests", async () => {
      for (const index of [3, 4]) {
        const args = assemblyArgs(
          "prepare",
          assemblyInputRef,
          join(dir, `wrong-digest-${index}.json`),
        );
        args[index] = "0".repeat(64);
        await assert.rejects(assemblyCommand(args));
        await assert.rejects(readFile(args.at(-1)), { code: "ENOENT" });
      }
    });
    await t.test(
      "maintained qualified recovery bundle reaches actual protected parser",
      async () => {
        const refs = JSON.parse(generated.members["recovery-references.json"].content);
        assert.equal(
          refs.postgres_backup_destination.containerUrl,
          contextManifest.storage.backup.container_url,
        );
        assert.equal(
          refs.ledger_consumers.worker.ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL,
          contextManifest.storage.erasure.container_url,
        );
        const symbol = Symbol.for("nutrition.test.generatedRecoveryParser");
        const state = { calls: 0, key: null };
        globalThis[symbol] = state;
        const sourceURL = (name) => pathToFileURL(resolve(name)).href;
        const hooks = registerHooks({
          resolve(specifier, context, next) {
            if (
              specifier === "../packages/contracts/dist/index.js" &&
              context.parentURL?.endsWith("/azure-development-runtime-database-policy.mjs")
            )
              return {
                url: sourceURL("packages/contracts/src/canonical-json.ts"),
                shortCircuit: true,
              };
            if (
              specifier === "./postgres-backup.mjs" &&
              context.parentURL?.endsWith("/postgres-operator.mjs")
            )
              return { url: "generated-recovery:native", shortCircuit: true };
            if (
              specifier === "../packages/artifact-store/dist/index.js" &&
              ["/postgres-operator.mjs", "/postgres-backup-storage.mjs"].some((name) =>
                context.parentURL?.endsWith(name),
              )
            )
              return { url: "generated-recovery:artifact-source", shortCircuit: true };
            if (
              context.parentURL?.includes("/packages/") &&
              specifier.startsWith(".") &&
              specifier.endsWith(".js")
            ) {
              const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
              if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
            }
            return next(specifier, context);
          },
          load(url, context, next) {
            if (/\/packages\/[^/]+\/dist\//u.test(url))
              throw new Error("Workspace dist load refused by recovery source proof");
            if (url === "generated-recovery:native")
              return {
                format: "module",
                shortCircuit: true,
                source:
                  "export const runPostgresBackup=s=>globalThis[Symbol.for('nutrition.test.generatedRecoveryParser')].backup(s);",
              };
            if (url === "generated-recovery:artifact-source")
              return {
                format: "module",
                shortCircuit: true,
                source: ["artifact-encryption", "postgres-backup", "azure-blob-raw-artifact-store"]
                  .map(
                    (name) =>
                      "export * from " +
                      JSON.stringify(sourceURL(`packages/artifact-store/src/${name}.ts`)) +
                      ";",
                  )
                  .join("\n"),
              };
            if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/packages/"))
              return {
                format: "module",
                shortCircuit: true,
                source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
                  mode: "transform",
                  sourceUrl: url,
                }),
              };
            return next(url, context);
          },
        });
        try {
          state.backup = async (settings) => {
            state.calls++;
            assert.deepEqual(settings.storage, refs.postgres_backup_destination);
            state.key = settings.keyRing.keys.get("synthetic");
            assert.deepEqual(state.key, Buffer.alloc(32, 7));
            return {
              kind: "publication",
              storage: "azure-blob",
              localOnly: true,
              operationalRecoveryAccepted: false,
              manifestSha256: "e".repeat(64),
              manifest: {
                backupId: "a0000000-0000-4000-8000-000000000001",
                databaseName: "nutrition",
                deploymentTarget: "development",
                snapshotId: "synthetic",
                sourceRevision: assemblyInput.source_revision,
              },
            };
          };
          const { runPostgresOperator } = await import("./postgres-operator.mjs");
          const settings = {
            timeoutMs: 1000,
            storage: refs.postgres_backup_destination,
            sourceRevision: assemblyInput.source_revision,
            deploymentTarget: "development",
            keyRing: {
              currentKeyId: "synthetic",
              keys: { synthetic: Buffer.alloc(32, 7).toString("base64") },
            },
          };
          const dispatch = async (binding = bundleRef, changedSettings = settings) => {
            const document = {
              schemaVersion: 1,
              operation: "backup",
              notAfterUtc: new Date(now + 180000).toISOString(),
              assembly: binding,
              settings: changedSettings,
            };
            const raw = JSON.stringify(document);
            const path = join(dir, `generated-operator-${++rejectedIndex}.json`);
            await writeFile(path, raw, { mode: 0o600, flag: "wx" });
            const inherited = process.env;
            try {
              return await withOperatorTestEnvironment(() =>
                runPostgresOperator(["backup", "--input", path, "--input-sha256", sha(raw)]),
              );
            } finally {
              assert.equal(process.env, inherited);
            }
          };
          const receipt = await dispatch();
          assert.equal(state.calls, 1);
          assert.deepEqual(state.key, Buffer.alloc(32));
          assert.equal(receipt.assemblySha256, bundleRef.sha256);
          assert.equal(receipt.result.operationalRecoveryAccepted, false);
          assert.equal(
            JSON.stringify(receipt).includes(Buffer.alloc(32, 7).toString("base64")),
            false,
          );
          await assert.rejects(
            dispatch(bundleRef, {
              ...settings,
              storage: { ...settings.storage, prefix: "foreign/" },
            }),
          );
          assert.equal(state.calls, 1);
          const obsolete = structuredClone(generated);
          obsolete.source_files["infra/development/azure/runtime-installation-storage.py"] =
            obsolete.source_files[recoverySources[1]];
          delete obsolete.source_files[recoverySources[1]];
          const obsoleteRef = await privateDoc(join(dir, "obsolete-source-bundle.json"), obsolete);
          await assert.rejects(dispatch(obsoleteRef));
          assert.equal(state.calls, 1);
        } finally {
          hooks.deregister();
          delete globalThis[symbol];
        }
      },
    );

    const statePath = join(done.directory, "work/terraform.tfstate");
    const bytes = await readFile(statePath);
    await writeFile(statePath, Buffer.concat([bytes, Buffer.from(" ")]));
    await assert.rejects(() => qualify(done, result.ownership));
    await writeFile(statePath, bytes);
    assert.deepEqual(await readFile(join(done.directory, "result.json")), beforeQualification);
    for (const name of ["first-members.json", "second-backup-containers.json"]) {
      const path = join(done.directory, name);
      const saved = await readFile(path);
      const changed = JSON.parse(saved);
      changed.value[0].id += "-foreign";
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(() => qualify(done, result.ownership));
      await writeFile(path, saved);
    }
    for (const name of ["first-deployment.json", "second-deployment.json"]) {
      const path = join(done.directory, name);
      const saved = await readFile(path);
      const changed = JSON.parse(saved);
      changed.properties.outputResources[0].id += "-foreign";
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(() => qualify(done, result.ownership));
      await writeFile(path, saved);
    }
    const forged = JSON.parse(beforeQualification);
    forged.phases_sha256 = "0".repeat(64);
    await writeFile(join(done.directory, "result.json"), JSON.stringify(forged) + "\n");
    await assert.rejects(() =>
      qualify(
        {
          ...done,
          resultSha256: sha(JSON.stringify(forged) + "\n"),
        },
        result.ownership,
      ),
    );
    await writeFile(join(done.directory, "result.json"), beforeQualification);
    const second = await privateDoc(join(dir, "second-request.json"), {
      ...execution,
      operation_name: "nourishing-storage-execute-222222222222",
    });
    await assert.rejects(
      runStorageAcquisition("execute", second.path, second.sha256, { environment: {} }, execute),
    );
    assert.equal(applies, 1);
    const cloneParent = join(dir, "copied");
    await mkdir(cloneParent, { mode: 0o700 });
    const clonePlan = join(cloneParent, input.operation_name);
    await mkdir(clonePlan, { mode: 0o700 });
    for (const name of ["result.json", "plan.tfplan", "rendered.json"])
      await writeFile(join(clonePlan, name), await readFile(join(prepared.directory, name)), {
        mode: 0o600,
        flag: "wx",
      });
    const copiedRequest = await privateDoc(join(cloneParent, "plan-request.json"), input);
    assert.equal(copiedRequest.sha256, request.sha256);
    const copiedExecution = await privateDoc(join(cloneParent, "execute-request.json"), {
      ...execution,
      operation_name: "nourishing-storage-execute-444444444444",
      plan_request: copiedRequest,
      plan_result: { path: join(clonePlan, "result.json"), sha256: planResult.sha256 },
    });
    await assert.rejects(
      runStorageAcquisition(
        "execute",
        copiedExecution.path,
        copiedExecution.sha256,
        { environment: {} },
        execute,
      ),
    );
    assert.equal(applies, 1);
    const sessionRaw = await readFile(join(done.directory, "session.json"));
    const intentRaw = await readFile(join(done.directory, "mutation-intent.json"));
    const stateRaw = await readFile(join(done.directory, "work/terraform.tfstate"));
    now = initial + 3600001;
    const reconcile = {
      ...execution,
      operation_name: "nourishing-storage-reconcile-333333333333",
      not_after_utc: new Date(now + 3600000).toISOString(),
      origin: {
        request: exref,
        directory: done.directory,
        session_sha256: sha(sessionRaw),
        intent_sha256: sha(intentRaw),
        state_sha256: sha(stateRaw),
      },
    };
    const rr = await privateDoc(join(dir, "reconcile-request.json"), reconcile);
    const reconciled = await runStorageAcquisition(
      "reconcile",
      rr.path,
      rr.sha256,
      { environment: {} },
      execute,
    );
    const observed = JSON.parse(await readFile(join(reconciled.directory, "result.json"), "utf8"));
    assert.equal(observed.original_execution_outcome, "unconfirmed");
    assert.equal(observed.external_quiescence_verified, false);
    assert.equal(applies, 1);
    assert.equal(
      await readFile(join(done.directory, "work/terraform.tfstate"), "utf8"),
      stateRaw.toString(),
    );
    assert.equal(actions.filter((x) => x === "plan").length, 1);
    assert.equal(resourceReads, 4 * readsPerPass);
    const admittedTime = now;
    for (const [index, selected] of ["foreign", "freshness", "horizon"].entries()) {
      now = admittedTime;
      fault = selected;
      const rejected = await privateDoc(join(dir, `rejected-${selected}.json`), {
        ...reconcile,
        operation_name: `nourishing-storage-reconcile-${String(index + 5).repeat(12)}`,
      });
      await assert.rejects(
        runStorageAcquisition(
          "reconcile",
          rejected.path,
          rejected.sha256,
          { environment: {} },
          execute,
        ),
      );
      const operationName = JSON.parse(await readFile(rejected.path, "utf8")).operation_name;
      await assert.rejects(readFile(join(dir, operationName, "result.json")));
      assert.equal(applies, 1);
    }
    fault = null;
    now = admittedTime + 7200000; // Historical validation does not renew expired operations.
    const afterExpiry = await qualify(reconciled, observed.ownership);
    assert.equal(afterExpiry.original_execution_outcome, "unconfirmed");
    // An interrupted original apply need not have completed result or phases files.
    await rm(join(done.directory, "result.json"));
    await rm(join(done.directory, "phases.json"));
    const interruptedOrigin = await qualify(reconciled, observed.ownership);
    assert.equal(interruptedOrigin.original_execution_outcome, "unconfirmed");
    assert.equal(applies, 1);
    assert.equal(resourceReads, 8 * readsPerPass + 1);
  } finally {
    globalThis.Date = OriginalDate;
    await rm(dir, { recursive: true, force: true });
  }
});
test("ambient Azure identity and malformed mode reject before execution", async () => {
  let calls = 0;
  const execute = async () => {
    calls++;
    throw new Error("unreachable");
  };
  await assert.rejects(
    runStorageAcquisition("delete", "/absent", "a".repeat(64), { environment: {} }, execute),
  );
  await assert.rejects(
    runStorageAcquisition(
      "plan",
      "/absent",
      "a".repeat(64),
      { environment: { ARM_FIVEPOINTZERO_BETA: "true" } },
      execute,
    ),
  );
  assert.equal(calls, 0);
});

test("pure storage and retained acquisition Python validators", async () => {
  for (const name of ["test-storage-policy.py", "test-storage-acquisition.py"]) {
    const result = await child(
      "/usr/bin/python3.12",
      ["-I", "-B", resolve("infra/development/azure", name)],
      {
        env: { PATH: "/usr/bin:/bin" },
        timeout: 30000,
        maxBuffer: 1048576,
      },
    );
    assert.match(result.stderr, /\nOK\s*$/u);
  }
});

test("held reader repeated guards release no stream listeners and reject changed content", async () => {
  const directory = await mkdtemp(join(homedir(), "nourishing-held-reader-test-"));
  await chmod(directory, 0o700);
  const path = join(directory, "input.bin");
  const bytes = Buffer.alloc(131073, 31);
  let held;
  const warnings = [];
  const warning = (w) => warnings.push(w);
  process.on("warning", warning);
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    held = await openPlan(path);
    assert.equal(held.sha256, sha(bytes));
    for (let i = 0; i < 50; i++) await held.verify();
    await new Promise(setImmediate);
    assert.equal(warnings.filter((w) => w.name === "MaxListenersExceededWarning").length, 0);
    bytes[100] = 17;
    await writeFile(path, bytes);
    await assert.rejects(held.verify());
    await held.close();
    held = await openPlan(path);
    await writeFile(path, bytes.subarray(0, 100));
    await assert.rejects(held.verify());
  } finally {
    try {
      if (held) await held.close();
    } finally {
      process.removeListener("warning", warning);
      bytes.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  }
});
