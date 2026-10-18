/** Real HTTP journey for a separately admitted private synthetic runtime; never a production client. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  authCredentialsRequestSchema,
  canonicalJson,
  createCustomFoodDiaryEntryRequestSchema,
  currentAccountResponseSchema,
  customFoodDraftRequestSchema,
  customFoodMutationResponseSchema,
  diaryCorrectionMutationResponseSchema,
  diaryDayResponseSchema,
  diaryEntrySchema,
  diaryMutationResponseSchema,
  emailVerificationConfirmRequestSchema,
  emailVerificationConfirmResponseSchema,
  emailVerificationRequestResponseSchema,
  foodSearchPageSchema,
  passwordRecoveryConfirmRequestSchema,
  passwordRecoveryConfirmResponseSchema,
  passwordRecoveryRequestResponseSchema,
  passwordRecoveryRequestSchema,
  problemDetailsSchema,
  registerAccountRequestSchema,
  sessionCreatedResponseSchema,
  updateDiaryEntryRequestSchema,
} from "../packages/contracts/dist/index.js";

const schemas = {
  authCredentialsRequestSchema,
  createCustomFoodDiaryEntryRequestSchema,
  currentAccountResponseSchema,
  customFoodDraftRequestSchema,
  customFoodMutationResponseSchema,
  diaryCorrectionMutationResponseSchema,
  diaryDayResponseSchema,
  diaryEntrySchema,
  diaryMutationResponseSchema,
  emailVerificationConfirmRequestSchema,
  emailVerificationConfirmResponseSchema,
  emailVerificationRequestResponseSchema,
  foodSearchPageSchema,
  passwordRecoveryConfirmRequestSchema,
  passwordRecoveryConfirmResponseSchema,
  passwordRecoveryRequestResponseSchema,
  passwordRecoveryRequestSchema,
  problemDetailsSchema,
  registerAccountRequestSchema,
  sessionCreatedResponseSchema,
  updateDiaryEntryRequestSchema,
};

const require = createRequire(new URL("../packages/contracts/package.json", import.meta.url));
const Ajv = require("ajv").default,
  addFormats = require("ajv-formats").default;
const validators = new Map();
const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function validate(name, value) {
  if (!validators.has(name)) {
    assert(Object.hasOwn(schemas, name), "Missing maintained journey contract");
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    validators.set(name, ajv.compile(schemas[name]));
  }
  assert(validators.get(name)(value), "Development journey contract observation failed");
  return value;
}
function context(input) {
  const config = JSON.parse(JSON.stringify(input.configuration));
  const { http, onMutationStart } = input;
  let { signal } = input;
  assert(
    signal instanceof AbortSignal &&
      typeof http?.request === "function" &&
      typeof onMutationStart === "function",
  );
  assert(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(config.runId),
  );
  assert(
    config.nodeEnv === "development" &&
      config.profile === "hosted-development" &&
      config.syntheticOnly === true,
  );
  assert(Array.isArray(config.owners) && config.owners.length === 2);
  for (const [index, owner] of config.owners.entries()) {
    assert(owner.email === `nourishing-${config.runId}-${index + 1}@example.invalid`);
    validate("registerAccountRequestSchema", {
      email: owner.email,
      password: owner.password,
      timeZone: "UTC",
    });
  }
  assert(
    config.owners[0].password !== config.owners[1].password &&
      typeof config.recoveryPassword === "string" &&
      config.recoveryPassword !== config.owners[0].password &&
      config.recoveryPassword !== config.owners[1].password,
  );
  validate("authCredentialsRequestSchema", {
    email: config.owners[0].email,
    password: config.recoveryPassword,
  });
  for (const auth of [config.captureReview, config.captureSend])
    assert(
      auth &&
        /^[A-Za-z0-9._-]{1,128}$/u.test(auth.username) &&
        /^[A-Za-z0-9_-]{32,256}$/u.test(auth.password),
    );
  assert(
    config.captureReview.username !== config.captureSend.username &&
      config.captureReview.password !== config.captureSend.password,
  );
  const catalogue = config.catalogue;
  assert(
    catalogue?.kind === "nutrition-development-catalogue-v1" &&
      catalogue.syntheticOnly === true &&
      catalogue.name === "Blueberries (synthetic sample)" &&
      /^[1-9][0-9]*$/u.test(catalogue.foodId) &&
      /^[1-9][0-9]*$/u.test(catalogue.foodVersionId) &&
      catalogue.coreNutrients.length === 15,
  );
  assert(Date.parse(catalogue.fixtureExpiresAt) > Date.now());
  const energy = catalogue.coreNutrients.filter((nutrient) => nutrient.code === "energy");
  assert(energy.length === 1 && energy[0].unit === "kcal");
  const stop = Date.parse(config.notAfterUtc),
    start = Date.now(),
    mono = performance.now();
  assert(
    new Date(stop).toISOString() === config.notAfterUtc && stop > start && stop - start <= 300_000,
  );
  signal = AbortSignal.any([signal, AbortSignal.timeout(stop - start)]);
  const guard = () => {
    signal.throwIfAborted();
    assert(Date.now() >= start && Date.now() < stop && performance.now() - mono < stop - start);
    assert(Date.parse(catalogue.fixtureExpiresAt) > Date.now());
  };
  const mark = async (phase) => {
    guard();
    await onMutationStart(phase, signal);
    guard();
  };
  const auth = (credential) =>
    `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  async function api(
    path,
    status,
    schema,
    { method = "GET", body, token, operation, revision, timeZone } = {},
  ) {
    guard();
    const headers = {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(operation ? { "idempotency-key": operation } : {}),
      ...(revision ? { "if-match": `"${revision}"` } : {}),
      ...(timeZone ? { "x-expected-profile-time-zone": "UTC" } : {}),
    };
    const response = await http.request("api", path, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    guard();
    assert(response.status === status && response.headers.get("cache-control") === "no-store");
    if (status === 204) {
      assert((await response.text()) === "");
      return null;
    }
    assert(
      response.headers.get("content-type")?.split(";", 1)[0] ===
        (schema === "problemDetailsSchema" ? "application/problem+json" : "application/json"),
    );
    const result = await response.json();
    return validate(schema, result);
  }
  async function ready() {
    guard();
    const response = await http.request("api", "/ready", { signal });
    assert(response.status === 200 && canonicalJson(await response.json()) === '{"status":"ok"}');
    guard();
  }
  async function login(owner, password = owner.password) {
    await mark("login");
    const result = await api("/v1/auth/login", 200, "sessionCreatedResponseSchema", {
      method: "POST",
      body: validate("authCredentialsRequestSchema", { email: owner.email, password }),
    });
    assert(result.data.user.email === owner.email && result.data.profile.timeZone === "UTC");
    return result.data;
  }
  async function captureToken(recipient, route) {
    const candidates = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      guard();
      const response = await http.request("capture", "/api/v1/messages?start=0&limit=50", {
        signal,
        headers: { authorization: auth(config.captureReview) },
      });
      assert(response.status === 200);
      const listed = await response.json();
      assert(
        Array.isArray(listed.messages) &&
          listed.messages.length <= 50 &&
          Number.isSafeInteger(listed.total) &&
          listed.total <= 50,
      );
      const matches = listed.messages.filter(
        (message) =>
          Array.isArray(message.To) &&
          message.To.length === 1 &&
          message.To[0]?.Address === recipient,
      );
      assert(matches.length <= 2);
      for (const message of matches) {
        assert(typeof message.ID === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(message.ID));
        const detail = await http.request("capture", `/api/v1/message/${message.ID}`, {
          signal,
          headers: { authorization: auth(config.captureReview) },
        });
        assert(detail.status === 200);
        const observed = await detail.json();
        assert(
          observed.ID === message.ID &&
            typeof observed.Text === "string" &&
            Array.isArray(observed.To) &&
            observed.To.length === 1 &&
            observed.To[0]?.Address === recipient,
        );
        const links = observed.Text.match(/https?:\/\/[^\s<>"]+/gu) ?? [];
        for (const value of links) {
          const link = new URL(value);
          assert(
            link.origin === "https://localhost:3443" &&
              !link.search &&
              ["/verify-email", "/reset-password"].includes(link.pathname),
          );
          if (link.pathname !== route) continue;
          const token = link.hash.slice(7);
          assert(
            link.hash === `#token=${token}` &&
              Buffer.from(token, "base64url").length === 32 &&
              Buffer.from(token, "base64url").toString("base64url") === token,
          );
          candidates.push({
            id: message.ID,
            token,
            sha256: createHash("sha256").update(observed.Text).digest("hex"),
          });
        }
      }
      if (candidates.length) {
        assert(candidates.length === 1);
        break;
      }
      await delay(100, undefined, { signal });
    }
    assert(candidates.length === 1);
    // Review access works above; the same owned message must remain hidden from the send-only identity.
    for (const path of [
      "/api/v1/messages?start=0&limit=50",
      `/api/v1/message/${candidates[0].id}`,
    ]) {
      const denied = await http.request("capture", path, {
        signal,
        headers: { authorization: auth(config.captureSend) },
      });
      assert(
        denied.status === 401 && /^Basic /iu.test(denied.headers.get("www-authenticate") ?? ""),
      );
    }
    guard();
    return candidates[0];
  }
  async function day(token, date) {
    const seen = new Set(),
      entries = [];
    let cursor = null,
      snapshot;
    for (let page = 0; page < 3; page++) {
      const query = new URLSearchParams({ date, limit: "20", ...(cursor ? { cursor } : {}) });
      const result = await api(`/v1/diary/?${query}`, 200, "diaryDayResponseSchema", { token });
      const metadata = { ...result.data, entries: [] };
      if (snapshot) assert(digest(metadata) === digest(snapshot));
      else snapshot = metadata;
      for (const entry of result.data.entries) {
        assert(!seen.has(entry.id));
        seen.add(entry.id);
        entries.push(entry);
      }
      cursor = result.page.nextCursor;
      if (cursor === null) {
        assert(entries.length === result.page.totalEntries);
        return { metadata, entries };
      }
      assert(typeof cursor === "string" && entries.length <= 50);
    }
    throw new Error("Development journey exceeded diary page budget");
  }
  return { config, energy: energy[0], guard, mark, api, ready, login, captureToken, day };
}

/** Protected inputs/identity and create-only stage intent must be durable before this call. No mutation retries. */
export async function initializeDevelopmentRuntimeJourney(input) {
  const c = context(input),
    { config, api, mark, energy } = c;
  await c.ready();
  const accounts = [],
    captureEvidence = [];
  for (const owner of config.owners) {
    await mark("register");
    const registered = await api("/v1/auth/register", 201, "sessionCreatedResponseSchema", {
      method: "POST",
      body: validate("registerAccountRequestSchema", {
        email: owner.email,
        password: owner.password,
        timeZone: "UTC",
      }),
    });
    assert(
      registered.data.user.email === owner.email && registered.data.profile.timeZone === "UTC",
    );
    await mark("request-verification");
    await api(
      "/v1/auth/email-verification/request",
      202,
      "emailVerificationRequestResponseSchema",
      {
        method: "POST",
        token: registered.data.accessToken,
      },
    );
    const capture = await c.captureToken(owner.email, "/verify-email");
    await mark("confirm-verification");
    await api(
      "/v1/auth/email-verification/confirm",
      200,
      "emailVerificationConfirmResponseSchema",
      {
        method: "POST",
        body: validate("emailVerificationConfirmRequestSchema", { token: capture.token }),
      },
    );
    const account = await api("/v1/auth/me", 200, "currentAccountResponseSchema", {
      token: registered.data.accessToken,
    });
    assert(
      account.data.user.id === registered.data.user.id && account.data.user.emailVerified === true,
    );
    await mark("logout-registration");
    await api("/v1/auth/logout", 204, null, { method: "POST", token: registered.data.accessToken });
    await api("/v1/auth/me", 401, "problemDetailsSchema", { token: registered.data.accessToken });
    const logged = await c.login(owner);
    assert(logged.user.id === account.data.user.id);
    accounts.push(logged);
    captureEvidence.push({ id: capture.id, sha256: capture.sha256 });
  }
  assert(accounts[0].user.id !== accounts[1].user.id);
  const token = accounts[0].accessToken,
    other = accounts[1].accessToken;
  const searched = await api(
    "/v1/foods/search?query=Blueberries&limit=20",
    200,
    "foodSearchPageSchema",
    { token },
  );
  assert(
    searched.page.nextCursor === null &&
      searched.data.length === 1 &&
      searched.data[0].foodId === config.catalogue.foodId &&
      searched.data[0].foodVersionId === config.catalogue.foodVersionId,
  );
  const draft = validate("customFoodDraftRequestSchema", {
    name: `Synthetic runtime food ${config.runId}`,
    brandName: null,
    serving: { label: "100 g", grams: "100" },
    nutrients: [{ nutrientId: energy.id, state: "quantified", amountPer100Grams: "60" }],
    notes: "Synthetic runtime acceptance fixture",
  });
  await mark("create-custom-food");
  const custom = (
    await api("/v1/custom-foods", 201, "customFoodMutationResponseSchema", {
      method: "POST",
      body: draft,
      token,
      operation: randomUUID(),
    })
  ).data.customFood;
  const occurredAt = new Date().toISOString();
  const entryRequest = validate("createCustomFoodDiaryEntryRequestSchema", {
    customFoodVersionId: custom.currentVersion.id,
    portion: { kind: "grams", grams: "75" },
    mealSlot: "breakfast",
    occurredAt,
  });
  await mark("log-custom-food");
  const logged = await api(
    `/v1/custom-foods/${custom.id}/log?profileTimeZonePrecondition=v1`,
    201,
    "diaryMutationResponseSchema",
    {
      method: "POST",
      body: entryRequest,
      token,
      operation: randomUUID(),
      timeZone: true,
    },
  );
  const entry = logged.data.entry;
  assert(
    entry &&
      entry.foodVersionId === custom.currentVersion.id &&
      entry.foodProvenance.kind === "private_custom" &&
      entry.foodProvenance.customFoodId === custom.id &&
      entry.foodProvenance.customFoodVersionNumber === 1 &&
      entry.timeZone === "UTC" &&
      entry.localDate === occurredAt.slice(0, 10) &&
      entry.note === null &&
      entry.resolvedGrams === "75" &&
      entry.nutrients.find((item) => item.code === "energy")?.knownAmount === "45",
  );
  const patch = validate("updateDiaryEntryRequestSchema", {
    portion: { kind: "grams", grams: "125" },
    note: "Synthetic persistent diary",
  });
  await mark("edit-diary");
  const corrected = await api(
    `/v1/diary/entries/${entry.id}?diaryCorrectionProtocol=v1`,
    200,
    "diaryCorrectionMutationResponseSchema",
    {
      method: "PATCH",
      body: patch,
      token,
      revision: entry.revision,
      operation: randomUUID(),
    },
  );
  const edited = corrected.data.entry;
  assert(
    edited &&
      edited.id === entry.id &&
      BigInt(edited.revision) > BigInt(entry.revision) &&
      edited.foodVersionId === custom.currentVersion.id &&
      digest(edited.foodProvenance) === digest(entry.foodProvenance) &&
      edited.note === patch.note &&
      digest(edited.portion) === digest(patch.portion) &&
      edited.localDate === entry.localDate &&
      edited.timeZone === "UTC" &&
      edited.resolvedGrams === "125" &&
      edited.nutrients.find((item) => item.code === "energy")?.knownAmount === "75",
  );
  const denials = [
    [`/v1/custom-foods/${custom.id}`, {}, 404, "NOT_FOUND"],
    [
      `/v1/custom-foods/${custom.id}/log?profileTimeZonePrecondition=v1`,
      {
        method: "POST",
        body: entryRequest,
        operation: randomUUID(),
        timeZone: true,
      },
      422,
      "VALIDATION_ERROR",
    ],
    [
      `/v1/diary/entries/${edited.id}?diaryCorrectionProtocol=v1`,
      {
        method: "PATCH",
        body: patch,
        revision: edited.revision,
        operation: randomUUID(),
      },
      404,
      "NOT_FOUND",
    ],
  ];
  for (const [path, options, status, code] of denials) {
    await mark("cross-owner-denial");
    const result = await api(path, status, "problemDetailsSchema", { ...options, token: other });
    assert(result.code === code);
  }
  const before = await c.day(token, edited.localDate);
  assert(
    before.entries.length === 1 &&
      digest(before.entries[0]) === digest(edited) &&
      before.metadata.localDate === edited.localDate &&
      before.metadata.timeZone === "UTC" &&
      before.metadata.status === "open",
  );
  const totalEnergy = before.metadata.totals.filter((item) => item.nutrientId === energy.id);
  assert(
    totalEnergy.length === 1 &&
      totalEnergy[0].knownAmount === "75" &&
      totalEnergy[0].completeness === "complete" &&
      totalEnergy[0].isExact &&
      totalEnergy[0].contributorCount === 1,
  );
  assert((await c.day(other, edited.localDate)).entries.length === 0);
  await mark("request-password-recovery");
  await api("/v1/auth/password-recovery/request", 202, "passwordRecoveryRequestResponseSchema", {
    method: "POST",
    body: validate("passwordRecoveryRequestSchema", { email: config.owners[0].email }),
  });
  const recovered = await c.captureToken(config.owners[0].email, "/reset-password");
  captureEvidence.push({ id: recovered.id, sha256: recovered.sha256 });
  await mark("confirm-password-recovery");
  await api("/v1/auth/password-recovery/confirm", 200, "passwordRecoveryConfirmResponseSchema", {
    method: "POST",
    body: validate("passwordRecoveryConfirmRequestSchema", {
      token: recovered.token,
      newPassword: config.recoveryPassword,
    }),
  });
  const revoked = await api("/v1/auth/me", 401, "problemDetailsSchema", { token });
  assert(revoked.code === "UNAUTHORIZED");
  await mark("old-password-denial");
  await api("/v1/auth/login", 401, "problemDetailsSchema", {
    method: "POST",
    body: { email: config.owners[0].email, password: config.owners[0].password },
  });
  const fresh = await c.login(config.owners[0], config.recoveryPassword);
  assert(fresh.user.id === accounts[0].user.id && fresh.user.emailVerified);
  assert(digest(await c.day(fresh.accessToken, edited.localDate)) === digest(before));
  for (const accessToken of [fresh.accessToken, other]) {
    await mark("logout");
    await api("/v1/auth/logout", 204, null, { method: "POST", token: accessToken });
    await api("/v1/auth/me", 401, "problemDetailsSchema", { token: accessToken });
  }
  c.guard();
  return Object.freeze({
    kind: "nutrition-development-journey-v1",
    runId: config.runId,
    syntheticOnly: true,
    ownerIds: accounts.map((account) => account.user.id),
    customFoodId: custom.id,
    localDate: edited.localDate,
    entryId: edited.id,
    entryRevision: edited.revision,
    diary: before,
    captureEvidence,
  });
}

