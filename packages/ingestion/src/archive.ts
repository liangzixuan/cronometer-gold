import { resolve, sep } from "node:path";
import { compareCodePoints } from "./deterministic.js";
import { IngestionError, invariant } from "./errors.js";

export interface ArchiveEntryDescriptor {
  readonly path: string;
  readonly type: "directory" | "file" | "hardlink" | "symlink";
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface ArchiveSafetyLimits {
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxCompressionRatio?: number;
  readonly expectedFiles?: readonly string[];
}

export interface PlannedArchiveEntry {
  readonly archivePath: string;
  readonly destinationPath: string;
  readonly uncompressedSize: number;
}

export interface ArchiveExtractionPlan {
  readonly entries: readonly PlannedArchiveEntry[];
  readonly totalUncompressedBytes: number;
}

/**
 * Format-independent archive preflight. An archive decoder must enumerate all
 * central-directory entries before extraction, pass them here, then extract
 * only the returned regular-file plan. Links and ambiguous portable paths are
 * intentionally unsupported.
 */
export function planArchiveExtraction(
  descriptors: readonly ArchiveEntryDescriptor[],
  destinationRoot: string,
  limits: ArchiveSafetyLimits = {},
): ArchiveExtractionPlan {
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxFileBytes = limits.maxFileBytes ?? 2_000_000_000;
  const maxTotalBytes = limits.maxTotalBytes ?? 10_000_000_000;
  const maxCompressionRatio = limits.maxCompressionRatio ?? 200;
  invariant(
    descriptors.length <= maxEntries,
    "ARCHIVE_LIMIT_EXCEEDED",
    `Archive contains more than ${maxEntries} entries`,
    { actual: descriptors.length },
  );
  const root = resolve(destinationRoot);
  const seenPortablePaths = new Set<string>();
  const entries: PlannedArchiveEntry[] = [];
  let totalUncompressedBytes = 0;

  for (const descriptor of descriptors) {
    validateArchiveSize(descriptor.compressedSize, "compressedSize", descriptor.path);
    validateArchiveSize(descriptor.uncompressedSize, "uncompressedSize", descriptor.path);
    const archivePath = safeArchivePath(descriptor.path, descriptor.type === "directory");
    const portablePath = archivePath.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seenPortablePaths.has(portablePath)) {
      throw new IngestionError("INVALID_ARCHIVE_ENTRY", "Archive has a duplicate portable path", {
        path: descriptor.path,
      });
    }
    seenPortablePaths.add(portablePath);

    invariant(
      descriptor.type === "file" || descriptor.type === "directory",
      "INVALID_ARCHIVE_ENTRY",
      "Archive links are not allowed",
      { path: descriptor.path, type: descriptor.type },
    );
    if (descriptor.type === "directory") {
      continue;
    }
    invariant(
      descriptor.uncompressedSize <= maxFileBytes,
      "ARCHIVE_LIMIT_EXCEEDED",
      "Archive entry exceeds the per-file limit",
      { path: archivePath, bytes: descriptor.uncompressedSize, maxFileBytes },
    );
    const ratio =
      descriptor.compressedSize === 0
        ? descriptor.uncompressedSize === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : descriptor.uncompressedSize / descriptor.compressedSize;
    invariant(
      ratio <= maxCompressionRatio,
      "ARCHIVE_LIMIT_EXCEEDED",
      "Archive entry exceeds the compression-ratio limit",
      { path: archivePath, ratio, maxCompressionRatio },
    );
    totalUncompressedBytes += descriptor.uncompressedSize;
    invariant(
      Number.isSafeInteger(totalUncompressedBytes) && totalUncompressedBytes <= maxTotalBytes,
      "ARCHIVE_LIMIT_EXCEEDED",
      "Archive exceeds the total uncompressed-size limit",
      { totalUncompressedBytes, maxTotalBytes },
    );
    const destinationPath = resolve(root, ...archivePath.split("/"));
    invariant(
      destinationPath.startsWith(`${root}${sep}`),
      "INVALID_ARCHIVE_ENTRY",
      "Archive entry escapes the extraction root",
      { path: descriptor.path },
    );
    entries.push(
      Object.freeze({
        archivePath,
        destinationPath,
        uncompressedSize: descriptor.uncompressedSize,
      }),
    );
  }

  entries.sort((left, right) => compareCodePoints(left.archivePath, right.archivePath));
  if (limits.expectedFiles) {
    const expected = new Set(limits.expectedFiles.map((entry) => safeArchivePath(entry, false)));
    const actual = new Set(entries.map((entry) => entry.archivePath));
    for (const required of expected) {
      invariant(
        actual.has(required),
        "INVALID_ARCHIVE_ENTRY",
        "Archive is missing an expected file",
        {
          path: required,
        },
      );
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), totalUncompressedBytes });
}

export function safeArchivePath(input: string, directory = false): string {
  invariant(input.length > 0, "INVALID_ARCHIVE_ENTRY", "Archive path is empty");
  invariant(
    !hasControlCharacters(input),
    "INVALID_ARCHIVE_ENTRY",
    "Archive path has control characters",
    { path: input },
  );
  invariant(!input.includes("\\"), "INVALID_ARCHIVE_ENTRY", "Archive path uses backslashes", {
    path: input,
  });
  invariant(!input.startsWith("/"), "INVALID_ARCHIVE_ENTRY", "Archive path is absolute", {
    path: input,
  });
  invariant(!/^[A-Za-z]:/.test(input), "INVALID_ARCHIVE_ENTRY", "Archive path has a drive prefix", {
    path: input,
  });
  const withoutDirectorySlash = directory && input.endsWith("/") ? input.slice(0, -1) : input;
  invariant(
    withoutDirectorySlash.length > 0 && !withoutDirectorySlash.endsWith("/"),
    "INVALID_ARCHIVE_ENTRY",
    "Archive path has an ambiguous trailing slash",
    { path: input },
  );
  const segments = withoutDirectorySlash.split("/");
  invariant(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "INVALID_ARCHIVE_ENTRY",
    "Archive path is non-canonical or contains traversal",
    { path: input },
  );
  return segments.join("/");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function validateArchiveSize(size: number, field: string, path: string): void {
  invariant(
    Number.isSafeInteger(size) && size >= 0,
    "INVALID_ARCHIVE_ENTRY",
    `Archive ${field} must be a non-negative safe integer`,
    { path, [field]: size },
  );
}
