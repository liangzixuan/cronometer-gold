import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import {
  type ArchiveEntryDescriptor,
  type ArchiveSafetyLimits,
  planArchiveExtraction,
} from "./archive.js";
import { abortError, IngestionError, invariant } from "./errors.js";

export interface ExtractZipOptions {
  readonly archivePath: string;
  readonly destinationDirectory: string;
  /** Full regular-file inventory for exact mode; required members for required-subset mode. */
  readonly expectedFiles: readonly string[];
  /** Members to write after the complete archive passes preflight. Defaults to expectedFiles. */
  readonly selectedFiles?: readonly string[];
  /** Defaults to exact; required-subset is retained for callers without a full inventory. */
  readonly memberPolicy?: "exact" | "required-subset";
  readonly limits?: ArchiveSafetyLimits;
  readonly signal?: AbortSignal;
}

export interface ExtractedZipFile {
  readonly archivePath: string;
  readonly path: string;
  readonly byteSize: number;
  /** Extractor-bound identity and content proof for post-return consumers. */
  readonly identity: ExtractedZipFileIdentity;
}

export interface ExtractedZipFileIdentity {
  readonly birthtimeMs: number;
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly sha256: string;
  readonly size: number;
  readonly uid: number;
}

interface FileIdentity {
  readonly birthtimeMs: number;
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly sha256: string | null;
  readonly size: number;
  readonly uid: number;
}

interface OwnedExtractionPath {
  active: boolean;
  readonly archivePath: string;
  boundPath: string;
  identity: FileIdentity;
  readonly kind: "final" | "temporary";
  readonly publicPath: string;
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly uid: number;
}

interface BoundDirectory {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly identity: DirectoryIdentity;
  readonly key: string;
  readonly publicPath: string;
}

interface ExtractionAttempt {
  readonly cleanupErrors: Error[];
  readonly createdPaths: OwnedExtractionPath[];
  readonly directories: Map<string, BoundDirectory>;
}

/**
 * Two-pass, lazy ZIP extraction: all central-directory entries are preflighted
 * before selected members are streamed to atomic, no-replace destination files.
 */
