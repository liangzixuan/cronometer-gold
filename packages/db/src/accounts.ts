import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import type { Database, JsonObject, SexAtBirth, UnitSystem } from "./types.js";

export class AccountConflictError extends Error {
  override readonly name = "AccountConflictError";
}

export class AccountNotFoundError extends Error {
  override readonly name = "AccountNotFoundError";
}

export class ProfileRevisionConflictError extends Error {
  override readonly name = "ProfileRevisionConflictError";
}

export interface UserProfileRecord {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly displayName: string | null;
  readonly birthDate: string | null;
  readonly sexAtBirth: SexAtBirth;
  readonly heightCm: string | null;
  readonly baselineWeightKg: string | null;
  readonly activityLevelCode: string | null;
  readonly locale: string;
  readonly timeZone: string;
  readonly unitSystem: UnitSystem;
  readonly preferences: JsonObject;
  readonly revision: string;
  readonly onboardingCompletedAt: Date | null;
  readonly wellnessDisclaimerAcknowledgedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PasswordCredentialRecord {
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly passwordParameters: JsonObject;
}

export interface RegisterPasswordAccountInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly passwordParameters: JsonObject;
  readonly timeZone: string;
  readonly locale?: string;
  readonly displayName?: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface AuthenticatedSession extends SessionRecord {
  readonly profile: UserProfileRecord;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date | string;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

export interface UpdateUserProfileInput {
  readonly userId: string;
  readonly expectedRevision: bigint | number | string;
  readonly patch: {
    readonly displayName?: string | null;
    readonly birthDate?: string | null;
    readonly sexAtBirth?: SexAtBirth;
    readonly heightCm?: string | null;
    readonly baselineWeightKg?: string | null;
    readonly activityLevelCode?: string | null;
    readonly locale?: string;
    readonly timeZone?: string;
    readonly unitSystem?: UnitSystem;
    readonly preferences?: JsonObject;
    readonly onboardingCompletedAt?: Date | string | null;
    readonly wellnessDisclaimerAcknowledgedAt?: Date | string | null;
  };
}

export async function registerPasswordAccount(
  database: Kysely<Database>,
  input: RegisterPasswordAccountInput,
): Promise<UserProfileRecord> {
  const email = normalizeEmail(input.email);
  validateDisplayName(input.displayName);
  const userId = randomUUID();
  try {
    return await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("app_user")
        .values({ auth_subject: `password:${userId}`, email, id: userId })
        .execute();
      await transaction
        .insertInto("user_password_credential")
        .values({
          password_hash: input.passwordHash,
          password_parameters: input.passwordParameters,
          password_salt: input.passwordSalt,
          user_id: userId,
        })
        .execute();
      await transaction
        .insertInto("user_profile")
        .values({
          display_name: input.displayName ?? null,
          locale: input.locale ?? "en-US",
          time_zone: input.timeZone,
          user_id: userId,
        })
        .execute();
      const profile = await selectUserProfile(transaction, userId);
      if (!profile) throw new Error("registered profile was not persisted");
      return profile;
    });
  } catch (error) {
    if (isPostgresError(error, "23505")) {
      throw new AccountConflictError("An account already exists for that email");
    }
    throw error;
  }
}

export async function findPasswordCredentialByEmail(
  database: Kysely<Database>,
  email: string,
): Promise<PasswordCredentialRecord | null> {
  const row = await database
    .selectFrom("app_user as user")
    .innerJoin("user_password_credential as credential", "credential.user_id", "user.id")
    .select([
      "user.id as user_id",
      "user.email",
      "user.email_verified_at",
      "credential.password_hash",
      "credential.password_salt",
      "credential.password_parameters",
    ])
    .where("user.email", "=", normalizeEmail(email))
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  return row
    ? {
        email: row.email,
        passwordHash: row.password_hash,
        passwordParameters: row.password_parameters,
        passwordSalt: row.password_salt,
        userId: row.user_id,
      }
    : null;
}

