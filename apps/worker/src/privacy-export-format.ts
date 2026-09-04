import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { type CanonicalJsonValue, canonicalJson } from "@nutrition-tracker/contracts";

export const PRIVACY_EXPORT_ENTITIES = [
  "account",
  "audit_event",
  "biometric_definition",
  "biometric_definition_operation",
  "biometric_definition_version",
  "biometric_event",
  "biometric_event_operation",
  "biometric_event_revision",
  "custom_food",
  "custom_food_catalogue_barcode",
  "custom_food_catalogue_food",
  "custom_food_catalogue_nutrient",
  "custom_food_catalogue_serving",
  "custom_food_catalogue_version",
  "custom_food_nutrient",
  "custom_food_operation",
  "custom_food_version",
  "device",
  "diary_day",
  "diary_entry",
  "diary_entry_legacy_nutrient",
  "diary_entry_nutrient",
  "diary_entry_revision",
  "diary_entry_source",
  "diary_operation",
  "hydration_day",
  "hydration_entry",
  "hydration_entry_revision",
  "hydration_operation",
  "nutrition_goal",
  "nutrition_goal_operation",
  "nutrition_goal_target",
  "nutrition_goal_version",
  "platform_health_import",
  "platform_health_import_conflict",
  "platform_health_import_revision",
  "platform_import_batch",
  "platform_integration",
  "platform_integration_version",
  "privacy_export_artifact",
  "privacy_export_artifact_deletion",
  "privacy_export_artifact_tombstone",
  "privacy_export_download_audit",
  "privacy_export_job",
  "profile",
  "reauthentication_proof",
  "recipe",
  "recipe_ingredient",
  "recipe_nutrient",
  "recipe_operation",
  "recipe_source",
  "recipe_version",
  "reminder_consent",
  "reminder_consent_version",
  "reminder_delivery",
  "reminder_schedule",
  "reminder_schedule_version",
  "retention_operation",
  "security_challenge",
  "session",
  "user_watermark",
] as const;

export type PrivacyExportEntity = (typeof PRIVACY_EXPORT_ENTITIES)[number];

export const MAX_PRIVACY_EXPORT_ROW_BYTES = 100 * 1_024 * 1_024;
export const DEFAULT_CSV_ZIP_MEMBER_MAX_BYTES = 400 * 1_024 * 1_024;

const entityIndexes = new Map(
  PRIVACY_EXPORT_ENTITIES.map((entity, index) => [entity, index] as const),
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_IDENTIFIER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export interface PrivacyExportRow {
  readonly ordinal: string;
  readonly entityType: PrivacyExportEntity;
  readonly entityId: string;
  readonly revision: string | null;
  readonly deleted: boolean;
  readonly watermark: string;
  readonly payload: Readonly<Record<string, CanonicalJsonValue>>;
  readonly payloadSha256: string;
}

export interface PrivacyExportSourceEvidence {
  readonly entity: PrivacyExportEntity;
  readonly sourceCount: number;
  readonly watermark: string;
  readonly sourceRecordSetSha256: string;
}

export interface PrivacyExportSemanticEvidence {
  readonly version: "retention-export-semantic-v1";
  readonly diaryDailyNutrientGroupCount: string;
  readonly diaryDailyTotalsSha256: string;
  readonly biometricEventCount: string;
  readonly biometricRevisionCount: string;
  readonly platformImportCount: string;
  readonly platformImportRevisionCount: string;
  readonly digest: string;
}

export interface PrivacyExportSnapshot {
  readonly capturedAt: string;
  readonly snapshotWatermark: string;
  readonly entities: readonly PrivacyExportSourceEvidence[];
  readonly semanticEvidence: PrivacyExportSemanticEvidence;
  readonly records: AsyncIterable<PrivacyExportRow>;
}

export interface PrivacyExportManifest {
  readonly formatVersion: "nutrition-account-export-v1";
  readonly capturedAt: string;
  readonly snapshotWatermark: string;
  readonly entities: readonly {
    readonly entity: PrivacyExportEntity;
    readonly sourceCount: number;
    readonly exportedCount: number;
    readonly watermark: string;
    readonly sourceRecordSetSha256: string;
    readonly exportedRecordSetSha256: string;
  }[];
  readonly semanticEvidence: PrivacyExportSemanticEvidence;
  readonly reconciled: true;
}

export interface PrivacyExportDeliveryManifest {
  readonly formatVersion: "nutrition-account-export-delivery-v1";
  readonly logicalManifestSha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: "text/csv; charset=utf-8";
    readonly byteLength: number;
    readonly sha256: string;
    readonly recordCount: number;
  }[];
}