export async function extractZipArchive(
  options: ExtractZipOptions,
): Promise<readonly ExtractedZipFile[]> {
  invariant(
    options.expectedFiles.length > 0,
    "INVALID_ARCHIVE_ENTRY",
    "At least one expected ZIP member must be declared",
  );
  const expected = new Set(options.expectedFiles);
  invariant(
    expected.size === options.expectedFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "Expected ZIP member list contains duplicates",
  );
  const selectedFiles = options.selectedFiles ?? options.expectedFiles;
  const selected = new Set(selectedFiles);
  invariant(
    selected.size === selectedFiles.length,
    "INVALID_ARCHIVE_ENTRY",
    "Selected ZIP member list contains duplicates",
  );
  for (const selectedFile of selected) {
    invariant(
      expected.has(selectedFile),
      "INVALID_ARCHIVE_ENTRY",
      "Selected ZIP members must be a subset of the expected inventory",
      { path: selectedFile },
    );
  }
  throwIfAborted(options.signal);
  const destination = await prepareTrustedDestination(options.destinationDirectory);
  const attempt: ExtractionAttempt = {
    cleanupErrors: [],
    createdPaths: [],
    directories: new Map([[".", destination]]),
  };
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(options.archivePath);
    const maxEntries = options.limits?.maxEntries ?? 20_000;
    invariant(
      zip.entryCount <= maxEntries,
      "ARCHIVE_LIMIT_EXCEEDED",
      `ZIP contains more than ${maxEntries} entries`,
      { actual: zip.entryCount },
    );
    const archiveEntries = await enumerateOpenZip(zip, options.signal);
    const plan = planArchiveExtraction(
      archiveEntries.map((item) => item.descriptor),
      destination.publicPath,
      { ...options.limits, expectedFiles: options.expectedFiles },
    );
    if ((options.memberPolicy ?? "exact") === "exact") {
      invariant(
        plan.entries.length === expected.size &&
          plan.entries.every((entry) => expected.has(entry.archivePath)),
        "INVALID_ARCHIVE_ENTRY",
        "ZIP file set must exactly match the expected members",
        { expected: expected.size, actual: plan.entries.length },
      );
    }
    const plannedByPath = new Map(
      plan.entries
        .filter((entry) => selected.has(entry.archivePath))
        .map((entry) => [entry.archivePath, entry]),
    );
    const extracted: ExtractedZipFile[] = [];
    for (const item of archiveEntries) {
      throwIfAborted(options.signal);
      await assertBoundDirectory(destination);
      const entry = item.entry;
      const planned = plannedByPath.get(normalizedZipFilename(entry));
      if (!planned) {
        continue;
      }
      validateZipEntry(entry);
      const parent = await ensureSafeParent(attempt, destination, dirname(planned.archivePath));
      const output = await extractEntry(
        zip,
        entry,
        parent,
        planned.destinationPath,
        attempt,
        options.signal,
      );
      invariant(
        output.byteSize === planned.uncompressedSize,
        "INVALID_ARCHIVE_ENTRY",
        "Extracted ZIP member size differs from the central directory",
        { path: planned.archivePath, expected: planned.uncompressedSize, actual: output.byteSize },
      );
      extracted.push(
        Object.freeze({
          archivePath: planned.archivePath,
          path: planned.destinationPath,
          byteSize: output.byteSize,
          identity: output.identity,
        }),
      );
    }
    invariant(
      extracted.length === selected.size,
      "INVALID_ARCHIVE_ENTRY",
      "Not every selected ZIP member was extracted",
      { expected: selected.size, actual: extracted.length },
    );
    await assertPublishedOutputs(extracted, attempt.createdPaths);
    await assertBoundDirectory(destination);
    extracted.sort((left, right) =>
      left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0,
    );
    const completedZip = zip;
    zip = undefined;
    try {
      await closeOpenZip(completedZip);
    } catch (error) {
      throw cleanupFailure("Unable to close the ZIP archive after extraction completed", {}, error);
    }
    const directoryCloseErrors = await closeAttemptDirectories(attempt);
    if (directoryCloseErrors.length > 0) {
      attempt.cleanupErrors.push(...directoryCloseErrors);
      try {
        await rebindActiveOwnedPaths(attempt);
      } catch (error) {
        attempt.cleanupErrors.push(
          cleanupFailure(
            "Unable to rebind ZIP outputs after destination-handle close failed",
            {},
            error,
          ),
        );
      }
      throw new IngestionError(
        "INVALID_ARCHIVE_ENTRY",
        "ZIP extraction could not close every bound destination handle",
        {},
        { cause: directoryCloseErrors[0] },
      );
    }
    return Object.freeze(extracted);
  } catch (operationError) {
    const cleanupErrors = [
      ...attempt.cleanupErrors,
      ...(await rollbackCreatedPaths(attempt.createdPaths)),
    ];
    if (zip) {
      const failedZip = zip;
      zip = undefined;
      try {
        await closeOpenZip(failedZip);
      } catch (error) {
        cleanupErrors.push(
          cleanupFailure("Unable to close the ZIP archive after extraction failed", {}, error),
        );
      }
    }
    cleanupErrors.push(...(await closeAttemptDirectories(attempt)));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "ZIP extraction failed and rollback was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

async function enumerateOpenZip(
  zip: ZipFile,
  signal?: AbortSignal,
): Promise<readonly { readonly descriptor: ArchiveEntryDescriptor; readonly entry: Entry }[]> {
  const entries: { readonly descriptor: ArchiveEntryDescriptor; readonly entry: Entry }[] = [];
  await forEachEntry(zip, async (entry) => {
    throwIfAborted(signal);
    validateZipEntry(entry);
    const filename = normalizedZipFilename(entry);
    entries.push(
      Object.freeze({
        entry,
        descriptor: Object.freeze({
          path: filename,
          type: zipEntryType(entry),
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
        }),
      }),
    );
  });
  return Object.freeze(entries);
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(
            new IngestionError(
              "INVALID_ARCHIVE_ENTRY",
              "Unable to open ZIP archive",
              { path },
              {
                cause: error,
              },
            ),
          );
          return;
        }
        resolveOpen(zipfile);
      },
    );
  });
}

function forEachEntry(zip: ZipFile, visit: (entry: Entry) => Promise<void>): Promise<void> {
  return new Promise((resolveIteration, reject) => {
    let settled = false;
    const cleanup = (): void => {
      zip.off("error", onError);
      zip.off("end", onEnd);
      zip.off("entry", onEntry);
    };
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const failIteration = (error: unknown): void =>
      fail(
        error instanceof IngestionError
          ? error
          : new IngestionError(
              "INVALID_ARCHIVE_ENTRY",
              "ZIP archive iteration failed",
              {},
              { cause: error },
            ),
      );
    const onError = (error: unknown): void => {
      failIteration(error);
    };
    const onEnd = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolveIteration();
      }
    };
    const onEntry = (entry: Entry): void => {
      void visit(entry).then(() => {
        if (!settled) {
          try {
            zip.readEntry();
          } catch (error) {
            failIteration(error);
          }
        }
      }, failIteration);
    };
    zip.once("error", onError);
    zip.once("end", onEnd);
    zip.on("entry", onEntry);
    try {
      zip.readEntry();
    } catch (error) {
      failIteration(error);
    }
  });
}

