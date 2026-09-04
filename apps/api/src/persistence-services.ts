import {
  type AuthenticatedAccount,
  type DiaryDay,
  type DiaryDayResponse,
  type DiaryEntry,
  type DiaryEntryPortion,
  type DiaryMutationResponse,
  type DiaryNutrientAggregate,
  GENERAL_WELLNESS_NOTICE,
  type GoalProgressRow,
  type HydrationDay,
  type HydrationEntry,
  type HydrationMutationResponse,
  type NutrientCategory,
  type NutrientUnknownReason,
  type NutritionGoal,
  type NutritionGoalMutationResponse,
  type NutritionGoalProgressResponse,
  type Recipe,
  type RecipeIngredientRequest,
  type RecipeMutationResponse,
  type RecipeSummary,
  type RecipeWarningCode,
  type TargetableNutrient,
  type TargetableNutrientListResponse,
  type UpdateUserProfileRequest,
  type UserProfile,
} from "@nutrition-tracker/contracts";
import {
  AccountConflictError,
  AccountNotFoundError,
  confirmEmailVerificationToken,
  confirmPasswordRecoveryToken,
  type createDatabaseFromEnvironment,
  createFoodDiaryEntry,
  createHydrationEntry,
  createNutritionGoal,
  createReauthenticationProof,
  createRecipe,
  createRecipeDiaryEntry,
  createSession,
  EmailVerificationTokenExpiredError as DatabaseEmailVerificationTokenExpiredError,
  EmailVerificationTokenInvalidError as DatabaseEmailVerificationTokenInvalidError,
  PasswordCredentialStaleError as DatabasePasswordCredentialStaleError,
  PasswordRecoveryTokenExpiredError as DatabasePasswordRecoveryTokenExpiredError,
  PasswordRecoveryTokenInvalidError as DatabasePasswordRecoveryTokenInvalidError,
  type DiaryDayRecord,
  type DiaryEntryRecord,
  DiaryEntryRevisionConflictError,
  type DiaryFoodEntryRecord,
  DiaryIdempotencyConflictError,
  DiaryLockedError,
  type DiaryMutationResult,
  DiaryNotFoundError,
  type DiaryNutrientAggregateRecord,
  type DiaryPageContinuationRecord,
  DiaryPageStaleError,
  type DiaryRecipeEntryRecord,
  DiaryTimeZoneChangedError,
  DiaryValidationError,
  deleteDiaryEntry,
  deleteHydrationEntry,
  findActiveSessionByTokenHash,
  findPasswordCredentialByEmail,
  findPendingErasureRecoverySessionByTokenHash,
  type GoalNutrientDefinitionRecord,
  getCurrentNutritionGoal,
  getDiaryDay,
  getDiaryDayPage,
  getHydrationDay,
  getNutritionGoalProgress,
  getRecipe,
  getUserProfile,
  type HydrationDayRecord,
  type HydrationEntryRecord,
  HydrationEntryRevisionConflictError,
  HydrationIdempotencyConflictError,
  type HydrationMutationResult,
  HydrationNotFoundError,
  HydrationTimeZoneChangedError,
  HydrationValidationError,
  issueEmailVerificationToken,
  issuePasswordRecoveryToken,
  type JsonObject,
  listRecipes,
  listTargetableNutrients,
  type NutritionGoalEnergyRecord,
  NutritionGoalIdempotencyConflictError,
  type NutritionGoalMutationResult,
  NutritionGoalNotFoundError,
  NutritionGoalPeriodConflictError,
  type NutritionGoalProgressRecord,
  type NutritionGoalRecord,
  NutritionGoalRevisionConflictError,
  type NutritionGoalTargetProgressRecord,
  NutritionGoalUnsupportedProfileError,
  NutritionGoalValidationError,
  ProfileRevisionConflictError,
  RecipeCursorError,
  type RecipeDraft,
  RecipeIdempotencyConflictError,
  type RecipeIngredientRecord,
  type RecipeMutationResult,
  RecipeNotFoundError,
  type RecipeRecord,
  RecipeRevisionConflictError,
  type RecipeSourceRecord,
  RecipeValidationError,
  type RecipeWarningRecord,
  registerPasswordAccount,
  reviseNutritionGoal,
  reviseRecipe,
  revokeSession,
  type UserProfileRecord,
  updateDiaryEntry,
  updateHydrationEntry,
  updateUserProfile,
} from "@nutrition-tracker/db";
import {
  canonicalNonNegativeDecimal,
  canonicalPositiveDecimal,
  DEFAULT_RECIPE_RETENTION_POLICY,
  decimal,
  MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH,
  MIFFLIN_ST_JEOR_SOURCE,
  PRODUCT_PAL_POLICY,
  validatePalSelection,
} from "@nutrition-tracker/domain";
import {
  AccountAlreadyExistsError,
  type AuthRepository,
  EmailVerificationTokenExpiredError,
  EmailVerificationTokenInvalidError,
  InvalidCredentialsError,
  type PasswordCredential,
  PasswordRecoveryTokenExpiredError,
  PasswordRecoveryTokenInvalidError,
} from "./modules/auth/auth-service.js";
import {
  DiaryIdempotencyConflictServiceError,
  DiaryLockedServiceError,
  DiaryNotFoundServiceError,
  DiaryPageCursorServiceError,
  DiaryPageStaleServiceError,
  DiaryRevisionConflictServiceError,
  type DiaryService,
  DiaryTimeZoneChangedServiceError,
  DiaryValidationServiceError,
} from "./modules/diary/diary.routes.js";
import {
  DiaryPageCursorCodec,
  InvalidDiaryPageCursorError,
} from "./modules/diary/diary-page-cursor.js";
import {
  GoalIdempotencyConflictServiceError,
  GoalNotFoundServiceError,
  GoalPeriodConflictServiceError,
  GoalRevisionConflictServiceError,
  type GoalService,
  GoalUnsupportedProfileServiceError,
  GoalValidationServiceError,
} from "./modules/goals/goal.routes.js";
import {
  HydrationIdempotencyConflictServiceError,
  HydrationNotFoundServiceError,
  HydrationRevisionConflictServiceError,
  type HydrationService,
  HydrationTimeZoneChangedServiceError,
  HydrationValidationServiceError,
} from "./modules/hydration/hydration.routes.js";
import {
  ProfileRevisionConflictServiceError,
  type ProfileService,
  ProfileValidationServiceError,
} from "./modules/profile/profile.routes.js";
import { normalizeProfilePatch } from "./modules/profile/profile-validation.js";
import {
  RecipeCursorServiceError,
  RecipeIdempotencyConflictServiceError,
  RecipeNotFoundServiceError,
  RecipeRevisionConflictServiceError,
  type RecipeService,
  RecipeValidationServiceError,
} from "./modules/recipes/recipe.routes.js";

type AppDatabase = ReturnType<typeof createDatabaseFromEnvironment>;

