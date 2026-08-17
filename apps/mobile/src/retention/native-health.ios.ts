import { Linking } from "react-native";

import {
  buildNativeHealthChanges,
  exactNativeDecimal,
  type NativeHealthAdapter,
  type NativeWeightRecord,
} from "./native-health.types";

const BODY_MASS = "HKQuantityTypeIdentifierBodyMass" as const;
const PAGE_SIZE = 1_000;

function revision(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && candidate.length <= 200 ? candidate : fallback;
}

export function createNativeHealthAdapter(): NativeHealthAdapter {
  return {
    platform: "apple_healthkit",
    async availability() {
      try {
        const healthKit = await import("@kingstinct/react-native-healthkit");
        return (await healthKit.isHealthDataAvailableAsync())
          ? { status: "available" }
          : { status: "unavailable", reason: "device" };
      } catch {
        return { status: "unavailable", reason: "native_module" };
      }
    },
    async requestWeightReadPermission() {
      try {
        const healthKit = await import("@kingstinct/react-native-healthkit");
        if (!(await healthKit.isHealthDataAvailableAsync())) {
          return { status: "unavailable", readAuthorizationOpaque: false };
        }
        const completed = await healthKit.requestAuthorization({ toRead: [BODY_MASS] });
        // Apple intentionally does not reveal whether a read type was denied; an empty query is ambiguous.
        return completed
          ? { status: "ready", readAuthorizationOpaque: true }
          : { status: "error", readAuthorizationOpaque: true };
      } catch {
        return { status: "error", readAuthorizationOpaque: true };
      }
    },
    async readWeightChanges({ providerCursor, knownRevisions, recordedTimeZone }) {
      const healthKit = await import("@kingstinct/react-native-healthkit");
      async function readAll(anchor: string | null) {
        let nextAnchor = anchor;
        let pageCount = 0;
        const samples: Array<
          Awaited<ReturnType<typeof healthKit.queryQuantitySamplesWithAnchor>>["samples"][number]
        > = [];
        const deletedSamples: Array<
          Awaited<
            ReturnType<typeof healthKit.queryQuantitySamplesWithAnchor>
          >["deletedSamples"][number]
        > = [];
        for (;;) {
          const result = await healthKit.queryQuantitySamplesWithAnchor(BODY_MASS, {
            limit: PAGE_SIZE,
            unit: "kg",
            ...(nextAnchor ? { anchor: nextAnchor } : {}),
          });
          pageCount += 1;
          samples.push(...result.samples);
          deletedSamples.push(...result.deletedSamples);
          if (samples.length + deletedSamples.length > 10_000 || pageCount > 100) {
            throw new RangeError(
              "Apple Health weight history exceeds the reviewed reconciliation bound.",
            );
          }
          const pageSize = result.samples.length + result.deletedSamples.length;
          if (pageSize < PAGE_SIZE) {
            return { samples, deletedSamples, newAnchor: result.newAnchor, pageCount };
          }
          if (result.newAnchor === nextAnchor) {
            throw new Error("Apple Health did not advance its anchored-query cursor.");
          }
          nextAnchor = result.newAnchor;
        }
      }
      let fullReconciliation = providerCursor === null;
      let result: Awaited<ReturnType<typeof readAll>>;
      try {
        result = await readAll(providerCursor);
      } catch (error) {
        if (providerCursor === null) throw error;
        // An invalidated/expired anchor is recovered with one bounded full reread. Permission and
        // provider failures will fail again here rather than being reported as a successful reset.
        result = await readAll(null);
        fullReconciliation = true;
      }
      const upserts: Extract<NativeWeightRecord, { readonly operation: "upsert" }>[] =
        result.samples.map((sample) => ({
          operation: "upsert",
          externalId: sample.uuid,
          externalRevision: revision(
            sample.sourceRevision.version,
            sample.sourceRevision.operatingSystemVersion || "1",
          ),
          definitionCode: "body_weight",
          measuredAt: sample.startDate.toISOString(),
          recordedTimeZone,
          value: exactNativeDecimal(sample.quantity),
          unit: "kg",
        }));
      const deleted: Extract<NativeWeightRecord, { readonly operation: "delete" }>[] =
        result.deletedSamples.map((sample) => ({
          operation: "delete",
          externalId: sample.uuid,
          externalRevision: `anchor:${result.newAnchor.slice(0, 160)}`,
        }));
      return buildNativeHealthChanges(
        result.newAnchor,
        upserts,
        deleted,
        knownRevisions,
        fullReconciliation,
        `full:${result.newAnchor.slice(0, 160)}`,
        false,
        result.pageCount,
      );
    },
    async openPermissionSettings() {
      await Linking.openSettings();
    },
  };
}

export type { NativeHealthAdapter } from "./native-health.types";
