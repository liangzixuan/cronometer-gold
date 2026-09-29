// Executes the unchanged smoke module with synthetic APIs. No browser/network/filesystem writes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../smoke.mjs", import.meta.url), "utf8");
const expectedChecks = [
  "authenticated-session-persistence",
  "real-search-and-single-add",
  "saved-diary-entry-after-reload",
  "report-agrees-with-saved-day",
  "narrow-diary-remains-usable",
];

async function exercise(options = {}) {
  let currentURL = "",
    count = 6,
    connected = 0,
    closed = 0,
    caps;
  const outputs = new Map(),
    typed = [],
    filled = [],
    actions = [],
    fetches = [],
    navigations = [];
  const input = {
    origin: "http://127.0.0.1:3287",
    date: "2026-09-29",
    from: "2026-09-23",
    localIdentifier: "nourishing-123-1",
    sourceSha: "a".repeat(40),
    buildId: "synthetic-build",
    runtime: "/synthetic/runtime",
  };
  const credentials = {
    email: "walkthrough-abc123@example.invalid",
    password: "SYNTHETIC-SECRET-SENTINEL",
    timeZone: "America/Chicago",
  };
  const env = {
    NOURISHING_BROWSER_PRIVATE: "/synthetic/private",
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    BROWSERSTACK_USERNAME: "synthetic-user",
    BROWSERSTACK_ACCESS_KEY: "synthetic-key",
  };
  if (options.missingCredential) delete env.BROWSERSTACK_ACCESS_KEY;
  const fakeProcess = { env, once() {}, exitCode: undefined };
  const locator = (label = "") => ({
    waitFor: async () => {},
    count: async () => 1,
    first() {
      return this;
    },
    filter() {
      return this;
    },
    locator: (next) => locator(next),
    getByRole: (_role, value) => locator(value.name),
    getByLabel: (next) => locator(next),
    evaluate: async (fn) => fn({ id: "diary-page-count" }),
    type: async (value) => typed.push([label, value]),
    fill: async (value) => filled.push([label, value]),
    inputValue: async () => (label === "Meal" ? "snacks" : input.date),
    click: async () => {
      if (label.startsWith("Add 1.5")) count = 7;
    },
    isVisible: async () => true,
    allTextContents: async () => [`Energy: ${options.energy ?? "135"} kcal`],
  });
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    setViewportSize: async () => {},
    goto: async (url) => {
      navigations.push(url);
      if (options.actualPageRoutes) {
        const target = new URL(url);
        assert.equal(target.origin, input.origin);
        await readFile(
          new URL(`../../../apps/web/src/app${target.pathname}/page.tsx`, import.meta.url),
        );
      }
      currentURL = url;
    },
    url: () => currentURL,
    reload: async () => {},
    locator,
    getByLabel: locator,
    getByRole: (_role, value) => locator(value.name),
    waitForURL: async () => {
      if (options.loginFailure) throw new Error("SYNTHETIC-SECRET-SENTINEL");
    },
    waitForResponse: async () => ({ ok: () => !options.addFailure }),
    waitForFunction: async (fn, arg) => {
      assert(fn(arg), "Synthetic DOM predicate rejected");
    },
    evaluate: async (fn, value) => {
      if (typeof value === "string" && value.startsWith("browserstack_executor:")) {
        const action = JSON.parse(value.slice("browserstack_executor:".length));
        actions.push(action);
        if (action.action === "getSessionDetails")
          return JSON.stringify({
            hashed_id: options.missingSession ? undefined : "synthetic-session",
          });
        if (action.action === "setSessionStatus" && options.statusFailure)
          throw new Error("synthetic status error");
        return undefined;
      }
      return fn(value);
    },
  };
  const browser = {
    version: () => "synthetic-browser",
    newContext: async (config) => {
      assert.equal(config.acceptDownloads, false);
      assert.equal(config.serviceWorkers, "block");
      assert.equal(config.ignoreHTTPSErrors, undefined);
      assert.equal(config.storageState, undefined);
      assert.equal(config.recordVideo, undefined);
      return { newPage: async () => page };
    },
    close: async () => {
      closed++;
      if (options.closeFailure) throw new Error("synthetic close error");
    },
  };
  const document = {
    documentElement: { scrollWidth: 390 },
    querySelector: () => ({
      textContent: `${count} of ${count} entries loaded. Nutrition totals include all ${count}.`,
    }),
    querySelectorAll: () => [
      {
        querySelector: (selector) =>
          selector.startsWith("time") ? {} : { textContent: String(options.reportCount ?? count) },
      },
    ],
  };
  const terminalFetch = async (url, config) => {
    assert.equal(closed, 1, "Terminal read must follow browser close");
    fetches.push([url, config]);
    const value = {
      automation_session: {
        hashed_id: options.crossSession ? "other-session" : "synthetic-session",
        name: "synthetic-login-search-add-report",
        project_name: "Nourishing",
        build_name: options.wrongBuild ? "another-build" : `nourishing-${input.sourceSha}-123-1`,
        status: options.terminalFailed ? "failed" : "passed",
        browserstack_status: options.terminalRunning ? "running" : "done",
        duration: options.fractionalDuration ? 25.5 : 25,
        video_url: options.videoPresent
          ? "https://private.invalid/SYNTHETIC-SECRET-SENTINEL"
          : null,
        har_logs_url: null,
        browser_console_logs_url: null,
        playwright_logs_url: null,
      },
    };
    if (options.oversizedResponse) value.ignoredPrivate = "X".repeat(70 * 1024);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let consumed = false;
    return {
      ok: !options.terminalHttpFailure,
      body: {
        getReader: () => ({
          read: async () => {
            if (consumed) return { done: true };
            consumed = true;
            return { value: bytes, done: false };
          },
          cancel: async () => {},
        }),
      },
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  const context = vm.createContext({
    URL,
    Buffer,
    AbortSignal,
    TextDecoder,
    Uint8Array,
    fetch: terminalFetch,
    console: {
      log() {
        throw new Error("Unexpected output");
      },
      error() {
        throw new Error("Unexpected output");
      },
    },
    process: fakeProcess,
    setTimeout: () => 1,
    clearTimeout() {},
    document,
    window: { innerWidth: 390 },
  });
  const modules = new Map();
  function moduleFor(name, values) {
    if (!modules.has(name))
      modules.set(
        name,
        new vm.SyntheticModule(
          Object.keys(values),
          function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
          },
          { context },
        ),
      );
    return modules.get(name);
  }
  const module = new vm.SourceTextModule(source, { context, identifier: "actual-smoke.mjs" });
  await module.link((name) => {
    if (name === "node:assert/strict") return moduleFor(name, { default: assert });
    if (name === "node:path") return moduleFor(name, { join });
    if (name === "node:fs/promises")
      return moduleFor(name, {
        readFile: async (path) =>
          JSON.stringify(path.endsWith("browser-input.json") ? input : credentials),
        writeFile: async (path, value, config) => {
          assert.equal(config.flag, "wx");
          assert.equal(config.mode, 0o600);
          outputs.set(path, value);
        },
      });
    if (name === "playwright")
      return moduleFor(name, {
        chromium: {
          connect: async ({ wsEndpoint, timeout }) => {
            connected++;
            caps = JSON.parse(new URL(wsEndpoint).searchParams.get("caps"));
            assert.equal(timeout, 30_000);
            if (options.connectFailure) throw new Error("SYNTHETIC-SECRET-SENTINEL");
            return browser;
          },
        },
      });
    throw new Error(`Unexpected import: ${name}`);
  });
  let rejection;
  try {
    await module.evaluate();
  } catch (error) {
    rejection = error;
  }
  const raw = outputs.get("/synthetic/private/browser-result.json");
  return {
    receipt: raw && JSON.parse(raw),
    raw,
    connected,
    closed,
    caps,
    typed,
    filled,
    actions,
    fetches,
    navigations,
    exitCode: fakeProcess.exitCode,
    rejection,
  };
}

