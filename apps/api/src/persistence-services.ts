import type {
  AuthenticatedAccount,
  DiaryDay,
  DiaryEntry,
  DiaryEntryPortion,
  DiaryMutationResponse,
  DiaryNutrientAggregate,
  NutrientUnknownReason,
  UpdateUserProfileRequest,
  UserProfile,
} from "@nutrition-tracker/contracts";
import {
  AccountConflictError,
  AccountNotFoundError,
  type createDatabaseFromEnvironment,
  createFoodDiaryEntry,
  createSession,
  type DiaryDayRecord,
  type DiaryEntryRecord,
  DiaryEntryRevisionConflictError,
  DiaryIdempotencyConflictError,
  DiaryLockedError,
  type DiaryMutationResult,
  DiaryNotFoundError,
  type DiaryNutrientAggregateRecord,
  DiaryValidationError,
  deleteDiaryEntry,
  findActiveSessionByTokenHash,
  findPasswordCredentialByEmail,
  getDiaryDay,
  getUserProfile,
  type JsonObject,
  ProfileRevisionConflictError,
  registerPasswordAccount,
  revokeSession,
  type UserProfileRecord,
  updateFoodDiaryEntry,
  updateUserProfile,
} from "@nutrition-tracker/db";
import { canonicalPositiveDecimal } from "@nutrition-tracker/domain";
import {
  AccountAlreadyExistsError,
  type AuthRepository,
  type PasswordCredential,
} from "./modules/auth/auth-service.js";
import {
  DiaryIdempotencyConflictServiceError,
  DiaryLockedServiceError,
  DiaryNotFoundServiceError,
  DiaryRevisionConflictServiceError,
  type DiaryService,
  DiaryValidationServiceError,
} from "./modules/diary/diary.routes.js";
import {
  ProfileRevisionConflictServiceError,
  type ProfileService,
  ProfileValidationServiceError,
} from "./modules/profile/profile.routes.js";
import { normalizeProfilePatch } from "./modules/profile/profile-validation.js";

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
    await createSession(this.#database, input);
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<AuthenticatedAccount | null> {
    const session = await findActiveSessionByTokenHash(this.#database, tokenHash, now);
    return session ? account(session.profile) : null;
  }

  async revokeSession(input: Parameters<AuthRepository["revokeSession"]>[0]): Promise<boolean> {
    return revokeSession(this.#database, input);
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

export function mapDiaryNutrientAggregate(
  record: DiaryNutrientAggregateRecord,
): DiaryNutrientAggregate {
  return {
    code: record.code,
    completeness: record.completeness,
    contributorCount: record.contributorCount,
    isExact: record.isExact,
    knownAmount: record.knownAmount,
    name: record.name,
    nutrientId: record.nutrientId,
    quantifiedCount: record.quantifiedCount,
    traceCount: record.traceCount,
    unit: record.unit,
    unknownCount: record.unknownCount,
    unknownReasonCounts: unknownReasonCounts(record.unknownReasons),
  };
}

function portion(record: DiaryEntryRecord): DiaryEntryPortion {
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

function entry(record: DiaryEntryRecord): DiaryEntry {
  return {
    food: { brandName: record.food.brandName, name: record.food.name },
    foodVersionId: record.food.foodVersionId,
    id: record.id,
    localDate: record.localDate,
    localTime: record.localTime,
    mealSlot: record.mealSlot,
    nutrients: record.nutrients.map(mapDiaryNutrientAggregate),
    occurredAt: record.occurredAt,
    portion: portion(record),
    position: record.position,
    resolvedGrams: record.portion.resolvedGrams,
    revision: record.currentRevision,
    source: {
      attributionRequired: record.source.attributionRequired,
      attributionText: record.source.attributionText,
      code: record.source.code,
      displayName: record.source.displayName,
      licenseExpression: record.source.licenseExpression,
      releaseId: record.source.releaseId,
    },
    timeZone: record.timeZone,
  };
}

function day(record: DiaryDayRecord): DiaryDay {
  return {
    id: record.id,
    entries: record.entries.map(entry),
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
      entry: deleted ? null : entry(result.entry),
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
  if (error instanceof DiaryValidationError) throw new DiaryValidationServiceError();
  throw error;
}

export class DatabaseDiaryService implements DiaryService {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
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
      const result = await updateFoodDiaryEntry(this.#database, {
        clientOperationId: input.clientOperationId,
        entryId: input.entryId,
        expectedEntryRevision: input.expectedRevision,
        ...(input.patch.mealSlot === undefined ? {} : { mealSlot: input.patch.mealSlot }),
        ...(input.patch.occurredAt === undefined ? {} : { occurredAt: input.patch.occurredAt }),
        ...(input.patch.portion === undefined ? {} : { portion: input.patch.portion }),
        ...(input.patch.position === undefined ? {} : { position: input.patch.position }),
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
