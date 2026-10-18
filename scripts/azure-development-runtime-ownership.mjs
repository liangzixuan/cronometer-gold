import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson } from "../packages/contracts/dist/index.js";

const hash = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const identifier = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (left, right) => assert.equal(canonicalJson(left), canonicalJson(right));
const empty = (value) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value)
    ? value.length === 0
    : typeof value === "object" && Object.keys(value).length === 0);
const privateAddress = (value) =>
  typeof value === "string" &&
  isIP(value) === 4 &&
  (/^10\./u.test(value) ||
    /^192\.168\./u.test(value) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./u.test(value));
const durations = new Map([
  ["5s", 5_000_000_000],
  ["10s", 10_000_000_000],
  ["15s", 15_000_000_000],
  ["30s", 30_000_000_000],
]);
function environment(entries) {
  assert(Array.isArray(entries) && entries.length <= 256);
  const value = {};
  for (const entry of entries) {
    assert(typeof entry === "string");
    const at = entry.indexOf("=");
    assert(at > 0 && /^[A-Z][A-Z0-9_]*$/u.test(entry.slice(0, at)));
    const name = entry.slice(0, at);
    assert(!Object.hasOwn(value, name));
    value[name] = entry.slice(at + 1);
  }
  return value;
}
function health(observed, service, image) {
  if (!service.healthcheck) {
    exact(observed ?? null, image.Config.Healthcheck ?? null);
    return;
  }
  const expected = service.healthcheck;
  exact(observed?.Test, expected.test);
  for (const [field, key] of [
    ["Interval", "interval"],
    ["Timeout", "timeout"],
    ["StartPeriod", "start_period"],
  ]) {
    if (expected[key] !== undefined) assert(durations.has(expected[key]));
    assert.equal(
      observed[field] ?? 0,
      expected[key] === undefined ? 0 : durations.get(expected[key]),
    );
  }
  assert.equal(observed.Retries, expected.retries);
  assert.equal(observed.StartInterval ?? 0, 0);
}

/** Admit the complete initial Docker observation against the actual resolved fixed Compose model.
 * All future start/stop/probe observations must retain its immutable digest. */
