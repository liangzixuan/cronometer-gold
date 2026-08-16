import type { DecimalInput, DecimalString } from "./decimal.js";
import {
  canonicalDecimal,
  canonicalNonNegativeDecimal,
  canonicalPositiveDecimal,
  decimal,
} from "./decimal.js";
import { domainInvariant } from "./errors.js";
import { deepFreeze } from "./immutable.js";
import type { NutrientAggregate, NutrientCompleteness } from "./nutrients.js";

/** Original equation: Mifflin et al., AJCN 1990, DOI 10.1093/ajcn/51.2.241. */
export const MIFFLIN_ST_JEOR_SOURCE = deepFreeze({
  code: "mifflin-st-jeor-ree",
  version: "1990-original",
  url: "https://doi.org/10.1093/ajcn/51.2.241",
} as const);

/**
 * Product-reviewed PAL policy. PAL means 24-hour TEE / BMR. The categories are
 * based on FAO/WHO/UNU Technical Report Series 1 (2004), sections 3.4 and 5.3.
 * The single representative factors are our explicit product policy—not values
 * prescribed for an individual by FAO—and therefore carry their own version.
 */
export const PRODUCT_PAL_POLICY = deepFreeze({
  code: "fao-who-unu-pal-policy",
  version: "2004-reviewed-v1",
  sourceUrl: "https://www.fao.org/4/y5686e/y5686e07.htm",
  levels: {
    sedentary_or_light: {
      label: "Sedentary or light activity",
      publishedRange: { minimum: "1.4", maximum: "1.69" },
    },
    active_or_moderate: {
      label: "Active or moderately active",
      publishedRange: { minimum: "1.7", maximum: "1.99" },
    },
    vigorous: {
      label: "Vigorous or vigorously active",
      publishedRange: { minimum: "2", maximum: "2.4" },
    },
  },
} as const);

export type PalLevelCode = keyof typeof PRODUCT_PAL_POLICY.levels;
export type SupportedMifflinSex = "female" | "male";
/** Resource bound for exact progress ratios at the published transport boundary. */
export const MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH = 200;

export interface DerivedEnergyInput {
  readonly mode: "derived";
  readonly effectiveDate: string;
  readonly birthDate: string;
  readonly sexAtBirth: SupportedMifflinSex;
  /** Revision of the coherent authenticated profile snapshot used for every input. */
  readonly profileRevision: string;
  readonly heightCm: DecimalInput;
  readonly weightKg: DecimalInput;
  readonly activityLevelCode: PalLevelCode;
  /** Explicit PAL selection; the application never silently chooses a category midpoint. */
  readonly activityFactor: DecimalInput;
  readonly adjustmentKcal?: DecimalInput;
  readonly rationale: string;
}

export interface FixedEnergyInput {
  readonly mode: "fixed";
  readonly targetKcal: DecimalInput;
  readonly rationale: string;
}

export type EnergyTargetInput = DerivedEnergyInput | FixedEnergyInput;

export type EnergyTargetSnapshot =
  | {
      readonly mode: "fixed";
      readonly targetKcal: DecimalString;
      readonly source: { readonly code: "user-fixed"; readonly version: "1" };
      readonly rationale: string;
    }
  | {
      readonly mode: "derived";
      readonly targetKcal: DecimalString;
      readonly bmrKcal: DecimalString;
      readonly ageYears: number;
      readonly heightCm: DecimalString;
      readonly weightKg: DecimalString;
      readonly sexAtBirth: SupportedMifflinSex;
      readonly profileRevision: string;
      readonly activityLevelCode: PalLevelCode;
      readonly activityFactor: DecimalString;
      readonly adjustmentKcal: DecimalString;
      readonly source: {
        readonly equation: typeof MIFFLIN_ST_JEOR_SOURCE;
        readonly activityPolicy: {
          readonly code: string;
          readonly version: string;
          readonly sourceUrl: string;
        };
      };
      readonly rationale: string;
    };

