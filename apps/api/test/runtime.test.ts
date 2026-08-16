import { afterEach, describe, expect, it } from "vitest";

import { type ApiSearchRuntime, createApiSearchRuntime } from "../src/search-runtime.js";

const runtimes: ApiSearchRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => runtime.close()));
});

describe("production API runtime", () => {
  it("wires search and every private persistence service around one owned runtime", () => {
    const runtime = createApiSearchRuntime(
      { DATABASE_URL: "postgresql://local.invalid/nutrition", NODE_ENV: "test" },
      {
        cursorSecret: "test-cursor-secret-that-is-longer-than-thirty-two-bytes",
        databaseUrl: "postgresql://local.invalid/nutrition",
        meiliUrl: "http://127.0.0.1:7700",
        searchDatabaseMaxConcurrency: 2,
        searchDatabaseMaxQueue: 2,
        searchRequestTimeoutMs: 100,
      },
    );
    runtimes.push(runtime);

    expect(runtime.authService).toBeDefined();
    expect(runtime.profileService).toBeDefined();
    expect(runtime.diaryService).toBeDefined();
    expect(runtime.foodSearchService).toBeDefined();
    expect(runtime.recipeService).toBeDefined();
    expect(runtime.goalService).toBeDefined();
  });
});
