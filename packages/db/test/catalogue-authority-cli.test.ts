import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  databaseSsl,
  main,
  parseArguments,
  parseCanonicalDeploymentPolicyBytes,
  readPrivateFile,
  requirePrivateLocalPath,
  writePrivateNewFile,
} from "../src/catalogue-authority-cli.js";
import {
  CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  parseCatalogueAuthorityDeploymentPolicy,
} from "../src/catalogue-authority-deployment.js";
import { canonicalJson } from "../src/catalogue-validation.js";
import type { JsonValue } from "../src/types.js";

const rawPolicy = {
  applicationSchema: "public",
  applicationSchemaOwner: "pg_database_owner",
  approvalFunctionSourceSha256: CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  approvalGuardSourceSha256: CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  databaseName: "nutrition_tracker",
  databaseOwner: "nutrition_app",
  effectiveLoginAllowlist: [
    "nutrition_api",
    "nutrition_app",
    "nutrition_catalogue_data_reviewer",
    "nutrition_catalogue_quality_reviewer",
    "nutrition_catalogue_rights_reviewer",
    "nutrition_catalogue_unassigned_canary",
    "nutrition_worker",
  ],
  nonReviewerLogins: {
    api: "nutrition_api",
    unassigned: "nutrition_catalogue_unassigned_canary",
    worker: "nutrition_worker",
  },
  policyKind: "catalogue-authority-deployment",
  reviewerLogins: {
    data: "nutrition_catalogue_data_reviewer",
    quality: "nutrition_catalogue_quality_reviewer",
    rights: "nutrition_catalogue_rights_reviewer",
  },
  schemaVersion: 1,
} as const;

function canonicalPolicyBytes(): string {
  const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
  return `${canonicalJson(policy as unknown as JsonValue)}\n`;
}

