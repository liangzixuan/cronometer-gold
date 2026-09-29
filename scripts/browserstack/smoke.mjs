// Draft destination: scripts/browserstack/smoke.mjs. One connection, no retries.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone CI session runs outside Turbo; its credentials must not enter task caching.
const directory = process.env.NOURISHING_BROWSER_PRIVATE;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone CI session runs outside Turbo; its credentials must not enter task caching.
assert(directory && process.env.GITHUB_ACTIONS === "true");
const context = JSON.parse(await readFile(join(directory, "browser-input.json"), "utf8"));
const { origin, date, from, localIdentifier, sourceSha, buildId, runtime } = context;
assert.equal(origin, "http://127.0.0.1:3287");
assert(/^[a-f0-9]{40}$/.test(sourceSha));
assert(/^nourishing-[0-9]+-[0-9]+$/.test(localIdentifier));
const credentials = JSON.parse(
  await readFile(join(runtime, "walkthrough-account-credentials.json"), "utf8"),
);
assert(/^walkthrough-[a-z0-9]+@example\.invalid$/.test(credentials.email));
assert.equal(typeof credentials.password, "string");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone CI session runs outside Turbo; its credentials must not enter task caching.
const username = process.env.BROWSERSTACK_USERNAME;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone CI session runs outside Turbo; its credentials must not enter task caching.
const key = process.env.BROWSERSTACK_ACCESS_KEY;
assert(username && key);
const caps = {
  browser: "chrome",
  browser_version: "latest",
  os: "Windows",
  os_version: "11",
  project: "Nourishing",
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone CI session uses the current workflow identity outside Turbo.
  build: `nourishing-${sourceSha}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  name: "synthetic-login-search-add-report",
  "client.playwrightVersion": "1.59.0",
  "browserstack.username": username,
  "browserstack.accessKey": key,
  "browserstack.local": true,
  "browserstack.localIdentifier": localIdentifier,
  "browserstack.video": false,
  "browserstack.debug": false,
  "browserstack.networkLogs": false,
  "browserstack.console": "disable",
  playwrightLogs: false,
  "browserstack.maskCommands":
    "sendType,sendPress,setHTTPCredentials,setStorageState,setGeolocation",
};
const captureRequested = {
  video: false,
  screenshots: false,
  networkLogs: false,
  console: "disable",
  playwrightLogs: false,
  maskCommands: caps["browserstack.maskCommands"],
};
const receipt = {
  schemaVersion: 1,
  sourceSha,
  buildId,
  syntheticOnly: true,
  browserSessionsAttempted: 1,
  retries: 0,
  origin,
  checks: [],
  status: "failed",
  startedAt: new Date().toISOString(),
  browserVersion: null,
  sessionId: null,
  cookieAttributesIndependentlyInspected: false,
};
const SEARCH_SUBSTEPS = new Set([
  "open-foods",
  "wait-destination",
  "check-local-day",
  "check-meal",
  "fill-search",
  "submit-search",
  "wait-result",
  "check-result-count",
  "fill-amount",
  "observe-add-response",
  "click-add",
  "check-add-response",
]);
let browser, page;
let stage = "connect";
let substep = null;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  void browser?.close().catch(() => {});
};
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
const limit = setTimeout(cancel, 180_000);
async function check(name, operation) {
  stage = name;
  substep = null;
  assert(!cancelled, "Session cancelled");
  await operation();
  receipt.checks.push(name);
}
async function waitText(locator, pattern) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    ({ selector, source }) =>
      new RegExp(source).test(document.querySelector(selector)?.textContent ?? ""),
    { selector: await locator.evaluate((element) => `#${element.id}`), source: pattern.source },
    { timeout: 15_000 },
  );
}
async function diaryCount(number) {
  await waitText(
    page.locator("#diary-page-count"),
    new RegExp(`^${number} of ${number} entries loaded\\.`),
  );
}
async function terminalDetails() {
  // A single read after close. An eventual-consistency or API failure remains unaccepted;
  // it never starts a second browser session. Never follow an authenticated redirect.
  const response = await fetch(
    `https://api.browserstack.com/automate/sessions/${receipt.sessionId}.json`,
    {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${key}`).toString("base64")}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert(response.ok && response.body, "Session metadata unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= 64 * 1024, "Session metadata exceeds bound");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const details = JSON.parse(Buffer.concat(chunks).toString("utf8")).automation_session;
  assert.equal(details.hashed_id, receipt.sessionId);
  assert.equal(details.project_name, caps.project);
  assert.equal(details.build_name, caps.build);
  assert.equal(details.name, caps.name);
  assert(
    details.duration === null ||
      (Number.isInteger(details.duration) && details.duration >= 0 && details.duration <= 240),
  );
  assert(["passed", "failed", "done", "running", "error", "timeout"].includes(details.status));
  assert(["done", "running", "error", "failed", "timeout"].includes(details.browserstack_status));
  const observedArtifacts = {};
  for (const field of [
    "video_url",
    "har_logs_url",
    "browser_console_logs_url",
    "playwright_logs_url",
  ]) {
    const value = details[field];
    assert(value === undefined || value === null || typeof value === "string");
    observedArtifacts[field] =
      value === undefined
        ? "missing"
        : value === null
          ? "null"
          : value === ""
            ? "empty"
            : "present";
  }
  // Presence fields are documented URLs, not an authoritative capability echo.
  // Do not fetch or retain signed URLs or claim that absent links prove capture/masking.
  receipt.capture = {
    requested: captureRequested,
    observedArtifacts,
    dashboardVerification: "pending-first-run-review",
  };
  receipt.terminal = {
    sessionId: details.hashed_id,
    status: details.status,
    browserstackStatus: details.browserstack_status,
    durationSeconds: details.duration,
    buildName: details.build_name,
    projectName: details.project_name,
    name: details.name,
  };
  assert.equal(details.browserstack_status, "done");
  if (receipt.status === "passed") assert.equal(details.status, "passed");
}
try {
  // The endpoint/capabilities never enter stdout, error reports, or artifacts.
  browser = await chromium.connect({
    wsEndpoint: `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`,
    timeout: 30_000,
  });
  receipt.browserVersion = browser.version();
  const browserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
    serviceWorkers: "block",
    timezoneId: credentials.timeZone,
  });
  page = await browserContext.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);
  stage = "session-identity";
  const sessionRaw = await page.evaluate(
    () => {},
    `browserstack_executor: ${JSON.stringify({ action: "getSessionDetails" })}`,
  );
  assert(typeof sessionRaw === "string" && Buffer.byteLength(sessionRaw) <= 64 * 1024);
  const session = JSON.parse(sessionRaw);
  assert(
    typeof session.hashed_id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(session.hashed_id),
    "Session identifier missing",
  );
  receipt.sessionId = session.hashed_id;
  // No route mocks, cookies injected, storage-state injection, traces, screenshots, or TLS overrides.
  await check("authenticated-session-persistence", async () => {
    await page.goto(`${origin}/login`);
    assert.equal(new URL(page.url()).origin, origin);
    // Vendor masking explicitly covers locator.type; do not substitute fill for credentials.
    await page.getByLabel("Email", { exact: true }).type(credentials.email);
    await page.getByLabel("Password", { exact: true }).type(credentials.password);
    await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${origin}/dashboard`);
    await page.goto(`${origin}/dashboard?date=${date}`);
    await diaryCount(6); // Confirms an authenticated BFF read through the real API/database.
  });
  await check("real-search-and-single-add", async () => {
    substep = "open-foods";
    await page.goto(`${origin}/foods?date=${date}&meal=snacks`);
    substep = "wait-destination";
    await page.getByLabel("Local day", { exact: true }).waitFor();
    substep = "check-local-day";
    assert.equal(await page.getByLabel("Local day", { exact: true }).inputValue(), date);
    substep = "check-meal";
    assert.equal(await page.getByLabel("Meal", { exact: true }).inputValue(), "snacks");
    substep = "fill-search";
    await page.getByLabel("Food or brand", { exact: true }).fill("Blueberries");
    substep = "submit-search";
    await page
      .getByRole("form", { name: "Food search", exact: true })
      .getByRole("button", { name: "Search", exact: true })
      .click();
    substep = "wait-result";
    const food = page
      .getByRole("list", { name: "Food search results", exact: true })
      .locator("li")
      .filter({
        has: page.getByRole("heading", { name: "Blueberries (synthetic sample)", exact: true }),
      });
    await food.waitFor();
    substep = "check-result-count";
    assert.equal(await food.count(), 1);
    substep = "fill-amount";
    await food.getByLabel("Amount", { exact: true }).fill("1.5");
    substep = "observe-add-response";
    const added = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/diary/entries" &&
        response.request().method() === "POST",
    );
    substep = "click-add";
    await food
      .getByRole("button", {
        name: "Add 1.5 default servings of Blueberries (synthetic sample)",
        exact: true,
      })
      .click();
    substep = "check-add-response";
    assert((await added).ok());
  });
  await check("saved-diary-entry-after-reload", async () => {
    await page.goto(`${origin}/dashboard?date=${date}`);
    await diaryCount(7);
    await page.reload();
    await diaryCount(7);
    const entries = page.locator("article.diaryEntry").filter({
      has: page.getByRole("heading", { name: "Blueberries (synthetic sample)", exact: true }),
    });
    assert((await entries.count()) >= 1);
    assert(
      (await entries.locator(".ledgerRowEnergy").allTextContents()).some((text) =>
        /^\s*Energy:\s*135\s+kcal\s*$/.test(text),
      ),
      "Added 1.5-serving entry must display exactly 135 kcal",
    );
  });
  await check("report-agrees-with-saved-day", async () => {
    await page.goto(`${origin}/reports?from=${from}&to=${date}`);
    const row = page
      .locator(".reportTable tbody tr")
      .filter({ has: page.locator(`time[datetime="${date}"]`) });
    await row.first().waitFor();
    assert.equal(await row.count(), 1);
    await page.waitForFunction(
      ({ day }) =>
        [...document.querySelectorAll(".reportTable tbody tr")].some(
          (row) =>
            row.querySelector(`time[datetime="${day}"]`) &&
            row.querySelector("td")?.textContent?.trim() === "7",
        ),
      { day: date },
    );
  });
  await check("narrow-diary-remains-usable", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/dashboard?date=${date}`);
    await diaryCount(7);
    assert(await page.getByRole("heading", { name: "Diary", exact: true }).isVisible());
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    );
  });
  receipt.status = "passed";
} catch {
  receipt.failedStage = stage; // Never serialize vendor errors/capabilities or page contents.
  if (stage === "real-search-and-single-add" && SEARCH_SUBSTEPS.has(substep)) {
    receipt.failedSubstep = substep;
  }
} finally {
  clearTimeout(limit);
  if (page)
    await page
      .evaluate(
        () => {},
        `browserstack_executor: ${JSON.stringify({ action: "setSessionStatus", arguments: { status: receipt.status, reason: receipt.status === "passed" ? "Synthetic journey checks passed" : `Synthetic journey failed at ${stage}` } })}`,
      )
      .catch(() => {
        receipt.status = "failed";
        receipt.statusUpdateFailed = true;
      });
  if (browser)
    await browser.close().catch(() => {
      receipt.status = "failed";
      receipt.browserCleanupFailed = true;
    });
  if (receipt.sessionId) {
    await terminalDetails().catch(() => {
      receipt.terminalVerificationFailed = true;
      if (receipt.status === "passed") receipt.failedStage = "terminal-verification";
      receipt.status = "failed";
    });
  }
  receipt.completedAt = new Date().toISOString();
  await writeFile(join(directory, "browser-result.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.exitCode = receipt.status === "passed" ? 0 : 1;
}
