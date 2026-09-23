import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJsonChunks, type JsonValue } from "@nutrition-tracker/db/canonical-json";

// The request includes a JSON-escaped copy of the separately capped SQL document.
// This transport limit does not increase the SQL observation/document or stage caps.
export const MAX_CATALOGUE_VALIDATION_REQUEST_BYTES = 256 * 1024 * 1024;
const REQUEST_ROOT = ".local-data/evidence/catalogue-validation";
const REQUEST_PATTERN =
  /^\.local-data\/evidence\/catalogue-validation\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/u;

export interface CatalogueValidationRequestFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export function catalogueValidationRequestPath(value: string, workspaceRoot: string): string {
  if (!REQUEST_PATTERN.test(value)) {
    throw new Error(`Validation request must name a .json file directly beneath ${REQUEST_ROOT}`);
  }
  const root = resolve(workspaceRoot);
  if (/^[A-Za-z]:/u.test(root) || /^\/mnt\/[A-Za-z](?:\/|$)/u.test(root) || root.includes("\\")) {
    throw new Error("Validation requests must reside in the Linux filesystem");
  }
  return resolve(root, value);
}

export async function assertCatalogueValidationRequestDestination(
  value: string,
  workspaceRoot: string,
): Promise<void> {
  const path = catalogueValidationRequestPath(value, workspaceRoot);
  const directory = await privateDirectory(workspaceRoot, true);
  try {
    await assertAbsent(path);
    await directory.assertUnchanged();
  } finally {
    await directory.close();
  }
}

