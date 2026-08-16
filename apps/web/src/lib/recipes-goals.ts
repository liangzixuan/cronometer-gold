import {
  type DiaryNutrient,
  isLocalDate,
  isSupportedTimeZone,
  localDateInTimeZone,
  localDateTimeToInstant,
  type MealSlot,
  parseDiaryNutrient,
  quickAddOccurredAt,
} from "./diary";

export type Coverage = "complete" | "partial" | "unknown";

export interface SourceProvenance {
  readonly displayName: string;
  readonly licenseExpression: string;
  readonly attributionText: string;
}

export type RecipeNutrient = DiaryNutrient;

export interface RecipeIngredientView {
  readonly position: number;
  readonly kind: "food" | "recipe";
  readonly foodVersionId: string | null;
  readonly recipeId: string | null;
  readonly recipeVersionId: string | null;
  readonly name: string;
  readonly brandName: string | null;
  readonly portion:
    | {
        readonly kind: "serving";
        readonly servingId: string;
        readonly amount: string;
        readonly servingLabel: string;
      }
    | { readonly kind: "grams"; readonly grams: string };
  readonly quantityText: string;
  readonly resolvedGrams: string;
  readonly source: SourceProvenance | null;
  readonly note: string | null;
  readonly coverage: Coverage;
}

export interface RecipeView {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly revision: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly finalYieldGrams: string;
  readonly yieldSource: "measured" | "estimated";
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly inputMassGrams: string;
  readonly ingredients: readonly RecipeIngredientView[];
  /** Deterministic de-duplicated transitive provenance, including nested recipes. */
  readonly sources: readonly (SourceProvenance & {
    readonly code: string;
    readonly releaseId: string;
    readonly attributionRequired: boolean;
  })[];
  readonly nutrientsPer100Grams: readonly RecipeNutrient[];
  readonly nutrientsPerServing: readonly RecipeNutrient[] | null;
  readonly warnings: readonly {
    readonly code: string;
    readonly message: string;
    readonly nutrientIds: readonly string[];
  }[];
  readonly retentionPolicy: {
    readonly code: "identity-retention-default";
    readonly version: "1";
    readonly assumption: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeSummaryView {
  readonly id: string;
  readonly status: "active" | "archived";
  readonly revision: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly name: string;
  readonly finalYieldGrams: string;
  readonly yieldSource: "measured" | "estimated";
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
  readonly warningCount: number;
  readonly updatedAt: string;
}

export function mergeRecipePage(
  current: readonly RecipeSummaryView[],
  incoming: readonly RecipeSummaryView[],
  append: boolean,
): readonly RecipeSummaryView[] {
  if (!append) return incoming;
  const byId = new Map(current.map((recipe) => [recipe.id, recipe]));
  for (const recipe of incoming) byId.set(recipe.id, recipe);
  return [...byId.values()];
}

export function goalWriteBody<TEnergy, TTarget>(
  goalId: string | null,
  effectiveFrom: string,
  energy: TEnergy,
  nutrientTargets: readonly TTarget[],
) {
  return goalId === null ? { effectiveFrom, energy, nutrientTargets } : { energy, nutrientTargets };
}

export function recipeLogKindFor(recipe: Pick<RecipeView, "servingCount">): "serving" | "grams" {
  return recipe.servingCount === null ? "grams" : "serving";
}

export type RecipeIngredientDraft =
  | {
      readonly kind: "food";
      readonly clientKey: string;
      readonly foodVersionId: string;
      readonly name: string;
      readonly brandName: string | null;
      readonly portion:
        | {
            readonly kind: "serving";
            readonly servingId: string;
            readonly servingLabel: string;
            readonly amount: string;
          }
        | { readonly kind: "grams"; readonly grams: string };
      readonly source: SourceProvenance;
      readonly note: string | null;
    }
  | {
      readonly kind: "recipe";
      readonly clientKey: string;
      readonly recipeId: string;
      readonly recipeVersionId: string;
      readonly name: string;
      readonly grams: string;
      readonly note: string | null;
    };

export interface TargetableNutrient {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly category: string;
}

export interface GoalTargetView extends TargetableNutrient {
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly targetSource: string;
  readonly targetSourceVersion: string | null;
  readonly rationale: string | null;
}

export interface GoalView {
  readonly id: string;
  readonly status: "active" | "archived" | "draft";
  readonly revision: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly energy:
    | {
        readonly mode: "fixed";
        readonly targetKcal: string;
        readonly rationale: string;
      }
    | {
        readonly mode: "derived";
        readonly targetKcal: string;
        readonly bmrKcal: string;
        readonly ageYears: number;
        readonly profileRevision: string;
        readonly heightCm: string;
        readonly weightKg: string;
        readonly sexAtBirth: "female" | "male";
        readonly activityLevelCode: string;
        readonly activityFactor: string;
        readonly adjustmentKcal: string;
        readonly rationale: string;
        readonly equationLabel: string;
        readonly sourceUrl: string;
        readonly activitySourceUrl: string;
      };
  readonly targets: readonly GoalTargetView[];
  readonly notice: "General wellness estimate; not medical advice.";
}

export interface GoalProgressRowView {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: Coverage;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly minimum: { readonly amount: string; readonly state: string } | null;
  readonly target: {
    readonly amount: string;
    readonly lowerBoundPercent: string | null;
    readonly percentIsExact: boolean;
  } | null;
  readonly maximum: { readonly amount: string; readonly state: string } | null;
}

export interface GoalProgressView {
  readonly localDate: string;
  readonly timeZone: string;
  readonly diaryRevision: string;
  readonly goal: {
    readonly id: string;
    readonly versionId: string;
    readonly revision: string;
  } | null;
  readonly energy: GoalProgressRowView | null;
  readonly nutrients: readonly GoalProgressRowView[];
  readonly notice: "General wellness estimate; not medical advice.";
}

export interface StableMutation<TBody> {
  readonly intentKey: string;
  readonly operationId: string;
  readonly body: TBody;
}

export interface RecipeLogBody {
  readonly recipeVersionId: string;
  readonly portion:
    | { readonly kind: "serving"; readonly amount: string }
    | { readonly kind: "grams"; readonly grams: string };
  readonly mealSlot: MealSlot;
  readonly occurredAt: string;
}

export interface NutrientProgressInput {
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly completeness: Coverage;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly lowerBoundPercent: string | null;
  readonly percentIsExact: boolean;
}

export interface NutrientProgressPresentation {
  readonly valueText: string;
  readonly targetText: string;
  readonly coverageText: string;
  readonly accessibilityLabel: string;
  readonly progressPercent: number | null;
}

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const POSITIVE_EXACT_DECIMAL = /^(?=.*[1-9])(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/u;
const RECIPE_WARNING_CODES = new Set([
  "ESTIMATED_YIELD",
  "PARTIAL_NUTRIENT_DATA",
  "RETENTION_FACTORS_DEFAULTED",
  "YIELD_ABOVE_INPUT_MASS",
  "YIELD_BELOW_HALF_INPUT_MASS",
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => expected.has(key) && key in value)
  );
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || boundedText(value, 1, maximum);
}

function exactDecimal(value: unknown, positive = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= 160 &&
    (positive
      ? POSITIVE_EXACT_DECIMAL.test(value)
      : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value))
  );
}

function positiveResolvedDecimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 160 &&
    /^(?=.*[1-9])(?:0|[1-9][0-9]{0,17})(?:\.[0-9]+)?$/u.test(value)
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedText(value, 20, 64) &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function recipeWarning(value: unknown): value is RecipeView["warnings"][number] {
  return (
    object(value) &&
    exactKeys(value, ["code", "message", "nutrientIds"]) &&
    typeof value.code === "string" &&
    RECIPE_WARNING_CODES.has(value.code) &&
    boundedText(value.message, 1, 500) &&
    Array.isArray(value.nutrientIds) &&
    value.nutrientIds.length <= 256 &&
    value.nutrientIds.every((id) => typeof id === "string" && POSITIVE_ID.test(id))
  );
}

function source(value: unknown): RecipeView["sources"][number] {
  if (
    !object(value) ||
    !exactKeys(value, [
      "code",
      "releaseId",
      "displayName",
      "licenseExpression",
      "attributionRequired",
      "attributionText",
    ]) ||
    !(typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/u.test(value.code)) ||
    !UUID.test(String(value.releaseId)) ||
    !boundedText(value.displayName, 1, 200) ||
    !boundedText(value.licenseExpression, 1, 256) ||
    typeof value.attributionRequired !== "boolean" ||
    !boundedText(value.attributionText, 1, 2_000)
  ) {
    throw new TypeError("Recipe source provenance was invalid.");
  }
  return value as unknown as RecipeView["sources"][number];
}

function servingPortion(value: unknown): RecipeIngredientView["portion"] {
  if (!object(value) || typeof value.kind !== "string") {
    throw new TypeError("Recipe ingredient portion was invalid.");
  }
  if (
    value.kind === "grams" &&
    exactKeys(value, ["kind", "grams"]) &&
    typeof value.grams === "string" &&
    isRecipePositiveDecimal(value.grams)
  ) {
    return { kind: "grams", grams: value.grams };
  }
  if (
    value.kind === "serving" &&
    exactKeys(value, ["kind", "servingId", "amount", "servingLabel"]) &&
    typeof value.servingId === "string" &&
    POSITIVE_ID.test(value.servingId) &&
    typeof value.amount === "string" &&
    isRecipePositiveDecimal(value.amount) &&
    boundedText(value.servingLabel, 1, 300)
  ) {
    return {
      kind: "serving",
      servingId: value.servingId,
      amount: value.amount,
      servingLabel: value.servingLabel,
    };
  }
  throw new TypeError("Recipe ingredient portion was invalid.");
}

