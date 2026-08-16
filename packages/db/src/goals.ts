import { randomUUID } from "node:crypto";

import {
  canonicalDecimal,
  canonicalNonNegativeDecimal,
  canonicalPositiveDecimal,
  decimal,
  MIFFLIN_ST_JEOR_SOURCE,
  NUTRIENT_UNITS,
  NUTRITION_ENGINE_VERSION,
  type NutrientCategory,
  type NutrientUnit,
  PRODUCT_PAL_POLICY,
} from "@nutrition-tracker/domain";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";

import { type DiaryNutrientAggregateRecord, readDiaryDaySnapshot } from "./diary.js";
import type {
  Database,
  JsonObject,
  NutrientDimension,
  NutritionGoalVersionTable,
} from "./types.js";

const MAX_TARGETS = 256;

export type NutritionGoalPersistenceErrorCode =
  | "GOAL_IDEMPOTENCY_CONFLICT"
  | "GOAL_NOT_FOUND"
  | "GOAL_REVISION_CONFLICT"
  | "GOAL_VALIDATION";

export class NutritionGoalPersistenceError extends Error {
  override readonly name: string = "NutritionGoalPersistenceError";
  constructor(
    readonly code: NutritionGoalPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class NutritionGoalNotFoundError extends NutritionGoalPersistenceError {
  constructor() {
    super("GOAL_NOT_FOUND", "Nutrition goal not found");
  }
}

export class NutritionGoalRevisionConflictError extends NutritionGoalPersistenceError {
  constructor() {
    super("GOAL_REVISION_CONFLICT", "Nutrition goal revision does not match");
  }
}

export class NutritionGoalIdempotencyConflictError extends NutritionGoalPersistenceError {
  constructor() {
    super("GOAL_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for another request");
  }
}

export class NutritionGoalValidationError extends NutritionGoalPersistenceError {
  constructor(message: string) {
    super("GOAL_VALIDATION", message);
  }
}

export class NutritionGoalUnsupportedProfileError extends NutritionGoalValidationError {
  override readonly name = "NutritionGoalUnsupportedProfileError";
}

export class NutritionGoalPeriodConflictError extends NutritionGoalValidationError {
  override readonly name = "NutritionGoalPeriodConflictError";
}

export type GoalActivityLevelCode = "active_or_moderate" | "sedentary_or_light" | "vigorous";

export type NutritionGoalEnergyInput =
  | {
      readonly mode: "fixed";
      readonly targetKcal: string;
      readonly rationale: string;
    }
  | {
      readonly mode: "derived";
      readonly activityLevelCode: GoalActivityLevelCode;
      readonly activityFactor: string;
      readonly adjustmentKcal?: string;
      readonly rationale: string;
    };

export interface NutritionGoalTargetInput {
  readonly nutrientId: string;
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionGoalDraft {
  readonly energy: NutritionGoalEnergyInput;
  readonly targets: readonly NutritionGoalTargetInput[];
}

export interface CreateNutritionGoalInput extends NutritionGoalDraft {
  readonly userId: string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
  readonly effectiveFrom: string;
}

export interface ReviseNutritionGoalInput extends NutritionGoalDraft {
  readonly userId: string;
  readonly goalId: string;
  readonly expectedRevision: bigint | number | string;
  readonly clientOperationId: string;
  readonly requestDigest: string;
}

export type NutritionGoalEnergyRecord =
  | {
      readonly mode: "fixed";
      readonly targetKcal: string;
      readonly source: { readonly code: "user-fixed"; readonly version: "1" };
      readonly rationale: string;
    }
  | {
      readonly mode: "derived";
      readonly targetKcal: string;
      readonly bmrKcal: string;
      readonly ageYears: number;
      readonly heightCm: string;
      readonly weightKg: string;
      readonly sexAtBirth: "female" | "male";
      readonly profileRevision: string;
      readonly activityLevelCode: GoalActivityLevelCode;
      readonly activityFactor: string;
      readonly adjustmentKcal: string;
      readonly source: {
        readonly equation: {
          readonly code: "mifflin-st-jeor-ree";
          readonly version: "1990-original";
          readonly url: string;
        };
        readonly activityPolicy: {
          readonly code: "fao-who-unu-pal-policy";
          readonly version: "2004-reviewed-v1";
          readonly sourceUrl: string;
        };
      };
      readonly rationale: string;
    };

export interface GoalNutrientDefinitionRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly category: NutrientCategory;
}

export interface NutritionGoalTargetRecord {
  readonly nutrient: GoalNutrientDefinitionRecord;
  readonly minimumAmount: string | null;
  readonly targetAmount: string | null;
  readonly maximumAmount: string | null;
  readonly source: { readonly label: string; readonly version: string | null };
  readonly rationale: string | null;
}

export interface NutritionGoalVersionRecord {
  readonly id: string;
  readonly versionNumber: string;
  readonly status: "active" | "archived" | "draft";
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly energy: NutritionGoalEnergyRecord;
  readonly targets: readonly NutritionGoalTargetRecord[];
  readonly calculationVersion: string;
  readonly createdAt: string;
}

export interface NutritionGoalRecord {
  readonly id: string;
  readonly status: "active" | "archived" | "draft";
  readonly currentRevision: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly currentVersion: NutritionGoalVersionRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NutritionGoalMutationResult {
  readonly replayed: boolean;
  readonly goal: NutritionGoalRecord;
}

export interface NutritionGoalTargetProgressRecord {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly knownAmount: string;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly completeness: "complete" | "partial" | "unknown";
  readonly minimum: {
    readonly amount: string;
    readonly state: "below" | "indeterminate" | "met";
  } | null;
  readonly target: {
    readonly amount: string;
    readonly lowerBoundPercent: string | null;
    readonly percentIsExact: boolean;
  } | null;
  readonly maximum: {
    readonly amount: string;
    readonly state: "exceeded" | "indeterminate" | "within";
  } | null;
}

export interface NutritionGoalEnergyProgressRecord {
  readonly nutrientId: string;
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly targetKcal: string;
  readonly knownAmount: string;
  readonly amountInterpretation: "exact" | "lower_bound";
  readonly completeness: "complete" | "partial" | "unknown";
  readonly lowerBoundPercent: string;
  readonly percentIsExact: boolean;
}

export interface NutritionGoalProgressRecord {
  readonly localDate: string;
  readonly timeZone: string;
  readonly goal: NutritionGoalRecord;
  readonly goalVersionId: string;
  readonly diaryDayId: string | null;
  readonly diaryRevision: string;
  readonly energy: NutritionGoalEnergyProgressRecord;
  readonly targets: readonly NutritionGoalTargetProgressRecord[];
}

interface LockedProfile {
  readonly revision: string;
  readonly birthDate: string | null;
  readonly sexAtBirth: "female" | "intersex" | "male" | "not_specified";
  readonly heightCm: string | null;
  readonly weightKg: string | null;
}

interface MaterializedGoal {
  readonly energy: NutritionGoalEnergyRecord;
  readonly targets: readonly NutritionGoalTargetRecord[];
}

export async function createNutritionGoal(
  database: Kysely<Database>,
  input: CreateNutritionGoalInput,
): Promise<NutritionGoalMutationResult> {
  validateOperation(input.clientOperationId, input.requestDigest);
  validateLocalDate(input.effectiveFrom);
  try {
    return await database
      .transaction()
      .setIsolationLevel("read committed")
      .execute(async (transaction) => {
        await lockGoalUser(transaction, input.userId);
        const profile = await requireWritableGoalProfile(transaction, input.userId);
        const replay = await readGoalReplay(transaction, input, "create");
        if (replay) return replay;
        const activeGoals = await transaction
          .selectFrom("nutrition_goal as goal")
          .innerJoin("nutrition_goal_version as version", "version.id", "goal.current_version_id")
          .select([
            "goal.id",
            "goal.effective_from",
            "goal.effective_to",
            "version.id as version_id",
            "version.version_number",
          ])
          .where("goal.user_id", "=", input.userId)
          .where("goal.status", "=", "active")
          .orderBy("goal.id")
          .forUpdate("goal")
          .execute();
        const futureOrContaining = activeGoals.filter(
          (goal) =>
            goal.effective_to === null || normalizeDate(goal.effective_to) > input.effectiveFrom,
        );
        if (futureOrContaining.length > 1) {
          throw new NutritionGoalPeriodConflictError("Active goal intervals are inconsistent");
        }
        const previous = futureOrContaining[0];
        if (previous) {
          const previousStart = normalizeDate(previous.effective_from);
          if (previousStart >= input.effectiveFrom) {
            throw new NutritionGoalPeriodConflictError(
              "A new active goal must begin after the prior active interval",
            );
          }
          await closeOpenGoal(transaction, input.userId, previous, input.effectiveFrom);
        }
        const materialized = await materializeGoal(
          transaction,
          profile,
          input.effectiveFrom,
          input.energy,
          input.targets,
        );
        const goalId = randomUUID();
        const versionId = randomUUID();
        await transaction
          .insertInto("nutrition_goal")
          .values({
            current_version_id: null,
            effective_from: input.effectiveFrom,
            effective_to: null,
            id: goalId,
            status: "active",
            user_id: input.userId,
          })
          .execute();
        await insertGoalVersion(transaction, {
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          goalId,
          materialized,
          userId: input.userId,
          versionId,
          versionNumber: 1,
        });
        await transaction
          .updateTable("nutrition_goal")
          .set({ current_version_id: versionId })
          .where("id", "=", goalId)
          .where("user_id", "=", input.userId)
          .executeTakeFirstOrThrow();
        const goal = await loadOwnedGoal(transaction, input.userId, goalId);
        const result = { goal, replayed: false } satisfies NutritionGoalMutationResult;
        await recordGoalOperation(transaction, input, "create", goalId, result);
        return result;
      });
  } catch (error) {
    if (isPostgresError(error, "23P01")) {
      throw new NutritionGoalPeriodConflictError("Active nutrition goal periods must not overlap");
    }
    throw error;
  }
}

export async function reviseNutritionGoal(
  database: Kysely<Database>,
  input: ReviseNutritionGoalInput,
): Promise<NutritionGoalMutationResult> {
  validateOperation(input.clientOperationId, input.requestDigest);
  const expectedRevision = positiveRevision(input.expectedRevision);
  return database
    .transaction()
    .setIsolationLevel("read committed")
    .execute(async (transaction) => {
      await lockGoalUser(transaction, input.userId);
      const profile = await requireWritableGoalProfile(transaction, input.userId);
      const replay = await readGoalReplay(transaction, input, "revise", input.goalId);
      if (replay) return replay;
      const root = await transaction
        .selectFrom("nutrition_goal as goal")
        .innerJoin("nutrition_goal_version as version", "version.id", "goal.current_version_id")
        .select([
          "goal.status",
          "goal.effective_from",
          "goal.effective_to",
          "version.version_number",
        ])
        .where("goal.id", "=", input.goalId)
        .where("goal.user_id", "=", input.userId)
        .forUpdate("goal")
        .executeTakeFirst();
      if (root?.status !== "active") throw new NutritionGoalNotFoundError();
      if (String(root.version_number) !== expectedRevision) {
        throw new NutritionGoalRevisionConflictError();
      }
      if (root.effective_to !== null) {
        throw new NutritionGoalPeriodConflictError(
          "Closed nutrition goal history cannot be revised",
        );
      }
      const effectiveFrom = normalizeDate(root.effective_from);
      const effectiveTo = root.effective_to === null ? null : normalizeDate(root.effective_to);
      const materialized = await materializeGoal(
        transaction,
        profile,
        effectiveFrom,
        input.energy,
        input.targets,
      );
      const versionNumber = Number(expectedRevision) + 1;
      if (!Number.isSafeInteger(versionNumber) || versionNumber > 2_147_483_647) {
        throw new NutritionGoalValidationError("Nutrition goal revision is out of range");
      }
      const versionId = randomUUID();
      await insertGoalVersion(transaction, {
        effectiveFrom,
        effectiveTo,
        goalId: input.goalId,
        materialized,
        userId: input.userId,
        versionId,
        versionNumber,
      });
      await transaction
        .updateTable("nutrition_goal")
        .set({ current_version_id: versionId })
        .where("id", "=", input.goalId)
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
      const goal = await loadOwnedGoal(transaction, input.userId, input.goalId);
      const result = { goal, replayed: false } satisfies NutritionGoalMutationResult;
      await recordGoalOperation(transaction, input, "revise", input.goalId, result);
      return result;
    });
}

export async function getNutritionGoal(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly goalId: string },
): Promise<NutritionGoalRecord> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableGoalUser(transaction, input.userId);
      return loadOwnedGoal(transaction, input.userId, input.goalId);
    });
}

