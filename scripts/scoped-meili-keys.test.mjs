import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  bootstrapScopedMeiliKeys,
  runScopedMeiliKeysCli,
  ScopedMeiliKeysError,
  scopedMeiliKeyPolicies,
  writeScopedMeiliKeysFile,
} from "./scoped-meili-keys.mjs";

const endpoint = "http://127.0.0.1:7700";
const masterKey = "local-master-credential-for-tests";
const searchKey = "a".repeat(64);
const workerKey = "b".repeat(64);
const taskObserverKey = "c".repeat(64);

function response(status, value = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function keyRecord(policy, key) {
  return {
    actions: [...policy.actions],
    createdAt: "2026-08-30T00:00:00.000Z",
    description: policy.description,
    expiresAt: policy.expiresAt,
    indexes: [...policy.indexes],
    key,
    name: policy.name,
    uid: policy.uid,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function header(options, name) {
  return options.headers?.[name] ?? options.headers?.[name.toLowerCase()];
}

function createFetch(options = {}) {
  const records = new Map();
  if (options.existing !== false) {
    records.set(
      scopedMeiliKeyPolicies.search.uid,
      options.searchRecord ?? keyRecord(scopedMeiliKeyPolicies.search, searchKey),
    );
    records.set(
      scopedMeiliKeyPolicies.worker.uid,
      options.workerRecord ?? keyRecord(scopedMeiliKeyPolicies.worker, workerKey),
    );
    records.set(
      scopedMeiliKeyPolicies.taskObserver.uid,
      options.taskObserverRecord ?? keyRecord(scopedMeiliKeyPolicies.taskObserver, taskObserverKey),
    );
  }
  const calls = [];

  const fetchImpl = async (input, request = {}) => {
    const url = new URL(input);
    const call = {
      authorization: header(request, "Authorization"),
      body: request.body,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      redirect: request.redirect,
      signal: request.signal,
    };
    calls.push(call);
    if (options.override) {
      const overridden = await options.override(call, records);
      if (overridden !== undefined) return overridden;
    }

    if (call.authorization === `Bearer ${masterKey}` && call.method === "GET") {
      const prefix = "/keys/";
      if (url.pathname.startsWith(prefix)) {
        const record = records.get(url.pathname.slice(prefix.length));
        return record ? response(200, record) : response(404, { code: "api_key_not_found" });
      }
    }
    if (
      call.authorization === `Bearer ${masterKey}` &&
      call.method === "POST" &&
      url.pathname === "/keys"
    ) {
      const payload = JSON.parse(request.body);
      const policy = Object.values(scopedMeiliKeyPolicies).find(
        (candidate) => candidate.uid === payload.uid,
      );
      assert.ok(policy);
      const key =
        policy.uid === scopedMeiliKeyPolicies.search.uid
          ? searchKey
          : policy.uid === scopedMeiliKeyPolicies.worker.uid
            ? workerKey
            : taskObserverKey;
      const record = keyRecord(policy, key);
      records.set(policy.uid, record);
      return response(201, record);
    }
    if (
      call.authorization === `Bearer ${workerKey}` &&
      call.method === "GET" &&
      call.path === "/indexes?limit=1"
    ) {
      return response(200, { results: [] });
    }
    if (
      call.authorization === `Bearer ${taskObserverKey}` &&
      call.method === "GET" &&
      call.path === "/tasks?limit=1"
    ) {
      return response(200, { results: [] });
    }
    if (
      call.authorization === `Bearer ${searchKey}` &&
      call.method === "POST" &&
      url.pathname === "/indexes/foods/search"
    ) {
      return options.searchCanary ?? response(404, { code: "index_not_found" });
    }
    if (
      [searchKey, workerKey, taskObserverKey].some(
        (key) => call.authorization === `Bearer ${key}` && url.pathname.startsWith("/keys/"),
      )
    ) {
      return response(403, { code: "invalid_api_key" });
    }
    return response(500, { code: "unexpected_test_request" });
  };

  return { calls, fetchImpl, records };
}

function bootstrapOptions(fetchImpl, extra = {}) {
  return {
    endpoint,
    expectedSearchKey: searchKey,
    expectedTaskObserverKey: taskObserverKey,
    expectedWorkerKey: workerKey,
    fetchImpl,
    masterKey,
    port: "7700",
    timeoutMs: 1_000,
    ...extra,
  };
}

async function genericFailure(promise) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ScopedMeiliKeysError);
  for (const forbidden of [
    endpoint,
    masterKey,
    searchKey,
    workerKey,
    taskObserverKey,
    "remote.example.invalid",
  ]) {
    assert.equal(error.message.includes(forbidden), false);
  }
  return error;
}

test("pins three immutable least-privilege policies without key management", () => {
  assert.deepEqual(scopedMeiliKeyPolicies.search, {
    actions: ["search"],
    description: "Search-only API key for the controlled beta",
    expiresAt: null,
    indexes: ["foods"],
    name: "cronometer-gold-api-search",
    uid: "6b2e828a-7910-4b0c-861a-e5954b06533b",
  });
  assert.deepEqual(scopedMeiliKeyPolicies.worker, {
    actions: [
      "indexes.create",
      "indexes.get",
      "indexes.delete",
      "indexes.swap",
      "documents.add",
      "settings.update",
      "stats.get",
    ],
    description: "Food-index mutation key for the controlled-beta worker",
    expiresAt: null,
    indexes: ["foods*"],
    name: "cronometer-gold-worker-index-mutation-v2",
    uid: "91bdc613-7bf6-42b2-9244-cb3bffc64e23",
  });
  assert.deepEqual(scopedMeiliKeyPolicies.taskObserver, {
    actions: ["tasks.get"],
    description: "Task-observer key for the controlled-beta worker",
    expiresAt: null,
    indexes: ["*"],
    name: "cronometer-gold-worker-task-observer",
    uid: "d0ee657d-9a00-4187-a18b-3ea5f17f81b0",
  });
  for (const policy of Object.values(scopedMeiliKeyPolicies)) {
    assert.equal(
      policy.actions.some((action) => action.startsWith("keys.")),
      false,
    );
  }
});

test("creates fixed scoped keys and runs bounded positive and denial canaries", async () => {
  const fixture = createFetch({ existing: false });
  const keys = await bootstrapScopedMeiliKeys(bootstrapOptions(fixture.fetchImpl));

  assert.deepEqual(keys, {
    MEILI_ADMIN_KEY: workerKey,
    MEILI_SEARCH_KEY: searchKey,
    MEILI_TASK_OBSERVER_KEY: taskObserverKey,
  });
  assert.deepEqual(
    fixture.calls.map((call) => [call.method, call.path]),
    [
      ["GET", `/keys/${scopedMeiliKeyPolicies.search.uid}`],
      ["POST", "/keys"],
      ["GET", `/keys/${scopedMeiliKeyPolicies.worker.uid}`],
      ["POST", "/keys"],
      ["GET", `/keys/${scopedMeiliKeyPolicies.taskObserver.uid}`],
      ["POST", "/keys"],
      ["GET", "/indexes?limit=1"],
      ["GET", "/tasks?limit=1"],
      ["POST", "/indexes/foods/search"],
      ["GET", `/keys/${scopedMeiliKeyPolicies.search.uid}`],
      ["GET", `/keys/${scopedMeiliKeyPolicies.worker.uid}`],
      ["GET", `/keys/${scopedMeiliKeyPolicies.taskObserver.uid}`],
    ],
  );
  for (const call of fixture.calls) {
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
  }
  const creationPayloads = fixture.calls
    .filter((call) => call.method === "POST" && call.path === "/keys")
    .map((call) => JSON.parse(call.body));
  assert.deepEqual(creationPayloads, [
    {
      actions: [...scopedMeiliKeyPolicies.search.actions],
      description: scopedMeiliKeyPolicies.search.description,
      expiresAt: scopedMeiliKeyPolicies.search.expiresAt,
      indexes: [...scopedMeiliKeyPolicies.search.indexes],
      name: scopedMeiliKeyPolicies.search.name,
      uid: scopedMeiliKeyPolicies.search.uid,
    },
    {
      actions: [...scopedMeiliKeyPolicies.worker.actions],
      description: scopedMeiliKeyPolicies.worker.description,
      expiresAt: scopedMeiliKeyPolicies.worker.expiresAt,
      indexes: [...scopedMeiliKeyPolicies.worker.indexes],
      name: scopedMeiliKeyPolicies.worker.name,
      uid: scopedMeiliKeyPolicies.worker.uid,
    },
    {
      actions: [...scopedMeiliKeyPolicies.taskObserver.actions],
      description: scopedMeiliKeyPolicies.taskObserver.description,
      expiresAt: scopedMeiliKeyPolicies.taskObserver.expiresAt,
      indexes: [...scopedMeiliKeyPolicies.taskObserver.indexes],
      name: scopedMeiliKeyPolicies.taskObserver.name,
      uid: scopedMeiliKeyPolicies.taskObserver.uid,
    },
  ]);
  assert.equal(fixture.calls[6].authorization, `Bearer ${workerKey}`);
  assert.equal(fixture.calls[7].authorization, `Bearer ${taskObserverKey}`);
  assert.equal(fixture.calls[8].authorization, `Bearer ${searchKey}`);
});

test("reads existing exact policies without attempting key creation", async () => {
  const fixture = createFetch({ searchCanary: response(200, { hits: [] }) });
  await bootstrapScopedMeiliKeys(bootstrapOptions(fixture.fetchImpl));

  assert.equal(
    fixture.calls.some((call) => call.method === "POST" && call.path === "/keys"),
    false,
  );
  assert.deepEqual(
    fixture.calls.slice(0, 3).map((call) => call.authorization),
    [`Bearer ${masterKey}`, `Bearer ${masterKey}`, `Bearer ${masterKey}`],
  );
});

test("rejects master-equivalent and collapsed expected scoped credentials before I/O", async () => {
  for (const extra of [
    { expectedTaskObserverKey: masterKey },
    { expectedTaskObserverKey: workerKey },
    { expectedSearchKey: taskObserverKey },
  ]) {
    let requested = false;
    await genericFailure(
      bootstrapScopedMeiliKeys(
        bootstrapOptions(async () => {
          requested = true;
          return response(500);
        }, extra),
      ),
    );
    assert.equal(requested, false);
  }
});

test("rejects every non-exact loopback endpoint before issuing a request", async () => {
  const rejectedEndpoints = [
    "http://localhost:7700",
    "http://[::1]:7700",
    "https://127.0.0.1:7700",
    "http://127.0.0.1:7700/extra",
    "http://127.0.0.1:7700?key=value",
    "http://127.0.0.1:7701",
    "http://127.0.0.1:07700",
  ];

  for (const rejectedEndpoint of rejectedEndpoints) {
    let requested = false;
    await genericFailure(
      bootstrapScopedMeiliKeys(
        bootstrapOptions(
          async () => {
            requested = true;
            return response(500);
          },
          { endpoint: rejectedEndpoint },
        ),
      ),
    );
    assert.equal(requested, false);
  }
});

test("rejects immutable policy drift before running any canary", async () => {
  const drifted = keyRecord(scopedMeiliKeyPolicies.search, searchKey);
  drifted.actions = ["search", "keys.get"];
  const fixture = createFetch({ searchRecord: drifted });

  await genericFailure(bootstrapScopedMeiliKeys(bootstrapOptions(fixture.fetchImpl)));
  assert.equal(fixture.calls.length, 1);
});

test("rejects malformed responses, invalid generated keys, and expected-key mismatch", async () => {
  const cases = [
    {
      override: (call) => (call.method === "GET" ? response(200, "not-json") : undefined),
    },
    {
      searchRecord: { ...keyRecord(scopedMeiliKeyPolicies.search, searchKey), key: undefined },
    },
    {
      searchRecord: { ...keyRecord(scopedMeiliKeyPolicies.search, searchKey), key: "short" },
    },
    {
      expectedSearchKey: "c".repeat(64),
    },
    {
      override: (call) =>
        call.method === "GET" ? response(503, { message: masterKey }) : undefined,
    },
  ];

  for (const testCase of cases) {
    const fixture = createFetch(testCase);
    await genericFailure(
      bootstrapScopedMeiliKeys(
        bootstrapOptions(fixture.fetchImpl, {
          ...(testCase.expectedSearchKey ? { expectedSearchKey: testCase.expectedSearchKey } : {}),
        }),
      ),
    );
  }
});

test("cancels a chunked WHATWG response as soon as it crosses 64 KiB", async () => {
  const events = { cancelled: false, pulls: 0 };
  const chunks = [
    new Uint8Array(32 * 1_024).fill(0x61),
    new Uint8Array(32 * 1_024).fill(0x62),
    new Uint8Array([0x63]),
  ];
  let index = 0;
  const oversized = new Response(
    new ReadableStream({
      cancel() {
        events.cancelled = true;
      },
      pull(controller) {
        events.pulls += 1;
        if (index === chunks.length) return;
        controller.enqueue(chunks[index]);
        index += 1;
      },
    }),
    { status: 200 },
  );
  const fixture = createFetch({
    override: (call) => (call.method === "GET" ? oversized : undefined),
  });

  await genericFailure(bootstrapScopedMeiliKeys(bootstrapOptions(fixture.fetchImpl)));
  assert.equal(events.cancelled, true);
  assert.ok(events.pulls >= 3);
});

test("bounds stalled requests and replaces thrown credential-bearing errors", async () => {
  await genericFailure(
    bootstrapScopedMeiliKeys(
      bootstrapOptions(async () => {
        throw new Error(`${endpoint} ${masterKey} ${workerKey}`);
      }),
    ),
  );

  const startedAt = Date.now();
  await genericFailure(
    bootstrapScopedMeiliKeys(
      bootstrapOptions(
        async () =>
          new Promise(() => {
            // The production fetch honors AbortSignal; the race also bounds a broken implementation.
          }),
        { timeoutMs: 5 },
      ),
    ),
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("fails closed on worker, search, and key-management canary regressions", async () => {
  const cases = [
    (call) => (call.path === "/indexes?limit=1" ? response(403) : undefined),
    (call) => (call.path === "/tasks?limit=1" ? response(500) : undefined),
    (call) => (call.path === "/indexes/foods/search" ? response(403) : undefined),
    (call) =>
      call.path === "/indexes/foods/search"
        ? response(404, { code: "invalid_api_key" })
        : undefined,
    (call) =>
      call.authorization === `Bearer ${searchKey}` && call.path.startsWith("/keys/")
        ? response(200, keyRecord(scopedMeiliKeyPolicies.search, searchKey))
        : undefined,
    (call) =>
      call.authorization === `Bearer ${workerKey}` && call.path.startsWith("/keys/")
        ? response(200, keyRecord(scopedMeiliKeyPolicies.worker, workerKey))
        : undefined,
    (call) =>
      call.authorization === `Bearer ${taskObserverKey}` && call.path.startsWith("/keys/")
        ? response(200, keyRecord(scopedMeiliKeyPolicies.taskObserver, taskObserverKey))
        : undefined,
  ];

  for (const override of cases) {
    const fixture = createFetch({ override });
    await genericFailure(bootstrapScopedMeiliKeys(bootstrapOptions(fixture.fetchImpl)));
  }
});

test("writes an exclusive owner-only scoped-key file without the master credential", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-meili-output-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  const outputPath = resolve(directory, "keys.env");

  await writeScopedMeiliKeysFile(outputPath, {
    MEILI_ADMIN_KEY: workerKey,
    MEILI_SEARCH_KEY: searchKey,
    MEILI_TASK_OBSERVER_KEY: taskObserverKey,
  });
  const metadata = await stat(outputPath);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);
  const contents = await readFile(outputPath, "utf8");
  assert.equal(
    contents,
    `MEILI_SEARCH_KEY=${searchKey}\n` +
      `MEILI_ADMIN_KEY=${workerKey}\n` +
      `MEILI_TASK_OBSERVER_KEY=${taskObserverKey}\n`,
  );
  assert.equal(contents.includes(masterKey), false);
});

test("never overwrites an existing output file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-meili-no-overwrite-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  const outputPath = resolve(directory, "keys.env");
  await writeFile(outputPath, "operator-owned\n", { mode: 0o600 });

  await genericFailure(
    writeScopedMeiliKeysFile(outputPath, {
      MEILI_ADMIN_KEY: workerKey,
      MEILI_SEARCH_KEY: searchKey,
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    }),
  );
  assert.equal(await readFile(outputPath, "utf8"), "operator-owned\n");
});

test("scrubs the owned descriptor without unlinking a replacement pathname", async () => {
  const outputPath = resolve(tmpdir(), "synthetic-scoped-meili-output.env");
  const closed = [];
  const truncated = [];
  const fakeHandle = {
    chmod: async () => undefined,
    close: async () => closed.push(true),
    stat: async () => ({ isFile: () => true, mode: 0o100600, nlink: 1, uid: 1_000 }),
    sync: async () => undefined,
    truncate: async (size) => truncated.push(size),
    writeFile: async () => {
      throw new Error(`${masterKey} ${endpoint}`);
    },
  };
  let observedFlags;
  let observedMode;
  let pathnameRemovals = 0;

  await genericFailure(
    writeScopedMeiliKeysFile(
      outputPath,
      {
        MEILI_ADMIN_KEY: workerKey,
        MEILI_SEARCH_KEY: searchKey,
        MEILI_TASK_OBSERVER_KEY: taskObserverKey,
      },
      {
        getuid: () => 1_000,
        open: async (_path, flags, mode) => {
          observedFlags = flags;
          observedMode = mode;
          return fakeHandle;
        },
        rm: async () => {
          pathnameRemovals += 1;
        },
      },
    ),
  );
  assert.equal(observedMode, 0o600);
  assert.equal((observedFlags & constants.O_EXCL) !== 0, true);
  assert.deepEqual(truncated, [0]);
  assert.deepEqual(closed, [true]);
  assert.equal(pathnameRemovals, 0);
});

test("leaves an owner-only empty sentinel when output validation fails after creation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-meili-scrubbed-output-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  const outputPath = resolve(directory, "keys.env");

  await genericFailure(
    writeScopedMeiliKeysFile(outputPath, {
      MEILI_ADMIN_KEY: "invalid",
      MEILI_SEARCH_KEY: searchKey,
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    }),
  );
  const metadata = await stat(outputPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(await readFile(outputPath, "utf8"), "");
});

test("CLI writes output only after a successful bootstrap and leaves none on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-meili-cli-"));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  const outputPath = resolve(directory, "keys.env");
  const environment = {
    MEILI_ADMIN_KEY: "bootstrap-replaced-scoped-admin-key-not-for-production",
    MEILI_MASTER_KEY: masterKey,
    MEILI_PORT: "7700",
    MEILI_SEARCH_KEY: "bootstrap-replaced-scoped-search-key-not-for-production",
    MEILI_TASK_OBSERVER_KEY: "bootstrap-replaced-scoped-task-observer-key-not-for-production",
    MEILI_URL: endpoint,
  };
  const fixture = createFetch();

  await runScopedMeiliKeysCli({
    argv: ["--output-file", outputPath],
    environment,
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 1_000,
  });
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(outputPath, "utf8"),
    `MEILI_SEARCH_KEY=${searchKey}\n` +
      `MEILI_ADMIN_KEY=${workerKey}\n` +
      `MEILI_TASK_OBSERVER_KEY=${taskObserverKey}\n`,
  );

  const failedPath = resolve(directory, "failed.env");
  await genericFailure(
    runScopedMeiliKeysCli({
      argv: ["--output-file", failedPath],
      environment,
      fetchImpl: async () => {
        throw new Error(`${masterKey} ${endpoint}`);
      },
      timeoutMs: 10,
    }),
  );
  await assert.rejects(stat(failedPath), { code: "ENOENT" });
});

