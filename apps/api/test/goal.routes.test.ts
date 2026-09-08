import type {
  NutritionGoal,
  NutritionGoalMutationResponse,
  NutritionGoalProgressResponse,
  ReferenceTargetSetListResponse,
  TargetableNutrientListResponse,
} from "@nutrition-tracker/contracts";
import { canonicalNonNegativeDecimal, decimal } from "@nutrition-tracker/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import {
  GoalPersistedIntegrityServiceError,
  GoalProfileRevisionConflictServiceError,
  GoalReferenceUnavailableServiceError,
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

const referenceBase: Omit<ReferenceTargetSetListResponse["data"], "availability" | "sets"> = {
  acknowledgementPolicy: {
    code: "us-ca-dri-adults-19-50-eligibility-ack",
    version: "1",
    text: "Eligibility acknowledgement.",
  },
  applied: null,
  cautions: [{ code: "clinical-exclusions", text: "Clinical exclusions apply." }],
  date: "2026-08-16",
  notice:
    "This optional template copies U.S.–Canada population reference values into your goals. It is for usual intake by apparently healthy adults in the selected group, not a diagnosis, prescription, or proof of adequacy. A single day above or below a reference does not determine nutrient status.",
  profileRevision: "0",
  sources: {
    code: "health-canada-dri-tables",
    version: "2025-11-19",
    reviewedOn: "2026-09-07",
    overviewUrl: "https://example.test/overview",
    macronutrientsUrl: "https://example.test/macros",
    elementsUrl: "https://example.test/elements",
    vitaminsUrl: "https://example.test/vitamins",
    reportListUrl: "https://example.test/reports",
  },
};

const unavailableReferenceTargets: ReferenceTargetSetListResponse = {
  data: {
    ...referenceBase,
    availability: { available: false, reasonCodes: ["profile_missing_birth_date"] },
    sets: [],
  },
};

const persistedReferenceSet: ReferenceTargetSetListResponse["data"]["sets"][number] = {
  eligibleThroughExclusive: "2041-01-01",
  groupCode: "male-19-50",
  policyDigest: "a".repeat(64),
  targets: Array.from({ length: 12 }, (_, index) => ({
    basis: {
      maximumReferenceType: null,
      referenceType: "rda",
      sourceRows: ["Males 19–30 y", "Males 31–50 y"],
      timeBasis: "usual-average-daily-intake",
    },
    definition: {
      category: "other",
      code: `reference-${index + 1}`,
      id: String(index + 1),
      name: `Reference nutrient ${index + 1}`,
      unit: "mg",
    },
    maximumAmount: null,
    minimumAmount: null,
    rationale: "Source-verified population reference.",
    source: {
      label: "Health Canada Dietary Reference Intakes",
      table: "Table 1",
      url: "https://example.test/reference",
      version: "HC-2025-11-19/IOM-2005",
    },
    targetAmount: "1",
  })),
  templateCode: "us-ca-dri-adults-19-50",
  templateVersion: "1",
  title: "Source-verified adult reference candidate",
};

const appliedReferenceTargets: ReferenceTargetSetListResponse = {
  data: {
    ...referenceBase,
    applied: {
      acknowledgement: {
        accepted: true,
        acceptedAt: "2026-08-16T12:34:56.789Z",
        policyCode: "us-ca-dri-adults-19-50-eligibility-ack",
        policyVersion: "1",
      },
      appliedProfileRevision: "0",
      eligibleThroughExclusive: persistedReferenceSet.eligibleThroughExclusive,
      goalId,
      goalRevision: "2",
      goalVersionId,
      groupCode: persistedReferenceSet.groupCode,
      policyDigest: persistedReferenceSet.policyDigest,
      set: persistedReferenceSet,
      templateCode: persistedReferenceSet.templateCode,
      templateVersion: persistedReferenceSet.templateVersion,
    },
    availability: { available: true, reasonCodes: [] },
    sets: [persistedReferenceSet],
  },
};

const referenceRequest = {
  effectiveFrom: "2026-08-16",
  energy: { mode: "fixed" as const, targetKcal: "2000", rationale: "User-entered target." },
  nutrientTargets: [],
  expectedOwnerUserId: userId,
  expectedProfileRevision: "0",
  referenceTargetSet: {
    templateCode: "us-ca-dri-adults-19-50" as const,
    templateVersion: "1" as const,
    groupCode: "male-19-50" as const,
    eligibilityAcknowledgement: {
      policyCode: "us-ca-dri-adults-19-50-eligibility-ack" as const,
      policyVersion: "1" as const,
      accepted: true as const,
    },
  },
};

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
    listReferenceTargetSets: vi.fn(async () => {
      throw new Error("Reference target catalogue not stubbed");
    }),
    ...overrides,
  };
}

function createTestApp(
  goalService: GoalService,
  referenceTargetsEnabled = false,
): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    goalService,
    referenceTargetsEnabled,
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
const referenceRevisionRequest = {
  energy: referenceRequest.energy,
  nutrientTargets: referenceRequest.nutrientTargets,
  expectedOwnerUserId: referenceRequest.expectedOwnerUserId,
  expectedProfileRevision: referenceRequest.expectedProfileRevision,
  referenceTargetSet: referenceRequest.referenceTargetSet,
};