function closeOpenZip(zip: ZipFile): Promise<void> {
  return new Promise((resolveClose, reject) => {
    const reader = (zip as ZipFile & { readonly reader: EventEmitter }).reader;
    let settled = false;
    const cleanup = (): void => {
      zip.off("error", onZipError);
      reader.off("close", onReaderClose);
      reader.off("error", onReaderError);
    };
    const onReaderClose = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolveClose();
      }
    };
    const onReaderError = (error: unknown): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    // The reader forwards close errors through ZipFile.emitError(), but that
    // forwarding is suppressed after an earlier ZIP error. Keep a temporary
    // ZipFile listener to prevent an unhandled EventEmitter error and settle
    // from the reader's authoritative one-shot close/error events instead.
    const onZipError = (): void => {};
    zip.on("error", onZipError);
    reader.once("close", onReaderClose);
    reader.once("error", onReaderError);
    try {
      zip.close();
    } catch (error) {
      onReaderError(error);
    }
  });
}

async function extractEntry(
  zip: ZipFile,
  entry: Entry,
  parent: BoundDirectory,
  destinationPath: string,
  attempt: ExtractionAttempt,
  signal?: AbortSignal,
): Promise<{ readonly byteSize: number; readonly identity: ExtractedZipFileIdentity }> {
  await assertBoundDirectory(parent);
  const stream = await openZipEntryStream(zip, entry);
  const outputName = basename(destinationPath);
  const temporaryName = `.${outputName}.${randomUUID()}.partial`;
  const temporaryBoundPath = join(boundDirectoryPath(parent), temporaryName);
  const destinationBoundPath = join(boundDirectoryPath(parent), outputName);
  const temporaryPublicPath = join(parent.publicPath, temporaryName);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: OwnedExtractionPath | undefined;
  let published: OwnedExtractionPath | undefined;
  let byteSize = 0;
  let writtenSha256: string | undefined;
  let operationError: unknown;
  let result:
    | { readonly byteSize: number; readonly identity: ExtractedZipFileIdentity }
    | undefined;
  const abort = (): void => {
    stream.destroy(abortError(signal));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    handle = await open(
      temporaryBoundPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    const initialMetadata = await handle.stat();
    temporary = {
      active: true,
      archivePath: entry.fileName,
      boundPath: temporaryBoundPath,
      identity: fileIdentity(initialMetadata, null),
      kind: "temporary",
      publicPath: temporaryPublicPath,
    };
    attempt.createdPaths.push(temporary);
    assertNewTemporary(initialMetadata, temporaryBoundPath);

    const streamedHash = createHash("sha256");
    for await (const rawChunk of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      byteSize += chunk.byteLength;
      invariant(
        byteSize <= entry.uncompressedSize,
        "INVALID_ARCHIVE_ENTRY",
        "ZIP member exceeded its declared size while extracting",
        { path: entry.fileName, byteSize, declared: entry.uncompressedSize },
      );
      streamedHash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
    writtenSha256 = streamedHash.digest("hex");
    const completedMetadata = await handle.stat();
    assertFileTransition(
      completedMetadata,
      temporary.identity,
      1,
      byteSize,
      "ZIP temporary output changed before publication",
      temporaryBoundPath,
    );
    temporary.identity = fileIdentity(completedMetadata, writtenSha256);
    invariant(
      (await hashFileHandle(handle, byteSize)) === writtenSha256,
      "INVALID_ARCHIVE_ENTRY",
      "ZIP temporary output content differs from streamed bytes",
      { path: entry.fileName },
    );
    throwIfAborted(signal);

    try {
      await link(temporaryBoundPath, destinationBoundPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "ZIP extraction refuses to overwrite an existing destination",
          { path: destinationPath },
          { cause: error },
        );
      }
      throw error;
    }
    published = {
      active: true,
      archivePath: entry.fileName,
      boundPath: destinationBoundPath,
      identity: temporary.identity,
      kind: "final",
      publicPath: destinationPath,
    };
    attempt.createdPaths.push(published);
    const linkedMetadata = await handle.stat();
    assertFileTransition(
      linkedMetadata,
      temporary.identity,
      2,
      byteSize,
      "Published ZIP output is not the exact temporary inode",
      destinationPath,
    );
    temporary.identity = fileIdentity(linkedMetadata, writtenSha256);
    published.identity = temporary.identity;
    await assertExactOwnedPath(temporary);
    await assertExactOwnedPath(published);
    await assertPublicPath(published);

    throwIfAborted(signal);
    await assertExactOwnedPath(temporary);
    await assertExactOwnedPath(published);
    const beforeRemoval = await handle.stat();
    invariant(
      isSameOwnedFile(beforeRemoval, published.identity),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP output changed before temporary-link removal",
      { path: entry.fileName },
    );
    invariant(
      (await hashFileHandle(handle, byteSize)) === writtenSha256,
      "INVALID_ARCHIVE_ENTRY",
      "ZIP output content changed before temporary-link removal",
      { path: entry.fileName },
    );
    await removeExactOwnedPath(temporary, attempt.createdPaths);

    const finalMetadata = await handle.stat();
    assertFileTransition(
      finalMetadata,
      published.identity,
      1,
      byteSize,
      "Published ZIP output changed after temporary-link removal",
      destinationPath,
    );
    published.identity = fileIdentity(finalMetadata, writtenSha256);
    await assertExactOwnedPath(published);
    await assertPublicPath(published);
    invariant(
      (await hashFileHandle(handle, byteSize)) === writtenSha256,
      "INVALID_ARCHIVE_ENTRY",
      "Published ZIP output content differs from streamed bytes",
      { path: entry.fileName },
    );
    result = Object.freeze({
      byteSize,
      identity: publicFileIdentity(published.identity),
    });
  } catch (error) {
    operationError = error;
    if (handle && published && writtenSha256 !== undefined) {
      try {
        const handleMetadata = await handle.stat();
        invariant(
          sameFileCore(handleMetadata, published.identity) &&
            (await hashFileHandle(handle, byteSize)) === writtenSha256,
          "INVALID_ARCHIVE_ENTRY",
          "Cannot recover the published ZIP inode after extraction failed",
          { path: destinationPath },
        );
        for (const candidate of attempt.createdPaths) {
          if (!candidate.active || !sameInode(candidate.identity, published.identity)) {
            continue;
          }
          try {
            const metadata = await lstat(candidate.boundPath);
            if (sameFileCore(metadata, published.identity)) {
              candidate.identity = fileIdentity(metadata, writtenSha256);
            }
          } catch (recoveryError) {
            if (isNotFound(recoveryError)) {
              candidate.active = false;
            } else {
              throw recoveryError;
            }
          }
        }
      } catch (recoveryError) {
        attempt.cleanupErrors.push(
          cleanupFailure(
            "Unable to refresh a bound ZIP output identity after extraction failed",
            { path: destinationPath },
            recoveryError,
          ),
        );
      }
    }
    if (handle && !temporary) {
      try {
        const handleMetadata = await handle.stat();
        const pathMetadata = await lstat(temporaryBoundPath);
        const recoveredIdentity = fileIdentity(handleMetadata, null);
        invariant(
          handleMetadata.isFile() &&
            handleMetadata.uid === currentUserId() &&
            handleMetadata.nlink === 1 &&
            isSameOwnedFile(pathMetadata, recoveredIdentity),
          "INVALID_ARCHIVE_ENTRY",
          "Cannot bind the ZIP temporary pathname to its open handle after fstat failed",
          { path: temporaryPublicPath },
        );
        temporary = {
          active: true,
          archivePath: entry.fileName,
          boundPath: temporaryBoundPath,
          identity: recoveredIdentity,
          kind: "temporary",
          publicPath: temporaryPublicPath,
        };
        attempt.createdPaths.push(temporary);
      } catch (registrationError) {
        attempt.cleanupErrors.push(
          cleanupFailure(
            "Unable to register a ZIP temporary output after post-open validation failed",
            { path: temporaryPublicPath },
            registrationError,
          ),
        );
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  let closeError: unknown;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined) {
    if (closeError !== undefined) {
      attempt.cleanupErrors.push(
        cleanupFailure(
          "Unable to close a ZIP temporary output after extraction failed",
          { path: temporaryPublicPath },
          closeError,
        ),
      );
    }
    throw operationError;
  }
  if (closeError !== undefined) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to close the exact ZIP output after publication",
      { path: destinationPath },
      { cause: closeError },
    );
  }
  invariant(result, "INVALID_ARCHIVE_ENTRY", "ZIP extraction produced no result", {
    path: entry.fileName,
  });
  return result;
}

function openZipEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new IngestionError(
            "INVALID_ARCHIVE_ENTRY",
            "Unable to read ZIP member",
            { path: entry.fileName },
            { cause: error },
          ),
        );
        return;
      }
      resolveStream(stream);
    });
  });
}

