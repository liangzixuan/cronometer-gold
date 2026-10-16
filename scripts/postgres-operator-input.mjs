import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { trustedPath } from "./postgres-operator-process.mjs";

const failure = () => new Error("PostgreSQL operator private input failed");
const requireValue = (v) => {
  if (!v) throw failure();
};
const hashValue = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
const identity = (s) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
/** Own a pinned private input descriptor. The caller clears raw bytes and closes it. */
export async function heldOperatorInput(path, expected, { privateFile, maximum }, openFile = open) {
  requireValue(privateFile === true && hashValue(expected));
  requireValue(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 2097152);
  const digest = expected;
  await trustedPath(path);
  await trustedPath(dirname(path), { directory: true, privateLeaf: true });
  const named = await lstat(path, { bigint: true });
  const fd = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    requireValue(
      identity(named) === identity(before) &&
        before.isFile() &&
        before.nlink === 1n &&
        before.size > 0n &&
        before.size <= BigInt(maximum) &&
        (before.mode & 0o022n) === 0n,
    );
    requireValue(before.uid === BigInt(process.getuid()) && (before.mode & 0o7777n) === 0o600n);
    const id = identity(before);
    async function conserve() {
      await trustedPath(path);
      await trustedPath(dirname(path), { directory: true, privateLeaf: true });
      requireValue(
        identity(await fd.stat({ bigint: true })) === id &&
          identity(await lstat(path, { bigint: true })) === id,
      );
      const raw = Buffer.alloc(Number(before.size));
      let offset = 0;
      try {
        while (offset < raw.length) {
          const { bytesRead } = await fd.read(raw, offset, raw.length - offset, offset);
          requireValue(bytesRead > 0);
          offset += bytesRead;
        }
        requireValue(
          sha(raw) === digest &&
            identity(await fd.stat({ bigint: true })) === id &&
            identity(await lstat(path, { bigint: true })) === id,
        );
        return raw;
      } catch (error) {
        raw.fill(0);
        throw error;
      }
    }
    const raw = await conserve();
    return { raw, fd, conserve, sha256: digest, path: "/proc/" + process.pid + "/fd/" + fd.fd };
  } catch (error) {
    await fd.close();
    throw error;
  }
}
