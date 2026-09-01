import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLoggerOptions } from "../src/logging.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import type { DiaryService } from "../src/modules/diary/diary.routes.js";
import { account, bearerToken, operationId, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("private-route telemetry boundary", () => {
  it("never logs bearer, password, diary timestamps, operation IDs, or backend messages", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const logger = { ...createLoggerOptions(config), stream };
    const privateFailure = "private-diary-database-value";
    const authService: AuthService = {
      reauthenticate: vi.fn(),
      register: vi.fn(),
      login: vi.fn(async () => Promise.reject(new Error(privateFailure))),
      authenticate: vi.fn(async (header) =>
        header === `Bearer ${bearerToken}`
          ? { account, userId, sessionTokenHash: "a".repeat(64) }
          : null,
      ),
      authenticateErasureRecovery: vi.fn(async () => null),
      logout: vi.fn(),
    };
    const diaryService: DiaryService = {
      getDay: vi.fn(),
      createEntry: vi.fn(async () => Promise.reject(new Error(privateFailure))),
      updateEntry: vi.fn(),
      deleteEntry: vi.fn(),
    };
    const app = buildApp({ config, logger, authService, diaryService });
    apps.push(app);
    const password = "private password value";
    const occurredAt = "2026-08-15T13:30:00.000Z";
    const expectedProfileTimeZone = "America/Chicago";

    await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "private@example.com", password },
    });
    await app.inject({
      method: "POST",
      url: "/v1/diary/entries?profileTimeZonePrecondition=v1",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "idempotency-key": operationId,
        "x-expected-profile-time-zone": expectedProfileTimeZone,
      },
      payload: {
        foodVersionId: "202",
        portion: { kind: "grams", grams: "100" },
        mealSlot: "breakfast",
        occurredAt,
      },
    });

    expect(output).toContain("/v1/auth/login");
    expect(output).toContain("/v1/diary/entries");
    for (const privateValue of [
      bearerToken,
      password,
      occurredAt,
      expectedProfileTimeZone,
      operationId,
      "private@example.com",
      privateFailure,
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });
});