type PrivacyExportManifestBase = PrivacyExportManifest;

export interface PrivacyExportSpool {
  readonly directory: string;
  readonly recordsPath: string;
  readonly manifestBase: PrivacyExportManifestBase;
  readonly byteLength: number;
  dispose(): Promise<void>;
}

export interface PlaintextExportArtifact {
  readonly format: "json" | "csv";
  readonly fileName: string;
  readonly mediaType: "application/json" | "application/zip";
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface MaterializedPrivacyExport {
  readonly artifacts: readonly PlaintextExportArtifact[];
  readonly manifest: PrivacyExportManifest;
  readonly manifestJson: string;
  readonly manifestSha256: string;
}

export class PrivacyExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyExportFormatError";
  }
}

/**
 * A deterministic configured-size failure. Unlike malformed or unreconciled
 * export evidence, retrying this snapshot under the same limit cannot succeed.
 */
export class PrivacyExportCapacityError extends PrivacyExportFormatError {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyExportCapacityError";
  }
}

export function assertPrivacyExportSizeBounds(input: {
  readonly rowBytes: number;
  readonly totalBytes: number;
  readonly maximumBytes: number;
}): void {
  if (
    !Object.values(input).every(Number.isSafeInteger) ||
    input.rowBytes < 0 ||
    input.totalBytes < 0 ||
    input.maximumBytes < MAX_PRIVACY_EXPORT_ROW_BYTES
  ) {
    throw new PrivacyExportFormatError("Export snapshot byte bounds are invalid");
  }
  if (input.rowBytes > MAX_PRIVACY_EXPORT_ROW_BYTES || input.totalBytes > input.maximumBytes) {
    throw new PrivacyExportCapacityError("Export snapshot exceeds a configured bound");
  }
}

export function assertPrivacyExportArtifactSizeBounds(input: {
  readonly artifactBytes: number;
  readonly maximumBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.artifactBytes) ||
    input.artifactBytes < 1 ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < MAX_PRIVACY_EXPORT_ROW_BYTES ||
    input.maximumBytes > 107_374_182_400
  ) {
    throw new PrivacyExportFormatError("Export artifact byte bounds are invalid");
  }
  if (input.artifactBytes > input.maximumBytes) {
    throw new PrivacyExportCapacityError("Export artifact exceeds the configured byte budget");
  }
}

const forbiddenCredentialKeys = new Set([
  "access_token",
  "challenge",
  "ciphertext_bytes",
  "encryption_key_id",
  "key_fingerprint",
  "nonce",
  "nonce_hash",
  "object_key",
  "password_hash",
  "password_salt",
  "private_key",
  "proof_signature_digest",
  "public_key",
  "public_key_spki_base64",
  "secret",
  "session_token",
  "signature",
  "signature_digest",
  "token_hash",
]);

