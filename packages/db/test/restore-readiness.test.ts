import { createHash } from "node:crypto";
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseRestoreReplayObservation,
  assertDatabaseRestoreReplayReady,
  assertDatabaseRestoreTargetIdentity,
  completeDatabaseRestoreReplayAttestation,
  DatabaseRestoreReplayNotReadyError,
  type DatabaseRestoreReplayObservation,
  type DatabaseRestoreTargetIdentity,
  prepareDatabaseRestoreReplaySession,
} from "../src/restore.js";
import type { Database } from "../src/types.js";

const epoch = "synthetic-restore-epoch-".repeat(3);
const hash = createHash("sha256").update(epoch).digest("hex");
function observation(): DatabaseRestoreReplayObservation {
  return {
    databaseName: "nutrition_restore_test",
    databaseOid: "1234",
    attestation: {
      database_name: "nutrition_restore_test",
      database_oid: "1234",
      restore_epoch_hash: hash,
    },
  };
}
function fixture(
  value: DatabaseRestoreReplayObservation,
  failAt?: number,
  returnedRow?: Record<string, unknown>,
  identityRows?: readonly unknown[],
) {
  const calls: CompiledQuery[] = [];
  const original = new Error("synthetic query failure");
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          calls.push(query);
          if (calls.length === failAt) throw original;
          const rows =
            calls.length === 1
              ? (identityRows ?? [
                  { database_name: value.databaseName, database_oid: value.databaseOid },
                ])
              : returnedRow
                ? [returnedRow]
                : value.attestation
                  ? [value.attestation]
                  : [];
          return { rows: rows as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("Unexpected streaming query");
        },
      };
    }
  }
  const database = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, calls, original };
}
describe("shared restore replay readiness", () => {
  it("accepts current exact identity and epoch through both observation and production Kysely path", async () => {
    const value = observation(),
      db = fixture(value);
    try {
      expect(() =>
        assertDatabaseRestoreReplayObservation(value, { restoreEpoch: epoch }),
      ).not.toThrow();
      await assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: epoch });
      expect(db.calls).toHaveLength(2);
      expect(db.calls[0]?.sql).toContain("current_database()");
      expect(db.calls[1]?.sql).toContain('"database_restore_attestation"');
      expect(db.calls[1]?.parameters).toEqual([true]);
    } finally {
      await db.database.destroy();
    }
  });
  it.each(["missing", "epoch", "name", "oid"])(
    "denies %s with only the distinct stale-attestation class",
    async (kind) => {
      const current = observation();
      const value: DatabaseRestoreReplayObservation = {
        ...current,
        attestation:
          kind === "missing"
            ? undefined
            : {
                ...current.attestation!,
                ...(kind === "epoch" ? { restore_epoch_hash: "0".repeat(64) } : {}),
                ...(kind === "name" ? { database_name: "nutrition_source" } : {}),
                ...(kind === "oid" ? { database_oid: "5678" } : {}),
              },
      };
      const db = fixture(value);
      try {
        expect(() =>
          assertDatabaseRestoreReplayObservation(value, { restoreEpoch: epoch }),
        ).toThrow(DatabaseRestoreReplayNotReadyError);
        await expect(
          assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: epoch }),
        ).rejects.toThrow(DatabaseRestoreReplayNotReadyError);
      } finally {
        await db.database.destroy();
      }
    },
  );
  it.each(["", "0", "bad"])(
    "identity error %s never becomes expected readiness denial",
    async (databaseOid) => {
      const value = { ...observation(), databaseOid },
        db = fixture(value);
      try {
        for (const work of [
          () =>
            Promise.resolve(assertDatabaseRestoreReplayObservation(value, { restoreEpoch: epoch })),
          () => assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: epoch }),
        ]) {
          let caught: unknown;
          try {
            await work();
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(Error);
          expect(caught).not.toBeInstanceOf(DatabaseRestoreReplayNotReadyError);
          expect((caught as Error).message).toBe("Database identity is unavailable");
        }
      } finally {
        await db.database.destroy();
      }
    },
  );
  it.each([1, 2])("query failure at observation %s propagates unchanged", async (index) => {
    const db = fixture(observation(), index);
    try {
      await expect(
        assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: epoch }),
      ).rejects.toBe(db.original);
      expect(db.original).not.toBeInstanceOf(DatabaseRestoreReplayNotReadyError);
    } finally {
      await db.database.destroy();
    }
  });
  it("invalid epoch rejects before either production query", async () => {
    const db = fixture(observation());
    try {
      await expect(
        assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: "short" }),
      ).rejects.toThrow("DATABASE_RESTORE_EPOCH");
      expect(db.calls).toHaveLength(0);
      expect(() =>
        assertDatabaseRestoreReplayObservation(observation(), { restoreEpoch: "short" }),
      ).toThrow("DATABASE_RESTORE_EPOCH");
    } finally {
      await db.database.destroy();
    }
  });
});