test("actual module completes exactly one synthetic session and five journey stages", async () => {
  const result = await exercise();
  assert.equal(result.rejection, undefined);
  assert.equal(result.connected, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.checks, expectedChecks);
  assert.equal(result.exitCode, 0);
});
test("capture flags, masking and tunnel identity reach the actual connect call", async () => {
  const { caps, typed, filled } = await exercise();
  for (const key of [
    "browserstack.video",
    "browserstack.debug",
    "browserstack.networkLogs",
    "playwrightLogs",
  ])
    assert.equal(caps[key], false);
  assert.equal(caps["browserstack.console"], "disable");
  assert.match(caps["browserstack.maskCommands"], /sendType/);
  assert.equal(caps["browserstack.local"], true);
  assert.equal(caps["browserstack.localIdentifier"], "nourishing-123-1");
  assert.deepEqual(
    typed.map(([name]) => name),
    ["Email", "Password"],
  );
  assert(!filled.some(([, value]) => value === "SYNTHETIC-SECRET-SENTINEL"));
});
test("missing credential rejects before any connection", async () => {
  const result = await exercise({ missingCredential: true });
  assert(result.rejection);
  assert.equal(result.connected, 0);
});
test("connection failure makes one attempt and emits no raw secret", async () => {
  const result = await exercise({ connectFailure: true });
  assert.equal(result.connected, 1);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.exitCode, 1);
  assert(!result.raw.includes("SYNTHETIC-SECRET-SENTINEL"));
});
test("login failure closes the session and preserves a static failed stage", async () => {
  const result = await exercise({ loginFailure: true });
  assert.equal(result.closed, 1);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.failedStage, "authenticated-session-persistence");
  assert(!result.raw.includes("SYNTHETIC-SECRET-SENTINEL"));
});
test("failure after creation retains actual session identity and remote failed result", async () => {
  const result = await exercise({ loginFailure: true, terminalFailed: true });
  assert.equal(result.receipt.sessionId, "synthetic-session");
  assert.equal(result.receipt.failedStage, "authenticated-session-persistence");
  assert.equal(result.receipt.terminal.status, "failed");
  assert.equal(result.receipt.terminal.browserstackStatus, "done");
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.actions[0].action, "getSessionDetails");
  assert.equal(result.fetches.length, 1);
});
test("terminal read failure never overwrites the primary journey failure", async () => {
  const result = await exercise({ loginFailure: true, terminalHttpFailure: true });
  assert.equal(result.receipt.failedStage, "authenticated-session-persistence");
  assert.equal(result.receipt.terminalVerificationFailed, true);
  assert.equal(result.receipt.status, "failed");
});
test("failed add response cannot report browser success", async () => {
  assert.equal((await exercise({ addFailure: true })).receipt.status, "failed");
});
test("wrong report entry count cannot report browser success", async () => {
  assert.equal((await exercise({ reportCount: 6 })).receipt.status, "failed");
});
test("missing actual session identity cannot report browser success", async () => {
  assert.equal((await exercise({ missingSession: true })).receipt.status, "failed");
});
test("failed terminal status update fails local receipt", async () => {
  assert.equal((await exercise({ statusFailure: true })).receipt.status, "failed");
});
test("browser close failure fails local receipt", async () => {
  assert.equal((await exercise({ closeFailure: true })).receipt.status, "failed");
});
test("1135 kcal cannot satisfy the intended exact135 kcal assertion", async () => {
  assert.equal((await exercise({ energy: "1135" })).receipt.status, "failed");
});
test("terminal verification reads the exact HTTPS session after close with no redirects", async () => {
  const result = await exercise();
  assert.equal(result.fetches.length, 1);
  assert.equal(
    result.fetches[0][0],
    "https://api.browserstack.com/automate/sessions/synthetic-session.json",
  );
  assert.equal(result.fetches[0][1].redirect, "error");
  assert.match(result.fetches[0][1].headers.Authorization, /^Basic /);
  assert.equal(result.receipt.terminal.browserstackStatus, "done");
});
test("vendor still running cannot be called terminal success", async () => {
  assert.equal((await exercise({ terminalRunning: true })).receipt.status, "failed");
});
test("vendor failed status overrides local passed checks", async () => {
  assert.equal((await exercise({ terminalFailed: true })).receipt.status, "failed");
});
test("foreign terminal session cannot satisfy this session", async () => {
  assert.equal((await exercise({ crossSession: true })).receipt.status, "failed");
});
test("terminal HTTP failure cannot pass", async () => {
  assert.equal((await exercise({ terminalHttpFailure: true })).receipt.status, "failed");
});
test("wrong vendor build cannot pass", async () => {
  assert.equal((await exercise({ wrongBuild: true })).receipt.status, "failed");
});
test("non-integer remote duration cannot pass", async () => {
  assert.equal((await exercise({ fractionalDuration: true })).receipt.status, "failed");
});
test("oversized vendor response is rejected before it becomes evidence", async () => {
  const result = await exercise({ oversizedResponse: true });
  assert.equal(result.receipt.status, "failed");
  assert(!result.raw.includes("X".repeat(100)));
});
test("capture metadata is projected without retaining signed URLs or asserting masking verification", async () => {
  const result = await exercise({ videoPresent: true });
  assert.equal(result.receipt.capture.observedArtifacts.video_url, "present");
  assert.equal(result.receipt.capture.dashboardVerification, "pending-first-run-review");
  assert.equal(result.receipt.cookieAttributesIndependentlyInspected, false);
  assert(!result.raw.includes("SYNTHETIC-SECRET-SENTINEL"));
});

test("actual smoke navigations resolve to existing app pages and retain the selected diary day", async () => {
  const result = await exercise({ actualPageRoutes: true });
  assert.equal(result.rejection, undefined);
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.checks, expectedChecks);
  assert.equal(result.connected, 1);
  assert.equal(result.closed, 1);
  const diaryVisits = result.navigations
    .map((url) => new URL(url))
    .filter((url) => url.pathname === "/dashboard");
  assert.equal(diaryVisits.length, 3);
  assert(diaryVisits.every((url) => url.searchParams.get("date") === "2026-09-29"));
});
