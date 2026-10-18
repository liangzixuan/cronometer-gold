import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { fixture } from "./azure-development-runtime-host-fixture.mjs";

const chain = "NOURISHING-DEVELOPMENT-EGRESS",
  host = "NOURISHING-DEVELOPMENT-HOST";
const reject = (name) => `-A ${name} -j REJECT --reject-with icmp-port-unreachable`;

test("actual held qualification and bounded raw host observations bind prepared ARM64 encrypted storage and exact egress", async (t) => {
  const f = await fixture(t),
    host = await f.open();
  try {
    assert.equal(host.localOnly, true);
    assert.equal(host.operationalAcceptance, false);
    assert.equal(host.packetAcceptance, false);
    assert(f.calls.some(([, args]) => args[0] === "ahosts"));
    assert(
      f.calls.every(
        ([, args]) =>
          !args.some((arg) => ["-A", "-D", "-I", "mount", "start", "pull", "create"].includes(arg)),
      ),
    );
    assert(f.observations.every((row) => row.completed === true));
    await host.conserve();
  } finally {
    await host.close();
  }
});
test("wrong source or host, stale qualification and changed held bytes cannot admit a host", async (t) => {
  for (const mutate of [
    (f) => {
      f.input.sourceRevision = "b".repeat(40);
    },
    (f) => {
      f.input.bootId = f.q.owner;
    },
    (f) => {
      f.input.notAfterUtc = new Date(Date.now() - 1).toISOString();
    },
    async (f) => {
      await writeFile(f.path, "substituted");
    },
  ]) {
    const f = await fixture(t);
    await mutate(f);
    await assert.rejects(f.open());
    assert.equal(f.calls.length, 0);
  }
});
test("native identity, encrypted device, tmpfs and Docker storage drift refuse after a valid baseline", async (t) => {
  for (const mutate of [
    (s) => {
      s.node.arch = "x64";
    },
    (s) => {
      s.system["/etc/machine-id"] = "6".repeat(32);
    },
    (s) => {
      s.system["/proc/sys/kernel/osrelease"] = "microsoft-standard-WSL2";
    },
    (s) => {
      s.system["/proc/sys/net/ipv6/conf/all/disable_ipv6"] = "0";
    },
    (s) => {
      s.block.blockdevices[0].fstype = "ext4";
    },
    (s) => {
      s.block.blockdevices[0].children[0].type = "part";
    },
    (s) => {
      s.mount["maj:min"] = "8:1";
    },
    (s) => {
      s.memory.fstype = "ext4";
    },
    (s) => {
      s.docker.DockerRootDir = "/var/lib/docker";
    },
    (s) => {
      s.docker.ID = "unrelated-daemon";
    },
    (s) => {
      s.docker.LiveRestoreEnabled = true;
    },
  ]) {
    const f = await fixture(t),
      host = await f.open();
    try {
      mutate(f.state);
      await assert.rejects(host.conserve());
    } finally {
      await host.close();
    }
  }
});
test("wrong DNS, broadened destination policy or displaced first jump cannot survive conservation", async (t) => {
  for (const mutate of [
    (s) => {
      s.dns.postgres = ["172.28.0.99"];
    },
    (s) => {
      s.dns["nourishingfixture.blob.core.windows.net"].push("20.60.1.3");
    },
    (s) => {
      s.firewall[chain] = s.firewall[chain].replace("20.60.1.2/32", "0.0.0.0/0");
    },
    (s) => {
      s.firewall.OUTPUT = `-P OUTPUT ACCEPT\n-A OUTPUT -j ACCEPT\n-A OUTPUT -j ${host}\n`;
    },
    (s) => {
      s.firewall[host] = s.firewall[host].replace(reject(host), `-A ${host} -j ACCEPT`);
    },
  ]) {
    const f = await fixture(t),
      held = await f.open();
    try {
      mutate(f.state);
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
  }
});
test("reserved routes are absent initially and later bind only complete durable owned network IDs", async (t) => {
  const f = await fixture(t),
    held = await f.open(),
    id = "1".repeat(64);
  try {
    f.setRoutes([
      {
        dst: "172.28.0.0/24",
        dev: `br-${id.slice(0, 12)}`,
        protocol: "kernel",
        scope: "link",
        prefsrc: "172.28.0.1",
        flags: [],
      },
    ]);
    await assert.rejects(held.conserve());
    await held.conserve({ createdNetworks: { backend: id } });
    f.setRoutes([{ dst: "172.16.0.0/12", dev: "unrelated-vpn" }]);
    await assert.rejects(held.conserve({ createdNetworks: { backend: id } }));
  } finally {
    await held.close();
  }
});
test("bounded command output corruption, lost conservation and cancellation retain failure without admission", async (t) => {
  for (const option of ["wrongOutputHash", "breakAfterCommand"]) {
    const f = await fixture(t);
    f.state[option] = true;
    await assert.rejects(f.open());
    assert.equal(f.calls.length, 1);
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].completed, false);
    assert.equal(f.observations[0].phase, "host-observation-unconfirmed");
  }
  const f = await fixture(t);
  f.abort.abort();
  await assert.rejects(f.open());
  assert.equal(f.calls.length, 0);
});

