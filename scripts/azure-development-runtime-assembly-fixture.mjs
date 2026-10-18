// Actual acquisition/context/assembly validators; only external command observations are synthetic.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runStorageAcquisition, sourceDigest } from "./azure-development-storage-acquisition.mjs";

const child = promisify(execFile),
  gateway = resolve("infra/development/azure/test-storage-acquisition.py"),
  sha = (v) => createHash("sha256").update(v).digest("hex");
export async function runtimeAssemblyFixture(root) {
  const dir = join(root, "recovery"),
    initial = Math.floor(Date.now() / 60000) * 60000;
  await mkdir(dir, { mode: 0o700, recursive: true });
  const invoke = async (mode, args) => {
    const result = await child("/usr/bin/python3.12", ["-I", "-B", gateway, mode, ...args], {
      env: { PATH: "/usr/bin:/bin", NOURISHING_TEST_CLOCK: new Date().toISOString() },
      timeout: 60000,
      maxBuffer: 1048576,
    });
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const privateDoc = async (name, value) => {
    const path = join(dir, name),
      raw = JSON.stringify(value) + "\n";
    await writeFile(path, raw, { mode: 0o600, flag: "wx" });
    return { path, sha256: sha(raw) };
  };
  const f = JSON.parse(await invoke("--fixture", [])),
    identity = await privateDoc("synthetic-identity.json", {
      subscriptionId: f.sub,
      tenantId: f.sub,
    });
  const profile = join(dir, "synthetic-profile");
  await mkdir(profile, { mode: 0o700 });
  for (const name of ["config", "clouds.config"])
    await writeFile(join(profile, name), '{"synthetic":true}\n', { mode: 0o600, flag: "wx" });
  const source = await sourceDigest();
  const input = {
    schema_version: 1,
    source_sha256: source,
    operation_name: "nourishing-storage-plan-abcdef123456",
    not_after_utc: new Date(initial + 3600000).toISOString(),
    identity_file: identity.path,
    profile_directory: profile,
    terraform: join(dir, "synthetic-terraform"),
    provider_directory: join(dir, "synthetic-provider"),
    storage: f.storage,
  };
  const request = await privateDoc("plan-request.json", input);
  let applies = 0;
  const execute = async (tool, args, options) => {
    let text;
    if (tool.path === "/usr/bin/python3.12") text = await invoke("--gateway", args.slice(3));
    else if (tool.path === "/usr/bin/az") {
      const output = options.outputPath?.split("/").at(-1);
      if (!output) {
        const url = args[args.indexOf("--url") + 1],
          live = Object.values(f.live).find(
            (row) =>
              row.id && url === `https://management.azure.com${row.id}?api-version=2025-06-01`,
          );
        const label =
          args[0] === "version"
            ? "version"
            : args[0] === "extension"
              ? "extensions"
              : args[0] === "account"
                ? "account"
                : "subscription";
        text = JSON.stringify(live ?? f.auth[label]);
      } else if (output.startsWith("auth-")) text = JSON.stringify(f.auth[output.slice(5, -5)]);
      else if (args[0] === "group" && args[1] === "exists") text = "false";
      else {
        const label = output.replace(/^(first|second)-/u, "").replace(/\.json$/u, "");
        assert(Object.hasOwn(f.live, label));
        text = JSON.stringify(f.live[label]);
      }
    } else {
      assert.equal(tool.path, input.terraform, "No unselected native command can execute");
      if (args[0] === "version")
        text = JSON.stringify({ terraform_version: "1.5.7", platform: "linux_amd64" });
      else if (args[0] === "init") text = "initialized";
      else if (args[0] === "plan") {
        await writeFile(args.find((x) => x.startsWith("-out=")).slice(5), "synthetic-saved-plan", {
          mode: 0o600,
          flag: "wx",
        });
        text = "planned";
      } else if (args[0] === "show") {
        assert.match(args[2], /^\/proc\/\d+\/fd\/\d+$/u);
        text = JSON.stringify(
          options.outputPath.endsWith("/state.json") ? f.renderedState : f.plan,
        );
      } else if (args[0] === "apply") {
        applies++;
        for (const name of ["artifact", "erasure", "backup"])
          f.live[`${name}-account`].properties.creationTime = new Date().toISOString();
        assert.equal(await readFile(args.at(-1), "utf8"), "synthetic-saved-plan");
        const action = resolve(options.directory, ".."),
          intent = JSON.parse(await readFile(join(action, "mutation-intent.json"), "utf8")),
          claim = JSON.parse(
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
      } else assert.fail("Unselected synthetic command");
    }
    assert.equal(typeof text, "string");
    if (options.outputPath) await writeFile(options.outputPath, text, { mode: 0o600, flag: "wx" });
    return {
      text,
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
      stderrBytes: 0,
      stderrSha256: sha(""),
    };
  };
  const planned = await runStorageAcquisition(
    "plan",
    request.path,
    request.sha256,
    { environment: {} },
    execute,
  );
  const execution = await privateDoc("execute-request.json", {
    schema_version: 1,
    source_sha256: source,
    operation_name: "nourishing-storage-execute-111111111111",
    not_after_utc: new Date(initial + 3600000).toISOString(),
    plan_request: request,
    plan_result: { path: join(planned.directory, "result.json"), sha256: planned.resultSha256 },
    origin: null,
  });
  const done = await runStorageAcquisition(
    "execute",
    execution.path,
    execution.sha256,
    { environment: {} },
    execute,
  );
  assert.equal(applies, 1);
  const result = JSON.parse(await readFile(join(done.directory, "result.json"), "utf8"));
  assert.equal(result.operationalAcceptance, false);
  const acquisition = { path: join(done.directory, "result.json"), sha256: done.resultSha256 };
  const contextSource = (await invoke("--context-gateway", ["source-digest"])).trim();
  const destinations = Object.fromEntries(
    ["artifact", "erasure", "backup"].map((name) => [
      name,
      {
        provider: "azure-blob",
        container_url:
          f.live[`${name}-account`].properties.primaryEndpoints.blob +
          `nourishing-development-${name}`,
        prefix: `development/${name}/`,
        ownership_sha256: result.ownership[name].sha256,
      },
    ]),
  );
  const manifest = await privateDoc("recovery-manifest.json", {
    schema_version: 1,
    kind: "nutrition-azure-storage-observation-manifest-v1",
    storage: destinations,
    lease: {
      started_at_utc: new Date(initial).toISOString(),
      shutdown_at_utc: new Date(initial + 7200000).toISOString(),
      cleanup_seconds: 900,
    },
  });
  const observation = await privateDoc("recovery-request.json", {
    kind: "nutrition-azure-storage-observation-request-v1",
    schema_version: 1,
    source_sha256: contextSource,
    acquisition,
    identity_file: identity.path,
    identity_sha256: identity.sha256,
    profile_directory: profile,
    profile_sha256: { synthetic: true },
    manifest_sha256: manifest.sha256,
    not_after_utc: new Date(initial + 3600000).toISOString(),
    lifecycle_not_after_utc: new Date(initial + 7200000).toISOString(),
  });
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      [
        "infra/development/azure/storage-recovery-assembly.py",
        "infra/development/azure/storage-recovery-context.py",
        "infra/development/azure/storage-acquisition.py",
        "scripts/postgres-operator.mjs",
      ].map(async (name) => [
        name,
        { path: resolve(name), sha256: sha(await readFile(resolve(name))) },
      ]),
    ),
  );
  const assemblyInput = await privateDoc("assembly-input.json", {
    schema_version: 1,
    kind: "nutrition-storage-recovery-assembly-input-v1",
    target: "development",
    classification: "synthetic",
    source_revision: "a".repeat(40),
    source_files: sourceFiles,
    acquisition,
    storage_request: observation,
    storage_manifest: manifest,
    not_after_utc: new Date(initial + 600000).toISOString(),
  });
  const assemblySource = (await invoke("--assembly-gateway", ["source-digest"])).trim();
  const command = async (args) => {
    const { stdout, stderr } = await child(
      "/usr/bin/python3.12",
      ["-I", "-B", gateway, "--assembly-gateway", ...args],
      {
        env: { PATH: "/usr/bin:/bin", NOURISHING_TEST_CLOCK: new Date().toISOString() },
        timeout: 60000,
        maxBuffer: 1048576,
      },
    );
    assert.equal(stderr, "");
    return stdout;
  };
  return {
    assemblyInput,
    contextSource,
    assemblySource,
    destinations,
    command,
    applies: () => applies,
  };
}
