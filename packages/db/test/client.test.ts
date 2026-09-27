import { type LogEvent, type Logger, sql } from "kysely";
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabase,
  createDatabaseFromEnvironment,
  hasDatabaseTlsQueryParameter,
} from "../src/index.js";

describe("database transport configuration", () => {
  it("fails closed unless production PostgreSQL verifies the server certificate", async () => {
    expect(() =>
      createDatabaseFromEnvironment({
        DATABASE_SSL_MODE: "disable",
        DATABASE_URL: "postgresql://database.invalid/nutrition",
        NODE_ENV: "production",
      }),
    ).toThrow("DATABASE_SSL_MODE=verify-full is required in production");

    const database = createDatabaseFromEnvironment({
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_URL: "postgresql://database.invalid/nutrition",
      NODE_ENV: "production",
    });
    await database.destroy();
  });

  it.each([
    "ssl=0",
    "sslmode=disable",
    "sslcert=%2Ftmp%2Fclient.crt",
    "sslkey=%2Ftmp%2Fclient.key",
    "sslrootcert=%2Ftmp%2Froot.crt",
    "sslnegotiation=postgres",
    "uselibpqcompat=true&sslmode=require",
  ])("rejects connection-string TLS overrides before constructing a pool: %s", (query) => {
    expect(hasDatabaseTlsQueryParameter(`postgresql://database.invalid/nutrition?${query}`)).toBe(
      true,
    );
    expect(() =>
      createDatabaseFromEnvironment({
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_URL: `postgresql://database.invalid/nutrition?${query}`,
        NODE_ENV: "production",
      }),
    ).toThrow("DATABASE_URL must not contain TLS query parameters");
  });
});

function fakeConnection(fail?: Error) {
  const rows = [{ answer: 1 }];
  const query = vi.fn(async (statement: string, _parameters?: readonly unknown[]) => {
    if (fail && statement.includes("driver_failure")) throw fail;
    return { command: "SELECT", rowCount: rows.length, rows };
  });
  const release = vi.fn();
  const client = { query, release, processID: 1234 } as unknown as PoolClient;
  const connect = vi.spyOn(Pool.prototype, "connect").mockImplementation(async () => client);
  return { connect, query, release, rows };
}

afterEach(() => vi.restoreAllMocks());

describe("optional Kysely driver logger", () => {
  it("forwards one completion for begin, a successful statement and commit through the real driver", async () => {
    const connection = fakeConnection();
    const events: LogEvent[] = [];
    const log: Logger = (event) => {
      events.push(event);
    };
    const options = { connectionString: "postgresql://database.invalid/nutrition", log };
    const database = createDatabase(options);
    try {
      const rows = await database
        .transaction()
        .execute((transaction) => transaction.selectNoFrom(sql.lit(1).as("answer")).execute());
      expect(rows).toBe(connection.rows);
      expect(connection.query.mock.calls.map(([statement]) => statement)).toEqual([
        "begin",
        'select 1 as "answer"',
        "commit",
      ]);
      expect(events.map((event) => [event.level, event.query.sql])).toEqual([
        ["query", "begin"],
        ["query", 'select 1 as "answer"'],
        ["query", "commit"],
      ]);
      expect(events.map((event) => event.query.query.kind)).toEqual([
        "RawNode",
        "SelectQueryNode",
        "RawNode",
      ]);
      for (const event of events) {
        expect(Number.isFinite(event.queryDurationMillis)).toBe(true);
        expect(event.queryDurationMillis).toBeGreaterThanOrEqual(0);
      }
      expect(connection.connect).toHaveBeenCalledOnce();
      expect(connection.release).toHaveBeenCalledOnce();
    } finally {
      await database.destroy();
    }
  });
  it("forwards a failed statement once and rollback while preserving the original error", async () => {
    const failure = new Error("PRIVATE_DRIVER_FAILURE_CANARY");
    const connection = fakeConnection(failure);
    const events: LogEvent[] = [];
    const database = createDatabase({
      connectionString: "postgresql://database.invalid/nutrition",
      log: (event) => {
        events.push(event);
      },
    });
    try {
      await expect(
        database
          .transaction()
          .execute((transaction) =>
            sql`select ${"PRIVATE_PARAMETER_CANARY"} as driver_failure`.execute(transaction),
          ),
      ).rejects.toBe(failure);
      expect(connection.query.mock.calls).toEqual([
        ["begin", []],
        ["select $1 as driver_failure", ["PRIVATE_PARAMETER_CANARY"]],
        ["rollback", []],
      ]);
      expect(events.map((event) => [event.level, event.query.sql])).toEqual([
        ["query", "begin"],
        ["error", "select $1 as driver_failure"],
        ["query", "rollback"],
      ]);
      const errorEvent = events.find((event) => event.level === "error");
      expect(errorEvent?.error).toBe(failure);
      expect(connection.release).toHaveBeenCalledOnce();
    } finally {
      await database.destroy();
    }
  });

  it("includes the real driver's configured transaction command", async () => {
    const connection = fakeConnection();
    const events: LogEvent[] = [];
    const database = createDatabase({
      connectionString: "postgresql://database.invalid/nutrition",
      log: (event) => {
        events.push(event);
      },
    });
    try {
      await database
        .transaction()
        .setIsolationLevel("repeatable read")
        .setAccessMode("read only")
        .execute((transaction) => transaction.selectNoFrom(sql.lit(1).as("answer")).execute());
      expect(events.map((event) => [event.level, event.query.sql])).toEqual([
        ["query", "start transaction isolation level repeatable read read only"],
        ["query", 'select 1 as "answer"'],
        ["query", "commit"],
      ]);
      expect(connection.query).toHaveBeenCalledTimes(3);
      expect(connection.release).toHaveBeenCalledOnce();
    } finally {
      await database.destroy();
    }
  });

  it("leaves successful and failed default queries silent when no logger is configured", async () => {
    const failure = new Error("PRIVATE_DEFAULT_FAILURE_CANARY");
    const connection = fakeConnection(failure);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const database = createDatabase({
      connectionString: "postgresql://database.invalid/nutrition",
    });
    try {
      const rows = await database.selectNoFrom(sql.lit(1).as("answer")).execute();
      expect(rows).toBe(connection.rows);
      await expect(sql`select 1 as driver_failure`.execute(database)).rejects.toBe(failure);
      expect(connection.query).toHaveBeenCalledTimes(2);
      expect(connection.release).toHaveBeenCalledTimes(2);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await database.destroy();
    }
  });
});