export async function getCurrentNutritionGoal(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<NutritionGoalRecord | null> {
  validateLocalDate(input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableGoalUser(transaction, input.userId);
      return loadGoalForDate(transaction, input.userId, input.localDate);
    });
}

export async function getNutritionGoalProgress(
  database: Kysely<Database>,
  input: { readonly userId: string; readonly localDate: string },
): Promise<NutritionGoalProgressRecord | null> {
  validateLocalDate(input.localDate);
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableGoalUser(transaction, input.userId);
      const goal = await loadGoalForDate(transaction, input.userId, input.localDate);
      if (!goal) return null;
      const day = await readDiaryDaySnapshot(transaction, input);
      const energyDefinition = await loadEnergyDefinition(transaction);
      const byId = new Map(day.totals.map((total) => [total.nutrientId, total]));
      const byCode = new Map(day.totals.map((total) => [total.code, total]));
      const targets = goal.currentVersion.targets.map((target) =>
        targetProgress(target, byId.get(target.nutrient.id)),
      );
      const energyAggregate = byCode.get("energy");
      const energyKnown = energyAggregate?.knownAmount ?? "0";
      const energyExact = energyAggregate?.isExact ?? false;
      const energyCompleteness = energyAggregate?.completeness ?? "unknown";
      const targetKcal = goal.currentVersion.energy.targetKcal;
      return {
        diaryDayId: day.id,
        diaryRevision: day.revision,
        energy: {
          amountInterpretation: energyExact ? "exact" : "lower_bound",
          code: energyDefinition.code,
          completeness: energyCompleteness,
          knownAmount: energyKnown,
          lowerBoundPercent: percentage(energyKnown, targetKcal) ?? "0",
          name: energyDefinition.name,
          nutrientId: energyDefinition.id,
          percentIsExact: energyExact,
          targetKcal,
          unit: energyDefinition.unit,
        },
        goal,
        goalVersionId: goal.currentVersion.id,
        localDate: input.localDate,
        targets,
        timeZone: day.timeZone,
      };
    });
}

