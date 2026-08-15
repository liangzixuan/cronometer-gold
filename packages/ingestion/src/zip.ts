import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  /** When present, only these exact members are written. */
  readonly expectedFiles: readonly string[];
  /** Defaults to exact; required-subset must be selected explicitly for CNF documentation bundles. */
  readonly memberPolicy?: "exact" | "required-subset";
  readonly limits?: ArchiveSafetyLimits;
  readonly signal?: AbortSignal;
}

export interface ExtractedZipFile {
  readonly archivePath: string;
  readonly path: string;
  readonly byteSize: number;
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
    "At least one expected ZIP member must be selected",
  );
  throwIfAborted(options.signal);
  try {
    const destinationMetadata = await lstat(options.destinationDirectory);
    invariant(
      destinationMetadata.isDirectory() && !destinationMetadata.isSymbolicLink(),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP destination root must be a real directory",
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 });
  }
  const destinationMetadata = await lstat(options.destinationDirectory);
  invariant(
    destinationMetadata.isDirectory() && !destinationMetadata.isSymbolicLink(),
    "INVALID_ARCHIVE_ENTRY",
    "ZIP destination root changed during validation",
  );
  const destinationRoot = await realpath(options.destinationDirectory);
  const zip = await openZip(options.archivePath);
  try {
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
      destinationRoot,
      { ...options.limits, expectedFiles: options.expectedFiles },
    );
    const expected = new Set(options.expectedFiles);
    invariant(
      expected.size === options.expectedFiles.length,
      "INVALID_ARCHIVE_ENTRY",
      "Expected ZIP member list contains duplicates",
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
        .filter((entry) => expected.has(entry.archivePath))
        .map((entry) => [entry.archivePath, entry]),
    );
    const extracted: ExtractedZipFile[] = [];
    for (const item of archiveEntries) {
      throwIfAborted(options.signal);
      const entry = item.entry;
      const planned = plannedByPath.get(normalizedZipFilename(entry));
      if (!planned) {
        continue;
      }
      validateZipEntry(entry);
      await ensureSafeParent(destinationRoot, dirname(planned.archivePath));
      const output = await extractEntry(zip, entry, planned.destinationPath, options.signal);
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
        }),
      );
    }
    invariant(
      extracted.length === expected.size,
      "INVALID_ARCHIVE_ENTRY",
      "Not every expected ZIP member was extracted",
      { expected: expected.size, actual: extracted.length },
    );
    extracted.sort((left, right) =>
      left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0,
    );
    return Object.freeze(extracted);
  } finally {
    zip.close();
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
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    zip.once("error", (error) =>
      fail(
        error instanceof IngestionError
          ? error
          : new IngestionError(
              "INVALID_ARCHIVE_ENTRY",
              "ZIP archive iteration failed",
              {},
              { cause: error },
            ),
      ),
    );
    zip.once("end", () => {
      if (!settled) {
        settled = true;
        resolveIteration();
      }
    });
    zip.on("entry", (entry: Entry) => {
      void visit(entry).then(() => {
        if (!settled) {
          zip.readEntry();
        }
      }, fail);
    });
    zip.readEntry();
  });
}

function extractEntry(
  zip: ZipFile,
  entry: Entry,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<{ readonly byteSize: number }> {
  return new Promise((resolveExtraction, reject) => {
    zip.openReadStream(entry, async (openError, stream) => {
      if (openError || !stream) {
        reject(
          new IngestionError(
            "INVALID_ARCHIVE_ENTRY",
            "Unable to read ZIP member",
            {
              path: entry.fileName,
            },
            { cause: openError },
          ),
        );
        return;
      }
      const temporaryPath = join(
        dirname(destinationPath),
        `.${basename(destinationPath)}.${randomUUID()}.partial`,
      );
      let temporaryExists = false;
      const abort = (): void => {
        stream.destroy(abortError(signal));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const handle = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
          0o600,
        );
        temporaryExists = true;
        let byteSize = 0;
        try {
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
            await writeAll(handle, chunk);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        throwIfAborted(signal);
        try {
          await link(temporaryPath, destinationPath);
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
        await unlink(temporaryPath);
        temporaryExists = false;
        resolveExtraction(Object.freeze({ byteSize }));
      } catch (error) {
        if (temporaryExists) {
          await unlink(temporaryPath).catch(() => undefined);
        }
        reject(error);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    });
  });
}

async function ensureSafeParent(root: string, relativeParent: string): Promise<void> {
  if (relativeParent === ".") {
    return;
  }
  let current = root;
  for (const segment of relativeParent.split("/")) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    const metadata = await lstat(current);
    invariant(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      "INVALID_ARCHIVE_ENTRY",
      "ZIP destination parent is not a real directory",
      { path: current },
    );
  }
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
