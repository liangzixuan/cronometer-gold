/**
 * Populates only the selected isolated walkthrough through actual application routes.
 * Required environment: WALKTHROUGH_RUN_ID, WALKTHROUGH_API_ORIGIN (loopback),
 * WALKTHROUGH_EVIDENCE_DIR=<private WSL directory containing synthetic-catalogue.json>.
 * Run with existing Node, after root starts the real API. No .env is read.
 * --validate-only checks all request shapes offline with installed contract schemas.
 * Fresh-only, bounded and no automatic retries: partial failures retain their receipts.
 * Credentials are newly generated and saved mode0600; session token remains in memory.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as contracts from "../../packages/contracts/dist/index.js";

const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
const { Ajv } = require("ajv");
const addFormats = require("ajv-formats");
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const zone = "America/Chicago";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[1-9][0-9]{0,19}$/;
let currentStep = "preflight";
let eventPath;

function checked(schema, body) {
  assert(ajv.compile(schema)(body), "Request does not match its existing contract");
  return body;
}
function localDate(instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
// These UTC times fall within the requested Chicago date in both winter and summer.
function instant(date, hour) {
  const value = `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  assert(localDate(new Date(value)) === date, "Timestamp crossed a profile-local day");
  return value;
}
function foodByName(catalogue, name) {
  const food = catalogue.foods.find((row) => row.name === `${name} (synthetic sample)`);
  assert(food && identifierPattern.test(food.foodVersionId), "Synthetic food is missing");
  const serving = food.servings.find((row) => row.isDefault);
  assert(serving && identifierPattern.test(serving.id), "Default synthetic serving is missing");
  return { food, serving };
}
function foodBody(catalogue, name, amount, date, hour, mealSlot) {
  const { food, serving } = foodByName(catalogue, name);
  return checked(contracts.createDiaryEntryRequestSchema, {
    foodVersionId: food.foodVersionId,
    portion: { kind: "serving", servingId: serving.id, amount },
    mealSlot,
    occurredAt: instant(date, hour),
  });
}
function goalBody(catalogue, from, userId) {
  const targets = { protein: "100", carbohydrate: "230", fat: "65", fiber: "28", calcium: "900" };
  return checked(contracts.nutritionGoalDraftRequestSchema, {
    effectiveFrom: from,
    expectedOwnerUserId: userId,
    energy: {
      mode: "fixed",
      targetKcal: "1900",
      rationale: "Invented walkthrough target; not a personal nutrition recommendation.",
    },
    nutrientTargets: Object.entries(targets).map(([code, targetAmount]) => {
      const nutrient = catalogue.coreNutrients.find((row) => row.code === code);
      assert(nutrient && identifierPattern.test(nutrient.id), "Synthetic nutrient is missing");
      return {
        nutrientId: nutrient.id,
        minimumAmount: null,
        targetAmount,
        maximumAmount: null,
        source: { label: "Synthetic walkthrough choice", version: "1" },
        rationale: "Demonstration value only.",
      };
    }),
  });
}
function recipeBody(catalogue) {
  return checked(contracts.recipeDraftRequestSchema, {
    name: "Chicken rice bowl (synthetic sample)",
    description: "Invented demonstration recipe using the explicitly synthetic catalogue.",
    instructions:
      "Combine the sample chicken, rice and broccoli. Values are demonstration fixtures.",
    ingredients: [
      ["Grilled chicken", "150"],
      ["Brown rice", "190"],
      ["Broccoli", "90"],
    ].map(([name, grams], position) => ({
      kind: "food",
      foodVersionId: foodByName(catalogue, name).food.foodVersionId,
      portion: { kind: "grams", grams },
      position,
      note: null,
    })),
    finalYield: { grams: "430", source: "estimated" },
    servingCount: "2",
    servingLabel: "bowl",
  });
}
function definitionBody() {
  return checked(contracts.biometricDefinitionDraftRequestSchema, {
    name: "Weight (synthetic sample)",
    dimension: "mass",
    canonicalUnit: "kg",
    notes: "Invented readings for the walkthrough; no personal measurements.",
  });
}
function dayBodies(catalogue, date, index, recipeVersionId, definitionId) {
  const foods = [
    foodBody(catalogue, "Rolled oats", index % 2 ? "1.5" : "1", date, 13, "breakfast"),
    foodBody(catalogue, "Greek yogurt", "1", date, 13, "breakfast"),
    foodBody(catalogue, index % 2 ? "Grilled chicken" : "Salmon", "1.5", date, 23, "dinner"),
    foodBody(catalogue, "Banana", "1", date, 20, "snacks"),
    foodBody(catalogue, "Almonds", index % 3 ? "1" : "1.5", date, 20, "snacks"),
  ];
  const recipe = checked(contracts.createRecipeDiaryEntryRequestSchema, {
    recipeVersionId,
    portion: { kind: "serving", amount: index % 2 ? "2" : "1.5" },
    mealSlot: "lunch",
    occurredAt: instant(date, 18),
  });
  const weight = checked(contracts.biometricEventDraftRequestSchema, {
    definitionId,
    measuredAt: instant(date, 12),
    value: ["72.4", "72.3", "72.5", "72.2", "72.3", "72.1", "72.2"][index],
  });
  const hydration = checked(contracts.createHydrationEntryRequestSchema, {
    amountMilliliters: 1500 + (index % 3) * 250,
    occurredAt: instant(date, 19),
  });
  return { foods, recipe, weight, hydration };
}
async function privateJson(path) {
  const info = await lstat(path);
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o777) === 0o600 &&
      info.size > 0 &&
      info.size < 262144,
    "Input receipt must be a small owner-private regular file",
  );
  return JSON.parse(await readFile(path, "utf8"));
}
async function boundedResponseJson(response) {
  assert(response.body, "API response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2097152) {
        await reader.cancel();
        throw new Error("API response exceeded the fixture bound");
      }
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
    );
  } finally {
    reader.releaseLock();
  }
}
async function record(event) {
  const row = { at: new Date().toISOString(), ...event };
  if (eventPath) await appendFile(eventPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(row));
}
async function offline() {
  const names = [
    "Rolled oats",
    "Greek yogurt",
    "Grilled chicken",
    "Salmon",
    "Banana",
    "Almonds",
    "Brown rice",
    "Broccoli",
  ];
  const catalogue = {
    foods: names.map((name, index) => ({
      name: `${name} (synthetic sample)`,
      foodVersionId: String(index + 1),
      servings: [{ id: String(index + 20), isDefault: true }],
    })),
    coreNutrients: ["protein", "carbohydrate", "fat", "fiber", "calcium"].map((code, index) => ({
      code,
      id: String(index + 1),
    })),
  };
  const id = randomUUID();
  checked(contracts.registerAccountRequestSchema, {
    email: "walkthrough-offline@example.invalid",
    password: "Synthetic-only-offline-password-123",
    displayName: "Synthetic walkthrough",
    timeZone: zone,
  });
  goalBody(catalogue, "2026-09-19", id);
  recipeBody(catalogue);
  definitionBody();
  for (let index = 0; index < 7; index++)
    dayBodies(catalogue, shiftDate("2026-09-19", index), index, id, id);
  await record({
    step: "offline-validation",
    passed: true,
    serviceAccess: false,
    diaryEntries: 42,
    days: 7,
    recipes: 1,
    goals: 1,
    weightReadings: 7,
    hydrationEntries: 7,
  });
}
async function main() {
  assert(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === "--validate-only"),
    "Unsupported arguments",
  );
  if (process.argv[2] === "--validate-only") return offline();
  const origin = process.env.WALKTHROUGH_API_ORIGIN;
  const api = new URL(origin);
  assert(
    api.protocol === "http:" &&
      api.hostname === "127.0.0.1" &&
      Number(api.port) >= 1024 &&
      Number(api.port) <= 65535 &&
      origin === `http://127.0.0.1:${api.port}`,
    "Only the selected loopback API origin is accepted",
  );
  const directory = process.env.WALKTHROUGH_EVIDENCE_DIR;
  assert(
    directory?.startsWith("/") &&
      !directory.startsWith("/mnt/") &&
      (await realpath(directory)) === directory,
  );
  const info = await lstat(directory);
  assert(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o777) === 0o700,
    "Evidence directory must be owner-only",
  );
  const runtime = await privateJson(join(directory, "runtime.json"));
  assert(
    runtime.version === 1 &&
      runtime.syntheticOnly === true &&
      runtime.runtime === directory &&
      runtime.runId === process.env.WALKTHROUGH_RUN_ID &&
      String(runtime.ports.api) === api.port,
    "API target must match the selected runtime",
  );
  const catalogue = await privateJson(join(directory, "synthetic-catalogue.json"));
  assert(
    catalogue.syntheticOnly === true &&
      catalogue.schemaVersion === 1 &&
      catalogue.runId === runtime.runId &&
      /^[a-z0-9]{8,32}$/.test(catalogue.runId) &&
      catalogue.foods.length === 12 &&
      catalogue.coreNutrients.length === 15,
  );
  assert(
    Date.parse(catalogue.fixtureExpiresAt) > Date.now() + 10 * 60000,
    "Synthetic catalogue is expired or about to expire",
  );
  eventPath = join(directory, "account-population-events.jsonl");
  await writeFile(eventPath, "", { flag: "wx", mode: 0o600 });
  const credentialsPath = join(directory, "walkthrough-account-credentials.json");
  const credentials = {
    email: `walkthrough-${catalogue.runId}@example.invalid`,
    password: `Demo-${randomBytes(24).toString("base64url")}-9aA`,
    displayName: "Synthetic walkthrough",
    timeZone: zone,
  };
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  let token;
  async function request(step, path, schema, body, profileGuard = false) {
    currentStep = step;
    if (schema) checked(schema, body);
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) {
      headers["content-type"] = "application/json";
      if (token) headers["idempotency-key"] = randomUUID();
    }
    if (profileGuard) headers["x-expected-profile-time-zone"] = zone;
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers,
      redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const result = await boundedResponseJson(response);
    if (!response.ok) {
      const code =
        typeof result.code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.code)
          ? result.code
          : "UNSPECIFIED";
      await record({ step, status: response.status, passed: false, code });
      throw new Error("API request failed");
    }
    await record({ step, status: response.status, passed: true });
    return result;
  }
  const registration = await request(
    "register-demonstration-account",
    "/v1/auth/register",
    contracts.registerAccountRequestSchema,
    credentials,
  );
  assert(
    uuidPattern.test(registration.data?.user?.id) &&
      registration.data?.profile?.timeZone === zone &&
      typeof registration.data?.accessToken === "string",
    "Registration receipt is incomplete",
  );
  token = registration.data.accessToken;
  const today = localDate(new Date());
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
  await request(
    "create-manual-goals",
    "/v1/goals",
    contracts.nutritionGoalDraftRequestSchema,
    goalBody(catalogue, dates[0], registration.data.user.id),
  );
  const recipeResponse = await request(
    "create-saved-recipe",
    "/v1/recipes",
    contracts.recipeDraftRequestSchema,
    recipeBody(catalogue),
  );
  const recipe = recipeResponse.data?.recipe;
  assert(
    uuidPattern.test(recipe?.id) && uuidPattern.test(recipe?.currentVersion?.id),
    "Recipe receipt is incomplete",
  );
  const definitionResponse = await request(
    "create-synthetic-weight-definition",
    "/v1/biometrics/definitions",
    contracts.biometricDefinitionDraftRequestSchema,
    definitionBody(),
  );
  const definitionId = definitionResponse.data?.definition?.id;
  assert(uuidPattern.test(definitionId), "Weight definition receipt is incomplete");
  const guard = "?profileTimeZonePrecondition=v1";
  for (const [index, date] of dates.entries()) {
    const bodies = dayBodies(catalogue, date, index, recipe.currentVersion.id, definitionId);
    for (const [entryIndex, body] of bodies.foods.entries())
      await request(
        `day-${index + 1}-food-${entryIndex + 1}`,
        `/v1/diary/entries${guard}`,
        contracts.createDiaryEntryRequestSchema,
        body,
        true,
      );
    await request(
      `day-${index + 1}-recipe`,
      `/v1/recipes/${recipe.id}/log${guard}`,
      contracts.createRecipeDiaryEntryRequestSchema,
      bodies.recipe,
      true,
    );
    await request(
      `day-${index + 1}-weight`,
      "/v1/biometrics/events",
      contracts.biometricEventDraftRequestSchema,
      bodies.weight,
    );
    await request(
      `day-${index + 1}-hydration`,
      `/v1/hydration/entries${guard}`,
      contracts.createHydrationEntryRequestSchema,
      bodies.hydration,
      true,
    );
  }
  const report = await request(
    "verify-seven-day-report",
    `/v1/reports/nutrition?from=${dates[0]}&to=${today}`,
  );
  assert(
    report.data?.days?.length === 7 &&
      report.data.days.every((day) => day.entryCount === 6) &&
      report.data?.series?.length === 15,
    "Report does not contain the planned complete seven-day fixture",
  );
  const receipt = {
    syntheticOnly: true,
    completedAt: new Date().toISOString(),
    from: dates[0],
    to: today,
    timeZone: zone,
    days: 7,
    diaryEntries: 42,
    recipes: 1,
    manualGoalSets: 1,
    weightReadings: 7,
    hydrationEntries: 7,
    userId: registration.data.user.id,
    recipeId: recipe.id,
    weightDefinitionId: definitionId,
    credentialsPath,
    catalogueExpiresAt: catalogue.fixtureExpiresAt,
  };
  await writeFile(
    join(directory, "account-population.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await record({ step: "complete", passed: true, days: 7, diaryEntries: 42, credentialsPath });
}
process.umask(0o077);
main().catch(async (error) => {
  await record({
    step: currentStep,
    passed: false,
    errorType: error instanceof Error ? error.name : "UnknownError",
    action:
      "Inspect the named step; partial synthetic data and private credentials are retained. No automatic retry.",
  });
  process.exitCode = 1;
});