export async function listTargetableNutrients(
  database: Kysely<Database>,
  input: { readonly userId: string },
): Promise<readonly GoalNutrientDefinitionRecord[]> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (transaction) => {
      await requireReadableGoalUser(transaction, input.userId);
      const rows = await transaction
        .selectFrom("nutrient")
        .select(["id", "code", "name", "canonical_unit", "dimension"])
        .where("active", "=", true)
        .where("is_targetable", "=", true)
        .where("dimension", "!=", "energy")
        .orderBy("display_order")
        .orderBy("id")
        .limit(MAX_TARGETS + 1)
        .execute();
      if (rows.length > MAX_TARGETS) {
        throw new NutritionGoalValidationError("Targetable nutrient registry exceeds 256");
      }
      return rows.map((row) => ({
        category: nutrientCategory(row.dimension),
        code: row.code,
        id: row.id,
        name: row.name,
        unit: supportedUnit(row.canonical_unit),
      }));
    });
}

async function loadEnergyDefinition(
  database: Kysely<Database>,
): Promise<GoalNutrientDefinitionRecord> {
  const rows = await database
    .selectFrom("nutrient")
    .select(["id", "code", "name", "canonical_unit", "dimension"])
    .where("active", "=", true)
    .where("code", "=", "energy")
    .where("dimension", "=", "energy")
    .orderBy("id")
    .limit(2)
    .execute();
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new NutritionGoalValidationError("Canonical energy nutrient is unavailable or ambiguous");
  }
  return {
    category: nutrientCategory(rows[0].dimension),
    code: rows[0].code,
    id: rows[0].id,
    name: rows[0].name,
    unit: supportedUnit(rows[0].canonical_unit),
  };
}

