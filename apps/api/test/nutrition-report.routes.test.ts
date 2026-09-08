import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  NutritionReportCapacityServiceError,
  NutritionReportNotFoundServiceError,
  NutritionReportPersistedIntegrityServiceError,
  NutritionReportRangeServiceError,
  type NutritionReportService,
} from "../src/modules/reports/nutrition-report.routes.js";
import { account, bearerToken, userId } from "./fixtures.js";
import { nutritionReportResponseFixture, reportOwnerId } from "./nutrition-report-fixture.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const authHeaders = { authorization: `Bearer ${bearerToken}` };

function authStub(): AuthService {
  return {
    authenticate: vi.fn(async (header) =>
      header === `Bearer ${bearerToken}`
        ? { account, sessionTokenHash: "a".repeat(64), userId }
        : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    confirmEmailVerification: vi.fn(),
    confirmPasswordRecovery: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    reauthenticate: vi.fn(),
    register: vi.fn(),
    requestEmailVerification: vi.fn(),
    requestPasswordRecovery: vi.fn(),
  };
}

function createTestApp(service?: NutritionReportService) {
  const app = buildApp({
    authService: authStub(),
    config: testConfig,
    logger: false,
    ...(service ? { nutritionReportService: service } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("nutrition report route", () => {
  it("returns one private authenticated snapshot and derives the owner server-side", async () => {
    const getNutritionReport = vi.fn(async () => nutritionReportResponseFixture(userId));
    const app = createTestApp({ getNutritionReport });
    const response = await app.inject({
      headers: authHeaders,
      method: "GET",
      url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().data.ownerUserId).toBe(userId);
    expect(getNutritionReport).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-09-07", to: "2026-09-07", userId }),
    );
  });

  it("requires authentication and never calls the report service without it", async () => {
    const getNutritionReport = vi.fn(async () => nutritionReportResponseFixture(userId));
    const app = createTestApp({ getNutritionReport });
    const response = await app.inject({
      method: "GET",
      url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
    });
    expect(response.statusCode).toBe(401);
    expect(getNutritionReport).not.toHaveBeenCalled();
  });

  it("rejects malformed, extra, reversed, and 32-day queries before the service", async () => {
    const getNutritionReport = vi.fn(async () => nutritionReportResponseFixture(userId));
    const app = createTestApp({ getNutritionReport });
    for (const [url, status] of [
      ["/v1/reports/nutrition?from=2026-02-30&to=2026-03-01", 400],
      ["/v1/reports/nutrition?from=2026-09-07&to=2026-09-07&owner=x", 400],
      ["/v1/reports/nutrition?from=2026-09-08&to=2026-09-07", 422],
      ["/v1/reports/nutrition?from=2026-01-01&to=2026-02-01", 422],
    ] as const) {
      const response = await app.inject({ headers: authHeaders, method: "GET", url });
      expect(response.statusCode).toBe(status);
    }
    expect(getNutritionReport).not.toHaveBeenCalled();
  });

  it("fails closed when the service is absent or returns another owner", async () => {
    const absent = await createTestApp().inject({
      headers: authHeaders,
      method: "GET",
      url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
    });
    expect(absent.statusCode).toBe(503);

    const mismatch = await createTestApp({
      getNutritionReport: vi.fn(async () => nutritionReportResponseFixture(reportOwnerId)),
    }).inject({
      headers: authHeaders,
      method: "GET",
      url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
    });
    expect(mismatch.statusCode).toBe(503);
  });

  it("maps range, absent-owner, and persisted-integrity failures without details", async () => {
    for (const [error, status] of [
      [new NutritionReportRangeServiceError(), 422],
      [new NutritionReportNotFoundServiceError(), 404],
      [new NutritionReportPersistedIntegrityServiceError(), 503],
    ] as const) {
      const app = createTestApp({
        getNutritionReport: vi.fn(async () => Promise.reject(error)),
      });
      const response = await app.inject({
        headers: authHeaders,
        method: "GET",
        url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
      });
      expect(response.statusCode).toBe(status);
      expect(JSON.stringify(response.json())).not.toContain(error.constructor.name);
    }
  });

  it("maps report capacity separately from date-range validation", async () => {
    const error = new NutritionReportCapacityServiceError();
    const app = createTestApp({
      getNutritionReport: vi.fn(async () => Promise.reject(error)),
    });
    const response = await app.inject({
      headers: authHeaders,
      method: "GET",
      url: "/v1/reports/nutrition?from=2026-09-07&to=2026-09-07",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "REPORT_CAPACITY_EXCEEDED",
      detail:
        "This nutrition report contains too many current entries or source time zones to return safely. Choose a shorter range.",
    });
    expect(response.json().detail).not.toContain("1 to 31 local days");
  });
});
