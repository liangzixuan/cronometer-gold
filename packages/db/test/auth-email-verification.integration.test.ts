import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  confirmEmailVerificationToken,
  createDatabase,
  EmailVerificationTokenExpiredError,
  EmailVerificationTokenInvalidError,
  getUserProfile,
  issueEmailVerificationToken,
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

async function waitForPostgresLock(
  observer: ReturnType<typeof createDatabase>,
  applicationName: string,
  expectedWaitEvents: readonly string[],
  label: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const activity = await sql<{
      wait_event: string | null;
      wait_event_type: string | null;
    }>`
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
  const poolResults = await Promise.allSettled(
    databases.map((database) => Promise.resolve().then(() => database.destroy())),
  );
  let cleanupFailed = poolResults.some((result) => result.status === "rejected");
  try {
    await sql`drop schema ${sql.id(schemaName)} cascade`.execute(bootstrap);
  } catch {
    cleanupFailed = true;
  }
  try {
    await bootstrap.destroy();
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) throw new Error("Email-verification integration cleanup failed");
}

describeDatabase("email-verification persistence", { timeout: 15_000 }, () => {
  it("replaces, binds, expires, atomically consumes, audits, and cascades credential rows", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_email_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    try {
      await runMigrations(database);
      const email = `verify-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "$argon2id$email-verification-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "email-verification-fixture-salt",
        timeZone: "America/Chicago",
      });
      const issuedAt = new Date("2035-08-15T00:00:00.000Z");
      const expiresAt = new Date("2035-08-16T00:00:00.000Z");
      const firstRawToken = randomBytes(32).toString("base64url");
      const secondRawToken = randomBytes(32).toString("base64url");

      await expect(
        issueEmailVerificationToken(database, {
          deliver: async () => undefined,
          emailHash: sha256(email),
          expiresAt,
          issuedAt,
          tokenHash: sha256(firstRawToken),
          userId: owner.userId,
        }),
      ).resolves.toBe("issued");
      await expect(
        issueEmailVerificationToken(database, {
          deliver: async () => undefined,
          emailHash: sha256(email),
          expiresAt,
          issuedAt: new Date(issuedAt.getTime() + 1_000),
          tokenHash: sha256(secondRawToken),
          userId: owner.userId,
        }),
      ).resolves.toBe("issued");

      const stored = await database
        .selectFrom("auth_action_token")
        .selectAll()
        .where("user_id", "=", owner.userId)
        .execute();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.consumed_at === null).toBe(true);
      expect(stored[0]?.email_hash === sha256(email)).toBe(true);
      expect(stored[0]?.purpose === "email_verification").toBe(true);
      expect(stored[0]?.token_hash === sha256(secondRawToken)).toBe(true);
      expect(JSON.stringify(stored).includes(firstRawToken)).toBe(false);
      expect(JSON.stringify(stored).includes(secondRawToken)).toBe(false);
      await expect(
        database
          .updateTable("auth_action_token")
          .set({ consumed_at: expiresAt })
          .where("user_id", "=", owner.userId)
          .executeTakeFirst(),
      ).rejects.toThrow();
      await expect(
        confirmEmailVerificationToken(database, {
          confirmedAt: new Date("2035-08-15T01:00:00.000Z"),
          requestId: "request-superseded",
          tokenHash: sha256(firstRawToken),
        }),
      ).rejects.toBeInstanceOf(EmailVerificationTokenInvalidError);
      await expect(
        confirmEmailVerificationToken(database, {
          confirmedAt: expiresAt,
          requestId: "request-expired",
          tokenHash: sha256(secondRawToken),
        }),
      ).rejects.toBeInstanceOf(EmailVerificationTokenExpiredError);

      const thirdRawToken = randomBytes(32).toString("base64url");
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(email),
        expiresAt,
        issuedAt,
        tokenHash: sha256(thirdRawToken),
        userId: owner.userId,
      });
      const changedEmail = `changed-${randomUUID()}@example.invalid`;
      await database
        .updateTable("app_user")
        .set({ email: changedEmail })
        .where("id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      await expect(
        confirmEmailVerificationToken(database, {
          confirmedAt: new Date("2035-08-15T01:00:00.000Z"),
          requestId: "request-email-changed",
          tokenHash: sha256(thirdRawToken),
        }),
      ).rejects.toBeInstanceOf(EmailVerificationTokenInvalidError);

      const currentRawToken = randomBytes(32).toString("base64url");
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(changedEmail),
        expiresAt,
        issuedAt,
        tokenHash: sha256(currentRawToken),
        userId: owner.userId,
      });
      await expect(
        confirmEmailVerificationToken(database, {
          confirmedAt: new Date("2035-08-15T02:00:00.000Z"),
          requestId: "request-confirmed",
          tokenHash: sha256(currentRawToken),
        }),
      ).resolves.toBeUndefined();
      await expect(getUserProfile(database, owner.userId)).resolves.toMatchObject({
        email: changedEmail,
        emailVerified: true,
        emailVerifiedAt: new Date("2035-08-15T02:00:00.000Z"),
      });
      const audit = await database
        .selectFrom("audit_log")
        .selectAll()
        .where("action", "=", "auth.email_verification.confirmed")
        .where("subject_user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        actor_user_id: null,
        after_state: { emailVerified: true },
        before_state: { emailVerified: false },
        context: { purpose: "email_verification" },
        entity_id: owner.userId,
        request_id: "request-confirmed",
        sensitivity: "security",
      });
      const auditJson = JSON.stringify(audit);
      expect(auditJson.includes(currentRawToken)).toBe(false);
      expect(auditJson.includes(sha256(currentRawToken))).toBe(false);
      expect(auditJson.includes(changedEmail)).toBe(false);
      await expect(
        confirmEmailVerificationToken(database, {
          confirmedAt: new Date("2035-08-15T03:00:00.000Z"),
          requestId: "request-replay",
          tokenHash: sha256(currentRawToken),
        }),
      ).rejects.toBeInstanceOf(EmailVerificationTokenInvalidError);
      const auditCount = await database
        .selectFrom("audit_log")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("action", "=", "auth.email_verification.confirmed")
        .where("subject_user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(auditCount.count).toBe("1");
      const replacementHash = sha256(randomBytes(32).toString("base64url"));
      await expect(
        issueEmailVerificationToken(database, {
          deliver: async () => undefined,
          emailHash: sha256(changedEmail),
          expiresAt,
          issuedAt,
          tokenHash: replacementHash,
          userId: owner.userId,
        }),
      ).resolves.toBe("already_verified");
      const unchanged = await database
        .selectFrom("auth_action_token")
        .select("token_hash")
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(unchanged.token_hash === sha256(currentRawToken)).toBe(true);

      const cascadeEmail = `verify-cascade-${randomUUID()}@example.invalid`;
      const cascadeOwner = await registerPasswordAccount(database, {
        email: cascadeEmail,
        passwordHash: "$argon2id$email-verification-cascade-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "email-verification-cascade-fixture-salt",
        timeZone: "America/Chicago",
      });
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(cascadeEmail),
        expiresAt,
        issuedAt,
        tokenHash: sha256(randomBytes(32).toString("base64url")),
        userId: cascadeOwner.userId,
      });
      await database
        .deleteFrom("app_user")
        .where("id", "=", cascadeOwner.userId)
        .executeTakeFirst();
      const afterDelete = await database
        .selectFrom("auth_action_token")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", cascadeOwner.userId)
        .executeTakeFirstOrThrow();
      expect(afterDelete.count).toBe("0");
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [database]);
    }
  });

  it("preserves active delivery, serializes resends, and fences confirm until promotion commits", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `auth_email_lock_${randomBytes(6).toString("hex")}`;
    await sql`create schema ${sql.id(schemaName)}`.execute(bootstrap);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const runId = randomBytes(6).toString("hex");
    const firstApplicationName = `email_verify_first_${runId}`;
    const secondApplicationName = `email_verify_second_${runId}`;
    const issuanceApplicationName = `email_verify_issuance_${runId}`;
    const confirmationApplicationName = `email_verify_confirmation_${runId}`;
    const observerApplicationName = `email_verify_observer_${runId}`;
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 2 });
    const firstDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), firstApplicationName),
      maxConnections: 1,
    });
    const secondDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), secondApplicationName),
      maxConnections: 1,
    });
    const issuanceDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), issuanceApplicationName),
      maxConnections: 1,
    });
    const confirmationDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), confirmationApplicationName),
      maxConnections: 1,
    });
    const observerDatabase = createDatabase({
      connectionString: withApplicationName(scopedUrl.toString(), observerApplicationName),
      maxConnections: 1,
    });
    try {
      await runMigrations(database);
      const email = `verify-lock-${randomUUID()}@example.invalid`;
      const owner = await registerPasswordAccount(database, {
        email,
        passwordHash: "$argon2id$email-verification-lock-fixture-hash",
        passwordParameters: { algorithm: "test" },
        passwordSalt: "email-verification-lock-fixture-salt",
        timeZone: "America/Chicago",
      });
      const priorTokenHash = sha256(randomBytes(32).toString("base64url"));
      const failedTokenHash = sha256(randomBytes(32).toString("base64url"));
      const firstTokenHash = sha256(randomBytes(32).toString("base64url"));
      const secondTokenHash = sha256(randomBytes(32).toString("base64url"));
      const expiresAt = new Date("2035-08-16T00:00:00.000Z");
      const baseInput = { emailHash: sha256(email), expiresAt, userId: owner.userId };
      await issueEmailVerificationToken(database, {
        ...baseInput,
        deliver: async () => undefined,
        issuedAt: new Date("2035-08-15T00:00:00.000Z"),
        tokenHash: priorTokenHash,
      });

      await expect(
        issueEmailVerificationToken(database, {
          ...baseInput,
          deliver: async () => Promise.reject(new Error("synthetic delivery failure")),
          issuedAt: new Date("2035-08-15T00:01:00.000Z"),
          tokenHash: failedTokenHash,
        }),
      ).rejects.toThrow("synthetic delivery failure");
      const preserved = await database
        .selectFrom("auth_action_token")
        .select("token_hash")
        .where("user_id", "=", owner.userId)
        .executeTakeFirstOrThrow();
      expect(preserved.token_hash === priorTokenHash).toBe(true);

      const firstStarted = deferred();
      const releaseFirst = deferred();
      const deliveryOrder: string[] = [];
      const first = issueEmailVerificationToken(firstDatabase, {
        ...baseInput,
        deliver: async () => {
          deliveryOrder.push("first-started");
          firstStarted.resolve();
          await releaseFirst.promise;
          deliveryOrder.push("first-accepted");
        },
        issuedAt: new Date("2035-08-15T00:02:00.000Z"),
        tokenHash: firstTokenHash,
      });
      await firstStarted.promise;
      const second = issueEmailVerificationToken(secondDatabase, {
        ...baseInput,
        deliver: async () => {
          deliveryOrder.push("second-accepted");
        },
        issuedAt: new Date("2035-08-15T00:03:00.000Z"),
        tokenHash: secondTokenHash,
      });
      try {
        await waitForPostgresLock(
          observerDatabase,
          secondApplicationName,
          ["transactionid", "tuple"],
          "concurrent resend",
        );
        expect(deliveryOrder).toEqual(["first-started"]);
      } finally {
        releaseFirst.resolve();
        await Promise.allSettled([first, second]);
      }
      await expect(Promise.all([first, second])).resolves.toEqual(["issued", "issued"]);
      expect(deliveryOrder).toEqual(["first-started", "first-accepted", "second-accepted"]);
      const finalTokens = await database
        .selectFrom("auth_action_token")
        .select("token_hash")
        .where("user_id", "=", owner.userId)
        .execute();
      expect(finalTokens.length === 1 && finalTokens[0]?.token_hash === secondTokenHash).toBe(true);

      const fencedRawToken = randomBytes(32).toString("base64url");
      const fencedTokenHash = sha256(fencedRawToken);
      const deliveryAccepted = deferred();
      const releasePromotion = deferred();
      const fencedIssuance = issueEmailVerificationToken(issuanceDatabase, {
        ...baseInput,
        deliver: async () => {
          deliveryAccepted.resolve();
          await releasePromotion.promise;
        },
        issuedAt: new Date("2035-08-15T00:04:00.000Z"),
        tokenHash: fencedTokenHash,
      });
      await deliveryAccepted.promise;
      const fencedConfirmation = confirmEmailVerificationToken(confirmationDatabase, {
        confirmedAt: new Date("2035-08-15T00:05:00.000Z"),
        requestId: "request-during-delivery",
        tokenHash: fencedTokenHash,
      });
      try {
        await waitForPostgresLock(
          observerDatabase,
          confirmationApplicationName,
          ["advisory"],
          "concurrent confirmation",
        );
      } finally {
        releasePromotion.resolve();
        await Promise.allSettled([fencedIssuance, fencedConfirmation]);
      }
      await expect(fencedIssuance).resolves.toBe("issued");
      await expect(fencedConfirmation).resolves.toBeUndefined();
      await expect(getUserProfile(database, owner.userId)).resolves.toMatchObject({
        emailVerified: true,
      });
    } finally {
      await cleanupDatabaseTest(bootstrap, schemaName, [
        database,
        firstDatabase,
        secondDatabase,
        issuanceDatabase,
        confirmationDatabase,
        observerDatabase,
      ]);
    }
  });
});