test("CLI no-argument mode validates ambient scoped keys as exact expectations", async () => {
  const exactEnvironment = {
    MEILI_ADMIN_KEY: workerKey,
    MEILI_MASTER_KEY: masterKey,
    MEILI_PORT: "7700",
    MEILI_SEARCH_KEY: searchKey,
    MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    MEILI_URL: endpoint,
  };
  const fixture = createFetch();

  assert.deepEqual(
    await runScopedMeiliKeysCli({
      argv: [],
      environment: exactEnvironment,
      fetchImpl: fixture.fetchImpl,
      timeoutMs: 1_000,
    }),
    {
      MEILI_ADMIN_KEY: workerKey,
      MEILI_SEARCH_KEY: searchKey,
      MEILI_TASK_OBSERVER_KEY: taskObserverKey,
    },
  );

  let requested = false;
  await genericFailure(
    runScopedMeiliKeysCli({
      argv: [],
      environment: {
        ...exactEnvironment,
        MEILI_SEARCH_KEY: "bootstrap-replaced-scoped-search-key-not-for-production",
      },
      fetchImpl: async () => {
        requested = true;
        return response(500);
      },
      timeoutMs: 1_000,
    }),
  );
  assert.equal(requested, false);

  const mismatchFixture = createFetch();
  await genericFailure(
    runScopedMeiliKeysCli({
      argv: [],
      environment: { ...exactEnvironment, MEILI_SEARCH_KEY: "d".repeat(64) },
      fetchImpl: mismatchFixture.fetchImpl,
      timeoutMs: 1_000,
    }),
  );
  assert.equal(mismatchFixture.calls.length, 1);
});