function profile(record: UserProfileRecord): UserProfile {
  return {
    activityLevelCode: record.activityLevelCode,
    baselineWeightKg:
      record.baselineWeightKg === null
        ? null
        : canonicalPositiveDecimal(record.baselineWeightKg, "baselineWeightKg"),
    birthDate: record.birthDate,
    displayName: record.displayName,
    heightCm:
      record.heightCm === null ? null : canonicalPositiveDecimal(record.heightCm, "heightCm"),
    locale: record.locale,
    onboardingCompletedAt: record.onboardingCompletedAt?.toISOString() ?? null,
    revision: record.revision,
    sexAtBirth: record.sexAtBirth,
    timeZone: record.timeZone,
    unitSystem: record.unitSystem,
  };
}

function account(record: UserProfileRecord): AuthenticatedAccount {
  return {
    profile: profile(record),
    user: {
      email: record.email,
      emailVerified: record.emailVerified,
      id: record.userId,
    },
  };
}

function jsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error("Password parameters must be scalar JSON values");
    }
    output[key] = item;
  }
  return output;
}

export class DatabaseAuthRepository implements AuthRepository {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async register(input: Parameters<AuthRepository["register"]>[0]): Promise<AuthenticatedAccount> {
    try {
      const result = await registerPasswordAccount(this.#database, {
        displayName: input.displayName ?? null,
        email: input.email,
        passwordHash: input.passwordHash,
        passwordParameters: jsonObject(input.passwordParameters),
        passwordSalt: input.passwordSalt,
        timeZone: input.timeZone,
      });
      return account(result);
    } catch (error) {
      if (error instanceof AccountConflictError) throw new AccountAlreadyExistsError();
      throw error;
    }
  }

  async findPasswordCredential(normalizedEmail: string): Promise<PasswordCredential | null> {
    const credential = await findPasswordCredentialByEmail(this.#database, normalizedEmail);
    if (!credential) return null;
    const owner = await getUserProfile(this.#database, credential.userId);
    if (!owner) return null;
    return {
      account: account(owner),
      passwordHash: credential.passwordHash,
      passwordParameters: credential.passwordParameters,
      passwordSalt: credential.passwordSalt,
    };
  }

  async createSession(input: Parameters<AuthRepository["createSession"]>[0]): Promise<void> {
    try {
      await createSession(this.#database, input);
    } catch (error) {
      if (error instanceof DatabasePasswordCredentialStaleError) {
        throw new InvalidCredentialsError();
      }
      throw error;
    }
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedAccount | null> {
    const session = await findActiveSessionByTokenHash(this.#database, tokenHash, now);
    return session ? account(session.profile) : null;
  }

  async findPendingErasureRecoverySession(
    tokenHash: string,
    now: Date,
  ): Promise<Awaited<ReturnType<AuthRepository["findPendingErasureRecoverySession"]>>> {
    const session = await findPendingErasureRecoverySessionByTokenHash(this.#database, {
      now,
      tokenHash,
    });
    return session
      ? {
          account: account(session.profile),
          erasureJobId: session.erasureJobId,
          executeAfter: session.executeAfter,
        }
      : null;
  }

  async revokeSession(input: Parameters<AuthRepository["revokeSession"]>[0]): Promise<boolean> {
    return revokeSession(this.#database, input);
  }

  async createReauthenticationProof(
    input: Parameters<AuthRepository["createReauthenticationProof"]>[0],
  ): Promise<void> {
    try {
      await createReauthenticationProof(this.#database, {
        expectedPasswordHash: input.expectedPasswordHash,
        expiresAt: input.expiresAt.toISOString(),
        purpose: input.purpose,
        sessionTokenHash: input.sessionTokenHash,
        tokenHash: input.tokenHash,
        userId: input.userId,
      });
    } catch (error) {
      if (error instanceof DatabasePasswordCredentialStaleError) {
        throw new InvalidCredentialsError();
      }
      throw error;
    }
  }

  async issueEmailVerificationToken(
    input: Parameters<AuthRepository["issueEmailVerificationToken"]>[0],
  ): Promise<"already_verified" | "issued"> {
    return issueEmailVerificationToken(this.#database, input);
  }

  async confirmEmailVerificationToken(
    input: Parameters<AuthRepository["confirmEmailVerificationToken"]>[0],
  ): Promise<void> {
    try {
      await confirmEmailVerificationToken(this.#database, input);
    } catch (error) {
      if (error instanceof DatabaseEmailVerificationTokenExpiredError) {
        throw new EmailVerificationTokenExpiredError();
      }
      if (error instanceof DatabaseEmailVerificationTokenInvalidError) {
        throw new EmailVerificationTokenInvalidError();
      }
      throw error;
    }
  }

  async issuePasswordRecoveryToken(
    input: Parameters<AuthRepository["issuePasswordRecoveryToken"]>[0],
  ): Promise<"ineligible" | "issued"> {
    return issuePasswordRecoveryToken(this.#database, input);
  }

  async confirmPasswordRecoveryToken(
    input: Parameters<AuthRepository["confirmPasswordRecoveryToken"]>[0],
  ): Promise<void> {
    try {
      await confirmPasswordRecoveryToken(this.#database, {
        ...input,
        passwordParameters: jsonObject(input.passwordParameters),
      });
    } catch (error) {
      if (error instanceof DatabasePasswordRecoveryTokenExpiredError) {
        throw new PasswordRecoveryTokenExpiredError();
      }
      if (error instanceof DatabasePasswordRecoveryTokenInvalidError) {
        throw new PasswordRecoveryTokenInvalidError();
      }
      throw error;
    }
  }
}

export class DatabaseProfileService implements ProfileService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async get(userId: string): Promise<UserProfile | null> {
    const result = await getUserProfile(this.#database, userId);
    return result ? profile(result) : null;
  }

  async update(input: {
    readonly userId: string;
    readonly expectedRevision: string;
    readonly patch: UpdateUserProfileRequest;
  }): Promise<UserProfile> {
    try {
      const result = await updateUserProfile(this.#database, {
        expectedRevision: input.expectedRevision,
        patch: normalizeProfilePatch(input.patch),
        userId: input.userId,
      });
      return profile(result);
    } catch (error) {
      if (error instanceof ProfileRevisionConflictError) {
        throw new ProfileRevisionConflictServiceError();
      }
      if (error instanceof AccountNotFoundError || error instanceof RangeError) {
        throw new ProfileValidationServiceError();
      }
      throw error;
    }
  }
}

const unknownReasonKeys = [
  "not_reported",
  "not_analyzed",
  "not_applicable",
  "withheld",
] as const satisfies readonly NutrientUnknownReason[];

function unknownReasonCounts(value: JsonObject): Readonly<Record<NutrientUnknownReason, number>> {
  const allowed = new Set<string>(unknownReasonKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Unknown nutrient reason in persistence result");
  }
  const result = Object.fromEntries(
    unknownReasonKeys.map((key) => {
      const count = value[key] ?? 0;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("Invalid nutrient unknown reason count");
      }
      return [key, count];
    }),
  );
  return result as Readonly<Record<NutrientUnknownReason, number>>;
}

const MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH = 200;

function boundedNutrientAggregateAmount(
  value: Parameters<typeof canonicalNonNegativeDecimal>[0],
  label: string,
): string {
  const canonical = canonicalNonNegativeDecimal(value, label);
  if (canonical.length > MAX_NUTRIENT_AGGREGATE_OUTPUT_LENGTH) {
    throw new TypeError(`${label} exceeds the supported exact output bound`);
  }
  return canonical;
}

export function mapDiaryNutrientAggregate(
  record: DiaryNutrientAggregateRecord,
): DiaryNutrientAggregate {
  return {
    code: record.code,
    completeness: record.completeness,
    contributorCount: record.contributorCount,
    isExact: record.isExact,
    knownAmount: boundedNutrientAggregateAmount(record.knownAmount, "diary nutrient amount"),
    name: record.name,
    nutrientId: record.nutrientId,
    quantifiedCount: record.quantifiedCount,
    traceCount: record.traceCount,
    unit: record.unit,
    unknownCount: record.unknownCount,
    unknownReasonCounts: unknownReasonCounts(record.unknownReasons),
  };
}

function foodPortion(record: DiaryFoodEntryRecord): DiaryEntryPortion {
  if (!record.portion.servingId) return { grams: record.portion.amount, kind: "grams" };
  if (!record.portion.servingLabel) {
    throw new TypeError("A serving-based diary revision is missing its immutable serving label.");
  }
  return {
    amount: record.portion.amount,
    kind: "serving",
    servingId: record.portion.servingId,
    servingLabel: record.portion.servingLabel,
  };
}

function foodEntry(record: DiaryFoodEntryRecord): DiaryEntry {
  const common = {
    entryKind: "food",
    food: { brandName: record.food.brandName, name: record.food.name },
    foodVersionId: record.food.foodVersionId,
    id: record.id,
    localDate: record.localDate,
    localTime: record.localTime,
    mealSlot: record.mealSlot,
    nutrients: record.nutrients.map(mapDiaryNutrientAggregate),
    occurredAt: record.occurredAt,
    portion: foodPortion(record),
    position: record.position,
    resolvedGrams: record.portion.resolvedGrams,
    revision: record.currentRevision,
    recipe: null,
    note: record.note,
    recipeVersionId: null,
    timeZone: record.timeZone,
  } as const;
  if (record.foodProvenance.kind === "private_custom") {
    if (
      record.source !== null ||
      record.food.customFoodId !== record.foodProvenance.customFoodId ||
      record.food.customFoodVersionNumber !== record.foodProvenance.versionNumber ||
      !Number.isSafeInteger(record.foodProvenance.versionNumber) ||
      record.foodProvenance.versionNumber < 1
    ) {
      throw new TypeError("Private custom-food diary provenance is inconsistent");
    }
    return {
      ...common,
      source: null,
      foodProvenance: {
        customFoodId: record.foodProvenance.customFoodId,
        customFoodVersionNumber: record.foodProvenance.versionNumber,
        kind: "private_custom",
      },
    };
  }
  if (
    record.source === null ||
    record.food.customFoodId !== null ||
    record.food.customFoodVersionNumber !== null
  ) {
    throw new TypeError("Public food diary provenance is inconsistent");
  }
  const source = {
    attributionRequired: record.source.attributionRequired,
    attributionText: record.source.attributionText,
    code: record.source.code,
    displayName: record.source.displayName,
    licenseExpression: record.source.licenseExpression,
    releaseId: record.source.releaseId,
  };
  return { ...common, source, foodProvenance: { kind: "public", source } };
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recipeRetentionPolicy(record: DiaryRecipeEntryRecord): {
  readonly code: "identity-retention-default";
  readonly version: "1";
  readonly assumption: string;
} {
  if (
    record.recipe.retentionPolicy.code !== DEFAULT_RECIPE_RETENTION_POLICY.code ||
    record.recipe.retentionPolicy.version !== DEFAULT_RECIPE_RETENTION_POLICY.version
  ) {
    throw new TypeError("Unsupported recipe retention policy in diary snapshot");
  }
  const policy = record.recipe.calculationAssumptions.retentionPolicy;
  if (
    !isJsonRecord(policy) ||
    policy.code !== DEFAULT_RECIPE_RETENTION_POLICY.code ||
    policy.version !== DEFAULT_RECIPE_RETENTION_POLICY.version ||
    typeof policy.assumption !== "string" ||
    policy.assumption.length === 0
  ) {
    throw new TypeError("Recipe diary retention assumption is missing");
  }
  return {
    code: DEFAULT_RECIPE_RETENTION_POLICY.code,
    version: DEFAULT_RECIPE_RETENTION_POLICY.version,
    assumption: policy.assumption,
  };
}

function recipeDiaryEntry(record: DiaryRecipeEntryRecord): DiaryEntry {
  const servingPairPresent =
    record.recipe.servingCount !== null && record.recipe.servingLabel !== null;
  if (
    (record.recipe.servingCount === null) !== (record.recipe.servingLabel === null) ||
    (record.portion.inputUnit === "serving" && !servingPairPresent)
  ) {
    throw new TypeError("Recipe diary serving snapshot is inconsistent");
  }
  const versionNumber = record.recipe.versionNumber;
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new TypeError("Recipe diary version number is missing");
  }
  const sources = record.recipe.sources.map(recipeSource).sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.releaseId}`;
    const rightKey = `${right.code}\u0000${right.releaseId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    entryKind: "recipe",
    food: null,
    foodVersionId: null,
    id: record.id,
    localDate: record.localDate,
    localTime: record.localTime,
    mealSlot: record.mealSlot,
    nutrients: record.nutrients.map(mapDiaryNutrientAggregate),
    occurredAt: record.occurredAt,
    portion:
      record.portion.inputUnit === "g"
        ? { kind: "grams", grams: record.portion.amount }
        : {
            kind: "serving",
            amount: record.portion.amount,
            servingLabel: record.recipe.servingLabel as string,
          },
    position: record.position,
    recipe: {
      id: record.recipe.recipeId,
      name: record.recipe.name,
      versionNumber,
      yieldGrams: record.recipe.yieldGrams,
      yieldSource: record.recipe.yieldSource,
      servingCount: record.recipe.servingCount,
      servingLabel: record.recipe.servingLabel,
      calculationVersion: record.recipe.calculationVersion,
      retentionPolicy: recipeRetentionPolicy(record),
      warnings: record.recipe.warnings.map(recipeWarning),
    },
    recipeVersionId: record.recipe.recipeVersionId,
    resolvedGrams: record.portion.resolvedGrams,
    revision: record.currentRevision,
    source: null,
    note: record.note,
    sources,
    timeZone: record.timeZone,
  };
}

export function mapDiaryEntryRecord(record: DiaryEntryRecord): DiaryEntry {
  return record.kind === "food" ? foodEntry(record) : recipeDiaryEntry(record);
}

function day(record: DiaryDayRecord): DiaryDay {
  return {
    id: record.id,
    entries: record.entries.map(mapDiaryEntryRecord),
    localDate: record.localDate,
    revision: record.revision,
    status: record.status,
    timeZone: record.timeZone,
    totals: record.totals.map(mapDiaryNutrientAggregate),
    updatedAt: record.updatedAt,
  };
}

function mutation(result: DiaryMutationResult, deleted: boolean): DiaryMutationResponse {
  return {
    data: {
      affectedDays: result.days,
      entry: deleted ? null : mapDiaryEntryRecord(result.entry),
      replayed: result.replayed,
    },
  };
}

function mapDiaryPersistenceError(error: unknown): never {
  if (error instanceof DiaryNotFoundError) throw new DiaryNotFoundServiceError();
  if (error instanceof DiaryEntryRevisionConflictError) {
    throw new DiaryRevisionConflictServiceError();
  }
  if (error instanceof DiaryIdempotencyConflictError) {
    throw new DiaryIdempotencyConflictServiceError();
  }
  if (error instanceof DiaryLockedError) throw new DiaryLockedServiceError();
  if (error instanceof DiaryPageStaleError) throw new DiaryPageStaleServiceError();
  if (error instanceof DiaryTimeZoneChangedError) {
    throw new DiaryTimeZoneChangedServiceError();
  }
  if (error instanceof DiaryValidationError) throw new DiaryValidationServiceError();
  throw error;
}

export class DatabaseDiaryService implements DiaryService {
  readonly #database: AppDatabase;
  readonly #pageCursorCodec: DiaryPageCursorCodec;

  constructor(database: AppDatabase, options: { readonly cursorSecret: string | Uint8Array }) {
    this.#database = database;
    this.#pageCursorCodec = new DiaryPageCursorCodec(options.cursorSecret);
  }

  async getDay(input: Parameters<DiaryService["getDay"]>[0]): Promise<DiaryDay> {
    input.signal?.throwIfAborted();
    try {
      const result = await getDiaryDay(this.#database, input);
      input.signal?.throwIfAborted();
      return day(result);
    } catch (error) {
      mapDiaryPersistenceError(error);
    }
  }

  async getDayPage(
    input: Parameters<NonNullable<DiaryService["getDayPage"]>>[0],
  ): Promise<DiaryDayResponse> {
    input.signal?.throwIfAborted();
    const binding = {
      userId: input.userId,
      localDate: input.localDate,
      limit: input.limit,
    };
    let continuation: DiaryPageContinuationRecord | undefined;
    if (input.cursor !== undefined) {
      try {
        continuation = this.#pageCursorCodec.decode(input.cursor, binding);
      } catch (error) {
        if (error instanceof InvalidDiaryPageCursorError) {
          throw new DiaryPageCursorServiceError();
        }
        throw error;
      }
    }
    try {
      const result = await getDiaryDayPage(this.#database, {
        userId: input.userId,
        localDate: input.localDate,
        limit: input.limit,
        ...(continuation === undefined ? {} : { continuation }),
      });
      input.signal?.throwIfAborted();
      return {
        data: day(result.day),
        page: {
          nextCursor:
            result.page.next === null
              ? null
              : this.#pageCursorCodec.encode(result.page.next, binding),
          totalEntries: result.page.totalEntries,
        },
      };
    } catch (error) {
      mapDiaryPersistenceError(error);
    }
  }

  async createEntry(
    input: Parameters<DiaryService["createEntry"]>[0],
  ): Promise<DiaryMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await createFoodDiaryEntry(this.#database, {
        clientOperationId: input.clientOperationId,
        foodVersionId: input.entry.foodVersionId,
        mealSlot: input.entry.mealSlot,
        occurredAt: input.entry.occurredAt,
        ...(input.expectedProfileTimeZone === undefined
          ? {}
          : { expectedProfileTimeZone: input.expectedProfileTimeZone }),
        portion: input.entry.portion,
        ...(input.entry.position === undefined ? {} : { position: input.entry.position }),
        requestDigest: input.requestDigest,
        userId: input.userId,
      });
      input.signal?.throwIfAborted();
      return mutation(result, false);
    } catch (error) {
      mapDiaryPersistenceError(error);
    }
  }

  async updateEntry(
    input: Parameters<DiaryService["updateEntry"]>[0],
  ): Promise<DiaryMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await updateDiaryEntry(this.#database, {
        clientOperationId: input.clientOperationId,
        entryId: input.entryId,
        expectedEntryRevision: input.expectedRevision,
        ...(input.patch.mealSlot === undefined ? {} : { mealSlot: input.patch.mealSlot }),
        ...(input.patch.occurredAt === undefined ? {} : { occurredAt: input.patch.occurredAt }),
        ...(input.patch.portion === undefined ? {} : { portion: input.patch.portion }),
        ...(input.patch.position === undefined ? {} : { position: input.patch.position }),
        ...(input.patch.note === undefined ? {} : { note: input.patch.note }),
        requestDigest: input.requestDigest,
        userId: input.userId,
      });
      input.signal?.throwIfAborted();
      return mutation(result, false);
    } catch (error) {
      mapDiaryPersistenceError(error);
    }
  }

  async deleteEntry(
    input: Parameters<DiaryService["deleteEntry"]>[0],
  ): Promise<DiaryMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await deleteDiaryEntry(this.#database, {
        clientOperationId: input.clientOperationId,
        entryId: input.entryId,
        expectedEntryRevision: input.expectedRevision,
        requestDigest: input.requestDigest,
        userId: input.userId,
      });
      input.signal?.throwIfAborted();
      return mutation(result, true);
    } catch (error) {
      mapDiaryPersistenceError(error);
    }
  }
}

