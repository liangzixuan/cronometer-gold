import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { JsonObject, JsonValue, StagedCatalogueRecordInput } from "@nutrition-tracker/db";
import { canonicalJson } from "@nutrition-tracker/ingestion";

const FORMAT = "usda-fdc-csv-normalized-record-export-v1";
const ORDERING = "sha256-partition-then-fdc-id-v1";
const DIRECTORY = ".local-data/evidence/fdc-csv-records";
const MAX_PAYLOAD_BYTES = 1_048_576;
// Leave an explicit 64-KiB allowance for V2 page identity and decimal counters.
const MAX_PAGE_BYTES = 16_777_216 - 65_536;
const MAX_LINE_BYTES = 15_728_640;
const EMPTY_PAGE_BYTES = Buffer.byteLength(canonicalJson({ records: [], schemaVersion: 1 }));
const NO_AUTHORITY = Object.freeze({
  acquisition: false,
  review: false,
  staging: false,
  promotion: false,
  activation: false,
});

export interface FdcRecordExportHeader {
  readonly recordType: "header";
  readonly format: typeof FORMAT;
  readonly schemaVersion: 1;
  readonly authority: {
    readonly acquisition: false;
    readonly review: false;
    readonly staging: false;
    readonly promotion: false;
    readonly activation: false;
  };
  readonly artifactByteSize: number;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
  readonly parserBuildSha256: string;
  readonly parserPackage: string;
  readonly parserVersion: string;
  readonly releaseKey: string;
  readonly sourceCode: string;
  readonly ordering: typeof ORDERING;
}

export interface FdcStagingPage {
  readonly expectedNextOffset: number;
  readonly nextOffset: number;
  readonly records: readonly StagedCatalogueRecordInput[];
  readonly recordsDocumentBytes: number;
}

export interface VerifiedFdcRecordExportV2 {
  readonly protocolVersion: 2;
  readonly header: FdcRecordExportHeader;
  readonly evidence: {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly recordCount: number;
    readonly recordsSha256: string;
    readonly nutrientCount: number;
    readonly servingCount: number;
    readonly postgresPayloadByteUpperBound: number;
  };
  readonly inspection: JsonObject;
  pages(input: {
    readonly nextOffset: number;
    readonly replayPreviousPage?: boolean;
  }): AsyncIterable<FdcStagingPage>;
  close(): Promise<void>;
}

/**
 * V2 resource admission reads the unchanged normalized-export-v1 envelope.
 * Verify one complete pinned file into an anonymous private snapshot, then expose
 * bounded deterministic pages. No page index grows with the source cardinality.
 * These explicit limits must come from the accepted immutable V2 admission.
 */
