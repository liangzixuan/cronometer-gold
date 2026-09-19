import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { canonicalJson, type JsonValue, type StagedFoodRecord } from "@nutrition-tracker/ingestion";

/** A separate output ceiling; never changes the parser's reviewed spool budget. */
export const FDC_RECORD_EXPORT_MAX_BYTES = 6_000_000_000;
const EXPORT_DIRECTORY = ".local-data/evidence/fdc-csv-records";

export interface FdcRecordExportResult {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly recordCount: number;
  readonly recordsSha256: string;
}

export interface FdcRecordExport {
  append(record: StagedFoodRecord): Promise<void>;
  publish(input: {
    readonly footer: JsonValue;
    readonly expectedRecordCount: number;
    readonly expectedRecordSha256: string;
  }): Promise<FdcRecordExportResult>;
  abort(): Promise<void>;
}

interface BoundDirectory {
  readonly handle: FileHandle;
  readonly path: string;
  readonly identity: Stats;
  closed: boolean;
}

/** Provisional records have no authority. Call publish only after parser cleanup and baseline acceptance. */
export async function createFdcRecordExport(input: {
  readonly outputPath: string;
  readonly workspaceRoot: string;
  readonly header: JsonValue;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<FdcRecordExport> {
  const { outputPath, workspaceRoot, signal } = input;
  const maxBytes = input.maxBytes ?? FDC_RECORD_EXPORT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FDC_RECORD_EXPORT_MAX_BYTES) {
    throw new Error(
      "FDC record export byte budget must be positive and cannot exceed its hard ceiling",
    );
  }
  if (
    process.platform !== "linux" ||
    typeof process.getuid !== "function" ||
    !workspaceRoot.startsWith("/") ||
    resolve(workspaceRoot) !== workspaceRoot ||
    /^\/mnt\/[A-Za-z](?:\/|$)/u.test(workspaceRoot) ||
    /[\\\0]/u.test(workspaceRoot) ||
    outputPath !== join(workspaceRoot, EXPORT_DIRECTORY, basename(outputPath)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/u.test(basename(outputPath))
  ) {
    throw new Error(
      "FDC record export must use a canonical Linux path under .local-data/evidence/fdc-csv-records/<name>.ndjson",
    );
  }
  signal?.throwIfAborted();
  const userId = process.getuid();
  const directories: BoundDirectory[] = [];
  let file: FileHandle | undefined;
  let identity: Stats | undefined;
  let temporaryPath: string | undefined;
  let finalPath: string | undefined;
  let finalLinked = false;
  let linkedIdentity: Stats | undefined;
  let temporaryRemoved = false;
  let cleaned = false;
  let cleanupFailure: unknown;
  let cancelled = false;
  let state: "open" | "failed" | "aborted" | "published" = "open";
  let pending: Promise<unknown> | undefined;
  let byteSize = 0;
  let recordCount = 0;
  const fileHash = createHash("sha256");
  const recordsHash = createHash("sha256");

  function isPublished(): boolean {
    return state === "published";
  }

  function checkActive(): void {
    signal?.throwIfAborted();
    if (cancelled) throw new Error("FDC record export was aborted or used concurrently");
  }

  async function assertDirectories(): Promise<void> {
    for (const directory of directories) {
      if (
        (!directory.closed && !sameDirectory(await directory.handle.stat(), directory.identity)) ||
        !sameDirectory(await lstat(directory.path), directory.identity)
      ) {
        throw new Error("FDC record export directory identity changed");
      }
    }
    if ((await realpath(workspaceRoot)) !== workspaceRoot) {
      throw new Error("FDC record export workspace contains a symbolic link");
    }
  }

  async function writeLine(value: unknown): Promise<Buffer> {
    checkActive();
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    if (byteSize + bytes.length > maxBytes) {
      throw new Error("FDC record export exceeds its total byte budget");
    }
    if (!file) throw new Error("FDC record export file is closed");
    await file.writeFile(bytes);
    checkActive();
    byteSize += bytes.length;
    fileHash.update(bytes);
    return bytes;
  }

  let cleanupTask: Promise<void> | undefined;

  function cleanup(keepFinal: boolean): Promise<void> {
    cleanupTask ??= performCleanup(keepFinal);
    return cleanupTask;
  }

  async function performCleanup(keepFinal: boolean): Promise<void> {
    if (cleaned) {
      if (cleanupFailure !== undefined) throw cleanupFailure;
      return;
    }
    const errors: unknown[] = [];
    if (file) {
      const handle = file;
      file = undefined;
      try {
        await handle.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (identity && temporaryPath && !temporaryRemoved) {
      try {
        await removeOwnedFile(temporaryPath, identity);
        temporaryRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!keepFinal && linkedIdentity && finalPath && finalLinked) {
      try {
        await removeOwnedFile(finalPath, linkedIdentity);
        finalLinked = false;
      } catch (error) {
        errors.push(error);
      }
    }
    for (const directory of [...directories].reverse()) {
      if (!directory.closed) {
        try {
          await directory.handle.close();
          directory.closed = true;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    cleaned = true;
    if (errors.length > 0) {
      cleanupFailure = new AggregateError(
        errors,
        "FDC record export required cleanup failed; no completed export is confirmed; retained output may require inspection",
      );
      throw cleanupFailure;
    }
  }

  function run<T>(action: () => Promise<T>): Promise<T> {
    if (pending) {
      cancelled = true;
      return Promise.reject(new Error("FDC record export forbids concurrent append or publish"));
    }
    if (state !== "open") return Promise.reject(new Error(`FDC record export is ${state}`));
    const operation = (async () => {
      try {
        checkActive();
        return await action();
      } catch (error) {
        state = "failed";
        try {
          await cleanup(false);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "FDC record export and cleanup failed; no completed export is confirmed; retained output may require inspection",
            {
              cause: error,
            },
          );
        }
        throw error;
      } finally {
        pending = undefined;
      }
    })();
    pending = operation;
    return operation;
  }

  try {
    if ((await realpath(workspaceRoot)) !== workspaceRoot) {
      throw new Error("FDC record export workspace contains a symbolic link");
    }
    let current = workspaceRoot;
    for (const component of ["", ...EXPORT_DIRECTORY.split("/")]) {
      let boundPath = current;
      if (component !== "") {
        const parent = directories.at(-1);
        if (!parent) throw new Error("FDC record export parent is unavailable");
        current = join(current, component);
        boundPath = join(`/proc/self/fd/${parent.handle.fd}`, component);
        try {
          await mkdir(boundPath, { mode: 0o700 });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const handle = await open(
        boundPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      directories.push({ handle, identity: metadata, path: current, closed: false });
      if (
        !metadata.isDirectory() ||
        metadata.uid !== userId ||
        (component === "" ? (metadata.mode & 0o022) !== 0 : (metadata.mode & 0o777) !== 0o700)
      ) {
        throw new Error(
          "FDC record export directories must be current-user-owned and private (0700)",
        );
      }
      await assertDirectories();
    }
    const parent = directories.at(-1);
    if (!parent) throw new Error("FDC record export parent is unavailable");
    finalPath = join(`/proc/self/fd/${parent.handle.fd}`, basename(outputPath));
    await assertAbsent(finalPath);
    temporaryPath = join(
      `/proc/self/fd/${parent.handle.fd}`,
      `.fdc-record-export-${randomUUID()}.tmp`,
    );
    file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    identity = await file.stat();
    if (
      !identity.isFile() ||
      identity.uid !== userId ||
      (identity.mode & 0o777) !== 0o600 ||
      identity.nlink !== 1
    ) {
      throw new Error("FDC record export temporary file must be current-user-owned mode 0600");
    }
    await writeLine(input.header);
  } catch (error) {
    try {
      await cleanup(false);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "FDC record export creation failed; no completed export is confirmed; retained output may require inspection",
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  return {
    append(record) {
      return run(async () => {
        const bytes = await writeLine(record);
        recordsHash.update(bytes);
        recordCount += 1;
      });
    },
    publish({ footer, expectedRecordCount, expectedRecordSha256 }) {
      return run(async () => {
        const recordsSha256 = recordsHash.copy().digest("hex");
        if (recordCount !== expectedRecordCount || recordsSha256 !== expectedRecordSha256) {
          throw new Error(
            "FDC record export count or digest differs from accepted parser evidence",
          );
        }
        await writeLine(footer);
        const sha256 = fileHash.copy().digest("hex");
        if (!file || !identity || !temporaryPath || !finalPath)
          throw new Error("FDC record export is unavailable");
        await file.sync();
        await assertDirectories();
        const sealed = await verifyContents(
          file,
          temporaryPath,
          identity,
          byteSize,
          sha256,
          checkActive,
        );
        // Closing the writer is required before a final name can become visible.
        await file.close();
        file = undefined;
        await assertDirectories();
        if (!sameSealedFile(await lstat(temporaryPath), sealed))
          throw new Error("FDC record export temporary file changed before publication");
        checkActive();
        try {
          await link(temporaryPath, finalPath);
        } catch (error) {
          if (hasCode(error, "EEXIST"))
            throw new Error("FDC record export already exists; refusing to overwrite it");
          throw error;
        }
        finalLinked = true;
        linkedIdentity = identity;
        // link(2) has no descriptor-source variant in Node. Attribute a substituted
        // source's new hardlink before rejecting it, so rollback removes that link
        // while preserving the substituted temporary name and any final replacement.
        const linked = await lstat(finalPath);
        const sourceAfterLink = await lstat(temporaryPath);
        if (sameEntry(linked, sourceAfterLink) && linked.nlink >= 2) linkedIdentity = linked;
        await assertDirectories();
        const visible = await lstat(finalPath);
        if (
          !sameOwnedFile(visible, identity) ||
          visible.size !== byteSize ||
          visible.mtimeMs !== sealed.mtimeMs ||
          visible.nlink !== 2
        ) {
          throw new Error("FDC record export published file identity changed");
        }
        checkActive();
        await removeOwnedFile(temporaryPath, identity);
        temporaryRemoved = true;
        const parent = directories.at(-1);
        if (!parent) throw new Error("FDC record export parent is unavailable");
        await parent.handle.sync();
        await assertDirectories();
        if (!sameOwnedFile(await lstat(outputPath), identity))
          throw new Error("FDC record export visible output identity changed");
        checkActive();
        // Release other descriptors while the pinned final parent remains available for rollback.
        for (const directory of directories.slice(0, -1)) {
          await directory.handle.close();
          directory.closed = true;
        }
        await assertDirectories();
        checkActive();
        await parent.handle.close();
        parent.closed = true;
        cleaned = true;
        state = "published";
        return { path: outputPath, byteSize, sha256, recordCount, recordsSha256 };
      });
    },
    async abort() {
      if (isPublished()) return;
      cancelled = true;
      if (pending) {
        try {
          await pending;
        } catch {
          /* The caller retains the operation failure. */
        }
      }
      if (isPublished()) return;
      state = "aborted";
      await cleanup(false);
    },
  };
}

async function verifyContents(
  handle: FileHandle,
  path: string,
  identity: Stats,
  byteSize: number,
  expectedSha256: string,
  checkActive: () => void,
): Promise<Stats> {
  const before = await handle.stat();
  if (
    !sameOwnedFile(before, identity) ||
    before.nlink !== 1 ||
    before.size !== byteSize ||
    !sameSealedFile(await lstat(path), before)
  ) {
    throw new Error("FDC record export temporary file identity changed");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < byteSize) {
    checkActive();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, byteSize - offset),
      offset,
    );
    if (bytesRead === 0) throw new Error("FDC record export file was truncated");
    offset += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (
    hash.digest("hex") !== expectedSha256 ||
    !sameSealedFile(await handle.stat(), before) ||
    !sameSealedFile(await lstat(path), before)
  ) {
    throw new Error("FDC record export file content or identity changed");
  }
  return before;
}

async function removeOwnedFile(path: string, identity: Stats): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!sameEntry(before, identity))
    throw new Error("Refusing to remove a replaced FDC record export file");
  const quarantine = `${path}.${randomUUID()}.cleanup`;
  await rename(path, quarantine);
  if (!sameEntry(await lstat(quarantine), identity)) {
    // Restore the accidentally moved replacement without overwriting a new name.
    // On restoration failure retain its quarantine for explicit manual recovery.
    try {
      const replacement = await lstat(quarantine);
      await link(quarantine, path);
      if (
        !sameEntry(await lstat(path), replacement) ||
        !sameEntry(await lstat(quarantine), replacement)
      ) {
        throw new Error("FDC record export replacement restoration identity changed");
      }
      await unlink(quarantine);
    } catch (restoreError) {
      throw new AggregateError(
        [restoreError],
        "FDC record export cleanup replacement retained in quarantine",
      );
    }
    throw new Error("FDC record export cleanup identity changed; replacement restored");
  }
  if (!sameEntry(await lstat(quarantine), identity))
    throw new Error("FDC record export cleanup quarantine changed; retained");
  await unlink(quarantine);
}

function sameEntry(actual: Stats, expected: Stats): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeMs === expected.birthtimeMs &&
    actual.uid === expected.uid &&
    actual.mode === expected.mode
  );
}

function sameOwnedFile(actual: Stats, expected: Stats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeMs === expected.birthtimeMs &&
    actual.uid === expected.uid &&
    (actual.mode & 0o777) === 0o600
  );
}

function sameSealedFile(actual: Stats, expected: Stats): boolean {
  return (
    sameOwnedFile(actual, expected) &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs &&
    actual.nlink === expected.nlink
  );
}

function sameDirectory(actual: Stats, expected: Stats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeMs === expected.birthtimeMs &&
    actual.uid === expected.uid &&
    actual.mode === expected.mode
  );
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("FDC record export already exists; refusing to overwrite it");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
