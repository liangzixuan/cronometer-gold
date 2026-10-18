import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { openPreparedDevelopmentHost } from "./azure-development-runtime-host.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const chain = "NOURISHING-DEVELOPMENT-EGRESS",
  host = "NOURISHING-DEVELOPMENT-HOST";
const allow = (name) =>
  `-A ${name} -d 20.60.1.2/32 -p tcp -m tcp --dport 443 -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT`;
const reject = (name) => `-A ${name} -j REJECT --reject-with icmp-port-unreachable`;
export async function fixture(t, options = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "nutrition-prepared-host-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "held"), { mode: 0o700 });
  const volume = {
      source: "/dev/mapper/nourishing",
      mountPoint: options.mountPoint ?? "/tmp",
      majorMinor: "253:0",
      filesystemUuid: "11111111-1111-4111-8111-111111111111",
      luksUuid: "22222222-2222-4222-8222-222222222222",
    },
    q = {
      schemaVersion: 1,
      kind: "nutrition-development-prepared-host-v1",
      sourceRevision: "a".repeat(40),
      owner: options.owner ?? "33333333-3333-4333-8333-333333333333",
      bootId: "44444444-4444-4444-8444-444444444444",
      machineId: "5".repeat(32),
      notAfterUtc: options.notAfterUtc ?? new Date(Date.now() + 7_200_000).toISOString(),
      azureEndpoints: Object.fromEntries(
        (options.azureHosts ?? ["nourishingfixture.blob.core.windows.net"]).map((name) => [
          name,
          ["20.60.1.2"],
        ]),
      ),
      resolver: "168.63.129.16",
      encryptedVolume: volume,
    };
  const path = join(root, "held", "host.json"),
    raw = Buffer.from(`${canonicalJson(q)}\n`);
  await writeFile(path, raw, { mode: 0o600, flag: "wx" });
  const calls = [],
    observations = [],
    abort = new AbortController();
  let routes = [
    { dst: "default", gateway: "10.1.0.1", dev: "eth0" },
    { dst: "10.1.0.0/24", dev: "eth0", protocol: "kernel", scope: "link", prefsrc: "10.1.0.4" },
  ];
  const state = {
    canonicalPaths: {},
    graphs: [],
    nestedMounts: [],
    localRoutes: [],
    defaultRoutes: [],
    policyRules: [
      { priority: 0, src: "all", table: "local" },
      { priority: 32766, src: "all", table: "main" },
      { priority: 32767, src: "all", table: "default" },
    ],
    interfaces: ["all", "default", "eth0", "lo"],
    node: { platform: "linux", arch: "arm64", version: "22.23.2" },
    block: {
      blockdevices: [
        {
          path: "/dev/sdc1",
          type: "part",
          fstype: "crypto_LUKS",
          uuid: volume.luksUuid,
          "maj:min": "8:33",
          children: [
            {
              path: volume.source,
              type: "crypt",
              fstype: "ext4",
              uuid: volume.filesystemUuid,
              "maj:min": volume.majorMinor,
            },
          ],
        },
      ],
    },
    mount: {
      source: volume.source,
      target: volume.mountPoint,
      fstype: "ext4",
      options: "rw,relatime",
      "maj:min": volume.majorMinor,
    },
    memory: {
      fstype: "tmpfs",
      options: "rw,nosuid,nodev,noexec,relatime",
      target: `${root}/tmpfs`,
    },
    docker: {
      Driver: "overlay2",
      ID: "synthetic-owned-docker-id",
      DockerRootDir: `${root}-docker-data`,
      OSType: "linux",
      Architecture: "aarch64",
      NCPU: 4,
      MemTotal: 8 * 1024 ** 3,
      LiveRestoreEnabled: false,
    },
    system: {
      "/proc/sys/kernel/random/boot_id": q.bootId,
      "/etc/machine-id": q.machineId,
      "/proc/sys/kernel/osrelease": "6.8.0-azure",
      "/proc/sys/net/ipv6/conf/all/disable_ipv6": "1",
      "/proc/sys/net/ipv6/conf/default/disable_ipv6": "1",
      "/proc/sys/net/ipv6/conf/eth0/disable_ipv6": "1",
      "/proc/sys/net/ipv6/conf/lo/disable_ipv6": "1",
    },
    dns: {
      ...q.azureEndpoints,
      postgres: ["172.28.0.2"],
      "meili.internal": ["172.28.0.4"],
      "mail-capture": ["172.29.0.2"],
    },
    firewall: {
      FORWARD: `-P FORWARD DROP\n-A FORWARD -s 172.30.0.0/24 -j ${chain}\n-A FORWARD -j DOCKER-USER\n`,
      OUTPUT: `-P OUTPUT ACCEPT\n-A OUTPUT -j ${host}\n`,
      [chain]: `-N ${chain}\n${allow(chain)}\n${reject(chain)}\n`,
      [host]: [
        `-N ${host}`,
        `-A ${host} -o lo -j ACCEPT`,
        `-A ${host} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
        ...[
          ["172.28.0.2", 5432],
          ["172.28.0.4", 8443],
          ["172.28.0.5", 4000],
          ["172.29.0.2", 8025],
        ].map(([ip, port]) => `-A ${host} -d ${ip}/32 -p tcp -m tcp --dport ${port} -j ACCEPT`),
        ...["udp", "tcp"].map(
          (protocol) =>
            `-A ${host} -d 168.63.129.16/32 -p ${protocol} -m ${protocol} --dport 53 -j ACCEPT`,
        ),
        allow(host),
        reject(host),
        "",
      ].join("\n"),
    },
  };
  const input = {
    root,
    dockerRoot: state.docker.DockerRootDir,
    dockerId: state.docker.ID,
    qualification: { path, sha256: hash(raw) },
    sourceRevision: q.sourceRevision,
    owner: q.owner,
    bootId: q.bootId,
    machineId: q.machineId,
    notAfterUtc: q.notAfterUtc,
    encryptedVolume: volume,
    azureHosts: Object.keys(q.azureEndpoints),
    signal: abort.signal,
    conserve: async () => {
      if (state.breakConservation) throw new Error("Controlled held-input change");
    },
    onObservation: async (row) => observations.push(row),
    ...Object.fromEntries(
      ["node", "lsblk", "findmnt", "docker", "getent", "ip", "iptables", "realpath"].map((name) => [
        name,
        { path: name === "node" ? process.execPath : `/usr/bin/${name}`, sha256: "f".repeat(64) },
      ]),
    ),
  };
  const execute = async (tool, args, config) => {
    config.signal.throwIfAborted();
    calls.push([tool.path, [...args]]);
    assert.deepEqual(config.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
    assert(config.limit === 262_144);
    let value;
    if (tool.path === input.node.path) value = JSON.stringify(state.node);
    else if (tool.path === input.lsblk.path) {
      assert.deepEqual(args, ["--json", "--output", "PATH,TYPE,FSTYPE,UUID,MAJ:MIN"]);
      value = JSON.stringify(state.block);
    } else if (tool.path === input.findmnt.path)
      value = JSON.stringify({
        filesystems: args.includes("--list")
          ? [
              state.mount,
              { ...state.memory, source: "tmpfs", "maj:min": "0:1" },
              ...state.nestedMounts,
            ]
          : [args.includes(`${root}/tmpfs`) ? state.memory : state.mount],
      });
    else if (tool.path === input.docker.path) {
      if (args.includes("inspect")) {
        assert.deepEqual(args.slice(0, 6), [
          "--host",
          "unix:///var/run/docker.sock",
          "--config",
          `${root}/docker-config`,
          "container",
          "inspect",
        ]);
        value = JSON.stringify(state.graphs);
      } else {
        assert.deepEqual(args, [
          "--host",
          "unix:///var/run/docker.sock",
          "--config",
          `${root}/docker-config`,
          "info",
          "--format",
          "{{json .}}",
        ]);
        value = JSON.stringify(state.docker);
      }
    } else if (tool.path === input.getent.path) {
      assert(args[0] === "ahosts");
      value = state.dns[args[1]].map((ip) => `${ip} STREAM ${args[1]}`).join("\n") + "\n";
    } else if (tool.path === input.ip.path) {
      if (args.includes("rule")) {
        assert.deepEqual(args, ["-json", "-4", "rule", "show"]);
        value = JSON.stringify(state.policyRules);
      } else {
        assert.deepEqual(args.slice(0, 5), ["-json", "-4", "route", "show", "table"]);
        assert(["main", "local", "default"].includes(args[5]));
        value = JSON.stringify(
          args[5] === "main"
            ? routes
            : args[5] === "local"
              ? state.localRoutes
              : state.defaultRoutes,
        );
      }
    } else if (tool.path === input.realpath.path) {
      assert.deepEqual(args.slice(0, 2), ["--canonicalize-existing", "--"]);
      value = `${args
        .slice(2)
        .map((path) => state.canonicalPaths[path] ?? path)
        .join("\n")}\n`;
    } else {
      assert.equal(tool.path, input.iptables.path);
      assert.deepEqual(args.slice(0, 3), ["-w", "5", "-S"]);
      value = state.firewall[args[3]];
    }
    if (state.breakAfterCommand) state.breakConservation = true;
    return {
      text: value,
      bytes: Buffer.byteLength(value),
      sha256: state.wrongOutputHash ? "0".repeat(64) : hash(value),
      stderrBytes: 0,
      stderrSha256: hash(""),
    };
  };
  const execution = {
    execute,
    readdir: async (name) => {
      assert.equal(name, "/proc/sys/net/ipv6/conf");
      return [...state.interfaces];
    },
    readSystem: async (name) => {
      assert(Object.hasOwn(state.system, name));
      return state.system[name] + "\n";
    },
  };
  return {
    input,
    execution,
    q,
    path,
    calls,
    observations,
    state,
    abort,
    setRoutes: (rows) => {
      routes = rows;
    },
    open: () => openPreparedDevelopmentHost(input, execution),
  };
}
