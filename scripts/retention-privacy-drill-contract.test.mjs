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

const stepName = "Drill retention export and erasure production wiring";
const artifactStepName = "Exercise encrypted artifact storage with split credentials";
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
  "        run: pnpm --filter @nutrition-tracker/api test:retention-integration",
  "",
].join("\n");

const localFixture = {
  ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID: "ambient-admin-must-not-escape",
  ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY: "ambient-admin-secret-must-not-escape",
  DATABASE_URL:
    "postgresql://nutrition_local:nutrition_local_only@127.0.0.1:5432/nutrition_tracker",
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
  MINIO_API_PORT: "9000",
  MINIO_ROOT_PASSWORD: "nutrition_minio_root_local_only",
  MINIO_ROOT_USER: "nutrition_minio_root",
  POSTGRES_DB: "nutrition_tracker",
  POSTGRES_PASSWORD: "nutrition_local_only",
  POSTGRES_PORT: "5432",
  POSTGRES_USER: "nutrition_local",
};

function assertRetentionWorkflow(source) {
  const database = workflowJob(source, "database");
  const artifactStep = workflowStep(database, artifactStepName);
  const step = workflowStep(database, stepName);
  assertUnconditionalStep(artifactStep, artifactStepName);
  assertUnconditionalStep(step, stepName);
  assert.equal(
    artifactStep,
    expectedArtifactStep,
    "encrypted artifact storage step and split fixture must remain exact",
  );
  assert.equal(step, expectedRetentionStep, "retention drill step and fixture must remain exact");
  assertStepOrder(database, [
    "Bootstrap least-privilege private object storage",
    artifactStepName,
    "Apply and replay database migrations",
    "Exercise database integration invariants",
    "Exercise authenticated API persistence adapters",
    stepName,
    "Rehearse a complete PostgreSQL backup and isolated restore",
  ]);
  assert.equal(occurrences(source, `- name: ${artifactStepName}`), 1);
  assert.equal(occurrences(source, 'RUN_ARTIFACT_STORE_INTEGRATION: "1"'), 1);
  assert.equal(occurrences(source, `- name: ${stepName}`), 1);
  assert.equal(occurrences(source, 'RUN_RETENTION_WORKER_INTEGRATION: "1"'), 1);
  assert.equal(occurrences(source, "test:retention-integration"), 1);
}

test("binds the local privacy drill to one overridden environment and exact steps", () => {
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
  assertRetentionPrivacyDrillEnvironment(localFixture);
  runRetentionPrivacyDrill((command, args, options) => {
    calls.push({
      adminAccessPresent: Object.hasOwn(options.env, "ARTIFACT_STORE_ADMIN_ACCESS_KEY_ID"),
      adminSecretPresent: Object.hasOwn(options.env, "ARTIFACT_STORE_ADMIN_SECRET_ACCESS_KEY"),
      args,
      artifactFlag: options.env.RUN_ARTIFACT_STORE_INTEGRATION,
      command,
      retentionFlag: options.env.RUN_RETENTION_WORKER_INTEGRATION,
      shell: options.shell,
      stdio: options.stdio,
    });
    return { error: undefined, signal: null, status: 0 };
  }, localFixture);
  assert.deepEqual(
    calls,
    retentionPrivacyDrillSteps.map((step) => ({
      adminAccessPresent: false,
      adminSecretPresent: false,
      args: step.args,
      artifactFlag: step.environment?.RUN_ARTIFACT_STORE_INTEGRATION,
      command: "pnpm",
      retentionFlag: step.environment?.RUN_RETENTION_WORKER_INTEGRATION,
      shell: false,
      stdio: "inherit",
    })),
  );
  assert.match(releaseGates, /pnpm retention:privacy-drill/u);
  assert.match(releaseGates, /synthetic loopback PostgreSQL and MinIO Compose targets/u);
  assert.match(releaseGates, /never a cloud, public-hosting, physical-phone/u);
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

test("rejects target drift and credential collapse before launching a drill step", () => {
  const mutations = [
    {
      ...localFixture,
      DATABASE_URL: `${localFixture.DATABASE_URL}?host=remote.example.invalid`,
    },
    { ...localFixture, EXPORT_ARTIFACT_ENDPOINT: "http://remote.example.invalid:9000" },
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
    { ...localFixture, MINIO_ROOT_PASSWORD: "" },
  ];

  for (const mutation of mutations) {
    let calls = 0;
    assert.throws(() =>
      runRetentionPrivacyDrill(() => {
        calls += 1;
        return { error: undefined, signal: null, status: 0 };
      }, mutation),
    );
    assert.equal(calls, 0);
  }
});

test("stops after the first launch error, signal, or nonzero exit", () => {
  for (const result of [
    { error: new Error("synthetic launch failure"), signal: null, status: null },
    { error: undefined, signal: "SIGTERM", status: null },
    { error: undefined, signal: null, status: 9 },
  ]) {
    let calls = 0;
    assert.throws(() =>
      runRetentionPrivacyDrill(() => {
        calls += 1;
        return result;
      }, localFixture),
    );
    assert.equal(calls, 1);
  }
});

test("binds one ordered, unconditional CI retention drill", () => {
  assertRetentionWorkflow(readSource(".github/workflows/ci.yml"));
});

test("rejects retention drill removal, reordering, target drift, or weakened credentials", () => {
  const workflow = readSource(".github/workflows/ci.yml");
  const database = workflowJob(workflow, "database");
  const bootstrap = workflowStep(database, "Bootstrap least-privilege private object storage");
  const mutations = [
    workflow.replace(expectedArtifactStep, ""),
    workflow.replace(expectedRetentionStep, ""),
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
      .replace(bootstrap, `${expectedRetentionStep}${bootstrap}`),
  ];

  for (const mutation of mutations) {
    assert.throws(() => assertRetentionWorkflow(mutation));
  }
});
