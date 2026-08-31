import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRetentionPrivacyDrillEnvironment,
  retentionPrivacyDrillSteps,
  runRetentionPrivacyDrill,
  runRetentionPrivacyDrillWithPrivateEnv,
} from "./run-retention-privacy-drill.mjs";
import {
  assertStepOrder,
  assertUnconditionalStep,
  workflowJob,
  workflowStep,
} from "./workflow-contract-helpers.mjs";

function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readSource(relativePath));
}

function occurrences(source, token) {
  return source.split(token).length - 1;
}

function namedImportSources(source, importedName) {
  const sources = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/gu)) {
    const bindings = match[1].split(",").map(
      (binding) =>
        binding
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0],
    );
    if (bindings.includes(importedName)) sources.push(match[2]);
  }
  return sources;
}

const stepName = "Drill retention export and erasure production wiring";
const artifactStepName = "Exercise encrypted artifact storage with split credentials";
const meiliBootstrapStepName = "Bootstrap scoped Meilisearch keys";
const meiliCleanupStepName = "Remove scoped Meilisearch key file";
const workerSearchStepName = "Exercise PostgreSQL-to-Meilisearch worker boundary";
const searchIntegrationStepName = "Exercise real search index rebuild and queries";
const expectedArtifactStep = [
  `      - name: ${artifactStepName}`,
  "        env:",
  '          RUN_ARTIFACT_STORE_INTEGRATION: "1"',
  "          EXPORT_ARTIFACT_ENDPOINT: http://127.0.0.1:9000",
  "          EXPORT_ARTIFACT_REGION: us-east-1",
  "          EXPORT_ARTIFACT_BUCKET: nutrition-private-exports",
  "          EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: nutrition_export_writer",
  "          EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: nutrition_export_writer_local_only",
  "          EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: nutrition_export_reader",
  "          EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: nutrition_export_reader_local_only",
  "          ERASURE_REPLAY_LEDGER_ENDPOINT: http://127.0.0.1:9000",
  "          ERASURE_REPLAY_LEDGER_REGION: us-east-1",
  "          ERASURE_REPLAY_LEDGER_BUCKET: nutrition-erasure-ledger",
  "          ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: nutrition_erasure_writer",
  "          ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: nutrition_erasure_writer_local_only",
  "          ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: nutrition_erasure_restore",
  "          ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: nutrition_erasure_restore_local_only",
  "        run: pnpm --filter @nutrition-tracker/artifact-store test:integration",
  "",
].join("\n");
const expectedRetentionStep = [
  `      - name: ${stepName}`,
  "        env:",
  '          RUN_RETENTION_WORKER_INTEGRATION: "1"',
  "          POSTGRES_DB: nutrition_tracker",
  "          POSTGRES_PASSWORD: nutrition_local_only",
  '          POSTGRES_PORT: "5432"',
  "          POSTGRES_USER: nutrition_local",
  "          TEST_DATABASE_URL: postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker",
  '          MINIO_API_PORT: "9000"',
  '          MEILI_PORT: "7700"',
  "          MEILI_URL: http://127.0.0.1:7700",
  "          EXPORT_ARTIFACT_ENDPOINT: http://127.0.0.1:9000",
  "          EXPORT_ARTIFACT_REGION: us-east-1",
  "          EXPORT_ARTIFACT_BUCKET: nutrition-private-exports",
  "          EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: nutrition_export_writer",
  "          EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: nutrition_export_writer_local_only",
  "          EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: nutrition_export_reader",
  "          EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: nutrition_export_reader_local_only",
  "          ERASURE_REPLAY_LEDGER_ENDPOINT: http://127.0.0.1:9000",
  "          ERASURE_REPLAY_LEDGER_REGION: us-east-1",
  "          ERASURE_REPLAY_LEDGER_BUCKET: nutrition-erasure-ledger",
  "          ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: nutrition_erasure_writer",
  "          ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: nutrition_erasure_writer_local_only",
  "          ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: nutrition_erasure_restore",
  "          ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: nutrition_erasure_restore_local_only",
  "        run: >-",
  "          node node_modules/dotenv-cli/cli.js",
  "          -o",
  "          --no-expand",
  `          -e "\${RUNNER_TEMP}/retention-meili.env"`,
  "          --",
  "          pnpm --filter @nutrition-tracker/api test:retention-integration",
  "",
].join("\n");
const expectedMeiliBootstrapStep = [
  `      - name: ${meiliBootstrapStepName}`,
  "        id: retention_meili_bootstrap",
  "        env:",
  "          MEILI_MASTER_KEY: search-integration-key-20260815",
  '          MEILI_PORT: "7700"',
  "          MEILI_URL: http://127.0.0.1:7700",
  "        run: |",
  `          target="\${RUNNER_TEMP}/retention-meili.env"`,
  `          node scripts/scoped-meili-keys.mjs --output-file "\${target}"`,
  `          identity="$(stat --format='%d:%i' -- "\${target}")"`,
  "          {",
  '            echo "created=true"',
  `            echo "identity=\${identity}"`,
  `          } >> "\${GITHUB_OUTPUT}"`,
  "",
].join("\n");
const expectedMeiliCleanupStep = [
  `      - name: ${meiliCleanupStepName}`,
  "        if: always()",
  "        env:",
  `          RETENTION_MEILI_CREATED: \${{ steps.retention_meili_bootstrap.outputs.created }}`,
  `          RETENTION_MEILI_IDENTITY: \${{ steps.retention_meili_bootstrap.outputs.identity }}`,
  "        run: |",
  `          target="\${RUNNER_TEMP}/retention-meili.env"`,
  `          if [ "\${RETENTION_MEILI_CREATED}" != "true" ] || [ ! -e "\${target}" ]; then`,
  "            exit 0",
  "          fi",
  `          if [ -L "\${target}" ] || [ ! -f "\${target}" ]; then`,
  '            echo "Refusing to remove replaced scoped Meilisearch key path" >&2',
  "            exit 1",
  "          fi",
  `          identity="$(stat --format='%d:%i' -- "\${target}")"`,
  `          links="$(stat --format='%h' -- "\${target}")"`,
  `          if [ "\${identity}" != "\${RETENTION_MEILI_IDENTITY}" ] || [ "\${links}" != "1" ]; then`,
  '            echo "Refusing to remove replaced scoped Meilisearch key file" >&2',
  "            exit 1",
  "          fi",
  `          rm -f -- "\${target}"`,
  "",
].join("\n");
const expectedWorkerSearchStep = [
  `      - name: ${workerSearchStepName}`,
  "        env:",
  "          TEST_DATABASE_URL: postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker",
  "          TEST_MEILI_URL: http://127.0.0.1:7700",
  "        run: >-",
  "          node node_modules/dotenv-cli/cli.js",
  "          -o",
  "          --no-expand",
  `          -e "\${RUNNER_TEMP}/retention-meili.env"`,
  "          --",
  "          pnpm --filter @nutrition-tracker/worker test:integration",
  "",
].join("\n");
const expectedSearchIntegrationStep = [
  `      - name: ${searchIntegrationStepName}`,
  "        env:",
  "          TEST_MEILI_URL: http://127.0.0.1:7700",
  "        run: >-",
  "          node node_modules/dotenv-cli/cli.js",
  "          -o",
  "          --no-expand",
  `          -e "\${RUNNER_TEMP}/retention-meili.env"`,
  "          --",
  "          pnpm --filter @nutrition-tracker/search test:integration",
  "",
].join("\n");

