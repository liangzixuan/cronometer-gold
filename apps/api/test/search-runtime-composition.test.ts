import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDatabaseReady: vi.fn(),
  coreFoodSearchService: vi.fn(),
  createApiRetentionArtifactRuntime: vi.fn(),
  createDatabaseFromEnvironment: vi.fn(),
  databaseAuthRepository: vi.fn(),
  databaseBackedFoodSearchService: vi.fn(),
  databaseDiaryService: vi.fn(),
  databaseGoalService: vi.fn(),
  databaseProfileService: vi.fn(),
  databaseRecipeService: vi.fn(),
  databaseRetentionService: vi.fn(),
  meilisearchFoodSearchBackend: vi.fn(),
  meilisearchHttpClient: vi.fn(),
  secureAuthService: vi.fn(),
}));

vi.mock("@nutrition-tracker/db", () => ({
  assertDatabaseReady: mocks.assertDatabaseReady,
  createDatabaseFromEnvironment: mocks.createDatabaseFromEnvironment,
}));

vi.mock("@nutrition-tracker/search", () => ({
  FoodSearchService: class {
    constructor(options: unknown) {
      mocks.coreFoodSearchService(options);
    }
  },
  MeilisearchFoodSearchBackend: class {
    constructor(options: unknown) {
      mocks.meilisearchFoodSearchBackend(options);
    }
  },
  MeilisearchHttpClient: class {
    constructor(options: unknown) {
      mocks.meilisearchHttpClient(options);
    }
  },
}));

vi.mock("../src/modules/auth/auth-service.js", () => ({
  SecureAuthService: class {
    constructor(options: unknown) {
      mocks.secureAuthService(options);
    }
  },
}));

vi.mock("../src/modules/foods/search-service.js", () => ({
  DatabaseBackedFoodSearchService: class {
    constructor(options: unknown) {
      mocks.databaseBackedFoodSearchService(options);
    }
  },
}));

vi.mock("../src/persistence-services.js", () => ({
  DatabaseAuthRepository: class {
    constructor(database: unknown) {
      mocks.databaseAuthRepository(database);
    }
  },
  DatabaseDiaryService: class {
    constructor(database: unknown, options: unknown) {
      mocks.databaseDiaryService(database, options);
    }
  },
  DatabaseGoalService: class {
    constructor(database: unknown) {
      mocks.databaseGoalService(database);
    }
  },
  DatabaseProfileService: class {
    constructor(database: unknown) {
      mocks.databaseProfileService(database);
    }
  },
  DatabaseRecipeService: class {
    constructor(database: unknown) {
      mocks.databaseRecipeService(database);
    }
  },
}));

vi.mock("../src/retention-artifact-runtime.js", () => ({
  createApiRetentionArtifactRuntime: mocks.createApiRetentionArtifactRuntime,
}));

vi.mock("../src/retention-persistence-service.js", () => ({
  DatabaseRetentionService: class {
    constructor(options: unknown) {
      mocks.databaseRetentionService(options);
    }
  },
}));

import type { ApiDependencyConfig, ApiRetentionDependencyConfig } from "../src/config.js";
import { createApiSearchRuntime } from "../src/search-runtime.js";

function retentionConfig(): ApiRetentionDependencyConfig {
  return {
    artifactDirectory: "/var/lib/nutrition/encrypted-exports",
    artifactEncryptionKeyRing: {
      currentKeyId: "export-v1",
      keys: new Map([["export-v1", Buffer.alloc(32, 1)]]),
      purpose: "export",
    },
    artifactReadMaximumArtifactBytes: 100 * 1_024 * 1_024,
    artifactReadMaximumBytesPerWindow: 200 * 1_024 * 1_024,
    artifactReadMaximumConcurrency: 2,
    artifactReadMaximumDownloadsPerWindow: 3,
    artifactReadMaximumReservedBytes: 100 * 1_024 * 1_024,
    artifactReadRateWindowMs: 60_000,
    artifactReadSpoolDirectory: "/dev/shm/nutrition-api-clock-test",
    artifactReadSpoolMaximumAgeMs: 60_000,
    artifactReadSpoolProtection: "tmpfs",
    artifactRequestTimeoutMs: 5_000,
    artifactStore: "filesystem",
    deviceChallengeHmacKey: Buffer.alloc(32, 2),
    erasureLedgerLocatorKeyRing: {
      currentKeyId: "locator-v1",
      keys: new Map([["locator-v1", Buffer.alloc(32, 3)]]),
    },
    erasureStatusCapabilityHmacKey: Buffer.alloc(32, 4),
  };
}

function dependencyConfig(retention = retentionConfig()): ApiDependencyConfig {
  return {
    cursorSecret: "clock-composition-cursor-secret-longer-than-thirty-two-bytes",
    databaseRestoreEpoch: null,
    databaseUrl: "postgresql://local.invalid/nutrition",
    meiliSearchKey: "scoped-search-key",
    meiliUrl: "http://127.0.0.1:7700",
    requireDatabaseRestoreAttestation: false,
    retention,
    searchDatabaseMaxConcurrency: 2,
    searchDatabaseMaxQueue: 2,
    searchRequestTimeoutMs: 100,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.assertDatabaseReady.mockResolvedValue(undefined);
});

describe("API dependency runtime composition", () => {
  it("propagates one clock through auth, retention, and the artifact bulkhead seam", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const database = { destroy };
    const artifactRuntime = {
      bulkhead: { boundary: "artifact-read-bulkhead" },
      store: { boundary: "encrypted-artifact-store" },
    };
    mocks.createDatabaseFromEnvironment.mockReturnValue(database);
    mocks.createApiRetentionArtifactRuntime.mockResolvedValue(artifactRuntime);
    const config = dependencyConfig();
    const environment = {
      DATABASE_URL: "postgresql://ambient.invalid/must-be-overridden",
      NODE_ENV: "test",
    };
    const clock = () => new Date("2035-08-30T12:00:00.000Z");

    const runtime = await createApiSearchRuntime(environment, config, { clock });

    expect(mocks.createDatabaseFromEnvironment).toHaveBeenCalledWith({
      ...environment,
      DATABASE_URL: config.databaseUrl,
    });
    expect(mocks.createApiRetentionArtifactRuntime).toHaveBeenCalledWith(config.retention, {
      clock,
    });
    expect(mocks.secureAuthService).toHaveBeenCalledWith(expect.objectContaining({ clock }));
    expect(mocks.databaseDiaryService).toHaveBeenCalledWith(database, {
      cursorSecret: config.cursorSecret,
    });
    expect(mocks.databaseRetentionService).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: artifactRuntime,
        clock,
        database,
      }),
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the database once when retention composition fails", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.createDatabaseFromEnvironment.mockReturnValue({ destroy });
    mocks.createApiRetentionArtifactRuntime.mockResolvedValue({ bulkhead: {}, store: {} });
    const primary = new Error("synthetic retention composition failure");
    mocks.databaseRetentionService.mockImplementationOnce(() => {
      throw primary;
    });

    await expect(
      createApiSearchRuntime({ NODE_ENV: "test" }, dependencyConfig(), {
        clock: () => new Date("2035-08-30T12:00:00.000Z"),
      }),
    ).rejects.toBe(primary);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
