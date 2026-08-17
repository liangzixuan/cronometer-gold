import type {
  AuthenticatedAccount,
  DiaryDay,
  DiaryMutationResponse,
  DiaryNutrientAggregate,
  DiaryPublicFoodEntry,
  UserProfile,
} from "@nutrition-tracker/contracts";

export const userId = "70eedafb-9d6e-4adc-b924-8e55e87ff5d0";
export const entryId = "75d7fa63-4e26-42de-a1f8-0683ce268f62";
export const diaryId = "7f2a4824-872e-4616-9cd1-d63cf1beae51";
export const operationId = "61eec75e-fe16-47e4-9f7b-efb6914ad9dc";
export const bearerToken = "t".repeat(43);

export const profile: UserProfile = {
  displayName: "Ada",
  birthDate: null,
  sexAtBirth: "not_specified",
  heightCm: null,
  baselineWeightKg: null,
  activityLevelCode: null,
  locale: "en-US",
  timeZone: "America/Chicago",
  unitSystem: "metric",
  onboardingCompletedAt: null,
  revision: "1",
};

export const account: AuthenticatedAccount = {
  user: { id: userId, email: "ada@example.com", emailVerified: false },
  profile,
};

export const nutrient: DiaryNutrientAggregate = {
  nutrientId: "1008",
  code: "energy_kcal",
  name: "Energy",
  unit: "kcal",
  knownAmount: "95.25",
  completeness: "complete",
  isExact: true,
  contributorCount: 1,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 0,
  unknownReasonCounts: {
    not_reported: 0,
    not_analyzed: 0,
    not_applicable: 0,
    withheld: 0,
  },
};

export const diaryEntry: DiaryPublicFoodEntry = {
  entryKind: "food",
  id: entryId,
  revision: "3",
  foodVersionId: "202",
  recipeVersionId: null,
  portion: { kind: "serving", servingId: "303", amount: "1.5", servingLabel: "medium apple" },
  food: { name: "Apple", brandName: null },
  recipe: null,
  mealSlot: "breakfast",
  resolvedGrams: "150",
  occurredAt: "2026-08-15T13:30:00.000Z",
  localDate: "2026-08-15",
  localTime: "08:30:00.000",
  position: 0,
  source: {
    attributionRequired: true,
    attributionText: "Data source: USDA FoodData Central",
    code: "USDA_FDC",
    displayName: "USDA FoodData Central",
    licenseExpression: "CC0-1.0",
    releaseId: "9bc908d2-6362-4a9d-92af-f480c304381b",
  },
  foodProvenance: {
    kind: "public",
    source: {
      attributionRequired: true,
      attributionText: "Data source: USDA FoodData Central",
      code: "USDA_FDC",
      displayName: "USDA FoodData Central",
      licenseExpression: "CC0-1.0",
      releaseId: "9bc908d2-6362-4a9d-92af-f480c304381b",
    },
  },
  timeZone: "America/Chicago",
  nutrients: [nutrient],
};

export const diaryDay: DiaryDay = {
  id: diaryId,
  localDate: "2026-08-15",
  timeZone: "America/Chicago",
  status: "open",
  revision: "4",
  entries: [diaryEntry],
  totals: [nutrient],
  updatedAt: "2026-08-15T13:30:01.000Z",
};

export const mutationResponse: DiaryMutationResponse = {
  data: {
    replayed: false,
    entry: diaryEntry,
    affectedDays: [{ localDate: "2026-08-15", revision: "4" }],
  },
};
