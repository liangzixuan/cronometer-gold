import { createHash, randomBytes, randomUUID } from "node:crypto";

import { canonicalJson, type HydrationDayResponse } from "@nutrition-tracker/contracts";
import { createDatabase, runMigrations } from "@nutrition-tracker/db";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SecureAuthService } from "../src/modules/auth/auth-service.js";
import {
  DatabaseAuthRepository,
  DatabaseDiaryService,
  DatabaseHydrationService,
  DatabaseProfileService,
} from "../src/persistence-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

function hydrationDayEtag(response: HydrationDayResponse): string {
  const digest = createHash("sha256").update(canonicalJson(response), "utf8").digest("base64url");
  return `"h-${digest}"`;
}

describeDatabase("live private API adapters", () => {
  it("proves authenticated profile, diary, and hydration ownership through real adapters", {
    timeout: 60_000,
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
    const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const app = buildApp({
      authService,
      config,
      diaryService: new DatabaseDiaryService(database, {
        cursorSecret: "x".repeat(32),
      }),
      hydrationService: new DatabaseHydrationService(database),
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
      const diaryPage = await app.inject({
        method: "GET",
        url: "/v1/diary?date=2026-08-15&limit=20",
        headers: { authorization },
      });
      expect(diaryPage.statusCode, diaryPage.body).toBe(200);
      expect(diaryPage.headers.etag).toMatch(/^"p-[A-Za-z0-9_-]{43}"$/u);
      expect(diaryPage.json()).toMatchObject({
        data: { entries: [], id: null, localDate: "2026-08-15", revision: "0", totals: [] },
        page: { nextCursor: null, totalEntries: 0 },
      });

      const createOperationId = randomUUID();
      const createBody = {
        amountMilliliters: 250,
        // This UTC instant is still the prior profile-local day in America/Chicago.
        occurredAt: "2026-08-15T04:30:00.000Z",
      };
      const createdHydration = await app.inject({
        method: "POST",
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
        headers: {
          authorization,
          "idempotency-key": createOperationId,
          "x-expected-profile-time-zone": "America/Chicago",
        },
        payload: createBody,
      });
      expect(createdHydration.statusCode, createdHydration.body).toBe(201);
      expect(createdHydration.headers["cache-control"]).toBe("no-store");
      expect(createdHydration.headers.etag).toBe('"1"');
      const createdHydrationBody = createdHydration.json<{
        data: {
          replayed: boolean;
          entry: {
            id: string;
            revision: string;
            amountMilliliters: number;
            localDate: string;
            localTime: string;
            timeZone: string;
          };
        };
      }>();
      expect(createdHydrationBody.data).toMatchObject({
        replayed: false,
        entry: {
          revision: "1",
          amountMilliliters: 250,
          localDate: "2026-08-14",
          localTime: "23:30:00",
          timeZone: "America/Chicago",
        },
      });

      const replayedCreate = await app.inject({
        method: "POST",
        url: "/v1/hydration/entries?profileTimeZonePrecondition=v1",
        headers: {
          authorization,
          "idempotency-key": createOperationId,
          "x-expected-profile-time-zone": "America/Chicago",
        },
        payload: createBody,
      });
      expect(replayedCreate.statusCode, replayedCreate.body).toBe(200);
      expect(replayedCreate.json()).toMatchObject({
        data: { replayed: true, entry: { id: createdHydrationBody.data.entry.id } },
      });

      const hydrationBeforeMove = await app.inject({
        method: "GET",
        url: "/v1/hydration?date=2026-08-14",
        headers: { authorization },
      });
      expect(hydrationBeforeMove.statusCode, hydrationBeforeMove.body).toBe(200);
      expect(hydrationBeforeMove.json()).toMatchObject({
        data: {
          entries: [{ id: createdHydrationBody.data.entry.id, amountMilliliters: 250 }],
          localDate: "2026-08-14",
          totalMilliliters: 250,
        },
      });

      const otherRegistration = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: {
          displayName: "Other Hydration Owner",
          email: "other-hydration-owner@example.invalid",
          password,
          timeZone: "UTC",
        },
      });
      expect(otherRegistration.statusCode, otherRegistration.body).toBe(201);
      const otherAuthorization = `Bearer ${
        otherRegistration.json<{ data: { accessToken: string } }>().data.accessToken
      }`;
      const otherDay = await app.inject({
        method: "GET",
        url: "/v1/hydration?date=2026-08-14",
        headers: { authorization: otherAuthorization },
      });
      expect(otherDay.statusCode, otherDay.body).toBe(200);
      expect(otherDay.json()).toMatchObject({
        data: { entries: [], revision: "0", timeZone: "UTC", totalMilliliters: 0 },
      });
      const crossOwnerUpdate = await app.inject({
        method: "PATCH",
        url: `/v1/hydration/entries/${createdHydrationBody.data.entry.id}`,
        headers: {
          authorization: otherAuthorization,
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        payload: { amountMilliliters: 400 },
      });
      expect(crossOwnerUpdate.statusCode).toBe(404);

      const movedHydration = await app.inject({
        method: "PATCH",
        url: `/v1/hydration/entries/${createdHydrationBody.data.entry.id}`,
        headers: {
          authorization,
          "idempotency-key": randomUUID(),
          "if-match": '"1"',
        },
        payload: {
          amountMilliliters: 500,
          occurredAt: "2026-08-15T05:30:00.000Z",
        },
      });
      expect(movedHydration.statusCode, movedHydration.body).toBe(200);
      expect(movedHydration.headers.etag).toBe('"2"');
      expect(movedHydration.json()).toMatchObject({
        data: {
          replayed: false,
          entry: { revision: "2", localDate: "2026-08-15", amountMilliliters: 500 },
          affectedDays: expect.arrayContaining([
            { localDate: "2026-08-14", revision: "2" },
            { localDate: "2026-08-15", revision: "1" },
          ]),
        },
      });

      const oldDay = await app.inject({
        method: "GET",
        url: "/v1/hydration?date=2026-08-14",
        headers: { authorization },
      });
      expect(oldDay.statusCode, oldDay.body).toBe(200);
      const oldDayBody = oldDay.json<HydrationDayResponse>();
      expect(oldDay.headers.etag).toBe(hydrationDayEtag(oldDayBody));
      expect(oldDayBody).toMatchObject({
        data: { entries: [], revision: "2", totalMilliliters: 0 },
      });
      const newDay = await app.inject({
        method: "GET",
        url: "/v1/hydration?date=2026-08-15",
        headers: { authorization },
      });
      expect(newDay.statusCode, newDay.body).toBe(200);
      expect(newDay.json()).toMatchObject({
        data: { entries: [{ amountMilliliters: 500 }], totalMilliliters: 500 },
      });

      const deleteOperationId = randomUUID();
      const deletedHydration = await app.inject({
        method: "DELETE",
        url: `/v1/hydration/entries/${createdHydrationBody.data.entry.id}`,
        headers: {
          authorization,
          "idempotency-key": deleteOperationId,
          "if-match": '"2"',
        },
      });
      expect(deletedHydration.statusCode, deletedHydration.body).toBe(200);
      expect(deletedHydration.json()).toMatchObject({
        data: { replayed: false, entry: null },
      });
      const replayedDelete = await app.inject({
        method: "DELETE",
        url: `/v1/hydration/entries/${createdHydrationBody.data.entry.id}`,
        headers: {
          authorization,
          "idempotency-key": deleteOperationId,
          "if-match": '"2"',
        },
      });
      expect(replayedDelete.statusCode, replayedDelete.body).toBe(200);
      expect(replayedDelete.json()).toMatchObject({ data: { replayed: true, entry: null } });
      const emptyPersistedDay = await app.inject({
        method: "GET",
        url: "/v1/hydration?date=2026-08-15",
        headers: { authorization },
      });
      expect(emptyPersistedDay.statusCode, emptyPersistedDay.body).toBe(200);
      const emptyPersistedDayBody = emptyPersistedDay.json<HydrationDayResponse>();
      expect(emptyPersistedDay.headers.etag).toBe(hydrationDayEtag(emptyPersistedDayBody));
      expect(emptyPersistedDayBody).toMatchObject({
        data: { entries: [], revision: "2", totalMilliliters: 0 },
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
