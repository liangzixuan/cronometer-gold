/** Observe a separately prepared host. No firewall, route, resolver, mount or service mutation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { heldOperatorInput } from "./postgres-operator-input.mjs";
import { runTool } from "./postgres-operator-process.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url))),
  hash = (value) => createHash("sha256").update(value).digest("hex"),
  exact = (a, b) => assert.equal(canonicalJson(a), canonicalJson(b)),
  keys = (value, names) => exact(Object.keys(value).sort(), [...names].sort()),
  failure = () => new Error("Prepared development host admission or conservation failed");
const privateDns = {
  postgres: "172.28.0.2",
  "meili.internal": "172.28.0.4",
  "mail-capture": "172.29.0.2",
};
const bridges = { backend: "172.28.0", capture: "172.29.0", azure_egress: "172.30.0" };
const ipNumber = (text) => {
  assert(isIP(text) === 4);
  return text.split(".").reduce((n, part) => n * 256 + Number(part), 0);
};
export const publicIp = (value) => {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const n = ipNumber(value);
  return ![
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(
    ([base, bits]) =>
      Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipNumber(base) / 2 ** (32 - bits)),
  );
};
function rules(raw, chain) {
  assert(typeof raw === "string" && Buffer.byteLength(raw) <= 262_144);
  const lines = raw.trim().split("\n");
  assert(lines.length > 0 && lines.length <= 1024);
  const rows = [];
  for (const line of lines) {
    const fields = line.split(" ");
    assert(fields.every((value) => /^[A-Za-z0-9_.,/:!+-]+$/u.test(value)));
    assert(fields[1] === chain);
    if (fields[0] === "-A") rows.push(fields);
    else
      assert(
        (fields[0] === "-P" && fields.length === 3 && ["ACCEPT", "DROP"].includes(fields[2])) ||
          (fields[0] === "-N" && fields.length === 2),
      );
  }
  return rows;
}
function expectedRules(qualification, clientAccess) {
  const destinations = [...new Set(Object.values(qualification.azureEndpoints).flat())].sort(),
    forward = "NOURISHING-DEVELOPMENT-EGRESS",
    host = "NOURISHING-DEVELOPMENT-HOST";
  const allow443 = (chain) =>
    destinations.map((ip) => [
      "-A",
      chain,
      "-d",
      `${ip}/32`,
      "-p",
      "tcp",
      "-m",
      "tcp",
      "--dport",
      "443",
      "-m",
      "conntrack",
      "--ctstate",
      "NEW,ESTABLISHED",
      "-j",
      "ACCEPT",
    ]);
  const reject = (chain) => ["-A", chain, "-j", "REJECT", "--reject-with", "icmp-port-unreachable"];
  return {
    forward,
    host,
    forwardJump: ["-A", "FORWARD", "-s", "172.30.0.0/24", "-j", forward],
    outputJump: ["-A", "OUTPUT", "-j", host],
    forwardRules: [
      ...(clientAccess
        ? [
            [
              "-A",
              forward,
              "-s",
              "172.30.0.5/32",
              "-d",
              clientAccess.adminIpv4Cidr,
              "-p",
              "tcp",
              "-m",
              "tcp",
              "--sport",
              "8443",
              "-m",
              "conntrack",
              "--ctstate",
              "ESTABLISHED",
              "-j",
              "ACCEPT",
            ],
          ]
        : []),
      ...allow443(forward),
      reject(forward),
    ],
    hostRules: [
      ["-A", host, "-o", "lo", "-j", "ACCEPT"],
      ["-A", host, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
      ...[
        ["172.28.0.2", "5432"],
        ["172.28.0.4", "8443"],
        ["172.28.0.5", "4000"],
        ["172.29.0.2", "8025"],
      ].map(([ip, port]) => [
        "-A",
        host,
        "-d",
        `${ip}/32`,
        "-p",
        "tcp",
        "-m",
        "tcp",
        "--dport",
        port,
        "-j",
        "ACCEPT",
      ]),
      ...["udp", "tcp"].map((protocol) => [
        "-A",
        host,
        "-d",
        `${qualification.resolver}/32`,
        "-p",
        protocol,
        "-m",
        protocol,
        "--dport",
        "53",
        "-j",
        "ACCEPT",
      ]),
      ...allow443(host),
      reject(host),
    ],
  };
}
function routeAdmission(rows, createdNetworks, table = "main") {
  assert(Array.isArray(rows) && rows.length <= 1024);
  assert(Object.keys(createdNetworks).every((name) => Object.hasOwn(bridges, name)));
  for (const value of Object.values(createdNetworks)) assert(/^[a-f0-9]{64}$/u.test(value));
  for (const row of rows) {
    if (row.dst === "default") {
      assert(table === "main");
      continue;
    }
    assert(typeof row.dst === "string");
    const [address, prefix = "32"] = row.dst.split("/");
    assert(isIP(address) === 4 && /^(?:[0-9]|[12][0-9]|3[0-2])$/u.test(prefix));
    const bits = Number(prefix),
      start = Math.floor(ipNumber(address) / 2 ** (32 - bits)) * 2 ** (32 - bits),
      end = start + 2 ** (32 - bits) - 1;
    for (const [name, base] of Object.entries(bridges)) {
      const reserved = ipNumber(`${base}.0`);
      if (end < reserved || start > reserved + 255) continue;
      assert(createdNetworks[name], "Reserved bridge overlaps a pre-existing route");
      assert(
        row.dev === `br-${createdNetworks[name].slice(0, 12)}` &&
          row.protocol === "kernel" &&
          row.prefsrc === `${base}.1`,
      );
      if (table === "main")
        assert(row.dst === `${base}.0/24` && row.scope === "link" && row.type === undefined);
      else
        assert(
          table === "local" &&
            ((row.type === "local" && row.dst === `${base}.1` && row.scope === "host") ||
              (row.type === "broadcast" &&
                [`${base}.0`, `${base}.255`].includes(row.dst) &&
                row.scope === "link")),
        );
      assert(
        row.gateway === undefined &&
          (row.flags === undefined ||
            canonicalJson(row.flags) === "[]" ||
            canonicalJson(row.flags) === '["linkdown"]'),
      );
    }
  }
}

/** Only bounded raw process, DNS and system-file observations are replaceable in source tests. */
export async function openPreparedDevelopmentHost(input, execution = {}) {
  const specification = structuredClone({
    ...input,
    signal: undefined,
    conserve: undefined,
    onObservation: undefined,
  });
  const { signal, conserve, onObservation } = input,
    execute = execution.execute ?? runTool,
    readSystem = execution.readSystem ?? readFile,
    listSystem = execution.readdir ?? readdir;
  assert(
    signal instanceof AbortSignal &&
      typeof conserve === "function" &&
      typeof onObservation === "function",
  );
  assert(specification.node.path === process.execPath);
  assert(
    /^[a-f0-9]{40}$/u.test(specification.sourceRevision) &&
      /^[a-f0-9-]{36}$/u.test(specification.owner),
  );
  for (const value of [specification.root, specification.dockerRoot])
    assert(isAbsolute(value) && resolve(value) === value && value !== "/");
  assert(
    !specification.dockerRoot.startsWith(`${specification.root}/`) &&
      !specification.root.startsWith(`${specification.dockerRoot}/`) &&
      specification.root !== specification.dockerRoot,
  );
  let held,
    closed = false,
    result;
  const start = Date.now(),
    mono = performance.now(),
    stop = Date.parse(specification.notAfterUtc);
  assert(
    new Date(stop).toISOString() === specification.notAfterUtc &&
      stop > start &&
      stop - start <= 14_400_000,
  );
  const guard = () => {
    assert(
      !closed &&
        Date.now() >= start &&
        Date.now() < stop &&
        performance.now() - mono < stop - start,
    );
    signal.throwIfAborted();
  };
  const command = async (name, args) => {
    guard();
    await conserve();
    guard();
    const began = new Date().toISOString(),
      errors = [];
    let bytes = 0,
      raw;
    try {
      raw = await execute(specification[name], args, {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        directory: SOURCE,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(
              1,
              Math.floor(
                Math.min(30_000, stop - Date.now(), stop - start - (performance.now() - mono)),
              ),
            ),
          ),
        ]),
        limit: 262_144,
        onStderr: (chunk) => {
          assert(Buffer.isBuffer(chunk));
          bytes += chunk.length;
          assert(bytes <= 65_536);
          errors.push(Buffer.from(chunk));
        },
      });
      assert(
        typeof raw.text === "string" &&
          Buffer.byteLength(raw.text) <= 262_144 &&
          Buffer.byteLength(raw.text) === raw.bytes &&
          hash(raw.text) === raw.sha256 &&
          raw.stderrBytes === bytes &&
          raw.stderrSha256 === hash(Buffer.concat(errors)),
      );
      await conserve();
      guard();
    } catch {
      await onObservation({
        phase: "host-observation-unconfirmed",
        tool: name,
        command: args,
        startedAtUtc: began,
        endedAtUtc: new Date().toISOString(),
        completed: false,
        stderr: Buffer.concat(errors).toString("base64"),
        ...(typeof raw?.text === "string" && Buffer.byteLength(raw.text) <= 262_144
          ? { stdout: raw.text, stdoutSha256: hash(raw.text) }
          : {}),
      });
      throw failure();
    }
    await onObservation({
      phase: "host-observation",
      tool: name,
      command: args,
      startedAtUtc: began,
      endedAtUtc: new Date().toISOString(),
      completed: true,
      stdout: raw.text,
      stdoutSha256: raw.sha256,
      stderr: Buffer.concat(errors).toString("base64"),
      stderrSha256: raw.stderrSha256,
    });
    return raw.text;
  };
  const close = async () => {
    assert(!closed);
    closed = true;
    if (held) {
      held.raw.fill(0);
      await held.fd.close();
    }
  };
  try {
    held = await heldOperatorInput(
      specification.qualification.path,
      specification.qualification.sha256,
      { privateFile: true, maximum: 65_536 },
    );
    const q = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held.raw));
    assert(Buffer.from(`${canonicalJson(q)}\n`).equals(held.raw));
    keys(q, [
      "schemaVersion",
      "kind",
      "sourceRevision",
      "owner",
      "bootId",
      "machineId",
      "notAfterUtc",
      "azureEndpoints",
      "resolver",
      "encryptedVolume",
    ]);
    assert(
      q.schemaVersion === 1 &&
        q.kind === "nutrition-development-prepared-host-v1" &&
        q.sourceRevision === specification.sourceRevision &&
        q.owner === specification.owner &&
        q.bootId === specification.bootId &&
        q.machineId === specification.machineId &&
        Date.parse(q.notAfterUtc) >= stop,
    );
    assert(/^[a-f0-9-]{36}$/u.test(q.bootId) && /^[a-f0-9]{32}$/u.test(q.machineId));
    assert(
      isIP(q.resolver) === 4 && !q.resolver.startsWith("127.") && !q.resolver.startsWith("0."),
    );
    exact(Object.keys(q.azureEndpoints).sort(), [...specification.azureHosts].sort());
    assert(
      specification.azureHosts.length >= 1 &&
        specification.azureHosts.length <= 8 &&
        new Set(specification.azureHosts).size === specification.azureHosts.length,
    );
    for (const [hostname, addresses] of Object.entries(q.azureEndpoints)) {
      assert(/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(hostname));
      assert(
        Array.isArray(addresses) &&
          addresses.length >= 1 &&
          addresses.length <= 16 &&
          addresses.every(publicIp),
      );
      exact(addresses, [...new Set(addresses)].sort());
    }
    keys(q.encryptedVolume, ["source", "mountPoint", "majorMinor", "filesystemUuid", "luksUuid"]);
    exact(q.encryptedVolume, specification.encryptedVolume);
    const expected = expectedRules(q, specification.clientAccess);
    const observe = async ({ createdNetworks = {}, createdContainers = {} } = {}) => {
      createdNetworks = structuredClone(createdNetworks);
      createdContainers = structuredClone(createdContainers);
      guard();
      (await held.conserve()).fill(0);
      await conserve();
      guard();
      assert((await readSystem("/proc/sys/kernel/random/boot_id", "utf8")).trim() === q.bootId);
      assert((await readSystem("/etc/machine-id", "utf8")).trim() === q.machineId);
      const interfaces = await listSystem("/proc/sys/net/ipv6/conf");
      assert(
        Array.isArray(interfaces) &&
          interfaces.length >= 3 &&
          interfaces.length <= 1024 &&
          new Set(interfaces).size === interfaces.length,
      );
      assert(
        interfaces.includes("all") && interfaces.includes("default") && interfaces.includes("lo"),
      );
      assert(
        interfaces.every(
          (name) =>
            typeof name === "string" &&
            /^[A-Za-z0-9_.:-]{1,64}$/u.test(name) &&
            ![".", ".."].includes(name),
        ),
      );
      for (const name of interfaces) {
        guard();
        const value = await readSystem(`/proc/sys/net/ipv6/conf/${name}/disable_ipv6`, "utf8");
        assert(value.length <= 16 && value.trim() === "1");
      }
      exact([...(await listSystem("/proc/sys/net/ipv6/conf"))].sort(), [...interfaces].sort());
      const release = await readSystem("/proc/sys/kernel/osrelease", "utf8");
      assert(release.length <= 1024 && !/microsoft|wsl/iu.test(release));
      const node = JSON.parse(
        await command("node", [
          "--print",
          "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})",
        ]),
      );
      exact(node, { platform: "linux", arch: "arm64", version: "22.23.2" });
      const block = JSON.parse(
        await command("lsblk", ["--json", "--output", "PATH,TYPE,FSTYPE,UUID,MAJ:MIN"]),
      );
      assert(Array.isArray(block.blockdevices));
      let mounted;
      const walk = (rows, parent) => {
        for (const row of rows) {
          if (row.path === q.encryptedVolume.source) {
            assert(
              !mounted &&
                row.type === "crypt" &&
                ["ext4", "xfs"].includes(row.fstype) &&
                row.uuid === q.encryptedVolume.filesystemUuid &&
                row["maj:min"] === q.encryptedVolume.majorMinor &&
                parent?.fstype === "crypto_LUKS" &&
                parent.uuid === q.encryptedVolume.luksUuid,
            );
            mounted = row;
          }
          if (row.children) {
            assert(Array.isArray(row.children));
            walk(row.children, row);
          }
        }
      };
      walk(block.blockdevices);
      assert(mounted);
      for (const target of [specification.root, specification.dockerRoot]) {
        const value = JSON.parse(
          await command("findmnt", [
            "--json",
            "--target",
            target,
            "--output",
            "SOURCE,FSTYPE,OPTIONS,MAJ:MIN,TARGET",
          ]),
        );
        assert(value.filesystems?.length === 1);
        const row = value.filesystems[0],
          opts = row.options.split(",");
        assert(
          row.source === q.encryptedVolume.source &&
            row.target === q.encryptedVolume.mountPoint &&
            row["maj:min"] === q.encryptedVolume.majorMinor &&
            row.fstype === mounted.fstype &&
            opts.includes("rw") &&
            !opts.includes("ro"),
        );
      }
      // Native overlay paths come only from just-inspected durable owned container IDs.
      // Their backing directories must resolve inside the same encrypted Docker root.
      const containerNames = Object.keys(createdContainers);
      assert(
        containerNames.length <= (specification.clientAccess ? 10 : 9) &&
          containerNames.every((name) =>
            [
              ...(specification.clientAccess ? ["client-edge"] : []),
              "api",
              "worker",
              "postgres",
              "capture",
              "internal-tls",
              "meilisearch",
              "migrate",
              "azure-canary",
              "search-bootstrap",
            ].includes(name),
          ),
      );
      const containerIds = Object.values(createdContainers);
      assert(
        new Set(containerIds).size === containerIds.length &&
          containerIds.every((id) => /^[a-f0-9]{64}$/u.test(id)),
      );
      const overlays = new Map(),
        backingPaths = new Set(),
        overlayComparisons = [];
      const backingPath = (value) => {
        assert(typeof value === "string" && value.length <= 4096 && !/[\s,\0]/u.test(value));
        const path = isAbsolute(value)
          ? value
          : resolve(specification.dockerRoot, "overlay2", value);
        assert(path.startsWith(`${specification.dockerRoot}/overlay2/`) && resolve(path) === path);
        backingPaths.add(path);
        return path;
      };
      if (containerIds.length) {
        const observed = JSON.parse(
          await command("docker", [
            "--host",
            "unix:///var/run/docker.sock",
            "--config",
            `${specification.root}/docker-config`,
            "container",
            "inspect",
            ...containerIds,
          ]),
        );
        assert(Array.isArray(observed) && observed.length === containerIds.length);
        for (const [name, id] of Object.entries(createdContainers)) {
          const matches = observed.filter((row) => row.Id === id);
          assert(matches.length === 1);
          const row = matches[0],
            labels = row.Config?.Labels,
            graph = row.GraphDriver;
          assert(
            labels?.["io.nourishing.runtime.owner"] === specification.owner &&
              labels?.["io.nourishing.runtime.revision"] === specification.sourceRevision &&
              labels?.["com.docker.compose.service"] === name &&
              labels?.["com.docker.compose.project"] ===
                `nourishing-development-${specification.owner}`,
          );
          assert(graph?.Name === "overlay2");
          keys(graph.Data, ["LowerDir", "MergedDir", "UpperDir", "WorkDir"]);
          const base = `${specification.dockerRoot}/overlay2/`,
            merged = graph.Data.MergedDir;
          assert(
            typeof merged === "string" &&
              merged.startsWith(base) &&
              /^[a-f0-9]{64}\/merged$/u.test(merged.slice(base.length)) &&
              !overlays.has(merged),
          );
          const layer = merged.slice(0, -"merged".length);
          assert(graph.Data.UpperDir === `${layer}diff` && graph.Data.WorkDir === `${layer}work`);
          assert(typeof graph.Data.LowerDir === "string" && graph.Data.LowerDir.length <= 65_536);
          const lower = graph.Data.LowerDir.split(":");
          assert(lower.length >= 1 && lower.length <= 128);
          overlays.set(merged, {
            lower: lower.map(backingPath),
            upper: backingPath(graph.Data.UpperDir),
            work: backingPath(graph.Data.WorkDir),
          });
        }
      }
      // Enumerate nested mount points, including individual file bind mounts. A protected inode
      // on another device is not evidence that its bytes reside on this encrypted volume.
      const mountInventory = JSON.parse(
        await command("findmnt", [
          "--json",
          "--list",
          "--output",
          "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN",
        ]),
      );
      assert(
        Array.isArray(mountInventory.filesystems) && mountInventory.filesystems.length <= 4096,
      );
      for (const row of mountInventory.filesystems) {
        assert(
          typeof row.target === "string" &&
            isAbsolute(row.target) &&
            resolve(row.target) === row.target,
        );
        const withinRuntime =
            row.target === specification.root || row.target.startsWith(`${specification.root}/`),
          withinDocker =
            row.target === specification.dockerRoot ||
            row.target.startsWith(`${specification.dockerRoot}/`);
        if (!withinRuntime && !withinDocker) continue;
        if (withinDocker && row.fstype === "overlay") {
          const graph = overlays.get(row.target);
          assert(graph && row.source === "overlay");
          const options = row.options.split(","),
            fields = {};
          for (const item of options) {
            const at = item.indexOf("=");
            if (at > 0) {
              const key = item.slice(0, at);
              assert(!Object.hasOwn(fields, key));
              fields[key] = item.slice(at + 1);
            }
          }
          assert(
            options.includes("rw") !== options.includes("ro") &&
              fields.lowerdir &&
              fields.upperdir &&
              fields.workdir,
          );
          const lower = fields.lowerdir.split(":");
          assert(lower.length <= 128);
          overlayComparisons.push({
            graph,
            mount: {
              lower: lower.map(backingPath),
              upper: backingPath(fields.upperdir),
              work: backingPath(fields.workdir),
            },
          });
          continue;
        }
        if (row.target === `${specification.root}/tmpfs`) continue; // separately checked exact tmpfs below
        assert(
          !row.target.startsWith(`${specification.root}/tmpfs/`),
          "Unexpected nested mount within backup tmpfs",
        );
        assert(
          row.source === q.encryptedVolume.source &&
            row["maj:min"] === q.encryptedVolume.majorMinor &&
            row.fstype === mounted.fstype &&
            row.options.split(",").includes("rw"),
        );
      }
      if (backingPaths.size) {
        const paths = [...backingPaths];
        assert(
          paths.length <= 2048 &&
            paths.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 1, 0) <= 131_072,
        );
        const output = await command("realpath", ["--canonicalize-existing", "--", ...paths]);
        assert(output.endsWith("\n"));
        const resolved = output.slice(0, -1).split("\n");
        assert(resolved.length === paths.length);
        const canonical = new Map(paths.map((path, index) => [path, resolved[index]]));
        for (const value of resolved) {
          assert(
            value.startsWith(`${specification.dockerRoot}/overlay2/`) &&
              resolve(value) === value &&
              /^([a-f0-9]{64}(?:-init)?)\/diff$|^([a-f0-9]{64})\/work$/u.test(
                value.slice(`${specification.dockerRoot}/overlay2/`.length),
              ),
          );
        }
        const mapped = (value) => ({
          lower: value.lower.map((path) => canonical.get(path)),
          upper: canonical.get(value.upper),
          work: canonical.get(value.work),
        });
        for (const { graph, mount } of overlayComparisons) exact(mapped(mount), mapped(graph));
      }
      const memory = JSON.parse(
        await command("findmnt", [
          "--json",
          "--target",
          `${specification.root}/tmpfs`,
          "--output",
          "FSTYPE,OPTIONS,TARGET",
        ]),
      );
      assert(memory.filesystems?.length === 1);
      const memoryRow = memory.filesystems[0],
        memoryOptions = memoryRow.options.split(",");
      assert(
        memoryRow.fstype === "tmpfs" &&
          memoryRow.target === `${specification.root}/tmpfs` &&
          ["rw", "noexec", "nosuid", "nodev"].every((option) => memoryOptions.includes(option)),
      );
      const docker = JSON.parse(
        await command("docker", [
          "--host",
          "unix:///var/run/docker.sock",
          "--config",
          `${specification.root}/docker-config`,
          "info",
          "--format",
          "{{json .}}",
        ]),
      );
      assert(
        docker.Driver === "overlay2" &&
          docker.ID === specification.dockerId &&
          docker.DockerRootDir === specification.dockerRoot &&
          docker.OSType === "linux" &&
          ["aarch64", "arm64"].includes(docker.Architecture) &&
          docker.NCPU >= 4 &&
          docker.MemTotal >= 8 * 1024 ** 3 &&
          docker.LiveRestoreEnabled === false,
      );
      for (const [hostname, addresses] of Object.entries({
        ...q.azureEndpoints,
        ...Object.fromEntries(Object.entries(privateDns).map(([name, value]) => [name, [value]])),
      })) {
        guard();
        const raw = await command("getent", ["ahosts", hostname]);
        const observed = raw
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/u));
        assert(
          observed.length > 0 &&
            observed.length <= 128 &&
            observed.every(
              (row) =>
                row.length >= 2 &&
                isIP(row[0]) === 4 &&
                ["STREAM", "DGRAM", "RAW"].includes(row[1]),
            ),
        );
        exact([...new Set(observed.map((row) => row[0]))].sort(), addresses);
      }
      const policyRules = JSON.parse(await command("ip", ["-json", "-4", "rule", "show"]));
      assert(Array.isArray(policyRules) && policyRules.length === 3);
      const routingContract = [
        [0, "local"],
        [32766, "main"],
        [32767, "default"],
      ];
      for (const [index, [priority, table]] of routingContract.entries()) {
        const row = policyRules[index];
        assert(
          row &&
            Object.keys(row).every((name) =>
              ["priority", "src", "table", "protocol"].includes(name),
            ) &&
            row.priority === priority &&
            row.src === "all" &&
            row.table === table &&
            [undefined, "kernel"].includes(row.protocol),
        );
      }
      for (const table of ["main", "local", "default"]) {
        const routes = JSON.parse(
          await command("ip", ["-json", "-4", "route", "show", "table", table]),
        );
        assert(Array.isArray(routes) && routes.length <= 1024);
        if (table === "default") assert(routes.length === 0);
        else routeAdmission(routes, createdNetworks, table);
      }
      for (const [chain, first] of [
        ["FORWARD", expected.forwardJump],
        ["OUTPUT", expected.outputJump],
      ]) {
        const rows = rules(await command("iptables", ["-w", "5", "-S", chain]), chain);
        exact(rows[0], first);
        assert(rows.filter((row) => canonicalJson(row) === canonicalJson(first)).length === 1);
      }
      exact(
        rules(await command("iptables", ["-w", "5", "-S", expected.forward]), expected.forward),
        expected.forwardRules,
      );
      exact(
        rules(await command("iptables", ["-w", "5", "-S", expected.host]), expected.host),
        expected.hostRules,
      );
      (await held.conserve()).fill(0);
      await conserve();
      guard();
      return Object.freeze({
        kind: "nutrition-development-host-observations-v1",
        qualificationSha256: specification.qualification.sha256,
        bootId: q.bootId,
        machineId: q.machineId,
        localOnly: true,
        operationalAcceptance: false,
        packetAcceptance: false,
      });
    };
    result = await observe();
    return Object.freeze({ ...result, conserve: observe, close });
  } catch {
    if (!closed) await close();
    throw failure();
  }
}
