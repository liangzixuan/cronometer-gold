import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCiObjectStoreContext,
  assertCiObjectStoreProcess,
  assertCiObjectStoreTopology,
  assertCiObjectStoreVerification,
  CI_OBJECT_STORE,
  objectStoreOverride,
  verifyCiObjectStoreImage,
  writeCiObjectStoreOverride,
} from "./prepare-ci-object-store.mjs";
import { OBJECT_STORE_REF } from "./verify-local-object-store-image.mjs";

const imageRef = CI_OBJECT_STORE.imageRef;
const imageId = CI_OBJECT_STORE.configDigest;
const image = {
  Id: imageId,
  Os: "linux",
  Architecture: "arm64",
  RepoDigests: [imageRef],
};
const verification = {
  ref: imageRef,
  runtimeRef: CI_OBJECT_STORE.runtimeRef,
  runtimeDigest: CI_OBJECT_STORE.runtimeRef.split("@")[1],
  revision: CI_OBJECT_STORE.revision,
  binarySha256: "b".repeat(64),
};
const context = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "liangzixuan/cronometer-gold",
  GITHUB_REF: "refs/heads/codex/retention-features",
  GITHUB_SHA: "c".repeat(40),
  GITHUB_WORKFLOW_SHA: "c".repeat(40),
};
const base = {
  name: "nutrition-tracker",
  services: {
    "object-store": {
      image: OBJECT_STORE_REF,
      ports: [{ host_ip: "127.0.0.1", published: "9000" }],
      volumes: [{ read_only: true, bind: { create_host_path: false } }],
    },
    postgres: { image: "unchanged", ports: [{ host_ip: "127.0.0.1" }] },
  },
  volumes: { "object-store": {} },
};
const merged = structuredClone(base);
merged.services["object-store"].image = imageRef;
const container = {
  Config: {
    Image: imageRef,
    Labels: {
      "com.docker.compose.service": "object-store",
      "com.docker.compose.project": base.name,
    },
  },
  Image: imageId,
  State: { Running: true },
};
const status = "Name:\tweed\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";

test("CI override is only an immutable image and preserves every other rendered field", () => {
  assertCiObjectStoreContext(context);
  assert.deepEqual(objectStoreOverride(imageRef), {
    services: { "object-store": { image: imageRef } },
  });
  assertCiObjectStoreTopology(base, merged, imageRef);
  assertCiObjectStoreProcess(container, image, base.name, status);
});
for (const [field, value] of [
  ["GITHUB_ACTIONS", "false"],
  ["GITHUB_EVENT_NAME", "workflow_dispatch"],
  ["GITHUB_REPOSITORY", "attacker/fork"],
  ["GITHUB_SHA", "abc"],
])
  test(`rejects unapproved CI context ${field}`, () =>
    assert.throws(() => assertCiObjectStoreContext({ ...context, [field]: value })));
for (const value of [
  "ghcr.io/liangzixuan/cronometer-gold-object-store:latest",
  imageRef.replace("liangzixuan", "attacker"),
  `${imageRef}\nservices: {}`,
  imageRef.replace("@sha256:", ":tag@sha256:"),
]) {
  test(`rejects noncanonical image reference ${JSON.stringify(value)}`, () =>
    assert.throws(() => objectStoreOverride(value)));
}
for (const [name, mutate] of [
  [
    "public port",
    (copy) => {
      copy.services["object-store"].ports[0].host_ip = "0.0.0.0";
    },
  ],
  [
    "writable credentials",
    (copy) => {
      copy.services["object-store"].volumes[0].read_only = false;
    },
  ],
  [
    "different companion",
    (copy) => {
      copy.services.postgres.image = "changed";
    },
  ],
  [
    "new entrypoint",
    (copy) => {
      copy.services["object-store"].entrypoint = "sh";
    },
  ],
  [
    "removed volume",
    (copy) => {
      delete copy.volumes;
    },
  ],
])
  test(`rejects extra override: ${name}`, () => {
    const copy = structuredClone(merged);
    mutate(copy);
    assert.throws(() => assertCiObjectStoreTopology(base, copy, imageRef));
  });