const identitySql =
  "select pg_catalog.current_database() database_name, " +
  "(select oid::pg_catalog.text from pg_catalog.pg_database where datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) database_oid";
const expectedIdentity: DatabaseRestoreTargetIdentity = {
  databaseName: "nutrition_restore_test",
  databaseOid: "1234",
};

describe("exclusive restore replay role preparation", () => {
  function roleFixture(mode = "valid") {
    const calls: CompiledQuery[] = [];
    class Driver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        return {
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            calls.push(query);
            if (mode === "denied" && calls.length === 1) throw new Error("private SQL failure");
            const rows =
              calls.length === 1
                ? []
                : calls.length === 2
                  ? [{ role: mode === "role" ? "wrong_owner" : "nutrition_owner" }]
                  : [
                      {
                        database_name: "nutrition_restore_test",
                        database_oid: mode === "identity" ? "9999" : "1234",
                      },
                    ];
            return { rows: rows as R[] };
          },
          streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
            throw new Error("Unexpected stream");
          },
        };
      }
    }
    const database = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new Driver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { database, calls };
  }
  it("sets the owner as an identifier and observes role then exact cluster identity", async () => {
    const f = roleFixture();
    try {
      const result = await f.database.connection().execute((db) =>
        prepareDatabaseRestoreReplaySession(db, {
          ...expectedIdentity,
          expectedOwner: "nutrition_owner",
        }),
      );
      expect(result).toEqual(expectedIdentity);
      expect(f.calls.map((q) => q.sql.replace(/\s+/gu, " ").trim())).toEqual([
        'set role "nutrition_owner"',
        "select current_user::pg_catalog.text as role",
        identitySql,
      ]);
      expect(f.calls.every((q) => q.parameters.length === 0)).toBe(true);
    } finally {
      await f.database.destroy();
    }
  });
  it.each(["denied", "role", "identity"])(
    "refuses %s without starting traversal or a transaction",
    async (mode) => {
      const f = roleFixture(mode);
      try {
        await expect(
          prepareDatabaseRestoreReplaySession(f.database, {
            ...expectedIdentity,
            expectedOwner: "nutrition_owner",
          }),
        ).rejects.toThrow();
        expect(f.calls.length).toBe(mode === "denied" ? 1 : mode === "role" ? 2 : 3);
      } finally {
        await f.database.destroy();
      }
    },
  );
  it.each([
    { ...expectedIdentity, expectedOwner: 'bad"owner' },
    { ...expectedIdentity, expectedOwner: "nutrition_owner", extra: true },
    { ...expectedIdentity, expectedOwner: "nutrition_owner", [Symbol("private")]: true },
    Object.defineProperty({ ...expectedIdentity }, "expectedOwner", {
      get() {
        throw new Error("must not invoke getter");
      },
    }),
  ])("refuses malformed expectations before SQL", async (expected) => {
    const f = roleFixture();
    try {
      await expect(
        prepareDatabaseRestoreReplaySession(f.database, expected as never),
      ).rejects.toThrow("Expected restore session is invalid");
      expect(f.calls).toEqual([]);
    } finally {
      await f.database.destroy();
    }
  });
});

