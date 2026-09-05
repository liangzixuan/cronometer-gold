import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const GENERATED_KEY_PATTERN = /^[a-f0-9]{64}$/u;

export const scopedMeiliKeyPolicies = Object.freeze({
  search: Object.freeze({
    actions: Object.freeze(["search"]),
    description: "Search-only API key for the controlled beta",
    expiresAt: null,
    indexes: Object.freeze(["foods"]),
    name: "cronometer-gold-api-search",
    uid: "6b2e828a-7910-4b0c-861a-e5954b06533b",
  }),
  worker: Object.freeze({
    actions: Object.freeze([
      "indexes.create",
      "indexes.get",
      "indexes.delete",
      "indexes.swap",
      "documents.add",
      "settings.update",
      "stats.get",
    ]),
    description: "Food-index mutation key for the controlled-beta worker",
    expiresAt: null,
    indexes: Object.freeze(["foods*"]),
    name: "cronometer-gold-worker-index-mutation-v2",
    uid: "91bdc613-7bf6-42b2-9244-cb3bffc64e23",
  }),
  taskObserver: Object.freeze({
    actions: Object.freeze(["tasks.get"]),
    description: "Task-observer key for the controlled-beta worker",
    expiresAt: null,
    indexes: Object.freeze(["*"]),
    name: "cronometer-gold-worker-task-observer",
    uid: "d0ee657d-9a00-4187-a18b-3ea5f17f81b0",
  }),
});

export class ScopedMeiliKeysError extends Error {
  constructor(stage) {
    super(`Scoped Meilisearch key bootstrap failed during ${stage}`);
    this.name = "ScopedMeiliKeysError";
    this.stage = stage;
  }
}

function fail(stage) {
  throw new ScopedMeiliKeysError(stage);
}

function exactPort(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    fail("configuration validation");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535 || String(parsed) !== value) {
    fail("configuration validation");
  }
  return value;
}

function exactLoopbackEndpoint(value, port) {
  if (typeof value !== "string" || value !== `http://127.0.0.1:${port}`) {
    fail("configuration validation");
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("configuration validation");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port !== port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    fail("configuration validation");
  }
  return value;
}

function masterCredential(value) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\r\n]/u.test(value)
  ) {
    fail("configuration validation");
  }
  return value;
}

function generatedCredential(value, stage) {
  if (typeof value !== "string" || !GENERATED_KEY_PATTERN.test(value)) fail(stage);
  return value;
}

function boundedTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    fail("configuration validation");
  }
  return value;
}

function sameStrings(actual, expected) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== "string") ||
    new Set(actual).size !== actual.length
  ) {
    return false;
  }
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseObject(value, stage) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(stage);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(stage);
  return parsed;
}

async function readBoundedResponseBody(response) {
  if (response.body === null) return "";
  if (
    typeof response.body !== "object" ||
    response.body === null ||
    typeof response.body.getReader !== "function"
  ) {
    fail("response validation");
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    fail("response validation");
  }
  if (typeof reader !== "object" || reader === null || typeof reader.read !== "function") {
    fail("response validation");
  }

  const chunks = [];
  let completed = false;
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (typeof chunk !== "object" || chunk === null || typeof chunk.done !== "boolean") {
        fail("response validation");
      }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail("response validation");
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) fail("response validation");
      chunks.push(Buffer.from(chunk.value));
    }
    completed = true;
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    if (!completed && typeof reader.cancel === "function") {
      try {
        const cancellation = reader.cancel();
        if (cancellation && typeof cancellation.catch === "function") {
          void cancellation.catch(() => undefined);
        }
      } catch {
        // The fail-closed response error remains authoritative.
      }
    }
    if (typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch {
        // A pending aborted read may retain the lock until fetch settles.
      }
    }
  }
}

