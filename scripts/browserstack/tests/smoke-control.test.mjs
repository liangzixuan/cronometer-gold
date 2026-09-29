// Executes the smoke module with synthetic APIs; no browser or network.
// Controller fixtures use a temporary directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "@babel/parser";

const source = await readFile(new URL("../smoke.mjs", import.meta.url), "utf8");
const expectedChecks = [
  "authenticated-session-persistence",
  "real-search-and-single-add",
  "saved-diary-entry-after-reload",
  "report-agrees-with-saved-day",
  "narrow-diary-remains-usable",
];
const searchOperations = [
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
];

function matchingNodes(tree, predicate) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type !== "string") return;
    if (predicate(node)) found.push(node);
    for (const value of Object.values(node)) visit(value);
  }
  visit(tree);
  return found;
}

// A bounded model of this native label/select, not HTML parsing, hydration or a browser.
// JSX and option text come from app source; matching runs the installed Playwright functions.
async function mealSelectorModel() {
  const component = parse(
    await readFile(
      new URL("../../../apps/web/src/app/foods/FoodSearchClient.tsx", import.meta.url),
      "utf8",
    ),
    { sourceType: "module", plugins: ["typescript", "jsx"] },
  );
  const attr = (node, name) =>
    node.openingElement.attributes.find(
      (item) => item.type === "JSXAttribute" && item.name.name === name,
    )?.value;
  const elements = (tree, tag) =>
    matchingNodes(
      tree,
      (node) => node.type === "JSXElement" && node.openingElement.name.name === tag,
    );
  const labels = elements(component, "label").filter(
    (node) => attr(node, "htmlFor")?.value === "quick-add-meal",
  );
  assert.equal(labels.length, 1);
  const [label] = labels;
  const selects = elements(label, "select");
  assert.equal(selects.length, 1);
  const [select] = selects;
  const id = attr(select, "id").value;
  assert.equal(id, "quick-add-meal");
  assert.equal(attr(select, "value").expression.name, "mealSlot");
  assert.equal(
    matchingNodes(
      component,
      (node) => node.type === "JSXAttribute" && node.name.name === "id" && node.value?.value === id,
    ).length,
    1,
  );
  const [option] = elements(select, "option");
  assert.equal(attr(option, "value").expression.object.name, "group");
  assert.equal(attr(option, "value").expression.property.name, "mealSlot");
  const optionText = option.children.find(
    (node) => node.type === "JSXExpressionContainer",
  ).expression;
  assert.equal(optionText.object.name, "group");
  assert.equal(optionText.property.name, "label");
  assert(
    select.children.some(
      (node) =>
        node.type === "JSXExpressionContainer" &&
        node.expression?.callee?.object?.name === "diaryGroups" &&
        node.expression?.callee?.property?.name === "map",
    ),
  );
  const diary = parse(
    await readFile(new URL("../../../apps/web/src/lib/diary.ts", import.meta.url), "utf8"),
    { sourceType: "module", plugins: ["typescript"] },
  );
  const [groups] = matchingNodes(
    diary,
    (node) => node.type === "VariableDeclarator" && node.id.name === "defaultDiaryGroups",
  );
  const options = groups.init.expression.elements.map((node) =>
    Object.fromEntries(
      node.properties.map((property) => {
        assert.equal(property.value.type, "StringLiteral");
        return [property.key.name, property.value.value];
      }),
    ),
  );
  const document = { head: null };
  const text = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (name, children, attributes = {}) => {
    for (let index = 0; index < children.length; index++)
      children[index].nextSibling = children[index + 1];
    return {
      nodeType: 1,
      nodeName: name,
      ownerDocument: document,
      firstChild: children[0],
      getAttribute: (name) => attributes[name] ?? null,
    };
  };
  const selectNode = element(
    "SELECT",
    options.map((option) => element("OPTION", [text(option.label)])),
    { id },
  );
  const labelNode = element("LABEL", [
    text(
      label.children
        .filter((node) => node.type === "JSXText")
        .map((node) => node.value)
        .join(""),
    ),
    selectNode,
  ]);
  selectNode.labels = [labelNode];
  const require = createRequire(import.meta.url);
  const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
  const core = dirname(playwrightRequire.resolve("playwright-core/package.json"));
  assert.equal(require(join(core, "package.json")).version, "1.59.0");
  const injected = require(join(core, "lib/generated/injectedScriptSource.js")).source;
  const parsed = parse(injected);
  const names = [
    "normalizeWhiteSpace",
    "shouldSkipForTextMatching",
    "elementText",
    "getAriaLabelledByElements",
    "getElementLabels",
    "createTextMatcher",
  ];
  const functions = names.map((name) => {
    const declarations = matchingNodes(
      parsed,
      (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
    );
    assert.equal(declarations.length, 1);
    return injected.slice(declarations[0].start, declarations[0].end);
  });
  const engine = vm.runInNewContext(
    `${functions.join("\n")}\n({getElementLabels,createTextMatcher})`,
    {
      normalizedWhitespaceCache: undefined,
      HTMLInputElement: class {},
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, COMMENT_NODE: 8 },
    },
  );
  const nativeLabels = engine.getElementLabels(new Map(), selectNode);
  return {
    id,
    options,
    normalizedLabel: nativeLabels[0].normalized,
    exactLabelMatches: (name) =>
      nativeLabels.some(engine.createTextMatcher(`${JSON.stringify(name)}s`, true).matcher),
  };
}

