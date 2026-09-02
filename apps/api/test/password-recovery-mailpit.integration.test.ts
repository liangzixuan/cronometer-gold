import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import {
  createDatabase,
  createReauthenticationProof,
  findPasswordCredentialByEmail,
  issueEmailVerificationToken,
  issuePasswordRecoveryToken,
  runMigrations,
  withPrivacyExportSnapshot,
} from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLoggerOptions } from "../src/logging.js";
import { SecureAuthService } from "../src/modules/auth/auth-service.js";
import { LocalMailpitEmailDelivery } from "../src/modules/auth/email-delivery.js";
import { DatabaseAuthRepository } from "../src/persistence-services.js";

const proofRequested = process.env.TEST_PASSWORD_RECOVERY_MAILPIT === "true";
const describeMailpit = proofRequested ? describe : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describeMailpit("real Mailpit password-recovery proof", { timeout: 60_000 }, () => {
  it("resets safely, revokes older authority, redacts secrets, and cleans up its messages", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const mailpitHttpUrl = process.env.TEST_MAILPIT_HTTP_URL;
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the Mailpit proof");
    if (mailpitHttpUrl !== "http://127.0.0.1:8025") {
      throw new Error("TEST_MAILPIT_HTTP_URL must be exact loopback Mailpit");
    }

    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `mailpit_recovery_${randomBytes(6).toString("hex")}`;
    const recipient = `mailpit-recovery-${randomUUID()}@example.invalid`;
    const unknownRecipient = `mailpit-recovery-unknown-${randomUUID()}@example.invalid`;
    let schemaCreated = false;
    let databaseToDestroy: ReturnType<typeof createDatabase> | null = null;
    let app: ReturnType<typeof buildApp> | null = null;
    let proofError: unknown;
    try {
      await bootstrap.schema.createSchema(schemaName).execute();
      schemaCreated = true;
      const scopedUrl = new URL(databaseUrl);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
      const database = createDatabase({
        connectionString: scopedUrl.toString(),
        maxConnections: 4,
      });
      databaseToDestroy = database;
      await runMigrations(database);

      let logs = "";
      const logStream = new Writable({
        write(chunk, _encoding, callback) {
          logs += chunk.toString();
          callback();
        },
      });
      const config = loadConfig({ LOG_LEVEL: "info", NODE_ENV: "test" });
      const delivery = new LocalMailpitEmailDelivery({
        from: "Nutrition Tracker Local <no-reply@nutrition.local>",
        host: "127.0.0.1",
        nodeEnv: "test",
        port: 1025,
        timeoutMs: 5_000,
      });
      const authService = new SecureAuthService({
        emailVerificationDelivery: delivery,
        emailVerificationPublicOrigin: "http://127.0.0.1:3000",
        passwordRecoveryDelivery: delivery,
        passwordRecoveryPublicOrigin: "http://127.0.0.1:3000",
        repository: new DatabaseAuthRepository(database),
      });
      app = buildApp({
        authService,
        config,
        logger: { ...createLoggerOptions(config), stream: logStream },
      });

      const oldPassword = "mailpit recovery old password";
      const newPassword = "mailpit recovery replacement password";
      const replayPassword = "mailpit recovery replay password";
      const registration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          email: recipient,
          password: oldPassword,
          timeZone: "America/Chicago",
        },
      });
      expect(registration.statusCode).toBe(201);
      const registrationBody = registration.json<{
        data: { accessToken: string; user: { id: string } };
      }>();
      const firstBearer = registrationBody.data.accessToken;
      const userId = registrationBody.data.user.id;
      const registeredCredential = await findPasswordCredentialByEmail(database, recipient);
      if (!registeredCredential) throw new Error("Registered password credential is missing");

      const secondLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: recipient, password: oldPassword },
      });
      expect(secondLogin.statusCode).toBe(200);
      const secondBearer = secondLogin.json<{ data: { accessToken: string } }>().data.accessToken;
      const firstBearerHash = sha256(firstBearer);
      const secondBearerHash = sha256(secondBearer);
      const preResetBearerHashes = [firstBearerHash, secondBearerHash];

      const reauthenticationToken = randomBytes(32).toString("base64url");
      const reauthenticationTokenHash = sha256(reauthenticationToken);
      await createReauthenticationProof(database, {
        expectedPasswordHash: registeredCredential.passwordHash,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        purpose: "account_export",
        sessionTokenHash: firstBearerHash,
        tokenHash: reauthenticationTokenHash,
        userId,
      });

      const verificationToken = randomBytes(32).toString("base64url");
      const verificationTokenHash = sha256(verificationToken);
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(recipient),
        expiresAt: new Date(Date.now() + 60 * 60_000),
        issuedAt: new Date(),
        tokenHash: verificationTokenHash,
        userId,
      });

      const unknownToken = randomBytes(32).toString("base64url");
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { newPassword, token: unknownToken },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<{ code?: unknown }>().code === "PASSWORD_RECOVERY_TOKEN_INVALID").toBe(
        true,
      );
      expect(invalid.body.includes(unknownToken)).toBe(false);
      expect(invalid.body.includes(newPassword)).toBe(false);

      const expiredToken = randomBytes(32).toString("base64url");
      const expiredAt = new Date(Date.now() - 60_000);
      await issuePasswordRecoveryToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(recipient),
        expiresAt: expiredAt,
        issuedAt: new Date(expiredAt.getTime() - 60_000),
        normalizedEmail: recipient,
        tokenHash: sha256(expiredToken),
      });
      const expired = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { newPassword, token: expiredToken },
      });
      expect(expired.statusCode).toBe(410);
      expect(expired.json<{ code?: unknown }>().code === "PASSWORD_RECOVERY_TOKEN_EXPIRED").toBe(
        true,
      );
      expect(expired.body.includes(expiredToken)).toBe(false);
      expect(expired.body.includes(newPassword)).toBe(false);

      const unknownRequest = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/request",
        payload: { email: unknownRecipient },
      });
      expect(unknownRequest.statusCode).toBe(202);
      expect(unknownRequest.json()).toEqual({ data: { status: "accepted" } });
      expect(unknownRequest.headers["cache-control"]).toBe("no-store");
      expect(Buffer.byteLength(unknownRequest.body, "utf8")).toBeLessThanOrEqual(4 * 1_024);
      expect((await listSyntheticMessageIds(mailpitHttpUrl, [unknownRecipient])).length).toBe(0);

      const knownRequest = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/request",
        payload: { email: recipient },
      });
      expect(knownRequest.statusCode).toBe(202);
      expect(knownRequest.json()).toEqual({ data: { status: "accepted" } });
      expect(knownRequest.headers["cache-control"]).toBe(unknownRequest.headers["cache-control"]);
      expect(knownRequest.body).toBe(unknownRequest.body);
      expect(Buffer.byteLength(knownRequest.body, "utf8")).toBeLessThanOrEqual(4 * 1_024);

      const messageId = await waitForSyntheticMessage(mailpitHttpUrl, recipient);
      const messageResponse = await fetch(
        `${mailpitHttpUrl}/api/v1/message/${encodeURIComponent(messageId)}`,
      );
      expect(messageResponse.status).toBe(200);
      const message = (await messageResponse.json()) as { Text?: unknown };
      if (typeof message.Text !== "string") throw new Error("Mailpit message text is missing");
      const link =
        /http:\/\/127\.0\.0\.1:3000\/reset-password#token=(?<token>[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])/u.exec(
          message.Text,
        );
      const token = link?.groups?.token;
      if (!token) throw new Error("Mailpit recovery fragment is missing");
      const tokenHash = sha256(token);

      const pendingRecovery = await database
        .selectFrom("auth_action_token")
        .selectAll()
        .where("user_id", "=", userId)
        .where("purpose", "=", "password_recovery")
        .executeTakeFirstOrThrow();
      expect(Object.keys(pendingRecovery).sort()).toEqual([
        "consumed_at",
        "created_at",
        "email_hash",
        "expires_at",
        "id",
        "purpose",
        "token_hash",
        "user_id",
      ]);
      expect(pendingRecovery.token_hash === tokenHash).toBe(true);
      expect(pendingRecovery.email_hash === sha256(recipient)).toBe(true);
      expect(pendingRecovery.consumed_at === null).toBe(true);
      expect(JSON.stringify(pendingRecovery).includes(token)).toBe(false);

      const confirmation = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { newPassword, token },
      });
      expect(confirmation.statusCode).toBe(200);
      expect(confirmation.json()).toEqual({ data: { passwordReset: true } });
      expect(confirmation.headers["cache-control"]).toBe("no-store");

      const replay = await app.inject({
        method: "POST",
        url: "/v1/auth/password-recovery/confirm",
        payload: { newPassword: replayPassword, token },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json<{ code?: unknown }>().code === "PASSWORD_RECOVERY_TOKEN_INVALID").toBe(
        true,
      );
      expect(replay.body.includes(token)).toBe(false);
      expect(replay.body.includes(replayPassword)).toBe(false);

      const invalidatedVerification = await app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/confirm",
        payload: { token: verificationToken },
      });
      expect(invalidatedVerification.statusCode).toBe(400);
      expect(
        invalidatedVerification.json<{ code?: unknown }>().code ===
          "EMAIL_VERIFICATION_TOKEN_INVALID",
      ).toBe(true);
      expect(invalidatedVerification.body.includes(verificationToken)).toBe(false);

      for (const bearer of [firstBearer, secondBearer]) {
        const preResetSession = await app.inject({
          headers: { authorization: `Bearer ${bearer}` },
          method: "GET",
          url: "/v1/auth/me",
        });
        expect(preResetSession.statusCode).toBe(401);
      }

      const oldPasswordLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: recipient, password: oldPassword },
      });
      expect(oldPasswordLogin.statusCode).toBe(401);
      expect(oldPasswordLogin.body.includes(oldPassword)).toBe(false);

      const newPasswordLogin = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: recipient, password: newPassword },
      });
      expect(newPasswordLogin.statusCode).toBe(200);
      const newLoginBody = newPasswordLogin.json<{
        data: { accessToken: string; user: { emailVerified: boolean } };
      }>();
      expect(newLoginBody.data.user.emailVerified).toBe(true);
      const newBearer = newLoginBody.data.accessToken;
      const me = await app.inject({
        headers: { authorization: `Bearer ${newBearer}` },
        method: "GET",
        url: "/v1/auth/me",
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ data: { user: { emailVerified: true } } });

      const sessions = await database
        .selectFrom("user_session")
        .select(["token_hash", "revoked_at"])
        .where("user_id", "=", userId)
        .execute();
      for (const preResetHash of preResetBearerHashes) {
        const session = sessions.find((candidate) => candidate.token_hash === preResetHash);
        expect(session?.revoked_at !== null).toBe(true);
      }
      const newSession = sessions.find((candidate) => candidate.token_hash === sha256(newBearer));
      expect(newSession?.revoked_at === null).toBe(true);

      const reauthenticationProof = await database
        .selectFrom("reauthentication_proof")
        .select(["token_hash", "consumed_at", "revoked_at"])
        .where("user_id", "=", userId)
        .where("token_hash", "=", reauthenticationTokenHash)
        .executeTakeFirstOrThrow();
      expect(reauthenticationProof.consumed_at === null).toBe(true);
      expect(reauthenticationProof.revoked_at !== null).toBe(true);

      const remainingVerificationActions = await database
        .selectFrom("auth_action_token")
        .select("id")
        .where("user_id", "=", userId)
        .where("purpose", "=", "email_verification")
        .execute();
      expect(remainingVerificationActions).toEqual([]);
      const persistedRecovery = await database
        .selectFrom("auth_action_token")
        .selectAll()
        .where("user_id", "=", userId)
        .where("purpose", "=", "password_recovery")
        .executeTakeFirstOrThrow();
      expect(persistedRecovery.token_hash === tokenHash).toBe(true);
      expect(persistedRecovery.consumed_at !== null).toBe(true);
      expect(JSON.stringify(persistedRecovery).includes(token)).toBe(false);

      const credential = await database
        .selectFrom("user_password_credential")
        .select(["password_hash", "password_salt"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(credential.password_hash === newPassword).toBe(false);
      expect(credential.password_salt === newPassword).toBe(false);

      const completionAudits = await database
        .selectFrom("audit_log")
        .select([
          "actor_user_id",
          "after_state",
          "before_state",
          "context",
          "entity_id",
          "entity_type",
          "reason",
          "sensitivity",
          "subject_user_id",
        ])
        .where("action", "=", "auth.password_recovery.completed")
        .where("subject_user_id", "=", userId)
        .execute();
      expect(completionAudits.length).toBe(1);
      const audit = completionAudits[0];
      expect(audit?.actor_user_id === null).toBe(true);
      expect(audit?.entity_id === userId && audit.subject_user_id === userId).toBe(true);
      expect(audit?.entity_type === "user_password_credential").toBe(true);
      expect(audit?.reason === "user_confirmed_recovery_link").toBe(true);
      expect(audit?.sensitivity === "security").toBe(true);
      expect(JSON.stringify(audit?.before_state) === '{"emailVerified":false}').toBe(true);
      expect(
        JSON.stringify(audit?.after_state) === '{"emailVerified":true,"passwordChanged":true}',
      ).toBe(true);
      expect(JSON.stringify(audit?.context) === '{"purpose":"password_recovery"}').toBe(true);

      const exportJobId = randomUUID();
      const workerId = "mailpit-recovery-proof-worker";
      await database
        .insertInto("privacy_export_job")
        .values({
          client_operation_id: randomUUID(),
          id: exportJobId,
          locked_at: new Date(),
          locked_by: workerId,
          request_digest: "e".repeat(64),
          requested_formats: ["json"],
          status: "running",
          user_id: userId,
        })
        .execute();
      const serializedExport = await withPrivacyExportSnapshot(
        database,
        {
          jobId: exportJobId,
          maximumSnapshotBytes: 10 * 1_024 * 1_024,
          userId,
          workerId,
        },
        async (snapshot) => {
          const records: unknown[] = [];
          for (const entity of snapshot.entities) {
            let cursor: string | null = null;
            do {
              const page = await snapshot.page({ cursor, entity: entity.entity, limit: 1_000 });
              records.push(...page.records);
              cursor = page.nextCursor;
            } while (cursor);
          }
          return JSON.stringify(records);
        },
      );

      const serializedAudit = JSON.stringify(completionAudits);
      const forbiddenAuditOrLogValues = [
        recipient,
        unknownRecipient,
        token,
        tokenHash,
        pendingRecovery.email_hash,
        unknownToken,
        expiredToken,
        verificationToken,
        verificationTokenHash,
        reauthenticationToken,
        reauthenticationTokenHash,
        firstBearer,
        secondBearer,
        oldPassword,
        newPassword,
        replayPassword,
        credential.password_hash,
        credential.password_salt,
      ];
      for (const forbidden of forbiddenAuditOrLogValues) {
        expect(serializedAudit.includes(forbidden)).toBe(false);
        expect(logs.includes(forbidden)).toBe(false);
      }
      const forbiddenExportValues = [
        token,
        tokenHash,
        pendingRecovery.email_hash,
        unknownToken,
        expiredToken,
        verificationToken,
        verificationTokenHash,
        reauthenticationToken,
        reauthenticationTokenHash,
        firstBearer,
        secondBearer,
        sha256(firstBearer),
        sha256(secondBearer),
        oldPassword,
        newPassword,
        replayPassword,
        credential.password_hash,
        credential.password_salt,
      ];
      for (const forbidden of forbiddenExportValues) {
        expect(serializedExport.includes(forbidden)).toBe(false);
      }
    } catch (error) {
      proofError = error;
    }

    let cleanupFailed = false;
    if (mailpitHttpUrl === "http://127.0.0.1:8025") {
      try {
        const syntheticRecipients = [recipient, unknownRecipient];
        const syntheticMessageIds = await listSyntheticMessageIds(
          mailpitHttpUrl,
          syntheticRecipients,
        );
        if (syntheticMessageIds.length > 0) {
          const deletion = await fetch(`${mailpitHttpUrl}/api/v1/messages`, {
            body: JSON.stringify({ IDs: syntheticMessageIds }),
            headers: { "content-type": "application/json" },
            method: "DELETE",
          });
          if (deletion.status !== 200) cleanupFailed = true;
        }
        const remaining = await listSyntheticMessageIds(mailpitHttpUrl, syntheticRecipients);
        if (remaining.length !== 0) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      if (app) await app.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (databaseToDestroy) await databaseToDestroy.destroy();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (schemaCreated) await bootstrap.schema.dropSchema(schemaName).cascade().execute();
    } catch {
      cleanupFailed = true;
    }
    try {
      await bootstrap.destroy();
    } catch {
      cleanupFailed = true;
    }

    const cleanupError = cleanupFailed ? new Error("Password-recovery proof cleanup failed") : null;
    if (proofError !== undefined && cleanupError) {
      throw new AggregateError(
        [proofError, cleanupError],
        "Password-recovery proof and cleanup failed",
      );
    }
    if (proofError !== undefined) throw proofError;
    if (cleanupError) throw cleanupError;
  });
});

async function waitForSyntheticMessage(mailpitHttpUrl: string, recipient: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  do {
    const messageIds = await listSyntheticMessageIds(mailpitHttpUrl, [recipient]);
    if (messageIds[0]) return messageIds[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("Synthetic Mailpit message was not captured");
}

async function listSyntheticMessageIds(
  mailpitHttpUrl: string,
  recipients: readonly string[],
): Promise<string[]> {
  const response = await fetch(`${mailpitHttpUrl}/api/v1/messages?start=0&limit=50`);
  if (response.status !== 200) throw new Error("Mailpit message listing failed");
  const body = (await response.json()) as {
    messages?: readonly {
      ID?: unknown;
      To?: readonly { Address?: unknown }[];
    }[];
  };
  const recipientSet = new Set(recipients);
  return (body.messages ?? []).flatMap((message) =>
    message.To?.some(
      (address) => typeof address.Address === "string" && recipientSet.has(address.Address),
    ) &&
    typeof message.ID === "string" &&
    message.ID.length > 0
      ? [message.ID]
      : [],
  );
}