for (const [name, mutate] of [
  [
    "wrong image",
    (copy) => {
      copy.Image = `sha256:${"e".repeat(64)}`;
    },
  ],
  [
    "wrong reference",
    (copy) => {
      copy.Config.Image = "mutable:tag";
    },
  ],
  [
    "wrong project",
    (copy) => {
      copy.Config.Labels["com.docker.compose.project"] = "other";
    },
  ],
  [
    "wrong service",
    (copy) => {
      copy.Config.Labels["com.docker.compose.service"] = "postgres";
    },
  ],
  [
    "stopped",
    (copy) => {
      copy.State.Running = false;
    },
  ],
])
  test(`rejects unsafe process: ${name}`, () => {
    const copy = structuredClone(container);
    mutate(copy);
    assert.throws(() => assertCiObjectStoreProcess(copy, image, base.name, status));
  });
for (const unsafe of [
  status.replace("Uid:\t1000", "Uid:\t0"),
  status.replace("Gid:\t1000", "Gid:\t0"),
  `${status}Uid:\t1000\t1000\t1000\t1000\n`,
  status.replace(/^Gid:.*\n/mu, ""),
]) {
  test(`rejects incorrect runtime UID/GID ${JSON.stringify(unsafe)}`, () =>
    assert.throws(() => assertCiObjectStoreProcess(container, image, base.name, unsafe)));
}
test("override is exclusively created owner-private and never replaces a file or link", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-storage-override-"));
  try {
    const path = join(directory, "override.json");
    writeCiObjectStoreOverride(path, imageRef);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), objectStoreOverride(imageRef));
    assert.throws(() => writeCiObjectStoreOverride(path, imageRef));
    symlinkSync(path, join(directory, "link"));
    assert.throws(() => writeCiObjectStoreOverride(join(directory, "link"), imageRef));
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("read-only push and fork-PR consumers retain the original qualified build identity", () => {
  for (const event of ["push", "pull_request"]) {
    assertCiObjectStoreContext({
      ...context,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: event === "push" ? "refs/heads/review" : "refs/pull/123/merge",
      GITHUB_SHA: "d".repeat(40),
      GITHUB_WORKFLOW_SHA: "e".repeat(40),
      GITHUB_HEAD_REF: "contributor-change",
    });
  }
  let called = false;
  assert.equal(
    verifyCiObjectStoreImage((options) => {
      called = true;
      assert.deepEqual(options, {
        mode: "verify",
        imageRef,
        revision: "e109b1ea70720a186c35d13e9fe4fedba93759e1",
        workflowSha: "e109b1ea70720a186c35d13e9fe4fedba93759e1",
        sourceRef: "refs/heads/codex/retention-features",
      });
      return verification;
    }),
    verification,
  );
  assert.equal(called, true);
  assert.throws(
    () =>
      verifyCiObjectStoreImage(() => {
        throw new Error("signature failed");
      }),
    /signature failed/,
  );
});

test("verification receipts must retain the qualified index, runtime, source and binary identity", () => {
  assert.equal(assertCiObjectStoreVerification(verification), verification);
  for (const key of ["ref", "runtimeRef", "runtimeDigest", "revision", "binarySha256"]) {
    assert.throws(() => assertCiObjectStoreVerification({ ...verification, [key]: "changed" }));
    const missing = { ...verification };
    delete missing[key];
    assert.throws(() => assertCiObjectStoreVerification(missing));
  }
  assert.throws(() =>
    verifyCiObjectStoreImage(() => ({ ...verification, revision: context.GITHUB_SHA })),
  );
});

test("inspection must resolve the qualified index to its exact native runtime config", () => {
  for (const [key, value] of [
    ["Id", `sha256:${"0".repeat(64)}`],
    ["Architecture", "amd64"],
    ["Os", "windows"],
    ["RepoDigests", [CI_OBJECT_STORE.runtimeRef]],
  ]) {
    assert.throws(() =>
      assertCiObjectStoreProcess(container, { ...image, [key]: value }, base.name, status),
    );
  }
  assert.throws(() => objectStoreOverride(imageRef.replace(/.$/, "0")));
});