async function materializeGoal(
  transaction: Transaction<Database>,
  profile: LockedProfile,
  effectiveFrom: string,
  energy: NutritionGoalEnergyInput,
  targets: readonly NutritionGoalTargetInput[],
): Promise<MaterializedGoal> {
  validateRationale(energy.rationale);
  await sql`lock table nutrient in share mode`.execute(transaction);
  const targetRecords = await materializeTargets(transaction, targets);
  if (energy.mode === "fixed") {
    return {
      energy: {
        mode: "fixed",
        rationale: energy.rationale,
        source: { code: "user-fixed", version: "1" },
        targetKcal: positiveInputDecimal(energy.targetKcal, "fixed energy target"),
      },
      targets: targetRecords,
    };
  }
  if (
    profile.birthDate === null ||
    (profile.sexAtBirth !== "female" && profile.sexAtBirth !== "male") ||
    profile.heightCm === null ||
    profile.weightKg === null
  ) {
    throw new NutritionGoalUnsupportedProfileError(
      "Derived energy requires birth date, female or male sex, height, and weight",
    );
  }
  const ageYears = ageOnDate(profile.birthDate, effectiveFrom);
  if (ageYears < 19 || ageYears > 78) {
    throw new NutritionGoalUnsupportedProfileError("Derived energy supports ages 19 through 78");
  }
  const activityFactor = positiveInputDecimal(energy.activityFactor, "activity factor");
  validateActivityFactor(energy.activityLevelCode, activityFactor);
  const adjustmentKcal = signedInputDecimal(energy.adjustmentKcal ?? "0", "energy adjustment");
  const heightCm = canonicalPositiveDecimal(profile.heightCm, "profile height");
  const weightKg = canonicalPositiveDecimal(profile.weightKg, "profile weight");
  const bmrKcal = canonicalPositiveDecimal(
    decimal(weightKg)
      .mul(10)
      .plus(decimal(heightCm).mul("6.25"))
      .minus(decimal(ageYears).mul(5))
      .plus(profile.sexAtBirth === "male" ? 5 : -161),
    "derived BMR",
  );
  const targetKcal = canonicalPositiveDecimal(
    decimal(bmrKcal).mul(activityFactor).plus(adjustmentKcal),
    "derived energy target",
  );
  assertEnergyRange(bmrKcal);
  assertEnergyRange(targetKcal);
  return {
    energy: {
      activityFactor,
      activityLevelCode: energy.activityLevelCode,
      adjustmentKcal,
      ageYears,
      bmrKcal,
      heightCm,
      mode: "derived",
      profileRevision: profile.revision,
      rationale: energy.rationale,
      sexAtBirth: profile.sexAtBirth,
      source: {
        activityPolicy: {
          code: "fao-who-unu-pal-policy",
          sourceUrl: PRODUCT_PAL_POLICY.sourceUrl,
          version: "2004-reviewed-v1",
        },
        equation: {
          code: "mifflin-st-jeor-ree",
          url: MIFFLIN_ST_JEOR_SOURCE.url,
          version: "1990-original",
        },
      },
      targetKcal,
      weightKg,
    },
    targets: targetRecords,
  };
}

async function materializeTargets(
  transaction: Transaction<Database>,
  inputs: readonly NutritionGoalTargetInput[],
): Promise<readonly NutritionGoalTargetRecord[]> {
  if (inputs.length > MAX_TARGETS) {
    throw new NutritionGoalValidationError("A goal supports at most 256 nutrient targets");
  }
  const ids = inputs.map((target) => target.nutrientId);
  if (new Set(ids).size !== ids.length) {
    throw new NutritionGoalValidationError("Goal nutrient targets must be unique");
  }
  if (ids.length === 0) return [];
  const rows = await transaction
    .selectFrom("nutrient")
    .select(["id", "code", "name", "canonical_unit", "active", "is_targetable", "dimension"])
    .where("id", "in", ids)
    .orderBy("id")
    .forKeyShare()
    .execute();
  if (rows.length !== ids.length) throw new NutritionGoalValidationError("Goal nutrient not found");
  const byId = new Map(rows.map((row) => [row.id, row]));
  return inputs.map((input) => {
    const nutrient = byId.get(input.nutrientId);
    if (!nutrient?.active || !nutrient.is_targetable || nutrient.dimension === "energy") {
      throw new NutritionGoalValidationError("Nutrient is not targetable");
    }
    const minimumAmount = nullableGoalAmount(input.minimumAmount, "minimum amount");
    const targetAmount = nullableGoalAmount(input.targetAmount, "target amount");
    const maximumAmount = nullableGoalAmount(input.maximumAmount, "maximum amount");
    if (minimumAmount === null && targetAmount === null && maximumAmount === null) {
      throw new NutritionGoalValidationError("A nutrient target requires at least one amount");
    }
    if (
      (minimumAmount !== null &&
        targetAmount !== null &&
        decimal(minimumAmount).gt(targetAmount)) ||
      (targetAmount !== null &&
        maximumAmount !== null &&
        decimal(targetAmount).gt(maximumAmount)) ||
      (minimumAmount !== null && maximumAmount !== null && decimal(minimumAmount).gt(maximumAmount))
    ) {
      throw new NutritionGoalValidationError("Nutrient target amounts are out of order");
    }
    validateSource(input.source);
    validateOptionalRationale(input.rationale);
    return {
      maximumAmount,
      minimumAmount,
      nutrient: {
        category: nutrientCategory(nutrient.dimension),
        code: nutrient.code,
        id: nutrient.id,
        name: nutrient.name,
        unit: supportedUnit(nutrient.canonical_unit),
      },
      rationale: input.rationale,
      source: input.source,
      targetAmount,
    };
  });
}

