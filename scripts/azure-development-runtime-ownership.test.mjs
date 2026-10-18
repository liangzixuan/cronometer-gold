import assert from "node:assert/strict";
import test from "node:test";
import { runtimeDockerFixture as fixture, project } from "./azure-development-runtime-fixture.mjs";
import {
  observeRuntimeContainer,
  observeRuntimeNetwork,
  requireSameRuntimeContainer,
} from "./azure-development-runtime-ownership.mjs";

test("real Compose model admits nine created observations and pins full identity before any start", async (t) => {
  const f = await fixture(t);
  const recorded = [];
  for (const [name, row] of Object.entries(f.containers)) {
    const result = observeRuntimeContainer(row, f.contracts[name]);
    assert.equal(result.service, name);
    assert.equal(result.status, "created");
    assert.equal(result.identity.length, 64);
    recorded.push(result.id);
  }
  assert.equal(new Set(recorded).size, 9);
});

test("running process/health/address observations change without relaxing immutable container identity", async (t) => {
  const f = await fixture(t),
    row = f.containers.api,
    contract = f.contracts.api;
  const recorded = observeRuntimeContainer(row, contract);
  row.State = { ...row.State, Status: "running", Running: true, Health: { Status: "healthy" } };
  for (const [name, network] of Object.entries(row.NetworkSettings.Networks)) {
    const key = name.slice(project.length + 1);
    network.IPAddress = contract.service.networks[key].ipv4_address;
  }
  const current = requireSameRuntimeContainer(row, contract, recorded);
  assert.equal(current.status, "running");
  assert.equal(current.healthy, true);
  assert.equal(current.addresses.backend, "172.28.0.5");
});

test("wrong target, image, source, env, namespace, mount, privilege or public port cannot become an owned container", async (t) => {
  const f = await fixture(t);
  const vectors = [
    (row) => {
      row.Image = `sha256:${"c".repeat(64)}`;
    },
    (row) => {
      row.Config.Labels["io.nourishing.runtime.owner"] = "22222222-2222-4222-8222-222222222222";
    },
    (row) => {
      row.Config.Labels["io.nourishing.runtime.revision"] = "c".repeat(40);
    },
    (row) => {
      row.Config.Env.push("UNEXPECTED_INPUT=synthetic");
    },
    (row) => {
      row.Config.Cmd = ["node", "dist/unowned.js"];
    },
    (row) => {
      row.Args = ["dist/unowned.js"];
    },
    (row) => {
      row.HostConfig.Privileged = true;
    },
    (row) => {
      row.HostConfig.PortBindings = { "4000/tcp": [{ HostIp: "0.0.0.0", HostPort: "4000" }] };
    },
    (row) => {
      row.Mounts[0].Source = "/unowned/ca.crt";
    },
    (row) => {
      row.Mounts[0].RW = true;
    },
    (row) => {
      row.HostConfig.NetworkMode = "host";
    },
    (row) => {
      row.NetworkSettings.Networks.unowned = {
        NetworkID: "c".repeat(64),
        IPAddress: "172.21.0.3",
        GlobalIPv6Address: "",
      };
    },
    (row) => {
      row.Config.Healthcheck.Test = ["CMD", "node", "-e", "process.exit(0)"];
    },
    (row) => {
      row.HostConfig.ReadonlyRootfs = false;
    },
    (row) => {
      row.NetworkSettings.Ports["4000/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "4000" }];
    },
  ];
  for (const mutate of vectors) {
    const row = structuredClone(f.containers.api);
    mutate(row);
    assert.throws(() => observeRuntimeContainer(row, f.contracts.api));
  }
  const issuer = structuredClone(f.containers["search-bootstrap"]);
  issuer.HostConfig.NetworkMode = `container:${"e".repeat(64)}`;
  assert.throws(() => observeRuntimeContainer(issuer, f.contracts["search-bootstrap"]));
});

test("even an otherwise policy-valid replacement ID or newly injected HostConfig field cannot pass a recorded readback", async (t) => {
  const f = await fixture(t),
    recorded = observeRuntimeContainer(f.containers.api, f.contracts.api);
  for (const mutate of [
    (row) => {
      row.Id = "e".repeat(64);
    },
    (row) => {
      row.HostConfig.UnreviewedSetting = true;
    },
    (row) => {
      row.Config.Labels.extra = "changed";
    },
  ]) {
    const row = structuredClone(f.containers.api);
    mutate(row);
    assert.throws(() => requireSameRuntimeContainer(row, f.contracts.api, recorded));
  }
});

test("public or substituted networks cannot qualify a created private dependency", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (row) => {
      row.Internal = false;
    },
    (row) => {
      row.Driver = "host";
    },
    (row) => {
      row.Name = "unowned_backend";
    },
    (row) => {
      row.EnableIPv6 = true;
    },
    (row) => {
      row.IPAM.Config[0].Subnet = "8.8.8.0/24";
    },
  ]) {
    const row = structuredClone(f.rawNetworks.backend);
    mutate(row);
    assert.throws(() => observeRuntimeNetwork(row, { project, name: "backend", internal: true }));
  }
});

test("an owned container cannot use another private address in its prepared host network", async (t) => {
  const f = await fixture(t),
    row = f.containers.api;
  row.State = { ...row.State, Status: "running", Running: true };
  for (const [name, network] of Object.entries(row.NetworkSettings.Networks)) {
    const key = name.slice(project.length + 1);
    network.IPAddress = f.contracts.api.service.networks[key].ipv4_address;
  }
  assert.doesNotThrow(() => observeRuntimeContainer(row, f.contracts.api));
  row.NetworkSettings.Networks[`${project}_backend`].IPAddress = "172.28.0.99";
  assert.throws(() => observeRuntimeContainer(row, f.contracts.api));
});

test("another RFC1918 subnet or gateway cannot satisfy the prepared native DNS contract", async (t) => {
  const f = await fixture(t);
  for (const mutation of ["Subnet", "Gateway"]) {
    const row = structuredClone(f.rawNetworks.backend);
    row.IPAM.Config[0][mutation] = mutation === "Subnet" ? "172.27.0.0/24" : "172.27.0.1";
    assert.throws(() => observeRuntimeNetwork(row, { project, name: "backend", internal: true }));
  }
});
