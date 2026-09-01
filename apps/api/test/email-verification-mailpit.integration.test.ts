import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import {
  createDatabase,
  issueEmailVerificationToken,
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

const proofRequested = process.env.TEST_EMAIL_VERIFICATION_MAILPIT === "true";
const describeMailpit = proofRequested ? describe : describe.skip;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describeMailpit("real Mailpit email-verification proof", { timeout: 30_000 }, () => {
  it("captures, confirms, exports safely, and deletes only its synthetic message", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const mailpitHttpUrl = process.env.TEST_MAILPIT_HTTP_URL;
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the Mailpit proof");
    if (mailpitHttpUrl !== "http://127.0.0.1:8025") {
      throw new Error("TEST_MAILPIT_HTTP_URL must be exact loopback Mailpit");
    }

    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `mailpit_verify_${randomBytes(6).toString("hex")}`;
    const recipient = `mailpit-proof-${randomUUID()}@example.invalid`;
    let schemaCreated = false;
    let databaseToDestroy: ReturnType<typeof createDatabase> | null = null;
    let messageId: string | null = null;
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
      const authService = new SecureAuthService({
        emailVerificationDelivery: new LocalMailpitEmailDelivery({
          from: "Nutrition Tracker Local <no-reply@nutrition.local>",
          host: "127.0.0.1",
          nodeEnv: "test",
          port: 1025,
          timeoutMs: 5_000,
        }),
        emailVerificationPublicOrigin: "http://127.0.0.1:3000",
        repository: new DatabaseAuthRepository(database),
      });
      app = buildApp({
        authService,
        config,
        logger: { ...createLoggerOptions(config), stream: logStream },
      });
      const registration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          email: recipient,
          password: "mailpit proof password",
          timeZone: "America/Chicago",
        },
      });
      expect(registration.statusCode).toBe(201);
      const registrationBody = registration.json<{
        data: { accessToken: string; user: { id: string } };
      }>();
      const bearer = registrationBody.data.accessToken;
      const userId = registrationBody.data.user.id;

      for (const malformedToken of ["too-short", "a".repeat(43)]) {
        const malformed = await app.inject({
          method: "POST",
          url: "/v1/auth/email-verification/confirm",
          payload: { token: malformedToken },
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json<{ code?: unknown }>().code === "VALIDATION_ERROR").toBe(true);
        expect(malformed.body.includes(malformedToken)).toBe(false);
      }

      const unknownToken = randomBytes(32).toString("base64url");
      const unknown = await app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/confirm",
        payload: { token: unknownToken },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json<{ code?: unknown }>().code === "EMAIL_VERIFICATION_TOKEN_INVALID").toBe(
        true,
      );
      expect(unknown.body.includes(unknownToken)).toBe(false);

      const expiredToken = randomBytes(32).toString("base64url");
      const expiredAt = new Date(Date.now() - 60_000);
      await issueEmailVerificationToken(database, {
        deliver: async () => undefined,
        emailHash: sha256(recipient),
        expiresAt: expiredAt,
        issuedAt: new Date(expiredAt.getTime() - 60_000),
        tokenHash: sha256(expiredToken),
        userId,
      });
      const expired = await app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/confirm",
        payload: { token: expiredToken },
      });
      expect(expired.statusCode).toBe(410);
      expect(expired.json<{ code?: unknown }>().code === "EMAIL_VERIFICATION_TOKEN_EXPIRED").toBe(
        true,
      );
      expect(expired.body.includes(expiredToken)).toBe(false);

      const requested = await app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/request",
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(requested.statusCode).toBe(202);

      messageId = await waitForSyntheticMessage(mailpitHttpUrl, recipient);
      const messageResponse = await fetch(
        `${mailpitHttpUrl}/api/v1/message/${encodeURIComponent(messageId)}`,
      );
      expect(messageResponse.status).toBe(200);
      const message = (await messageResponse.json()) as { Text?: unknown };
      if (typeof message.Text !== "string") throw new Error("Mailpit message text is missing");
      const link =
        /http:\/\/127\.0\.0\.1:3000\/verify-email#token=(?<token>[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])/u.exec(
          message.Text,
        );
      const token = link?.groups?.token;
      if (!token) throw new Error("Mailpit verification fragment is missing");
      const tokenHash = sha256(token);

      const confirmation = await app.inject({
        method: "POST",
        url: "/v1/auth/email-verification/confirm",
        payload: { token },
      });
      expect(confirmation.statusCode).toBe(200);
      const me = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ data: { user: { emailVerified: true } } });

      const persisted = await database
        .selectFrom("auth_action_token")
        .select(["token_hash", "email_hash", "consumed_at"])
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(persisted.token_hash === tokenHash).toBe(true);
      expect(persisted.consumed_at !== null).toBe(true);
      expect(JSON.stringify(persisted).includes(token)).toBe(false);
      expect(logs.includes(token)).toBe(false);
      expect(logs.includes(tokenHash)).toBe(false);
      expect(logs.includes(unknownToken)).toBe(false);
      expect(logs.includes(expiredToken)).toBe(false);

      const confirmationAudits = await database
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
        .where("action", "=", "auth.email_verification.confirmed")
        .where("subject_user_id", "=", userId)
        .execute();
      expect(confirmationAudits.length).toBe(1);
      const audit = confirmationAudits[0];
      expect(audit?.actor_user_id === null).toBe(true);
      expect(audit?.entity_id === userId && audit.subject_user_id === userId).toBe(true);
      expect(audit?.entity_type === "app_user").toBe(true);
      expect(audit?.reason === "user_confirmed_link").toBe(true);
      expect(audit?.sensitivity === "security").toBe(true);
      expect(JSON.stringify(audit?.before_state) === '{"emailVerified":false}').toBe(true);
      expect(JSON.stringify(audit?.after_state) === '{"emailVerified":true}').toBe(true);
      expect(JSON.stringify(audit?.context) === '{"purpose":"email_verification"}').toBe(true);
      const serializedAudit = JSON.stringify(confirmationAudits);
      expect(serializedAudit.includes(token)).toBe(false);
      expect(serializedAudit.includes(tokenHash)).toBe(false);
      expect(serializedAudit.includes(persisted.email_hash)).toBe(false);
      expect(serializedAudit.includes(recipient)).toBe(false);

      const exportJobId = randomUUID();
      const workerId = "mailpit-proof-worker";
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
      expect(serializedExport.includes(token)).toBe(false);
      expect(serializedExport.includes(tokenHash)).toBe(false);
      expect(serializedExport.includes(persisted.email_hash)).toBe(false);
    } catch (error) {
      proofError = error;
    }

    let cleanupFailed = false;
    if (mailpitHttpUrl === "http://127.0.0.1:8025") {
      try {
        const syntheticMessageIds = await listSyntheticMessageIds(mailpitHttpUrl, recipient);
        if (syntheticMessageIds.length > 0) {
          const deletion = await fetch(`${mailpitHttpUrl}/api/v1/messages`, {
            body: JSON.stringify({ IDs: syntheticMessageIds }),
            headers: { "content-type": "application/json" },
            method: "DELETE",
          });
          if (deletion.status !== 200) cleanupFailed = true;
          else {
            const remaining = await listSyntheticMessageIds(mailpitHttpUrl, recipient);
            if (remaining.length !== 0) cleanupFailed = true;
          }
        }
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

    const cleanupError = cleanupFailed
      ? new Error("Email-verification proof cleanup failed")
      : undefined;
    if (proofError !== undefined && cleanupError) {
      throw new AggregateError(
        [proofError, cleanupError],
        "Email-verification proof and cleanup failed",
      );
    }
    if (proofError !== undefined) throw proofError;
    if (cleanupError) throw cleanupError;
  });
});

async function waitForSyntheticMessage(mailpitHttpUrl: string, recipient: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  do {
    const messageIds = await listSyntheticMessageIds(mailpitHttpUrl, recipient);
    if (messageIds[0]) return messageIds[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("Synthetic Mailpit message was not captured");
}

async function listSyntheticMessageIds(
  mailpitHttpUrl: string,
  recipient: string,
): Promise<string[]> {
  const response = await fetch(`${mailpitHttpUrl}/api/v1/messages?start=0&limit=50`);
  if (response.status !== 200) throw new Error("Mailpit message listing failed");
  const body = (await response.json()) as {
    messages?: readonly {
      ID?: unknown;
      To?: readonly { Address?: unknown }[];
    }[];
  };
  return (body.messages ?? []).flatMap((message) =>
    message.To?.some((address) => address.Address === recipient) &&
    typeof message.ID === "string" &&
    message.ID.length > 0
      ? [message.ID]
      : [],
  );
}
