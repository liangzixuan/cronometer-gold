import {
  buildNativeHealthChanges,
  exactNativeDecimal,
  type NativeHealthAdapter,
  type NativeWeightRecord,
} from "./native-health.types";

interface WeightRecordShape {
  readonly time: string;
  readonly metadata?: {
    readonly id?: string;
    readonly lastModifiedTime?: string;
    readonly clientRecordVersion?: number;
  };
  readonly weight: { readonly inKilograms: number };
}

interface AndroidProviderCursor {
  readonly version: 1;
  readonly changesToken: string;
  /** Earliest bounded instant that may be reread after token expiry without history scope. */
  readonly recoveryStart: string;
}

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export function parseAndroidProviderCursor(value: string): AndroidProviderCursor {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "changesToken,recoveryStart,version"
  ) {
    throw new TypeError("The protected Health Connect cursor was invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.changesToken !== "string" ||
    candidate.changesToken.length < 1 ||
    candidate.changesToken.length > 16_000 ||
    typeof candidate.recoveryStart !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(candidate.recoveryStart) ||
    !Number.isFinite(Date.parse(candidate.recoveryStart))
  ) {
    throw new TypeError("The protected Health Connect cursor was invalid.");
  }
  return candidate as unknown as AndroidProviderCursor;
}

function recoveryStart(now: Date): string {
  return new Date(now.getTime() - RECOVERY_WINDOW_MS).toISOString();
}

function encodeAndroidProviderCursor(changesToken: string, start: string): string {
  return JSON.stringify(
    parseAndroidProviderCursor(JSON.stringify({ version: 1, changesToken, recoveryStart: start })),
  );
}

function externalRevision(record: {
  readonly time: string;
  readonly metadata?: { readonly lastModifiedTime?: string; readonly clientRecordVersion?: number };
}): string {
  const value =
    record.metadata?.lastModifiedTime ??
    (record.metadata?.clientRecordVersion === undefined
      ? record.time
      : String(record.metadata.clientRecordVersion));
  if (value.length < 1 || value.length > 200)
    throw new TypeError("Health Connect revision was invalid.");
  return value;
}

async function boundedWeightSnapshot(startTime: string) {
  const healthConnect = await import("react-native-health-connect");
  const records: Awaited<ReturnType<typeof healthConnect.readRecords<"Weight">>>["records"] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const page = await healthConnect.readRecords("Weight", {
      timeRangeFilter: { operator: "after", startTime },
      ascendingOrder: true,
      pageSize: 500,
      ...(pageToken ? { pageToken } : {}),
    });
    records.push(...page.records);
    pageCount += 1;
    pageToken = page.pageToken;
    if (records.length > 10_000) {
      throw new RangeError(
        "Health Connect weight history exceeds the reviewed reconciliation bound.",
      );
    }
  } while (pageToken);
  return { records, pageCount };
}

export function hasWeightReadPermission(granted: readonly unknown[]): boolean {
  return granted.some(
    (permission) =>
      typeof permission === "object" &&
      permission !== null &&
      "accessType" in permission &&
      "recordType" in permission &&
      permission.accessType === "read" &&
      permission.recordType === "Weight",
  );
}

async function assertWeightReadPermission(
  healthConnect: typeof import("react-native-health-connect"),
): Promise<void> {
  if (!hasWeightReadPermission(await healthConnect.getGrantedPermissions())) {
    throw new Error("Health Connect weight access was revoked; synchronization is paused.");
  }
}