const localFixture = {
  ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID: "ambient-admin-must-not-escape",
  ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY: "ambient-admin-secret-must-not-escape",
  AWS_SECRET_ACCESS_KEY: "ambient-cloud-secret-must-not-escape",
  CI: "true",
  DATABASE_URL:
    "postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker",
  DOCKER_AUTH_CONFIG: "ambient-docker-credentials-must-not-escape",
  ERASURE_REPLAY_LEDGER_BUCKET: "nutrition-erasure-ledger",
  ERASURE_REPLAY_LEDGER_ENDPOINT: "http://127.0.0.1:9000",
  ERASURE_REPLAY_LEDGER_REGION: "us-east-1",
  ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID: "nutrition_erasure_restore",
  ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY: "nutrition_erasure_restore_local_only",
  ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID: "nutrition_erasure_writer",
  ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY: "nutrition_erasure_writer_local_only",
  EXPORT_ARTIFACT_BUCKET: "nutrition-private-exports",
  EXPORT_ARTIFACT_ENDPOINT: "http://127.0.0.1:9000",
  EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: "nutrition_export_reader",
  EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY: "nutrition_export_reader_local_only",
  EXPORT_ARTIFACT_REGION: "us-east-1",
  EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID: "nutrition_export_writer",
  EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY: "nutrition_export_writer_local_only",
  GITHUB_TOKEN: "ambient-github-token-must-not-escape",
  HEALTH_REVIEWER_PEM: "ambient-private-key-must-not-escape",
  MEILI_ADMIN_KEY: "nutrition_meili_admin_local_only",
  MEILI_MASTER_KEY: "nutrition_meili_master_local_only",
  MEILI_PORT: "7700",
  MEILI_SEARCH_KEY: "nutrition_meili_search_local_only",
  MEILI_TASK_OBSERVER_KEY: "nutrition_meili_task_observer_local_only",
  MEILI_URL: "http://127.0.0.1:7700",
  MINIO_API_PORT: "9000",
  MINIO_ROOT_PASSWORD: "nutrition_minio_root_local_only",
  MINIO_ROOT_USER: "nutrition_minio_root",
  POSTGRES_DB: "nutrition_tracker",
  POSTGRES_PASSWORD: "nutrition_local_only",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "nutrition_local",
  PATH: "/usr/local/bin:/usr/bin",
  TEST_DATABASE_URL: "postgresql://unvalidated.invalid/must-not-escape",
  VAULT_TOKEN: "unrecognized-secret-must-not-escape",
};