for (const [name, mutate] of [
  [
    "nested plaintext database mount",
    (f) => {
      f.state.nestedMounts.push({
        target: `${f.input.root}/data/postgres`,
        source: "/dev/sdb",
        fstype: "ext4",
        options: "rw",
        "maj:min": "8:16",
      });
    },
  ],
  [
    "overriding routing policy",
    (f) => {
      f.state.policyRules.splice(1, 0, { priority: 100, src: "all", table: "123" });
    },
  ],
  [
    "enabled existing IPv6 interface",
    (f) => {
      f.state.system["/proc/sys/net/ipv6/conf/eth0/disable_ipv6"] = "0";
    },
  ],
])
  test(`after a valid baseline refuse ${name}`, async (t) => {
    const f = await fixture(t),
      held = await f.open();
    try {
      mutate(f);
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
  });

test("normal routing rules cannot hide an overriding local route or fallback table", async (t) => {
  for (const mutate of [
    (f) => {
      f.state.localRoutes = [
        {
          type: "local",
          dst: "172.28.0.0/24",
          dev: "lo",
          protocol: "kernel",
          scope: "host",
          prefsrc: "127.0.0.1",
        },
      ];
    },
    (f) => {
      f.state.defaultRoutes = [{ dst: "default", gateway: "10.2.0.1", dev: "unrelated" }];
    },
  ]) {
    const f = await fixture(t),
      held = await f.open();
    try {
      mutate(f);
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
  }
});
test("plaintext mounts under any protected file or spool and nested tmpfs mounts refuse", async (t) => {
  for (const suffix of [
    "config/api.env",
    "pki/postgres.key",
    "data/export-read-spool",
    "data/erasure-replay-spool",
    "tmpfs/foreign",
  ]) {
    const f = await fixture(t),
      held = await f.open();
    try {
      f.state.nestedMounts.push({
        target: `${f.input.root}/${suffix}`,
        source: "/dev/sdb",
        fstype: "ext4",
        options: "rw",
        "maj:min": "8:16",
      });
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
  }
});

for (const [name, mutate] of [
  [
    "local-table default route",
    (f) => {
      f.state.localRoutes = [
        {
          type: "local",
          dst: "default",
          dev: "lo",
          protocol: "kernel",
          scope: "host",
          prefsrc: "127.0.0.1",
        },
      ];
    },
  ],
  [
    "nested plaintext Docker metadata",
    (f) => {
      f.state.nestedMounts.push({
        target: `${f.input.dockerRoot}/containers`,
        source: "/dev/sdb",
        fstype: "ext4",
        options: "rw",
        "maj:min": "8:16",
      });
    },
  ],
])
  test(`after a valid baseline refuse ${name}`, async (t) => {
    const f = await fixture(t),
      held = await f.open();
    try {
      mutate(f);
      await assert.rejects(held.conserve());
    } finally {
      await held.close();
    }
  });

test("native owned overlay mounts bind all backing paths without admitting plaintext Docker metadata", async (t) => {
  const f = await fixture(t),
    held = await f.open(),
    id = "7".repeat(64),
    layer = "8".repeat(64),
    lower = "9".repeat(64),
    base = `${f.input.dockerRoot}/overlay2/`;
  try {
    const data = {
      LowerDir: `${base}${lower}/diff`,
      MergedDir: `${base}${layer}/merged`,
      UpperDir: `${base}${layer}/diff`,
      WorkDir: `${base}${layer}/work`,
    };
    f.state.graphs = [
      {
        Id: id,
        Config: {
          Labels: {
            "io.nourishing.runtime.owner": f.input.owner,
            "io.nourishing.runtime.revision": f.input.sourceRevision,
            "com.docker.compose.project": `nourishing-development-${f.input.owner}`,
            "com.docker.compose.service": "api",
          },
        },
        GraphDriver: { Name: "overlay2", Data: data },
      },
    ];
    const mount = {
      target: data.MergedDir,
      source: "overlay",
      fstype: "overlay",
      options: `rw,relatime,lowerdir=${data.LowerDir},upperdir=${data.UpperDir},workdir=${data.WorkDir}`,
      "maj:min": "0:88",
    };
    f.state.nestedMounts = [mount];
    await assert.rejects(held.conserve());
    await held.conserve({ createdContainers: { api: id } });
    assert.equal(f.calls.filter(([tool]) => tool === f.input.realpath.path).length, 1);
    f.state.canonicalPaths[data.LowerDir] = "/tmp/plaintext-outside-docker-store";
    await assert.rejects(held.conserve({ createdContainers: { api: id } }));
    delete f.state.canonicalPaths[data.LowerDir];
    for (const change of [
      () => {
        mount.options = mount.options.replace(data.UpperDir, "/tmp/plaintext");
      },
      () => {
        mount.options = `rw,lowerdir=${data.LowerDir},upperdir=${data.UpperDir},workdir=${data.WorkDir}`;
        f.state.nestedMounts.push({
          target: data.UpperDir,
          source: "/dev/sdb",
          fstype: "ext4",
          options: "rw",
          "maj:min": "8:16",
        });
      },
    ]) {
      change();
      await assert.rejects(held.conserve({ createdContainers: { api: id } }));
    }
  } finally {
    await held.close();
  }
});

test("unsupported Docker storage cannot omit persistent encrypted store observation", async (t) => {
  const f = await fixture(t),
    held = await f.open();
  try {
    f.state.docker.Driver = "overlayfs";
    await assert.rejects(held.conserve());
  } finally {
    await held.close();
  }
});
