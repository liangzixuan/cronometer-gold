import type { ErasureReplayLedgerEntry } from "@nutrition-tracker/artifact-store";
import { describe, expect, it, vi } from "vitest";

import { replayErasureLedgerSubjects } from "./erasure-ledger-restore.js";

const first = "10000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";

async function* subjects() {
  yield first;
  yield second;
}

describe("offline erasure replay", () => {
  it("probes every restored subject with bounded concurrency and applies only authenticated tombstones", async () => {
    let active = 0;
    let maximumActive = 0;
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: "nutrition-erasure-replay-ledger-v1",
      jobId: "30000000-0000-4000-8000-000000000003",
      ledgerEntryId: "30000000-0000-4000-8000-000000000003",
      recordedAt: "2026-08-16T12:00:00.000Z",
      restoreLocator: `v1:key-v1:${"a".repeat(64)}`,
      subjectUserId: second,
    };
    const apply = vi.fn(async (_entry: ErasureReplayLedgerEntry) => ({
      reconciled: true,
      remainingRows: { app_user: "0" },
    }));
    const ledger = {
      replaySubject: vi.fn(async (input: { subjectUserId: string; apply: typeof apply }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return input.subjectUserId === second ? input.apply(entry) : null;
      }),
    };
    await expect(
      replayErasureLedgerSubjects({
        apply,
        ledger,
        maximumConcurrency: 2,
        subjects: subjects(),
      }),
    ).resolves.toEqual({
      reconciled: true,
      reconciliationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      replayedTombstones: 1,
      scannedSubjects: 2,
    });
    expect(ledger.replaySubject).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(entry);
    expect(maximumActive).toBe(2);
  });

  it("fails the readiness command when a replay does not reconcile to zero", async () => {
    const entry: ErasureReplayLedgerEntry = {
      formatVersion: "nutrition-erasure-replay-ledger-v1",
      jobId: "30000000-0000-4000-8000-000000000003",
      ledgerEntryId: "30000000-0000-4000-8000-000000000003",
      recordedAt: "2026-08-16T12:00:00.000Z",
      restoreLocator: `v1:key-v1:${"a".repeat(64)}`,
      subjectUserId: first,
    };
    await expect(
      replayErasureLedgerSubjects({
        apply: async () => ({ reconciled: false, remainingRows: { app_user: "1" } }),
        ledger: {
          replaySubject: async (input) => {
            const result = await input.apply(entry);
            if (!result.reconciled) throw new Error("not-reconciled");
            return result;
          },
        },
        maximumConcurrency: 1,
        subjects: (async function* () {
          yield first;
        })(),
      }),
    ).rejects.toThrow("not-reconciled");
  });
});
