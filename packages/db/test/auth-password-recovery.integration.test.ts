import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  confirmPasswordRecoveryToken,
  createDatabase,
  createReauthenticationProof,
  createSession,
  findPasswordCredentialByEmail,
  getUserProfile,
  issueEmailVerificationToken,
  issuePasswordRecoveryToken,
  PasswordCredentialStaleError,
  PasswordRecoveryTokenExpiredError,
  PasswordRecoveryTokenInvalidError,
  registerPasswordAccount,
  runMigrations,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function setPasswordCredentialRevisionExactly(
  database: ReturnType<typeof createDatabase>,
  userId: string,
  revision: string,
): Promise<void> {
  await sql`alter table user_password_credential disable trigger user_password_credential_set_updated_at`.execute(
    database,
  );
  try {
    await sql`
      update user_password_credential
      set updated_at = ${revision}::timestamptz
      where user_id = ${userId}::uuid
    `.execute(database);
  } finally {
    await sql`alter table user_password_credential enable trigger user_password_credential_set_updated_at`.execute(
      database,
    );
  }
}

async function waitForPostgresLock(
  observer: ReturnType<typeof createDatabase>,
  applicationName: string,
  expectedWaitEvents: readonly string[],
  label: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const activity = await sql<{ wait_event: string | null; wait_event_type: string | null }>`
      select wait_event, wait_event_type
      from pg_stat_activity
      where application_name = ${applicationName}
        and datname = current_database()
        and state <> 'idle'
      order by query_start desc nulls last
      limit 1
    `.execute(observer);
    const waiter = activity.rows[0];
    if (
      waiter?.wait_event_type === "Lock" &&
      waiter.wait_event !== null &&
      expectedWaitEvents.includes(waiter.wait_event)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe ${label} waiting on the expected PostgreSQL lock`);
}

async function cleanupDatabaseTest(
  bootstrap: ReturnType<typeof createDatabase>,
  schemaName: string,
  databases: readonly ReturnType<typeof createDatabase>[],
): Promise<void> {
  const results = await Promise.allSettled(
    databases.map((database) => Promise.resolve().then(() => database.destroy())),
  );
  let failed = results.some((result) => result.status === "rejected");
  try {
    await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
  } catch {
    failed = true;
  }
  try {
    await bootstrap.destroy();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("Password-recovery integration cleanup failed");
}

describeDatabase("password-recovery persistence", { timeout: 20_000 }, () => {
  it("supersedes, resets, verifies, revokes, audits, expires, and keeps secrets excluded", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_recovery_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    try {
      await runMigrations(database);
      const email = `recovery-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "old-password-hash-material",
        passwordParameters: { algorithm: "old-test" },
        passwordSalt: "old-password-salt-material",
        timeZone: "America/Chicago",
      });
      const issuedAt = new Date("2035-08-15T00:00:00.000Z");
      const expiresAt = new Date("2035-08-15T01:00:00.000Z");
      const firstRawToken = randomBytes(32).toString("base64url");
      const secondRawToken = randomBytes(32).toString("base64url");
      const emailHash = sha256(email);

      await expect(
        issuePasswordRecoveryToken(database, {
          deliver: async () => undefined,
          emailHash,
          expiresAt,
          issuedAt,
          normalizedEmail: email,
          tokenHash: sha256(firstRawToken),
        }),
      ).resolves.toBe("issued");
      await expect(
        issuePasswordRecoveryToken(database, {
          deliver: async () => undefined,
          emailHash,
          expiresAt,
          issuedAt: new Date(issuedAt.getTime() + 1_000),
          normalizedEmail: email,
          tokenHash: sha256(secondRawToken),
        }),
      ).resolves.toBe("issued");

      const stored = await database
        .selectFrom("auth_action_token")
        .selectAll()
        .where("user_id", "=", owner.userId)
        .where("purpose", "=", "password_recovery")
        .execute();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        consumed_at: null,
        email_hash: emailHash,
        token_hash: sha256(secondRawToken),
      });
      expect(JSON.stringify(stored)).not.toContain(firstRawToken);
      expect(JSON.stringify(stored)).not.toContain(secondRawToken);
      await expect(
        confirmPasswordRecoveryToken(database, {
          confirmedAt: new Date("2035-08-15T00:05:00.000Z"),
          passwordHash: "superseded-password-hash",
          passwordParameters: { algorithm: "test" },
          passwordSalt: "superseded-password-salt",
          tokenHash: sha256(firstRawToken),
        }),
      ).rejects.toBeInstanceOf(PasswordRecoveryTokenInvalidError);

      const sessionHashes = [sha256("session-one"), sha256("session-two")];
      for (const tokenHash of sessionHashes) {
        await createSession(database, {
          expiresAt: new Date("2035-08-16T00:00:00.000Z"),
          tokenHash,
          userId: owner.userId,
        });
      }
      await createReauthenticationProof(database, {
        expectedPasswordHash: "old-password-hash-material",
        expiresAt: "2035-08-15T00:30:00.000Z",
        purpose: "account_export",
        sessionTokenHash: sessionHashes[0] ?? "",
        tokenHash: sha256("reauthentication-proof"),
        userId: owner.userId,
      });
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash,
        expiresAt: new Date("2035-08-16T00:00:00.000Z"),
        issuedAt,
        tokenHash: sha256("verification-token"),
        userId: owner.userId,
      });

      const newCredential = {
        passwordHash: "new-password-hash-material",
        passwordParameters: { N: 32_768, algorithm: "scrypt", p: 3, r: 8 },
        passwordSalt: "new-password-salt-material",
      } as const;
      const confirmedAt = new Date("2035-08-15T00:10:00.000Z");
      await expect(
        confirmPasswordRecoveryToken(database, {
          confirmedAt,
          requestId: "password-recovery-request-1",
          tokenHash: sha256(secondRawToken),
          ...newCredential,
        }),
      ).resolves.toBeUndefined();

      expect(await getUserProfile(database, owner.userId)).toMatchObject({ emailVerified: true });
      const credential = await database
        .selectFrom("user_password_credential")
        .select(["password_hash", "password_parameters", "password_salt"])
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(credential).toEqual({
        password_hash: newCredential.passwordHash,
        password_parameters: newCredential.passwordParameters,
        password_salt: newCredential.passwordSalt,
      });
      const actions = await database
        .selectFrom("auth_action_token")
        .select(["purpose", "consumed_at"])
        .where("user_id", "=", owner.userId)
        .execute();
      expect(actions).toEqual([{ consumed_at: confirmedAt, purpose: "password_recovery" }]);
      const sessions = await database
        .selectFrom("user_session")
        .select(["token_hash", "revoked_at"])
        .where("user_id", "=", owner.userId)
        .orderBy("token_hash")
        .execute();
      expect(sessions).toHaveLength(2);
      expect(
        sessions.every((session) => session.revoked_at?.getTime() === confirmedAt.getTime()),
      ).toBe(true);
      const proof = await database
        .selectFrom("reauthentication_proof")
        .select("revoked_at")
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(proof.revoked_at?.getTime()).toBe(confirmedAt.getTime());

      const audit = await database
        .selectFrom("audit_log")
        .select([
          "action",
          "actor_user_id",
          "after_state",
          "before_state",
          "context",
          "entity_id",
          "entity_type",
          "request_id",
          "subject_user_id",
        ])
        .where("action", "=", "auth.password_recovery.completed")
        .where("subject_user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(audit).toEqual({
        action: "auth.password_recovery.completed",
        actor_user_id: null,
        after_state: { emailVerified: true, passwordChanged: true },
        before_state: { emailVerified: false },
        context: { purpose: "password_recovery" },
        entity_id: owner.userId,
        entity_type: "user_password_credential",
        request_id: "password-recovery-request-1",
        subject_user_id: owner.userId,
      });
      const serializedAudit = JSON.stringify(audit);
      for (const secret of [
        email,
        emailHash,
        firstRawToken,
        secondRawToken,
        sha256(secondRawToken),
        newCredential.passwordHash,
        newCredential.passwordSalt,
      ]) {
        expect(serializedAudit).not.toContain(secret);
      }
      await expect(
        confirmPasswordRecoveryToken(database, {
          confirmedAt: new Date("2035-08-15T00:11:00.000Z"),
          requestId: "password-recovery-replay",
          tokenHash: sha256(secondRawToken),
          ...newCredential,
        }),
      ).rejects.toBeInstanceOf(PasswordRecoveryTokenInvalidError);

      const expiredRawToken = randomBytes(32).toString("base64url");
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash,
        expiresAt: new Date("2035-08-15T00:30:00.000Z"),
        issuedAt: new Date("2035-08-15T00:20:00.000Z"),
        normalizedEmail: email,
        tokenHash: sha256(expiredRawToken),
      });
      await expect(
        confirmPasswordRecoveryToken(database, {
          confirmedAt: new Date("2035-08-15T00:30:00.000Z"),
          passwordHash: "expired-password-hash-material",
          passwordParameters: { algorithm: "test" },
          passwordSalt: "expired-password-salt-material",
          tokenHash: sha256(expiredRawToken),
        }),
      ).rejects.toBeInstanceOf(PasswordRecoveryTokenExpiredError);
      const unchanged = await database
        .selectFrom("user_password_credential")
        .select("password_hash")
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(unchanged.password_hash).toBe(newCredential.passwordHash);
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [database]);
    }
  });

  it("hides ineligible accounts, preserves prior delivery, and fences confirmation", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_recovery_lock_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const runId = randomBytes(6).toString("hex");
    const issueName = `password_recovery_issue_${runId}`;
    const confirmName = `password_recovery_confirm_${runId}`;
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const issueDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), issueName),
      maxConnections: 1,
    });
    const confirmDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), confirmName),
      maxConnections: 1,
    });
    const observerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_observer_${runId}`,
      ),
      maxConnections: 1,
    });
    try {
      await runMigrations(database);
      const email = `recovery-lock-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "old-password-hash-material",
        passwordParameters: { algorithm: "old-test" },
        passwordSalt: "old-password-salt-material",
        timeZone: "America/Chicago",
      });
      const emailHash = sha256(email);
      const expiresAt = new Date("2035-08-15T01:00:00.000Z");
      const priorTokenHash = sha256(randomBytes(32).toString("base64url"));
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash,
        expiresAt,
        issuedAt: new Date("2035-08-15T00:00:00.000Z"),
        normalizedEmail: email,
        tokenHash: priorTokenHash,
      });
      await expect(
        issuePasswordRecoveryToken(database, {
          deliver: async () => Promise.reject(new Error("synthetic local delivery failure")),
          emailHash,
          expiresAt,
          issuedAt: new Date("2035-08-15T00:01:00.000Z"),
          normalizedEmail: email,
          tokenHash: sha256(randomBytes(32).toString("base64url")),
        }),
      ).rejects.toThrow("synthetic local delivery failure");
      expect(
        await database
          .selectFrom("auth_action_token")
          .select("token_hash")
          .where("user_id", "=", owner.userId)
          .where("purpose", "=", "password_recovery")
          .executeTakeFirstOrThrow(),
      ).toEqual({ token_hash: priorTokenHash });

      let ineligibleDelivered = false;
      await expect(
        issuePasswordRecoveryToken(database, {
          deliver: async () => {
            ineligibleDelivered = true;
          },
          emailHash: sha256("absent@example.invalid"),
          expiresAt,
          issuedAt: new Date("2035-08-15T00:02:00.000Z"),
          normalizedEmail: "absent@example.invalid",
          tokenHash: sha256(randomBytes(32).toString("base64url")),
        }),
      ).resolves.toBe("ineligible");
      expect(ineligibleDelivered).toBe(false);

      const credentiallessEmail = `recovery-no-credential-${randomUUID()}@example.invalid`;
      const credentiallessOwner = await registerPasswordAccount(database, {
        email: credentiallessEmail,
        passwordHash: "credentialless-old-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "credentialless-old-salt",
        timeZone: "America/Chicago",
      });
      const credentiallessToken = sha256(randomBytes(32).toString("base64url"));
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(credentiallessEmail),
        expiresAt,
        issuedAt: new Date("2035-08-15T00:02:00.000Z"),
        normalizedEmail: credentiallessEmail,
        tokenHash: credentiallessToken,
      });
      await database
        .deleteFrom("user_password_credential")
        .where("user_id", "=", credentiallessOwner.userId)
        .executeTakeFirstOrThrow();
      await expect(
        confirmPasswordRecoveryToken(database, {
          confirmedAt: new Date("2035-08-15T00:03:00.000Z"),
          passwordHash: "credentialless-new-hash",
          passwordParameters: { algorithm: "test" },
          passwordSalt: "credentialless-new-salt",
          tokenHash: credentiallessToken,
        }),
      ).rejects.toBeInstanceOf(PasswordRecoveryTokenInvalidError);

      const fencedRawToken = randomBytes(32).toString("base64url");
      const deliveryStarted = deferred();
      const releaseDelivery = deferred();
      const issuance = issuePasswordRecoveryToken(issueDatabase, {
        deliver: async () => {
          deliveryStarted.resolve();
          await releaseDelivery.promise;
        },
        emailHash,
        expiresAt,
        issuedAt: new Date("2035-08-15T00:03:00.000Z"),
        normalizedEmail: email,
        tokenHash: sha256(fencedRawToken),
      });
      await deliveryStarted.promise;
      const confirmation = confirmPasswordRecoveryToken(confirmDatabase, {
        confirmedAt: new Date("2035-08-15T00:04:00.000Z"),
        passwordHash: "fenced-password-hash-material",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "fenced-password-salt-material",
        tokenHash: sha256(fencedRawToken),
      });
      try {
        await waitForPostgresLock(
          observerDatabase,
          confirmName,
          ["advisory"],
          "password-recovery confirmation",
        );
      } finally {
        releaseDelivery.resolve();
        await Promise.allSettled([issuance, confirmation]);
      }
      await expect(issuance).resolves.toBe("issued");
      await expect(confirmation).resolves.toBeUndefined();
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [
        database,
        issueDatabase,
        confirmDatabase,
        observerDatabase,
      ]);
    }
  });

  it("allows exactly one overlapping confirmation to consume a recovery token", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_recovery_concurrent_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const runId = randomBytes(6).toString("hex");
    const winnerName = `password_recovery_winner_${runId}`;
    const loserName = `password_recovery_loser_${runId}`;
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const blockerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_account_blocker_${runId}`,
      ),
      maxConnections: 1,
    });
    const winnerDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), winnerName),
      maxConnections: 1,
    });
    const loserDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), loserName),
      maxConnections: 1,
    });
    const observerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_concurrent_observer_${runId}`,
      ),
      maxConnections: 1,
    });
    try {
      await runMigrations(database);
      const email = `recovery-concurrent-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "concurrent-old-password-hash",
        passwordParameters: { algorithm: "old-test" },
        passwordSalt: "concurrent-old-password-salt",
        timeZone: "America/Chicago",
      });
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = sha256(rawToken);
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(email),
        expiresAt: new Date("2035-08-15T01:00:00.000Z"),
        issuedAt: new Date("2035-08-15T00:00:00.000Z"),
        normalizedEmail: email,
        tokenHash,
      });

      const accountLocked = deferred();
      const releaseAccount = deferred();
      const blocker = blockerDatabase.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", owner.userId)
          .forShare()
          .executeTakeFirstOrThrow();
        accountLocked.resolve();
        await releaseAccount.promise;
      });
      await accountLocked.promise;

      const winnerCredential = {
        passwordHash: "concurrent-winning-password-hash",
        passwordParameters: { algorithm: "winning-test" },
        passwordSalt: "concurrent-winning-password-salt",
      } as const;
      const winner = confirmPasswordRecoveryToken(winnerDatabase, {
        confirmedAt: new Date("2035-08-15T00:05:00.000Z"),
        requestId: "password-recovery-concurrent-winner",
        tokenHash,
        ...winnerCredential,
      });
      let loser: Promise<void> | null = null;
      try {
        await waitForPostgresLock(
          observerDatabase,
          winnerName,
          ["transactionid", "tuple"],
          "winning password-recovery confirmation behind the account row",
        );
        loser = confirmPasswordRecoveryToken(loserDatabase, {
          confirmedAt: new Date("2035-08-15T00:05:01.000Z"),
          passwordHash: "concurrent-losing-password-hash",
          passwordParameters: { algorithm: "losing-test" },
          passwordSalt: "concurrent-losing-password-salt",
          tokenHash,
        });
        await waitForPostgresLock(
          observerDatabase,
          loserName,
          ["advisory"],
          "losing password-recovery confirmation behind the token fence",
        );
      } finally {
        releaseAccount.resolve();
        await Promise.allSettled([blocker, winner, ...(loser ? [loser] : [])]);
      }

      await expect(blocker).resolves.toBeUndefined();
      await expect(winner).resolves.toBeUndefined();
      if (!loser) throw new Error("Concurrent password-recovery loser was not started");
      await expect(loser).rejects.toBeInstanceOf(PasswordRecoveryTokenInvalidError);
      expect(
        await database
          .selectFrom("user_password_credential")
          .select(["password_hash", "password_parameters", "password_salt"])
          .where("user_id", "=", owner.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        password_hash: winnerCredential.passwordHash,
        password_parameters: winnerCredential.passwordParameters,
        password_salt: winnerCredential.passwordSalt,
      });
      expect(
        await database
          .selectFrom("auth_action_token")
          .select("consumed_at")
          .where("user_id", "=", owner.userId)
          .where("purpose", "=", "password_recovery")
          .where("token_hash", "=", tokenHash)
          .executeTakeFirstOrThrow(),
      ).toEqual({ consumed_at: expect.any(Date) });
      const audits = await database
        .selectFrom("audit_log")
        .select("request_id")
        .where("action", "=", "auth.password_recovery.completed")
        .where("subject_user_id", "=", owner.userId)
        .execute();
      expect(audits).toEqual([{ request_id: "password-recovery-concurrent-winner" }]);
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [
        database,
        blockerDatabase,
        winnerDatabase,
        loserDatabase,
        observerDatabase,
      ]);
    }
  });

  it("rejects old-password sessions and proofs that waited behind a completed reset", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_recovery_session_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const runId = randomBytes(6).toString("hex");
    const resetName = `password_recovery_reset_${runId}`;
    const staleSessionName = `password_recovery_stale_session_${runId}`;
    const staleProofName = `password_recovery_stale_proof_${runId}`;
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const blockerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_token_blocker_${runId}`,
      ),
      maxConnections: 1,
    });
    const resetDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), resetName),
      maxConnections: 1,
    });
    const staleSessionDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), staleSessionName),
      maxConnections: 1,
    });
    const staleProofDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), staleProofName),
      maxConnections: 1,
    });
    const observerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_session_observer_${runId}`,
      ),
      maxConnections: 1,
    });
    try {
      await runMigrations(database);
      const email = `recovery-session-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "old-session-password-hash",
        passwordParameters: { algorithm: "old-test" },
        passwordSalt: "old-session-password-salt",
        timeZone: "America/Chicago",
      });
      const oldCredential = await findPasswordCredentialByEmail(database, email);
      if (!oldCredential) throw new Error("Password-recovery credential fixture is missing");
      const oldSameMillisecondRevision = "2040-01-01T00:00:00.000100Z";
      await setPasswordCredentialRevisionExactly(
        database,
        owner.userId,
        oldSameMillisecondRevision,
      );
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = sha256(rawToken);
      const proofSessionTokenHash = sha256("session-for-stale-reauthentication-proof");
      await createSession(database, {
        expiresAt: new Date("2035-08-16T00:00:00.000Z"),
        tokenHash: proofSessionTokenHash,
        userId: owner.userId,
      });
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(email),
        expiresAt: new Date("2035-08-15T01:00:00.000Z"),
        issuedAt: new Date("2035-08-15T00:00:00.000Z"),
        normalizedEmail: email,
        tokenHash,
      });

      const tokenLocked = deferred();
      const releaseToken = deferred();
      const blocker = blockerDatabase.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("auth_action_token")
          .select("id")
          .where("purpose", "=", "password_recovery")
          .where("token_hash", "=", tokenHash)
          .forUpdate()
          .executeTakeFirstOrThrow();
        tokenLocked.resolve();
        await releaseToken.promise;
      });
      await tokenLocked.promise;

      const reset = confirmPasswordRecoveryToken(resetDatabase, {
        confirmedAt: new Date("2035-08-15T00:05:00.000Z"),
        passwordHash: "reset-session-password-hash",
        passwordParameters: { algorithm: "new-test" },
        passwordSalt: "reset-session-password-salt",
        tokenHash,
      });
      await waitForPostgresLock(
        observerDatabase,
        resetName,
        ["transactionid", "tuple"],
        "password reset behind the exact token row",
      );

      const staleSessionTokenHash = sha256("stale-session-after-password-reset");
      const staleSession = createSession(staleSessionDatabase, {
        expectedPasswordHash: oldCredential.passwordHash,
        expiresAt: new Date("2035-08-16T00:00:00.000Z"),
        tokenHash: staleSessionTokenHash,
        userId: owner.userId,
      });
      const staleProofTokenHash = sha256("stale-reauthentication-proof-after-password-reset");
      const staleProof = createReauthenticationProof(staleProofDatabase, {
        expectedPasswordHash: oldCredential.passwordHash,
        expiresAt: "2035-08-15T00:30:00.000Z",
        purpose: "account_export",
        sessionTokenHash: proofSessionTokenHash,
        tokenHash: staleProofTokenHash,
        userId: owner.userId,
      });
      try {
        await waitForPostgresLock(
          observerDatabase,
          staleSessionName,
          ["transactionid", "tuple"],
          "old-password session issuance behind password reset",
        );
        await waitForPostgresLock(
          observerDatabase,
          staleProofName,
          ["transactionid", "tuple"],
          "old-password reauthentication proof behind password reset",
        );
      } finally {
        releaseToken.resolve();
        await Promise.allSettled([blocker, reset, staleSession, staleProof]);
      }
      await expect(blocker).resolves.toBeUndefined();
      await expect(reset).resolves.toBeUndefined();
      await expect(staleSession).rejects.toBeInstanceOf(PasswordCredentialStaleError);
      await expect(staleProof).rejects.toBeInstanceOf(PasswordCredentialStaleError);
      expect(
        await database
          .selectFrom("user_session")
          .select("id")
          .where("token_hash", "=", staleSessionTokenHash)
          .executeTakeFirst(),
      ).toBeUndefined();

      const newSameMillisecondRevision = "2040-01-01T00:00:00.000900Z";
      expect(new Date(oldSameMillisecondRevision).getTime()).toBe(
        new Date(newSameMillisecondRevision).getTime(),
      );
      await setPasswordCredentialRevisionExactly(
        database,
        owner.userId,
        newSameMillisecondRevision,
      );
      const sameMillisecondSessionTokenHash = sha256("same-millisecond-stale-session");
      await expect(
        createSession(database, {
          expectedPasswordHash: oldCredential.passwordHash,
          expiresAt: new Date("2041-01-01T00:00:00.000Z"),
          tokenHash: sameMillisecondSessionTokenHash,
          userId: owner.userId,
        }),
      ).rejects.toBeInstanceOf(PasswordCredentialStaleError);
      expect(
        await database
          .selectFrom("user_session")
          .select("id")
          .where("token_hash", "=", sameMillisecondSessionTokenHash)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await database
          .selectFrom("reauthentication_proof")
          .select("id")
          .where("token_hash", "=", staleProofTokenHash)
          .executeTakeFirst(),
      ).toBeUndefined();
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [
        database,
        blockerDatabase,
        resetDatabase,
        staleSessionDatabase,
        staleProofDatabase,
        observerDatabase,
      ]);
    }
  });

  it("uses one post-lock completion instant for a session created after the caller clock", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_recovery_completion_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const runId = randomBytes(6).toString("hex");
    const blockerName = `password_recovery_completion_blocker_${runId}`;
    const resetName = `password_recovery_completion_reset_${runId}`;
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const blockerDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), blockerName),
      maxConnections: 1,
    });
    const resetDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), resetName),
      maxConnections: 1,
    });
    const observerDatabase = createDatabase({
      connectionString: withApplicationName(
        scopedUrl.toString(),
        `password_recovery_completion_observer_${runId}`,
      ),
      maxConnections: 1,
    });
    try {
      await runMigrations(database);
      const email = `recovery-completion-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "completion-old-password-hash",
        passwordParameters: { algorithm: "old-test" },
        passwordSalt: "completion-old-password-salt",
        timeZone: "America/Chicago",
      });
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = sha256(rawToken);
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(email),
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        issuedAt: new Date("1999-01-01T00:00:00.000Z"),
        normalizedEmail: email,
        tokenHash,
      });

      const accountLocked = deferred();
      const allowLateSession = deferred();
      const lateSessionTokenHash = sha256("session-created-after-caller-confirmed-at");
      const blocker = blockerDatabase.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("app_user")
          .select("id")
          .where("id", "=", owner.userId)
          .forShare()
          .executeTakeFirstOrThrow();
        accountLocked.resolve();
        await allowLateSession.promise;
        await transaction
          .insertInto("user_session")
          .values({
            created_at: "2040-01-01T00:00:00.000800Z",
            expires_at: new Date("2099-01-01T00:00:00.000Z"),
            token_hash: lateSessionTokenHash,
            user_id: owner.userId,
          })
          .executeTakeFirstOrThrow();
      });
      await accountLocked.promise;

      const callerConfirmedAt = "2040-01-01T00:00:00.000900Z";
      const reset = confirmPasswordRecoveryToken(resetDatabase, {
        confirmedAt: callerConfirmedAt,
        passwordHash: "completion-new-password-hash",
        passwordParameters: { algorithm: "new-test" },
        passwordSalt: "completion-new-password-salt",
        tokenHash,
      });
      try {
        await waitForPostgresLock(
          observerDatabase,
          resetName,
          ["transactionid", "tuple"],
          "password reset behind a pre-existing account reader",
        );
      } finally {
        allowLateSession.resolve();
        await Promise.allSettled([blocker, reset]);
      }
      await expect(blocker).resolves.toBeUndefined();
      await expect(reset).resolves.toBeUndefined();

      const exactTimes = await sql<{
        action_consumed_at: string | null;
        audit_occurred_at: string;
        email_verified_at: string | null;
        session_created_at: string;
        session_revoked_at: string | null;
      }>`
        select
          to_char(action.consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            as action_consumed_at,
          to_char(audit.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            as audit_occurred_at,
          to_char(account.email_verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            as email_verified_at,
          to_char(session.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            as session_created_at,
          to_char(session.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            as session_revoked_at
        from user_session session
        join auth_action_token action on action.user_id = session.user_id
          and action.token_hash = ${tokenHash}
        join app_user account on account.id = session.user_id
        join audit_log audit on audit.subject_user_id = session.user_id
          and audit.action = 'auth.password_recovery.completed'
        where session.token_hash = ${lateSessionTokenHash}
      `.execute(database);
      expect(exactTimes.rows).toEqual([
        {
          action_consumed_at: callerConfirmedAt,
          audit_occurred_at: callerConfirmedAt,
          email_verified_at: callerConfirmedAt,
          session_created_at: "2040-01-01T00:00:00.000800Z",
          session_revoked_at: callerConfirmedAt,
        },
      ]);
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [
        database,
        blockerDatabase,
        resetDatabase,
        observerDatabase,
      ]);
    }
  });
});