async function ensureSafeParent(
  attempt: ExtractionAttempt,
  root: BoundDirectory,
  relativeParent: string,
): Promise<BoundDirectory> {
  await assertBoundDirectory(root);
  if (relativeParent === ".") {
    return root;
  }
  let current = root;
  let key = "";
  for (const segment of relativeParent.split("/")) {
    key = key.length === 0 ? segment : `${key}/${segment}`;
    const cached = attempt.directories.get(key);
    if (cached) {
      await assertBoundDirectory(cached);
      current = cached;
      continue;
    }
    await assertBoundDirectory(current);
    const childBoundPath = join(boundDirectoryPath(current), segment);
    try {
      await mkdir(childBoundPath, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    const childHandle = await open(
      childBoundPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const publicPath = join(root.publicPath, ...key.split("/"));
    try {
      const metadata = await childHandle.stat();
      assertPrivateDirectory(
        metadata,
        currentUserId(),
        publicPath,
        "ZIP destination parent is not a private current-user directory",
      );
      const publicMetadata = await lstat(publicPath);
      invariant(
        sameDirectory(publicMetadata, metadata),
        "INVALID_ARCHIVE_ENTRY",
        "ZIP destination parent changed while its handle was opened",
        { path: publicPath },
      );
      const child: BoundDirectory = Object.freeze({
        handle: childHandle,
        identity: directoryIdentity(metadata),
        key,
        publicPath,
      });
      attempt.directories.set(key, child);
      current = child;
    } catch (operationError) {
      try {
        await childHandle.close();
      } catch (error) {
        const closeError = cleanupFailure(
          "Unable to close an invalid ZIP destination parent directory",
          { path: publicPath },
          error,
        );
        throw new AggregateError(
          [operationError, closeError],
          "ZIP destination-parent validation and handle cleanup both failed",
          { cause: operationError },
        );
      }
      throw operationError;
    }
  }
  return current;
}

async function prepareTrustedDestination(path: string): Promise<BoundDirectory> {
  try {
    await lstat(path);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const uid = currentUserId();
  const directMetadata = await lstat(path);
  assertPrivateDirectory(directMetadata, uid, path, "ZIP destination root is not trusted");
  const canonicalPath = await realpath(path);
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    assertPrivateDirectory(
      metadata,
      uid,
      canonicalPath,
      "ZIP destination root changed while its handle was opened",
    );
    invariant(
      sameDirectory(directMetadata, metadata),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP destination root identity changed during canonicalization",
      { path },
    );
    await realpath(boundDirectoryPath({ handle } as BoundDirectory));
    return Object.freeze({
      handle,
      identity: directoryIdentity(metadata),
      key: ".",
      publicPath: canonicalPath,
    });
  } catch (operationError) {
    try {
      await handle.close();
    } catch (error) {
      const closeError = cleanupFailure(
        "Unable to close an invalid ZIP destination root directory",
        { path: canonicalPath },
        error,
      );
      throw new AggregateError(
        [operationError, closeError],
        "ZIP destination-root validation and handle cleanup both failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

async function assertPublishedOutputs(
  extracted: readonly ExtractedZipFile[],
  createdPaths: readonly OwnedExtractionPath[],
): Promise<void> {
  for (const file of extracted) {
    const published = createdPaths.find(
      (candidate) =>
        candidate.active && candidate.kind === "final" && candidate.publicPath === file.path,
    );
    invariant(
      published,
      "INVALID_ARCHIVE_ENTRY",
      "ZIP extraction lost ownership evidence for a published output",
      { path: file.archivePath },
    );
    invariant(
      samePublicIdentity(published.identity, file.identity),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP extraction result identity differs from its published output",
      { path: file.archivePath },
    );
    await assertExactOwnedPath(published);
    await assertPublicPath(published);
    invariant(
      (await hashOwnedPath(published)) === published.identity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Published ZIP output content changed before extraction completed",
      { path: file.archivePath },
    );
  }
}

async function assertBoundDirectory(directory: BoundDirectory): Promise<void> {
  const handleMetadata = await directory.handle.stat();
  invariant(
    sameDirectoryIdentity(handleMetadata, directory.identity),
    "INVALID_ARCHIVE_ENTRY",
    "Bound ZIP destination directory changed during extraction",
    { path: directory.publicPath },
  );
  const publicMetadata = await lstat(directory.publicPath);
  invariant(
    sameDirectory(publicMetadata, handleMetadata),
    "INVALID_ARCHIVE_ENTRY",
    "ZIP destination directory path no longer names its bound inode",
    { path: directory.publicPath },
  );
}

function assertPrivateDirectory(metadata: Stats, uid: number, path: string, message: string): void {
  invariant(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === uid &&
      (metadata.mode & 0o777) === 0o700,
    "INVALID_ARCHIVE_ENTRY",
    message,
    { path },
  );
}

async function rollbackCreatedPaths(
  createdPaths: OwnedExtractionPath[],
): Promise<readonly Error[]> {
  const errors: Error[] = [];
  for (let index = createdPaths.length - 1; index >= 0; index -= 1) {
    const ownedPath = createdPaths[index];
    if (!ownedPath?.active) {
      continue;
    }
    try {
      await removeExactOwnedPath(ownedPath, createdPaths);
    } catch (error) {
      errors.push(
        cleanupFailure(
          "Unable to remove an exact ZIP extraction output during rollback",
          {
            archivePath: ownedPath.archivePath,
            kind: ownedPath.kind,
            path: ownedPath.publicPath,
          },
          error,
        ),
      );
    }
  }
  return Object.freeze(errors);
}

async function removeExactOwnedPath(
  ownedPath: OwnedExtractionPath,
  createdPaths: readonly OwnedExtractionPath[],
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(ownedPath.boundPath);
  } catch (error) {
    if (isNotFound(error)) {
      ownedPath.active = false;
      return;
    }
    throw error;
  }
  invariant(
    isSameOwnedFile(metadata, ownedPath.identity),
    "INVALID_ARCHIVE_ENTRY",
    "Refusing to remove a replaced ZIP extraction output",
    { path: ownedPath.publicPath },
  );
  const matchingLinks = await countMatchingOwnedPaths(createdPaths, ownedPath.identity);
  invariant(
    metadata.nlink === matchingLinks,
    "INVALID_ARCHIVE_ENTRY",
    "Refusing to remove a ZIP output with an unowned hard link",
    { path: ownedPath.publicPath, expected: matchingLinks, actual: metadata.nlink },
  );
  if (ownedPath.identity.sha256 !== null) {
    invariant(
      (await hashOwnedPath(ownedPath)) === ownedPath.identity.sha256,
      "INVALID_ARCHIVE_ENTRY",
      "Refusing to remove a ZIP output whose content changed",
      { path: ownedPath.publicPath },
    );
  }

  const quarantinePath = join(
    dirname(ownedPath.boundPath),
    `.${basename(ownedPath.publicPath)}.${randomUUID()}.quarantine`,
  );
  await rename(ownedPath.boundPath, quarantinePath);
  try {
    const quarantinedMetadata = await lstat(quarantinePath);
    if (!sameFileAfterRename(quarantinedMetadata, ownedPath.identity, matchingLinks)) {
      throw new IngestionError(
        "INVALID_ARCHIVE_ENTRY",
        "ZIP output identity changed while moving it to cleanup quarantine",
        { path: ownedPath.publicPath },
      );
    }
    if (ownedPath.identity.sha256 !== null) {
      const quarantined: OwnedExtractionPath = {
        ...ownedPath,
        boundPath: quarantinePath,
        identity: fileIdentity(quarantinedMetadata, ownedPath.identity.sha256),
      };
      if ((await hashOwnedPath(quarantined)) !== ownedPath.identity.sha256) {
        throw new IngestionError(
          "INVALID_ARCHIVE_ENTRY",
          "ZIP output content changed while moving it to cleanup quarantine",
          { path: ownedPath.publicPath },
        );
      }
    }
    const immediatelyBeforeUnlink = await lstat(quarantinePath);
    invariant(
      sameFileAfterRename(immediatelyBeforeUnlink, ownedPath.identity, matchingLinks),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP cleanup quarantine changed before removal",
      { path: ownedPath.publicPath },
    );
    await unlink(quarantinePath);
  } catch (error) {
    try {
      await restoreQuarantinedReplacement(quarantinePath, ownedPath.boundPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "ZIP cleanup quarantine verification failed and the original path could not be restored",
        { cause: error },
      );
    }
    throw error;
  }
  ownedPath.active = false;
  await refreshOwnedSiblings(createdPaths, ownedPath.identity);
}

async function restoreQuarantinedReplacement(
  quarantinePath: string,
  originalPath: string,
): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Unable to restore a replaced ZIP output from cleanup quarantine",
      { quarantinePath },
      { cause: error },
    );
  }
}

async function refreshOwnedSiblings(
  createdPaths: readonly OwnedExtractionPath[],
  removedIdentity: FileIdentity,
): Promise<void> {
  for (const candidate of createdPaths) {
    if (!candidate.active || !sameInode(candidate.identity, removedIdentity)) {
      continue;
    }
    try {
      const metadata = await lstat(candidate.boundPath);
      if (sameFileCore(metadata, candidate.identity)) {
        candidate.identity = fileIdentity(metadata, candidate.identity.sha256);
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

async function countMatchingOwnedPaths(
  createdPaths: readonly OwnedExtractionPath[],
  identity: FileIdentity,
): Promise<number> {
  let count = 0;
  for (const candidate of createdPaths) {
    if (!candidate.active || !sameInode(candidate.identity, identity)) {
      continue;
    }
    try {
      const metadata = await lstat(candidate.boundPath);
      if (sameFileCore(metadata, identity)) {
        count += 1;
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
  return count;
}

async function assertExactOwnedPath(ownedPath: OwnedExtractionPath): Promise<void> {
  const metadata = await lstat(ownedPath.boundPath);
  invariant(
    isSameOwnedFile(metadata, ownedPath.identity),
    "INVALID_ARCHIVE_ENTRY",
    "ZIP extraction output path no longer names its captured inode",
    { path: ownedPath.publicPath },
  );
}

async function assertPublicPath(ownedPath: OwnedExtractionPath): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(ownedPath.publicPath);
  } catch (error) {
    throw new IngestionError(
      "INVALID_ARCHIVE_ENTRY",
      "Public ZIP extraction path became unavailable",
      { path: ownedPath.publicPath },
      { cause: error },
    );
  }
  invariant(
    isSameOwnedFile(metadata, ownedPath.identity),
    "INVALID_ARCHIVE_ENTRY",
    "Public ZIP extraction path no longer names its bound output",
    { path: ownedPath.publicPath },
  );
}

function assertNewTemporary(metadata: Stats, path: string): void {
  invariant(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === currentUserId() &&
      (metadata.mode & 0o777) === 0o600 &&
      metadata.nlink === 1 &&
      metadata.size === 0,
    "INVALID_ARCHIVE_ENTRY",
    "New ZIP temporary output is not a private empty single-link regular file",
    { path },
  );
}

function assertFileTransition(
  metadata: Stats,
  identity: FileIdentity,
  expectedLinkCount: number,
  expectedSize: number,
  message: string,
  path: string,
): void {
  invariant(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.birthtimeMs === identity.birthtimeMs &&
      metadata.dev === identity.device &&
      metadata.ino === identity.inode &&
      metadata.uid === identity.uid &&
      (metadata.mode & 0o777) === identity.mode &&
      (identity.size !== expectedSize || metadata.mtimeMs === identity.mtimeMs) &&
      metadata.nlink === expectedLinkCount &&
      metadata.size === expectedSize,
    "INVALID_ARCHIVE_ENTRY",
    message,
    { path },
  );
}

function isSameOwnedFile(metadata: Stats, identity: FileIdentity): boolean {
  return (
    sameFileCore(metadata, identity) &&
    metadata.ctimeMs === identity.ctimeMs &&
    metadata.nlink === identity.nlink
  );
}

function sameFileCore(metadata: Stats, identity: FileIdentity): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.birthtimeMs === identity.birthtimeMs &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode &&
    metadata.mtimeMs === identity.mtimeMs &&
    metadata.size === identity.size
  );
}

function sameFileAfterRename(
  metadata: Stats,
  identity: FileIdentity,
  expectedLinkCount: number,
): boolean {
  return sameFileCore(metadata, identity) && metadata.nlink === expectedLinkCount;
}

function sameInode(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.birthtimeMs === right.birthtimeMs &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function fileIdentity(metadata: Stats, sha256: string | null): FileIdentity {
  return Object.freeze({
    birthtimeMs: metadata.birthtimeMs,
    ctimeMs: metadata.ctimeMs,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    mtimeMs: metadata.mtimeMs,
    nlink: metadata.nlink,
    sha256,
    size: metadata.size,
    uid: metadata.uid,
  });
}

function publicFileIdentity(identity: FileIdentity): ExtractedZipFileIdentity {
  invariant(identity.sha256 !== null, "INVALID_ARCHIVE_ENTRY", "ZIP content hash is unavailable");
  return Object.freeze({ ...identity, sha256: identity.sha256 });
}

function samePublicIdentity(internal: FileIdentity, published: ExtractedZipFileIdentity): boolean {
  return (
    internal.sha256 !== null &&
    internal.birthtimeMs === published.birthtimeMs &&
    internal.ctimeMs === published.ctimeMs &&
    internal.device === published.device &&
    internal.inode === published.inode &&
    internal.mode === published.mode &&
    internal.mtimeMs === published.mtimeMs &&
    internal.nlink === published.nlink &&
    internal.sha256 === published.sha256 &&
    internal.size === published.size &&
    internal.uid === published.uid
  );
}

async function hashFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < expectedSize) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    invariant(bytesRead > 0, "INVALID_ARCHIVE_ENTRY", "ZIP output read made no progress");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(trailing, 0, 1, position);
  invariant(bytesRead === 0, "INVALID_ARCHIVE_ENTRY", "ZIP output exceeds its captured size");
  return hash.digest("hex");
}

async function hashOwnedPath(ownedPath: OwnedExtractionPath): Promise<string> {
  const handle = await open(ownedPath.boundPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let digest: string | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const before = await handle.stat();
    invariant(
      isSameOwnedFile(before, ownedPath.identity),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP output changed before content verification",
      { path: ownedPath.publicPath },
    );
    digest = await hashFileHandle(handle, ownedPath.identity.size);
    const after = await handle.stat();
    invariant(
      isSameOwnedFile(after, ownedPath.identity),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP output changed during content verification",
      { path: ownedPath.publicPath },
    );
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    const closeError = cleanupFailure(
      "Unable to close a ZIP output after content verification",
      { path: ownedPath.publicPath },
      error,
    );
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        "ZIP output content verification and handle cleanup both failed",
        { cause: operationError },
      );
    }
    throw closeError;
  }
  if (operationFailed) {
    throw operationError;
  }
  invariant(digest !== undefined, "INVALID_ARCHIVE_ENTRY", "ZIP content hash is unavailable");
  return digest;
}

function directoryIdentity(metadata: Stats): DirectoryIdentity {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode & 0o777,
    uid: metadata.uid,
  });
}

function sameDirectoryIdentity(metadata: Stats, identity: DirectoryIdentity): boolean {
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    metadata.dev === identity.device &&
    metadata.ino === identity.inode &&
    metadata.uid === identity.uid &&
    (metadata.mode & 0o777) === identity.mode
  );
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    (left.mode & 0o777) === (right.mode & 0o777)
  );
}

