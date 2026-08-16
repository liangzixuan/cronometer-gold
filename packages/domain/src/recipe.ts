import type { DecimalInput, DecimalString } from "./decimal.js";
import { canonicalNonNegativeDecimal, canonicalPositiveDecimal, decimal } from "./decimal.js";
import { DomainError, domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import {
  calculatePortionNutrition,
  combineNutrientAggregates,
  createResolvedNutrientProfile,
  type NutrientAggregate,
  type NutrientDefinition,
  type NutrientId,
  type NutrientProfile,
  scaleNutrientAggregate,
} from "./nutrients.js";

export const MAX_RECIPE_INGREDIENTS = 50;
export const MAX_RECIPE_NUTRIENTS = 256;
export const MAX_RECIPE_NESTING_DEPTH = 10;
export const MAX_RECIPE_DEPENDENCY_VERSIONS = 500;
/** PostgreSQL stores every immutable recipe coverage counter as a signed integer. */
export const MAX_RECIPE_NUTRIENT_COVERAGE_COUNT = 2_147_483_647;

export const DEFAULT_RECIPE_RETENTION_POLICY = deepFreeze({
  code: "identity-retention-default",
  version: "1",
  assumption: "No cooking-retention dataset was applied; omitted factors remain exactly one.",
} as const);

export interface RecipeDependencyNode {
  readonly recipeVersionId: string;
  readonly nestedRecipeVersionIds: readonly string[];
}

export interface RecipeIngredient {
  readonly id: string;
  readonly name: string;
  readonly grams: DecimalInput;
  /** Immutable food-version or nested-recipe profile. */
  readonly nutrientProfile: NutrientProfile;
  /** Nutrient-specific multiplier; omitted values are exactly 1. */
  readonly retentionFactors?: Readonly<Partial<Record<NutrientId, DecimalInput>>>;
}

export interface RecipeYield {
  readonly grams: DecimalInput;
  readonly source: "measured" | "estimated";
}

export interface RecipeCalculationInput {
  readonly ingredients: readonly RecipeIngredient[];
  /** Explicit expected set makes an absent source value become unknown. */
  readonly nutrients: readonly NutrientDefinition[];
  readonly finalYield: RecipeYield;
  readonly servingCount?: DecimalInput | null;
}

export type RecipeWarningCode =
  | "ESTIMATED_YIELD"
  | "PARTIAL_NUTRIENT_DATA"
  | "RETENTION_FACTORS_DEFAULTED"
  | "YIELD_ABOVE_INPUT_MASS"
  | "YIELD_BELOW_HALF_INPUT_MASS";

export interface RecipeWarning {
  readonly code: RecipeWarningCode;
  readonly message: string;
  readonly nutrientIds: readonly NutrientId[];
}

export interface RecipeNutrition {
  readonly inputMassGrams: DecimalString;
  readonly finalYield: {
    readonly grams: DecimalString;
    readonly source: RecipeYield["source"];
    readonly ratioToInputMass: DecimalString;
  };
  readonly servingCount: DecimalString | null;
  readonly totals: readonly NutrientAggregate[];
  readonly per100Grams: readonly NutrientAggregate[];
  readonly perServing: readonly NutrientAggregate[] | null;
  readonly retentionPolicy: typeof DEFAULT_RECIPE_RETENTION_POLICY;
  readonly warnings: readonly RecipeWarning[];
}

/**
 * Sum nutrient mass, apply per-ingredient retention, then calculate final-yield
 * concentration. Yield changes concentration only; it does not multiply total
 * nutrient mass.
 */
export function calculateRecipeNutrition(input: RecipeCalculationInput): RecipeNutrition {
  domainInvariant(
    input.ingredients.length > 0,
    "INVALID_RECIPE",
    "A recipe requires at least one ingredient",
  );
  domainInvariant(
    input.ingredients.length <= MAX_RECIPE_INGREDIENTS,
    "INVALID_RECIPE",
    `A recipe supports at most ${MAX_RECIPE_INGREDIENTS} ingredients`,
  );
  domainInvariant(
    input.nutrients.length > 0,
    "INVALID_RECIPE",
    "A recipe requires an explicit expected nutrient set",
  );
  domainInvariant(
    input.nutrients.length <= MAX_RECIPE_NUTRIENTS,
    "INVALID_RECIPE",
    `A recipe supports at most ${MAX_RECIPE_NUTRIENTS} nutrients`,
  );

  const nutrientIds = new Set(input.nutrients.map((nutrient) => nutrient.id));
  domainInvariant(
    nutrientIds.size === input.nutrients.length,
    "INVALID_RECIPE",
    "Recipe nutrient definitions must be unique",
  );

  const ingredientIds = new Set<string>();
  const resolvedIngredients = input.ingredients.map((ingredient) => {
    domainInvariant(
      ingredient.id.trim().length > 0 && ingredient.name.trim().length > 0,
      "INVALID_RECIPE",
      "Recipe ingredient id and name are required",
    );
    if (ingredientIds.has(ingredient.id)) {
      throw new DomainError("INVALID_RECIPE", `Duplicate ingredient id: ${ingredient.id}`, {
        ingredientId: ingredient.id,
      });
    }
    ingredientIds.add(ingredient.id);
    const grams = canonicalPositiveDecimal(ingredient.grams, `${ingredient.name} grams`);

    for (const nutrientId of Object.keys(ingredient.retentionFactors ?? {})) {
      domainInvariant(
        nutrientIds.has(nutrientId),
        "INVALID_RECIPE",
        `Retention factor references an unexpected nutrient: ${nutrientId}`,
        { ingredientId: ingredient.id, nutrientId },
      );
    }

    const nutrition = calculatePortionNutrition(
      ingredient.nutrientProfile,
      grams,
      input.nutrients,
    ).map((aggregate) => {
      const rawFactor = ingredient.retentionFactors?.[aggregate.nutrientId] ?? "1";
      const factor = canonicalNonNegativeDecimal(
        rawFactor,
        `${ingredient.name} ${aggregate.nutrientId} retention factor`,
      );
      domainInvariant(
        decimal(factor).lte(1),
        "INVALID_RECIPE",
        "Nutrient retention factors must be between zero and one",
        { ingredientId: ingredient.id, nutrientId: aggregate.nutrientId, factor },
      );
      return scaleNutrientAggregate(aggregate, factor);
    });

    return { grams, nutrition };
  });

  const inputMass = resolvedIngredients.reduce(
    (sum, ingredient) => sum.plus(ingredient.grams),
    decimal(0),
  );
  const yieldGrams = canonicalPositiveDecimal(input.finalYield.grams, "recipe final yield grams");
  const yieldRatio = decimal(yieldGrams).div(inputMass);
  const servingCount =
    input.servingCount === undefined || input.servingCount === null
      ? null
      : canonicalPositiveDecimal(input.servingCount, "recipe serving count");

  const totals = input.nutrients.map((definition, nutrientIndex) =>
    combineNutrientAggregates(
      definition,
      resolvedIngredients.map((ingredient) => {
        const contribution = ingredient.nutrition[nutrientIndex];
        domainInvariant(
          contribution,
          "INVALID_RECIPE",
          "Ingredient nutrient calculation did not align with expected definitions",
          { nutrientId: definition.id },
        );
        return contribution;
      }),
    ),
  );
  for (const aggregate of totals) {
    domainInvariant(
      aggregate.contributorCount <= MAX_RECIPE_NUTRIENT_COVERAGE_COUNT &&
        aggregate.quantifiedCount <= MAX_RECIPE_NUTRIENT_COVERAGE_COUNT &&
        aggregate.traceCount <= MAX_RECIPE_NUTRIENT_COVERAGE_COUNT &&
        aggregate.unknownCount <= MAX_RECIPE_NUTRIENT_COVERAGE_COUNT,
      "INVALID_RECIPE",
      "Recipe nutrient coverage exceeds the supported immutable counter range",
      { nutrientId: aggregate.nutrientId },
    );
  }

  const per100Factor = decimal(100).div(yieldGrams);
  const per100Grams = totals.map((aggregate) => scaleNutrientAggregate(aggregate, per100Factor));
  const perServing =
    servingCount === null
      ? null
      : totals.map((aggregate) => scaleNutrientAggregate(aggregate, decimal(1).div(servingCount)));

  const warnings: RecipeWarning[] = [];
  if (
    input.ingredients.some((ingredient) =>
      input.nutrients.some((nutrient) => ingredient.retentionFactors?.[nutrient.id] === undefined),
    )
  ) {
    warnings.push({
      code: "RETENTION_FACTORS_DEFAULTED",
      message: DEFAULT_RECIPE_RETENTION_POLICY.assumption,
      nutrientIds: input.nutrients
        .filter((nutrient) =>
          input.ingredients.some(
            (ingredient) => ingredient.retentionFactors?.[nutrient.id] === undefined,
          ),
        )
        .map((nutrient) => nutrient.id),
    });
  }
  if (input.finalYield.source === "estimated") {
    warnings.push({
      code: "ESTIMATED_YIELD",
      message: "Final yield is estimated; per-weight nutrition may change after measuring it.",
      nutrientIds: [],
    });
  }
  if (yieldRatio.gt(1)) {
    warnings.push({
      code: "YIELD_ABOVE_INPUT_MASS",
      message:
        "Final yield exceeds the sum of entered ingredient masses; verify omitted water or units.",
      nutrientIds: [],
    });
  } else if (yieldRatio.lt("0.5")) {
    warnings.push({
      code: "YIELD_BELOW_HALF_INPUT_MASS",
      message: "Final yield is below half of input mass; verify cooking loss and units.",
      nutrientIds: [],
    });
  }
  const incompleteNutrients = totals
    .filter((aggregate) => !aggregate.isExact)
    .map((aggregate) => aggregate.nutrientId);
  if (incompleteNutrients.length > 0) {
    warnings.push({
      code: "PARTIAL_NUTRIENT_DATA",
      message: "One or more nutrients contain trace or unknown ingredient values.",
      nutrientIds: incompleteNutrients,
    });
  }

  return deepFreeze<RecipeNutrition>({
    inputMassGrams: inputMass.toFixed(),
    finalYield: {
      grams: yieldGrams,
      source: input.finalYield.source,
      ratioToInputMass: yieldRatio.toFixed(),
    },
    servingCount,
    totals,
    per100Grams,
    perServing,
    retentionPolicy: DEFAULT_RECIPE_RETENTION_POLICY,
    warnings,
  });
}

/** Preserve nested-recipe coverage counters rather than flattening missing to 0. */
export function recipePer100GramProfile(recipe: RecipeNutrition): NutrientProfile {
  return createResolvedNutrientProfile("100", recipe.per100Grams);
}

/**
 * Validate the immutable nested-recipe dependency closure before publishing a
 * revision. Depth counts the root recipe as one. The persistence layer must
 * load one coherent closure and reject a missing dependency before calling.
 */
export function validateRecipeDependencies(
  rootRecipeVersionId: string,
  nodes: readonly RecipeDependencyNode[],
  maximumDepth = MAX_RECIPE_NESTING_DEPTH,
): void {
  domainInvariant(
    rootRecipeVersionId.trim().length > 0,
    "INVALID_RECIPE",
    "Root recipe version id is required",
  );
  domainInvariant(
    Number.isSafeInteger(maximumDepth) && maximumDepth > 0,
    "INVALID_RECIPE",
    "Recipe maximum depth must be a positive safe integer",
  );
  domainInvariant(
    nodes.length <= MAX_RECIPE_DEPENDENCY_VERSIONS,
    "INVALID_RECIPE",
    `Recipe dependency closure supports at most ${MAX_RECIPE_DEPENDENCY_VERSIONS} versions`,
    { count: nodes.length, maximum: MAX_RECIPE_DEPENDENCY_VERSIONS },
  );

  const graph = new Map<string, readonly string[]>();
  for (const node of nodes) {
    domainInvariant(
      node.recipeVersionId.trim().length > 0,
      "INVALID_RECIPE",
      "Recipe dependency id is required",
    );
    domainInvariant(
      !graph.has(node.recipeVersionId),
      "INVALID_RECIPE",
      `Duplicate recipe dependency node: ${node.recipeVersionId}`,
    );
    const nested = [...new Set(node.nestedRecipeVersionIds)];
    domainInvariant(
      nested.every((id) => id.trim().length > 0),
      "INVALID_RECIPE",
      "Nested recipe version ids are required",
    );
    graph.set(node.recipeVersionId, nested);
  }
  domainInvariant(
    graph.has(rootRecipeVersionId),
    "INVALID_RECIPE",
    "Recipe dependency closure is missing its root",
  );

  const visiting = new Set<string>();
  const maximumDepthFrom = new Map<string, number>();
  const visit = (id: string): number => {
    if (visiting.has(id)) {
      throw new DomainError("RECIPE_DEPENDENCY_CYCLE", "Nested recipes must not form a cycle", {
        recipeVersionId: id,
      });
    }
    const memoized = maximumDepthFrom.get(id);
    if (memoized !== undefined) return memoized;
    const dependencies = graph.get(id);
    domainInvariant(dependencies, "INVALID_RECIPE", `Recipe dependency closure is missing ${id}`, {
      recipeVersionId: id,
    });
    visiting.add(id);
    let depth = 1;
    for (const dependency of dependencies) depth = Math.max(depth, 1 + visit(dependency));
    visiting.delete(id);
    maximumDepthFrom.set(id, depth);
    return depth;
  };

  const depth = visit(rootRecipeVersionId);
  domainInvariant(
    depth <= maximumDepth,
    "RECIPE_NESTING_LIMIT",
    `Recipe nesting exceeds the supported depth of ${maximumDepth}`,
    { recipeVersionId: rootRecipeVersionId, depth, maximumDepth },
  );
}