describe("observed restore target identity", () => {
  it.each([
    expectedIdentity,
    { databaseName: "_", databaseOid: "1" },
    { databaseName: "a".repeat(63), databaseOid: "4294967295" },
  ])("returns only the exact observed identity %j from one catalog query", async (expected) => {
    const db = fixture(observation(), undefined, undefined, [
      {
        database_name: expected.databaseName,
        database_oid: expected.databaseOid,
        restore_epoch: epoch,
        private_fixture: "private row payload",
      },
    ]);
    try {
      const result = await assertDatabaseRestoreTargetIdentity(db.database, expected);
      expect(result).toEqual(expected);
      expect(result).not.toBe(expected);
      expect(db.calls).toHaveLength(1);
      expect(db.calls[0]?.sql.replace(/\s+/gu, " ").trim()).toBe(identitySql);
      expect(db.calls[0]?.parameters).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(epoch);
    } finally {
      await db.database.destroy();
    }
  });

  const invalidNames = [
    "",
    "UPPER",
    "has space",
    "quoted-name",
    "a".repeat(64),
    "é",
    "x\n",
    42,
    null,
  ];
  const invalidOids = [
    "",
    "0",
    "-1",
    "01",
    "1.0",
    "1e2",
    "4294967296",
    "9999999999999999999",
    "1\n",
    1234,
    null,
  ];
  it.each([
    ...invalidNames.map((databaseName) => ({ ...expectedIdentity, databaseName })),
    ...invalidOids.map((databaseOid) => ({ ...expectedIdentity, databaseOid })),
    {},
    null,
    undefined,
  ])("refuses invalid expectation %j before querying", async (expected) => {
    const db = fixture(observation());
    try {
      await expect(
        assertDatabaseRestoreTargetIdentity(db.database, expected as DatabaseRestoreTargetIdentity),
      ).rejects.toThrow("Expected database identity is invalid");
      expect(db.calls).toHaveLength(0);
    } finally {
      await db.database.destroy();
    }
  });

  it.each([
    { database_name: "another_database", database_oid: "1234" },
    { database_name: "nutrition_restore_test", database_oid: "5678" },
  ])("refuses a different observed target %j", async (row) => {
    const db = fixture(observation(), undefined, undefined, [row]);
    try {
      await expect(
        assertDatabaseRestoreTargetIdentity(db.database, expectedIdentity),
      ).rejects.toThrow("Database target identity does not match");
      expect(db.calls).toHaveLength(1);
    } finally {
      await db.database.destroy();
    }
  });

  it.each(
    [
      [],
      [null],
      [{}],
      [observation(), observation()],
      ...invalidNames.map((database_name) => [{ database_name, database_oid: "1234" }]),
      ...invalidOids.map((database_oid) => [
        { database_name: "nutrition_restore_test", database_oid },
      ]),
      [
        { database_name: "nutrition_restore_test", database_oid: "1234" },
        { database_name: "nutrition_restore_test", database_oid: "1234" },
      ],
    ].map((rows) => ({ rows })),
  )("refuses incomplete or malformed observations %#", async ({ rows }) => {
    const db = fixture(observation(), undefined, undefined, rows);
    try {
      await expect(
        assertDatabaseRestoreTargetIdentity(db.database, expectedIdentity),
      ).rejects.toThrow("Database target identity is unavailable");
      expect(db.calls).toHaveLength(1);
    } finally {
      await db.database.destroy();
    }
  });

  it("rejects a query failure without retaining private driver details", async () => {
    const db = fixture(observation(), 1);
    db.original.message = `private driver payload ${epoch}`;
    try {
      const error = await assertDatabaseRestoreTargetIdentity(db.database, expectedIdentity).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Database target identity is unavailable");
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(epoch);
      expect(JSON.stringify(error)).not.toContain(epoch);
      expect(db.calls).toHaveLength(1);
    } finally {
      await db.database.destroy();
    }
  });

  it.each(["readiness", "attestation"])(
    "rejects duplicate identity before %s work",
    async (kind) => {
      const row = {
        database_name: expectedIdentity.databaseName,
        database_oid: expectedIdentity.databaseOid,
      };
      const db = fixture(observation(), undefined, undefined, [row, row]);
      try {
        const work =
          kind === "readiness"
            ? assertDatabaseRestoreReplayReady(db.database, { restoreEpoch: epoch })
            : completeDatabaseRestoreReplayAttestation(db.database, {
                completedAt: "2026-10-12T20:00:00.000Z",
                reconciliationDigest: "a".repeat(64),
                replayedSubjectCount: 0,
                restoreEpoch: epoch,
              });
        await expect(work).rejects.toThrow("Database identity is unavailable");
        expect(db.calls).toHaveLength(1);
      } finally {
        await db.database.destroy();
      }
    },
  );
});

