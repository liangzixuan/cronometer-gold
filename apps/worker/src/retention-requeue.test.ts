import { RetentionNotFoundError } from "@nutrition-tracker/db";
import { describe, expect, it, vi } from "vitest";

import {
  parseRetentionRequeueArguments,
  type RetentionRequeueRepository,
  requeueRetentionDeadLetter,
} from "./retention-requeue.js";

const id = "10000000-0000-4000-8000-000000000001";
const approvalDigest = "a".repeat(64);
function repository(): RetentionRequeueRepository {
  return {
    requeueArtifact: vi.fn(async () => undefined),
    requeueErasure: vi.fn(async () => undefined),
    requeueExport: vi.fn(async () => undefined),
    requeueStagedArtifact: vi.fn(async () => undefined),
  };
}

describe("governed retention requeue", () => {
  it("accepts only a closed kind, canonical target ID, and incident approval digest", () => {
    expect(
      parseRetentionRequeueArguments([
        "--kind",
        "export",
        "--id",
        id,
        "--approval-digest",
        approvalDigest,
      ]),
    ).toEqual({ approvalDigest, id, kind: "export" });
    expect(() =>
      parseRetentionRequeueArguments([
        "--kind",
        "wrong",
        "--id",
        id,
        "--approval-digest",
        approvalDigest,
      ]),
    ).toThrow("kind");
  });

  it("fails closed for a non-dead-lettered or wrong-kind target", async () => {
    const repo = repository();
    vi.mocked(repo.requeueErasure).mockRejectedValue(new RetentionNotFoundError());
    await expect(
      requeueRetentionDeadLetter({
        clock: () => new Date("2026-08-16T12:00:00.000Z"),
        repository: repo,
        request: { approvalDigest, id, kind: "erasure" },
      }),
    ).rejects.toBeInstanceOf(RetentionNotFoundError);
    expect(repo.requeueExport).not.toHaveBeenCalled();
  });
});
