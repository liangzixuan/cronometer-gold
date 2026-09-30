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
  DatabaseRestoreReplayNotReadyError,
  type DatabaseRestoreReplayObservation,
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
function fixture(value: DatabaseRestoreReplayObservation, failAt?: number) {
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
              ? [{ database_name: value.databaseName, database_oid: value.databaseOid }]
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
