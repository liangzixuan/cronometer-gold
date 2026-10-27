import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTarGzip } from "./source-artifact.ts";

type Limits = { archiveBytes: number; totalBytes: number; files: number };

/** Provider outputs are filesystem images; source uploads remain gzip tar archives. */
export function readOutputArtifact(archive: Buffer, limits: Limits) {
  if (!archive.length || archive.length > limits.archiveBytes)
    throw new Error("archive_size_limit");
  if (archive.length < 1028 || archive.readUInt32LE(1024) !== 0xe0f5e1e2)
    return readTarGzip(archive, limits);
  if (process.platform !== "linux") throw new Error("erofs_reader_requires_linux");
  const directory = mkdtempSync(join(tmpdir(), "nourishing-output-"));
  try {
    const image = join(directory, "output.erofs");
    writeFileSync(image, archive, { flag: "wx", mode: 0o600 });
    const reader = join(directory, "reader.py");
    writeFileSync(reader, readFileSync(new URL("./erofs-output.py", import.meta.url)), {
      flag: "wx",
      mode: 0o600,
    });
    const args = [
      "/usr/bin/bwrap",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--size",
      String(limits.totalBytes),
      "--tmpfs",
      "/output",
      "--ro-bind",
      image,
      "/input",
      "--ro-bind",
      reader,
      "/reader.py",
      "--chdir",
      "/output",
      "--cap-drop",
      "ALL",
      "/usr/bin/python3",
      "-I",
      "/reader.py",
      String(limits.totalBytes),
      String(limits.files),
    ];
    // Each private input is owned by this process; no sudo or host capability is needed.
    let converted: Buffer;
    try {
      converted = execFileSync("/usr/bin/bwrap", args.slice(1), {
        env: { PATH: "/usr/bin:/bin" },
        timeout: 30_000,
        maxBuffer: limits.archiveBytes,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      throw new Error("erofs_output_decode_failed", { cause });
    }
    // Apply the existing path, type, mode, duplicate, symlink and byte bounds unchanged.
    return readTarGzip(converted, limits);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