export function mapHydrationEntryRecord(record: HydrationEntryRecord): HydrationEntry {
  return {
    id: record.id,
    revision: record.revision,
    amountMilliliters: record.amountMilliliters,
    occurredAt: record.occurredAt,
    localDate: record.localDate,
    localTime: record.localTime,
    timeZone: record.timeZone,
    createdAt: record.createdAt,
  };
}

export function mapHydrationDayRecord(record: HydrationDayRecord): HydrationDay {
  return {
    localDate: record.localDate,
    timeZone: record.timeZone,
    revision: record.revision,
    entries: record.entries.map(mapHydrationEntryRecord),
    totalMilliliters: record.totalMilliliters,
    updatedAt: record.updatedAt,
  };
}

function hydrationMutation(result: HydrationMutationResult): HydrationMutationResponse {
  return {
    data: {
      replayed: result.replayed,
      entry: result.entry === null ? null : mapHydrationEntryRecord(result.entry),
      affectedDays: result.days,
    },
  };
}

export function mapHydrationPersistenceError(error: unknown): never {
  if (error instanceof HydrationNotFoundError) throw new HydrationNotFoundServiceError();
  if (error instanceof HydrationEntryRevisionConflictError) {
    throw new HydrationRevisionConflictServiceError();
  }
  if (error instanceof HydrationIdempotencyConflictError) {
    throw new HydrationIdempotencyConflictServiceError();
  }
  if (error instanceof HydrationTimeZoneChangedError) {
    throw new HydrationTimeZoneChangedServiceError();
  }
  if (error instanceof HydrationValidationError || error instanceof RangeError) {
    throw new HydrationValidationServiceError();
  }
  throw error;
}

