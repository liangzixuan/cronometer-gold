import assert from "node:assert/strict";
import test from "node:test";

import { compareRestoreEvidence, parseRestoreDrillArguments } from "./postgres-restore-drill.mjs";

test("accepts only an explicit isolated restore target", () => {
  assert.deepEqual(
    parseRestoreDrillArguments([
      "--container",
      "postgres-test-1",
      "--dump-directory",
      "/dev/shm",
      "--dump-protection",
      "tmpfs",
      "--source-db",
      "nutrition_source",
      "--target-db",
      "nutrition_restore_ci_20260816",
      "--user",
      "nutrition",
    ]),
    {
      container: "postgres-test-1",
      dumpDirectory: "/dev/shm",
      dumpProtection: "tmpfs",
      sourceDatabase: "nutrition_source",
      targetDatabase: "nutrition_restore_ci_20260816",
      user: "nutrition",
    },
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_source",
      ]),
    /Restore target/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci;drop_database",
      ]),
    /bounded/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--dump-directory",
        "/tmp",
        "--dump-protection",
        "tmpfs",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /protected absolute directory/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--dump-directory",
        "/approved/backup",
        "--dump-protection",
        "unverified",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /tmpfs or encrypted_volume/,
  );
});

test("requires exact migration, constraint, table, and row-count evidence", () => {
  const source = {
    migrationLedger: '[{"name":"0001.sql","checksum":"abc"}]',
    tableCounts: new Map([
      ["app_user", "2"],
      ["diary", "4"],
    ]),
    unvalidatedConstraints: "0",
  };
  compareRestoreEvidence(source, {
    migrationLedger: source.migrationLedger,
    tableCounts: new Map(source.tableCounts),
    unvalidatedConstraints: "0",
  });
  assert.throws(
    () =>
      compareRestoreEvidence(source, {
        ...source,
        tableCounts: new Map([
          ["app_user", "2"],
          ["diary", "3"],
        ]),
      }),
    /diary/,
  );
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, unvalidatedConstraints: "1" }),
    /unvalidated/,
  );
});
