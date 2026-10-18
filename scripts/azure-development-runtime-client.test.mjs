import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  admitRuntimeClientAccess,
  admitRuntimeClientCertificate,
  runtimeClientDeadline,
  runtimeClientEnvironment,
} from "./azure-development-runtime-client.mjs";
import { clientCertificateFixture } from "./azure-development-runtime-client-fixture.mjs";
import { openRuntimeDocker } from "./azure-development-runtime-docker.mjs";
import { runtimeDriverFixture } from "./azure-development-runtime-fixture.mjs";
import { openRuntimeJournal, readRuntimeJournal } from "./azure-development-runtime-journal.mjs";
import { observeRuntimeContainer } from "./azure-development-runtime-ownership.mjs";

const start = Math.ceil(Date.now() / 1000) * 1000 + 60_000;
const access = {
  adminIpv4Cidr: "8.8.8.8/32",
  notBeforeUtc: new Date(start).toISOString(),
  notAfterUtc: new Date(start + 900_000).toISOString(),
};
const apiDeadlineNs = (process.hrtime.bigint() + 960_000_000_000n).toString();

test("client selection requires explicit null or one exact finite administrator window", () => {
  assert.equal(admitRuntimeClientAccess(null), null);
  assert.deepEqual(admitRuntimeClientAccess(access), access);
  for (const value of [
    undefined,
    {},
    { ...access, extra: true },
    { ...access, adminIpv4Cidr: "10.1.2.3/32" },
    { ...access, adminIpv4Cidr: "8.8.8.8/24" },
    { ...access, notAfterUtc: new Date(start + 901_000).toISOString() },
    { ...access, notAfterUtc: new Date(start + 59_000).toISOString() },
  ])
    assert.throws(() => admitRuntimeClientAccess(value));
  const original = {
    startedAtUtc: new Date(start - 60_000).toISOString(),
    monotonicStartNs: "1000000000",
    notAfterUtc: new Date(start + 3_600_000).toISOString(),
  };
  assert.equal(runtimeClientDeadline(access, original), "946000000000");
  assert.equal(runtimeClientDeadline(access, original), runtimeClientDeadline(access, original));
  assert.throws(() =>
    runtimeClientDeadline(access, { ...original, notAfterUtc: access.notAfterUtc }),
  );
  const env = runtimeClientEnvironment(access, apiDeadlineNs);
  assert.equal(Date.parse(env.RUNTIME_API_END), start + 885_000);
  assert.equal(Number(env.RUNTIME_CLIENT_END), (start + 870_000) / 1000);
});

test("actual offline public Compose variant binds one port and records ten exact owned identities", async (t) => {
  const f = await runtimeDriverFixture(t, { clientAccess: access, apiDeadlineNs });
  const created = await f.driver.create();
  assert.equal(Object.keys(created).length, 10);
  assert.equal(Object.values(f.model.services).filter((service) => service.ports).length, 1);
  assert.deepEqual(f.model.services["client-edge"].ports, [
    { mode: "ingress", host_ip: "0.0.0.0", target: 8443, published: "443", protocol: "tcp" },
  ]);
  for (const name of ["api", "worker", "client-edge"]) await f.driver.start(name);
  await f.driver.stop();
  assert.deepEqual(f.stops, ["client-edge", "api", "worker"]);
  const journal = await readRuntimeJournal(f.directory, "a".repeat(64));
  assert.equal(
    Object.keys(journal.records.find((row) => row.event.phase === "created").event.contracts)
      .length,
    10,
  );
});

test("refused edge stop still attempts every remaining known owned service and retains failure", async (t) => {
  const f = await runtimeDriverFixture(t, {
    clientAccess: access,
    apiDeadlineNs,
    stopFailure: "client-edge",
  });
  await f.driver.create();
  for (const name of ["api", "worker", "client-edge"]) await f.driver.start(name);
  await assert.rejects(f.driver.stop(), AggregateError);
  assert.deepEqual(f.stops, ["client-edge", "api", "worker"]);
  assert.equal(f.containers["client-edge"].State.Running, true);
  assert.equal(f.containers.api.State.Running, false);
  assert.equal(f.containers.worker.State.Running, false);
});

