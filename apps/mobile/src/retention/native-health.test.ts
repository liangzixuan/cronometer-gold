import { describe, expect, it } from "vitest";

import { parseHealthCursorState } from "./health-cursor";
import {
  buildNativeHealthChanges,
  exactNativeDecimal,
  type NativeWeightRecord,
  nextKnownRevisionMap,
  reconciledRecords,
} from "./native-health.types";

describe("native weight reconciliation", () => {
  it("keeps exact provider decimals and rejects exponent coercion", () => {
    expect(exactNativeDecimal(72.125)).toBe("72.125");
    expect(() => exactNativeDecimal(1e21)).toThrow(/canonical/u);
  });

  it("turns records missing from a full snapshot into deletions", () => {
    const upsert = {
      operation: "upsert" as const,
      externalId: "still-present",
      externalRevision: "2",
      definitionCode: "body_weight" as const,
      measuredAt: "2026-08-16T08:00:00.000Z",
      recordedTimeZone: "America/Chicago",
      value: "72.125",
      unit: "kg" as const,
    };
    const records = reconciledRecords(
      [upsert],
      [],
      { "still-present": "1", removed: "4" },
      true,
      "full:5",
    );
    expect(records).toContainEqual({
      operation: "delete",
      externalId: "removed",
      externalRevision: "full:5",
    });
    expect(nextKnownRevisionMap({ "still-present": "1", removed: "4" }, records)).toEqual({
      "still-present": "2",
    });
  });

  it("never infers HealthKit deletion from an opaque empty full read", () => {
    const plan = buildNativeHealthChanges(
      "replacement-anchor",
      [],
      [],
      { "not-visible-or-revoked": "4" },
      true,
      "full:replacement-anchor",
      false,
      2,
    );
    expect(plan.deletionSemantics).toBe("explicit_only");
    expect(plan.pages).toEqual([
      { records: [], nextKnownRevisions: { "not-visible-or-revoked": "4" } },
    ]);
  });

  it("strictly parses the protected provider cursor without health values", () => {
    const state = {
      version: 1 as const,
      providerCursor: "private-provider-anchor",
      serverDigest: "a".repeat(64),
      knownRevisions: { sample: "7" },
    };
    expect(parseHealthCursorState(JSON.stringify(state))).toEqual(state);
    expect(() =>
      parseHealthCursorState(JSON.stringify({ ...state, healthValue: "72.125" })),
    ).toThrow(/cursor/u);
  });

  it("splits provider histories over the server batch bound", () => {
    const record: NativeWeightRecord = {
      operation: "delete",
      externalId: "sample",
      externalRevision: "1",
    };
    const plan = buildNativeHealthChanges(
      "next-provider-token",
      [],
      Array.from({ length: 1_001 }, (_, index) => ({ ...record, externalId: String(index) })),
      {},
      false,
      "1",
      false,
      2,
    );
    expect(plan.pages).toHaveLength(11);
    expect(plan.pages[0]?.records).toHaveLength(100);
    expect(plan.pages.at(-1)?.records).toHaveLength(1);
  });

  it("collapses repeated provider revisions and lets an explicit deletion win", () => {
    const first = {
      operation: "upsert" as const,
      externalId: "sample",
      externalRevision: "1",
      definitionCode: "body_weight" as const,
      measuredAt: "2026-08-16T08:00:00.000Z",
      recordedTimeZone: "America/Chicago",
      value: "72",
      unit: "kg" as const,
    };
    expect(
      reconciledRecords(
        [first, { ...first, externalRevision: "2", value: "73" }],
        [{ operation: "delete", externalId: "sample", externalRevision: "3" }],
        {},
        false,
        "unused",
      ),
    ).toEqual([{ operation: "delete", externalId: "sample", externalRevision: "3" }]);
  });
});
