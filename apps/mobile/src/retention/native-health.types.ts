import type { HealthPlatform } from "./device-signing";

const SIGNED_BATCH_RECORDS = 100;

export type NativeHealthAvailability =
  | { readonly status: "available" }
  | {
      readonly status: "unavailable";
      readonly reason: "device" | "provider_update_required" | "native_module";
    }
  | { readonly status: "error" };

export type NativeHealthPermission =
  | { readonly status: "ready"; readonly readAuthorizationOpaque: boolean }
  | { readonly status: "denied"; readonly readAuthorizationOpaque: false }
  | { readonly status: "unavailable"; readonly readAuthorizationOpaque: false }
  | { readonly status: "error"; readonly readAuthorizationOpaque: boolean };

export type NativeWeightRecord =
  | {
      readonly operation: "upsert";
      readonly externalId: string;
      readonly externalRevision: string;
      readonly definitionCode: "body_weight";
      readonly measuredAt: string;
      readonly recordedTimeZone: string;
      readonly value: string;
      readonly unit: "kg";
    }
  | {
      readonly operation: "delete";
      readonly externalId: string;
      readonly externalRevision: string;
    };

export interface NativeHealthChanges {
  readonly providerCursor: string;
  readonly fullReconciliation: boolean;
  /** Apple read authorization is opaque, so HealthKit can only apply explicit deletions. */
  readonly deletionSemantics: "explicit_only" | "full_snapshot";
  readonly providerPageCount: number;
  readonly pages: readonly {
    readonly records: readonly NativeWeightRecord[];
    readonly nextKnownRevisions: Readonly<Record<string, string>>;
  }[];
}

export interface NativeHealthAdapter {
  readonly platform: HealthPlatform;
  availability(): Promise<NativeHealthAvailability>;
  requestWeightReadPermission(): Promise<NativeHealthPermission>;
  readWeightChanges(input: {
    readonly providerCursor: string | null;
    readonly knownRevisions: Readonly<Record<string, string>>;
    readonly recordedTimeZone: string;
  }): Promise<NativeHealthChanges>;
  openPermissionSettings(): Promise<void>;
}

export function exactNativeDecimal(value: number): string {
  const decimal = String(value);
  if (!Number.isFinite(value) || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(decimal)) {
    throw new TypeError("The native health provider returned a non-canonical numeric value.");
  }
  return decimal;
}

export function reconciledRecords(
  upserts: readonly Extract<NativeWeightRecord, { readonly operation: "upsert" }>[],
  deleted: readonly Extract<NativeWeightRecord, { readonly operation: "delete" }>[],
  knownRevisions: Readonly<Record<string, string>>,
  fullReconciliation: boolean,
  fullRevision: string,
): readonly NativeWeightRecord[] {
  if (upserts.length > 10_000 || deleted.length > 10_000) {
    throw new RangeError("Weight reconciliation exceeds the reviewed provider-history bound.");
  }
  // Providers may report several changes to one immutable identity in the same token window.
  // Collapse deterministically to the final upsert/revision and let an explicit delete win.
  const latestUpserts = new Map<string, (typeof upserts)[number]>();
  for (const record of upserts) latestUpserts.set(record.externalId, record);
  const latestDeleted = new Map<string, (typeof deleted)[number]>();
  for (const record of deleted) latestDeleted.set(record.externalId, record);
  for (const externalId of latestDeleted.keys()) latestUpserts.delete(externalId);
  const normalizedUpserts = [...latestUpserts.values()];
  const normalizedDeleted = [...latestDeleted.values()];
  const present = new Set(normalizedUpserts.map((record) => record.externalId));
  const explicitDeleted = new Set(normalizedDeleted.map((record) => record.externalId));
  const inferred = fullReconciliation
    ? Object.keys(knownRevisions)
        .filter((externalId) => !present.has(externalId) && !explicitDeleted.has(externalId))
        .map((externalId) => ({
          operation: "delete" as const,
          externalId,
          externalRevision: fullRevision,
        }))
    : [];
  const result = [
    ...normalizedUpserts.filter(
      (record) => knownRevisions[record.externalId] !== record.externalRevision,
    ),
    ...normalizedDeleted,
    ...inferred,
  ];
  if (result.length > 10_000) {
    throw new RangeError("Weight reconciliation exceeds the reviewed operation bound.");
  }
  return result;
}

export function buildNativeHealthChanges(
  providerCursor: string,
  upserts: readonly Extract<NativeWeightRecord, { readonly operation: "upsert" }>[],
  deleted: readonly Extract<NativeWeightRecord, { readonly operation: "delete" }>[],
  knownRevisions: Readonly<Record<string, string>>,
  fullReconciliation: boolean,
  fullRevision: string,
  inferMissingDeletions: boolean,
  providerPageCount: number,
): NativeHealthChanges {
  if (providerCursor.length < 1 || providerCursor.length > 16_384) {
    throw new TypeError("The provider cursor was invalid.");
  }
  if (!Number.isInteger(providerPageCount) || providerPageCount < 1 || providerPageCount > 100) {
    throw new RangeError("The provider page count exceeded its reviewed bound.");
  }
  const records = reconciledRecords(
    upserts,
    deleted,
    knownRevisions,
    inferMissingDeletions,
    fullRevision,
  );
  const chunks: NativeWeightRecord[][] = [];
  for (let offset = 0; offset < records.length; offset += SIGNED_BATCH_RECORDS) {
    chunks.push(records.slice(offset, offset + SIGNED_BATCH_RECORDS));
  }
  if (chunks.length === 0) chunks.push([]);
  let nextKnownRevisions = knownRevisions;
  const pages = chunks.map((chunk) => {
    nextKnownRevisions = nextKnownRevisionMap(nextKnownRevisions, chunk);
    return { records: chunk, nextKnownRevisions };
  });
  return {
    providerCursor,
    fullReconciliation,
    deletionSemantics: inferMissingDeletions ? "full_snapshot" : "explicit_only",
    providerPageCount,
    pages,
  };
}

export function nextKnownRevisionMap(
  current: Readonly<Record<string, string>>,
  records: readonly NativeWeightRecord[],
): Readonly<Record<string, string>> {
  const next: Record<string, string> = { ...current };
  for (const record of records) {
    if (record.operation === "delete") delete next[record.externalId];
    else next[record.externalId] = record.externalRevision;
  }
  if (Object.keys(next).length > 10_000) {
    throw new RangeError("The local weight reconciliation index exceeds its reviewed bound.");
  }
  return next;
}