async function boundedRequest(fetchImpl, endpoint, path, init, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ScopedMeiliKeysError("bounded request"));
    }, timeoutMs);
  });

  try {
    const operation = (async () => {
      const response = await fetchImpl(`${endpoint}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (typeof response !== "object" || response === null || !Number.isInteger(response.status)) {
        fail("response validation");
      }
      const body = await readBoundedResponseBody(response);
      return { body, status: response.status };
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ScopedMeiliKeysError) throw error;
    fail("bounded request");
  } finally {
    clearTimeout(timer);
  }
}

function authorization(key) {
  return { Authorization: `Bearer ${key}` };
}

function validateKeyRecord(record, policy, expectedKey, masterKey) {
  if (
    record.uid !== policy.uid ||
    record.name !== policy.name ||
    record.description !== policy.description ||
    record.expiresAt !== policy.expiresAt ||
    !sameStrings(record.actions, policy.actions) ||
    !sameStrings(record.indexes, policy.indexes)
  ) {
    fail("key policy validation");
  }
  const key = generatedCredential(record.key, "key response validation");
  if (key === masterKey || (expectedKey !== undefined && key !== expectedKey)) {
    fail("key response validation");
  }
  return key;
}

async function getKeyRecord(fetchImpl, endpoint, masterKey, policy, timeoutMs) {
  return boundedRequest(
    fetchImpl,
    endpoint,
    `/keys/${policy.uid}`,
    { headers: authorization(masterKey), method: "GET" },
    timeoutMs,
  );
}

async function readOrCreateKey({ endpoint, expectedKey, fetchImpl, masterKey, policy, timeoutMs }) {
  let response = await getKeyRecord(fetchImpl, endpoint, masterKey, policy, timeoutMs);
  if (response.status === 404) {
    response = await boundedRequest(
      fetchImpl,
      endpoint,
      "/keys",
      {
        body: JSON.stringify({
          actions: policy.actions,
          description: policy.description,
          expiresAt: policy.expiresAt,
          indexes: policy.indexes,
          name: policy.name,
          uid: policy.uid,
        }),
        headers: {
          ...authorization(masterKey),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      timeoutMs,
    );
    if (response.status === 409) {
      response = await getKeyRecord(fetchImpl, endpoint, masterKey, policy, timeoutMs);
    }
    if (response.status !== 201 && response.status !== 200) fail("key creation");
  } else if (response.status !== 200) {
    fail("key retrieval");
  }

  return validateKeyRecord(
    parseObject(response.body, "key response validation"),
    policy,
    expectedKey,
    masterKey,
  );
}

async function requireScopedGetCanary(fetchImpl, endpoint, path, scopedKey, stage, timeoutMs) {
  const response = await boundedRequest(
    fetchImpl,
    endpoint,
    path,
    { headers: authorization(scopedKey), method: "GET" },
    timeoutMs,
  );
  if (response.status !== 200) fail(stage);
}

async function requireSearchCanary(fetchImpl, endpoint, searchKey, timeoutMs) {
  const response = await boundedRequest(
    fetchImpl,
    endpoint,
    "/indexes/foods/search",
    {
      body: JSON.stringify({ q: "" }),
      headers: {
        ...authorization(searchKey),
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    timeoutMs,
  );
  if (response.status === 200) return;
  if (response.status === 404) {
    const body = parseObject(response.body, "search permission canary");
    if (body.code === "index_not_found") return;
  }
  fail("search permission canary");
}

async function requireKeyManagementDenial(fetchImpl, endpoint, policy, scopedKey, timeoutMs) {
  const response = await boundedRequest(
    fetchImpl,
    endpoint,
    `/keys/${policy.uid}`,
    { headers: authorization(scopedKey), method: "GET" },
    timeoutMs,
  );
  if (response.status !== 403) fail("key-management denial canary");
}

export async function bootstrapScopedMeiliKeys(options = {}) {
  const port = exactPort(options.port);
  const endpoint = exactLoopbackEndpoint(options.endpoint, port);
  const masterKey = masterCredential(options.masterKey);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("configuration validation");

  const expectedSearchKey =
    options.expectedSearchKey === undefined
      ? undefined
      : generatedCredential(options.expectedSearchKey, "configuration validation");
  const expectedWorkerKey =
    options.expectedWorkerKey === undefined
      ? undefined
      : generatedCredential(options.expectedWorkerKey, "configuration validation");
  const expectedTaskObserverKey =
    options.expectedTaskObserverKey === undefined
      ? undefined
      : generatedCredential(options.expectedTaskObserverKey, "configuration validation");
  const expectedKeys = [expectedSearchKey, expectedWorkerKey, expectedTaskObserverKey].filter(
    (key) => key !== undefined,
  );
  if (
    expectedKeys.some((key) => key === masterKey) ||
    new Set(expectedKeys).size !== expectedKeys.length
  ) {
    fail("configuration validation");
  }

  const searchKey = await readOrCreateKey({
    endpoint,
    expectedKey: expectedSearchKey,
    fetchImpl,
    masterKey,
    policy: scopedMeiliKeyPolicies.search,
    timeoutMs,
  });
  const workerKey = await readOrCreateKey({
    endpoint,
    expectedKey: expectedWorkerKey,
    fetchImpl,
    masterKey,
    policy: scopedMeiliKeyPolicies.worker,
    timeoutMs,
  });
  const taskObserverKey = await readOrCreateKey({
    endpoint,
    expectedKey: expectedTaskObserverKey,
    fetchImpl,
    masterKey,
    policy: scopedMeiliKeyPolicies.taskObserver,
    timeoutMs,
  });
  if (new Set([searchKey, workerKey, taskObserverKey]).size !== 3) {
    fail("key response validation");
  }

  await requireScopedGetCanary(
    fetchImpl,
    endpoint,
    "/indexes?limit=1",
    workerKey,
    "worker permission canary",
    timeoutMs,
  );
  await requireScopedGetCanary(
    fetchImpl,
    endpoint,
    "/tasks?limit=1",
    taskObserverKey,
    "task-observer permission canary",
    timeoutMs,
  );
  await requireSearchCanary(fetchImpl, endpoint, searchKey, timeoutMs);
  await requireKeyManagementDenial(
    fetchImpl,
    endpoint,
    scopedMeiliKeyPolicies.search,
    searchKey,
    timeoutMs,
  );
  await requireKeyManagementDenial(
    fetchImpl,
    endpoint,
    scopedMeiliKeyPolicies.worker,
    workerKey,
    timeoutMs,
  );
  await requireKeyManagementDenial(
    fetchImpl,
    endpoint,
    scopedMeiliKeyPolicies.taskObserver,
    taskObserverKey,
    timeoutMs,
  );

  return Object.freeze({
    MEILI_ADMIN_KEY: workerKey,
    MEILI_SEARCH_KEY: searchKey,
    MEILI_TASK_OBSERVER_KEY: taskObserverKey,
  });
}

function exactOutputPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root
  ) {
    fail("output validation");
  }
  return value;
}

function outputContents(keys) {
  const searchKey = generatedCredential(keys?.MEILI_SEARCH_KEY, "output validation");
  const workerKey = generatedCredential(keys?.MEILI_ADMIN_KEY, "output validation");
  const taskObserverKey = generatedCredential(keys?.MEILI_TASK_OBSERVER_KEY, "output validation");
  if (new Set([searchKey, workerKey, taskObserverKey]).size !== 3) fail("output validation");
  return (
    `MEILI_SEARCH_KEY=${searchKey}\n` +
    `MEILI_ADMIN_KEY=${workerKey}\n` +
    `MEILI_TASK_OBSERVER_KEY=${taskObserverKey}\n`
  );
}

export async function writeScopedMeiliKeysFile(outputPath, keys, dependencies = {}) {
  const target = exactOutputPath(outputPath);
  const openFile = dependencies.open ?? open;
  const getuid =
    dependencies.getuid ??
    (() => (typeof process.getuid === "function" ? process.getuid() : undefined));
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;

  try {
    handle = await openFile(target, flags, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(outputContents(keys), { encoding: "utf8" });
    await handle.sync();
    const metadata = await handle.stat();
    const uid = getuid();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (uid !== undefined && metadata.uid !== uid)
    ) {
      fail("output validation");
    }
    await handle.close();
    handle = undefined;
  } catch {
    if (handle !== undefined) {
      try {
        await handle.truncate(0);
        await handle.sync();
      } catch {
        // Keep cleanup descriptor-bound even if scrubbing fails.
      }
      try {
        await handle.close();
      } catch {
        // The generic fail-closed output error remains authoritative.
      }
    }
    fail("output creation");
  }
}

function cliOutputPath(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--output-file") return argv[1];
  fail("invocation validation");
}

export async function runScopedMeiliKeysCli(options = {}) {
  const environment = options.environment ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const outputPath = cliOutputPath(argv);
  const expectedKeys =
    outputPath === undefined
      ? {
          expectedSearchKey: Object.hasOwn(environment, "MEILI_SEARCH_KEY")
            ? environment.MEILI_SEARCH_KEY
            : undefined,
          expectedTaskObserverKey: Object.hasOwn(environment, "MEILI_TASK_OBSERVER_KEY")
            ? environment.MEILI_TASK_OBSERVER_KEY
            : undefined,
          expectedWorkerKey: Object.hasOwn(environment, "MEILI_ADMIN_KEY")
            ? environment.MEILI_ADMIN_KEY
            : undefined,
        }
      : {};
  const keys = await bootstrapScopedMeiliKeys({
    endpoint: environment.MEILI_URL,
    ...expectedKeys,
    fetchImpl: options.fetchImpl,
    masterKey: environment.MEILI_MASTER_KEY,
    port: environment.MEILI_PORT,
    timeoutMs: options.timeoutMs,
  });
  if (outputPath !== undefined) {
    const writeOutput = options.writeOutput ?? writeScopedMeiliKeysFile;
    await writeOutput(outputPath, keys, options.outputDependencies);
  }
  return keys;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void runScopedMeiliKeysCli().catch(() => {
    process.stderr.write("Scoped Meilisearch key bootstrap failed.\n");
    process.exitCode = 1;
  });
}
