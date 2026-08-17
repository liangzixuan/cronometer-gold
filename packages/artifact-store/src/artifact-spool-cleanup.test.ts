import { mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupOrphanedAuthenticatedArtifactSpools,
  cleanupOrphanedPrivateSpools,
} from "./artifact-spool-cleanup.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("authenticated artifact orphan spool cleanup", () => {
  it("removes only old, owned, exact-prefix directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-test-"));
    cleanup.push(root);
    const old = join(root, "nutrition-artifact-read-old");
    const fresh = join(root, "nutrition-artifact-read-fresh");
    const unrelated = join(root, "user-data");
    await Promise.all([mkdir(old), mkdir(fresh), mkdir(unrelated)]);
    await utimes(old, new Date("2026-08-15T00:00:00.000Z"), new Date("2026-08-15T00:00:00.000Z"));
    const result = await cleanupOrphanedAuthenticatedArtifactSpools({
      clock: () => new Date("2026-08-16T00:00:00.000Z"),
      directory: root,
      olderThanMs: 60 * 60_000,
      ...(process.getuid === undefined ? {} : { ownerUid: process.getuid() }),
    });
    expect(result).toEqual({ inspected: 2, removed: 1 });
    expect((await readdir(root)).sort()).toEqual(["nutrition-artifact-read-fresh", "user-data"]);
  });

  it("never follows a matching symlink and rejects broad roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-link-test-"));
    const target = await mkdtemp(join(tmpdir(), "artifact-cleanup-target-test-"));
    cleanup.push(root, target);
    await symlink(target, join(root, "nutrition-artifact-read-link"));
    const result = await cleanupOrphanedAuthenticatedArtifactSpools({
      clock: () => new Date("2026-08-16T00:00:00.000Z"),
      directory: root,
      olderThanMs: 60_000,
    });
    expect(result.removed).toBe(0);
    await expect(
      cleanupOrphanedAuthenticatedArtifactSpools({ directory: "/", olderThanMs: 60_000 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("uses a closed worker export prefix and never removes authenticated-read spools", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-worker-test-"));
    cleanup.push(root);
    const worker = join(root, "nutrition-account-export-old");
    const reader = join(root, "nutrition-artifact-read-old");
    await Promise.all([mkdir(worker), mkdir(reader)]);
    const old = new Date("2026-08-15T00:00:00.000Z");
    await Promise.all([utimes(worker, old, old), utimes(reader, old, old)]);
    const result = await cleanupOrphanedPrivateSpools({
      clock: () => new Date("2026-08-16T00:00:00.000Z"),
      directory: root,
      olderThanMs: 60_000,
      prefix: "nutrition-account-export-",
    });
    expect(result).toEqual({ inspected: 1, removed: 1 });
    expect(await readdir(root)).toEqual(["nutrition-artifact-read-old"]);
  });
});