export async function openVerifiedFdcRecordExportV2(input: {
  readonly inputPath: string;
  readonly workspaceRoot: string;
  readonly expectedExport: { readonly sha256: string; readonly byteSize: number };
  readonly expectedHeader: FdcRecordExportHeader;
  readonly admission: {
    readonly maxRecords: number;
    readonly maxPayloadTextBytes: number;
    readonly maxSnapshotBytes: number;
  };
  readonly expectedBaseline: Readonly<Record<string, number | string>>;
  /** Additional source-specific baseline/conservation checks; never a staging callback. */
  readonly verifyInspection: (inspection: JsonObject) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<VerifiedFdcRecordExportV2> {
  const { inputPath, workspaceRoot, signal } = input;
  const expectedExport = { ...input.expectedExport };
  const expectedHeader = JSON.parse(canonicalJson(input.expectedHeader)) as FdcRecordExportHeader;
  const expectedBaseline = JSON.parse(canonicalJson(input.expectedBaseline)) as Readonly<
    Record<string, number | string>
  >;
  const { maxRecords, maxPayloadTextBytes, maxSnapshotBytes } = input.admission;
  for (const value of [maxRecords, maxPayloadTextBytes, maxSnapshotBytes]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("V2 export verification requires explicit positive accepted resource limits");
  }
  assertPath(inputPath, workspaceRoot);
  assertSha256(expectedExport.sha256);
  if (
    !Number.isSafeInteger(expectedExport.byteSize) ||
    expectedExport.byteSize < 1 ||
    expectedExport.byteSize > maxSnapshotBytes
  ) {
    throw new Error("FDC record export exceeds the bounded staging snapshot budget");
  }
  assertHeader(expectedHeader as unknown as JsonObject);
  const expectedCount = expectedBaseline.parserBaselineCsvAcceptedFoodCount;
  const expectedRecordsSha256 = expectedBaseline.parserBaselineCsvCanonicalAcceptedRecordsDigest;
  if (
    typeof expectedCount !== "number" ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > maxRecords ||
    typeof expectedRecordsSha256 !== "string"
  ) {
    throw new Error(
      "V2 FDC record export requires the complete reviewed baseline within its accepted record budget",
    );
  }
  assertSha256(expectedRecordsSha256);
  signal?.throwIfAborted();
  const userId = process.getuid?.();
  if (userId === undefined) throw new Error("FDC record reader requires POSIX ownership");
  const directories: { readonly path: string; readonly metadata: Stats }[] = [];
  let parent: FileHandle | undefined;
  let source: FileHandle | undefined;
  let snapshot: FileHandle | undefined;
  let reader: FileHandle | undefined;
  let snapshotPath: string | undefined;
  let snapshotIdentity: Stats | undefined;

  async function assertDirectories(): Promise<void> {
    if ((await realpath(workspaceRoot)) !== workspaceRoot)
      throw new Error("FDC record reader workspace contains a symbolic link");
    for (const directory of directories) {
      if (!sameEntry(await lstat(directory.path), directory.metadata))
        throw new Error("FDC record reader directory identity changed");
    }
    const expectedParent = directories.at(-1)?.metadata;
    if (parent && expectedParent && !sameEntry(await parent.stat(), expectedParent))
      throw new Error("FDC record reader parent identity changed");
  }

  async function cleanup(): Promise<void> {
    const failures: unknown[] = [];
    if (snapshotPath && snapshotIdentity) {
      try {
        await unlinkExact(snapshotPath, snapshotIdentity);
        snapshotPath = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const handle of [reader, snapshot, source, parent]) {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "FDC record reader cleanup failed; retained private paths may require inspection",
      );
  }

  try {
    let current = workspaceRoot;
    for (const part of ["", ...DIRECTORY.split("/")]) {
      if (part) current = join(current, part);
      const metadata = await lstat(current);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== userId ||
        (part ? (metadata.mode & 0o777) !== 0o700 : (metadata.mode & 0o022) !== 0)
      ) {
        throw new Error("FDC record reader requires real current-user-owned private directories");
      }
      directories.push({ path: current, metadata });
    }
    parent = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await assertDirectories();
    const boundSource = join(`/proc/self/fd/${parent.fd}`, basename(inputPath));
    source = await open(boundSource, constants.O_RDONLY | constants.O_NOFOLLOW);
    const original = await source.stat();
    if (
      !original.isFile() ||
      original.uid !== userId ||
      (original.mode & 0o777) !== 0o600 ||
      original.nlink !== 1 ||
      original.size !== expectedExport.byteSize ||
      !sameContent(await lstat(inputPath), original)
    ) {
      throw new Error(
        "FDC record export must be a stable private mode-0600 file of the expected size",
      );
    }
    snapshotPath = join(`/proc/self/fd/${parent.fd}`, `.fdc-record-snapshot-${randomUUID()}.tmp`);
    snapshot = await open(
      snapshotPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    snapshotIdentity = await snapshot.stat();
    if (
      !snapshotIdentity.isFile() ||
      snapshotIdentity.uid !== userId ||
      (snapshotIdentity.mode & 0o777) !== 0o600 ||
      snapshotIdentity.nlink !== 1
    )
      throw new Error("FDC record snapshot is not a private file");
    // Remove the name before copying bytes. No later pathname replacement can change this snapshot.
    await unlinkExact(snapshotPath, snapshotIdentity);
    snapshotPath = undefined;
    const writer = snapshot;
    const fileHash = createHash("sha256");
    const recordHash = createHash("sha256");
    let byteSize = 0;
    let recordCount = 0;
    let nutrientCount = 0;
    let servingCount = 0;
    let postgresPayloadByteUpperBound = 0;
    let lineNumber = 0;
    let inspection: JsonObject | undefined;
    for await (const line of lines(source, signal, async (chunk) => {
      byteSize += chunk.length;
      if (byteSize > expectedExport.byteSize)
        throw new Error("FDC record export grew during verification");
      fileHash.update(chunk);
      await writer.writeFile(chunk);
    })) {
      signal?.throwIfAborted();
      lineNumber += 1;
      const value = canonicalObject(line);
      if (lineNumber === 1) {
        if (line.length > 65_536) throw new Error("FDC record export header is too large");
        assertHeader(value);
        if (canonicalJson(value) !== canonicalJson(expectedHeader))
          throw new Error(
            "FDC record export header differs from expected manifest/parser/artifact identity",
          );
        continue;
      }
      if (inspection) throw new Error("FDC record export contains data after its final footer");
      if (value.recordType === "footer") {
        exactKeys(value, ["recordType", "format", "schemaVersion", "inspection"], "footer");
        if (value.format !== FORMAT || value.schemaVersion !== 1)
          throw new Error("FDC record export footer format differs");
        inspection = object(value.inspection, "inspection");
        continue;
      }
      stagingRecord(value, recordCount, line.length, expectedHeader);
      recordCount += 1;
      if (recordCount > expectedCount || recordCount > maxRecords)
        throw new Error(
          "V2 FDC record export count exceeds its reviewed baseline or accepted budget",
        );
      recordHash.update(line).update("\n");
      nutrientCount += array(value.nutrients, "nutrients").length;
      servingCount += array(value.servings, "servings").length;
      postgresPayloadByteUpperBound += postgresJsonTextByteUpperBound(value);
      if (postgresPayloadByteUpperBound > maxPayloadTextBytes)
        throw new Error(
          "V2 FDC record export exceeds its accepted conservative PostgreSQL payload bound",
        );
    }
    const sha256 = fileHash.digest("hex");
    const recordsSha256 = recordHash.digest("hex");
    if (!inspection || lineNumber < 2)
      throw new Error("FDC record export is missing its header or final footer");
    if (byteSize !== expectedExport.byteSize || sha256 !== expectedExport.sha256)
      throw new Error("FDC record export whole-file digest or size differs");
    if (recordCount !== expectedCount || recordsSha256 !== expectedRecordsSha256)
      throw new Error(
        "FDC record export ordered record count or digest differs from the reviewed manifest baseline",
      );
    verifyFooter(inspection, expectedHeader, expectedBaseline, {
      recordCount,
      recordsSha256,
      nutrientCount,
      servingCount,
    });
    await input.verifyInspection(inspection);
    signal?.throwIfAborted();
    await assertDirectories();
    if (
      !sameContent(await source.stat(), original) ||
      !sameContent(await lstat(boundSource), original)
    )
      throw new Error("FDC record export source identity changed during verification");
    await snapshot.sync();
    const finalSnapshot = await snapshot.stat();
    if (
      !sameEntry(finalSnapshot, snapshotIdentity) ||
      finalSnapshot.size !== byteSize ||
      finalSnapshot.nlink !== 0
    )
      throw new Error("FDC record snapshot identity changed");
    // This is a trusted descriptor path for our anonymous inode, never an input symlink.
    reader = await open(`/proc/self/fd/${snapshot.fd}`, constants.O_RDONLY);
    if (!sameContent(await reader.stat(), finalSnapshot))
      throw new Error("FDC record snapshot reader identity changed");
    await snapshot.close();
    snapshot = undefined;
    await source.close();
    source = undefined;
    await parent.close();
    parent = undefined;
    signal?.throwIfAborted();
    const snapshotReader = reader;
    reader = undefined;
    let closed = false;
    let active = false;
    let closeTask: Promise<void> | undefined;
    const evidence = Object.freeze({
      path: inputPath,
      byteSize,
      sha256,
      recordCount,
      recordsSha256,
      nutrientCount,
      servingCount,
      postgresPayloadByteUpperBound,
    });
    return {
      protocolVersion: 2,
      header: Object.freeze(expectedHeader),
      evidence,
      inspection,
      pages({ nextOffset, replayPreviousPage = false }) {
        if (closed || active)
          throw new Error("FDC record snapshot is closed or already being read");
        if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > recordCount)
          throw new Error("V2 FDC record cursor is outside its verified record set");
        // Resume scans the pinned snapshot once, with bounded page buffers. The
        // stage adapter replays from zero to bind each old SQL receipt exactly.
        if (replayPreviousPage)
          throw new Error("V2 FDC staging replays its complete pinned receipt chain from zero");
        active = true;
        return (async function* (): AsyncGenerator<FdcStagingPage> {
          try {
            let sequence = 0;
            let pageStart = 0;
            let records: StagedCatalogueRecordInput[] = [];
            let documentBytes = EMPTY_PAGE_BYTES;
            let index = 0;
            let cursorMatched = nextOffset === 0;
            for await (const line of lines(snapshotReader, signal)) {
              if (closed) throw new Error("FDC record snapshot was closed during paging");
              index += 1;
              if (index === 1) continue;
              const value = canonicalObject(line);
              if (value.recordType === "footer") break;
              const row = stagingRecord(value, sequence, line.length, expectedHeader);
              const entryBytes = stageEntryBytes(row);
              if (
                records.length === 250 ||
                documentBytes + entryBytes + (records.length ? 1 : 0) > MAX_PAGE_BYTES
              ) {
                if (pageStart === nextOffset) cursorMatched = true;
                if (pageStart < nextOffset && sequence > nextOffset)
                  throw new Error("V2 FDC cursor is not a deterministic page boundary");
                if (pageStart >= nextOffset) {
                  signal?.throwIfAborted();
                  yield Object.freeze({
                    expectedNextOffset: pageStart,
                    nextOffset: sequence,
                    records: Object.freeze(records),
                    recordsDocumentBytes: documentBytes,
                  });
                }
                pageStart = sequence;
                records = [];
                documentBytes = EMPTY_PAGE_BYTES;
              }
              documentBytes += entryBytes + (records.length ? 1 : 0);
              if (documentBytes > MAX_PAGE_BYTES)
                throw new Error("V2 FDC record exceeds its bounded page allocation");
              records.push(row);
              sequence += 1;
            }
            if (pageStart === nextOffset || sequence === nextOffset) cursorMatched = true;
            if (pageStart < nextOffset && sequence > nextOffset)
              throw new Error("V2 FDC cursor is not a deterministic page boundary");
            if (records.length && pageStart >= nextOffset) {
              signal?.throwIfAborted();
              yield Object.freeze({
                expectedNextOffset: pageStart,
                nextOffset: sequence,
                records: Object.freeze(records),
                recordsDocumentBytes: documentBytes,
              });
            }
            if (sequence !== recordCount || !cursorMatched)
              throw new Error("V2 FDC snapshot paging did not match its verified boundaries");
          } finally {
            active = false;
          }
        })();
      },
      close() {
        closed = true;
        closeTask ??= snapshotReader.close();
        return closeTask;
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "FDC record verification and required cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function verifyFooter(
  inspection: JsonObject,
  header: FdcRecordExportHeader,
  baseline: Readonly<Record<string, number | string>>,
  observed: {
    readonly recordCount: number;
    readonly recordsSha256: string;
    readonly nutrientCount: number;
    readonly servingCount: number;
  },
): void {
  if (inspection.schemaVersion !== 1 || inspection.reportKind !== "usda-fdc-full-csv-inspection-v1")
    throw new Error("FDC record export inspection kind differs");
  for (const key of [
    "manifestSha256",
    "parserBuildSha256",
    "parserPackage",
    "parserVersion",
    "releaseKey",
  ] as const) {
    if (inspection[key] !== header[key])
      throw new Error(`FDC record export inspection ${key} differs`);
  }
  if (canonicalJson(inspection.baseline) !== canonicalJson(baseline))
    throw new Error(
      "FDC record export footer baseline differs from the complete reviewed manifest baseline",
    );
  const review = object(inspection.baselineReview, "baseline review");
  if (
    canonicalJson(review) !==
    canonicalJson({
      kind: "non-qualifying-local-baseline-comparison-v1",
      manifestExpectationsMatched: true,
      mismatches: [],
      qualifiesAsAcquisitionOrApprovalEvidence: false,
      status: "matched-manifest-expectations",
    })
  )
    throw new Error(
      "FDC record export footer does not confirm a non-authoritative matched baseline",
    );
  const local = object(inspection.localVerification, "local verification");
  if (
    canonicalJson(local) !==
    canonicalJson({
      artifactByteSize: header.artifactByteSize,
      artifactSha256: header.artifactSha256,
      kind: "non-qualifying-local-artifact-verification-v1",
      qualifiesAsAcquisitionObservation: false,
      status: "verified-against-manifest-pins",
    })
  )
    throw new Error("FDC record export local artifact verification differs");
  const semantic = object(inspection.semanticEvidence, "semantic evidence");
  if (
    semantic.schemaVersion !== 1 ||
    semantic.ordering !== ORDERING ||
    canonicalJson(semantic.canonicalAcceptedRecords) !==
      canonicalJson({ count: observed.recordCount, sha256: observed.recordsSha256 })
  )
    throw new Error("FDC record export semantic count, digest or ordering differs");
  const metrics = object(inspection.metrics, "metrics");
  if (
    metrics.acceptedFoodCount !== observed.recordCount ||
    metrics.stagedNutrientCount !== observed.nutrientCount ||
    count(metrics.stagedPortionCount) + count(metrics.derivedLabelServingCount) !==
      observed.servingCount
  )
    throw new Error("FDC record export nutrient/serving totals differ from its inspection");
}

function stagingRecord(
  value: JsonObject,
  sequenceNumber: number,
  payloadBytes: number,
  header: FdcRecordExportHeader,
): StagedCatalogueRecordInput {
  if (payloadBytes > MAX_PAYLOAD_BYTES)
    throw new Error("FDC record exceeds the 1-MiB canonical payload cap");
  exactKeys(
    value,
    [
      "schemaVersion",
      "idempotencyKey",
      "source",
      "identity",
      "basis",
      "unlistedNutrientPolicy",
      "nutrients",
      "servings",
      "sourcePayloadHash",
    ],
    "record",
  );
  const source = object(value.source, "record source");
  if (
    value.schemaVersion !== 1 ||
    value.unlistedNutrientPolicy !== "unknown_not_reported" ||
    source.sourceCode !== header.sourceCode ||
    source.releaseKey !== header.releaseKey ||
    typeof source.sourceDataType !== "string" ||
    typeof source.sourceRecordId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey !==
      `${header.sourceCode}:${header.releaseKey}:${source.sourceDataType}:${source.sourceRecordId}` ||
    typeof value.sourcePayloadHash !== "string"
  )
    throw new Error("FDC record identity differs from its verified export");
  assertSha256(value.sourcePayloadHash);
  if (
    Buffer.byteLength(value.idempotencyKey) > 1024 ||
    Buffer.byteLength(source.sourceDataType) < 1 ||
    Buffer.byteLength(source.sourceDataType) > 256
  )
    throw new Error("FDC record identity exceeds the staging contract");
  array(value.nutrients, "nutrients");
  array(value.servings, "servings");
  return Object.freeze({
    canonicalPayload: value,
    canonicalPayloadSha256: createHash("sha256").update(canonicalJson(value)).digest("hex"),
    sequenceNumber,
    sourcePayloadSha256: value.sourcePayloadHash,
    sourceRecordKey: value.idempotencyKey,
    sourceRecordType: source.sourceDataType,
  });
}

function stageEntryBytes(record: StagedCatalogueRecordInput): number {
  return Buffer.byteLength(
    canonicalJson({
      canonicalPayloadDocument: canonicalJson(record.canonicalPayload),
      canonicalPayloadSha256: record.canonicalPayloadSha256,
      sequenceNumber: record.sequenceNumber,
      sourcePayloadSha256: record.sourcePayloadSha256,
      sourceRecordKey: record.sourceRecordKey,
      sourceRecordType: record.sourceRecordType,
    }),
  );
}

/** PostgreSQL jsonb text adds one space after each colon/comma; finite non-integers may expand from exponent form. */
export function postgresJsonTextByteUpperBound(value: JsonValue): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("PostgreSQL payload cannot contain non-finite numbers");
    return Number.isSafeInteger(value) ? Buffer.byteLength(JSON.stringify(value)) : 400;
  }
  if (typeof value === "string") {
    for (const character of value) {
      const point = character.codePointAt(0) ?? 0;
      if (point === 0 || (point >= 0xd800 && point <= 0xdfff))
        throw new Error("PostgreSQL payload cannot contain NUL or unpaired Unicode surrogates");
    }
    return Buffer.byteLength(JSON.stringify(value));
  }
  if (Array.isArray(value))
    return (
      2 +
      Math.max(0, value.length - 1) * 2 +
      value.reduce((total, child) => total + postgresJsonTextByteUpperBound(child), 0)
    );
  const entries = Object.entries(value);
  return (
    2 +
    Math.max(0, entries.length - 1) * 2 +
    entries.reduce(
      (total, [key, child]) =>
        total + postgresJsonTextByteUpperBound(key) + 2 + postgresJsonTextByteUpperBound(child),
      0,
    )
  );
}

async function* lines(
  handle: FileHandle,
  signal?: AbortSignal,
  onChunk?: (bytes: Buffer) => Promise<void>,
): AsyncGenerator<Buffer> {
  const buffer = Buffer.alloc(65_536);
  let position = 0;
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    await onChunk?.(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(start, end);
      lineBytes += fragment.length;
      if (lineBytes > MAX_LINE_BYTES)
        throw new Error("FDC record export line exceeds the bounded reader limit");
      fragments.push(fragment);
      if (newline < 0) break;
      yield Buffer.concat(fragments, lineBytes);
      fragments = [];
      lineBytes = 0;
      start = newline + 1;
    }
  }
  if (lineBytes || fragments.length)
    throw new Error("FDC record export must end with one complete LF-terminated footer");
}

function assertHeader(value: JsonObject): void {
  exactKeys(
    value,
    [
      "recordType",
      "format",
      "schemaVersion",
      "authority",
      "artifactByteSize",
      "artifactSha256",
      "manifestSha256",
      "parserBuildSha256",
      "parserPackage",
      "parserVersion",
      "releaseKey",
      "sourceCode",
      "ordering",
    ],
    "header",
  );
  if (
    value.recordType !== "header" ||
    value.format !== FORMAT ||
    value.schemaVersion !== 1 ||
    value.ordering !== ORDERING ||
    canonicalJson(value.authority) !== canonicalJson(NO_AUTHORITY) ||
    !Number.isSafeInteger(value.artifactByteSize) ||
    Number(value.artifactByteSize) < 1
  )
    throw new Error("FDC record export header schema or authority differs");
  for (const key of ["artifactSha256", "manifestSha256", "parserBuildSha256"]) {
    const digest = value[key];
    if (typeof digest !== "string") throw new Error("FDC record export header digest is invalid");
    assertSha256(digest);
  }
  for (const key of ["parserPackage", "parserVersion", "releaseKey", "sourceCode"])
    if (typeof value[key] !== "string" || !value[key])
      throw new Error("FDC record export header identity is invalid");
}

function canonicalObject(line: Buffer): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    throw new Error("FDC record export contains invalid JSON");
  }
  const value = object(parsed, "line");
  if (!Buffer.from(canonicalJson(value)).equals(line))
    throw new Error("FDC record export line is not exact canonical UTF-8 JSON");
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`FDC record export ${label} must be an object`);
  return value as JsonObject;
}
function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`FDC record export ${label} must be an array`);
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("FDC record export count is invalid");
  return value;
}
function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error("FDC record export digest must be canonical SHA-256");
}
function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort()))
    throw new Error(`FDC record export ${label} fields differ`);
}

