import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const sha = (value) => createHash("sha256").update(value).digest("hex");

import { fixture } from "./azure-development-runtime-images-fixture.mjs";

test("seven captured observations invoke actual backend and Mailpit validators with no acquisition or provenance claim", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.kind, "nutrition-development-seven-local-images-v1");
  assert.equal(Object.keys(result.imageObservations).length, 7);
  assert.equal(result.provenanceQualified, false);
  assert.equal(result.operationalAcceptance, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.observations.length, 2);
  assert(
    f.calls[0].includes("inspect") &&
      !f.calls.some(
        (args) => args.includes("pull") || args.includes("build") || args.includes("create"),
      ),
  );
});
test("actual maintained backend validator refuses changed source, process, runtime labels and environment", async () => {
  for (const mutate of [
    (f) => {
      f.rows[0].Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
    },
    (f) => {
      f.rows[1].Config.Cmd = ["/bin/false"];
    },
    (f) => {
      f.rows[3].Config.Labels["io.cronometer.upstream.version"] = "v0.0.0";
    },
    (f) => {
      f.rows[4].Config.User = "0:0";
    },
    (f) => {
      f.rows[5].Config.Env.push("MEILI_MASTER_KEY=synthetic-unexpected-image-key");
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.run(), /Prepared local runtime image admission failed/u);
    assert.equal(f.calls.length, 2);
  }
});
test("Mailpit runtime identity uses actual reviewed source lock and refuses a substituted capture entrypoint", async () => {
  const f = fixture();
  f.rows[6].Config.Entrypoint = ["/bin/false"];
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 1);
});
test("missing/extra identities, wrong reference, architecture or duplicate native IDs refuse before backend execution", async () => {
  for (const mutate of [
    (f) => {
      f.rows.pop();
    },
    (f) => {
      f.rows.push(structuredClone(f.rows[0]));
    },
    (f) => {
      f.rows[0].RepoDigests = ["unrelated.invalid/image@sha256:" + "a".repeat(64)];
    },
    (f) => {
      f.rows[0].Architecture = "amd64";
    },
    (f) => {
      f.rows[1].Id = f.rows[0].Id;
    },
    (f) => {
      f.input.images.WEB_IMAGE = "ghcr.io/liangzixuan/cronometer-gold-web@sha256:" + "a".repeat(64);
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.run());
    assert(f.calls.length <= 1);
  }
});
test("raw output integrity, held-input conservation, forged receipt and cancellation cannot admit images", async () => {
  for (const options of [
    { malformed: true },
    { wrongDigest: true },
    { breakConservation: true },
    { forgedReceipt: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run());
  }
  const f = fixture();
  f.controller.abort();
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
});

test("an actual rejected backend command retains bounded diagnostics without claiming stdout or completion", async () => {
  const f = fixture();
  f.rows[0].Config.Labels["org.opencontainers.image.revision"] = "b".repeat(40);
  await assert.rejects(f.run(), /Prepared local runtime image admission failed/u);
  assert.equal(f.calls.length, 2);
  assert.equal(f.observations.length, 2);
  const [docker, rejected] = f.observations;
  assert.equal(docker.completed, true);
  assert.equal(rejected.phase, "runtime-image-observation-unconfirmed");
  assert.equal(rejected.completed, false);
  assert.equal(rejected.stdoutAvailable, false);
  assert.equal(rejected.stdout, undefined);
  const stderr = Buffer.from(rejected.stderr, "base64");
  assert(stderr.length > 0 && stderr.length <= 65_536);
  assert.equal(rejected.stderrBytes, stderr.length);
  assert.equal(rejected.stderrSha256, sha(stderr));
  assert.equal(new Date(rejected.startedAtUtc).toISOString(), rejected.startedAtUtc);
  assert.equal(new Date(rejected.endedAtUtc).toISOString(), rejected.endedAtUtc);
  assert(Date.parse(rejected.endedAtUtc) >= Date.parse(rejected.startedAtUtc));
});

test("post-command conservation failure retains its actual attempted observation", async () => {
  const f = fixture({ breakConservation: true });
  await assert.rejects(f.run());
  assert.equal(f.calls.length, 1);
  assert.equal(f.observations.length, 1);
  const row = f.observations[0];
  assert.equal(row.phase, "runtime-image-observation-unconfirmed");
  assert.equal(row.completed, false);
  assert.equal(row.stdoutAvailable, true);
  assert.equal(row.stdoutIntegrityVerified, true);
  assert.equal(sha(row.stdout), row.stdoutSha256);
  assert.equal(JSON.parse(row.stdout).length, 7);
  assert.deepEqual(row.command, f.calls[0]);
});