async function insertGoalVersion(
  transaction: Transaction<Database>,
  input: {
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly goalId: string;
    readonly materialized: MaterializedGoal;
    readonly userId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  },
): Promise<void> {
  const energy = input.materialized.energy;
  await transaction
    .insertInto("nutrition_goal_version")
    .values({
      activity_factor: energy.mode === "derived" ? energy.activityFactor : null,
      activity_level_code: energy.mode === "derived" ? energy.activityLevelCode : null,
      activity_policy_code: energy.mode === "derived" ? energy.source.activityPolicy.code : null,
      activity_policy_url:
        energy.mode === "derived" ? energy.source.activityPolicy.sourceUrl : null,
      activity_policy_version:
        energy.mode === "derived" ? energy.source.activityPolicy.version : null,
      age_years: energy.mode === "derived" ? energy.ageYears : null,
      assumptions: {},
      bmr_equation_code: energy.mode === "derived" ? energy.source.equation.code : null,
      bmr_equation_version: energy.mode === "derived" ? energy.source.equation.version : null,
      bmr_kcal: energy.mode === "derived" ? energy.bmrKcal : null,
      calculation_version: NUTRITION_ENGINE_VERSION,
      created_by_user_id: input.userId,
      dri_reference_group_code: null,
      dri_reference_version: null,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo,
      energy_adjustment_kcal: energy.mode === "derived" ? energy.adjustmentKcal : null,
      energy_mode: energy.mode,
      energy_source_code:
        energy.mode === "derived" ? energy.source.equation.code : energy.source.code,
      energy_source_url: energy.mode === "derived" ? energy.source.equation.url : null,
      energy_source_version:
        energy.mode === "derived" ? energy.source.equation.version : energy.source.version,
      energy_target_kcal: energy.targetKcal,
      exercise_budget_kcal: null,
      goal_status: "active",
      id: input.versionId,
      nutrition_goal_id: input.goalId,
      profile_height_cm: energy.mode === "derived" ? energy.heightCm : null,
      profile_revision: energy.mode === "derived" ? energy.profileRevision : null,
      profile_sex_at_birth: energy.mode === "derived" ? energy.sexAtBirth : null,
      profile_weight_kg: energy.mode === "derived" ? energy.weightKg : null,
      rationale: energy.rationale,
      target_count: input.materialized.targets.length,
      thermic_effect_kcal: null,
      user_id: input.userId,
      version_number: input.versionNumber,
    })
    .execute();
  if (input.materialized.targets.length > 0) {
    await transaction
      .insertInto("nutrition_goal_target")
      .values(
        input.materialized.targets.map((target) => ({
          maximum_amount: target.maximumAmount,
          metadata: {},
          minimum_amount: target.minimumAmount,
          nutrient_id: target.nutrient.id,
          nutrition_goal_version_id: input.versionId,
          rationale: target.rationale,
          target_amount: target.targetAmount,
          target_source: target.source.label,
          target_source_version: target.source.version,
          unit: target.nutrient.unit,
        })),
      )
      .execute();
  }
}

async function closeOpenGoal(
  transaction: Transaction<Database>,
  userId: string,
  previous: {
    readonly id: string;
    readonly version_id: string;
    readonly version_number: number;
  },
  effectiveTo: string,
): Promise<void> {
  const versionId = randomUUID();
  const nextVersion = previous.version_number + 1;
  await sql`
    insert into nutrition_goal_version (
      id, nutrition_goal_id, version_number, energy_mode, energy_target_kcal,
      bmr_kcal, bmr_equation_code, bmr_equation_version,
      dri_reference_group_code, dri_reference_version, activity_factor,
      exercise_budget_kcal, thermic_effect_kcal, energy_adjustment_kcal,
      assumptions, rationale, created_by_user_id, user_id, goal_status,
      effective_from, effective_to, target_count, profile_revision, age_years,
      profile_height_cm, profile_weight_kg, profile_sex_at_birth,
      activity_level_code, energy_source_code, energy_source_version,
      energy_source_url, activity_policy_code, activity_policy_version,
      activity_policy_url, calculation_version
    )
    select
      ${versionId}::uuid, nutrition_goal_id, ${nextVersion}, energy_mode, energy_target_kcal,
      bmr_kcal, bmr_equation_code, bmr_equation_version,
      dri_reference_group_code, dri_reference_version, activity_factor,
      exercise_budget_kcal, thermic_effect_kcal, energy_adjustment_kcal,
      assumptions, rationale, created_by_user_id, user_id, goal_status,
      effective_from, ${effectiveTo}::date, target_count, profile_revision, age_years,
      profile_height_cm, profile_weight_kg, profile_sex_at_birth,
      activity_level_code, energy_source_code, energy_source_version,
      energy_source_url, activity_policy_code, activity_policy_version,
      activity_policy_url, calculation_version
    from nutrition_goal_version
    where id = ${previous.version_id}::uuid and nutrition_goal_id = ${previous.id}::uuid
  `.execute(transaction);
  await sql`
    insert into nutrition_goal_target (
      nutrition_goal_version_id, nutrient_id, minimum_amount, target_amount,
      maximum_amount, unit, target_source, target_source_version, metadata, rationale
    )
    select ${versionId}::uuid, nutrient_id, minimum_amount, target_amount,
      maximum_amount, unit, target_source, target_source_version, metadata, rationale
    from nutrition_goal_target where nutrition_goal_version_id = ${previous.version_id}::uuid
  `.execute(transaction);
  await transaction
    .updateTable("nutrition_goal")
    .set({ current_version_id: versionId, effective_to: effectiveTo })
    .where("id", "=", previous.id)
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
}