function assertPath(path: string, root: string): void {
  if (
    process.platform !== "linux" ||
    !root.startsWith("/") ||
    resolve(root) !== root ||
    /^\/mnt\/[A-Za-z](?:\/|$)/u.test(root) ||
    /[\\\0]/u.test(root) ||
    path !== join(root, DIRECTORY, basename(path)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ndjson$/u.test(basename(path))
  )
    throw new Error("FDC record input must use a canonical private Linux export path");
}
function sameEntry(actual: Stats, expected: Stats): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeMs === expected.birthtimeMs &&
    actual.mode === expected.mode &&
    actual.uid === expected.uid
  );
}
function sameContent(actual: Stats, expected: Stats): boolean {
  return (
    sameEntry(actual, expected) &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.ctimeMs === expected.ctimeMs &&
    actual.nlink === expected.nlink
  );
}
async function unlinkExact(path: string, identity: Stats): Promise<void> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!sameEntry(before, identity))
    throw new Error("Refusing to remove a replaced FDC snapshot path");
  const quarantine = `${path}.${randomUUID()}.cleanup`;
  await rename(path, quarantine);
  if (!sameEntry(await lstat(quarantine), identity)) {
    const replacement = await lstat(quarantine);
    await link(quarantine, path);
    if (
      sameEntry(await lstat(path), replacement) &&
      sameEntry(await lstat(quarantine), replacement)
    )
      await unlink(quarantine);
    throw new Error("FDC snapshot cleanup found and preserved a replacement");
  }
  await unlink(quarantine);
}