export class DatabaseHydrationService implements HydrationService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async getDay(input: Parameters<HydrationService["getDay"]>[0]): Promise<HydrationDay> {
    input.signal?.throwIfAborted();
    try {
      const result = await getHydrationDay(this.#database, {
        userId: input.userId,
        localDate: input.localDate,
      });
      input.signal?.throwIfAborted();
      return mapHydrationDayRecord(result);
    } catch (error) {
      mapHydrationPersistenceError(error);
    }
  }

  async createEntry(
    input: Parameters<HydrationService["createEntry"]>[0],
  ): Promise<HydrationMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await createHydrationEntry(this.#database, {
        userId: input.userId,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        ...(input.expectedProfileTimeZone === undefined
          ? {}
          : { expectedProfileTimeZone: input.expectedProfileTimeZone }),
        amountMilliliters: input.entry.amountMilliliters,
        occurredAt: input.entry.occurredAt,
      });
      input.signal?.throwIfAborted();
      return hydrationMutation(result);
    } catch (error) {
      mapHydrationPersistenceError(error);
    }
  }

  async updateEntry(
    input: Parameters<HydrationService["updateEntry"]>[0],
  ): Promise<HydrationMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await updateHydrationEntry(this.#database, {
        userId: input.userId,
        entryId: input.entryId,
        expectedEntryRevision: input.expectedRevision,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        ...(input.patch.amountMilliliters === undefined
          ? {}
          : { amountMilliliters: input.patch.amountMilliliters }),
        ...(input.patch.occurredAt === undefined ? {} : { occurredAt: input.patch.occurredAt }),
      });
      input.signal?.throwIfAborted();
      return hydrationMutation(result);
    } catch (error) {
      mapHydrationPersistenceError(error);
    }
  }

  async deleteEntry(
    input: Parameters<HydrationService["deleteEntry"]>[0],
  ): Promise<HydrationMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await deleteHydrationEntry(this.#database, {
        userId: input.userId,
        entryId: input.entryId,
        expectedEntryRevision: input.expectedRevision,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
      });
      input.signal?.throwIfAborted();
      return hydrationMutation(result);
    } catch (error) {
      mapHydrationPersistenceError(error);
    }
  }
}