export function createNativeHealthAdapter(): NativeHealthAdapter {
  return {
    platform: "android_health_connect",
    async availability() {
      try {
        const healthConnect = await import("react-native-health-connect");
        const status = await healthConnect.getSdkStatus();
        if (status === healthConnect.SdkAvailabilityStatus.SDK_AVAILABLE)
          return { status: "available" };
        return {
          status: "unavailable",
          reason:
            status === healthConnect.SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED
              ? "provider_update_required"
              : "device",
        };
      } catch {
        return { status: "unavailable", reason: "native_module" };
      }
    },
    async requestWeightReadPermission() {
      try {
        const healthConnect = await import("react-native-health-connect");
        if (
          (await healthConnect.getSdkStatus()) !== healthConnect.SdkAvailabilityStatus.SDK_AVAILABLE
        ) {
          return { status: "unavailable", readAuthorizationOpaque: false };
        }
        if (!(await healthConnect.initialize()))
          return { status: "error", readAuthorizationOpaque: false };
        const granted = await healthConnect.requestPermission([
          { accessType: "read", recordType: "Weight" },
        ]);
        return granted.some(
          (permission) => permission.accessType === "read" && permission.recordType === "Weight",
        )
          ? { status: "ready", readAuthorizationOpaque: false }
          : { status: "denied", readAuthorizationOpaque: false };
      } catch {
        return { status: "error", readAuthorizationOpaque: false };
      }
    },
    async readWeightChanges({ providerCursor, knownRevisions, recordedTimeZone }) {
      const healthConnect = await import("react-native-health-connect");
      if (!(await healthConnect.initialize()))
        throw new Error("Health Connect initialization failed.");
      await assertWeightReadPermission(healthConnect);
      const now = new Date();
      const prior = providerCursor === null ? null : parseAndroidProviderCursor(providerCursor);
      let changes = await healthConnect.getChanges({
        ...(prior ? { changesToken: prior.changesToken } : {}),
        recordTypes: ["Weight"],
      });
      const fullReconciliation = providerCursor === null || changes.changesTokenExpired;
      if (changes.changesTokenExpired)
        changes = await healthConnect.getChanges({ recordTypes: ["Weight"] });
      const changePages = [changes];
      while (changes.hasMore) {
        if (changePages.length >= 100) {
          throw new RangeError("Health Connect changes exceed the reviewed page bound.");
        }
        changes = await healthConnect.getChanges({ changesToken: changes.nextChangesToken });
        changePages.push(changes);
      }
      // Without READ_HEALTH_DATA_HISTORY, Android intentionally limits accessible history. On
      // initial sync or token expiry, reread only the persisted bounded recovery window and
      // dedupe; absence can never prove deletion of an older imported ID.
      const snapshotStart = prior?.recoveryStart ?? recoveryStart(now);
      const snapshot = fullReconciliation ? await boundedWeightSnapshot(snapshotStart) : null;
      if (snapshot) await assertWeightReadPermission(healthConnect);
      const sourceRecords: readonly WeightRecordShape[] = snapshot
        ? snapshot.records
        : changePages.flatMap((page) =>
            page.upsertionChanges
              .map((change) => change.record)
              .filter((record) => record.recordType === "Weight"),
          );
      const upserts: Extract<NativeWeightRecord, { readonly operation: "upsert" }>[] =
        sourceRecords.map((record) => {
          if (!record.metadata?.id) {
            throw new TypeError("Health Connect returned a weight without a stable record ID.");
          }
          return {
            operation: "upsert",
            externalId: record.metadata.id,
            externalRevision: externalRevision(record),
            definitionCode: "body_weight",
            measuredAt: record.time,
            recordedTimeZone,
            value: exactNativeDecimal(record.weight.inKilograms),
            unit: "kg",
          };
        });
      const deleted: Extract<NativeWeightRecord, { readonly operation: "delete" }>[] = changePages
        .flatMap((page) => page.deletionChanges)
        .map((change) => ({
          operation: "delete",
          externalId: change.recordId,
          externalRevision: `token:${changePages.at(-1)?.nextChangesToken.slice(0, 160) ?? "invalid"}`,
        }));
      const finalToken = changePages.at(-1)?.nextChangesToken;
      if (!finalToken) throw new TypeError("Health Connect did not return a continuation token.");
      return buildNativeHealthChanges(
        encodeAndroidProviderCursor(finalToken, recoveryStart(now)),
        upserts,
        deleted,
        knownRevisions,
        fullReconciliation,
        `full:${finalToken.slice(0, 160)}`,
        false,
        changePages.length + (snapshot?.pageCount ?? 0),
      );
    },
    async openPermissionSettings() {
      const { openHealthConnectSettings } = await import("react-native-health-connect");
      openHealthConnectSettings();
    },
  };
}

export type { NativeHealthAdapter } from "./native-health.types";
