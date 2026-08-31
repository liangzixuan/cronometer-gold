import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  createDatabase: vi.fn(),
  database: { destroy: vi.fn() },
  rebuild: vi.fn(),
}));

vi.mock("@nutrition-tracker/db", () => ({
  MAX_PRIVACY_EXPORT_SNAPSHOT_BYTES: 10 * 1_024 * 1_024 * 1_024,
  createDatabaseFromEnvironment: mocks.createDatabase,
}));
vi.mock("@nutrition-tracker/search", () => ({
  MeilisearchHttpClient: class {
    constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
}));
vi.mock("./food-search-worker.js", () => ({ rebuildFoodSearchNow: mocks.rebuild }));

import { runSearchRebuildCommand } from "./search-rebuild.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientOptions.length = 0;
  mocks.createDatabase.mockReturnValue(mocks.database);
  mocks.database.destroy.mockResolvedValue(undefined);
  mocks.rebuild.mockResolvedValue(undefined);
});

describe("search rebuild command", () => {
  it("routes mutation and task-observer credentials into the production client", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runSearchRebuildCommand({
          DATABASE_URL: "postgresql://local.invalid/nutrition",
          MEILI_ADMIN_KEY: "scoped-mutation-key-long-enough",
          MEILI_TASK_OBSERVER_KEY: "scoped-task-observer-key-long-enough",
          MEILI_URL: "http://127.0.0.1:7700",
          NODE_ENV: "test",
        }),
      ).resolves.toBe(2);

      expect(mocks.clientOptions).toEqual([
        {
          apiKey: "scoped-mutation-key-long-enough",
          host: "http://127.0.0.1:7700",
          requestTimeoutMs: 5_000,
          taskApiKey: "scoped-task-observer-key-long-enough",
        },
      ]);
      expect(mocks.createDatabase).toHaveBeenCalledWith(
        expect.objectContaining({ DATABASE_URL: "postgresql://local.invalid/nutrition" }),
      );
      expect(mocks.database.destroy).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
    }
  });
});