const recipeWarningCodes = new Set<RecipeWarningCode>([
  "ESTIMATED_YIELD",
  "PARTIAL_NUTRIENT_DATA",
  "RETENTION_FACTORS_DEFAULTED",
  "YIELD_ABOVE_INPUT_MASS",
  "YIELD_BELOW_HALF_INPUT_MASS",
]);

function recipeSource(record: RecipeSourceRecord) {
  return {
    attributionRequired: record.attributionRequired,
    attributionText: record.attributionText,
    code: record.code,
    displayName: record.displayName,
    licenseExpression: record.licenseExpression,
    releaseId: record.releaseId,
  };
}

function recipeWarning(record: RecipeWarningRecord) {
  if (!recipeWarningCodes.has(record.code as RecipeWarningCode)) {
    throw new TypeError("Unknown recipe warning code");
  }
  return {
    code: record.code as RecipeWarningCode,
    message: record.message,
    nutrientIds: record.nutrientIds,
  };
}

function scaleRecipeNutrient(
  nutrient: DiaryNutrientAggregate,
  factor: ReturnType<typeof decimal>,
): DiaryNutrientAggregate {
  return {
    ...nutrient,
    knownAmount: boundedNutrientAggregateAmount(
      decimal(nutrient.knownAmount).mul(factor),
      `${nutrient.code} recipe amount`,
    ),
  };
}

function recipeIngredient(
  record: RecipeIngredientRecord,
): Recipe["currentVersion"]["ingredients"][number] {
  if (record.kind === "food") {
    const portion: DiaryEntryPortion =
      record.portion.inputUnit === "g"
        ? { kind: "grams", grams: record.portion.amount }
        : record.portion.servingId && record.portion.servingLabel
          ? {
              kind: "serving",
              servingId: record.portion.servingId,
              amount: record.portion.amount,
              servingLabel: record.portion.servingLabel,
            }
          : (() => {
              throw new TypeError("Recipe food ingredient serving snapshot is incomplete");
            })();
    const common = {
      kind: "food",
      position: record.position,
      foodVersionId: record.food.foodVersionId,
      name: record.food.name,
      brandName: record.food.brandName,
      portion,
      resolvedGrams: record.portion.resolvedGrams,
      note: record.note,
    } as const;
    if (record.foodProvenance.kind === "private_custom") {
      if (record.source !== null) {
        throw new TypeError("Private custom recipe food must not contain public provenance");
      }
      const customFoodVersionNumber = Number(record.foodProvenance.customFoodVersionNumber);
      if (!Number.isSafeInteger(customFoodVersionNumber) || customFoodVersionNumber < 1) {
        throw new TypeError("Private custom recipe food version is invalid");
      }
      return {
        ...common,
        source: null,
        foodProvenance: {
          kind: "private_custom",
          customFoodId: record.foodProvenance.customFoodId,
          customFoodVersionNumber,
        },
      };
    }
    if (record.source === null) {
      throw new TypeError("Public recipe food provenance is incomplete");
    }
    const source = recipeSource(record.source);
    const provenanceSource = recipeSource(record.foodProvenance.source);
    if (
      record.source.foodSourceId !== record.foodProvenance.source.foodSourceId ||
      source.code !== provenanceSource.code ||
      source.releaseId !== provenanceSource.releaseId ||
      source.displayName !== provenanceSource.displayName ||
      source.licenseExpression !== provenanceSource.licenseExpression ||
      source.attributionRequired !== provenanceSource.attributionRequired ||
      source.attributionText !== provenanceSource.attributionText
    ) {
      throw new TypeError("Public recipe food provenance is inconsistent");
    }
    return { ...common, source, foodProvenance: { kind: "public", source } };
  }
  const nested = record.recipe;
  const versionNumber = Number(nested.versionNumber);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new TypeError("Nested recipe version number is missing");
  }
  return {
    kind: "recipe",
    position: record.position,
    recipeId: nested.recipeId,
    recipeVersionId: nested.recipeVersionId,
    versionNumber,
    name: nested.name,
    grams: record.grams,
    resolvedGrams: record.grams,
    note: record.note,
  };
}