function ingredient(value: unknown, coverage: Coverage): RecipeIngredientView {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.position) ||
    Number(value.position) < 0 ||
    Number(value.position) > 49
  ) {
    throw new TypeError("Recipe ingredient position was invalid.");
  }
  if (value.kind === "food") {
    if (
      !exactKeys(value, [
        "kind",
        "position",
        "foodVersionId",
        "name",
        "brandName",
        "portion",
        "resolvedGrams",
        "note",
        "source",
      ]) ||
      typeof value.foodVersionId !== "string" ||
      !POSITIVE_ID.test(value.foodVersionId) ||
      !boundedText(value.name, 1, 500) ||
      !nullableText(value.brandName, 300) ||
      !positiveResolvedDecimal(value.resolvedGrams) ||
      !nullableText(value.note, 500)
    ) {
      throw new TypeError("A resolved food ingredient was invalid.");
    }
    const portion = servingPortion(value.portion);
    const provenance = source(value.source);
    return {
      position: Number(value.position),
      kind: "food",
      foodVersionId: value.foodVersionId,
      recipeId: null,
      recipeVersionId: null,
      name: value.name,
      brandName: value.brandName,
      portion,
      quantityText: portion.kind === "serving" ? portion.amount : portion.grams,
      resolvedGrams: value.resolvedGrams,
      source: provenance,
      note: value.note,
      coverage,
    };
  }
  if (
    value.kind === "recipe" &&
    exactKeys(value, [
      "kind",
      "position",
      "recipeId",
      "recipeVersionId",
      "versionNumber",
      "name",
      "grams",
      "resolvedGrams",
      "note",
    ]) &&
    typeof value.recipeId === "string" &&
    UUID.test(value.recipeId) &&
    typeof value.recipeVersionId === "string" &&
    UUID.test(value.recipeVersionId) &&
    Number.isSafeInteger(value.versionNumber) &&
    Number(value.versionNumber) > 0 &&
    boundedText(value.name, 1, 200) &&
    exactDecimal(value.grams, true) &&
    positiveResolvedDecimal(value.resolvedGrams) &&
    nullableText(value.note, 500)
  ) {
    return {
      position: Number(value.position),
      kind: "recipe",
      foodVersionId: null,
      recipeId: value.recipeId,
      recipeVersionId: value.recipeVersionId,
      name: value.name,
      brandName: null,
      portion: { kind: "grams", grams: value.grams },
      quantityText: value.grams,
      resolvedGrams: value.resolvedGrams,
      source: null,
      note: value.note,
      coverage,
    };
  }
  throw new TypeError("A resolved nested recipe ingredient was invalid.");
}

function nutrientVector(value: unknown): readonly RecipeNutrient[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError("Recipe nutrient vector was invalid.");
  }
  const nutrients = value.map(parseDiaryNutrient);
  if (new Set(nutrients.map((row) => row.nutrientId)).size !== nutrients.length) {
    throw new TypeError("Recipe nutrient vector contained duplicates.");
  }
  return nutrients;
}

function sameNutrientIdentity(
  left: readonly RecipeNutrient[],
  right: readonly RecipeNutrient[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const candidate = right[index];
      return candidate?.nutrientId === row.nutrientId && candidate.unit === row.unit;
    })
  );
}

