import { randomBytes } from "node:crypto";

import { createDatabase, runMigrations } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SecureAuthService } from "../src/modules/auth/auth-service.js";
import {
  DatabaseAuthRepository,
  DatabaseDiaryService,
  DatabaseProfileService,
} from "../src/persistence-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("live private API adapters", () => {
  it("registers, authenticates, edits revision zero, reads an owned day, and revokes the session", {
    timeout: 30_000,
  }, async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const bootstrap = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
    const schemaName = `api_diary_${randomBytes(6).toString("hex")}`;
    await bootstrap.schema.createSchema(schemaName).execute();
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},public`);
    const database = createDatabase({ connectionString: scopedUrl.toString(), maxConnections: 4 });
    const authService = new SecureAuthService({
      repository: new DatabaseAuthRepository(database),
    });
    const app = buildApp({
      authService,
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      diaryService: new DatabaseDiaryService(database),
      logger: false,
      profileService: new DatabaseProfileService(database),
    });
    try {
      await runMigrations(database);
      const password = "correct horse battery staple";
      const registration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          displayName: "Live Adapter",
          email: "live-adapter@example.invalid",
          password,
          timeZone: "America/Chicago",
        },
      });
      expect(registration.statusCode).toBe(201);
      const registered = registration.json<{
        data: { accessToken: string; profile: { revision: string }; user: { id: string } };
      }>();
      expect(registered.data.profile.revision).toBe("0");
      const authorization = `Bearer ${registered.data.accessToken}`;

      const persistedSession = await database
        .selectFrom("user_session")
        .select("token_hash")
        .where("user_id", "=", registered.data.user.id)
        .executeTakeFirstOrThrow();
      const persistedCredential = await database
        .selectFrom("user_password_credential")
        .select("password_hash")
        .where("user_id", "=", registered.data.user.id)
        .executeTakeFirstOrThrow();
      expect(persistedSession.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(persistedSession.token_hash).not.toBe(registered.data.accessToken);
      expect(persistedCredential.password_hash).not.toBe(password);

      const me = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ data: { profile: { timeZone: "America/Chicago" } } });

      const profile = await app.inject({
        method: "PATCH",
        url: "/v1/profile",
        headers: { authorization, "if-match": '"0"' },
        payload: { heightCm: "170.000" },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.headers.etag).toBe('"1"');
      expect(profile.json()).toMatchObject({
        data: { profile: { heightCm: "170", revision: "1" } },
      });

      const diary = await app.inject({
        method: "GET",
        url: "/v1/diary?date=2026-08-15",
        headers: { authorization },
      });
      expect(diary.statusCode).toBe(200);
      expect(diary.headers.etag).toBe('"0"');
      expect(diary.json()).toMatchObject({
        data: { entries: [], id: null, localDate: "2026-08-15", revision: "0", totals: [] },
      });

      const logout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization },
      });
      expect(logout.statusCode).toBe(204);
      const revoked = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization },
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
      await database.destroy();
      await bootstrap.schema.dropSchema(schemaName).cascade().execute();
      await bootstrap.destroy();
    }
  });
});
