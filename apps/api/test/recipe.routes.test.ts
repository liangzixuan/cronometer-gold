import type {
  DiaryRecipeEntry,
  Recipe,
  RecipeListResponse,
  RecipeMutationResponse,
} from "@nutrition-tracker/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AuthService } from "../src/modules/auth/auth-service.js";
import { assertDiaryEntry } from "../src/modules/diary/diary.routes.js";
import type { RecipeService } from "../src/modules/recipes/recipe.routes.js";
import { RecipeCursorServiceError } from "../src/modules/recipes/recipe.routes.js";
import {
  account,
  bearerToken,
  diaryEntry,
  mutationResponse,
  nutrient,
  operationId,
  userId,
} from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
const recipeId = "2a29e851-eab0-4af6-82f2-5ac633420c2b";
const recipeVersionId = "d696b6c8-782a-4783-b459-af4698470cf0";
const secondRecipeVersionId = "f2693690-3803-4a65-97f5-8e856f81f01e";
const repeatingResolvedGrams = `33.${"3".repeat(150)}`;
const source = diaryEntry.source;
const { foodProvenance: _foodProvenance, ...diaryEntryWithoutFoodProvenance } = diaryEntry;

const recipe: Recipe = {
  id: recipeId,
  status: "active",
  revision: "1",
  currentVersion: {
    id: recipeVersionId,
    versionNumber: 1,
    name: "Porridge",
    description: null,
    instructions: null,
    ingredients: [
      {
        kind: "food",
        position: 0,
        foodVersionId: "202",
        name: "Apple",
        brandName: null,
        portion: { kind: "grams", grams: "100" },
        resolvedGrams: "100",
        note: null,
        source,
        foodProvenance: { kind: "public", source },
      },
    ],
    finalYield: { grams: "100", source: "measured", ratioToInputMass: "1" },
    inputMassGrams: "100",
    servingCount: "1",
    servingLabel: "bowl",
    nutrition: { totals: [nutrient], per100Grams: [nutrient], perServing: [nutrient] },
    sources: [source],
    retentionPolicy: {
      code: "identity-retention-default",
      version: "1",
      assumption: "No cooking-retention dataset was applied; omitted factors remain exactly one.",
    },
    calculationVersion: "nutrition-engine-v1",
    warnings: [
      {
        code: "RETENTION_FACTORS_DEFAULTED",
        message: "No cooking-retention dataset was applied.",
        nutrientIds: ["1008"],
      },
    ],
    createdAt: "2026-08-16T00:00:00.000Z",
  },
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const recipeMutation: RecipeMutationResponse = { data: { replayed: false, recipe } };
const recipeList: RecipeListResponse = {
  data: [
    {
      id: recipe.id,
      status: recipe.status,
      revision: recipe.revision,
      currentVersion: {
        id: recipe.currentVersion.id,
        versionNumber: recipe.currentVersion.versionNumber,
        name: recipe.currentVersion.name,
        description: recipe.currentVersion.description,
        finalYield: {
          grams: recipe.currentVersion.finalYield.grams,
          source: recipe.currentVersion.finalYield.source,
        },
        inputMassGrams: recipe.currentVersion.inputMassGrams,
        servingCount: recipe.currentVersion.servingCount,
        servingLabel: recipe.currentVersion.servingLabel,
        warnings: recipe.currentVersion.warnings,
        createdAt: recipe.currentVersion.createdAt,
      },
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
    },
  ],
  page: { nextCursor: null },
};

const recipeDiaryEntry: DiaryRecipeEntry = {
  ...diaryEntryWithoutFoodProvenance,
  entryKind: "recipe",
  foodVersionId: null,
  recipeVersionId,
  portion: { kind: "serving", amount: "1", servingLabel: "bowl" },
  resolvedGrams: repeatingResolvedGrams,
  food: null,
  recipe: {
    id: recipeId,
    name: "Porridge",
    versionNumber: 1,
    yieldGrams: "100",
    yieldSource: "measured",
    servingCount: "3",
    servingLabel: "bowl",
    calculationVersion: "nutrition-engine-v1",
    retentionPolicy: recipe.currentVersion.retentionPolicy,
    warnings: recipe.currentVersion.warnings,
  },
  sources: [source],
  source: null,
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

function recipeStub(overrides: Partial<RecipeService> = {}): RecipeService {
  return {
    list: vi.fn(async () => recipeList),
    get: vi.fn(async () => recipe),
    create: vi.fn(async () => recipeMutation),
    revise: vi.fn(async () => recipeMutation),
    log: vi.fn(async () => ({
      data: { ...mutationResponse.data, entry: recipeDiaryEntry },
    })),
    ...overrides,
  };
}

function createTestApp(recipeService: RecipeService): ReturnType<typeof buildApp> {
  const app = buildApp({
    config: testConfig,
    logger: false,
    authService: authStub(),
    recipeService,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const authHeaders = { authorization: `Bearer ${bearerToken}` };
const draft = {
  name: "Porridge",
  description: null,
  instructions: null,
  ingredients: [
    {
      kind: "food" as const,
      foodVersionId: "202",
      portion: { kind: "grams" as const, grams: "100" },
    },
  ],
  finalYield: { grams: "100", source: "measured" as const },
  servingCount: "1",
  servingLabel: "bowl",
};

describe("recipe routes", () => {
  it("requires authentication and lists private recipe summaries without caching", async () => {
    const service = recipeStub();
    const app = createTestApp(service);
    expect((await app.inject({ method: "GET", url: "/v1/recipes" })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: "/v1/recipes?limit=20",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(recipeList);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ userId, limit: 20 }));
  });

  it("maps a malformed opaque cursor to a safe 400", async () => {
    const service = recipeStub({
      list: vi.fn(async () => {
        throw new RecipeCursorServiceError();
      }),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: "/v1/recipes?cursor=malformed",
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      detail: "One or more request fields are invalid.",
      issues: [{ path: "/cursor", code: "invalid" }],
    });
  });

  it("creates a recipe with UUID idempotency and rejects an unpaired serving label", async () => {
    const service = recipeStub();
    const app = createTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/recipes",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: draft,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        clientOperationId: operationId,
        recipe: draft,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/recipes",
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { ...draft, servingLabel: null },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("fails closed when scaled nutrition vectors do not preserve nutrient evidence", async () => {
    const service = recipeStub({
      get: vi.fn(async () => ({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: {
            ...recipe.currentVersion.nutrition,
            per100Grams: [{ ...nutrient, code: "different_nutrient" }],
          },
        },
      })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: `/v1/recipes/${recipeId}`,
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("nutrient vectors");
  });

  it("serializes exact scaled nutrition amounts above the persisted snapshot bound", async () => {
    const scaledAmount = "9".repeat(168);
    const service = recipeStub({
      get: vi.fn(async () => ({
        ...recipe,
        currentVersion: {
          ...recipe.currentVersion,
          nutrition: {
            totals: [nutrient],
            per100Grams: [{ ...nutrient, knownAmount: scaledAmount }],
            perServing: [{ ...nutrient, knownAmount: scaledAmount }],
          },
        },
      })),
    });
    const response = await createTestApp(service).inject({
      method: "GET",
      url: `/v1/recipes/${recipeId}`,
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.recipe.currentVersion.nutrition.per100Grams[0].knownAmount).toBe(
      scaledAmount,
    );
  });

  it("uses strong revision preconditions for immutable recipe revisions", async () => {
    const service = recipeStub();
    const app = createTestApp(service);
    const missing = await app.inject({
      method: "POST",
      url: `/v1/recipes/${recipeId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: draft,
    });
    expect(missing.statusCode).toBe(428);
    const response = await app.inject({
      method: "POST",
      url: `/v1/recipes/${recipeId}/revisions`,
      headers: { ...authHeaders, "idempotency-key": operationId, "if-match": '"1"' },
      payload: draft,
    });
    expect(response.statusCode).toBe(200);
    expect(service.revise).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId, expectedRevision: "1", clientOperationId: operationId }),
    );
  });

  it("pins the exact recipe version in a retry-safe diary log operation", async () => {
    const service = recipeStub();
    const app = createTestApp(service);
    expect(() => assertDiaryEntry(recipeDiaryEntry)).not.toThrow();
    const body = {
      recipeVersionId,
      portion: { kind: "serving", amount: "1" },
      mealSlot: "breakfast",
      occurredAt: "2026-08-16T12:00:00.000Z",
    };
    const first = await app.inject({
      method: "POST",
      url: `/v1/recipes/${recipeId}/log`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: body,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.entry).toEqual(recipeDiaryEntry);
    expect(first.json().data.entry.resolvedGrams).toBe(repeatingResolvedGrams);
    const firstDigest = vi.mocked(service.log).mock.calls[0]?.[0].requestDigest;
    await app.inject({
      method: "POST",
      url: `/v1/recipes/${recipeId}/log`,
      headers: { ...authHeaders, "idempotency-key": operationId },
      payload: { ...body, recipeVersionId: secondRecipeVersionId },
    });
    const secondDigest = vi.mocked(service.log).mock.calls[1]?.[0].requestDigest;
    expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(secondDigest).not.toBe(firstDigest);
    expect(service.log).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ recipeId, entry: body }),
    );
  });
});