function assertRetentionWorkflow(source) {
  const database = workflowJob(source, "database");
  const artifactStep = workflowStep(database, artifactStepName);
  const meiliBootstrapStep = workflowStep(database, meiliBootstrapStepName);
  const step = workflowStep(database, stepName);
  const workerSearchStep = workflowStep(database, workerSearchStepName);
  const searchIntegrationStep = workflowStep(database, searchIntegrationStepName);
  const meiliCleanupStep = workflowStep(database, meiliCleanupStepName);
  assertUnconditionalStep(artifactStep, artifactStepName);
  assertUnconditionalStep(meiliBootstrapStep, meiliBootstrapStepName);
  assertUnconditionalStep(step, stepName);
  assertUnconditionalStep(workerSearchStep, workerSearchStepName);
  assertUnconditionalStep(searchIntegrationStep, searchIntegrationStepName);
  assert.equal(
    artifactStep,
    expectedArtifactStep,
    "encrypted artifact storage step and split fixture must remain exact",
  );
  assert.equal(
    meiliBootstrapStep,
    expectedMeiliBootstrapStep,
    "Meilisearch bootstrap must receive only the loopback target and master credential",
  );
  assert.equal(step, expectedRetentionStep, "retention drill step and fixture must remain exact");
  assert.equal(
    workerSearchStep,
    expectedWorkerSearchStep,
    "worker search integration must load only generated scoped Meilisearch keys",
  );
  assert.equal(
    searchIntegrationStep,
    expectedSearchIntegrationStep,
    "search integration must load only generated scoped Meilisearch keys",
  );
  assert.equal(
    meiliCleanupStep,
    expectedMeiliCleanupStep,
    "scoped Meilisearch key material must always be removed",
  );
  assertStepOrder(database, [
    "Bootstrap least-privilege private object storage",
    artifactStepName,
    "Apply and replay database migrations",
    "Exercise database integration invariants",
    "Exercise authenticated API persistence adapters",
    meiliBootstrapStepName,
    stepName,
    "Rehearse a complete PostgreSQL backup and isolated restore",
    workerSearchStepName,
    searchIntegrationStepName,
    meiliCleanupStepName,
  ]);
  assert.equal(occurrences(source, `- name: ${artifactStepName}`), 1);
  assert.equal(occurrences(source, 'RUN_ARTIFACT_STORE_INTEGRATION: "1"'), 1);
  assert.equal(occurrences(source, `- name: ${meiliBootstrapStepName}`), 1);
  assert.equal(occurrences(source, `- name: ${stepName}`), 1);
  assert.equal(occurrences(source, `- name: ${meiliCleanupStepName}`), 1);
  assert.equal(occurrences(source, 'RUN_RETENTION_WORKER_INTEGRATION: "1"'), 1);
  assert.equal(occurrences(source, "test:retention-integration"), 1);
  assert.equal(occurrences(source, "TEST_MEILI_API_KEY"), 0);
  assert.equal(occurrences(source, "scripts/scoped-meili-keys.mjs"), 1);
  assert.equal(occurrences(source, "MEILI_ADMIN_KEY:"), 0);
  assert.equal(occurrences(source, "MEILI_SEARCH_KEY:"), 0);
  assert.equal(occurrences(source, "MEILI_TASK_OBSERVER_KEY:"), 0);
  assert.equal(occurrences(database, "MEILI_MASTER_KEY: search-integration-key-20260815"), 2);
  assert.equal(occurrences(database, '          - "127.0.0.1:5432:5432"'), 1);
  assert.equal(occurrences(database, '          - "127.0.0.1:7700:7700"'), 1);
  assert.equal(occurrences(database, `\${RUNNER_TEMP}/retention-meili.env`), 5);
}