export function mapRecipeRecord(record: RecipeRecord): Recipe {
  const yieldGrams = canonicalPositiveDecimal(record.currentVersion.yield.grams, "recipe yield");
  const ingredients = record.currentVersion.ingredients.map(recipeIngredient);
  const recomputedInputMass = ingredients.reduce(
    (total, ingredient) => total.plus(ingredient.resolvedGrams),
    decimal(0),
  );
  const inputMass = canonicalPositiveDecimal(
    record.currentVersion.inputMassGrams,
    "recipe input mass",
  );
  if (!recomputedInputMass.eq(inputMass)) {
    throw new TypeError("Recipe input mass does not match its ingredient snapshots");
  }
  const yieldRatio = canonicalPositiveDecimal(
    record.currentVersion.yield.ratioToInputMass,
    "recipe yield ratio",
  );
  if (!decimal(yieldGrams).div(inputMass).eq(yieldRatio)) {
    throw new TypeError("Recipe yield ratio does not match its persisted masses");
  }
  if (
    record.currentVersion.retentionPolicy.code !== DEFAULT_RECIPE_RETENTION_POLICY.code ||
    record.currentVersion.retentionPolicy.version !== DEFAULT_RECIPE_RETENTION_POLICY.version
  ) {
    throw new TypeError("Unsupported recipe retention policy");
  }
  const totals = record.currentVersion.nutrients.map(mapDiaryNutrientAggregate);
  const per100Factor = decimal(100).div(yieldGrams);
  const servingCount = record.currentVersion.servingCount;
  const sources = record.currentVersion.sources.map(recipeSource).sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.releaseId}`;
    const rightKey = `${right.code}\u0000${right.releaseId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const versionNumber = Number(record.currentVersion.versionNumber);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new TypeError("Recipe version number is invalid");
  }
  return {
    id: record.id,
    status: record.status,
    revision: record.currentRevision,
    currentVersion: {
      id: record.currentVersion.id,
      versionNumber,
      name: record.currentVersion.name,
      description: record.currentVersion.description,
      instructions: record.currentVersion.instructions,
      ingredients,
      finalYield: {
        grams: yieldGrams,
        source: record.currentVersion.yield.source,
        ratioToInputMass: yieldRatio,
      },
      inputMassGrams: inputMass,
      servingCount,
      servingLabel: record.currentVersion.servingLabel,
      nutrition: {
        totals,
        per100Grams: totals.map((nutrient) => scaleRecipeNutrient(nutrient, per100Factor)),
        perServing:
          servingCount === null
            ? null
            : totals.map((nutrient) => scaleRecipeNutrient(nutrient, decimal(1).div(servingCount))),
      },
      sources,
      retentionPolicy: DEFAULT_RECIPE_RETENTION_POLICY,
      calculationVersion: record.currentVersion.calculationVersion,
      warnings: record.currentVersion.warnings.map(recipeWarning),
      createdAt: record.currentVersion.createdAt,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function recipeSummary(recipe: Recipe): RecipeSummary {
  return {
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
  };
}

function recipeDraft(input: {
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly ingredients: readonly RecipeIngredientRequest[];
  readonly finalYield: { readonly grams: string; readonly source: "estimated" | "measured" };
  readonly servingCount: string | null;
  readonly servingLabel: string | null;
}): RecipeDraft {
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ingredients: input.ingredients,
    yield: input.finalYield,
    servingCount: input.servingCount,
    servingLabel: input.servingLabel,
  };
}

function mappedRecipeMutation(result: RecipeMutationResult): RecipeMutationResponse {
  return { data: { replayed: result.replayed, recipe: mapRecipeRecord(result.recipe) } };
}

export function mapRecipePersistenceError(error: unknown): never {
  if (error instanceof RecipeCursorError) throw new RecipeCursorServiceError();
  if (error instanceof RecipeNotFoundError) throw new RecipeNotFoundServiceError();
  if (error instanceof RecipeRevisionConflictError) {
    throw new RecipeRevisionConflictServiceError();
  }
  if (error instanceof RecipeIdempotencyConflictError) {
    throw new RecipeIdempotencyConflictServiceError();
  }
  if (error instanceof RecipeValidationError || error instanceof RangeError) {
    throw new RecipeValidationServiceError();
  }
  throw error;
}

export class DatabaseRecipeService implements RecipeService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async list(input: Parameters<RecipeService["list"]>[0]) {
    input.signal?.throwIfAborted();
    try {
      const result = await listRecipes(this.#database, {
        userId: input.userId,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      input.signal?.throwIfAborted();
      return {
        data: result.items.map(mapRecipeRecord).map(recipeSummary),
        page: { nextCursor: result.nextCursor },
      };
    } catch (error) {
      mapRecipePersistenceError(error);
    }
  }

  async get(input: Parameters<RecipeService["get"]>[0]): Promise<Recipe | null> {
    input.signal?.throwIfAborted();
    try {
      const result = await getRecipe(this.#database, {
        userId: input.userId,
        recipeId: input.recipeId,
      });
      input.signal?.throwIfAborted();
      return mapRecipeRecord(result);
    } catch (error) {
      if (error instanceof RecipeNotFoundError) return null;
      mapRecipePersistenceError(error);
    }
  }

  async create(input: Parameters<RecipeService["create"]>[0]): Promise<RecipeMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await createRecipe(this.#database, {
        userId: input.userId,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        recipe: recipeDraft(input.recipe),
      });
      input.signal?.throwIfAborted();
      return mappedRecipeMutation(result);
    } catch (error) {
      mapRecipePersistenceError(error);
    }
  }

  async revise(input: Parameters<RecipeService["revise"]>[0]): Promise<RecipeMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await reviseRecipe(this.#database, {
        userId: input.userId,
        recipeId: input.recipeId,
        expectedRevision: input.expectedRevision,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        recipe: recipeDraft(input.recipe),
      });
      input.signal?.throwIfAborted();
      return mappedRecipeMutation(result);
    } catch (error) {
      mapRecipePersistenceError(error);
    }
  }

  async log(input: Parameters<RecipeService["log"]>[0]): Promise<DiaryMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await createRecipeDiaryEntry(this.#database, {
        userId: input.userId,
        recipeId: input.recipeId,
        recipeVersionId: input.entry.recipeVersionId,
        portion: input.entry.portion,
        mealSlot: input.entry.mealSlot,
        occurredAt: input.entry.occurredAt,
        ...(input.entry.position === undefined ? {} : { position: input.entry.position }),
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
      });
      input.signal?.throwIfAborted();
      return mutation(result, false);
    } catch (error) {
      if (error instanceof RecipeNotFoundError) throw new RecipeNotFoundServiceError();
      if (error instanceof RecipeValidationError || error instanceof RangeError) {
        throw new RecipeValidationServiceError();
      }
      mapDiaryPersistenceError(error);
    }
  }
}

