import { lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export type PrivateSpoolPrefix = "nutrition-account-export-" | "nutrition-artifact-read-";

export async function cleanupOrphanedPrivateSpools(input: {
  readonly directory: string;
  readonly prefix: PrivateSpoolPrefix;
  readonly olderThanMs: number;
  readonly clock?: () => Date;
  readonly ownerUid?: number;
  readonly maximumEntries?: number;
}): Promise<{ readonly inspected: number; readonly removed: number }> {
  const root = resolve(input.directory);
  if (
    !isAbsolute(input.directory) ||
    root !== input.directory ||
    root === parse(root).root ||
    !Number.isSafeInteger(input.olderThanMs) ||
    input.olderThanMs < 60_000
  ) {
    throw new TypeError("Invalid authenticated artifact spool cleanup boundary");
  }
  const maximumEntries = input.maximumEntries ?? 1_000;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 10_000) {
    throw new RangeError("Invalid authenticated artifact spool cleanup entry bound");
  }
  const ownerUid = input.ownerUid ?? process.getuid?.();
  const cutoff = (input.clock ?? (() => new Date()))().getTime() - input.olderThanMs;
  const entries = (await readdir(root)).slice(0, maximumEntries);
  let inspected = 0;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(input.prefix) || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
    inspected += 1;
    const path = resolve(join(root, name));
    if (!path.startsWith(`${root}${sep}`)) throw new TypeError("Invalid orphan spool path");
    const details = await lstat(path).catch(() => null);
    if (
      !details?.isDirectory() ||
      details.isSymbolicLink() ||
      (ownerUid !== undefined && details.uid !== ownerUid) ||
      details.mtimeMs >= cutoff
    ) {
      continue;
    }
    await rm(path, { force: true, recursive: true });
    removed += 1;
  }
  return { inspected, removed };
}

export async function cleanupOrphanedAuthenticatedArtifactSpools(
  input: Omit<Parameters<typeof cleanupOrphanedPrivateSpools>[0], "prefix">,
): Promise<{ readonly inspected: number; readonly removed: number }> {
  return cleanupOrphanedPrivateSpools({ ...input, prefix: "nutrition-artifact-read-" });
}