function assertSharedRuntimeComposition(sources) {
  assert.deepEqual(
    namedImportSources(sources.integration, "createApiApplicationRuntime"),
    ["../src/server.js"],
    "the drill must import the API application factory only from the production server module",
  );
  assert.deepEqual(
    namedImportSources(sources.integration, "createWorkerPollRuntime"),
    ["../../worker/src/worker-runtime.js"],
    "the drill must import the worker poll factory only from the production worker runtime",
  );
  assert.deepEqual(
    namedImportSources(sources.apiServer, "createApiSearchRuntime"),
    ["./search-runtime.js"],
    "the API application factory must retain the production dependency-runtime source",
  );
  assert.deepEqual(
    namedImportSources(sources.workerEntrypoint, "createWorkerPollRuntime"),
    ["./worker-runtime.js"],
    "the worker entrypoint must import the production worker poll factory",
  );
  assert.deepEqual(
    namedImportSources(sources.workerRuntime, "runFoodSearchWorkerPoll"),
    ["./food-search-worker.js"],
    "the shared worker runtime must use the production search poll implementation",
  );
  assert.deepEqual(
    namedImportSources(sources.workerRuntime, "runRetentionWorkerPoll"),
    ["./retention-worker.js"],
    "the shared worker runtime must use the production retention poll implementation",
  );

  assert.equal(
    occurrences(sources.integration, "createApiApplicationRuntime"),
    2,
    "the drill must import and call the production API application factory exactly once",
  );
  assert.equal(
    occurrences(sources.integration, "createWorkerPollRuntime"),
    2,
    "the drill must import and call the production worker poll factory exactly once",
  );
  assert.equal(
    occurrences(
      sources.integration,
      "const apiRuntime = await createApiApplicationRuntime(apiEnvironment, {",
    ),
    1,
    "the drill must retain the API runtime returned by the production factory",
  );
  assert.equal(
    occurrences(sources.integration, "apiRuntimeHandle = apiRuntime;"),
    1,
    "the drill must retain the exact API runtime for cleanup",
  );
  assert.equal(
    occurrences(sources.integration, "const app = apiRuntime.app;"),
    1,
    "the drill must issue requests through the app owned by the production API runtime",
  );
  assert.equal(
    occurrences(sources.integration, "apiRuntime.app"),
    1,
    "the API runtime app must have one unambiguous drill dataflow",
  );
  assert.match(sources.integration, /await app\.inject\(\{ method: "GET", url: "\/ready" \}\);/u);
  assert.equal(
    occurrences(sources.integration, "const workerRuntime = await createWorkerPollRuntime({"),
    1,
    "the drill must retain the worker runtime returned by the production factory",
  );
  assert.equal(
    occurrences(sources.integration, "workerRuntimeHandle = workerRuntime;"),
    1,
    "the drill must retain the exact worker runtime for cleanup",
  );
  assert.equal(
    occurrences(sources.integration, "await workerRuntime.pollOnce();"),
    2,
    "the drill must run exactly the export poll and the erasure poll through the shared runtime",
  );
  assert.equal(
    occurrences(sources.integration, "workerRuntime.pollOnce("),
    2,
    "the drill must not bypass or add worker polls outside the two production-runtime calls",
  );
  assert.doesNotMatch(sources.integration, /\.listen\s*\(/u);
  for (const manualComposition of [
    "buildApp",
    "SecureAuthService",
    "DatabaseRetentionService",
    "createRetentionWorkerRepository",
    "runRetentionWorkerPoll",
  ]) {
    assert.equal(
      sources.integration.includes(manualComposition),
      false,
      `the drill must not manually compose ${manualComposition}`,
    );
  }
  assert.equal(
    occurrences(
      sources.apiServer,
      "const runtime = await createApiApplicationRuntime(environment);",
    ),
    1,
    "the API entrypoint must start from the shared application runtime",
  );
  assert.equal(
    occurrences(sources.apiServer, "const { app, config } = runtime;"),
    1,
    "the API entrypoint must listen with the app and config from that runtime",
  );
  assert.equal(
    occurrences(
      sources.apiServer,
      "await app.listen({ host: config.apiHost, port: config.apiPort });",
    ),
    1,
    "the production listener must use the shared runtime's app and config",
  );
  assert.equal(
    occurrences(sources.apiServer, "app.listen("),
    1,
    "the API entrypoint must expose exactly one production listener",
  );
  assert.equal(
    occurrences(sources.workerEntrypoint, "const runtime = await createWorkerPollRuntime({"),
    1,
    "the worker entrypoint must start from the shared poll runtime",
  );
  assert.equal(
    occurrences(sources.workerEntrypoint, "onPoll: (signal) => runtime.pollOnce(signal),"),
    1,
    "the production worker loop must delegate each poll to the shared runtime",
  );
  assert.equal(
    occurrences(sources.workerEntrypoint, "runtime.pollOnce("),
    1,
    "the worker entrypoint must have one unambiguous shared-runtime poll dataflow",
  );
  assert.equal(
    occurrences(sources.workerRuntime, "await runFoodSearchWorkerPoll({"),
    1,
    "the shared worker runtime must execute one bounded search slice per poll",
  );
  assert.equal(
    occurrences(sources.workerRuntime, "await runRetentionWorkerPoll("),
    1,
    "the shared worker runtime must execute one bounded retention slice per poll",
  );
}

function runtimeCompositionSources() {
  return {
    apiServer: readSource("apps/api/src/server.ts"),
    integration: readSource("apps/api/test/retention-worker.integration.test.ts"),
    workerEntrypoint: readSource("apps/worker/src/index.ts"),
    workerRuntime: readSource("apps/worker/src/worker-runtime.ts"),
  };
}

test("binds the local privacy drill to one overridden environment and exact steps", async () => {
  const rootPackage = readJson("package.json");
  const apiPackage = readJson("apps/api/package.json");
  const releaseGates = readSource("docs/quality/release-gates.md");

  assert.equal(
    rootPackage.scripts?.["retention:privacy-drill"],
    "node scripts/run-retention-privacy-drill.mjs",
  );
  assert.equal(
    apiPackage.scripts?.["test:retention-integration"],
    "vitest run test/retention-worker.integration.test.ts",
  );
  assert.deepEqual(retentionPrivacyDrillSteps, [
    { args: ["infra:status"], label: "local dependency boundary" },
    {
      args: [
        "--filter",
        "@nutrition-tracker/api...",
        "--filter",
        "@nutrition-tracker/worker...",
        "build",
      ],
      label: "retention workspace build",
    },
    {
      args: ["--filter", "@nutrition-tracker/artifact-store", "test:integration"],
      environment: { RUN_ARTIFACT_STORE_INTEGRATION: "1" },
      label: "split encrypted artifact-store integration",
    },
    {
      args: ["--filter", "@nutrition-tracker/api", "test:retention-integration"],
      environment: { RUN_RETENTION_WORKER_INTEGRATION: "1" },
      label: "retention export and erasure integration",
    },
  ]);

  const calls = [];
  const bootstrapCalls = [];
  const scopedKeys = {
    MEILI_ADMIN_KEY: "d".repeat(64),
    MEILI_SEARCH_KEY: "c".repeat(64),
    MEILI_TASK_OBSERVER_KEY: "e".repeat(64),
  };
  assertRetentionPrivacyDrillEnvironment(localFixture);
  await runRetentionPrivacyDrill(
    (command, args, options) => {
      calls.push({
        args,
        command,
        environment: options.env,
        shell: options.shell,
        stdio: options.stdio,
      });
      return { error: undefined, signal: null, status: 0 };
    },
    localFixture,
    async (options) => {
      bootstrapCalls.push(options);
      return scopedKeys;
    },
  );
  assert.equal(calls.length, retentionPrivacyDrillSteps.length);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(call.args, retentionPrivacyDrillSteps[index].args);
    assert.equal(call.command, "pnpm");
    assert.equal(call.shell, false);
    assert.equal(call.stdio, "inherit");
    for (const forbidden of [
      "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID",
      "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "DOCKER_AUTH_CONFIG",
      "GITHUB_TOKEN",
      "HEALTH_REVIEWER_PEM",
      "VAULT_TOKEN",
    ]) {
      assert.equal(Object.hasOwn(call.environment, forbidden), false);
    }
  }

  const [infrastructure, build, artifact, retention] = calls;
  assert.deepEqual(Object.keys(infrastructure.environment).sort(), ["CI", "PATH"]);
  assert.deepEqual(Object.keys(build.environment).sort(), ["CI", "PATH"]);
  assert.deepEqual(Object.keys(artifact.environment).sort(), [
    "CI",
    "ERASURE_REPLAY_LEDGER_BUCKET",
    "ERASURE_REPLAY_LEDGER_ENDPOINT",
    "ERASURE_REPLAY_LEDGER_REGION",
    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_BUCKET",
    "EXPORT_ARTIFACT_ENDPOINT",
    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_REGION",
    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
    "PATH",
    "RUN_ARTIFACT_STORE_INTEGRATION",
  ]);
  assert.deepEqual(Object.keys(retention.environment).sort(), [
    "CI",
    "DATABASE_URL",
    "ERASURE_REPLAY_LEDGER_BUCKET",
    "ERASURE_REPLAY_LEDGER_ENDPOINT",
    "ERASURE_REPLAY_LEDGER_REGION",
    "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY",
    "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID",
    "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_BUCKET",
    "EXPORT_ARTIFACT_ENDPOINT",
    "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY",
    "EXPORT_ARTIFACT_REGION",
    "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID",
    "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY",
    "MEILI_ADMIN_KEY",
    "MEILI_PORT",
    "MEILI_SEARCH_KEY",
    "MEILI_TASK_OBSERVER_KEY",
    "MEILI_URL",
    "MINIO_API_PORT",
    "PATH",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
    "POSTGRES_PORT",
    "POSTGRES_USER",
    "RUN_RETENTION_WORKER_INTEGRATION",
  ]);
  assert.equal(Object.hasOwn(artifact.environment, "MINIO_ROOT_USER"), false);
  assert.equal(Object.hasOwn(artifact.environment, "MEILI_MASTER_KEY"), false);
  assert.equal(Object.hasOwn(retention.environment, "MINIO_ROOT_USER"), false);
  assert.equal(Object.hasOwn(retention.environment, "MEILI_MASTER_KEY"), false);
  assert.equal(Object.hasOwn(retention.environment, "TEST_DATABASE_URL"), false);
  assert.equal(retention.environment.MEILI_ADMIN_KEY, scopedKeys.MEILI_ADMIN_KEY);
  assert.equal(retention.environment.MEILI_SEARCH_KEY, scopedKeys.MEILI_SEARCH_KEY);
  assert.equal(retention.environment.MEILI_TASK_OBSERVER_KEY, scopedKeys.MEILI_TASK_OBSERVER_KEY);
  assert.deepEqual(bootstrapCalls, [
    {
      endpoint: localFixture.MEILI_URL,
      masterKey: localFixture.MEILI_MASTER_KEY,
      port: localFixture.MEILI_PORT,
    },
  ]);
  assert.match(releaseGates, /pnpm retention:privacy-drill/u);
  assert.match(releaseGates, /synthetic loopback PostgreSQL, MinIO, and Meilisearch Compose/u);
  assert.match(releaseGates, /same closeable API application runtime/u);
  assert.match(releaseGates, /same combined search\/retention worker runtime/u);
  assert.match(releaseGates, /never a cloud, public-hosting,\s+physical-phone/u);
});

