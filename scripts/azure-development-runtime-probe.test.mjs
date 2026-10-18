import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "../apps/api/dist/app.js";
import { loadConfig } from "../apps/api/dist/config.js";
import { SecureAuthService } from "../apps/api/dist/modules/auth/auth-service.js";
import { DiaryNotFoundServiceError } from "../apps/api/dist/modules/diary/diary.routes.js";
import { RetentionValidationServiceError } from "../apps/api/dist/modules/retention/retention.routes.js";
import { diaryDay, diaryEntry, nutrient, profile } from "../apps/api/test/fixtures.ts";
import { CORE_NUTRIENTS } from "../packages/domain/dist/index.js";
import {
  initializeDevelopmentRuntimeJourney,
  readBackDevelopmentRuntimeJourney,
} from "./azure-development-runtime-probe.mjs";

const clone = (value) => structuredClone(value);
const unexpected = () => {
  throw new Error("Unselected fixture operation");
};
function configuration() {
  const runId = randomUUID();
  return {
    runId,
    nodeEnv: "development",
    profile: "hosted-development",
    syntheticOnly: true,
    owners: [1, 2].map((index) => ({
      email: `nourishing-${runId}-${index}@example.invalid`,
      password: `synthetic password for owner ${index}`,
    })),
    recoveryPassword: "synthetic replacement password",
    captureReview: { username: "review", password: "r".repeat(32) },
    captureSend: { username: "send", password: "s".repeat(32) },
    notAfterUtc: new Date(Date.now() + 120_000).toISOString(),
    catalogue: {
      kind: "nutrition-development-catalogue-v1",
      syntheticOnly: true,
      name: "Blueberries (synthetic sample)",
      foodId: "201",
      foodVersionId: "202",
      coreNutrients: CORE_NUTRIENTS.map((item, index) => ({
        id: String(index + 1),
        code: item.id,
        unit: item.canonicalUnit,
      })),
      fixtureExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

/** Actual route validation/serialization, auth cryptography and token/revocation logic.
 * Repository and food/diary persistence are controlled memory seams, not live acceptance. */
async function fixture(t, options = {}) {
  const config = configuration(),
    accounts = new Map(),
    sessions = new Map(),
    verification = new Map(),
    recovery = new Map();
  const messages = [],
    requests = [],
    claims = [],
    effects = [];
  let custom,
    customOwner,
    entry,
    dayRevision = "0",
    currentApp;
  const repository = {
    async register(input) {
      assert(!accounts.has(input.email));
      const account = {
        user: { id: randomUUID(), email: input.email, emailVerified: false },
        profile: { ...profile, timeZone: input.timeZone },
      };
      accounts.set(input.email, { ...input, account });
      return account;
    },
    async findPasswordCredential(email) {
      return accounts.get(email) ?? null;
    },
    async createSession(input) {
      const account = [...accounts.values()].find((row) => row.account.user.id === input.userId);
      assert(account && account.passwordHash === input.expectedPasswordHash);
      sessions.set(input.tokenHash, input);
    },
    async findActiveSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      return session && session.expiresAt > now
        ? [...accounts.values()].find((row) => row.account.user.id === session.userId).account
        : null;
    },
    async findPendingErasureRecoverySession() {
      return null;
    },
    async revokeSession(input) {
      assert(sessions.get(input.tokenHash)?.userId === input.userId);
      return sessions.delete(input.tokenHash);
    },
    createReauthenticationProof: unexpected,
    async issueEmailVerificationToken(input) {
      await input.deliver();
      verification.set(input.tokenHash, input);
      return "issued";
    },
    async confirmEmailVerificationToken(input) {
      const issued = verification.get(input.tokenHash);
      assert(issued && issued.expiresAt > input.confirmedAt);
      const row = [...accounts.values()].find((row) => row.account.user.id === issued.userId);
      row.account.user.emailVerified = true;
      verification.delete(input.tokenHash);
    },
    async issuePasswordRecoveryToken(input) {
      if (!accounts.has(input.normalizedEmail)) return "ineligible";
      await input.deliver();
      recovery.set(input.tokenHash, input);
      return "issued";
    },
    async confirmPasswordRecoveryToken(input) {
      const issued = recovery.get(input.tokenHash);
      assert(issued && issued.expiresAt > input.confirmedAt);
      const row = accounts.get(issued.normalizedEmail);
      for (const key of ["passwordHash", "passwordSalt", "passwordParameters"])
        row[key] = input[key];
      for (const [key, session] of sessions)
        if (session.userId === row.account.user.id) sessions.delete(key);
      recovery.delete(input.tokenHash);
    },
  };
  const delivery = {
    async sendVerificationEmail(input) {
      messages.push({
        ID: randomUUID(),
        To: [{ Address: input.recipient }],
        Text: `Synthetic verification\n${input.verificationUrl}\n`,
      });
    },
    async sendPasswordRecoveryEmail(input) {
      messages.push({
        ID: randomUUID(),
        To: [{ Address: input.recipient }],
        Text: `Synthetic recovery\n${input.recoveryUrl}\n`,
      });
    },
  };
  const energy = config.catalogue.coreNutrients.find((item) => item.code === "energy");
  const aggregate = (grams) => ({
    ...nutrient,
    nutrientId: energy.id,
    code: energy.code,
    knownAmount: String(Number(grams) * 0.6),
  });
  const mutation = () => ({
    data: {
      replayed: false,
      entry: clone(entry),
      affectedDays: [{ localDate: entry.localDate, revision: dayRevision }],
    },
  });
  const servicePorts = {
    foodSearchService: {
      async search(input) {
        assert.equal(input.query, "Blueberries");
        return {
          data: [
            {
              foodId: "201",
              foodVersionId: "202",
              name: config.catalogue.name,
              kind: "generic",
              brandName: null,
              marketCode: "US",
              languageTag: "en-US",
              source: {
                code: "SYNTHETIC",
                displayName: "Synthetic",
                licenseExpression: "CC0-1.0",
                attributionRequired: false,
                attributionText: "Invented fixture",
              },
              defaultServing: null,
            },
          ],
          page: { nextCursor: null },
        };
      },
      autocomplete: unexpected,
      lookupBarcode: unexpected,
    },
    retentionService: {
      async createCustomFood(input) {
        effects.push("custom");
        customOwner = input.userId;
        const now = new Date().toISOString();
        custom = {
          id: randomUUID(),
          status: "active",
          revision: "1",
          createdAt: now,
          updatedAt: now,
          currentVersion: {
            id: "501",
            versionNumber: 1,
            name: input.draft.name,
            brandName: null,
            notes: input.draft.notes,
            serving: { ...input.draft.serving, id: "601" },
            nutrients: [
              {
                nutrient: { id: energy.id, code: energy.code, name: "Energy", unit: "kcal" },
                state: "quantified",
                amountPer100Grams: "60",
              },
            ],
            provenance: { kind: "user_entered", statement: "User entered fixture" },
            createdAt: now,
          },
        };
        return { data: { replayed: false, customFood: custom } };
      },
      async getCustomFood(input) {
        return input.userId === customOwner && input.customFoodId === custom.id ? custom : null;
      },
      async logCustomFood(input) {
        if (input.userId !== customOwner)
          throw new RetentionValidationServiceError(
            "Food version is unavailable for diary logging",
          );
        effects.push("log");
        assert.equal(input.expectedProfileTimeZone, "UTC");
        const instant = input.entry.occurredAt;
        entry = {
          ...clone(diaryEntry),
          id: randomUUID(),
          revision: "1",
          foodVersionId: custom.currentVersion.id,
          portion: input.entry.portion,
          food: { name: custom.currentVersion.name, brandName: null },
          source: null,
          foodProvenance: {
            kind: "private_custom",
            customFoodId: custom.id,
            customFoodVersionNumber: 1,
          },
          resolvedGrams: "75",
          occurredAt: instant,
          localDate: instant.slice(0, 10),
          localTime: instant.slice(11, -1),
          timeZone: "UTC",
          nutrients: [aggregate("75")],
        };
        dayRevision = "1";
        return mutation();
      },
    },
    diaryService: {
      async getDayPage(input) {
        const own = input.userId === customOwner && entry;
        return {
          data: {
            ...clone(diaryDay),
            id: own ? diaryDay.id : null,
            timeZone: "UTC",
            localDate: input.localDate,
            revision: own ? dayRevision : "0",
            entries: own ? [clone(entry)] : [],
            totals: own ? clone(entry.nutrients) : [],
            updatedAt: own ? entry.occurredAt : null,
          },
          page: { nextCursor: null, totalEntries: own ? 1 : 0 },
        };
      },
      async updateEntryCorrection(input) {
        if (input.userId !== customOwner) throw new DiaryNotFoundServiceError();
        effects.push("edit");
        assert.equal(input.expectedRevision, entry.revision);
        const previous = entry.revision;
        entry = {
          ...entry,
          revision: "2",
          resolvedGrams: "125",
          portion: input.patch.portion,
          note: input.patch.note,
          nutrients: [aggregate("125")],
        };
        dayRevision = "2";
        const result = mutation();
        result.data.receipt = {
          protocol: "v1",
          operationId: input.clientOperationId,
          kind: "update",
          expectedSubjects: [{ entryId: entry.id, revision: previous }],
          resultSubjects: [{ entryId: entry.id, revision: "2", state: "active" }],
          affectedDays: result.data.affectedDays,
        };
        return result;
      },
      createEntry: unexpected,
      deleteEntryCorrection: unexpected,
    },
  };
  const start = () =>
    buildApp({
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      logger: false,
      authService: new SecureAuthService({
        repository,
        emailVerificationDelivery: delivery,
        passwordRecoveryDelivery: delivery,
        emailVerificationPublicOrigin: "https://localhost:3443",
        passwordRecoveryPublicOrigin: "https://localhost:3443",
      }),
      ...servicePorts,
    });
  currentApp = start();
  t.after(() => currentApp.close());
  const http = {
    async request(channel, path, init = {}) {
      requests.push([channel, path, init.method ?? "GET"]);
      if (channel === "api") {
        const result = await currentApp.inject({
          method: init.method ?? "GET",
          url: path,
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(init.body ? { payload: init.body } : {}),
        });
        return new Response(result.statusCode === 204 ? null : result.body, {
          status: result.statusCode,
          headers: result.headers,
        });
      }
      assert.equal(channel, "capture");
      assert.equal(init.method ?? "GET", "GET");
      const header = new Headers(init.headers).get("authorization");
      if (
        header ===
        `Basic ${Buffer.from(`${config.captureSend.username}:${config.captureSend.password}`).toString("base64")}`
      )
        return options.allowSendReview
          ? Response.json({ messages, total: messages.length })
          : new Response("Denied", {
              status: 401,
              headers: { "www-authenticate": 'Basic realm="Mailpit"' },
            });
      assert.equal(
        header,
        `Basic ${Buffer.from(`${config.captureReview.username}:${config.captureReview.password}`).toString("base64")}`,
      );
      if (path.startsWith("/api/v1/messages?"))
        return Response.json({
          messages: messages.map(({ ID, To }) => ({ ID, To })),
          total: messages.length,
        });
      const message = messages.find((item) => path === `/api/v1/message/${item.ID}`);
      assert(message);
      return Response.json({
        ...message,
        ...(options.wrongRecipient ? { To: [{ Address: "unowned@example.invalid" }] } : {}),
      });
    },
  };
  return {
    config,
    requests,
    messages,
    claims,
    effects,
    accounts,
    sessions,
    input: {
      configuration: config,
      signal: new AbortController().signal,
      http,
      async onMutationStart(phase) {
        claims.push(phase);
        if (options.claimFailure) throw new Error("Durability unavailable");
      },
    },
    async restart({ loseDiary = false } = {}) {
      await currentApp.close();
      if (loseDiary) entry = undefined;
      currentApp = start();
    },
  };
}

test("actual API protocols complete verification, search, create/log/edit, owner denial, password recovery and restart readback", {
  timeout: 30_000,
}, async (t) => {
  const f = await fixture(t);
  const result = await initializeDevelopmentRuntimeJourney(f.input);
  assert.deepEqual(f.effects, ["custom", "log", "edit"]);
  assert.equal(f.messages.length, 3);
  assert.equal(f.sessions.size, 0);
  const serialized = JSON.stringify(result);
  for (const password of [
    ...f.config.owners.map((item) => item.password),
    f.config.recoveryPassword,
  ])
    assert(!serialized.includes(password));
  for (const message of f.messages) assert(!serialized.includes(message.Text));
  await f.restart();
  const readback = await readBackDevelopmentRuntimeJourney(f.input, result);
  assert.equal(readback.persisted, true);
  assert.equal(f.sessions.size, 0);
  assert.equal(readback.entryRevision, "2");
  assert.equal(readback.diarySha256.length, 64);
});

test("a failed durable mutation claim prevents even first registration", async (t) => {
  const f = await fixture(t, { claimFailure: true });
  await assert.rejects(initializeDevelopmentRuntimeJourney(f.input), /Durability unavailable/u);
  assert.equal(f.accounts.size, 0);
  assert.deepEqual(f.requests, [["api", "/ready", "GET"]]);
});

for (const [label, options] of Object.entries({
  sendCanReview: { allowSendReview: true },
  wrongRecipient: { wrongRecipient: true },
}))
  test(`capture ${label} prevents verification and all food mutation`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(initializeDevelopmentRuntimeJourney(f.input));
    assert.deepEqual(f.effects, []);
    assert(!f.claims.includes("confirm-verification"));
  });

test("lost diary after controlled application recreation cannot produce persistence receipt", {
  timeout: 30_000,
}, async (t) => {
  const f = await fixture(t);
  const result = await initializeDevelopmentRuntimeJourney(f.input);
  await f.restart({ loseDiary: true });
  await assert.rejects(readBackDevelopmentRuntimeJourney(f.input, result));
});

test("wrong profile, recipient, expired lease and pre-cancellation reject before HTTP", async (t) => {
  for (const mutate of [
    (f) => {
      f.config.profile = "production";
    },
    (f) => {
      f.config.owners[0].email = "unowned@example.invalid";
    },
    (f) => {
      f.config.notAfterUtc = new Date(Date.now() - 1000).toISOString();
    },
    (f) => {
      f.input.signal = AbortSignal.abort();
    },
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(initializeDevelopmentRuntimeJourney(f.input));
    assert.equal(f.requests.length, 0);
  }
});