const nutrientCategories = new Set<NutrientCategory>([
  "energy",
  "macronutrient",
  "vitamin",
  "mineral",
  "amino-acid",
  "fatty-acid",
  "other",
]);

function goalDefinition(
  record: GoalNutrientDefinitionRecord,
  expectedEnergy: boolean,
): TargetableNutrient {
  const { category } = record;
  if (!nutrientCategories.has(category)) {
    throw new TypeError("Goal nutrient category is missing or unsupported");
  }
  if ((category === "energy") !== expectedEnergy) {
    throw new TypeError("Goal nutrient energy classification is inconsistent");
  }
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    unit: record.unit,
    category,
  };
}

function mapGoalEnergy(
  record: NutritionGoalEnergyRecord,
  effectiveDate: string,
): NutritionGoal["currentVersion"]["energy"] {
  if (record.mode === "fixed") {
    if (record.source.code !== "user-fixed" || record.source.version !== "1") {
      throw new TypeError("Fixed goal source is invalid");
    }
    return {
      mode: "fixed" as const,
      targetKcal: canonicalPositiveDecimal(record.targetKcal, "fixed goal target"),
      source: { code: "user-fixed" as const, version: "1" as const },
      rationale: record.rationale,
    };
  }
  const activityFactor = validatePalSelection(record.activityLevelCode, record.activityFactor);
  if (
    !Number.isSafeInteger(record.ageYears) ||
    record.ageYears < 19 ||
    record.ageYears > 78 ||
    (record.sexAtBirth !== "female" && record.sexAtBirth !== "male") ||
    !/^(?:0|[1-9][0-9]*)$/.test(record.profileRevision)
  ) {
    throw new TypeError("Derived goal profile snapshot is invalid");
  }
  const heightCm = canonicalPositiveDecimal(record.heightCm, "goal height snapshot");
  const weightKg = canonicalPositiveDecimal(record.weightKg, "goal weight snapshot");
  const bmrKcal = canonicalPositiveDecimal(record.bmrKcal, "goal BMR snapshot");
  const adjustmentKcal = canonicalNonNegativeDecimal(
    decimal(record.adjustmentKcal).abs(),
    "goal adjustment magnitude",
  );
  const canonicalAdjustment = decimal(record.adjustmentKcal).isNegative()
    ? `-${adjustmentKcal}`
    : adjustmentKcal;
  const expectedBmr = decimal(weightKg)
    .mul(10)
    .plus(decimal(heightCm).mul("6.25"))
    .minus(decimal(record.ageYears).mul(5))
    .plus(record.sexAtBirth === "male" ? 5 : -161);
  const targetKcal = canonicalPositiveDecimal(record.targetKcal, "derived goal target");
  if (
    !expectedBmr.eq(bmrKcal) ||
    !expectedBmr.mul(activityFactor).plus(canonicalAdjustment).eq(targetKcal) ||
    record.source.equation.code !== MIFFLIN_ST_JEOR_SOURCE.code ||
    record.source.equation.version !== MIFFLIN_ST_JEOR_SOURCE.version ||
    record.source.equation.url !== MIFFLIN_ST_JEOR_SOURCE.url ||
    record.source.activityPolicy.code !== PRODUCT_PAL_POLICY.code ||
    record.source.activityPolicy.version !== PRODUCT_PAL_POLICY.version ||
    record.source.activityPolicy.sourceUrl !== PRODUCT_PAL_POLICY.sourceUrl
  ) {
    throw new TypeError("Derived goal calculation snapshot is inconsistent");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    throw new TypeError("Derived goal effective date is invalid");
  }
  return {
    mode: "derived" as const,
    targetKcal,
    bmrKcal,
    ageYears: record.ageYears,
    heightCm,
    weightKg,
    sexAtBirth: record.sexAtBirth,
    profileRevision: record.profileRevision,
    activityLevelCode: record.activityLevelCode,
    activityFactor,
    adjustmentKcal: canonicalAdjustment,
    source: {
      equation: MIFFLIN_ST_JEOR_SOURCE,
      activityPolicy: {
        code: PRODUCT_PAL_POLICY.code,
        version: PRODUCT_PAL_POLICY.version,
        sourceUrl: PRODUCT_PAL_POLICY.sourceUrl,
      },
    },
    rationale: record.rationale,
  };
}