test("opens, validates, and closes the private environment descriptor before the loaded run", () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const runnerPath = fileURLToPath(new URL("./run-retention-privacy-drill.mjs", import.meta.url));
  const descriptor = 17;
  const opened = [];
  const closed = [];
  const spawned = [];

  runRetentionPrivacyDrillWithPrivateEnv({
    close: (value) => closed.push(value),
    fstat: (value) => {
      assert.equal(value, descriptor);
      return { isFile: () => true, mode: 0o100600, nlink: 1, uid: 1_000 };
    },
    getuid: () => 1_000,
    open: (path, flags) => {
      opened.push({ flags, path });
      return descriptor;
    },
    spawn: (command, args, options) => {
      spawned.push({ args, command, options });
      return { error: undefined, signal: null, status: 0 };
    },
  });

  assert.deepEqual(opened, [
    {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
      path: resolve(repositoryRoot, ".env"),
    },
  ]);
  assert.deepEqual(closed, [descriptor]);
  assert.deepEqual(spawned, [
    {
      args: [
        resolve(repositoryRoot, "node_modules/dotenv-cli/cli.js"),
        "-o",
        "--no-expand",
        "-e",
        "/proc/self/fd/3",
        "--",
        process.execPath,
        runnerPath,
        "--loaded",
      ],
      command: process.execPath,
      options: {
        cwd: repositoryRoot,
        shell: false,
        stdio: ["inherit", "inherit", "inherit", descriptor],
      },
    },
  ]);
});

