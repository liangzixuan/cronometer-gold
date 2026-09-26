import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { OBJECT_STORE_REF } from "./verify-local-object-store-image.mjs";
import { verifyPatchedObjectStoreImage } from "./verify-patched-object-store-image.mjs";

// Qualified by the original trusted build; consumer and pull-request revisions differ.
export const CI_OBJECT_STORE = Object.freeze({
  imageRef:
    "ghcr.io/liangzixuan/cronometer-gold-object-store@sha256:f936639ab401e5ba291eebdc8eae421c382faee0c971e71e0a9dba94e7c08c2e",
  runtimeRef:
    "ghcr.io/liangzixuan/cronometer-gold-object-store@sha256:bb59c87fd41a196d75ad6ce789d9dfeeea54845910f31250fbfd2984f216ca30",
  configDigest: "sha256:f7e1acdf8387e17e542efb5cdd3343b0dcd15df247cc6ddd2e1660e14479e080",
  revision: "e109b1ea70720a186c35d13e9fe4fedba93759e1",
  workflowSha: "e109b1ea70720a186c35d13e9fe4fedba93759e1",
  sourceRef: "refs/heads/codex/retention-features",
});
const composeFile = "infra/docker/compose.yml";

export function assertCiObjectStoreContext(context) {
  assert.equal(context.GITHUB_ACTIONS, "true", "Patched fixture is CI-only.");
  assert.ok(["push", "pull_request"].includes(context.GITHUB_EVENT_NAME));
  assert.equal(context.GITHUB_REPOSITORY, "liangzixuan/cronometer-gold");
  assert.match(context.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
}

export function assertCiObjectStoreVerification(result) {
  assert.equal(result?.ref, CI_OBJECT_STORE.imageRef);
  assert.equal(result.runtimeRef, CI_OBJECT_STORE.runtimeRef);
  assert.equal(result.runtimeDigest, CI_OBJECT_STORE.runtimeRef.split("@")[1]);
  assert.equal(result.revision, CI_OBJECT_STORE.revision);
  assert.match(result.binarySha256 ?? "", /^[a-f0-9]{64}$/u);
  return result;
}

export function verifyCiObjectStoreImage(verify = verifyPatchedObjectStoreImage) {
  return assertCiObjectStoreVerification(
    verify({
      mode: "verify",
      imageRef: CI_OBJECT_STORE.imageRef,
      revision: CI_OBJECT_STORE.revision,
      workflowSha: CI_OBJECT_STORE.workflowSha,
      sourceRef: CI_OBJECT_STORE.sourceRef,
    }),
  );
}

export function objectStoreOverride(imageRef = CI_OBJECT_STORE.imageRef) {
  assert.equal(imageRef, CI_OBJECT_STORE.imageRef);
  return { services: { "object-store": { image: imageRef } } };
}

export function assertCiObjectStoreTopology(base, merged, imageRef = CI_OBJECT_STORE.imageRef) {
  assert.equal(imageRef, CI_OBJECT_STORE.imageRef);
  assert.equal(base.services?.["object-store"]?.image, OBJECT_STORE_REF);
  const expected = structuredClone(base);
  expected.services["object-store"].image = imageRef;
  assert.deepEqual(merged, expected, "The CI override may change only the object-store image.");
}

export function assertCiObjectStoreProcess(container, image, project, status) {
  assert.equal(image.Id, CI_OBJECT_STORE.configDigest);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "arm64");
  assert.ok(image.RepoDigests?.includes(CI_OBJECT_STORE.imageRef));
  assert.equal(container.Config?.Image, CI_OBJECT_STORE.imageRef);
  assert.equal(container.Image, image.Id);
  assert.equal(container.Config?.Labels?.["com.docker.compose.service"], "object-store");
  assert.equal(container.Config?.Labels?.["com.docker.compose.project"], project);
  assert.equal(container.State?.Running, true);
  for (const field of ["Uid", "Gid"]) {
    const rows = status.split("\n").filter((line) => line.startsWith(`${field}:`));
    assert.equal(rows.length, 1);
    assert.match(rows[0], new RegExp(`^${field}:\\s+1000\\s+1000\\s+1000\\s+1000\\s*$`, "u"));
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("CI object-store inspection failed.");
  return result.stdout;
}

export function writeCiObjectStoreOverride(path, imageRef = CI_OBJECT_STORE.imageRef) {
  const content = objectStoreOverride(imageRef);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(content)}\n`);
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    assert.equal(process.argv.length, 3);
    assert.ok(["verify", "prepare", "runtime"].includes(action));
    assertCiObjectStoreContext(process.env);
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "arm64");
    if (action === "verify") {
      process.stdout.write(`${JSON.stringify(verifyCiObjectStoreImage(), null, 2)}\n`);
    } else {
      assert.ok(process.env.RUNNER_TEMP);
      const override = resolve(process.env.RUNNER_TEMP, "patched-object-store.compose.json");
      const receipt = resolve(process.env.RUNNER_TEMP, "object-store-provenance.json");
      assertCiObjectStoreVerification(JSON.parse(readFileSync(receipt, "utf8")));
      const compose = ["compose", "-f", composeFile];
      const base = JSON.parse(capture("docker", [...compose, "config", "--format", "json"]));
      if (action === "prepare") writeCiObjectStoreOverride(override);
      assert.deepEqual(JSON.parse(readFileSync(override, "utf8")), objectStoreOverride());
      const scoped = [...compose, "-f", override];
      const merged = JSON.parse(capture("docker", [...scoped, "config", "--format", "json"]));
      assertCiObjectStoreTopology(base, merged);
      if (action === "runtime") {
        const id = capture("docker", [...scoped, "ps", "--quiet", "object-store"]).trim();
        assert.match(id, /^[a-f0-9]{64}$/u);
        const containers = JSON.parse(capture("docker", ["inspect", id]));
        assert.equal(containers.length, 1);
        assert.equal(containers[0].Id, id);
        // Compose pulled the index reference; no separate local child reference is assumed.
        const images = JSON.parse(
          capture("docker", ["image", "inspect", CI_OBJECT_STORE.imageRef]),
        );
        assert.equal(images.length, 1);
        const status = capture("docker", ["exec", id, "cat", "/proc/1/status"]);
        assertCiObjectStoreProcess(containers[0], images[0], base.name, status);
      }
      process.stdout.write(`CI object-store ${action} passed.\n`);
    }
  } catch {
    process.stderr.write(
      "CI object-store boundary verification failed; private inputs were not printed.\n",
    );
    process.exitCode = 1;
  }
}