function snakeCaseKey(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`).toLowerCase();
}

function assertCredentialSafePayload(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCredentialSafePayload(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = snakeCaseKey(key);
    const isSignatureMaterial = normalized.includes("signature");
    if (
      (forbiddenCredentialKeys.has(normalized) || isSignatureMaterial) &&
      item !== null &&
      item !== "[REDACTED]"
    ) {
      throw new PrivacyExportFormatError("Credential material is not exportable account data");
    }
    assertCredentialSafePayload(item);
  }
}

function canonicalPayload(value: PrivacyExportRow["payload"]): string {
  function visit(item: unknown): void {
    if (typeof item === "number" && !Number.isSafeInteger(item)) {
      throw new PrivacyExportFormatError("Exact database numerics must be exported as strings");
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child);
    }
  }
  assertCredentialSafePayload(value);
  visit(value);
  try {
    return canonicalJson(value);
  } catch {
    throw new PrivacyExportFormatError("Export payload is not canonical JSON");
  }
}

async function writeBuffer(stream: Writable, value: string | Buffer): Promise<void> {
  if (stream.write(value)) return;
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

class PrivacyExportWorkspaceBudget {
  #usedBytes: number;
  readonly #maximumBytes: number;

  constructor(maximumBytes: number, initialBytes: number) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < MAX_PRIVACY_EXPORT_ROW_BYTES ||
      maximumBytes > 107_374_182_400 ||
      !Number.isSafeInteger(initialBytes) ||
      initialBytes < 0
    ) {
      throw new PrivacyExportFormatError("Export workspace byte bounds are invalid");
    }
    if (initialBytes > maximumBytes) {
      throw new PrivacyExportCapacityError("Export workspace exceeds the configured byte budget");
    }
    this.#maximumBytes = maximumBytes;
    this.#usedBytes = initialBytes;
  }

  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new PrivacyExportFormatError("Export workspace reservation is invalid");
    }
    if (bytes > this.#maximumBytes - this.#usedBytes) {
      throw new PrivacyExportCapacityError("Export workspace exceeds the configured byte budget");
    }
    this.#usedBytes += bytes;
  }
}

async function writeWorkspaceBuffer(
  stream: Writable,
  value: string | Buffer,
  budget: PrivacyExportWorkspaceBudget,
): Promise<void> {
  budget.reserve(Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value, "utf8"));
  await writeBuffer(stream, value);
}

async function closeWritable(stream: Writable): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onFinish = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("finish", onFinish);
      stream.off("error", onError);
    };
    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });
}

function validateEvidence(
  evidence: readonly PrivacyExportSourceEvidence[],
): ReadonlyMap<PrivacyExportEntity, PrivacyExportSourceEvidence> {
  if (evidence.length !== PRIVACY_EXPORT_ENTITIES.length) {
    throw new PrivacyExportFormatError("Export source evidence is incomplete");
  }
  const result = new Map<PrivacyExportEntity, PrivacyExportSourceEvidence>();
  for (const item of evidence) {
    if (
      !entityIndexes.has(item.entity) ||
      result.has(item.entity) ||
      !Number.isSafeInteger(item.sourceCount) ||
      item.sourceCount < 0 ||
      item.watermark.length < 1 ||
      item.watermark.length > 512 ||
      !SHA256_PATTERN.test(item.sourceRecordSetSha256)
    ) {
      throw new PrivacyExportFormatError("Export source evidence is invalid");
    }
    result.set(item.entity, item);
  }
  return result;
}

function validateSemanticEvidence(
  evidence: PrivacyExportSemanticEvidence,
): PrivacyExportSemanticEvidence {
  const facts = {
    biometricEventCount: evidence.biometricEventCount,
    biometricRevisionCount: evidence.biometricRevisionCount,
    diaryDailyNutrientGroupCount: evidence.diaryDailyNutrientGroupCount,
    diaryDailyTotalsSha256: evidence.diaryDailyTotalsSha256,
    platformImportCount: evidence.platformImportCount,
    platformImportRevisionCount: evidence.platformImportRevisionCount,
    version: evidence.version,
  } as const;
  if (
    evidence.version !== "retention-export-semantic-v1" ||
    !DECIMAL_IDENTIFIER_PATTERN.test(evidence.diaryDailyNutrientGroupCount) ||
    !DECIMAL_IDENTIFIER_PATTERN.test(evidence.biometricEventCount) ||
    !DECIMAL_IDENTIFIER_PATTERN.test(evidence.biometricRevisionCount) ||
    !DECIMAL_IDENTIFIER_PATTERN.test(evidence.platformImportCount) ||
    !DECIMAL_IDENTIFIER_PATTERN.test(evidence.platformImportRevisionCount) ||
    !SHA256_PATTERN.test(evidence.diaryDailyTotalsSha256) ||
    !SHA256_PATTERN.test(evidence.digest) ||
    createHash("sha256").update(canonicalJson(facts), "utf8").digest("hex") !== evidence.digest
  ) {
    throw new PrivacyExportFormatError("Export semantic evidence is invalid");
  }
  return evidence;
}

function checkedRow(row: PrivacyExportRow): { readonly line: string; readonly payload: string } {
  if (
    !entityIndexes.has(row.entityType) ||
    !DECIMAL_IDENTIFIER_PATTERN.test(row.ordinal) ||
    row.ordinal.length > 20 ||
    row.entityId.length < 1 ||
    row.entityId.length > 500 ||
    (row.revision !== null && (row.revision.length < 1 || row.revision.length > 200)) ||
    row.watermark.length < 1 ||
    row.watermark.length > 512 ||
    !SHA256_PATTERN.test(row.payloadSha256)
  ) {
    throw new PrivacyExportFormatError("Export row metadata is invalid");
  }
  const payload = canonicalPayload(row.payload);
  const payloadDigest = createHash("sha256").update(payload, "utf8").digest("hex");
  if (payloadDigest !== row.payloadSha256) {
    throw new PrivacyExportFormatError("Export payload digest does not match snapshot evidence");
  }
  const line = canonicalJson({
    deleted: row.deleted,
    entityId: row.entityId,
    entityType: row.entityType,
    ordinal: row.ordinal,
    payload: row.payload,
    payloadSha256: row.payloadSha256,
    revision: row.revision,
    watermark: row.watermark,
  });
  if (Buffer.byteLength(line, "utf8") + 1 > MAX_PRIVACY_EXPORT_ROW_BYTES) {
    throw new PrivacyExportCapacityError("Export row exceeds 100 MiB");
  }
  return { line, payload };
}

export async function spoolPrivacyExportSnapshot(input: {
  readonly snapshot: PrivacyExportSnapshot;
  readonly maximumBytes: number;
  readonly temporaryDirectory?: string;
  readonly signal?: AbortSignal;
}): Promise<PrivacyExportSpool> {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < MAX_PRIVACY_EXPORT_ROW_BYTES ||
    input.maximumBytes > 107_374_182_400
  ) {
    throw new RangeError("Invalid privacy export spool bound");
  }
  if (!Number.isFinite(Date.parse(input.snapshot.capturedAt))) {
    throw new PrivacyExportFormatError("Export capture timestamp is invalid");
  }
  if (
    input.snapshot.snapshotWatermark.length < 1 ||
    input.snapshot.snapshotWatermark.length > 512
  ) {
    throw new PrivacyExportFormatError("Export snapshot watermark is invalid");
  }
  const sourceEvidence = validateEvidence(input.snapshot.entities);
  const semanticEvidence = validateSemanticEvidence(input.snapshot.semanticEvidence);
  const root = input.temporaryDirectory ?? tmpdir();
  const directory = await mkdtemp(join(root, "nutrition-account-export-"));
  await chmod(directory, 0o700);
  const recordsPath = join(directory, "snapshot.ndjson");
  const output = createWriteStream(recordsPath, { flags: "wx", mode: 0o600 });
  const counts = new Map<PrivacyExportEntity, number>();
  const digests = new Map(
    PRIVACY_EXPORT_ENTITIES.map((entity) => [entity, createHash("sha256")] as const),
  );
  let totalBytes = 0;
  let previousEntityIndex = -1;
  let previousOrdinal = -1n;
  let succeeded = false;
  try {
    for await (const row of input.snapshot.records) {
      if (input.signal?.aborted) throw input.signal.reason;
      const entityIndex = entityIndexes.get(row.entityType);
      if (entityIndex === undefined) throw new PrivacyExportFormatError("Unknown export entity");
      const ordinal = BigInt(row.ordinal);
      if (
        entityIndex < previousEntityIndex ||
        (entityIndex === previousEntityIndex && ordinal <= previousOrdinal)
      ) {
        throw new PrivacyExportFormatError("Export snapshot rows are not in stable order");
      }
      previousEntityIndex = entityIndex;
      previousOrdinal = ordinal;
      const checked = checkedRow(row);
      const serialized = `${checked.line}\n`;
      const bytes = Buffer.byteLength(serialized, "utf8");
      totalBytes += bytes;
      assertPrivacyExportSizeBounds({
        maximumBytes: input.maximumBytes,
        rowBytes: bytes,
        totalBytes,
      });
      if (sourceEvidence.get(row.entityType)?.watermark !== row.watermark) {
        throw new PrivacyExportFormatError("Export entity watermark reconciliation failed");
      }
      counts.set(row.entityType, (counts.get(row.entityType) ?? 0) + 1);
      digests.get(row.entityType)?.update(serialized, "utf8");
      await writeBuffer(output, serialized);
    }
    await closeWritable(output);
    const entities = PRIVACY_EXPORT_ENTITIES.map((entity) => {
      const source = sourceEvidence.get(entity);
      if (!source) throw new PrivacyExportFormatError("Export source evidence is incomplete");
      const exportedCount = counts.get(entity) ?? 0;
      if (source.sourceCount !== exportedCount) {
        throw new PrivacyExportFormatError("Export entity count reconciliation failed");
      }
      const exportedRecordSetSha256 = digests.get(entity)?.digest("hex") as string;
      if (source.sourceRecordSetSha256 !== exportedRecordSetSha256) {
        throw new PrivacyExportFormatError("Export record-set reconciliation failed");
      }
      return {
        entity,
        exportedCount,
        exportedRecordSetSha256,
        sourceRecordSetSha256: source.sourceRecordSetSha256,
        sourceCount: source.sourceCount,
        watermark: source.watermark,
      };
    });
    const manifestBase: PrivacyExportManifestBase = {
      capturedAt: input.snapshot.capturedAt,
      entities,
      formatVersion: "nutrition-account-export-v1",
      reconciled: true,
      semanticEvidence,
      snapshotWatermark: input.snapshot.snapshotWatermark,
    };
    succeeded = true;
    let disposed = false;
    return {
      byteLength: totalBytes,
      directory,
      manifestBase,
      recordsPath,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(directory, { force: true, recursive: true });
      },
    };
  } finally {
    if (!succeeded) {
      output.on("error", () => undefined);
      output.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  }
}

/** RFC 4180 cell encoding with defense against spreadsheet formula execution. */
export function csvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replaceAll('"', '""')}"` : neutralized;
}