async function exercise(options = {}, smokeSource = source) {
  const mealModel = options.mealModel;
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
    navigations = [],
    observedSearchOperations = [],
    mealReads = [];
  let addClicks = 0;
  function searchOperation(name) {
    observedSearchOperations.push(name);
    if (options.searchFailure === name) throw new Error("SYNTHETIC-SECRET-SENTINEL");
  }
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
    waitFor: async () => {
      if (label === "Local day") searchOperation("wait-destination");
      if (label === "food-result") searchOperation("wait-result");
    },
    count: async () => {
      if (label === "food-result") searchOperation("check-result-count");
      return 1;
    },
    first() {
      return this;
    },
    filter() {
      return this;
    },
    locator: (next) =>
      locator(label === "Food search results" && next === "li" ? "food-result" : next),
    getByRole: (_role, value) => locator(value.name),
    getByLabel: (next) => locator(next),
    evaluate: async (fn) => fn({ id: "diary-page-count" }),
    type: async (value) => typed.push([label, value]),
    fill: async (value) => {
      if (label === "Food or brand") searchOperation("fill-search");
      if (label === "Amount") searchOperation("fill-amount");
      filled.push([label, value]);
    },
    inputValue: async () => {
      if (label === "Local day") searchOperation("check-local-day");
      if (label === "Meal" || label === "#quick-add-meal" || label === "missing-meal") {
        searchOperation("check-meal");
        assert.notEqual(label, "missing-meal", "Exact label has no matching control");
        if (mealModel) {
          assert.equal(label, `#${mealModel.id}`);
          const value = options.mealValue ?? new URL(currentURL).searchParams.get("meal");
          assert(mealModel.options.some((option) => option.mealSlot === value));
          mealReads.push(value);
          return value;
        }
        return "snacks";
      }
      return input.date;
    },
    click: async () => {
      if (label === "Search") searchOperation("submit-search");
      if (label.startsWith("Add 1.5")) {
        searchOperation("click-add");
        addClicks++;
        count = 7;
      }
    },
    isVisible: async () => true,
    allTextContents: async () => [`Energy: ${options.energy ?? "135"} kcal`],
  });
  const page = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    setViewportSize: async () => {},
    goto: async (url) => {
      if (new URL(url).pathname === "/foods") searchOperation("open-foods");
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
    getByLabel: (name, config) =>
      locator(
        mealModel && name === "Meal" && config?.exact && !mealModel.exactLabelMatches(name)
          ? "missing-meal"
          : name,
      ),
    getByRole: (_role, value) => locator(value.name),
    waitForURL: async () => {
      if (options.loginFailure) throw new Error("SYNTHETIC-SECRET-SENTINEL");
    },
    waitForResponse: (predicate) => {
      searchOperation("observe-add-response");
      assert(
        predicate({
          url: () => `${input.origin}/api/diary/entries?date=${input.date}`,
          request: () => ({ method: () => "POST" }),
        }),
      );
      assert(
        !predicate({
          url: () => `${input.origin}/api/diary/entries`,
          request: () => ({ method: () => "GET" }),
        }),
      );
      return Promise.resolve({
        ok: () => {
          searchOperation("check-add-response");
          return !options.addFailure;
        },
      });
    },
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
  const module = new vm.SourceTextModule(smokeSource, { context, identifier: "actual-smoke.mjs" });
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
    observedSearchOperations,
    mealReads,
    addClicks,
    exitCode: fakeProcess.exitCode,
    rejection,
  };
}

test("actual runner resolves the source-derived meal select without matching nested option text", async () => {
  const mealModel = await mealSelectorModel();
  assert.equal(mealModel.exactLabelMatches("Meal"), false);
  assert(mealModel.normalizedLabel.startsWith("Meal"));
  assert(mealModel.options.every((option) => mealModel.normalizedLabel.includes(option.label)));
  const result = await exercise({ mealModel });
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.checks, expectedChecks);
  assert.deepEqual(result.mealReads, ["snacks"]);
  assert.equal(result.addClicks, 1);
});