export async function writeCatalogueValidationRequest(
  value: string,
  document: JsonValue,
  workspaceRoot: string,
): Promise<CatalogueValidationRequestFile> {
  const path = catalogueValidationRequestPath(value, workspaceRoot);
  const directory = await privateDirectory(workspaceRoot, true);
  const temporary = join(directory.path, `.request-${randomBytes(16).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownedTemporary = false;
  let failed = false;
  let failure: unknown;
  let result: CatalogueValidationRequestFile | undefined;
  try {
    await assertAbsent(path);
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    ownedTemporary = true;
    assertPrivateFile(await handle.stat());
    const digest = createHash("sha256");
    let byteSize = 0;
    for (const chunk of requestChunks(document)) {
      const bytes = Buffer.from(chunk, "utf8");
      byteSize += bytes.length;
      if (byteSize > MAX_CATALOGUE_VALIDATION_REQUEST_BYTES) {
        throw new Error("Validation request exceeds the bounded transport limit");
      }
      digest.update(bytes);
      await handle.writeFile(bytes);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await directory.assertUnchanged();
    await link(temporary, path); // Exclusive publication: never replace a retained request.
    result = { path: value, sha256: digest.digest("hex"), byteSize };
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  if (handle) await handle.close().catch((error: unknown) => cleanupErrors.push(error));
  if (ownedTemporary) {
    await unlink(temporary).catch((error: unknown) => cleanupErrors.push(error));
  }
  await directory.sync().catch((error: unknown) => cleanupErrors.push(error));
  await directory.assertUnchanged().catch((error: unknown) => cleanupErrors.push(error));
  await directory.close().catch((error: unknown) => cleanupErrors.push(error));
  if (failed || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(failed ? [failure] : []), ...cleanupErrors],
      "Validation request publication failed; preserve any existing destination for inspection",
    );
  }
  if (!result) throw new Error("Validation request publication was not confirmed");
  return result;
}

export async function readCatalogueValidationRequest(
  value: string,
  expected: { readonly sha256: string; readonly byteSize: number },
  workspaceRoot: string,
): Promise<unknown> {
  const path = catalogueValidationRequestPath(value, workspaceRoot);
  if (
    !/^[0-9a-f]{64}$/u.test(expected.sha256) ||
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize <= 0 ||
    expected.byteSize > MAX_CATALOGUE_VALIDATION_REQUEST_BYTES
  ) {
    throw new Error(
      "Validation request requires exact lowercase SHA-256 and bounded byte-size pins",
    );
  }
  const directory = await privateDirectory(workspaceRoot, false);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    assertPrivateFile(before);
    if (before.size !== expected.byteSize) throw new Error("Validation request byte size changed");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, expected.byteSize - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.byteSize) throw new Error("Validation request grew while reading");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const pathname = await lstat(path);
    assertPrivateFile(after);
    assertPrivateFile(pathname);
    if (
      !sameFile(before, after) ||
      !sameFile(before, pathname) ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      total !== expected.byteSize
    ) {
      throw new Error("Validation request changed while reading");
    }
    await directory.assertUnchanged();
    const bytes = Buffer.concat(chunks, total);
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("Validation request SHA-256 does not match the reviewed pin");
    }
    let document: JsonValue;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JsonValue;
    } catch {
      throw new Error("Validation request must contain valid UTF-8 JSON");
    }
    const canonicalDigest = createHash("sha256");
    let canonicalBytes = 1;
    for (const chunk of canonicalJsonChunks(document)) {
      canonicalDigest.update(chunk, "utf8");
      canonicalBytes += Buffer.byteLength(chunk, "utf8");
    }
    canonicalDigest.update("\n");
    if (canonicalBytes !== total || canonicalDigest.digest("hex") !== expected.sha256) {
      throw new Error("Validation request must preserve its exact canonical document and newline");
    }
    return document;
  } finally {
    try {
      await handle?.close();
    } finally {
      await directory.close();
    }
  }
}

async function privateDirectory(workspaceRoot: string, create: boolean) {
  const root = resolve(workspaceRoot);
  catalogueValidationRequestPath(`${REQUEST_ROOT}/probe.json`, root);
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Validation request storage requires a Linux user identity");
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root
  ) {
    throw new Error(
      "Validation request workspace must be a real current-user-owned trusted directory",
    );
  }
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const directories: { path: string; stat: Stats; handle: Awaited<ReturnType<typeof open>> }[] = [];
  const handles = [rootHandle];
  try {
    if (!sameFile(rootStat, await rootHandle.stat()))
      throw new Error("Validation workspace changed while opening");
    let path = root;
    for (const part of REQUEST_ROOT.split("/")) {
      path = join(path, part);
      if (create) {
        await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      const stat = await handle.stat();
      directories.push({ path, stat, handle });
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
        throw new Error("Validation request directories must be current-user-owned mode 0700");
      }
      if (!sameFile(stat, await lstat(path)) || (await realpath(path)) !== path) {
        throw new Error("Validation request directory identity changed");
      }
    }
    const last = directories.at(-1);
    if (!last) throw new Error("Validation request directory unavailable");
    return {
      path: last.path,
      async assertUnchanged() {
        if (!sameFile(rootStat, await lstat(root)) || (await realpath(root)) !== root) {
          throw new Error("Validation request workspace identity changed");
        }
        for (const item of directories) {
          const stat = await lstat(item.path);
          if (
            !sameFile(item.stat, stat) ||
            !stat.isDirectory() ||
            stat.uid !== uid ||
            (stat.mode & 0o777) !== 0o700 ||
            (await realpath(item.path)) !== item.path
          )
            throw new Error("Validation request directory changed");
        }
      },
      async sync() {
        // Sync the complete newly-created directory chain, including its workspace parent.
        for (const handle of [...handles].reverse()) await handle.sync();
      },
      async close() {
        const results = await Promise.allSettled(handles.map((handle) => handle.close()));
        const failures = results.flatMap((item) =>
          item.status === "rejected" ? [item.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Validation request directory cleanup failed");
      },
    };
  } catch (error) {
    const results = await Promise.allSettled(handles.map((handle) => handle.close()));
    const failures = results.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
    if (failures.length)
      throw new AggregateError([error, ...failures], "Validation directory setup failed");
    throw error;
  }
}

function assertPrivateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1
  )
    throw new Error(
      "Validation request must be a current-user-owned mode-0600 regular file with one link",
    );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && !right.isSymbolicLink();
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Validation request already exists; refusing to overwrite it");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function* requestChunks(document: JsonValue): Generator<string> {
  yield* canonicalJsonChunks(document);
  yield "\n";
}