test("public recovery uses the conserved model without configuration reads and closes edge first", async (t) => {
  const f = await runtimeDriverFixture(t, { clientAccess: access, apiDeadlineNs });
  await f.driver.create();
  for (const name of ["api", "worker", "client-edge"]) await f.driver.start(name);
  const original = await readRuntimeJournal(f.directory, "a".repeat(64));
  const directory = join(f.root, "client-recovery");
  await mkdir(directory, { mode: 0o700 });
  const journal = await openRuntimeJournal(directory);
  t.after(() => journal.close());
  await journal.publish({ phase: "admitted", inputSha256: "a".repeat(64) });
  f.useStopEvidence(directory, "a".repeat(64));
  const before = f.calls.length;
  const driver = await openRuntimeDocker(
    {
      ...f.driverInput,
      journal,
      recovery: {
        model: f.model,
        createdRecord: original.records.find((row) => row.event.phase === "created").event,
      },
    },
    f.execute,
  );
  assert.equal(f.calls.length, before);
  await driver.stop();
  assert.deepEqual(f.stops, ["client-edge", "api", "worker"]);
  assert(!f.calls.slice(before).some((args) => args.includes("compose") || args.includes("start")));
});

test("held public certificate requires the fixed hostname and validity through the original window", () => {
  // Signature is deliberately invalid; this proves parser admission only, never TLS trust.
  admitRuntimeClientCertificate(clientCertificateFixture(), access);
  for (const pem of [
    "invalid",
    clientCertificateFixture({ host: "other.example.invalid" }),
    clientCertificateFixture({ notAfter: "260101000000Z" }),
    clientCertificateFixture({ notBefore: "350101000000Z" }),
  ])
    assert.throws(() => admitRuntimeClientCertificate(pem, access));
});

test("Caddy image-declared ports remain unpublished while only the fixed IPv4 binding is admitted", async (t) => {
  const f = await runtimeDriverFixture(t, { clientAccess: access, apiDeadlineNs });
  const row = f.containers["client-edge"],
    contract = f.contracts["client-edge"];
  assert.deepEqual(Object.keys(contract.image.Config.ExposedPorts).sort(), [
    "2019/tcp",
    "443/tcp",
    "443/udp",
    "80/tcp",
  ]);
  observeRuntimeContainer(row, contract);
  await f.driver.create();
  await f.driver.start("client-edge");
  observeRuntimeContainer(row, contract);
  for (const mutate of [
    (value) => {
      value.NetworkSettings.Ports["443/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "444" }];
    },
    (value) => {
      value.NetworkSettings.Ports["1234/tcp"] = null;
    },
    (value) => {
      value.NetworkSettings.Ports["8443/tcp"][0].HostIp = "::";
    },
    (value) => {
      value.HostConfig.PortBindings["8443/tcp"][0].HostPort = "444";
    },
  ]) {
    const changed = structuredClone(row);
    mutate(changed);
    assert.throws(() => observeRuntimeContainer(changed, contract));
  }
  await f.driver.stop();
});

test("wrong-host held leaf refuses the complete controller before native creation or observation", async (t) => {
  const { runtimeRunFixture } = await import("./azure-development-runtime-run-fixture.mjs");
  const { runPreparedDevelopmentRuntime } = await import("./azure-development-runtime-run.mjs");
  const f = await runtimeRunFixture(t, {
    clientAccess: access,
    apiDeadlineNs,
    clientCertificateOptions: { host: "other.example.invalid" },
  });
  await assert.rejects(runPreparedDevelopmentRuntime(f.args, f.execution));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
  assert(f.prepared.opened.every((file) => file.closed));
});

test("cancelled public work cannot reopen the edge and still closes all owned identities", async (t) => {
  const f = await runtimeDriverFixture(t, { clientAccess: access, apiDeadlineNs });
  await f.driver.create();
  for (const name of ["api", "worker", "client-edge"]) await f.driver.start(name);
  f.controller.abort();
  await assert.rejects(f.driver.start("client-edge"));
  await f.driver.stop();
  assert.deepEqual(f.stops, ["client-edge", "api", "worker"]);
});
