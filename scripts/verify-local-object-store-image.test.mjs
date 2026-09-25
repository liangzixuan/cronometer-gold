import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OBJECT_STORE_IMAGE,
  OBJECT_STORE_REF,
  verifyObjectStoreImage,
} from "./verify-local-object-store-image.mjs";

const index = readFileSync(
  new URL("./fixtures/object-store-image-index.txt", import.meta.url),
  "utf8",
);
const runtime = {
  os: "linux",
  architecture: "arm64",
  config: {
    Labels: {
      "org.opencontainers.image.source": "https://github.com/seaweedfs/seaweedfs",
      "org.opencontainers.image.version": "4.47",
      "org.opencontainers.image.revision": "c5073360007d28385a33426a42ac3e4ec504c5a3",
    },
  },
};
function signature(digest) {
  return [
    {
      critical: {
        type: "https://sigstore.dev/cosign/sign/v1",
        image: { "docker-manifest-digest": digest },
      },
    },
  ];
}
function runner(overrides = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "docker" && args.includes("--raw")) return overrides.index ?? index;
    if (command === "docker") return JSON.stringify(overrides.runtime ?? runtime);
    const digest = args.at(-1).split("@")[1];
    if (overrides.failSignature === digest) throw new Error("Signature verification failed");
    return JSON.stringify(overrides.signatures ?? signature(digest));
  };
  return { calls, run };
}

test("verifies exact official index and ARM64 source before both release signatures", () => {
  const { calls, run } = runner();
  const result = verifyObjectStoreImage(run);
  assert.equal(result.ref, OBJECT_STORE_REF);
  assert.deepEqual(
    result.signatures.map((value) => value.digest),
    [OBJECT_STORE_IMAGE.digest, OBJECT_STORE_IMAGE.arm64Digest],
  );
  assert.equal(calls.length, 4);
  for (const call of calls.filter((entry) => entry.command === "cosign")) {
    assert.deepEqual(call.args.slice(0, 7), [
      "verify",
      "--certificate-identity",
      "https://github.com/seaweedfs/seaweedfs/.github/workflows/container_release_unified.yml@refs/tags/4.47",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--output",
      "json",
    ]);
    assert.equal(call.args.length, 8);
  }
});

test("rejects changed index bytes before another external command", () => {
  const { calls, run } = runner({ index: index + "\n" });
  assert.throws(() => verifyObjectStoreImage(run), /index bytes/);
  assert.equal(calls.length, 1);
});

for (const [name, change] of [
  ["platform", { ...runtime, architecture: "amd64" }],
  [
    "source",
    {
      ...runtime,
      config: {
        Labels: {
          ...runtime.config.Labels,
          "org.opencontainers.image.source": "https://example.com",
        },
      },
    },
  ],
  [
    "revision",
    {
      ...runtime,
      config: {
        Labels: { ...runtime.config.Labels, "org.opencontainers.image.revision": "0".repeat(40) },
      },
    },
  ],
  [
    "version",
    {
      ...runtime,
      config: {
        Labels: { ...runtime.config.Labels, "org.opencontainers.image.version": "latest" },
      },
    },
  ],
]) {
  test(`rejects unreviewed runtime ${name}`, () => {
    const { calls, run } = runner({ runtime: change });
    assert.throws(() => verifyObjectStoreImage(run), /source identity/);
    assert.equal(calls.length, 2);
  });
}

for (const digest of [OBJECT_STORE_IMAGE.digest, OBJECT_STORE_IMAGE.arm64Digest]) {
  test(`propagates signature verification failure for ${digest}`, () => {
    const { run } = runner({ failSignature: digest });
    assert.throws(() => verifyObjectStoreImage(run), /Signature verification failed/);
  });
}
for (const invalid of [
  [],
  {},
  signature("sha256:" + "0".repeat(64)),
  [
    {
      critical: {
        type: "unexpected",
        image: { "docker-manifest-digest": OBJECT_STORE_IMAGE.digest },
      },
    },
  ],
]) {
  test(`rejects empty or mismatched signature evidence ${JSON.stringify(invalid)}`, () => {
    assert.throws(
      () => verifyObjectStoreImage(runner({ signatures: invalid }).run),
      /signature output/,
    );
  });
}
