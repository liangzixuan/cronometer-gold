import { createHash, randomUUID } from "node:crypto";

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

export class EmailVerificationTokenInvalidError extends Error {
  override readonly name = "EmailVerificationTokenInvalidError";
}

export class EmailVerificationTokenExpiredError extends Error {
  override readonly name = "EmailVerificationTokenExpiredError";
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
export interface PendingErasureRecoverySession extends AuthenticatedSession {
  readonly erasureJobId: string;
  readonly executeAfter: Date;
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

export interface IssueEmailVerificationTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly emailHash: string;
  readonly issuedAt: Date | string;
  readonly expiresAt: Date | string;
  /** Bounded local delivery. It runs while the account row lock is held. */
  readonly deliver: () => Promise<void>;
}

export interface ConfirmEmailVerificationTokenInput {
  readonly tokenHash: string;
  readonly confirmedAt: Date | string;
  readonly requestId?: string | null;
}

export type IssueEmailVerificationTokenResult = "already_verified" | "issued";

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

/**
 * Narrow recovery credential for an exact account-erasure POST replay only.
 * It must never be accepted by normal authentication middleware.
 */
export async function findPendingErasureRecoverySessionByTokenHash(
  database: Kysely<Database>,
  input: { readonly tokenHash: string; readonly now: Date | string },
): Promise<PendingErasureRecoverySession | null> {
  assertSha256(input.tokenHash, "tokenHash");
  const now = typeof input.now === "string" ? new Date(input.now) : input.now;
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a finite instant");
  const row = await database
    .selectFrom("user_session as session")
    .innerJoin("app_user as user", "user.id", "session.user_id")
    .innerJoin("account_erasure_job as erasure", "erasure.user_id", "user.id")
    .select([
      "session.id",
      "session.user_id",
      "session.expires_at",
      "session.last_used_at",
      "session.revoked_at",
      "session.created_at",
      "erasure.id as erasure_job_id",
      "erasure.execute_after",
    ])
    .where("session.token_hash", "=", input.tokenHash)
    .where("session.revoked_at", "is not", null)
    .where("session.expires_at", ">", now)
    .where("user.status", "=", "pending_deletion")
    .where("user.deleted_at", "is", null)
    .where("erasure.status", "in", ["queued", "failed", "running"])
    .whereRef("erasure.recovery_session_token_hash", "=", "session.token_hash")
    .where("erasure.execute_after", ">", now)
    .where("erasure.status_capability_expires_at", ">", now)
    .executeTakeFirst();
  if (!row) return null;
  const profile = await selectUserProfile(database, row.user_id, "pending_deletion");
  return profile
    ? {
        ...mapSession(row),
        erasureJobId: row.erasure_job_id,
        executeAfter: row.execute_after,
        profile,
      }
    : null;
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
  return database.transaction().execute(async (transaction) => {
    const revokedAt = input.revokedAt ?? sql<Date>`clock_timestamp()`;
    const result = await transaction
      .updateTable("user_session")
      .set({ revoked_at: revokedAt })
      .where("user_id", "=", input.userId)
      .where("token_hash", "=", input.tokenHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows === 1n)
      await transaction
        .updateTable("reauthentication_proof")
        .set({ revoked_at: revokedAt })
        .where("user_id", "=", input.userId)
        .where("session_token_hash", "=", input.tokenHash)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();
    return result.numUpdatedRows === 1n;
  });
}

/**
 * Hold the account lock across bounded local delivery, then replace the one
 * current credential in the same transaction. Delivery failure rolls the
 * transaction back, preserving the prior usable credential. Concurrent
 * requests serialize their SMTP acceptance and promotion order on this lock.
 */
export async function issueEmailVerificationToken(
  database: Kysely<Database>,
  input: IssueEmailVerificationTokenInput,
): Promise<IssueEmailVerificationTokenResult> {
  assertSha256(input.tokenHash, "tokenHash");
  assertSha256(input.emailHash, "emailHash");
  const issuedAt = canonicalInstant(input.issuedAt, "issuedAt");
  const expiresAt = canonicalInstant(input.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) throw new Error("expiresAt must be after issuedAt");

  return database.transaction().execute(async (transaction) => {
    await acquireEmailVerificationTokenFence(transaction, input.tokenHash);
    const account = await transaction
      .selectFrom("app_user")
      .select(["email", "email_verified_at"])
      .where("id", "=", input.userId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!account) throw new AccountNotFoundError("Account not found");
    if (account.email_verified_at !== null) return "already_verified";
    if (sha256(account.email) !== input.emailHash) {
      throw new AccountNotFoundError("Account email changed");
    }

    await input.deliver();
    await transaction
      .insertInto("auth_action_token")
      .values({
        consumed_at: null,
        created_at: issuedAt,
        email_hash: input.emailHash,
        expires_at: expiresAt,
        purpose: "email_verification",
        token_hash: input.tokenHash,
        user_id: input.userId,
      })
      .onConflict((conflict) =>
        conflict.columns(["user_id", "purpose"]).doUpdateSet({
          consumed_at: null,
          created_at: issuedAt,
          email_hash: input.emailHash,
          expires_at: expiresAt,
          token_hash: input.tokenHash,
        }),
      )
      .execute();
    return "issued";
  });
}

/**
 * Consume one verification credential and mark the same locked account as
 * verified. Unknown, replayed, inactive, deleted, or email-stale credentials
 * all share the invalid-token result.
 */
export async function confirmEmailVerificationToken(
  database: Kysely<Database>,
  input: ConfirmEmailVerificationTokenInput,
): Promise<void> {
  assertSha256(input.tokenHash, "tokenHash");
  const confirmedAt = canonicalInstant(input.confirmedAt, "confirmedAt");
  if (input.requestId !== undefined && input.requestId !== null) {
    if (input.requestId.length < 1 || input.requestId.length > 200) {
      throw new Error("requestId is invalid");
    }
  }

  await database.transaction().execute(async (transaction) => {
    // This transaction fence closes the post-SMTP/pre-commit lookup gap. It is
    // not a row lock; after it, every path still takes the account row first.
    await acquireEmailVerificationTokenFence(transaction, input.tokenHash);
    // Discover the owner without taking a row lock, then lock account first.
    // Account erasure and token replacement use the same account -> token row order.
    const candidate = await transaction
      .selectFrom("auth_action_token")
      .select("user_id")
      .where("purpose", "=", "email_verification")
      .where("token_hash", "=", input.tokenHash)
      .executeTakeFirst();
    if (!candidate) throw new EmailVerificationTokenInvalidError("Verification token is invalid");

    const account = await transaction
      .selectFrom("app_user")
      .select(["id", "email", "email_verified_at"])
      .where("id", "=", candidate.user_id)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!account) throw new EmailVerificationTokenInvalidError("Verification token is invalid");

    const token = await transaction
      .selectFrom("auth_action_token")
      .select(["email_hash", "expires_at", "consumed_at"])
      .where("user_id", "=", account.id)
      .where("purpose", "=", "email_verification")
      .where("token_hash", "=", input.tokenHash)
      .forUpdate()
      .executeTakeFirst();
    if (!token || token.consumed_at !== null || token.email_hash !== sha256(account.email)) {
      throw new EmailVerificationTokenInvalidError("Verification token is invalid");
    }
    if (token.expires_at <= confirmedAt) {
      throw new EmailVerificationTokenExpiredError("Verification token is expired");
    }

    const consumed = await transaction
      .updateTable("auth_action_token")
      .set({ consumed_at: confirmedAt })
      .where("user_id", "=", account.id)
      .where("purpose", "=", "email_verification")
      .where("token_hash", "=", input.tokenHash)
      .where("consumed_at", "is", null)
      .executeTakeFirst();
    if (consumed.numUpdatedRows !== 1n) {
      throw new EmailVerificationTokenInvalidError("Verification token is invalid");
    }

    if (account.email_verified_at === null) {
      await transaction
        .updateTable("app_user")
        .set({ email_verified_at: confirmedAt })
        .where("id", "=", account.id)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("audit_log")
        .values({
          action: "auth.email_verification.confirmed",
          actor_user_id: null,
          after_state: { emailVerified: true },
          before_state: { emailVerified: false },
          context: { purpose: "email_verification" },
          entity_id: account.id,
          entity_type: "app_user",
          occurred_at: confirmedAt,
          reason: "user_confirmed_link",
          request_id: input.requestId ?? null,
          sensitivity: "security",
          source_ip: null,
          subject_user_id: account.id,
          user_agent: null,
        })
        .execute();
    }
  });
}

async function acquireEmailVerificationTokenFence(
  database: Kysely<Database>,
  tokenHash: string,
): Promise<void> {
  // A 64-bit-prefix collision can only serialize unrelated attempts. Full
  // token hashes and all account/email/state invariants are still rechecked.
  const lockKey = BigInt.asIntN(64, BigInt(`0x${tokenHash.slice(0, 16)}`)).toString();
  await sql`select pg_advisory_xact_lock(${lockKey}::bigint)`.execute(database);
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
  requiredStatus: "active" | "pending_deletion" = "active",
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
    .where("user.status", "=", requiredStatus)
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalInstant(value: Date | string, field: string): Date {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error(`${field} must be a finite instant`);
  return instant;
}

function canonicalRevision(value: bigint | number | string): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("revision must be non-negative");
  return text;
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
