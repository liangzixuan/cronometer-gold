import type {
  NutritionGoal,
  NutritionGoalMutationResponse,
  NutritionGoalProgressResponse,
  TargetableNutrientListResponse,
} from "@nutrition-tracker/contracts";
import { canonicalNonNegativeDecimal, decimal } from "@nutrition-tracker/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  type GoalService,
  GoalUnsupportedProfileServiceError,
} from "../src/modules/goals/goal.routes.js";
import { account, bearerToken, operationId, userId } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const goalId = "4037e074-ff9d-4242-a0aa-33540576946d";
const goalVersionId = "426642af-cf97-4a55-9dc5-a22df25a3e85";
const energyLowerBoundPercent = canonicalNonNegativeDecimal(decimal(1800).mul(100).div(2580));

const fiber = {
  id: "1079",
  code: "fiber",
  name: "Fiber",
  unit: "g",
  category: "macronutrient",
} as const;

const goal: NutritionGoal = {
  id: goalId,
  status: "active",
  effectiveFrom: "2026-08-16",
  effectiveTo: null,
  revision: "1",
  currentVersion: {
    id: goalVersionId,
    versionNumber: 1,
    energy: {
      mode: "derived",
      targetKcal: "2580",
      bmrKcal: "1720",
      ageYears: 40,
      heightCm: "180",
      weightKg: "80",
      sexAtBirth: "male",
      profileRevision: "7",
      activityLevelCode: "sedentary_or_light",
      activityFactor: "1.5",
      adjustmentKcal: "0",
      source: {
        equation: {
          code: "mifflin-st-jeor-ree",
          version: "1990-original",
          url: "https://doi.org/10.1093/ajcn/51.2.241",
        },
        activityPolicy: {
          code: "fao-who-unu-pal-policy",
          version: "2004-reviewed-v1",
          sourceUrl: "https://www.fao.org/4/y5686e/y5686e07.htm",
        },
      },
      rationale: "User selected an adult energy estimate.",
    },
    nutrientTargets: [
      {
        definition: fiber,
        minimumAmount: "20",
        targetAmount: "30",
        maximumAmount: "50",
        source: { label: "User supplied", version: null },
        rationale: null,
      },
    ],
    createdAt: "2026-08-16T00:00:00.000Z",
  },
  notice: "General wellness estimate; not medical advice.",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const mutation: NutritionGoalMutationResponse = { data: { replayed: false, goal } };
const progress: NutritionGoalProgressResponse = {
  data: {
    localDate: "2026-08-16",
    timeZone: "America/Chicago",
    diaryRevision: "4",
    goal: { id: goalId, versionId: goalVersionId, revision: "1" },
    energy: {
      nutrientId: "1008",
      code: "energy",
      name: "Energy",
      unit: "kcal",
      knownAmount: "1800",
      amountInterpretation: "exact",
      completeness: "complete",
      minimum: null,
      target: { amount: "2580", lowerBoundPercent: energyLowerBoundPercent, percentIsExact: true },
      maximum: null,
    },
    nutrients: [
      {
        nutrientId: fiber.id,
        code: fiber.code,
        name: fiber.name,
        unit: fiber.unit,
        knownAmount: "24",
        amountInterpretation: "lower_bound",
        completeness: "partial",
        minimum: { amount: "20", state: "met" },
        target: { amount: "30", lowerBoundPercent: "80", percentIsExact: false },
        maximum: { amount: "50", state: "indeterminate" },
      },
    ],
    notice: "General wellness estimate; not medical advice.",
  },
};

const targetable: TargetableNutrientListResponse = { data: [fiber] };

function authStub(): AuthService {
  return {
    confirmEmailVerification: vi.fn(),
    confirmPasswordRecovery: vi.fn(),
    reauthenticate: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    authenticate: vi.fn(async (header) =>
      header === `Bearer ${bearerToken}`
        ? { userId, account, sessionTokenHash: "a".repeat(64) }
        : null,
    ),
    authenticateErasureRecovery: vi.fn(async () => null),
    logout: vi.fn(),
    requestEmailVerification: vi.fn(),
    requestPasswordRecovery: vi.fn(),
  };
}

function goalStub(overrides: Partial<GoalService> = {}): GoalService {
  return {
    getCurrent: vi.fn(async () => goal),
    create: vi.fn(async () => mutation),
    revise: vi.fn(async () => mutation),
    progress: vi.fn(async () => progress),
    listTargetable: vi.fn(async () => targetable),
    ...overrides,
  };
}

function createTestApp(goalService: GoalService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    goalService,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const authHeaders = { authorization: `Bearer ${bearerToken}` };
const request = {
  effectiveFrom: "2026-08-16",
  energy: {
    mode: "derived" as const,
    activityLevelCode: "sedentary_or_light" as const,
    activityFactor: "1.5",
    rationale: "User selected an adult energy estimate.",
  },
  nutrientTargets: [
    {
      nutrientId: fiber.id,
      minimumAmount: "20",
      targetAmount: "30",
      maximumAmount: "50",
      source: { label: "User supplied", version: null },
      rationale: null,
    },
  ],
};
const revisionRequest = { energy: request.energy, nutrientTargets: request.nutrientTargets };

describe("nutrition goal routes", () => {
  it("reads the effective private goal by explicit local date without caching", async () => {
    const service = goalStub();
    const app = createTestApp(service);
    expect(
      (await app.inject({ method: "GET", url: "/v1/goals/current?date=2026-08-16" })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/v1/goals/current?date=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBe('"1"');
    expect(response.json()).toEqual({ data: { goal } });
    expect(service.getCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ userId, localDate: "2026-08-16" }),
    );
  });

  it("creates from PAL selection only and binds the complete request to UUID idempotency", async () => {
    const service = goalStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: request,
    });
    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        goal: request,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(JSON.stringify(vi.mocked(service.create).mock.calls[0]?.[0])).not.toContain("heightCm");
  });

  it("rejects PAL values outside their reviewed category before persistence", async () => {
    const service = goalStub();
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { ...request, energy: { ...request.energy, activityFactor: "1.7" } },
    });
    expect(response.statusCode).toBe(422);
    expect(service.create).not.toHaveBeenCalled();
    expect(response.json().detail).toBe("The nutrition goal is invalid for this account.");
  });

  it("fails a derived goal closed for an unsupported persisted profile while preserving fixed mode", async () => {
    const service = goalStub({
      create: vi.fn(async () => {
        throw new GoalUnsupportedProfileServiceError();
      }),
    });
    const response = await createTestApp(service).inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: request,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain("A fixed wellness target remains available");
  });

  it("requires a strong revision ETag for a new immutable goal version", async () => {
    const service = goalStub();
    const app = createTestApp(service);
    const missing = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: revisionRequest,
    });
    expect(missing.statusCode).toBe(428);
    const response = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"1"' },
      payload: revisionRequest,
    });
    expect(response.statusCode).toBe(200);
    expect(service.revise).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId,
        expectedRevision: "1",
        clientOperationId: operationId,
        goal: revisionRequest,
      }),
    );
    const attemptsToMoveInterval = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"1"' },
      payload: request,
    });
    expect(attemptsToMoveInterval.statusCode).toBe(400);
  });

  it("returns partial nutrient progress as a lower bound and excludes energy from targetable rows", async () => {
    const service = goalStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/v1/goals/progress?date=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.nutrients[0]).toMatchObject({
      amountInterpretation: "lower_bound",
      target: { lowerBoundPercent: "80", percentIsExact: false },
      maximum: { state: "indeterminate" },
    });
    const targetableResponse = await app.inject({
      method: "GET",
      url: "/v1/nutrients/targetable",
      headers: authHeaders,
    });
    expect(targetableResponse.statusCode).toBe(200);
    expect(targetableResponse.json()).toEqual(targetable);
    expect(targetableResponse.headers["cache-control"]).toBe("no-store");
  });

  it("serializes an exact progress percentage above 160 characters without coercion", async () => {
    const knownAmount = "9".repeat(160);
    const targetAmount = "0.000001";
    const lowerBoundPercent = canonicalNonNegativeDecimal(
      decimal(knownAmount).mul(100).div(targetAmount),
    );
    const progressEnergy = progress.data.energy;
    if (!progressEnergy) throw new Error("Expected an energy progress fixture");
    const service = goalStub({
      progress: vi.fn(async () => ({
        ...progress,
        data: {
          ...progress.data,
          energy: {
            ...progressEnergy,
            knownAmount,
            target: { amount: targetAmount, lowerBoundPercent, percentIsExact: true },
          },
        },
      })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/goals/progress?date=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.energy.target.lowerBoundPercent).toBe(lowerBoundPercent);
    expect(lowerBoundPercent.length).toBeGreaterThan(160);
  });
});