describe("nutrition goal routes", () => {
  it("keeps reference discovery and writes fail-closed by default", async () => {
    const service = goalStub({
      listReferenceTargetSets: vi.fn(async () => unavailableReferenceTargets),
    });
    const app = createTestApp(service);

    const discovery = await app.inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(discovery.statusCode).toBe(404);
    expect(discovery.json().code).toBe("NOT_FOUND");

    const create = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: referenceRequest,
    });
    expect(create.statusCode).toBe(503);
    expect(create.json().code).toBe("SERVICE_NOT_READY");

    const revise = await app.inject({
      method: "POST",
      url: `/v1/goals/${goalId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"1"' },
      payload: referenceRevisionRequest,
    });
    expect(revise.statusCode).toBe(503);
    expect(revise.json().code).toBe("SERVICE_NOT_READY");
    expect(service.listReferenceTargetSets).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(service.revise).not.toHaveBeenCalled();
  });

  it("lists authenticated revision-zero reference availability when explicitly enabled", async () => {
    const service = goalStub({
      listReferenceTargetSets: vi.fn(async () => unavailableReferenceTargets),
    });
    const app = createTestApp(service, true);
    expect(
      (await app.inject({ method: "GET", url: "/v1/goals/reference-target-sets?date=2026-08-16" }))
        .statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(unavailableReferenceTargets);
    expect(service.listReferenceTargetSets).toHaveBeenCalledWith(
      expect.objectContaining({ localDate: "2026-08-16", userId }),
    );
  });

  it("fails malformed catalogue states and unavailable registry reads closed", async () => {
    const inconsistent = goalStub({
      listReferenceTargetSets: vi.fn(async () => ({
        data: {
          ...unavailableReferenceTargets.data,
          availability: { available: true, reasonCodes: [] },
        },
      })),
    });
    const malformed = await createTestApp(inconsistent, true).inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(malformed.statusCode).toBe(503);

    const unavailable = goalStub({
      listReferenceTargetSets: vi.fn(async () => {
        throw new GoalReferenceUnavailableServiceError();
      }),
    });
    const unavailableResponse = await createTestApp(unavailable, true).inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json().code).toBe("SERVICE_NOT_READY");

    const corrupted = goalStub({
      listReferenceTargetSets: vi.fn(async () => {
        throw new GoalPersistedIntegrityServiceError();
      }),
    });
    const corruptedResponse = await createTestApp(corrupted, true).inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(corruptedResponse.statusCode).toBe(503);
    expect(corruptedResponse.json().code).toBe("SERVICE_NOT_READY");
  });

  it("returns the verified persisted applied snapshot and rejects identity divergence", async () => {
    const persistedApplied = appliedReferenceTargets.data.applied;
    if (!persistedApplied) throw new Error("Expected persisted applied reference fixture");
    const service = goalStub({
      listReferenceTargetSets: vi.fn(async () => appliedReferenceTargets),
    });
    const response = await createTestApp(service, true).inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.applied).toEqual(appliedReferenceTargets.data.applied);
    expect(response.json().data.applied.set.targets).toHaveLength(12);

    const divergent = goalStub({
      listReferenceTargetSets: vi.fn(async () => ({
        ...appliedReferenceTargets,
        data: {
          ...appliedReferenceTargets.data,
          applied: {
            ...persistedApplied,
            policyDigest: "b".repeat(64),
          },
        },
      })),
    });
    const rejected = await createTestApp(divergent, true).inject({
      method: "GET",
      url: "/v1/goals/reference-target-sets?date=2026-08-16",
      headers: authHeaders,
    });
    expect(rejected.statusCode).toBe(503);
  });

  it("binds reference selection, profile revision, acknowledgement, and owner into exact retries", async () => {
    const service = goalStub();
    const app = createTestApp(service, true);
    const first = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: referenceRequest,
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: referenceRequest,
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    const calls = vi.mocked(service.create).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].requestDigest).toBe(calls[1]?.[0].requestDigest);
    expect(calls[0]?.[0].goal).toEqual(referenceRequest);

    const switchedOwner = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: {
        ...referenceRequest,
        expectedOwnerUserId: "30000000-0000-4000-8000-000000000099",
      },
    });
    expect(switchedOwner.statusCode).toBe(409);
    expect(switchedOwner.json().code).toBe("GOAL_OWNER_CHANGED");
    expect(service.create).toHaveBeenCalledTimes(2);
  });

  it("maps stale profile reference writes and rejects client-owned reference amounts", async () => {
    const service = goalStub({
      create: vi.fn(async () => {
        throw new GoalProfileRevisionConflictServiceError();
      }),
    });
    const app = createTestApp(service, true);
    const stale = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: referenceRequest,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("GOAL_PROFILE_CHANGED");
    const amounts = await app.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { ...referenceRequest, nutrientTargets: request.nutrientTargets },
    });
    expect(amounts.statusCode).toBe(400);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

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