describe("catalogue authority deployment CLI boundary", () => {
  it("accepts only the exact argument order and resolves both paths", () => {
    expect(
      parseArguments([
        "--policy",
        ".local-data/policy.json",
        "--evidence-out",
        ".local-data/evidence.json",
      ]),
    ).toEqual({
      evidenceOut: resolve(".local-data/evidence.json"),
      policy: resolve(".local-data/policy.json"),
    });
    expect(() => parseArguments(["--policy", ".local-data/policy.json"])).toThrow(/Usage/u);
    expect(() =>
      parseArguments([
        "--evidence-out",
        ".local-data/evidence.json",
        "--policy",
        ".local-data/policy.json",
      ]),
    ).toThrow(/Usage/u);
  });

  it("requires an absolute normalized path with an exact .local-data segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogue-authority-cli-"));
    try {
      const localData = join(root, ".local-data");
      await mkdir(localData);
      const accepted = join(localData, "policy.json");
      await expect(requirePrivateLocalPath(accepted, "policy")).resolves.toBeUndefined();
      await expect(requirePrivateLocalPath(".local-data/policy.json", "policy")).rejects.toThrow(
        /ignored \.local-data path/u,
      );
      await expect(
        requirePrivateLocalPath(join(root, ".local-data-shadow", "policy.json"), "policy"),
      ).rejects.toThrow(/ignored \.local-data path/u);
      await expect(
        requirePrivateLocalPath(
          [localData, "..", ".local-data", "policy.json"].join(sep),
          "policy",
        ),
      ).rejects.toThrow(/ignored \.local-data path/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects symlinks above, at, or below the .local-data boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogue-authority-cli-"));
    try {
      const realRoot = join(root, "real");
      const localData = join(realRoot, ".local-data");
      const realParent = join(localData, "policies");
      await mkdir(realParent, { recursive: true });

      const linkedRoot = join(root, "linked-root");
      await symlink(realRoot, linkedRoot, "dir");
      await expect(
        requirePrivateLocalPath(join(linkedRoot, ".local-data", "policy.json"), "policy"),
      ).rejects.toThrow(/must not contain symlinks/u);

      const markerHost = join(root, "marker-host");
      await mkdir(markerHost);
      await symlink(localData, join(markerHost, ".local-data"), "dir");
      await expect(
        requirePrivateLocalPath(join(markerHost, ".local-data", "policy.json"), "policy"),
      ).rejects.toThrow(/must not contain symlinks/u);

      const linkedParent = join(localData, "linked-parent");
      await symlink(realParent, linkedParent, "dir");
      await expect(
        requirePrivateLocalPath(join(linkedParent, "policy.json"), "policy"),
      ).rejects.toThrow(/must not contain symlinks/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts only exact canonical policy bytes", () => {
    const bytes = canonicalPolicyBytes();
    expect(parseCanonicalDeploymentPolicyBytes(bytes)).toEqual(
      parseCatalogueAuthorityDeploymentPolicy(rawPolicy),
    );

    const pretty = `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`;
    expect(() => parseCanonicalDeploymentPolicyBytes(pretty)).toThrow(/not canonical JSON/u);
    expect(() => parseCanonicalDeploymentPolicyBytes(bytes.trimEnd())).toThrow(
      /not canonical JSON/u,
    );

    const duplicateKey = bytes.replace("{", '{"applicationSchema":"shadow",');
    expect(() => parseCanonicalDeploymentPolicyBytes(duplicateKey)).toThrow(/not canonical JSON/u);
    expect(() => parseCanonicalDeploymentPolicyBytes("{")).toThrow(/not valid JSON/u);
  });

  it("enforces verified TLS except for literal loopback and rejects URL overrides", () => {
    expect(databaseSsl("verify-full", ["postgresql://user:secret@db.example/test"])).toEqual({
      rejectUnauthorized: true,
    });
    expect(
      databaseSsl("disable", [
        "postgresql://user:secret@127.0.0.1/test",
        "postgresql://user:secret@[::1]/test",
      ]),
    ).toBe(false);
    expect(() => databaseSsl("disable", ["postgresql://user:secret@localhost/test"])).toThrow(
      /literal loopback/u,
    );
    expect(() => databaseSsl("disable", ["postgresql://user:secret@db.example/test"])).toThrow(
      /literal loopback/u,
    );
    expect(() =>
      databaseSsl("disable", [
        "postgresql://user:secret@127.0.0.1/test",
        "postgresql://user:secret@db.example/test",
      ]),
    ).toThrow(/literal loopback/u);
    expect(() => databaseSsl("require", ["postgresql://user:secret@localhost/test"])).toThrow(
      /must be verify-full/u,
    );
    expect(() =>
      databaseSsl("verify-full", ["postgresql://user:secret@db.example/test?sslmode=disable"]),
    ).toThrow(/query parameters/u);
    expect(() =>
      databaseSsl("verify-full", ["postgresql://user:secret@db.example/test?useLibpqCompat=true"]),
    ).toThrow(/query parameters/u);
    expect(() =>
      databaseSsl("disable", [
        "postgresql://user:secret@127.0.0.1/test?host=db.example&options=-c%20role%3Downer",
      ]),
    ).toThrow(/query parameters/u);
    expect(() =>
      databaseSsl("verify-full", ["postgresql://user:secret@db.example/test#override"]),
    ).toThrow(/query parameters/u);
    expect(() => databaseSsl("verify-full", ["https://db.example/test"])).toThrow(
      /must use PostgreSQL/u,
    );
    expect(() => databaseSsl("verify-full", ["not-a-url"])).toThrow(/valid PostgreSQL URLs/u);
  });

  it("refuses a process-wide Node TLS bypass before reading the policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogue-authority-cli-"));
    try {
      const localData = join(root, ".local-data");
      await mkdir(localData);
      await expect(
        main(
          [
            "--policy",
            join(localData, "missing-policy.json"),
            "--evidence-out",
            join(localData, "evidence.json"),
          ],
          { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        ),
      ).rejects.toThrow(/refuses disabled Node TLS verification/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads only mode-0600 single-link regular files without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogue-authority-cli-"));
    try {
      const localData = join(root, ".local-data");
      await mkdir(localData);
      const policy = join(localData, "policy.json");
      await writeFile(policy, "{}\n", { mode: 0o600 });
      await chmod(policy, 0o600);
      await expect(readPrivateFile(policy)).resolves.toBe("{}\n");

      const hardLink = join(localData, "policy-hard-link.json");
      await link(policy, hardLink);
      await expect(readPrivateFile(policy)).rejects.toThrow(/mode-0600 single-link/u);

      const symlinkPath = join(localData, "policy-symbolic-link.json");
      await symlink(policy, symlinkPath);
      await expect(readPrivateFile(symlinkPath)).rejects.toBeDefined();

      await rm(hardLink);
      await chmod(policy, 0o640);
      await expect(readPrivateFile(policy)).rejects.toThrow(/mode-0600 single-link/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("creates new evidence exactly once as a mode-0600 regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogue-authority-cli-"));
    try {
      const localData = join(root, ".local-data");
      await mkdir(localData);
      const evidence = join(localData, "evidence.json");
      await writePrivateNewFile(evidence, "evidence\n");
      expect(await readFile(evidence, "utf8")).toBe("evidence\n");
      const state = await lstat(evidence);
      expect(state.isFile()).toBe(true);
      expect(state.isSymbolicLink()).toBe(false);
      expect(state.nlink).toBe(1);
      expect(state.mode & 0o777).toBe(0o600);
      await expect(writePrivateNewFile(evidence, "replacement\n")).rejects.toBeDefined();
      expect(await readFile(evidence, "utf8")).toBe("evidence\n");
      expect(constants.O_NOFOLLOW).toBeTypeOf("number");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