export function observeRuntimeContainer(observation, contract) {
  const row = structuredClone(observation),
    c = structuredClone(contract);
  const { serviceName, service, image, project, owner, revision, networks, relatedIds = {} } = c;
  assert(/^[a-z][a-z0-9-]{0,31}$/u.test(serviceName));
  assert(/^[a-z][a-z0-9-]{0,62}$/u.test(project));
  assert(/^[a-f0-9-]{36}$/u.test(owner) && /^[a-f0-9]{40}$/u.test(revision));
  assert(identifier(row.Id) && identifier(image.Id?.slice(7)) && row.Image === image.Id);
  assert(row.Config.Image === service.image && (image.RepoDigests ?? []).includes(service.image));
  assert(row.Platform === "linux" && image.Os === "linux" && image.Architecture === "arm64");
  assert(typeof row.Created === "string" && Number.isFinite(Date.parse(row.Created)));
  assert(
    row.RestartCount === 0 &&
      row.State &&
      ["created", "running", "exited"].includes(row.State.Status),
  );
  assert(
    row.State.Running === (row.State.Status === "running") &&
      row.State.Paused === false &&
      row.State.Dead === false,
  );
  const labels = row.Config.Labels;
  assert(
    labels?.["com.docker.compose.project"] === project &&
      labels["com.docker.compose.service"] === serviceName &&
      labels["com.docker.compose.oneoff"] === "False" &&
      labels["io.nourishing.runtime.owner"] === owner &&
      labels["io.nourishing.runtime.revision"] === revision,
  );
  exact(row.Config.Cmd ?? null, service.command ?? image.Config.Cmd ?? null);
  exact(row.Config.Entrypoint ?? null, service.entrypoint ?? image.Config.Entrypoint ?? null);
  const command = [...(row.Config.Entrypoint ?? []), ...(row.Config.Cmd ?? [])];
  assert(command.length > 0 && row.Path === command[0]);
  exact(row.Args, command.slice(1));
  assert.equal(
    row.Config.StopSignal ?? null,
    service.stop_signal ?? image.Config.StopSignal ?? null,
  );
  assert.equal(row.Config.User, service.user);
  assert.equal(row.Config.WorkingDir, service.working_dir ?? image.Config.WorkingDir ?? "");
  assert(
    row.Config.Tty === false && row.Config.OpenStdin === false && row.Config.StdinOnce === false,
  );
  exact(environment(row.Config.Env), {
    ...environment(image.Config.Env ?? []),
    ...service.environment,
  });
  health(row.Config.Healthcheck, service, image);
  const host = row.HostConfig;
  assert(host.Privileged === false && host.ReadonlyRootfs === true && host.Init === true);
  assert(host.RestartPolicy?.Name === "no" && (host.RestartPolicy.MaximumRetryCount ?? 0) === 0);
  exact(host.CapDrop, ["ALL"]);
  assert(empty(host.CapAdd) && empty(host.PortBindings) && host.PublishAllPorts === false);
  assert(
    empty(host.Devices) &&
      empty(host.DeviceRequests) &&
      empty(host.GroupAdd) &&
      empty(host.VolumesFrom),
  );
  assert(
    empty(host.Links) &&
      empty(host.ExtraHosts) &&
      empty(host.Dns) &&
      empty(host.DnsOptions) &&
      empty(host.DnsSearch),
  );
  assert(
    ["", undefined].includes(host.PidMode) &&
      ["private", ""].includes(host.IpcMode) &&
      ["", undefined].includes(host.UTSMode) &&
      ["", undefined].includes(host.UsernsMode),
  );
  exact(host.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(host.PidsLimit, service.pids_limit);
  assert.equal(host.Memory, service.mem_limit);
  assert.equal(host.NanoCpus, Math.round(Number(service.cpus) * 1_000_000_000));
  exact(host.LogConfig, { Type: "json-file", Config: { "max-file": "2", "max-size": "2m" } });
  const tmpfs = {};
  for (const mount of service.tmpfs ?? []) {
    const at = mount.indexOf(":");
    assert(at > 0);
    tmpfs[mount.slice(0, at)] = mount.slice(at + 1);
  }
  exact(host.Tmpfs ?? {}, tmpfs);
  const mounts = row.Mounts.map((mount) => {
    assert(
      mount.Type === "bind" && typeof mount.RW === "boolean" && mount.Propagation === "rprivate",
    );
    return { source: mount.Source, target: mount.Destination, read_only: !mount.RW };
  }).sort((a, b) => a.target.localeCompare(b.target));
  const expectedMounts = (service.volumes ?? [])
    .map((mount) => {
      assert(mount.type === "bind" && mount.bind?.create_host_path === false);
      return { source: mount.source, target: mount.target, read_only: mount.read_only ?? false };
    })
    .sort((a, b) => a.target.localeCompare(b.target));
  exact(mounts, expectedMounts);
  const expectedNetworks = {},
    addresses = {};
  if (service.network_mode) {
    assert(service.network_mode === "service:meilisearch" && identifier(relatedIds.meilisearch));
    assert(host.NetworkMode === `container:${relatedIds.meilisearch}`);
    assert(empty(row.NetworkSettings.Networks));
  } else {
    for (const key of Object.keys(service.networks)) {
      const network = networks[key];
      assert(network && identifier(network.Id));
      const actual = row.NetworkSettings.Networks[network.Name];
      assert(
        actual &&
          (actual.NetworkID === network.Id ||
            (row.State.Status === "created" &&
              actual.NetworkID === "" &&
              actual.IPAddress === "")) &&
          actual.GlobalIPv6Address === "",
      );
      const preparedAddress = service.networks[key].ipv4_address;
      assert(privateAddress(preparedAddress));
      assert(
        actual.IPAddress === preparedAddress ||
          (["created", "exited"].includes(row.State.Status) && actual.IPAddress === ""),
      );
      expectedNetworks[network.Name] = network.Id;
      addresses[key] = actual.IPAddress;
    }
    exact(Object.keys(row.NetworkSettings.Networks).sort(), Object.keys(expectedNetworks).sort());
    assert(Object.hasOwn(expectedNetworks, host.NetworkMode));
  }
  for (const binding of Object.values(row.NetworkSettings.Ports ?? {})) assert(binding === null);
  // Entire Config/HostConfig and every initial mount/network identity are pinned, including fields
  // not used by this version of the controller. Dynamic process/health/address state is observed separately.
  const identity = hash({
    Id: row.Id,
    Image: row.Image,
    Created: row.Created,
    Platform: row.Platform,
    Config: row.Config,
    HostConfig: host,
    Mounts: row.Mounts,
    Networks: expectedNetworks,
    Path: row.Path,
    Args: row.Args,
    AppArmorProfile: row.AppArmorProfile,
  });
  return Object.freeze({
    id: row.Id,
    imageId: row.Image,
    service: serviceName,
    identity,
    status: row.State.Status,
    exitCode: row.State.ExitCode,
    oomKilled: row.State.OOMKilled,
    healthy: row.State.Health?.Status === "healthy",
    addresses: Object.freeze(addresses),
  });
}

export function requireSameRuntimeContainer(observation, contract, recorded) {
  const current = observeRuntimeContainer(observation, contract);
  assert(
    current.id === recorded.id &&
      current.imageId === recorded.imageId &&
      current.service === recorded.service &&
      current.identity === recorded.identity,
  );
  return current;
}

export function observeRuntimeNetwork(row, { project, name, internal }) {
  assert(identifier(row.Id) && row.Name === `${project}_${name}` && row.Driver === "bridge");
  assert(
    row.Scope === "local" &&
      row.Internal === internal &&
      row.EnableIPv6 === false &&
      row.Ingress === false,
  );
  assert(
    row.Labels?.["com.docker.compose.project"] === project &&
      row.Labels["com.docker.compose.network"] === name,
  );
  assert(
    row.IPAM?.Driver === "default" &&
      Array.isArray(row.IPAM.Config) &&
      row.IPAM.Config.length === 1,
  );
  const subnet = row.IPAM.Config[0].Subnet;
  assert(
    typeof subnet === "string" &&
      privateAddress(subnet.split("/")[0]) &&
      /\/(?:1[6-9]|2[0-9])$/u.test(subnet),
  );
  const prepared = { backend: "172.28.0", capture: "172.29.0", azure_egress: "172.30.0" }[name];
  assert(
    prepared && subnet === `${prepared}.0/24` && row.IPAM.Config[0].Gateway === `${prepared}.1`,
  );
  assert([undefined, ""].includes(row.IPAM.Config[0].IPRange));
  assert(empty(row.IPAM.Config[0].AuxiliaryAddresses));
  assert(
    Object.keys(row.Options ?? {}).every((key) => key === "com.docker.network.bridge.enable_icc"),
  );
  assert(row.Options?.["com.docker.network.bridge.enable_icc"] !== "false");
  return Object.freeze({
    Id: row.Id,
    Name: row.Name,
    identity: hash({
      Id: row.Id,
      Name: row.Name,
      Driver: row.Driver,
      Scope: row.Scope,
      Internal: row.Internal,
      EnableIPv6: row.EnableIPv6,
      IPAM: row.IPAM,
      Options: row.Options,
      Labels: row.Labels,
    }),
  });
}