test("the original exact Meal label fails in the actual runner before search or add", async () => {
  const oldLookup = 'page.getByLabel("Meal", { exact: true }).inputValue()';
  const original = source.replace('page.locator("#quick-add-meal").inputValue()', oldLookup);
  assert(original.includes(oldLookup));
  const result = await exercise({ mealModel: await mealSelectorModel() }, original);
  assert.equal(result.receipt.failedSubstep, "check-meal");
  assert.equal(result.receipt.status, "failed");
  assert.deepEqual(result.observedSearchOperations, searchOperations.slice(0, 4));
  assert.equal(result.addClicks, 0);
  assert.equal(result.closed, 1);
  assert.deepEqual(result.mealReads, []);
});

test("a wrong meal value still stops the actual runner before search or add", async () => {
  const result = await exercise({ mealModel: await mealSelectorModel(), mealValue: "breakfast" });
  assert.equal(result.receipt.failedSubstep, "check-meal");
  assert.equal(result.receipt.status, "failed");
  assert.deepEqual(result.observedSearchOperations, searchOperations.slice(0, 4));
  assert.equal(result.addClicks, 0);
  assert.equal(result.closed, 1);
  assert.deepEqual(result.mealReads, ["breakfast"]);
});

test("actual module completes exactly one synthetic session and five journey stages", async () => {
  const result = await exercise();
  assert.equal(result.rejection, undefined);
  assert.equal(result.connected, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.checks, expectedChecks);
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.failedSubstep, undefined);
  assert.deepEqual(result.observedSearchOperations, searchOperations);
  assert.equal(result.addClicks, 1);
});

function publicSummary(receipt) {
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('browser_controller_tests',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
case=module.DraftTests('test_failed_browser_never_accepts')
case.setUp()
try:
 case.full_receipts();case.write('browser-result.json',json.loads(sys.stdin.read()))
 try: case.ns['summary']()
 except RuntimeError: pass
finally: case.doCleanups()
`;
  const result = spawnSync(
    "python3",
    ["-B", "-c", script, fileURLToPath(new URL("./test_ci_run.py", import.meta.url))],
    {
      input: JSON.stringify(receipt),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes("SYNTHETIC-SECRET-SENTINEL"));
  return JSON.parse(result.stdout);
}

for (const [index, operation] of searchOperations.entries()) {
  test(`search failure at ${operation} reaches the actual bounded public summary`, async () => {
    const result = await exercise({ searchFailure: operation });
    assert.equal(result.rejection, undefined);
    assert.equal(result.receipt.failedStage, "real-search-and-single-add");
    assert.equal(result.receipt.failedSubstep, operation);
    assert.equal(result.receipt.status, "failed");
    assert.deepEqual(result.receipt.checks, [expectedChecks[0]]);
    assert.deepEqual(result.observedSearchOperations, searchOperations.slice(0, index + 1));
    assert.equal(result.addClicks, operation === "check-add-response" ? 1 : 0);
    assert.equal(result.connected, 1);
    assert.equal(result.closed, 1);
    assert.equal(result.exitCode, 1);
    assert(!result.raw.includes("SYNTHETIC-SECRET-SENTINEL"));
    const summary = publicSummary(result.receipt);
    assert.equal(summary.accepted, false);
    assert.equal(summary.failedBrowser.stage, "real-search-and-single-add");
    assert.equal(summary.failedBrowser.substep, operation);
  });
}

test("failed search substep survives terminal and cleanup failures", async () => {
  const result = await exercise({
    searchFailure: "wait-result",
    terminalHttpFailure: true,
    closeFailure: true,
  });
  assert.equal(result.receipt.failedStage, "real-search-and-single-add");
  assert.equal(result.receipt.failedSubstep, "wait-result");
  assert.equal(result.receipt.browserCleanupFailed, true);
  assert.equal(result.receipt.terminalVerificationFailed, true);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.addClicks, 0);
  assert.equal(result.closed, 1);
});

test("earlier and later failures cannot retain a search substep", async () => {
  for (const options of [
    { loginFailure: true },
    { energy: "1135" },
    { reportCount: 6 },
    { terminalRunning: true },
    { statusFailure: true },
    { closeFailure: true },
  ]) {
    const result = await exercise(options);
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.failedSubstep, undefined);
    assert.equal(result.connected, 1);
    assert.equal(result.closed, 1);
    assert.equal(result.addClicks, options.loginFailure ? 0 : 1);
  }
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