export async function createSession(
  database: Kysely<Database>,
  input: CreateSessionInput,
): Promise<SessionRecord> {
  assertSha256(input.tokenHash, "tokenHash");
  return database.transaction().execute(async (transaction) => {
    // Serialize session issuance with account disable/delete transitions. A
    // disable that commits first makes this read fail; a session that locks
    // first is durably issued before the later disable.
    const user = await transaction
      .selectFrom("app_user")
      .select("id")
      .where("id", "=", input.userId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!user) throw new AccountNotFoundError("Account not found");
    const row = await transaction
      .insertInto("user_session")
      .values({
        expires_at: input.expiresAt,
        ip_address: input.ipAddress ?? null,
        token_hash: input.tokenHash,
        user_agent: input.userAgent ?? null,
        user_id: input.userId,
      })
      .returning(["id", "user_id", "expires_at", "last_used_at", "revoked_at", "created_at"])
      .executeTakeFirstOrThrow();
    return mapSession(row);
  });
}

export async function findActiveSessionByTokenHash(
  database: Kysely<Database>,
  tokenHash: string,
  now: Date | string = new Date(),
): Promise<AuthenticatedSession | null> {
  assertSha256(tokenHash, "tokenHash");
  const session = await database
    .selectFrom("user_session as session")
    .innerJoin("app_user as user", "user.id", "session.user_id")
    .select([
      "session.id",
      "session.user_id",
      "session.expires_at",
      "session.last_used_at",
      "session.revoked_at",
      "session.created_at",
    ])
    .where("session.token_hash", "=", tokenHash)
    .where("session.revoked_at", "is", null)
    .where("session.expires_at", ">", typeof now === "string" ? new Date(now) : now)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  if (!session) return null;
  const profile = await selectUserProfile(database, session.user_id);
  return profile ? { ...mapSession(session), profile } : null;
}

export async function revokeSession(
  database: Kysely<Database>,
  input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly revokedAt?: Date | string;
  },
): Promise<boolean> {
  assertSha256(input.tokenHash, "tokenHash");
  const result = await database
    .updateTable("user_session")
    .set({ revoked_at: input.revokedAt ?? sql<Date>`clock_timestamp()` })
    .where("user_id", "=", input.userId)
    .where("token_hash", "=", input.tokenHash)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function getUserProfile(
  database: Kysely<Database>,
  userId: string,
): Promise<UserProfileRecord | null> {
  return selectUserProfile(database, userId);
}

export async function updateUserProfile(
  database: Kysely<Database>,
  input: UpdateUserProfileInput,
): Promise<UserProfileRecord> {
  const expectedRevision = canonicalRevision(input.expectedRevision);
  const patch = input.patch;
  if (Object.keys(patch).length === 0) throw new Error("Profile patch must not be empty");
  validateDisplayName(patch.displayName);
  validateBirthDate(patch.birthDate);
  validateActivityLevelCode(patch.activityLevelCode);
  const values = {
    ...(patch.activityLevelCode !== undefined
      ? { activity_level_code: patch.activityLevelCode }
      : {}),
    ...(patch.baselineWeightKg !== undefined ? { baseline_weight_kg: patch.baselineWeightKg } : {}),
    ...(patch.birthDate !== undefined ? { birth_date: patch.birthDate } : {}),
    ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
    ...(patch.heightCm !== undefined ? { height_cm: patch.heightCm } : {}),
    ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
    ...(patch.onboardingCompletedAt !== undefined
      ? { onboarding_completed_at: patch.onboardingCompletedAt }
      : {}),
    ...(patch.preferences !== undefined ? { preferences: patch.preferences } : {}),
    ...(patch.sexAtBirth !== undefined ? { sex_at_birth: patch.sexAtBirth } : {}),
    ...(patch.timeZone !== undefined ? { time_zone: patch.timeZone } : {}),
    ...(patch.unitSystem !== undefined ? { unit_system: patch.unitSystem } : {}),
    ...(patch.wellnessDisclaimerAcknowledgedAt !== undefined
      ? { wellness_disclaimer_acknowledged_at: patch.wellnessDisclaimerAcknowledgedAt }
      : {}),
    revision: (BigInt(expectedRevision) + 1n).toString(),
  };
  return database.transaction().execute(async (transaction) => {
    const activeAccount = await transaction
      .selectFrom("app_user")
      .select("id")
      .where("id", "=", input.userId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!activeAccount) throw new AccountNotFoundError("Account not found");

    const result = await transaction
      .updateTable("user_profile")
      .set(values)
      .where("user_id", "=", input.userId)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      const exists = await transaction
        .selectFrom("user_profile")
        .select("user_id")
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      if (!exists) throw new AccountNotFoundError("Account not found");
      throw new ProfileRevisionConflictError("Profile revision does not match");
    }
    const profile = await selectUserProfile(transaction, input.userId);
    if (!profile) throw new AccountNotFoundError("Account not found");
    return profile;
  });
}