export function createEnergyTargetSnapshot(input: EnergyTargetInput): EnergyTargetSnapshot {
  const rationale = requiredRationale(input.rationale);
  if (input.mode === "fixed") {
    return deepFreeze({
      mode: "fixed",
      targetKcal: canonicalPositiveDecimal(input.targetKcal, "fixed energy target"),
      source: { code: "user-fixed", version: "1" },
      rationale,
    });
  }

  const ageYears = ageOnDate(input.birthDate, input.effectiveDate);
  domainInvariant(
    /^(?:0|[1-9][0-9]*)$/.test(input.profileRevision),
    "INVALID_GOAL",
    "A valid profile revision is required for derived energy",
  );
  domainInvariant(
    ageYears >= 19 && ageYears <= 78,
    "INVALID_GOAL",
    "Mifflin–St Jeor derivation is limited to the original study age range of 19 through 78",
    { ageYears },
  );
  domainInvariant(
    input.sexAtBirth === "female" || input.sexAtBirth === "male",
    "INVALID_GOAL",
    "Mifflin–St Jeor requires an explicit female or male equation selection",
  );
  const heightCm = canonicalPositiveDecimal(input.heightCm, "heightCm");
  const weightKg = canonicalPositiveDecimal(input.weightKg, "weightKg");
  const level = PRODUCT_PAL_POLICY.levels[input.activityLevelCode];
  domainInvariant(level, "INVALID_GOAL", "Activity level is not in the reviewed PAL policy", {
    activityLevelCode: input.activityLevelCode,
  });
  const activityFactor = validatePalSelection(input.activityLevelCode, input.activityFactor);
  const sexConstant = input.sexAtBirth === "male" ? decimal(5) : decimal(-161);
  const bmr = decimal(weightKg)
    .mul(10)
    .plus(decimal(heightCm).mul("6.25"))
    .minus(decimal(ageYears).mul(5))
    .plus(sexConstant);
  domainInvariant(bmr.gt(0), "INVALID_GOAL", "Derived resting energy must be positive");
  const adjustmentKcal = canonicalDecimal(input.adjustmentKcal ?? "0", "energy adjustment");
  const target = bmr.mul(activityFactor).plus(adjustmentKcal);
  domainInvariant(target.gt(0), "INVALID_GOAL", "Derived energy target must be positive");

  return deepFreeze({
    mode: "derived",
    targetKcal: canonicalDecimal(target, "derived energy target"),
    bmrKcal: canonicalDecimal(bmr, "resting energy"),
    ageYears,
    heightCm,
    weightKg,
    sexAtBirth: input.sexAtBirth,
    profileRevision: input.profileRevision,
    activityLevelCode: input.activityLevelCode,
    activityFactor,
    adjustmentKcal,
    source: {
      equation: MIFFLIN_ST_JEOR_SOURCE,
      activityPolicy: {
        code: PRODUCT_PAL_POLICY.code,
        version: PRODUCT_PAL_POLICY.version,
        sourceUrl: PRODUCT_PAL_POLICY.sourceUrl,
      },
    },
    rationale,
  });
}

export function validatePalSelection(
  activityLevelCode: PalLevelCode,
  factor: DecimalInput,
): DecimalString {
  const level = PRODUCT_PAL_POLICY.levels[activityLevelCode];
  domainInvariant(level, "INVALID_GOAL", "Activity level is not in the reviewed PAL policy", {
    activityLevelCode,
  });
  const activityFactor = canonicalPositiveDecimal(factor, "physical activity level");
  domainInvariant(
    decimal(activityFactor).gte(level.publishedRange.minimum) &&
      decimal(activityFactor).lte(level.publishedRange.maximum),
    "INVALID_GOAL",
    "Physical activity level is outside the reviewed category range",
    {
      activityLevelCode,
      activityFactor,
      minimum: level.publishedRange.minimum,
      maximum: level.publishedRange.maximum,
    },
  );
  return activityFactor;
}

export interface NutrientTarget {
  readonly nutrientId: string;
  readonly unit: string;
  readonly minimumAmount: DecimalInput | null;
  readonly targetAmount: DecimalInput | null;
  readonly maximumAmount: DecimalInput | null;
}

export type ThresholdState = "met" | "below" | "within" | "exceeded" | "indeterminate";

export interface NutrientTargetProgress {
  readonly nutrientId: string;
  readonly unit: string;
  readonly knownAmount: DecimalString;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly completeness: NutrientCompleteness;
  readonly minimum: { readonly amount: DecimalString; readonly state: ThresholdState } | null;
  readonly target: {
    readonly amount: DecimalString;
    readonly lowerBoundPercent: DecimalString | null;
    readonly percentIsExact: boolean;
  } | null;
  readonly maximum: { readonly amount: DecimalString; readonly state: ThresholdState } | null;
}

