import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/deployment/runtime/route";
import { observeBuild, observeServer, providerIdentity } from "./appwrite-runtime.cjs";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = {
  revision: "a".repeat(40),
  tree: "b".repeat(40),
  sourceManifestSha256: "c".repeat(64),
};
const provider = {
  APPWRITE_SITE_API_ENDPOINT: "https://nyc.cloud.appwrite.io/v1",
  APPWRITE_SITE_PROJECT_ID: "6abac02e002f10c31ac2",
  APPWRITE_SITE_ID: "fixture-site",
  APPWRITE_SITE_DEPLOYMENT: "fixture-deployment",
};
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function manifest(override = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nourishing-runtime-test-"));
  directories.push(directory);
  const files = [{ path: "fixture", type: "file", mode: "100644", size: 1, sha256: digest("x") }];
  const value = {
    schemaVersion: 1,
    ...source,
    entrypoint: "start-site.cjs",
    payloadEntrypoint: "payload/apps/web/server.js",
    files,
    outputTreeSha256: digest(JSON.stringify(files)),
    ...override,
  };
  const path = join(directory, "output-manifest.json");
  writeFileSync(path, JSON.stringify(value));
  return { path, value };
}

describe("actual Appwrite process observations", () => {
  it("measures versions and hashes real native bytes without serializing private environment", () => {
    const report = observeBuild(source, { PRIVATE_SENTINEL: "never-publish-this" });
    expect(report.node).toBe(process.versions.node);
    expect(report.openssl).toBe(process.versions.openssl);
    expect(report.architecture).toBe(process.arch);
    expect(report.libc).toMatch(/^(glibc|musl)@\d+\.\d+/);
    expect(report.nativeInventory).toContainEqual({
      path: realpathSync(process.execPath),
      sha256: digest(readFileSync(process.execPath)),
    });
    expect(report.provider).toBeNull();
    expect(report.outputTreeSha256).toBeNull();
    expect(report.qualificationPerformed).toBe(false);
    const json = JSON.stringify(report);
    for (const forbidden of [
      "never-publish-this",
      "PRIVATE_SENTINEL",
      "advisoryAssessment",
      "opensslFixCommit",
      '"high":',
      '"critical":',
    ])
      expect(json).not.toContain(forbidden);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(65536);
    expect(Date.now() - Date.parse(report.observedAt)).toBeLessThan(30_000);
  });
  it("accepts only complete official provider identifiers", () => {
    expect(providerIdentity(provider)?.siteId).toBe("fixture-site");
    expect(() => providerIdentity({ APPWRITE_SITE_ID: "partial" })).toThrow();
    expect(() =>
      providerIdentity({ ...provider, APPWRITE_SITE_API_ENDPOINT: "https://other.invalid/v1" }),
    ).toThrow();
    expect(() => providerIdentity({ ...provider, APPWRITE_SITE_PROJECT_ID: "wrong" })).toThrow();
    expect(() =>
      providerIdentity({ ...provider, APPWRITE_SITE_DEPLOYMENT: "../secret" }),
    ).toThrow();
    expect(() => observeBuild({ ...source, revision: "invalid" }, {})).toThrow();
  });
  it("binds SSR observations to the validated output manifest and actual provider", () => {
    const { path, value } = manifest();
    const report = observeServer({ ...provider, NOURISHING_OUTPUT_MANIFEST: path });
    expect(report.phase).toBe("ssr");
    expect(report.sourceRevision).toBe(source.revision);
    expect(report.outputTreeSha256).toBe(value.outputTreeSha256);
    expect(report.provider?.deploymentId).toBe(provider.APPWRITE_SITE_DEPLOYMENT);
    expect(() => observeServer({ NOURISHING_OUTPUT_MANIFEST: path })).toThrow();
    expect(() => observeServer(provider)).toThrow();
    const bad = manifest({ outputTreeSha256: "d".repeat(64) });
    expect(() => observeServer({ ...provider, NOURISHING_OUTPUT_MANIFEST: bad.path })).toThrow();
  });
  it("serves only bounded no-store observations and rejects path-selection queries", async () => {
    const { path } = manifest();
    for (const [key, value] of Object.entries({
      ...provider,
      NOURISHING_OUTPUT_MANIFEST: path,
      PRIVATE_SENTINEL: "never-publish-this",
    }))
      vi.stubEnv(key, value);
    const response = GET(new Request("https://fixture.invalid/api/deployment/runtime"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.json()).phase).toBe("ssr");
    expect(
      GET(new Request("https://fixture.invalid/api/deployment/runtime?path=/etc/passwd")).status,
    ).toBe(400);
    vi.stubEnv("NOURISHING_OUTPUT_MANIFEST", "/unavailable/private/sentinel");
    const unavailable = GET(new Request("https://fixture.invalid/api/deployment/runtime"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Runtime observation unavailable" });
  });
});