async function loadGoalForDate(
  database: Kysely<Database>,
  userId: string,
  localDate: string,
): Promise<NutritionGoalRecord | null> {
  const root = await database
    .selectFrom("nutrition_goal")
    .select("id")
    .where("user_id", "=", userId)
    .where("status", "=", "active")
    .where("effective_from", "<=", localDate)
    .where((expression) =>
      expression.or([
        expression("effective_to", "is", null),
        expression("effective_to", ">", localDate),
      ]),
    )
    .orderBy("effective_from", "desc")
    .limit(2)
    .execute();
  if (root.length > 1) throw new NutritionGoalPeriodConflictError("Active goal periods overlap");
  return root[0] ? loadOwnedGoal(database, userId, root[0].id) : null;
}

async function loadOwnedGoal(
  database: Kysely<Database>,
  userId: string,
  goalId: string,
): Promise<NutritionGoalRecord> {
  const row = await database
    .selectFrom("nutrition_goal as goal")
    .innerJoin("nutrition_goal_version as version", "version.id", "goal.current_version_id")
    .select([
      "goal.id",
      "goal.status",
      "goal.effective_from",
      "goal.effective_to",
      "goal.created_at",
      "goal.updated_at",
      "version.id as version_id",
      "version.version_number",
    ])
    .where("goal.id", "=", goalId)
    .where("goal.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new NutritionGoalNotFoundError();
  return {
    createdAt: row.created_at.toISOString(),
    currentRevision: String(row.version_number),
    currentVersion: await loadGoalVersion(database, userId, row.version_id),
    effectiveFrom: normalizeDate(row.effective_from),
    effectiveTo: row.effective_to === null ? null : normalizeDate(row.effective_to),
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadGoalVersion(
  database: Kysely<Database>,
  userId: string,
  versionId: string,
): Promise<NutritionGoalVersionRecord> {
  const row = await database
    .selectFrom("nutrition_goal_version")
    .selectAll()
    .where("id", "=", versionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new NutritionGoalNotFoundError();
  const targets = await database
    .selectFrom("nutrition_goal_target as target")
    .innerJoin("nutrient", "nutrient.id", "target.nutrient_id")
    .select([
      "target.nutrient_id",
      "target.minimum_amount",
      "target.target_amount",
      "target.maximum_amount",
      "target.unit",
      "target.target_source",
      "target.target_source_version",
      "target.rationale",
      "nutrient.code",
      "nutrient.name",
      "nutrient.dimension",
    ])
    .where("target.nutrition_goal_version_id", "=", versionId)
    .orderBy("nutrient.code")
    .limit(MAX_TARGETS + 1)
    .execute();
  if (targets.length !== row.target_count || targets.length > MAX_TARGETS) {
    throw new NutritionGoalValidationError("Goal target count is inconsistent");
  }
  const energy: NutritionGoalEnergyRecord =
    row.energy_mode === "fixed"
      ? {
          mode: "fixed",
          rationale: requiredText(row.rationale, "goal rationale"),
          source: { code: "user-fixed", version: "1" },
          targetKcal: canonicalPositive(row.energy_target_kcal, "energy target"),
        }
      : loadDerivedEnergy(row);
  return {
    calculationVersion: row.calculation_version,
    createdAt: row.created_at.toISOString(),
    effectiveFrom: normalizeDate(row.effective_from),
    effectiveTo: row.effective_to === null ? null : normalizeDate(row.effective_to),
    energy,
    id: row.id,
    status: row.goal_status,
    targets: targets.map((target) => ({
      maximumAmount: nullableCanonical(target.maximum_amount),
      minimumAmount: nullableCanonical(target.minimum_amount),
      nutrient: {
        category: nutrientCategory(target.dimension),
        code: target.code,
        id: target.nutrient_id,
        name: target.name,
        unit: supportedUnit(target.unit),
      },
      rationale: target.rationale,
      source: { label: target.target_source, version: target.target_source_version },
      targetAmount: nullableCanonical(target.target_amount),
    })),
    versionNumber: String(row.version_number),
  };
}

function loadDerivedEnergy(row: Selectable<NutritionGoalVersionTable>): NutritionGoalEnergyRecord {
  if (
    row.energy_mode !== "derived" ||
    row.bmr_kcal === null ||
    row.age_years === null ||
    row.profile_height_cm === null ||
    row.profile_weight_kg === null ||
    (row.profile_sex_at_birth !== "female" && row.profile_sex_at_birth !== "male") ||
    row.profile_revision === null ||
    row.activity_factor === null ||
    !isActivityCode(row.activity_level_code) ||
    row.energy_adjustment_kcal === null ||
    !row.energy_source_url ||
    !row.activity_policy_url
  ) {
    throw new NutritionGoalValidationError("Derived energy snapshot is incomplete");
  }
  return {
    activityFactor: canonicalPositive(row.activity_factor, "activity factor"),
    activityLevelCode: row.activity_level_code,
    adjustmentKcal: canonicalDecimal(row.energy_adjustment_kcal, "energy adjustment"),
    ageYears: row.age_years,
    bmrKcal: canonicalPositive(row.bmr_kcal, "BMR"),
    heightCm: canonicalPositive(row.profile_height_cm, "height"),
    mode: "derived",
    profileRevision: String(row.profile_revision),
    rationale: requiredText(row.rationale, "goal rationale"),
    sexAtBirth: row.profile_sex_at_birth,
    source: {
      activityPolicy: {
        code: "fao-who-unu-pal-policy",
        sourceUrl: row.activity_policy_url,
        version: "2004-reviewed-v1",
      },
      equation: {
        code: "mifflin-st-jeor-ree",
        url: row.energy_source_url,
        version: "1990-original",
      },
    },
    targetKcal: canonicalPositive(row.energy_target_kcal, "energy target"),
    weightKg: canonicalPositive(row.profile_weight_kg, "weight"),
  };
}

async function requireWritableGoalProfile(
  transaction: Transaction<Database>,
  userId: string,
): Promise<LockedProfile> {
  const row = await transaction
    .selectFrom("user_profile as profile")
    .innerJoin("app_user as user", "user.id", "profile.user_id")
    .select([
      "profile.revision",
      "profile.birth_date",
      "profile.sex_at_birth",
      "profile.height_cm",
      "profile.baseline_weight_kg",
    ])
    .where("profile.user_id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .forUpdate(["user", "profile"])
    .executeTakeFirst();
  if (!row) throw new NutritionGoalNotFoundError();
  return {
    birthDate: row.birth_date === null ? null : normalizeDate(row.birth_date),
    heightCm: row.height_cm,
    revision: row.revision,
    sexAtBirth: row.sex_at_birth,
    weightKg: row.baseline_weight_kg,
  };
}

async function requireReadableGoalUser(database: Kysely<Database>, userId: string): Promise<void> {
  const row = await database
    .selectFrom("app_user")
    .select("id")
    .where("id", "=", userId)
    .where("status", "=", "active")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NutritionGoalNotFoundError();
}

async function lockGoalUser(transaction: Transaction<Database>, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`nutrition-tracker:goal:${userId}`}, 0))`.execute(
    transaction,
  );
}

async function readGoalReplay(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
  },
  operation: "create" | "revise",
  goalId?: string,
): Promise<NutritionGoalMutationResult | null> {
  const row = await transaction
    .selectFrom("nutrition_goal_operation")
    .select(["request_digest", "operation", "nutrition_goal_id", "result_payload"])
    .where("user_id", "=", input.userId)
    .where("client_operation_id", "=", input.clientOperationId)
    .executeTakeFirst();
  if (!row) return null;
  if (
    row.request_digest !== input.requestDigest ||
    row.operation !== operation ||
    (goalId !== undefined && row.nutrition_goal_id !== goalId)
  ) {
    throw new NutritionGoalIdempotencyConflictError();
  }
  return { ...(row.result_payload as unknown as NutritionGoalMutationResult), replayed: true };
}

async function recordGoalOperation(
  transaction: Transaction<Database>,
  input: {
    readonly userId: string;
    readonly clientOperationId: string;
    readonly requestDigest: string;
  },
  operation: "create" | "revise",
  goalId: string,
  result: NutritionGoalMutationResult,
): Promise<void> {
  await transaction
    .insertInto("nutrition_goal_operation")
    .values({
      client_operation_id: input.clientOperationId,
      nutrition_goal_id: goalId,
      operation,
      request_digest: input.requestDigest,
      result_payload: JSON.parse(JSON.stringify(result)) as JsonObject,
      user_id: input.userId,
    })
    .execute();
}

function targetProgress(
  target: NutritionGoalTargetRecord,
  aggregate: DiaryNutrientAggregateRecord | undefined,
): NutritionGoalTargetProgressRecord {
  const known = aggregate?.knownAmount ?? "0";
  const exact = aggregate?.isExact ?? false;
  const completeness = aggregate?.completeness ?? "unknown";
  return {
    amountInterpretation: exact ? "exact" : "lower_bound",
    code: target.nutrient.code,
    completeness,
    knownAmount: known,
    maximum:
      target.maximumAmount === null
        ? null
        : {
            amount: target.maximumAmount,
            state: decimal(known).gt(target.maximumAmount)
              ? "exceeded"
              : exact
                ? "within"
                : "indeterminate",
          },
    minimum:
      target.minimumAmount === null
        ? null
        : {
            amount: target.minimumAmount,
            state: decimal(known).gte(target.minimumAmount)
              ? "met"
              : exact
                ? "below"
                : "indeterminate",
          },
    name: target.nutrient.name,
    nutrientId: target.nutrient.id,
    target:
      target.targetAmount === null
        ? null
        : {
            amount: target.targetAmount,
            lowerBoundPercent: percentage(known, target.targetAmount),
            percentIsExact: exact,
          },
    unit: target.nutrient.unit,
  };
}

function percentage(known: string, target: string): string | null {
  if (decimal(target).isZero()) return null;
  const result = canonicalNonNegativeDecimal(
    decimal(known).mul(100).div(target),
    "goal percentage",
  );
  if (result.length > 200) {
    throw new NutritionGoalValidationError("Goal percentage is out of response range");
  }
  return result;
}

function validateOperation(clientOperationId: string, requestDigest: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      clientOperationId,
    )
  ) {
    throw new NutritionGoalValidationError("clientOperationId must be a UUID");
  }
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    throw new NutritionGoalValidationError("requestDigest must be a lowercase SHA-256 hex");
  }
}

function positiveRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 2_147_483_647n) {
    throw new NutritionGoalValidationError("Nutrition goal revision is invalid");
  }
  return text;
}

function validateLocalDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new NutritionGoalValidationError("Date is invalid");
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new NutritionGoalValidationError("Date is invalid");
  }
}

function ageOnDate(birthDate: string, onDate: string): number {
  validateLocalDate(birthDate);
  validateLocalDate(onDate);
  const [birthYear, birthMonth, birthDay] = birthDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [year, month, day] = onDate.split("-").map(Number) as [number, number, number];
  return (
    year - birthYear - (month < birthMonth || (month === birthMonth && day < birthDay) ? 1 : 0)
  );
}

function positiveInputDecimal(value: string, label: string): string {
  try {
    if (!/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value)) throw new Error();
    const result = canonicalPositiveDecimal(value, label);
    assertEnergyRange(result);
    return result;
  } catch {
    throw new NutritionGoalValidationError(`${label} is invalid or out of range`);
  }
}

function signedInputDecimal(value: string, label: string): string {
  try {
    if (!/^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(value) || value === "-0") {
      throw new Error();
    }
    const result = canonicalDecimal(value, label);
    if (decimal(result).abs().gte("1000000000000")) throw new Error();
    return result;
  } catch {
    throw new NutritionGoalValidationError(`${label} is invalid or out of range`);
  }
}

function nullableGoalAmount(value: string | null, label: string): string | null {
  if (value === null) return null;
  try {
    if (!/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/.test(value)) throw new Error();
    const result = canonicalNonNegativeDecimal(value, label);
    if (decimal(result).gte("1000000000000000000") || result.length > 160) throw new Error();
    return result;
  } catch {
    throw new NutritionGoalValidationError(`${label} is invalid or out of range`);
  }
}

function validateActivityFactor(code: GoalActivityLevelCode, factor: string): void {
  const value = decimal(factor);
  const [minimum, maximum] =
    code === "sedentary_or_light"
      ? ["1.40", "1.69"]
      : code === "active_or_moderate"
        ? ["1.70", "1.99"]
        : code === "vigorous"
          ? ["2.00", "2.40"]
          : ["1", "0"];
  if (value.lt(minimum) || value.gt(maximum)) {
    throw new NutritionGoalValidationError("Activity factor is outside its selected PAL range");
  }
}

function assertEnergyRange(value: string): void {
  if (decimal(value).gte("1000000000000")) {
    throw new NutritionGoalValidationError("Energy value is out of range");
  }
}

function validateRationale(value: string): void {
  if (value.trim().length < 1 || [...value].length > 1000 || Buffer.byteLength(value) > 4000) {
    throw new NutritionGoalValidationError("Energy rationale is invalid");
  }
}

function validateOptionalRationale(value: string | null): void {
  if (value !== null && ([...value].length > 1000 || Buffer.byteLength(value) > 4000)) {
    throw new NutritionGoalValidationError("Target rationale is invalid");
  }
}

function validateSource(source: NutritionGoalTargetInput["source"]): void {
  if (
    source.label.trim().length < 1 ||
    [...source.label].length > 160 ||
    Buffer.byteLength(source.label) > 640 ||
    (source.version !== null &&
      (source.version.trim().length < 1 ||
        [...source.version].length > 100 ||
        Buffer.byteLength(source.version) > 400))
  ) {
    throw new NutritionGoalValidationError("Target source is invalid");
  }
}

function supportedUnit(value: string): NutrientUnit {
  if (value.length > 32 || !NUTRIENT_UNITS.includes(value as NutrientUnit)) {
    throw new NutritionGoalValidationError("Nutrient unit is unsupported");
  }
  return value as NutrientUnit;
}

function nutrientCategory(dimension: NutrientDimension): NutrientCategory {
  switch (dimension) {
    case "energy":
      return "energy";
    case "amount":
    case "mass":
    case "ratio":
    case "volume":
      // Physical dimension cannot honestly classify a nutrient as macro, vitamin, or mineral.
      return "other";
    default: {
      const exhaustive: never = dimension;
      throw new NutritionGoalValidationError(
        `Unsupported nutrient dimension: ${String(exhaustive)}`,
      );
    }
  }
}

function canonicalPositive(value: string | null, label: string): string {
  if (value === null) throw new NutritionGoalValidationError(`${label} is missing`);
  try {
    return canonicalPositiveDecimal(value, label);
  } catch {
    throw new NutritionGoalValidationError(`${label} is invalid`);
  }
}

function nullableCanonical(value: string | null): string | null {
  return value === null ? null : canonicalNonNegativeDecimal(value);
}

function requiredText(value: string | null, label: string): string {
  if (value === null || value.trim().length < 1) {
    throw new NutritionGoalValidationError(`${label} is missing`);
  }
  return value;
}

function normalizeDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isActivityCode(value: unknown): value is GoalActivityLevelCode {
  return value === "sedentary_or_light" || value === "active_or_moderate" || value === "vigorous";
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