/** Read-only diary proof after the controller has restarted only its reverified owned application IDs. */
export async function readBackDevelopmentRuntimeJourney(input, original) {
  const c = context(input);
  const state = JSON.parse(JSON.stringify(original));
  assert(
    state.kind === "nutrition-development-journey-v1" &&
      state.runId === c.config.runId &&
      state.syntheticOnly === true &&
      state.ownerIds.length === 2 &&
      state.ownerIds[0] !== state.ownerIds[1] &&
      state.diary.entries.length === 1 &&
      state.diary.entries[0].id === state.entryId,
  );
  validate("diaryEntrySchema", state.diary.entries[0]);
  await c.ready();
  const owner = await c.login(c.config.owners[0], c.config.recoveryPassword);
  const other = await c.login(c.config.owners[1]);
  assert(
    owner.user.id === state.ownerIds[0] &&
      other.user.id === state.ownerIds[1] &&
      owner.user.emailVerified &&
      other.user.emailVerified,
  );
  assert(digest(await c.day(owner.accessToken, state.localDate)) === digest(state.diary));
  assert((await c.day(other.accessToken, state.localDate)).entries.length === 0);
  for (const token of [owner.accessToken, other.accessToken]) {
    await c.mark("logout");
    await c.api("/v1/auth/logout", 204, null, { method: "POST", token });
    await c.api("/v1/auth/me", 401, "problemDetailsSchema", { token });
  }
  c.guard();
  return Object.freeze({
    kind: "nutrition-development-journey-readback-v1",
    runId: state.runId,
    entryId: state.entryId,
    entryRevision: state.entryRevision,
    diarySha256: digest(state.diary),
    persisted: true,
  });
}
