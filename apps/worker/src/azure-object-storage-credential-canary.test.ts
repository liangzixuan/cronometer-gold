import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseAzureObjectStorageCanaryConfiguration,
  runAzureObjectStorageCredentialCanaryFromEnvironment,
} from "./azure-object-storage-credential-canary.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("@nutrition-tracker/artifact-store", async (original) => {
  const actual = await original<typeof import("@nutrition-tracker/artifact-store")>();
  return { ...actual, runAzureBlobCredentialCanary: run };
});
function sas(sp: string, role: string) {
  return new URLSearchParams({
    sv: "2026-04-06",
    spr: "https",
    st: "2026-10-17T19:00:00Z",
    se: "2026-10-17T23:00:00Z",
    sr: "c",
    sp,
    sig: `synthetic-${role}`,
    skoid: role,
    sktid: "tenant",
    skt: "2026-10-17T18:00:00Z",
    ske: "2026-10-18T00:00:00Z",
    sks: "b",
    skv: "2026-04-06",
  }).toString();
}
function env(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    NOURISHING_API_PROFILE: "hosted-development",
    EXPORT_ARTIFACT_STORE: "azure",
    ERASURE_REPLAY_LEDGER_STORE: "azure",
    EXPORT_ARTIFACT_AZURE_CONTAINER_URL: "https://canaryexports.blob.core.windows.net/exports",
    EXPORT_ARTIFACT_AZURE_PREFIX: "development/exports/",
    EXPORT_ARTIFACT_AZURE_READ_SAS: sas("r", "reader"),
    EXPORT_ARTIFACT_AZURE_WRITE_SAS: sas("rcd", "writer"),
    EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS: sas("l", "observer"),
    ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL: "https://canaryledger.blob.core.windows.net/ledger",
    ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "development/ledger/",
    ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS: sas("rc", "ledger"),
    ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: sas("rl", "restore"),
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 17, 20));
  run.mockReset();
});
afterEach(() => vi.restoreAllMocks());
describe("Azure maintenance entrypoint configuration", () => {
  it("joins only explicit credentials into the actual operation", async () => {
    run.mockResolvedValue({
      exportCleanupVerified: true,
      ledgerCanaryRetained: true,
      ledgerVersionVerified: true,
    });
    await expect(
      runAzureObjectStorageCredentialCanaryFromEnvironment(env(), { onStart() {} }),
    ).resolves.toMatchObject({ exportCleanupVerified: true });
    expect(run).toHaveBeenCalledWith(parseAzureObjectStorageCanaryConfiguration(env()), {
      onStart: expect.any(Function),
    });
  });
  it.each([
    "NODE_ENV",
    "NOURISHING_API_PROFILE",
    "EXPORT_ARTIFACT_STORE",
    "ERASURE_REPLAY_LEDGER_STORE",
    "EXPORT_ARTIFACT_AZURE_CONTAINER_URL",
    "EXPORT_ARTIFACT_AZURE_PREFIX",
    "EXPORT_ARTIFACT_AZURE_READ_SAS",
    "EXPORT_ARTIFACT_AZURE_WRITE_SAS",
    "EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS",
    "ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL",
    "ERASURE_REPLAY_LEDGER_AZURE_PREFIX",
    "ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS",
    "ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS",
  ])("requires explicit %s", async (field) => {
    const e = env();
    delete e[field];
    await expect(
      runAzureObjectStorageCredentialCanaryFromEnvironment(e, { onStart() {} }),
    ).rejects.toThrow("Azure artifact storage operation failed");
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["production", "test"])("rejects %s operation", (value) => {
    const e = env();
    e.NODE_ENV = value;
    expect(() => parseAzureObjectStorageCanaryConfiguration(e)).toThrow();
  });
  it("cannot fall back to S3 or filesystem", () => {
    const e = env();
    e.EXPORT_ARTIFACT_STORE = "s3";
    expect(() => parseAzureObjectStorageCanaryConfiguration(e)).toThrow();
  });
  it("runs directly and reports only a bounded generic failure for rejected configuration", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./azure-object-storage-credential-canary.ts", import.meta.url)),
      ],
      {
        env: {
          NODE_ENV: "production",
          EXPORT_ARTIFACT_AZURE_WRITE_SAS: "private-synthetic-sentinel",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      event: "azure_object_storage.credentials.failed",
      level: "fatal",
    });
    expect(result.stderr).not.toContain("private-synthetic-sentinel");
  });
});