function boundDirectoryPath(directory: Pick<BoundDirectory, "handle">): string {
  return `/proc/self/fd/${directory.handle.fd}`;
}

async function rebindActiveOwnedPaths(attempt: ExtractionAttempt): Promise<void> {
  const rebound = new Map<string, BoundDirectory>();
  try {
    for (const ownedPath of attempt.createdPaths) {
      if (!ownedPath.active) {
        continue;
      }
      const parentPath = dirname(ownedPath.publicPath);
      let directory = rebound.get(parentPath);
      if (!directory) {
        const handle = await open(
          parentPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const handleMetadata = await handle.stat();
          const publicMetadata = await lstat(parentPath);
          assertPrivateDirectory(
            handleMetadata,
            currentUserId(),
            parentPath,
            "Cannot rebind a ZIP output outside its private destination parent",
          );
          invariant(
            sameDirectory(publicMetadata, handleMetadata),
            "INVALID_ARCHIVE_ENTRY",
            "ZIP output parent changed while rebinding cleanup",
            { path: parentPath },
          );
          directory = Object.freeze({
            handle,
            identity: directoryIdentity(handleMetadata),
            key: `rebound:${parentPath}`,
            publicPath: parentPath,
          });
          rebound.set(parentPath, directory);
          attempt.directories.set(directory.key, directory);
        } catch (operationError) {
          try {
            await handle.close();
          } catch (error) {
            const closeError = cleanupFailure(
              "Unable to close an invalid rebound ZIP destination directory",
              { path: parentPath },
              error,
            );
            throw new AggregateError(
              [operationError, closeError],
              "ZIP output-parent rebinding and handle cleanup both failed",
              { cause: operationError },
            );
          }
          throw operationError;
        }
      }
      ownedPath.boundPath = join(boundDirectoryPath(directory), basename(ownedPath.publicPath));
    }
  } catch (operationError) {
    const cleanupErrors: Error[] = [];
    for (const directory of rebound.values()) {
      try {
        await directory.handle.close();
      } catch (error) {
        cleanupErrors.push(
          cleanupFailure(
            "Unable to close a rebound ZIP destination directory after rebinding failed",
            { path: directory.publicPath },
            error,
          ),
        );
      }
      attempt.directories.delete(directory.key);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        "ZIP output rebinding failed and rebound-directory cleanup was incomplete",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

async function closeAttemptDirectories(attempt: ExtractionAttempt): Promise<Error[]> {
  const errors: Error[] = [];
  const directories = [...attempt.directories.values()].reverse();
  attempt.directories.clear();
  for (const directory of directories) {
    try {
      await directory.handle.close();
    } catch (error) {
      attempt.directories.set(directory.key, directory);
      errors.push(
        cleanupFailure(
          "Unable to close a bound ZIP destination directory",
          { path: directory.publicPath },
          error,
        ),
      );
    }
  }
  return errors;
}

function cleanupFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause: unknown,
): IngestionError {
  return new IngestionError("INVALID_ARCHIVE_ENTRY", message, details, { cause });
}

function currentUserId(): number {
  invariant(
    typeof process.getuid === "function",
    "INVALID_ARCHIVE_ENTRY",
    "ZIP extraction requires POSIX ownership verification under Linux/WSL",
  );
  return process.getuid();
}

function validateZipEntry(entry: Entry): void {
  invariant(
    (entry.generalPurposeBitFlag & 0x1) === 0,
    "INVALID_ARCHIVE_ENTRY",
    "Encrypted ZIP members are not supported",
    { path: entry.fileName },
  );
  normalizedZipFilename(entry);
}

function normalizedZipFilename(entry: Entry): string {
  invariant(typeof entry.fileName === "string", "INVALID_ARCHIVE_ENTRY", "ZIP filename is invalid");
  return entry.fileName;
}

function zipEntryType(entry: Entry): ArchiveEntryDescriptor["type"] {
  const isDirectoryName = entry.fileName.endsWith("/");
  const platform = entry.versionMadeBy >>> 8;
  if (platform !== 3) {
    return isDirectoryName ? "directory" : "file";
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    return "symlink";
  }
  if (fileType === 0o040000 || isDirectoryName) {
    return "directory";
  }
  if (fileType === 0 || fileType === 0o100000) {
    return "file";
  }
  return "hardlink";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    invariant(
      result.bytesWritten > 0,
      "INVALID_ARCHIVE_ENTRY",
      "ZIP output write made no progress",
    );
    offset += result.bytesWritten;
  }
}