describe("shared restore replay readiness", () => {
  it.each(["Nutrition", "nutrition$restore"])(
    "preserves existing helpers for database name %s",
    async (databaseName) => {
      const value = observation();
      const current = {
        ...value,
        databaseName,
        attestation: {
          database_name: databaseName,
          database_oid: value.databaseOid,
          restore_epoch_hash: hash,
        },
      };
      const completedAt = new Date("2026-10-12T20:00:00.000Z");
      const ready = fixture(current);
      const attested = fixture(current, undefined, {
        completed_at: completedAt,
        database_name: databaseName,
        database_oid: current.databaseOid,
        reconciliation_digest: "a".repeat(64),
        replayed_subject_count: "0",
        restore_epoch_hash: hash,
      });
      try {
        await assertDatabaseRestoreReplayReady(ready.database, { restoreEpoch: epoch });
        expect(
          await completeDatabaseRestoreReplayAttestation(attested.database, {
            completedAt: completedAt.toISOString(),
            reconciliationDigest: "a".repeat(64),
            replayedSubjectCount: 0,
            restoreEpoch: epoch,
          }),
        ).toEqual({
          completedAt: completedAt.toISOString(),
          databaseName,
          databaseOid: current.databaseOid,
          reconciliationDigest: "a".repeat(64),
          replayedSubjectCount: "0",
          restoreEpochHash: hash,
        });
        for (const db of [ready, attested]) {
          expect(db.calls).toHaveLength(2);
          expect(db.calls[0]?.sql.replace(/\s+/gu, " ").trim()).toBe(identitySql);
        }
      } finally {
        await ready.database.destroy();
        await attested.database.destroy();
      }
    },
  );

  it("returns committed row identity without replacing the stored epoch hash with caller input", async () => {
    const storedHash = "b".repeat(64);
    const completedAt = new Date("2026-10-12T20:00:00.000Z");
    const db = fixture(observation(), undefined, {
      completed_at: completedAt,
      database_name: "nutrition_restore_test",
      database_oid: "1234",
      reconciliation_digest: "a".repeat(64),
      replayed_subject_count: "2",
      restore_epoch_hash: storedHash,
      ignored_private_fixture: "not part of the returned record",
    });
    try {
      const result = await completeDatabaseRestoreReplayAttestation(db.database, {
        completedAt: completedAt.toISOString(),
        reconciliationDigest: "a".repeat(64),
        replayedSubjectCount: 2,
        restoreEpoch: epoch,
      });
      expect(result).toEqual({
        completedAt: completedAt.toISOString(),
        databaseName: "nutrition_restore_test",
        databaseOid: "1234",
        reconciliationDigest: "a".repeat(64),
        replayedSubjectCount: "2",
        restoreEpochHash: storedHash,
      });
      expect(storedHash).not.toBe(hash);
      expect(db.calls).toHaveLength(2);
      expect(db.calls[0]?.sql.replace(/\s+/gu, " ").trim()).toBe(identitySql);
      expect(db.calls[1]?.sql).toMatch(/^insert into "database_restore_attestation"/);
      expect(db.calls[1]?.sql).toContain('on conflict ("singleton") do update set');
      expect(db.calls[1]?.sql).toContain("returning *");
      expect(db.calls[1]?.parameters).toContain(hash);
      expect(db.calls[1]?.parameters).not.toContain(storedHash);
    } finally {
      await db.database.destroy();
    }
  });

  it("does not return an attestation when the existing write fails", async () => {
    const db = fixture(observation(), 2);
    try {
      await expect(
        completeDatabaseRestoreReplayAttestation(db.database, {
          completedAt: "2026-10-12T20:00:00.000Z",
          reconciliationDigest: "a".repeat(64),
          replayedSubjectCount: 0,
          restoreEpoch: epoch,
        }),
      ).rejects.toBe(db.original);
      expect(db.calls).toHaveLength(2);
    } finally {
      await db.database.destroy();
    }
  });
});
