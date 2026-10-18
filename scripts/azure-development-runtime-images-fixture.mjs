import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { references } from "./azure-development-runtime-fixture.mjs";
import { admitRuntimeImageObservations } from "./azure-development-runtime-images.mjs";
import { runTool } from "./postgres-operator-process.mjs";
import { MAILPIT_INPUTS } from "./verify-mailpit-build.mjs";

const source = resolve(fileURLToPath(new URL("../", import.meta.url))),
  sha = (raw) => createHash("sha256").update(raw).digest("hex");
const python = { path: "/usr/bin/python3.12", sha256: sha(await readFile("/usr/bin/python3.12")) };
const generated = spawnSync(
  python.path,
  ["-I", "-B", `${source}/scripts/azure-development-runtime-images-fixture.py`],
  {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 524_288,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  },
);
assert.ifError(generated.error);
assert.equal(generated.status, 0, generated.stderr);
const backend = JSON.parse(generated.stdout),
  revision = "a".repeat(40),
  lock = await readFile(new URL("../infra/docker/mailpit-build-inputs.json", import.meta.url)),
  notices = await readFile(new URL("../infra/docker/mailpit-NOTICES.txt", import.meta.url));
const capture = {
  User: "1000:1000",
  Entrypoint: ["/usr/bin/mailpit"],
  WorkingDir: "/data",
  Env: [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/home/mailpit",
    "TMPDIR=/tmp",
    "TZ=UTC",
  ],
  ExposedPorts: { "1025/tcp": {}, "8025/tcp": {} },
  Labels: {
    "org.opencontainers.image.source": "https://github.com/liangzixuan/cronometer-gold",
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": "v1.31.3",
    "io.cronometer.runtime.component": "mailpit",
    "io.cronometer.upstream.source.revision": MAILPIT_INPUTS.upstream.revision,
    "io.cronometer.build-inputs.sha256": sha(lock),
    "io.cronometer.notices.sha256": sha(notices),
  },
};

export function fixture(options = {}) {
  const rows = Object.entries(references).map(([name, reference], index) => ({
    Id: `sha256:${String(index + 1).repeat(64)}`,
    RepoDigests: [reference],
    Os: "linux",
    Architecture: "arm64",
    Config: structuredClone(name === "MAILPIT_IMAGE" ? capture : backend[name]),
  }));
  const calls = [],
    observations = [],
    controller = new AbortController();
  let conserved = 0;
  const input = {
    root: "/tmp/nourishing-runtime-image-source-fixture",
    sourceRevision: revision,
    images: { ...references },
    tools: { docker: { path: "/usr/bin/docker", sha256: "d".repeat(64) }, python },
    signal: controller.signal,
    conserve: async () => {
      conserved++;
      if (options.breakConservation && conserved > 1)
        throw new Error("Synthetic held input changed");
    },
    onObservation: async (row) => {
      observations.push(row);
    },
  };
  const execute = async (tool, args, configuration) => {
    configuration.signal.throwIfAborted();
    calls.push([...args]);
    if (tool.path === input.tools.docker.path) {
      assert.deepEqual(args, [
        "--host",
        "unix:///var/run/docker.sock",
        "--config",
        `${input.root}/docker-config`,
        "image",
        "inspect",
        ...Object.values(input.images),
      ]);
      assert.deepEqual(configuration.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
      const text = options.malformed ? "not-json" : JSON.stringify([...rows].reverse());
      return {
        text,
        bytes: Buffer.byteLength(text),
        sha256: options.wrongDigest ? "0".repeat(64) : sha(text),
        stderrBytes: 0,
        stderrSha256: sha(""),
      };
    }
    assert.deepEqual(tool, python);
    assert.deepEqual(args, [
      "-I",
      "-B",
      `${source}/infra/development/azure/runtime-image-observations.py`,
    ]);
    // This runs the actual maintained Python validators. Only raw Docker output above is controlled.
    const raw = await runTool(tool, args, configuration);
    if (!options.forgedReceipt) return raw;
    const receipt = JSON.parse(raw.text);
    receipt.images.API_IMAGE.image_id = `sha256:${"f".repeat(64)}`;
    const text = JSON.stringify(receipt);
    return { ...raw, text, bytes: Buffer.byteLength(text), sha256: sha(text) };
  };
  return {
    input,
    rows,
    calls,
    observations,
    controller,
    run: () => admitRuntimeImageObservations(input, { execute }),
  };
}