/** Pure size planner used to prove deterministic splitting even above classic ZIP's 4 GiB offset. */
export function planCsvChunkSizes(input: {
  readonly headerBytes: number;
  readonly rowBytes: readonly number[];
  readonly maximumMemberBytes: number;
}): readonly { readonly byteLength: number; readonly recordCount: number }[] {
  if (
    !Number.isSafeInteger(input.headerBytes) ||
    input.headerBytes < 1 ||
    !Number.isSafeInteger(input.maximumMemberBytes) ||
    input.maximumMemberBytes < input.headerBytes ||
    input.maximumMemberBytes > 0xffffffff
  ) {
    throw new RangeError("Invalid CSV ZIP member bound");
  }
  const chunks: { byteLength: number; recordCount: number }[] = [];
  let byteLength = input.headerBytes;
  let recordCount = 0;
  for (const rowBytes of input.rowBytes) {
    if (!Number.isSafeInteger(rowBytes) || rowBytes < 1) {
      throw new PrivacyExportFormatError("CSV row byte evidence is invalid");
    }
    if (rowBytes + input.headerBytes > input.maximumMemberBytes) {
      throw new PrivacyExportCapacityError("A CSV row exceeds the deterministic chunk bound");
    }
    if (recordCount > 0 && byteLength + rowBytes > input.maximumMemberBytes) {
      chunks.push({ byteLength, recordCount });
      byteLength = input.headerBytes;
      recordCount = 0;
    }
    byteLength += rowBytes;
    recordCount += 1;
  }
  chunks.push({ byteLength, recordCount });
  return chunks;
}