export function mapNutritionGoalRecord(record: NutritionGoalRecord): NutritionGoal {
  const versionNumber = Number(record.currentVersion.versionNumber);
  if (
    !Number.isSafeInteger(versionNumber) ||
    versionNumber < 1 ||
    record.currentRevision !== record.currentVersion.versionNumber ||
    record.status !== record.currentVersion.status ||
    record.effectiveFrom !== record.currentVersion.effectiveFrom ||
    record.effectiveTo !== record.currentVersion.effectiveTo ||
    record.currentVersion.calculationVersion.trim().length === 0
  ) {
    throw new TypeError("Nutrition goal head and immutable version are inconsistent");
  }
  const seen = new Set<string>();
  const nutrientTargets = record.currentVersion.targets.map((target) => {
    const definition = goalDefinition(target.nutrient, false);
    if (seen.has(definition.id)) throw new TypeError("Duplicate nutrition goal target");
    seen.add(definition.id);
    const minimum = target.minimumAmount === null ? null : decimal(target.minimumAmount);
    const desired = target.targetAmount === null ? null : decimal(target.targetAmount);
    const maximum = target.maximumAmount === null ? null : decimal(target.maximumAmount);
    if (
      (!minimum && !desired && !maximum) ||
      (minimum && desired && minimum.gt(desired)) ||
      (desired && maximum && desired.gt(maximum)) ||
      (minimum && maximum && minimum.gt(maximum))
    ) {
      throw new TypeError("Nutrition goal target thresholds are inconsistent");
    }
    return {
      definition,
      minimumAmount: minimum?.toFixed() ?? null,
      targetAmount: desired?.toFixed() ?? null,
      maximumAmount: maximum?.toFixed() ?? null,
      source: target.source,
      rationale: target.rationale,
    };
  });
  return {
    id: record.id,
    status: record.status,
    effectiveFrom: record.effectiveFrom,
    effectiveTo: record.effectiveTo,
    revision: record.currentRevision,
    currentVersion: {
      id: record.currentVersion.id,
      versionNumber,
      energy: mapGoalEnergy(record.currentVersion.energy, record.currentVersion.effectiveFrom),
      nutrientTargets,
      createdAt: record.currentVersion.createdAt,
    },
    notice: GENERAL_WELLNESS_NOTICE,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapGoalProgressRow(record: NutritionGoalTargetProgressRecord): GoalProgressRow {
  const knownAmount = canonicalNonNegativeDecimal(record.knownAmount, "goal progress amount");
  const expectedPercentage =
    record.target === null || decimal(record.target.amount).isZero()
      ? null
      : decimal(knownAmount).mul(100).div(record.target.amount).toFixed();
  const lowerBoundPercent = boundedGoalPercentage(
    record.target?.lowerBoundPercent ?? null,
    expectedPercentage,
  );
  return {
    nutrientId: record.nutrientId,
    code: record.code,
    name: record.name,
    unit: record.unit,
    knownAmount,
    amountInterpretation: record.amountInterpretation,
    completeness: record.completeness,
    minimum: record.minimum,
    target:
      record.target === null
        ? null
        : {
            ...record.target,
            lowerBoundPercent,
          },
    maximum: record.maximum,
  };
}

function boundedGoalPercentage(value: string | null, expected: string | null): string | null {
  if ((value === null) !== (expected === null)) {
    throw new TypeError("Goal progress percentage is inconsistent");
  }
  if (value === null || expected === null) return null;
  const canonical = canonicalNonNegativeDecimal(value, "goal progress percentage");
  if (
    canonical.length > MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH ||
    expected.length > MAX_GOAL_PROGRESS_PERCENTAGE_OUTPUT_LENGTH ||
    !decimal(canonical).eq(expected)
  ) {
    throw new TypeError("Goal progress percentage is inconsistent");
  }
  return canonical;
}

export function mapNutritionGoalProgressRecord(
  record: NutritionGoalProgressRecord,
): NutritionGoalProgressResponse {
  if (!record.timeZone || record.energy.code !== "energy" || record.energy.unit !== "kcal") {
    throw new TypeError("Goal progress energy definition is not canonical");
  }
  const goal = mapNutritionGoalRecord(record.goal);
  if (
    record.goalVersionId !== goal.currentVersion.id ||
    !decimal(record.energy.targetKcal).eq(goal.currentVersion.energy.targetKcal)
  ) {
    throw new TypeError("Goal progress is not pinned to its goal version");
  }
  const energyKnownAmount = canonicalNonNegativeDecimal(
    record.energy.knownAmount,
    "energy progress amount",
  );
  const expectedEnergyPercentage = decimal(energyKnownAmount)
    .mul(100)
    .div(record.energy.targetKcal);
  const energyLowerBoundPercent = boundedGoalPercentage(
    record.energy.lowerBoundPercent,
    expectedEnergyPercentage.toFixed(),
  );
  const energy: GoalProgressRow = {
    nutrientId: record.energy.nutrientId,
    code: record.energy.code,
    name: record.energy.name,
    unit: record.energy.unit,
    knownAmount: energyKnownAmount,
    amountInterpretation: record.energy.amountInterpretation,
    completeness: record.energy.completeness,
    minimum: null,
    target: {
      amount: record.energy.targetKcal,
      lowerBoundPercent: energyLowerBoundPercent,
      percentIsExact: record.energy.percentIsExact,
    },
    maximum: null,
  };
  return {
    data: {
      localDate: record.localDate,
      timeZone: record.timeZone,
      diaryRevision: record.diaryRevision,
      goal: { id: goal.id, versionId: goal.currentVersion.id, revision: goal.revision },
      energy,
      nutrients: record.targets.map(mapGoalProgressRow),
      notice: GENERAL_WELLNESS_NOTICE,
    },
  };
}

function mapGoalMutation(result: NutritionGoalMutationResult): NutritionGoalMutationResponse {
  return { data: { replayed: result.replayed, goal: mapNutritionGoalRecord(result.goal) } };
}

function mapGoalPersistenceError(error: unknown): never {
  if (error instanceof NutritionGoalNotFoundError) throw new GoalNotFoundServiceError();
  if (error instanceof NutritionGoalRevisionConflictError) {
    throw new GoalRevisionConflictServiceError();
  }
  if (error instanceof NutritionGoalIdempotencyConflictError) {
    throw new GoalIdempotencyConflictServiceError();
  }
  if (error instanceof NutritionGoalUnsupportedProfileError) {
    throw new GoalUnsupportedProfileServiceError();
  }
  if (error instanceof NutritionGoalPeriodConflictError) {
    throw new GoalPeriodConflictServiceError();
  }
  if (error instanceof NutritionGoalValidationError || error instanceof RangeError) {
    throw new GoalValidationServiceError();
  }
  throw error;
}

export class DatabaseGoalService implements GoalService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async getCurrent(input: Parameters<GoalService["getCurrent"]>[0]): Promise<NutritionGoal | null> {
    input.signal?.throwIfAborted();
    try {
      const result = await getCurrentNutritionGoal(this.#database, {
        userId: input.userId,
        localDate: input.localDate,
      });
      input.signal?.throwIfAborted();
      return result ? mapNutritionGoalRecord(result) : null;
    } catch (error) {
      mapGoalPersistenceError(error);
    }
  }

  async create(
    input: Parameters<GoalService["create"]>[0],
  ): Promise<NutritionGoalMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await createNutritionGoal(this.#database, {
        userId: input.userId,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        effectiveFrom: input.goal.effectiveFrom,
        energy: input.goal.energy,
        targets: input.goal.nutrientTargets,
      });
      input.signal?.throwIfAborted();
      return mapGoalMutation(result);
    } catch (error) {
      mapGoalPersistenceError(error);
    }
  }

  async revise(
    input: Parameters<GoalService["revise"]>[0],
  ): Promise<NutritionGoalMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await reviseNutritionGoal(this.#database, {
        userId: input.userId,
        goalId: input.goalId,
        expectedRevision: input.expectedRevision,
        clientOperationId: input.clientOperationId,
        requestDigest: input.requestDigest,
        energy: input.goal.energy,
        targets: input.goal.nutrientTargets,
      });
      input.signal?.throwIfAborted();
      return mapGoalMutation(result);
    } catch (error) {
      mapGoalPersistenceError(error);
    }
  }

  async progress(
    input: Parameters<GoalService["progress"]>[0],
  ): Promise<NutritionGoalProgressResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await getNutritionGoalProgress(this.#database, {
        userId: input.userId,
        localDate: input.localDate,
      });
      input.signal?.throwIfAborted();
      if (result) return mapNutritionGoalProgressRecord(result);
      const diary = await getDiaryDay(this.#database, {
        userId: input.userId,
        localDate: input.localDate,
      });
      input.signal?.throwIfAborted();
      return {
        data: {
          localDate: diary.localDate,
          timeZone: diary.timeZone,
          diaryRevision: diary.revision,
          goal: null,
          energy: null,
          nutrients: [],
          notice: GENERAL_WELLNESS_NOTICE,
        },
      };
    } catch (error) {
      mapGoalPersistenceError(error);
    }
  }

  async listTargetable(
    input: Parameters<GoalService["listTargetable"]>[0],
  ): Promise<TargetableNutrientListResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await listTargetableNutrients(this.#database, { userId: input.userId });
      input.signal?.throwIfAborted();
      return { data: result.map((definition) => goalDefinition(definition, false)) };
    } catch (error) {
      mapGoalPersistenceError(error);
    }
  }
}