/**
 * Compare a diary aggregate with an explicit target without turning incomplete
 * food data into a measured total. A partial/trace aggregate can prove a minimum
 * was met or a maximum exceeded, but cannot prove the inverse.
 */
export function calculateNutrientTargetProgress(
  aggregate: NutrientAggregate,
  target: NutrientTarget,
): NutrientTargetProgress {
  domainInvariant(
    aggregate.nutrientId === target.nutrientId && aggregate.unit === target.unit,
    "UNIT_MISMATCH",
    "Goal target and diary aggregate must use the same nutrient and unit",
  );
  const minimum = optionalNonNegative(target.minimumAmount, "minimum target");
  const desired = optionalNonNegative(target.targetAmount, "nutrient target");
  const maximum = optionalNonNegative(target.maximumAmount, "maximum target");
  domainInvariant(
    minimum !== null || desired !== null || maximum !== null,
    "INVALID_GOAL",
    "A nutrient target requires at least one threshold",
  );
  if (minimum !== null && desired !== null) {
    domainInvariant(
      decimal(minimum).lte(desired),
      "INVALID_GOAL",
      "Minimum nutrient amount must not exceed target amount",
    );
  }
  if (desired !== null && maximum !== null) {
    domainInvariant(
      decimal(desired).lte(maximum),
      "INVALID_GOAL",
      "Target nutrient amount must not exceed maximum amount",
    );
  }
  if (minimum !== null && maximum !== null) {
    domainInvariant(
      decimal(minimum).lte(maximum),
      "INVALID_GOAL",
      "Minimum nutrient amount must not exceed maximum amount",
    );
  }

  const amount = decimal(aggregate.knownAmount);
  const exact = aggregate.isExact;
  const minimumState =
    minimum === null ? null : amount.gte(minimum) ? "met" : exact ? "below" : "indeterminate";
  const maximumState =
    maximum === null ? null : amount.gt(maximum) ? "exceeded" : exact ? "within" : "indeterminate";
  const lowerBoundPercent =
    desired === null || decimal(desired).isZero()
      ? null
      : canonicalNonNegativeDecimal(amount.div(desired).mul(100), "target progress percentage");
  domainInvariant(
    lowerBoundPercent === null ||
      lowerBoundPercent.length <= MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH,
    "INVALID_GOAL",
    "Target progress percentage exceeds the supported exact output bound",
    { maximumLength: MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH },
  );

  return deepFreeze({
    nutrientId: target.nutrientId,
    unit: target.unit,
    knownAmount: canonicalNonNegativeDecimal(amount, "known nutrient amount"),
    amountInterpretation: exact ? "exact" : "lower_bound",
    completeness: aggregate.completeness,
    minimum: minimum === null ? null : { amount: minimum, state: minimumState ?? "indeterminate" },
    target: desired === null ? null : { amount: desired, lowerBoundPercent, percentIsExact: exact },
    maximum: maximum === null ? null : { amount: maximum, state: maximumState ?? "indeterminate" },
  });
}

function optionalNonNegative(value: DecimalInput | null, label: string): DecimalString | null {
  return value === null ? null : canonicalNonNegativeDecimal(value, label);
}

function requiredRationale(value: string): string {
  const rationale = value.trim();
  domainInvariant(rationale.length > 0, "INVALID_GOAL", "Energy target rationale is required");
  return rationale;
}

function ageOnDate(birthDate: string, effectiveDate: string): number {
  const birth = parseDate(birthDate, "birthDate");
  const effective = parseDate(effectiveDate, "effectiveDate");
  domainInvariant(
    effective.ordinal >= birth.ordinal,
    "INVALID_GOAL",
    "Goal effective date must not precede birth date",
  );
  return (
    effective.year -
    birth.year -
    (effective.month < birth.month || (effective.month === birth.month && effective.day < birth.day)
      ? 1
      : 0)
  );
}

function parseDate(
  value: string,
  label: string,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly ordinal: number;
} {
  const match = /^(?!0000)(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  domainInvariant(match, "INVALID_GOAL", `${label} must use a valid YYYY-MM-DD date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, day);
  domainInvariant(
    check.getUTCFullYear() === year &&
      check.getUTCMonth() === month - 1 &&
      check.getUTCDate() === day,
    "INVALID_GOAL",
    `${label} is not a valid calendar date`,
  );
  return { year, month, day, ordinal: Date.UTC(year, month - 1, day) };
}