function parseRecipe(value: unknown): RecipeView {
  if (
    !object(value) ||
    !exactKeys(value, ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !["active", "archived"].includes(String(value.status)) ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.revision) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !object(value.currentVersion)
  ) {
    throw new TypeError("Recipe response was invalid.");
  }
  const version = value.currentVersion;
  if (
    !exactKeys(version, [
      "id",
      "versionNumber",
      "name",
      "description",
      "instructions",
      "ingredients",
      "finalYield",
      "inputMassGrams",
      "servingCount",
      "servingLabel",
      "nutrition",
      "sources",
      "retentionPolicy",
      "calculationVersion",
      "warnings",
      "createdAt",
    ]) ||
    typeof version.id !== "string" ||
    !UUID.test(version.id) ||
    !Number.isSafeInteger(version.versionNumber) ||
    Number(version.versionNumber) < 1 ||
    !boundedText(version.name, 1, 200) ||
    !nullableText(version.description, 2_000) ||
    !nullableText(version.instructions, 10_000) ||
    !Array.isArray(version.ingredients) ||
    version.ingredients.length < 1 ||
    version.ingredients.length > 50 ||
    !object(version.finalYield) ||
    !exactKeys(version.finalYield, ["grams", "source", "ratioToInputMass"]) ||
    !positiveResolvedDecimal(version.finalYield.grams) ||
    !["measured", "estimated"].includes(String(version.finalYield.source)) ||
    !exactDecimal(version.finalYield.ratioToInputMass, true) ||
    !positiveResolvedDecimal(version.inputMassGrams) ||
    !(version.servingCount === null || exactDecimal(version.servingCount, true)) ||
    !nullableText(version.servingLabel, 100) ||
    (version.servingCount === null) !== (version.servingLabel === null) ||
    !object(version.nutrition) ||
    !exactKeys(version.nutrition, ["totals", "per100Grams", "perServing"]) ||
    !Array.isArray(version.sources) ||
    version.sources.length < 1 ||
    version.sources.length > 256 ||
    !object(version.retentionPolicy) ||
    !exactKeys(version.retentionPolicy, ["code", "version", "assumption"]) ||
    version.retentionPolicy.code !== "identity-retention-default" ||
    version.retentionPolicy.version !== "1" ||
    !boundedText(version.retentionPolicy.assumption, 1, 500) ||
    !boundedText(version.calculationVersion, 1, 100) ||
    !Array.isArray(version.warnings) ||
    version.warnings.length > 5 ||
    !version.warnings.every(recipeWarning) ||
    !timestamp(version.createdAt)
  ) {
    throw new TypeError("Recipe version response was invalid.");
  }
  const totals = nutrientVector(version.nutrition.totals);
  const per100 = nutrientVector(version.nutrition.per100Grams);
  const perServing =
    version.nutrition.perServing === null ? null : nutrientVector(version.nutrition.perServing);
  if (
    !sameNutrientIdentity(totals, per100) ||
    (perServing !== null && !sameNutrientIdentity(totals, perServing)) ||
    (version.servingCount === null) !== (perServing === null)
  ) {
    throw new TypeError("Recipe nutrient vectors were inconsistent.");
  }
  const warnings = version.warnings as unknown as RecipeView["warnings"];
  const coverage: Coverage = warnings.some((warning) => warning.code === "PARTIAL_NUTRIENT_DATA")
    ? "partial"
    : "complete";
  const ingredients = version.ingredients.map((row) => ingredient(row, coverage));
  if (new Set(ingredients.map((row) => row.position)).size !== ingredients.length) {
    throw new TypeError("Recipe ingredient positions were duplicated.");
  }
  const sources = version.sources.map(source);
  if (new Set(sources.map((row) => `${row.code}\u0000${row.releaseId}`)).size !== sources.length) {
    throw new TypeError("Recipe sources were duplicated.");
  }
  return {
    id: value.id,
    status: value.status as RecipeView["status"],
    revision: value.revision,
    versionId: version.id,
    versionNumber: Number(version.versionNumber),
    name: version.name,
    description: version.description,
    instructions: version.instructions,
    finalYieldGrams: version.finalYield.grams,
    yieldSource: version.finalYield.source as RecipeView["yieldSource"],
    servingCount: version.servingCount,
    servingLabel: version.servingLabel,
    inputMassGrams: version.inputMassGrams,
    ingredients,
    sources,
    nutrientsPer100Grams: per100,
    nutrientsPerServing: perServing,
    warnings,
    retentionPolicy: version.retentionPolicy as RecipeView["retentionPolicy"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseRecipeSummary(value: unknown): RecipeSummaryView {
  if (
    !object(value) ||
    !exactKeys(value, ["id", "status", "revision", "currentVersion", "createdAt", "updatedAt"]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !["active", "archived"].includes(String(value.status)) ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.revision) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !object(value.currentVersion)
  ) {
    throw new TypeError("Recipe summary was invalid.");
  }
  const version = value.currentVersion;
  if (
    !exactKeys(version, [
      "id",
      "versionNumber",
      "name",
      "description",
      "finalYield",
      "inputMassGrams",
      "servingCount",
      "servingLabel",
      "warnings",
      "createdAt",
    ]) ||
    typeof version.id !== "string" ||
    !UUID.test(version.id) ||
    !Number.isSafeInteger(version.versionNumber) ||
    Number(version.versionNumber) < 1 ||
    !boundedText(version.name, 1, 200) ||
    !nullableText(version.description, 2_000) ||
    !object(version.finalYield) ||
    !exactKeys(version.finalYield, ["grams", "source"]) ||
    !positiveResolvedDecimal(version.finalYield.grams) ||
    !["measured", "estimated"].includes(String(version.finalYield.source)) ||
    !positiveResolvedDecimal(version.inputMassGrams) ||
    !(version.servingCount === null || exactDecimal(version.servingCount, true)) ||
    !nullableText(version.servingLabel, 100) ||
    (version.servingCount === null) !== (version.servingLabel === null) ||
    !Array.isArray(version.warnings) ||
    version.warnings.length > 5 ||
    !version.warnings.every(recipeWarning) ||
    !timestamp(version.createdAt)
  ) {
    throw new TypeError("Recipe summary version was invalid.");
  }
  return {
    id: value.id,
    status: value.status as RecipeSummaryView["status"],
    revision: value.revision,
    versionId: version.id,
    versionNumber: Number(version.versionNumber),
    name: version.name,
    finalYieldGrams: version.finalYield.grams,
    yieldSource: version.finalYield.source as RecipeSummaryView["yieldSource"],
    servingCount: version.servingCount,
    servingLabel: version.servingLabel,
    warningCount: version.warnings.length,
    updatedAt: value.updatedAt,
  };
}

export function parseRecipeCollection(value: unknown): {
  readonly data: readonly RecipeSummaryView[];
  readonly nextCursor: string | null;
} {
  if (
    !object(value) ||
    !exactKeys(value, ["data", "page"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 50 ||
    !object(value.page) ||
    !exactKeys(value.page, ["nextCursor"]) ||
    !(value.page.nextCursor === null || boundedText(value.page.nextCursor, 1, 512))
  ) {
    throw new TypeError("Recipe list response was invalid.");
  }
  const data = value.data.map(parseRecipeSummary);
  if (new Set(data.map((row) => row.id)).size !== data.length) {
    throw new TypeError("Recipe list contained duplicates.");
  }
  return { data, nextCursor: value.page.nextCursor };
}

export function parseRecipeResponse(value: unknown): RecipeView {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !object(value.data) ||
    !exactKeys(value.data, ["recipe"])
  ) {
    throw new TypeError("Recipe detail response was invalid.");
  }
  return parseRecipe(value.data.recipe);
}

export function parseRecipeMutation(value: unknown): {
  readonly replayed: boolean;
  readonly recipe: RecipeView;
} {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !object(value.data) ||
    !exactKeys(value.data, ["replayed", "recipe"]) ||
    typeof value.data.replayed !== "boolean"
  ) {
    throw new TypeError("Recipe mutation response was invalid.");
  }
  return { replayed: value.data.replayed, recipe: parseRecipe(value.data.recipe) };
}

const GOAL_NOTICE = "General wellness estimate; not medical advice." as const;
const GOAL_STATUSES = new Set(["active", "archived", "draft"]);
const NUTRIENT_CATEGORIES = new Set([
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);
const THRESHOLD_STATES = new Set(["met", "below", "within", "exceeded", "indeterminate"]);
const PAL_RANGES = {
  sedentary_or_light: ["1.4", "1.69"],
  active_or_moderate: ["1.7", "1.99"],
  vigorous: ["2", "2.4"],
} as const;

function compareNonNegative(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  if (leftInteger.length !== rightInteger.length)
    return leftInteger.length < rightInteger.length ? -1 : 1;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, "0");
  const normalizedRight = rightFraction.padEnd(width, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

function targetable(value: unknown): TargetableNutrient {
  if (
    !object(value) ||
    !exactKeys(value, ["id", "code", "name", "unit", "category"]) ||
    typeof value.id !== "string" ||
    !POSITIVE_ID.test(value.id) ||
    !boundedText(value.code, 1, 64) ||
    !boundedText(value.name, 1, 200) ||
    !boundedText(value.unit, 1, 32) ||
    typeof value.category !== "string" ||
    !NUTRIENT_CATEGORIES.has(value.category)
  ) {
    throw new TypeError("Targetable nutrient definition was invalid.");
  }
  return {
    nutrientId: value.id,
    code: value.code,
    name: value.name,
    unit: value.unit,
    category: value.category,
  };
}

function safeSourceUrl(value: unknown): value is string {
  if (!boundedText(value, 1, 500)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function energySnapshot(value: unknown): GoalView["energy"] {
  if (!object(value) || value.mode === "fixed") {
    if (
      !object(value) ||
      !exactKeys(value, ["mode", "targetKcal", "source", "rationale"]) ||
      value.mode !== "fixed" ||
      !exactDecimal(value.targetKcal, true) ||
      !object(value.source) ||
      !exactKeys(value.source, ["code", "version"]) ||
      value.source.code !== "user-fixed" ||
      value.source.version !== "1" ||
      !boundedText(value.rationale, 1, 1_000)
    ) {
      throw new TypeError("Fixed energy goal snapshot was invalid.");
    }
    return { mode: "fixed", targetKcal: value.targetKcal, rationale: value.rationale };
  }
  if (
    !exactKeys(value, [
      "mode",
      "targetKcal",
      "bmrKcal",
      "profileRevision",
      "ageYears",
      "heightCm",
      "weightKg",
      "sexAtBirth",
      "activityLevelCode",
      "activityFactor",
      "adjustmentKcal",
      "source",
      "rationale",
    ]) ||
    value.mode !== "derived" ||
    !exactDecimal(value.targetKcal, true) ||
    !exactDecimal(value.bmrKcal, true) ||
    typeof value.profileRevision !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.profileRevision) ||
    !Number.isSafeInteger(value.ageYears) ||
    Number(value.ageYears) < 19 ||
    Number(value.ageYears) > 78 ||
    !exactDecimal(value.heightCm, true) ||
    !exactDecimal(value.weightKg, true) ||
    !["female", "male"].includes(String(value.sexAtBirth)) ||
    typeof value.activityLevelCode !== "string" ||
    !(value.activityLevelCode in PAL_RANGES) ||
    !exactDecimal(value.activityFactor, true) ||
    !exactDecimal(value.adjustmentKcal) ||
    !object(value.source) ||
    !exactKeys(value.source, ["equation", "activityPolicy"]) ||
    !object(value.source.equation) ||
    !exactKeys(value.source.equation, ["code", "version", "url"]) ||
    value.source.equation.code !== "mifflin-st-jeor-ree" ||
    value.source.equation.version !== "1990-original" ||
    !safeSourceUrl(value.source.equation.url) ||
    !object(value.source.activityPolicy) ||
    !exactKeys(value.source.activityPolicy, ["code", "version", "sourceUrl"]) ||
    value.source.activityPolicy.code !== "fao-who-unu-pal-policy" ||
    value.source.activityPolicy.version !== "2004-reviewed-v1" ||
    !safeSourceUrl(value.source.activityPolicy.sourceUrl) ||
    !boundedText(value.rationale, 1, 1_000)
  ) {
    throw new TypeError("Derived energy goal snapshot was invalid.");
  }
  const range = PAL_RANGES[value.activityLevelCode as keyof typeof PAL_RANGES];
  if (
    compareNonNegative(value.activityFactor, range[0]) < 0 ||
    compareNonNegative(value.activityFactor, range[1]) > 0
  ) {
    throw new TypeError("Derived energy activity factor was outside its reviewed range.");
  }
  return {
    mode: "derived",
    targetKcal: value.targetKcal,
    bmrKcal: value.bmrKcal,
    profileRevision: value.profileRevision,
    ageYears: Number(value.ageYears),
    heightCm: value.heightCm,
    weightKg: value.weightKg,
    sexAtBirth: value.sexAtBirth as "female" | "male",
    activityLevelCode: value.activityLevelCode,
    activityFactor: value.activityFactor,
    adjustmentKcal: String(value.adjustmentKcal),
    rationale: value.rationale,
    equationLabel: "Mifflin–St Jeor (1990 original)",
    sourceUrl: value.source.equation.url,
    activitySourceUrl: value.source.activityPolicy.sourceUrl,
  };
}

function goalTarget(value: unknown): GoalTargetView {
  if (
    !object(value) ||
    !exactKeys(value, [
      "definition",
      "minimumAmount",
      "targetAmount",
      "maximumAmount",
      "source",
      "rationale",
    ]) ||
    !(
      value.minimumAmount === null ||
      (typeof value.minimumAmount === "string" && isGoalDecimal(value.minimumAmount))
    ) ||
    !(
      value.targetAmount === null ||
      (typeof value.targetAmount === "string" && isGoalDecimal(value.targetAmount))
    ) ||
    !(
      value.maximumAmount === null ||
      (typeof value.maximumAmount === "string" && isGoalDecimal(value.maximumAmount))
    ) ||
    (value.minimumAmount === null && value.targetAmount === null && value.maximumAmount === null) ||
    !object(value.source) ||
    !exactKeys(value.source, ["label", "version"]) ||
    !boundedText(value.source.label, 1, 160) ||
    !nullableText(value.source.version, 100) ||
    !nullableText(value.rationale, 1_000)
  ) {
    throw new TypeError("Nutrition goal target was invalid.");
  }
  const definition = targetable(value.definition);
  if (
    (value.minimumAmount !== null &&
      value.targetAmount !== null &&
      compareNonNegative(value.minimumAmount, value.targetAmount) > 0) ||
    (value.targetAmount !== null &&
      value.maximumAmount !== null &&
      compareNonNegative(value.targetAmount, value.maximumAmount) > 0) ||
    (value.minimumAmount !== null &&
      value.maximumAmount !== null &&
      compareNonNegative(value.minimumAmount, value.maximumAmount) > 0)
  ) {
    throw new TypeError("Nutrition goal thresholds were contradictory.");
  }
  return {
    ...definition,
    minimumAmount: value.minimumAmount,
    targetAmount: value.targetAmount,
    maximumAmount: value.maximumAmount,
    targetSource: value.source.label,
    targetSourceVersion: value.source.version,
    rationale: value.rationale,
  };
}

function parseGoal(value: unknown): GoalView {
  if (
    !object(value) ||
    !exactKeys(value, [
      "id",
      "status",
      "effectiveFrom",
      "effectiveTo",
      "revision",
      "currentVersion",
      "notice",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.status !== "string" ||
    !GOAL_STATUSES.has(value.status) ||
    !isLocalDate(value.effectiveFrom) ||
    !(value.effectiveTo === null || isLocalDate(value.effectiveTo)) ||
    (value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.revision) ||
    value.notice !== GOAL_NOTICE ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !object(value.currentVersion)
  ) {
    throw new TypeError("Nutrition goal response was invalid.");
  }
  const version = value.currentVersion;
  if (
    !exactKeys(version, ["id", "versionNumber", "energy", "nutrientTargets", "createdAt"]) ||
    typeof version.id !== "string" ||
    !UUID.test(version.id) ||
    !Number.isSafeInteger(version.versionNumber) ||
    Number(version.versionNumber) < 1 ||
    !Array.isArray(version.nutrientTargets) ||
    version.nutrientTargets.length > 256 ||
    !timestamp(version.createdAt)
  ) {
    throw new TypeError("Nutrition goal version was invalid.");
  }
  const targets = version.nutrientTargets.map(goalTarget);
  if (new Set(targets.map((target) => target.nutrientId)).size !== targets.length) {
    throw new TypeError("Nutrition goal contained duplicate nutrient targets.");
  }
  return {
    id: value.id,
    status: value.status as GoalView["status"],
    revision: value.revision,
    versionId: version.id,
    versionNumber: Number(version.versionNumber),
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    energy: energySnapshot(version.energy),
    targets,
    notice: GOAL_NOTICE,
  };
}

export function parseCurrentGoal(value: unknown): GoalView | null {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !object(value.data) ||
    !exactKeys(value.data, ["goal"])
  ) {
    throw new TypeError("Current nutrition goal response was invalid.");
  }
  return value.data.goal === null ? null : parseGoal(value.data.goal);
}

export function parseGoalMutation(value: unknown): {
  readonly replayed: boolean;
  readonly goal: GoalView;
} {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !object(value.data) ||
    !exactKeys(value.data, ["replayed", "goal"]) ||
    typeof value.data.replayed !== "boolean"
  ) {
    throw new TypeError("Nutrition goal mutation response was invalid.");
  }
  return { replayed: value.data.replayed, goal: parseGoal(value.data.goal) };
}

function progressThreshold(value: unknown): GoalProgressRowView["minimum"] {
  if (value === null) return null;
  if (
    !object(value) ||
    !exactKeys(value, ["amount", "state"]) ||
    typeof value.amount !== "string" ||
    !aggregateDecimal(value.amount) ||
    typeof value.state !== "string" ||
    !THRESHOLD_STATES.has(value.state)
  ) {
    throw new TypeError("Nutrition goal progress threshold was invalid.");
  }
  return { amount: value.amount, state: value.state };
}

function progressRow(value: unknown): GoalProgressRowView {
  if (
    !object(value) ||
    !exactKeys(value, [
      "nutrientId",
      "code",
      "name",
      "unit",
      "knownAmount",
      "amountInterpretation",
      "completeness",
      "minimum",
      "target",
      "maximum",
    ]) ||
    typeof value.nutrientId !== "string" ||
    !POSITIVE_ID.test(value.nutrientId) ||
    !boundedText(value.code, 1, 64) ||
    !boundedText(value.name, 1, 200) ||
    !boundedText(value.unit, 1, 32) ||
    typeof value.knownAmount !== "string" ||
    !aggregateDecimal(value.knownAmount) ||
    !["exact", "lower_bound"].includes(String(value.amountInterpretation)) ||
    !["complete", "partial", "unknown"].includes(String(value.completeness)) ||
    (value.completeness !== "complete" && value.amountInterpretation !== "lower_bound")
  ) {
    throw new TypeError("Nutrition goal progress row was invalid.");
  }
  const minimum = progressThreshold(value.minimum);
  const maximum = progressThreshold(value.maximum);
  let target: GoalProgressRowView["target"] = null;
  if (value.target !== null) {
    if (
      !object(value.target) ||
      !exactKeys(value.target, ["amount", "lowerBoundPercent", "percentIsExact"]) ||
      typeof value.target.amount !== "string" ||
      !aggregateDecimal(value.target.amount) ||
      !(
        value.target.lowerBoundPercent === null ||
        (typeof value.target.lowerBoundPercent === "string" &&
          percentageDecimal(value.target.lowerBoundPercent))
      ) ||
      typeof value.target.percentIsExact !== "boolean" ||
      value.target.percentIsExact !== (value.amountInterpretation === "exact")
    ) {
      throw new TypeError("Nutrition goal target progress was invalid.");
    }
    target = {
      amount: value.target.amount,
      lowerBoundPercent: value.target.lowerBoundPercent,
      percentIsExact: value.target.percentIsExact,
    };
  }
  if (
    (value.amountInterpretation === "exact" &&
      (minimum?.state === "indeterminate" || maximum?.state === "indeterminate")) ||
    (value.amountInterpretation === "lower_bound" &&
      (minimum?.state === "below" || maximum?.state === "within"))
  ) {
    throw new TypeError("Nutrition goal threshold state contradicted coverage.");
  }
  return {
    nutrientId: value.nutrientId,
    code: value.code,
    name: value.name,
    unit: value.unit,
    knownAmount: value.knownAmount,
    amountInterpretation: value.amountInterpretation as GoalProgressRowView["amountInterpretation"],
    completeness: value.completeness as Coverage,
    minimum,
    target,
    maximum,
  };
}

export function parseGoalProgress(value: unknown): GoalProgressView {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !object(value.data) ||
    !exactKeys(value.data, [
      "localDate",
      "timeZone",
      "diaryRevision",
      "goal",
      "energy",
      "nutrients",
      "notice",
    ]) ||
    !isLocalDate(value.data.localDate) ||
    typeof value.data.timeZone !== "string" ||
    !isSupportedTimeZone(value.data.timeZone) ||
    typeof value.data.diaryRevision !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.data.diaryRevision) ||
    value.data.notice !== GOAL_NOTICE ||
    !Array.isArray(value.data.nutrients) ||
    value.data.nutrients.length > 256
  ) {
    throw new TypeError("Nutrition goal progress response was invalid.");
  }
  let goal: GoalProgressView["goal"] = null;
  if (value.data.goal !== null) {
    if (
      !object(value.data.goal) ||
      !exactKeys(value.data.goal, ["id", "versionId", "revision"]) ||
      typeof value.data.goal.id !== "string" ||
      !UUID.test(value.data.goal.id) ||
      typeof value.data.goal.versionId !== "string" ||
      !UUID.test(value.data.goal.versionId) ||
      typeof value.data.goal.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(value.data.goal.revision)
    ) {
      throw new TypeError("Nutrition goal progress identity was invalid.");
    }
    goal = value.data.goal as GoalProgressView["goal"];
  }
  const nutrients = value.data.nutrients.map(progressRow);
  if (new Set(nutrients.map((row) => row.nutrientId)).size !== nutrients.length) {
    throw new TypeError("Nutrition goal progress contained duplicate nutrients.");
  }
  const energy = value.data.energy === null ? null : progressRow(value.data.energy);
  if (energy !== null && (energy.unit !== "kcal" || energy.code.toLowerCase() !== "energy")) {
    throw new TypeError("Nutrition goal energy progress was invalid.");
  }
  return {
    localDate: value.data.localDate,
    timeZone: value.data.timeZone,
    diaryRevision: value.data.diaryRevision,
    goal,
    energy,
    nutrients,
    notice: GOAL_NOTICE,
  };
}

export function parseTargetableNutrients(value: unknown): readonly TargetableNutrient[] {
  if (
    !object(value) ||
    !exactKeys(value, ["data"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 256
  ) {
    throw new TypeError("Targetable nutrient list was invalid.");
  }
  const definitions = value.data.map(targetable);
  if (new Set(definitions.map((row) => row.nutrientId)).size !== definitions.length) {
    throw new TypeError("Targetable nutrient list contained duplicates.");
  }
  return definitions;
}

export function isRecipePositiveDecimal(value: string): boolean {
  return /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u.test(value);
}

export function isGoalDecimal(value: string): boolean {
  return /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/u.test(value);
}

export function isSignedGoalDecimal(value: string): boolean {
  return /^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u.test(value);
}

/**
 * Keep the exact body object and operation id until a response is authoritative.
 * A retry after a dropped response therefore cannot create a second revision.
 */
export function prepareStableMutation<TBody>(
  pending: ReadonlyMap<string, StableMutation<TBody>>,
  intentKey: string,
  bodyFactory: () => TBody,
  operationIdFactory: () => string,
): StableMutation<TBody> {
  const existing = pending.get(intentKey);
  if (existing) return existing;
  return { intentKey, operationId: operationIdFactory(), body: bodyFactory() };
}

export function prepareRecipeLogOperation(
  pending: ReadonlyMap<string, StableMutation<RecipeLogBody>>,
  input: {
    readonly recipeId: string;
    readonly recipeVersionId: string;
    readonly portion: RecipeLogBody["portion"];
    readonly mealSlot: MealSlot;
    readonly localDate: string;
    readonly timeZone: string;
  },
  now: Date,
  operationIdFactory: () => string,
): StableMutation<RecipeLogBody> {
  const intentKey = JSON.stringify([
    input.recipeId,
    input.recipeVersionId,
    input.portion,
    input.mealSlot,
    input.localDate,
  ]);
  return prepareStableMutation(
    pending,
    intentKey,
    () => ({
      recipeVersionId: input.recipeVersionId,
      portion: input.portion,
      mealSlot: input.mealSlot,
      occurredAt: quickAddOccurredAt(input.localDate, input.timeZone, now),
    }),
    operationIdFactory,
  );
}

/** Convert an explicitly selected wall clock time while rejecting DST gaps. */
export function recipeLogInstant(localDate: string, localTime: string, timeZone: string): string {
  return localDateTimeToInstant(localDate, localTime, timeZone);
}

export function authoritativeRecipeDate(now: Date, timeZone: string): string {
  return localDateInTimeZone(now, timeZone);
}

function aggregateDecimal(value: string): boolean {
  return value.length <= 160 && NON_NEGATIVE_DECIMAL.test(value);
}

function percentageDecimal(value: string): boolean {
  return value.length <= 200 && NON_NEGATIVE_DECIMAL.test(value);
}

/** Convert only the already-bounded presentation percentage, never a nutrient amount. */
function displayPercent(value: string | null): number | null {
  if (value === null) return null;
  if (!percentageDecimal(value))
    throw new TypeError("Nutrient progress contained an invalid percentage.");
  const integerDigits = value.split(".", 1)[0]?.length ?? 0;
  if (integerDigits > 3) return 100;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 100;
}

export function nutrientProgressPresentation(
  input: NutrientProgressInput,
): NutrientProgressPresentation {
  if (!aggregateDecimal(input.knownAmount)) {
    throw new TypeError("Nutrient progress contained an invalid amount.");
  }
  if (input.targetAmount !== null && !aggregateDecimal(input.targetAmount)) {
    throw new TypeError("Nutrient progress contained an invalid target.");
  }
  if (
    (input.completeness !== "complete" && input.amountInterpretation !== "lower_bound") ||
    input.percentIsExact !== (input.amountInterpretation === "exact")
  ) {
    throw new TypeError("Nutrient progress coverage was contradictory.");
  }

  const lowerBound = input.amountInterpretation === "lower_bound";
  const valueText = `${lowerBound ? "at least " : ""}${input.knownAmount} ${input.unit}`;
  const targetText =
    input.targetAmount === null ? "No daily target" : `Target ${input.targetAmount} ${input.unit}`;
  const coverageText =
    input.amountInterpretation === "exact"
      ? "Complete quantified coverage"
      : input.completeness === "complete"
        ? "Complete source coverage — trace or unquantified contributions make this a lower bound"
        : input.completeness === "partial"
          ? "Partial coverage — shown amount is a quantified lower bound"
          : "Unknown coverage — zero is not a measured zero";
  const progressPercent = displayPercent(input.lowerBoundPercent);
  return {
    valueText,
    targetText,
    coverageText,
    accessibilityLabel: `${input.name}: ${valueText}. ${targetText}. ${coverageText}.`,
    progressPercent,
  };
}

export function recipeIngredientAccessibilityLabel(input: {
  readonly name: string;
  readonly amountText: string;
  readonly sourceText: string;
  readonly coverage: Coverage;
}): string {
  const coverage =
    input.coverage === "complete"
      ? "complete quantified coverage"
      : input.coverage === "partial"
        ? "partial coverage"
        : "unknown coverage";
  return `${input.name}. ${input.amountText}. Source: ${input.sourceText}. ${coverage}.`;
}

/** Render the server's flattened transitive provenance once per immutable release. */
export function recipeSourceLines(recipe: Pick<RecipeView, "sources">): readonly string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of recipe.sources) {
    const identity = `${source.code}\u0000${source.releaseId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const attribution = source.attributionRequired ? source.attributionText : source.displayName;
    lines.push(`${attribution} · ${source.licenseExpression}`);
  }
  return lines;
}