test("binds the drill and production entrypoints to the same closeable runtime factories", () => {
  assertSharedRuntimeComposition(runtimeCompositionSources());
});

test("rejects bypassing either shared runtime composition factory", () => {
  const sources = runtimeCompositionSources();
  for (const mutation of [
    {
      ...sources,
      integration: sources.integration.replace('from "../src/server.js";', 'from "../src/app.js";'),
    },
    {
      ...sources,
      integration: sources.integration.replace(
        'from "../../worker/src/worker-runtime.js";',
        'from "../../worker/src/index.js";',
      ),
    },
    {
      ...sources,
      integration: sources.integration.replace(
        "await createApiApplicationRuntime(apiEnvironment, {",
        "await manualApiApplicationRuntime(apiEnvironment, {",
      ),
    },
    {
      ...sources,
      integration: sources.integration.replace(
        "await createWorkerPollRuntime({",
        "await manualWorkerPollRuntime({",
      ),
    },
    {
      ...sources,
      integration: sources.integration.replace(
        "const app = apiRuntime.app;",
        "const app = apiRuntime.config;",
      ),
    },
    {
      ...sources,
      integration: sources.integration.replace(
        "await workerRuntime.pollOnce();",
        "await workerRuntimeHandle?.pollOnce();",
      ),
    },
    {
      ...sources,
      integration: `${sources.integration}\nbuildApp({});\n`,
    },
    {
      ...sources,
      apiServer: sources.apiServer.replace(
        "const runtime = await createApiApplicationRuntime(environment);",
        "const runtime = await legacyApiRuntime(environment);",
      ),
    },
    {
      ...sources,
      apiServer: sources.apiServer.replace(
        'from "./search-runtime.js";',
        'from "./legacy-search-runtime.js";',
      ),
    },
    {
      ...sources,
      apiServer: sources.apiServer.replace(
        "await app.listen({ host: config.apiHost, port: config.apiPort });",
        "await legacyApp.listen({ host: config.apiHost, port: config.apiPort });",
      ),
    },
    {
      ...sources,
      workerEntrypoint: sources.workerEntrypoint.replace(
        "const runtime = await createWorkerPollRuntime({",
        "const runtime = await legacyWorkerRuntime({",
      ),
    },
    {
      ...sources,
      workerEntrypoint: sources.workerEntrypoint.replace(
        'from "./worker-runtime.js";',
        'from "./legacy-worker-runtime.js";',
      ),
    },
    {
      ...sources,
      workerEntrypoint: sources.workerEntrypoint.replace(
        "onPoll: (signal) => runtime.pollOnce(signal),",
        "onPoll: (signal) => legacyRuntime.pollOnce(signal),",
      ),
    },
    {
      ...sources,
      workerRuntime: sources.workerRuntime.replace(
        'from "./food-search-worker.js";',
        'from "./legacy-food-search-worker.js";',
      ),
    },
    {
      ...sources,
      workerRuntime: sources.workerRuntime.replace(
        'from "./retention-worker.js";',
        'from "./legacy-retention-worker.js";',
      ),
    },
  ]) {
    assert.throws(() => assertSharedRuntimeComposition(mutation));
  }
});

test("rejects unsafe private environment metadata before parsing and still closes the file", () => {
  const metadataCases = [
    { isFile: () => false, mode: 0o100600, nlink: 1, uid: 1_000 },
    { isFile: () => true, mode: 0o100600, nlink: 2, uid: 1_000 },
    { isFile: () => true, mode: 0o100640, nlink: 1, uid: 1_000 },
    { isFile: () => true, mode: 0o100600, nlink: 1, uid: 2_000 },
  ];

  for (const metadata of metadataCases) {
    let spawnCalls = 0;
    const closed = [];
    assert.throws(() =>
      runRetentionPrivacyDrillWithPrivateEnv({
        close: (descriptor) => closed.push(descriptor),
        fstat: () => metadata,
        getuid: () => 1_000,
        open: () => 19,
        spawn: () => {
          spawnCalls += 1;
          return { error: undefined, signal: null, status: 0 };
        },
      }),
    );
    assert.deepEqual(closed, [19]);
    assert.equal(spawnCalls, 0);
  }

  let openFailureSpawnCalls = 0;
  assert.throws(() =>
    runRetentionPrivacyDrillWithPrivateEnv({
      open: () => {
        throw new Error("synthetic open failure");
      },
      spawn: () => {
        openFailureSpawnCalls += 1;
        return { error: undefined, signal: null, status: 0 };
      },
    }),
  );
  assert.equal(openFailureSpawnCalls, 0);
});