async function selectUserProfile(
  database: Kysely<Database>,
  userId: string,
): Promise<UserProfileRecord | null> {
  const row = await database
    .selectFrom("user_profile as profile")
    .innerJoin("app_user as user", "user.id", "profile.user_id")
    .select([
      "profile.user_id",
      "user.email",
      "user.email_verified_at",
      "profile.display_name",
      "profile.birth_date",
      "profile.sex_at_birth",
      "profile.height_cm",
      "profile.baseline_weight_kg",
      "profile.activity_level_code",
      "profile.locale",
      "profile.time_zone",
      "profile.unit_system",
      "profile.preferences",
      "profile.revision",
      "profile.onboarding_completed_at",
      "profile.wellness_disclaimer_acknowledged_at",
      "profile.created_at",
      "profile.updated_at",
    ])
    .where("profile.user_id", "=", userId)
    .where("user.status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
  return row
    ? {
        activityLevelCode: row.activity_level_code,
        baselineWeightKg: row.baseline_weight_kg,
        birthDate: normalizeDateOnly(row.birth_date),
        createdAt: row.created_at,
        displayName: row.display_name,
        email: row.email,
        emailVerified: row.email_verified_at !== null,
        emailVerifiedAt: row.email_verified_at,
        heightCm: row.height_cm,
        locale: row.locale,
        onboardingCompletedAt: row.onboarding_completed_at,
        preferences: row.preferences,
        revision: row.revision,
        sexAtBirth: row.sex_at_birth,
        timeZone: row.time_zone,
        unitSystem: row.unit_system,
        updatedAt: row.updated_at,
        userId: row.user_id,
        wellnessDisclaimerAcknowledgedAt: row.wellness_disclaimer_acknowledged_at,
      }
    : null;
}

function mapSession(row: {
  readonly id: string;
  readonly user_id: string;
  readonly expires_at: Date;
  readonly last_used_at: Date;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}): SessionRecord {
  return {
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    userId: row.user_id,
  };
}

function normalizeEmail(email: string): string {
  const normalized = email.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
      normalized,
    )
  ) {
    throw new Error("email is invalid");
  }
  return normalized;
}

function validateDisplayName(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if (
    value.trim().length === 0 ||
    [...value].length > 100 ||
    Buffer.byteLength(value, "utf8") > 300
  ) {
    throw new Error("displayName is invalid or too long");
  }
}

function validateBirthDate(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error("birthDate is invalid");
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("birthDate is invalid");
  }
}

function validateActivityLevelCode(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if ([...value].length > 64 || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("activityLevelCode is invalid");
  }
}

function normalizeDateOnly(value: unknown): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function assertSha256(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 hex`);
}

function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("revision must be non-negative");
  return text;
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
