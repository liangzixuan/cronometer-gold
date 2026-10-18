import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openPreparedRuntimeSupervisor,
  renderPreparedRuntimeService,
} from "./azure-development-runtime-supervision.mjs";

const source = resolve(fileURLToPath(new URL("../", import.meta.url))),
  owner = "11111111-1111-4111-8111-111111111111",
  sha = (raw) => createHash("sha256").update(raw).digest("hex");

export async function fixture(t, options = {}) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "nutrition-prepared-supervision-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "supervision"), { mode: 0o700, recursive: true });
  const start = Date.now(),
    origin = process.hrtime.bigint(),
    input = {
      owner,
      root,
      inputPath: options.inputPath ?? join(root, "runtime.json"),
      inputSha256: options.inputSha256 ?? "a".repeat(64),
      nodePath: process.execPath,
      controllerUid: process.getuid(),
      controllerGid: process.getgid(),
      runtimeSeconds: options.runtimeSeconds ?? 1800,
      notAfterUtc: options.notAfterUtc ?? new Date(start + 3_900_000).toISOString(),
      startedAtUtc: new Date(start).toISOString(),
      monotonicStartNs: origin.toString(),
      signal: new AbortController().signal,
      busctl: { path: "/usr/bin/busctl", sha256: "b".repeat(64) },
    };
  const definition = renderPreparedRuntimeService(input);
  await writeFile(definition.path, definition.fragment, { mode: 0o600, flag: "wx" });
  const startedMonoUs = Number(origin / 1000n) - 1000,
    fields = {
      Unit: {
        Id: ["s", definition.unit],
        LoadState: ["s", "loaded"],
        ActiveState: ["s", "active"],
        SubState: ["s", "running"],
        FragmentPath: ["s", definition.path],
        DropInPaths: ["as", []],
        Transient: ["b", false],
        NeedDaemonReload: ["b", false],
      },
      Service: {
        Type: ["s", "exec"],
        Restart: ["s", "no"],
        MainPID: ["u", process.pid],
        ExecMainStartTimestampMonotonic: ["t", startedMonoUs],
        RuntimeMaxUSec: ["t", input.runtimeSeconds * 1_000_000],
        RuntimeRandomizedExtraUSec: ["t", 0],
        TimeoutStopUSec: ["t", 1_500_000_000],
        TimeoutStopFailureMode: ["s", "kill"],
        KillMode: ["s", "control-group"],
        KillSignal: ["i", 9],
        FinalKillSignal: ["i", 9],
        SendSIGKILL: ["b", true],
        NotifyAccess: ["s", "none"],
        RemainAfterExit: ["b", false],
        Delegate: ["b", false],
        User: ["s", String(process.getuid())],
        Group: ["s", String(process.getgid())],
        Environment: ["as", [`NODE_EXTRA_CA_CERTS=${join(root, "pki/ca.crt")}`]],
        WorkingDirectory: ["s", source],
        UMask: ["u", 63],
        ExecStart: [
          "a(sasbttttuii)",
          [
            [
              process.execPath,
              definition.start,
              false,
              start * 1000 - 1000,
              startedMonoUs,
              0,
              0,
              process.pid,
              0,
              0,
            ],
          ],
        ],
        ExecStopPost: [
          "a(sasbttttuii)",
          [[process.execPath, definition.stop, false, 0, 0, 0, 0, 0, 0, 0]],
        ],
        ExecStartPre: ["a(sasbttttuii)", []],
        ExecStartPost: ["a(sasbttttuii)", []],
        ExecStop: ["a(sasbttttuii)", []],
        ExecReload: ["a(sasbttttuii)", []],
        ControlGroup: ["s", `/system.slice/${definition.unit}`],
      },
    };
  const calls = [],
    observations = [];
  const execution = {
    async execute(tool, args, configuration) {
      configuration.signal.throwIfAborted();
      assert.deepEqual(tool, input.busctl);
      assert.deepEqual(args.slice(0, 8), [
        "--system",
        "--json=short",
        "--no-pager",
        "--auto-start=no",
        "--allow-interactive-authorization=no",
        "--timeout=5s",
        "get-property",
        "org.freedesktop.systemd1",
      ]);
      assert.equal(
        args[8],
        `/org/freedesktop/systemd1/unit/${definition.unit.replaceAll("-", "_2d").replaceAll(".", "_2e")}`,
      );
      assert.deepEqual(configuration.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
      const family = args[9].split(".").at(-1),
        names = args.slice(10);
      assert(Object.hasOwn(fields, family));
      assert.deepEqual(names, Object.keys(fields[family]));
      calls.push([...args]);
      let text = `${names.map((name) => JSON.stringify({ type: fields[family][name][0], data: fields[family][name][1] })).join("\n")}\n`;
      if (options.malformed) text = text.replace('"type":"s"', '"type":"t"');
      return {
        text,
        bytes: Buffer.byteLength(text),
        sha256: options.wrongDigest ? "0".repeat(64) : sha(text),
        stderrBytes: 0,
        stderrSha256: sha(""),
      };
    },
    async readSystem(path) {
      assert.equal(path, `/proc/${process.pid}/cgroup`);
      return options.wrongCgroup
        ? "0::/unrelated.slice/unrelated.service\n"
        : `0::/system.slice/${definition.unit}\n`;
    },
  };
  input.onObservation = async (record) => {
    observations.push(record);
  };
  const open = () => openPreparedRuntimeSupervisor(input, execution);
  return { input, definition, fields, calls, observations, open, execution };
}