test("closes the private descriptor on every loaded-run failure", () => {
  const outcomes = [
    () => ({ error: new Error("synthetic launch failure"), signal: null, status: null }),
    () => ({ error: undefined, signal: "SIGTERM", status: null }),
    () => ({ error: undefined, signal: null, status: 9 }),
    () => {
      throw new Error("synthetic thrown launch failure");
    },
  ];

  for (const outcome of outcomes) {
    const closed = [];
    assert.throws(() =>
      runRetentionPrivacyDrillWithPrivateEnv({
        close: (descriptor) => closed.push(descriptor),
        fstat: () => ({ isFile: () => true, mode: 0o100600, nlink: 1, uid: 1_000 }),
        getuid: () => 1_000,
        open: () => 23,
        spawn: outcome,
      }),
    );
    assert.deepEqual(closed, [23]);
  }

  assert.throws(() =>
    runRetentionPrivacyDrillWithPrivateEnv({
      close: () => {
        throw new Error("synthetic close failure");
      },
      fstat: () => ({ isFile: () => true, mode: 0o100600, nlink: 1, uid: 1_000 }),
      getuid: () => 1_000,
      open: () => 29,
      spawn: () => ({ error: undefined, signal: null, status: 0 }),
    }),
  );
});

test("rejects target drift and credential collapse before launching a drill step", async () => {
  const mutations = [
    {
      ...localFixture,
      DATABASE_URL: `${localFixture.DATABASE_URL}?host=remote.example.invalid`,
    },
    { ...localFixture, EXPORT_ARTIFACT_ENDPOINT: "http://remote.example.invalid:9000" },
    { ...localFixture, MEILI_URL: "http://0.0.0.0:7700" },
    {
      ...localFixture,
      EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: localFixture.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID,
    },
    {
      ...localFixture,
      ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY:
        localFixture.ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY,
    },
    { ...localFixture, MINIO_ROOT_USER: localFixture.EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID },
    { ...localFixture, MINIO_ROOT_PASSWORD: localFixture.EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY },
    { ...localFixture, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { ...localFixture, npm_config_strict_ssl: "false" },
    { ...localFixture, GIT_SSL_NO_VERIFY: "1" },
    { ...localFixture, MINIO_ROOT_PASSWORD: "" },
  ];

  for (const mutation of mutations) {
    let calls = 0;
    await assert.rejects(
      runRetentionPrivacyDrill(
        () => {
          calls += 1;
          return { error: undefined, signal: null, status: 0 };
        },
        mutation,
        async () => ({
          MEILI_ADMIN_KEY: "d".repeat(64),
          MEILI_SEARCH_KEY: "c".repeat(64),
          MEILI_TASK_OBSERVER_KEY: "e".repeat(64),
        }),
      ),
    );
    assert.equal(calls, 0);
  }
});

test("stops after the first launch error, signal, or nonzero exit", async () => {
  for (const result of [
    { error: new Error("synthetic launch failure"), signal: null, status: null },
    { error: undefined, signal: "SIGTERM", status: null },
    { error: undefined, signal: null, status: 9 },
  ]) {
    let calls = 0;
    await assert.rejects(
      runRetentionPrivacyDrill(
        () => {
          calls += 1;
          return result;
        },
        localFixture,
        async () => ({
          MEILI_ADMIN_KEY: "d".repeat(64),
          MEILI_SEARCH_KEY: "c".repeat(64),
          MEILI_TASK_OBSERVER_KEY: "e".repeat(64),
        }),
      ),
    );
    assert.equal(calls, 1);
  }
});

test("stops after infrastructure when scoped Meilisearch bootstrap fails", async () => {
  let calls = 0;
  await assert.rejects(
    runRetentionPrivacyDrill(
      () => {
        calls += 1;
        return { error: undefined, signal: null, status: 0 };
      },
      localFixture,
      async () => {
        throw new Error("synthetic scoped-key bootstrap failure");
      },
    ),
  );
  assert.equal(calls, 1);
});

test("rejects master-equivalent or collapsed scoped Meilisearch bootstrap keys", async () => {
  const independentSearchKey = "c".repeat(64);
  const independentAdminKey = "d".repeat(64);
  const independentTaskObserverKey = "e".repeat(64);
  for (const keys of [
    {
      MEILI_ADMIN_KEY: localFixture.MEILI_MASTER_KEY,
      MEILI_SEARCH_KEY: independentSearchKey,
      MEILI_TASK_OBSERVER_KEY: independentTaskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: independentAdminKey,
      MEILI_SEARCH_KEY: localFixture.MEILI_MASTER_KEY,
      MEILI_TASK_OBSERVER_KEY: independentTaskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: independentAdminKey,
      MEILI_SEARCH_KEY: independentSearchKey,
      MEILI_TASK_OBSERVER_KEY: localFixture.MEILI_MASTER_KEY,
    },
    {
      MEILI_ADMIN_KEY: independentAdminKey,
      MEILI_SEARCH_KEY: independentAdminKey,
      MEILI_TASK_OBSERVER_KEY: independentTaskObserverKey,
    },
    {
      MEILI_ADMIN_KEY: independentAdminKey,
      MEILI_SEARCH_KEY: independentSearchKey,
      MEILI_TASK_OBSERVER_KEY: independentAdminKey,
    },
    {
      MEILI_ADMIN_KEY: independentAdminKey,
      MEILI_SEARCH_KEY: independentSearchKey,
      MEILI_TASK_OBSERVER_KEY: independentSearchKey,
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      runRetentionPrivacyDrill(
        () => {
          calls += 1;
          return { error: undefined, signal: null, status: 0 };
        },
        localFixture,
        async () => keys,
      ),
      /split scoped Meilisearch keys/u,
    );
    assert.equal(calls, 1, "no post-bootstrap child may run with rejected scoped keys");
  }
});

test("binds one ordered, unconditional CI retention drill", () => {
  assertRetentionWorkflow(readSource(".github/workflows/ci.yml"));
});

test("rejects retention drill removal, reordering, target drift, or weakened credentials", () => {
  const workflow = readSource(".github/workflows/ci.yml");
  const database = workflowJob(workflow, "database");
  const objectStorageBootstrap = workflowStep(
    database,
    "Bootstrap least-privilege private object storage",
  );
  const mutations = [
    workflow.replace(expectedArtifactStep, ""),
    workflow.replace(expectedMeiliBootstrapStep, ""),
    workflow.replace(expectedRetentionStep, ""),
    workflow.replace(expectedWorkerSearchStep, ""),
    workflow.replace(expectedSearchIntegrationStep, ""),
    workflow.replace(expectedMeiliCleanupStep, ""),
    workflow.replace(
      expectedMeiliBootstrapStep,
      expectedMeiliBootstrapStep.replace(
        "          MEILI_MASTER_KEY: search-integration-key-20260815\n",
        "",
      ),
    ),
    workflow.replace(
      expectedMeiliBootstrapStep,
      expectedMeiliBootstrapStep.replace(
        "          MEILI_URL: http://127.0.0.1:7700\n",
        "          MEILI_URL: http://0.0.0.0:7700\n",
      ),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace(
        "          MEILI_URL: http://127.0.0.1:7700\n",
        "          MEILI_URL: http://127.0.0.1:7700\n" +
          "          MEILI_ADMIN_KEY: search-integration-key-20260815\n",
      ),
    ),
    workflow.replace(
      expectedWorkerSearchStep,
      expectedWorkerSearchStep.replace(
        [
          "        run: >-",
          "          node node_modules/dotenv-cli/cli.js",
          "          -o",
          "          --no-expand",
          `          -e "\${RUNNER_TEMP}/retention-meili.env"`,
          "          --",
          "          pnpm --filter @nutrition-tracker/worker test:integration",
        ].join("\n"),
        "        run: pnpm --filter @nutrition-tracker/worker test:integration",
      ),
    ),
    workflow.replace(
      expectedSearchIntegrationStep,
      expectedSearchIntegrationStep.replace(
        "          TEST_MEILI_URL: http://127.0.0.1:7700\n",
        "          TEST_MEILI_URL: http://127.0.0.1:7700\n" +
          "          TEST_MEILI_API_KEY: search-integration-key-20260815\n",
      ),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace(
        [
          "        run: >-",
          "          node node_modules/dotenv-cli/cli.js",
          "          -o",
          "          --no-expand",
          `          -e "\${RUNNER_TEMP}/retention-meili.env"`,
          "          --",
          "          pnpm --filter @nutrition-tracker/api test:retention-integration",
        ].join("\n"),
        "        run: pnpm --filter @nutrition-tracker/api test:retention-integration",
      ),
    ),
    workflow.replace(
      expectedMeiliCleanupStep,
      expectedMeiliCleanupStep.replace("        if: always()", "        if: success()"),
    ),
    workflow.replace('          - "127.0.0.1:5432:5432"', '          - "5432:5432"'),
    workflow.replace('          - "127.0.0.1:7700:7700"', '          - "7700:7700"'),
    workflow.replace(
      expectedMeiliBootstrapStep,
      expectedMeiliBootstrapStep.replace("        id: retention_meili_bootstrap\n", ""),
    ),
    workflow.replace(
      expectedMeiliCleanupStep,
      expectedMeiliCleanupStep.replace(
        `          RETENTION_MEILI_IDENTITY: \${{ steps.retention_meili_bootstrap.outputs.identity }}\n`,
        "",
      ),
    ),
    workflow.replace(
      expectedMeiliCleanupStep,
      expectedMeiliCleanupStep.replace(
        `          if [ "\${identity}" != "\${RETENTION_MEILI_IDENTITY}" ] || [ "\${links}" != "1" ]; then`,
        "          if false; then",
      ),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace(
        "EXPORT_ARTIFACT_ENDPOINT: http://127.0.0.1:9000",
        "EXPORT_ARTIFACT_ENDPOINT: http://0.0.0.0:9000",
      ),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace(
        "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: nutrition_export_reader",
        "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID: nutrition_export_writer",
      ),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace('          RUN_RETENTION_WORKER_INTEGRATION: "1"\n', ""),
    ),
    workflow.replace(
      expectedRetentionStep,
      expectedRetentionStep.replace(
        `      - name: ${stepName}\n`,
        `      - name: ${stepName}\n        continue-on-error: true\n`,
      ),
    ),
    workflow
      .replace(expectedRetentionStep, "")
      .replace(objectStorageBootstrap, `${expectedRetentionStep}${objectStorageBootstrap}`),
    workflow
      .replace(expectedMeiliBootstrapStep, "")
      .replace(expectedRetentionStep, `${expectedRetentionStep}${expectedMeiliBootstrapStep}`),
    workflow
      .replace(expectedMeiliCleanupStep, "")
      .replace(expectedRetentionStep, `${expectedMeiliCleanupStep}${expectedRetentionStep}`),
  ];

  for (const mutation of mutations) {
    assert.throws(() => assertRetentionWorkflow(mutation));
  }
});