function csvRow(row: PrivacyExportRow): string {
  return `${[
    row.ordinal,
    row.entityId,
    row.revision ?? "",
    row.deleted ? "true" : "false",
    row.watermark,
    row.payloadSha256,
    canonicalPayload(row.payload),
  ]
    .map(csvCell)
    .join(",")}\r\n`;
}

async function readSpoolRows(
  path: string,
  operation: (row: PrivacyExportRow, rawLine: string) => Promise<void>,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      const row = JSON.parse(line) as PrivacyExportRow;
      checkedRow(row);
      await operation(row, line);
    }
  } finally {
    lines.close();
  }
}

async function fileMetadata(
  path: string,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk as Uint8Array);
    byteLength += bytes.byteLength;
    digest.update(bytes);
  }
  return { byteLength, sha256: digest.digest("hex") };
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

async function crc32(path: string): Promise<number> {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(path)) {
    for (const byte of Buffer.from(chunk as Uint8Array)) {
      crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

interface ZipInput {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly crc: number;
}

async function deterministicStoredZip(
  path: string,
  files: readonly ZipInput[],
  budget: PrivacyExportWorkspaceBudget,
): Promise<void> {
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const central: { readonly file: ZipInput; readonly offset: bigint }[] = [];
  let offset = 0n;
  try {
    for (const file of [...files].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new PrivacyExportFormatError("ZIP member byte evidence is invalid");
      }
      if (file.size > 0xffffffff) {
        throw new PrivacyExportCapacityError("ZIP member exceeds the supported bound");
      }
      const name = Buffer.from(file.name, "utf8");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0x21, 12);
      header.writeUInt32LE(file.crc, 14);
      header.writeUInt32LE(file.size, 18);
      header.writeUInt32LE(file.size, 22);
      header.writeUInt16LE(name.byteLength, 26);
      header.writeUInt16LE(0, 28);
      central.push({ file, offset });
      await writeWorkspaceBuffer(output, header, budget);
      await writeWorkspaceBuffer(output, name, budget);
      offset += BigInt(header.byteLength + name.byteLength);
      for await (const chunk of createReadStream(file.path)) {
        const bytes = Buffer.from(chunk as Uint8Array);
        await writeWorkspaceBuffer(output, bytes, budget);
        offset += BigInt(bytes.byteLength);
      }
    }
    const centralOffset = offset;
    for (const item of central) {
      const name = Buffer.from(item.file.name, "utf8");
      const usesZip64Offset = item.offset > 0xffffffffn;
      const extra = usesZip64Offset
        ? Buffer.concat([Buffer.from([0x01, 0x00, 0x08, 0x00]), uint64(item.offset)])
        : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(usesZip64Offset ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(0x21, 14);
      header.writeUInt32LE(item.file.crc, 16);
      header.writeUInt32LE(item.file.size, 20);
      header.writeUInt32LE(item.file.size, 24);
      header.writeUInt16LE(name.byteLength, 28);
      header.writeUInt16LE(extra.byteLength, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(usesZip64Offset ? 0xffffffff : Number(item.offset), 42);
      await writeWorkspaceBuffer(output, header, budget);
      await writeWorkspaceBuffer(output, name, budget);
      await writeWorkspaceBuffer(output, extra, budget);
      offset += BigInt(header.byteLength + name.byteLength + extra.byteLength);
    }
    const centralSize = offset - centralOffset;
    const needsZip64 =
      centralOffset > 0xffffffffn || centralSize > 0xffffffffn || central.length > 0xffff;
    if (needsZip64) {
      const zip64Offset = offset;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeUInt32LE(0, 16);
      end64.writeUInt32LE(0, 20);
      end64.writeBigUInt64LE(BigInt(central.length), 24);
      end64.writeBigUInt64LE(BigInt(central.length), 32);
      end64.writeBigUInt64LE(centralSize, 40);
      end64.writeBigUInt64LE(centralOffset, 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(zip64Offset, 8);
      locator.writeUInt32LE(1, 16);
      await writeWorkspaceBuffer(output, end64, budget);
      await writeWorkspaceBuffer(output, locator, budget);
      offset += BigInt(end64.byteLength + locator.byteLength);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length > 0xffff ? 0xffff : central.length, 8);
    end.writeUInt16LE(central.length > 0xffff ? 0xffff : central.length, 10);
    end.writeUInt32LE(centralSize > 0xffffffffn ? 0xffffffff : Number(centralSize), 12);
    end.writeUInt32LE(centralOffset > 0xffffffffn ? 0xffffffff : Number(centralOffset), 16);
    end.writeUInt16LE(0, 20);
    await writeWorkspaceBuffer(output, end, budget);
    await closeWritable(output);
  } catch (error) {
    output.on("error", () => undefined);
    output.destroy();
    throw error;
  }
}

interface StagedCsvChunk extends ZipInput {
  readonly recordCount: number;
}

async function stageCsvChunks(input: {
  readonly spool: PrivacyExportSpool;
  readonly maximumMemberBytes: number;
  readonly workspaceBudget: PrivacyExportWorkspaceBudget;
  readonly signal?: AbortSignal;
}): Promise<readonly StagedCsvChunk[]> {
  if (
    !Number.isSafeInteger(input.maximumMemberBytes) ||
    input.maximumMemberBytes < 1_024 ||
    input.maximumMemberBytes > 0xffffffff
  ) {
    throw new RangeError("Invalid CSV ZIP member bound");
  }
  const csvDirectory = join(input.spool.directory, "csv");
  await mkdir(csvDirectory, { mode: 0o700 });
  const header = "ordinal,entity_id,revision,deleted,watermark,payload_sha256,payload_json\r\n";
  const chunks: StagedCsvChunk[] = [];
  let entityIndex = 0;
  let part = 1;
  let recordCount = 0;
  let bytes = Buffer.byteLength(header, "utf8");
  let path = "";
  let name = "";
  let writer: ReturnType<typeof createWriteStream> | undefined;

  const open = async () => {
    const entity = PRIVACY_EXPORT_ENTITIES[entityIndex] as PrivacyExportEntity;
    const partName = `part-${String(part).padStart(6, "0")}.csv`;
    const entityDirectory = join(csvDirectory, entity);
    await mkdir(entityDirectory, { mode: 0o700, recursive: true });
    path = join(entityDirectory, partName);
    name = `entities/${entity}/${partName}`;
    writer = createWriteStream(path, { flags: "wx", mode: 0o600 });
    recordCount = 0;
    bytes = Buffer.byteLength(header, "utf8");
    await writeWorkspaceBuffer(writer, header, input.workspaceBudget);
  };
  const close = async () => {
    if (!writer) throw new PrivacyExportFormatError("CSV writer was not initialized");
    await closeWritable(writer);
    const metadata = await fileMetadata(path);
    if (metadata.byteLength !== bytes) throw new PrivacyExportFormatError("CSV size drifted");
    chunks.push({
      crc: await crc32(path),
      name,
      path,
      recordCount,
      size: metadata.byteLength,
    });
  };

  await open();
  try {
    await readSpoolRows(input.spool.recordsPath, async (row) => {
      if (input.signal?.aborted) throw input.signal.reason;
      const targetIndex = entityIndexes.get(row.entityType) as number;
      while (entityIndex < targetIndex) {
        await close();
        entityIndex += 1;
        part = 1;
        await open();
      }
      const line = csvRow(row);
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes + Buffer.byteLength(header, "utf8") > input.maximumMemberBytes) {
        throw new PrivacyExportCapacityError("A CSV row exceeds the deterministic chunk bound");
      }
      if (recordCount > 0 && bytes + lineBytes > input.maximumMemberBytes) {
        await close();
        part += 1;
        await open();
      }
      if (!writer) throw new PrivacyExportFormatError("CSV writer was not initialized");
      await writeWorkspaceBuffer(writer, line, input.workspaceBudget);
      bytes += lineBytes;
      recordCount += 1;
    });
    await close();
    while (entityIndex < PRIVACY_EXPORT_ENTITIES.length - 1) {
      entityIndex += 1;
      part = 1;
      await open();
      await close();
    }
    return chunks;
  } catch (error) {
    writer?.on("error", () => undefined);
    writer?.destroy();
    throw error;
  }
}

export async function materializePrivacyExportArtifacts(input: {
  readonly spool: PrivacyExportSpool;
  readonly formats: readonly ("json" | "csv")[];
  readonly csvMemberMaximumBytes?: number;
  readonly maximumArtifactBytes?: number;
  /** Cumulative bytes of snapshot, chunks and final artifacts retained at once. */
  readonly maximumWorkspaceBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<MaterializedPrivacyExport> {
  const formats = [...new Set(input.formats)].sort();
  if (
    formats.length < 1 ||
    formats.length > 2 ||
    formats.some((format) => format !== "csv" && format !== "json")
  ) {
    throw new PrivacyExportFormatError("Export formats are invalid");
  }
  const maximumArtifactBytes = input.maximumArtifactBytes ?? 107_374_182_400;
  assertPrivacyExportArtifactSizeBounds({ artifactBytes: 1, maximumBytes: maximumArtifactBytes });
  const workspaceBudget = new PrivacyExportWorkspaceBudget(
    input.maximumWorkspaceBytes ?? maximumArtifactBytes,
    input.spool.byteLength,
  );
  const csvChunks = formats.includes("csv")
    ? await stageCsvChunks({
        maximumMemberBytes: input.csvMemberMaximumBytes ?? DEFAULT_CSV_ZIP_MEMBER_MAX_BYTES,
        spool: input.spool,
        workspaceBudget,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    : [];
  const csvFiles = await Promise.all(
    csvChunks.map(async (chunk) => {
      const metadata = await fileMetadata(chunk.path);
      return {
        byteLength: metadata.byteLength,
        mediaType: "text/csv; charset=utf-8" as const,
        path: chunk.name,
        recordCount: chunk.recordCount,
        sha256: metadata.sha256,
      };
    }),
  );
  // This logical reconciliation manifest is byte-identical in every requested
  // format. CSV member hashes live in a separate delivery inventory so the JSON
  // artifact never claims files that it does not physically contain.
  const manifest = input.spool.manifestBase;
  const manifestJson = canonicalJson(manifest);
  const manifestSha256 = createHash("sha256").update(manifestJson, "utf8").digest("hex");
  const deliveryManifest: PrivacyExportDeliveryManifest = {
    files: csvFiles,
    formatVersion: "nutrition-account-export-delivery-v1",
    logicalManifestSha256: manifestSha256,
  };
  const artifacts: PlaintextExportArtifact[] = [];
  if (formats.includes("json")) {
    const path = join(input.spool.directory, "account-export.json");
    const jsonOutput = createWriteStream(path, { flags: "wx", mode: 0o600 });
    let currentEntityIndex = 0;
    let firstInEntity = true;
    try {
      await writeWorkspaceBuffer(jsonOutput, '{"entities":{', workspaceBudget);
      await writeWorkspaceBuffer(
        jsonOutput,
        `${JSON.stringify(PRIVACY_EXPORT_ENTITIES[0])}:[`,
        workspaceBudget,
      );
      await readSpoolRows(input.spool.recordsPath, async (row, rawLine) => {
        if (input.signal?.aborted) throw input.signal.reason;
        const targetIndex = entityIndexes.get(row.entityType) as number;
        while (currentEntityIndex < targetIndex) {
          currentEntityIndex += 1;
          firstInEntity = true;
          await writeWorkspaceBuffer(
            jsonOutput,
            `],${JSON.stringify(PRIVACY_EXPORT_ENTITIES[currentEntityIndex])}:[`,
            workspaceBudget,
          );
        }
        await writeWorkspaceBuffer(
          jsonOutput,
          `${firstInEntity ? "" : ","}${rawLine}`,
          workspaceBudget,
        );
        firstInEntity = false;
      });
      while (currentEntityIndex < PRIVACY_EXPORT_ENTITIES.length - 1) {
        currentEntityIndex += 1;
        await writeWorkspaceBuffer(
          jsonOutput,
          `],${JSON.stringify(PRIVACY_EXPORT_ENTITIES[currentEntityIndex])}:[`,
          workspaceBudget,
        );
      }
      await writeWorkspaceBuffer(jsonOutput, `]},"manifest":${manifestJson}}\n`, workspaceBudget);
      await closeWritable(jsonOutput);
    } catch (error) {
      jsonOutput.on("error", () => undefined);
      jsonOutput.destroy();
      throw error;
    }
    const metadata = await fileMetadata(path);
    assertPrivacyExportArtifactSizeBounds({
      artifactBytes: metadata.byteLength,
      maximumBytes: maximumArtifactBytes,
    });
    artifacts.push({
      ...metadata,
      fileName: "account-export.json",
      format: "json",
      mediaType: "application/json",
      path,
    });
  }
  if (formats.includes("csv")) {
    const csvDirectory = join(input.spool.directory, "csv");
    const manifestPath = join(csvDirectory, "manifest.json");
    const manifestOutput = createWriteStream(manifestPath, { flags: "wx", mode: 0o600 });
    await writeWorkspaceBuffer(manifestOutput, `${manifestJson}\n`, workspaceBudget);
    await closeWritable(manifestOutput);
    const manifestDetails = await stat(manifestPath);
    const deliveryManifestPath = join(csvDirectory, "files.json");
    const deliveryManifestOutput = createWriteStream(deliveryManifestPath, {
      flags: "wx",
      mode: 0o600,
    });
    await writeWorkspaceBuffer(
      deliveryManifestOutput,
      `${canonicalJson(deliveryManifest)}\n`,
      workspaceBudget,
    );
    await closeWritable(deliveryManifestOutput);
    const deliveryManifestDetails = await stat(deliveryManifestPath);
    const zipInputs: ZipInput[] = [
      ...csvChunks,
      {
        crc: await crc32(manifestPath),
        name: "manifest.json",
        path: manifestPath,
        size: manifestDetails.size,
      },
      {
        crc: await crc32(deliveryManifestPath),
        name: "files.json",
        path: deliveryManifestPath,
        size: deliveryManifestDetails.size,
      },
    ];
    const path = join(input.spool.directory, "account-export-csv.zip");
    await deterministicStoredZip(path, zipInputs, workspaceBudget);
    const metadata = await fileMetadata(path);
    assertPrivacyExportArtifactSizeBounds({
      artifactBytes: metadata.byteLength,
      maximumBytes: maximumArtifactBytes,
    });
    artifacts.push({
      ...metadata,
      fileName: "account-export-csv.zip",
      format: "csv",
      mediaType: "application/zip",
      path,
    });
  }
  return {
    artifacts: artifacts.sort((left, right) =>
      left.format < right.format ? -1 : left.format > right.format ? 1 : 0,
    ),
    manifest,
    manifestJson,
    manifestSha256,
  };
}
