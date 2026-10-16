import type { EventEmitter } from "node:events";
import { rootCertificates } from "node:tls";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { ClientConfig, Query } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TestSocket extends EventEmitter {
  destroyed: boolean;
  destroy(): TestSocket;
}
type Config = Omit<ClientConfig, "stream"> & { stream: () => TestSocket };
interface Client extends EventEmitter {
  config: Config;
  socket: TestSocket;
  calls: Query[];
  current: Query | undefined;
  endCalls: number;
}
const state = vi.hoisted(() => ({
  clients: [] as Client[],
  sockets: [] as TestSocket[],
  connect: "ok",
  end: "ok",
  autoClose: true,
  query: undefined as undefined | ((query: Query, client: Client) => void),
}));
vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  const { isIP } = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    isIP,
    Socket: class extends EventEmitter {
      destroyed = false;
      constructor() {
        super();
        state.sockets.push(this);
      }
      destroy() {
        if (!this.destroyed) {
          this.destroyed = true;
          if (state.autoClose) queueMicrotask(() => this.emit("close"));
        }
        return this;
      }
    },
  };
});
vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Client: class extends EventEmitter {
      socket: TestSocket;
      calls: Query[] = [];
      current: Query | undefined;
      endCalls = 0;
      connectingReject?: (error: unknown) => void;
      constructor(readonly config: Config) {
        super();
        this.socket = config.stream();
        state.clients.push(this);
        this.socket.once("close", () => {
          this.connectingReject?.(new Error("private-password"));
          this.current?.emit("error", new Error("private-epoch"));
          this.current = undefined;
          this.emit("end");
        });
      }
      connect() {
        if (state.connect === "throw") throw new Error("private-password");
        if (state.connect === "reject") return Promise.reject(new Error("private-password"));
        if (state.connect === "pending")
          return new Promise((_resolve, reject) => {
            this.connectingReject = reject;
          });
        return Promise.resolve(this);
      }
      query(query: Query) {
        expect(query.listenerCount("row")).toBe(1);
        this.calls.push(query);
        this.current = query;
        if (state.query) state.query(query, this);
        else queueMicrotask(() => finish(query, this, [], "SELECT"));
        return query;
      }
      end() {
        this.endCalls++;
        if (state.end === "throw") throw new Error("private-cleanup");
        if (state.end === "reject") return Promise.reject(new Error("private-cleanup"));
        if (this.socket.destroyed && state.autoClose) return Promise.resolve();
        const promise = new Promise<void>((resolve) => this.once("end", resolve));
        if (state.end !== "pending") this.socket.destroy();
        return promise;
      }
    },
  };
});

import { assertDatabaseMigrationLedgerReady } from "../src/client.js";
import { discoverMigrations, migrationSearchPath } from "../src/migrator.js";
import {
  openOwnedPostgresDatabase,
  openOwnedPostgresPool,
} from "../src/owned-postgres-database.js";
import { normalizePostgresBackupConnection } from "../src/postgres-backup-connection.js";
import {
  assertDatabaseRestoreTargetIdentity,
  prepareDatabaseRestoreReplaySession,
} from "../src/restore.js";
import { replayExternalErasureLedgerEntry } from "../src/retention.js";
import {
  ERASURE_TABLE_SPECS,
  EXPORT_ENTITY_SPECS,
  USER_LINKED_EXPORT_EXCLUSIONS,
} from "../src/retention-privacy-policy.js";

const options = {
  connection: normalizePostgresBackupConnection({
    connectionString: "postgresql://operator:private-password@database.test/nutrition",
    caCertificate: rootCertificates[0] ?? "",
  }),
};
function client() {
  const value = state.clients[0];
  if (!value) throw new Error("No fixture client");
  return value;
}
function finish(
  query: Query,
  owned: Client,
  rows: unknown[],
  command = "SELECT",
  count: unknown = rows.length,
) {
  const first = rows[0];
  const result = {
    fields: Object.keys(first && typeof first === "object" ? first : {}).map((name) => ({ name })),
    command,
    rowCount: count,
    rows: [],
  };
  for (const row of rows) query.emit("row", row, result);
  owned.current = undefined;
  query.emit("end", result);
}
function reply(rows: unknown[], command = "SELECT", count: unknown = rows.length) {
  state.query = (query, owned) => queueMicrotask(() => finish(query, owned, rows, command, count));
}
const closers: Array<() => Promise<void>> = [];
async function pool(overrides = {}) {
  const owner = await openOwnedPostgresPool({ ...options, ...overrides });
  closers.push(owner.close);
  return owner;
}
beforeEach(() => {
  state.clients.length = 0;
  state.sockets.length = 0;
  state.connect = "ok";
  state.end = "ok";
  state.autoClose = true;
  state.query = undefined;
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("uses real dialect transactions, typed rows/counts and one pinned owned connection", async () => {
  const owner = await openOwnedPostgresDatabase(options);
  closers.push(owner.close);
  const texts: string[] = [];
  state.query = (query, owned) =>
    queueMicrotask(() => {
      const text = String(Reflect.get(query, "text"));
      texts.push(text);
      if (text === "begin" || text === "commit" || text === "rollback")
        finish(query, owned, [], text.toUpperCase(), null);
      else if (text.startsWith("delete")) finish(query, owned, [], "DELETE", 12);
      else if (text.startsWith("create")) finish(query, owned, [], "CREATE", null);
      else
        finish(query, owned, [
          {
            id: "row-id",
            complete: true,
            completed_at: new Date("2026-01-01T00:00:00Z"),
            count: "0",
          },
        ]);
    });
  await owner.database.connection().execute(async (db) => {
    await db.transaction().execute(async (tx) => {
      expect(
        (
          await sql<{
            id: string;
            complete: boolean;
            completed_at: Date;
            count: string;
          }>`select ${["a", "b"]}::text[], ${new Date("2026-01-01T00:00:00Z")}, ${true}, ${500}`.execute(
            tx,
          )
        ).rows[0],
      ).toEqual({
        id: "row-id",
        complete: true,
        completed_at: new Date("2026-01-01T00:00:00Z"),
        count: "0",
      });
      expect((await sql`delete from fixture`.execute(tx)).numAffectedRows).toBe(12n);
      expect(
        (await sql`create temporary table fixture (id text)`.execute(tx)).numAffectedRows,
      ).toBeUndefined();
    });
    await expect(
      db.transaction().execute(async () => {
        throw new Error("selected failure");
      }),
    ).rejects.toThrow("selected failure");
  });
  expect(texts).toEqual([
    "begin",
    expect.stringContaining("select"),
    "delete from fixture",
    "create temporary table fixture (id text)",
    "commit",
    "begin",
    "rollback",
  ]);
  expect(state.clients).toHaveLength(1);
  expect(state.sockets).toHaveLength(1);
  for (const [i, query] of client().calls.entries()) {
    expect(Reflect.get(query, "name")).toBe(`owned_${i + 1}`);
    expect(Reflect.get(query, "callback")).toBeUndefined();
    expect(query.listenerCount("row")).toBe(0);
  }
  await owner.close();
  await owner.close();
  expect(client().endCalls).toBe(1);
});

it("closes even when Kysely never initialized its driver", async () => {
  const owner = await openOwnedPostgresDatabase(options);
  await owner.close();
  expect(client().socket.destroyed).toBe(true);
  expect(client().endCalls).toBe(1);
});

it("rejects concurrent/stale/double reservations without dispatching or opening a client", async () => {
  const owner = await pool();
  const first = await owner.pool.connect();
  expect(owner.pool.options).toEqual({});
  expect(owner.pool).not.toHaveProperty("Client");
  expect(first).not.toHaveProperty("processID");
  await expect(owner.pool.connect()).rejects.toMatchObject({ code: "CONCURRENT" });
  first.release();
  const second = await owner.pool.connect();
  await expect(first.query("select 1", [])).rejects.toMatchObject({ code: "CLOSED" });
  expect(() => first.release()).toThrow();
  await second.query("select 1", []);
  second.release();
  expect(() => second.release()).toThrow();
  expect(state.clients).toHaveLength(1);
  expect(client().calls).toHaveLength(1);
});

it("snapshots mutable Dates/arrays and does not expose input extras", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = () => undefined;
  const date = new Date("2026-01-01T00:00:00Z");
  const values = ["a"];
  const parameters = [date, values, null, true, 500];
  const pending = connection.query("select $1", parameters);
  date.setFullYear(2027);
  values[0] = "private-epoch";
  parameters[0] = null;
  expect(Reflect.get(client().calls[0] as object, "values")).toEqual([
    new Date("2026-01-01T00:00:00Z"),
    ["a"],
    null,
    true,
    500,
  ]);
  finish(client().calls[0] as Query, client(), []);
  await pending;
  connection.release();
});

for (const [label, parameters] of [
  ["undefined", [undefined]],
  ["infinite", [Infinity]],
  ["fraction", [1.2]],
  ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
  ["invalid date", [new Date(Number.NaN)]],
  ["object", [{ secret: "private-epoch" }]],
  ["buffer", [Buffer.from("private-epoch")]],
  ["nested", [[["a"]]]],
  ["array null", [[null]]],
  [
    "coercion",
    [
      {
        toPostgres() {
          throw new Error("must not invoke");
        },
      },
    ],
  ],
  ["too many", Array(1025).fill("a")],
  ["long string", ["a".repeat(8193)]],
  ["long array", [Array(1025).fill("a")]],
  ["large bytes", [Array(129).fill("a".repeat(8192))]],
] as const)
  it(`refuses ${label} parameters before dispatch and poisons owner`, async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    await expect(connection.query("select private-sql", parameters)).rejects.toMatchObject({
      code: "CONFIGURATION",
    });
    expect(client().calls).toHaveLength(0);
    expect(owner.signal.aborted).toBe(true);
    connection.release();
    await expect(owner.pool.connect()).rejects.toMatchObject({ code: "ABORTED" });
  });

it("refuses accessors without invoking them", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  const getter = vi.fn(() => "private-epoch");
  const values: string[] = [];
  Object.defineProperty(values, "0", { get: getter });
  await expect(connection.query("select", values)).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(getter).not.toHaveBeenCalled();
});

for (const command of [
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SET",
  "CREATE",
  "DROP",
  "SAVEPOINT",
  "RELEASE",
])
  it(`preserves ${command} null count`, async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    reply([], command, null);
    expect(await connection.query("utility", [])).toEqual({ command, rowCount: null, rows: [] });
  });
for (const command of ["INSERT", "UPDATE", "DELETE", "MERGE"])
  it(`preserves ${command} affected count with RETURNING`, async () => {
    const owner = await pool();
    const db = new Kysely({ dialect: new PostgresDialect({ pool: owner.pool }) });
    reply([{ id: "x" }], command, 10);
    expect(await sql`mutation`.execute(db)).toMatchObject({
      numAffectedRows: 10n,
      rows: [{ id: "x" }],
    });
  });

for (const [label, mutate] of [
  [
    "missing fields",
    (r: Record<string, unknown>) => {
      delete r.fields;
    },
  ],
  [
    "duplicate fields",
    (r: Record<string, unknown>) => {
      r.fields = [{ name: "id" }, { name: "id" }];
    },
  ],
  [
    "long name",
    (r: Record<string, unknown>) => {
      r.fields = [{ name: "x".repeat(257) }];
    },
  ],
  [
    "unknown command",
    (r: Record<string, unknown>) => {
      r.command = "COPY";
    },
  ],
  [
    "negative count",
    (r: Record<string, unknown>) => {
      r.rowCount = -1;
    },
  ],
  [
    "unsafe count",
    (r: Record<string, unknown>) => {
      r.rowCount = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "string count",
    (r: Record<string, unknown>) => {
      r.rowCount = "0";
    },
  ],
  [
    "mismatched count",
    (r: Record<string, unknown>) => {
      r.rowCount = 1;
    },
  ],
  [
    "hidden rows",
    (r: Record<string, unknown>) => {
      r.rows = [{ private: "private-epoch" }];
    },
  ],
] as const)
  it(`refuses ${label} metadata`, async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    state.query = (q, c) =>
      queueMicrotask(() => {
        const result = { command: "SELECT", rowCount: 0, rows: [], fields: [] };
        mutate(result);
        c.current = undefined;
        q.emit("end", result);
      });
    await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
    expect(owner.signal.aborted).toBe(true);
  });

for (const row of [
  { x: {} },
  { x: ["a"] },
  { x: Infinity },
  { x: new Date(Number.NaN) },
  { x: "x".repeat(1_048_577) },
])
  it("rejects unsupported/oversized decoded data without returning partial success", async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    reply([row]);
    await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
    expect(owner.signal.aborted).toBe(true);
  });

it("rejects multiple command result objects", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = (q, c) =>
    queueMicrotask(() => {
      c.current = undefined;
      q.emit("end", [{ command: "DELETE", rowCount: 1, rows: [], fields: [] }]);
    });
  await expect(connection.query("delete; select", [])).rejects.toMatchObject({ code: "RESULT" });
});

it("accepts exactly 1024 rows and refuses the next row", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  reply(Array.from({ length: 1024 }, (_, i) => ({ id: String(i) })));
  expect((await connection.query("select", [])).rows).toHaveLength(1024);
  reply(Array.from({ length: 1025 }, (_, i) => ({ id: String(i) })));
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
});

it("enforces query count across release and reserves no extra dispatch", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  for (let i = 0; i < 4096; i++) await connection.query("select", []);
  connection.release();
  const next = await owner.pool.connect();
  await expect(next.query("select", [])).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(client().calls).toHaveLength(4096);
  expect(owner.usage().queries).toBe(4096);
});
it("enforces aggregate SQL and exact per-query SQL ceiling", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  const text = "s".repeat(65_536);
  for (let i = 0; i < 256; i++) await connection.query(text, []);
  expect(owner.usage().sqlBytes).toBe(16 * 1_048_576);
  await expect(connection.query("x", [])).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(client().calls).toHaveLength(256);
});
it("enforces aggregate parameter bytes without truncation", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  const values = Array(128).fill("s".repeat(8192));
  for (let i = 0; i < 32; i++) await connection.query("select", values);
  expect(owner.usage().parameterBytes).toBe(32 * 1_048_576);
  await expect(connection.query("select", ["a"])).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(client().calls).toHaveLength(32);
});
it("enforces aggregate decoded bytes including the rejected response", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  reply([{ x: "s".repeat(1_048_575) }]);
  for (let i = 0; i < 32; i++) await connection.query("select", []);
  expect(owner.usage().decodedBytes).toBe(32 * 1_048_576);
  reply([{ x: "a" }]);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
  expect(owner.usage().decodedBytes).toBe(32 * 1_048_576 + 2);
});

it("counts admitted attempt and decoded bytes on a later driver failure, with no private error", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = (q, c) =>
    queueMicrotask(() => {
      q.emit("row", { x: "a" }, { fields: [{ name: "x" }] });
      c.current = undefined;
      q.emit("error", new Error("private-password private-epoch private-sql"));
    });
  await expect(connection.query("private-sql", ["private-epoch"])).rejects.toMatchObject({
    code: "QUERY",
    message: "Owned PostgreSQL session failed (QUERY)",
  });
  expect(owner.usage()).toEqual({ queries: 1, sqlBytes: 11, parameterBytes: 13, decodedBytes: 2 });
});

it("awaits physical closure and started query settlement after external cancellation", async () => {
  const abort = new AbortController();
  const owner = await pool({ signal: abort.signal });
  const connection = await owner.pool.connect();
  state.autoClose = false;
  state.query = () => undefined;
  let queryDone = false,
    closeDone = false;
  const pending = connection.query("select", []).catch(() => {
    queryDone = true;
  });
  abort.abort(new Error("private-epoch"));
  const closing = owner.close().then(() => {
    closeDone = true;
  });
  await Promise.resolve();
  expect(client().socket.destroyed).toBe(true);
  expect(queryDone).toBe(false);
  expect(closeDone).toBe(false);
  client().socket.emit("close");
  await pending;
  await closing;
  expect(queryDone).toBe(true);
  expect(closeDone).toBe(true);
});

for (const kind of ["query", "session"])
  it(`settles ${kind} deadline and removes timers`, async () => {
    vi.useFakeTimers();
    const owner = await pool(kind === "query" ? { queryTimeoutMs: 10 } : { timeoutMs: 10 });
    const connection = await owner.pool.connect();
    state.query = () => undefined;
    const pending = expect(connection.query("select", [])).rejects.toMatchObject({
      code: "ABORTED",
    });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    await owner.close();
    expect(vi.getTimerCount()).toBe(0);
  });
for (const mode of ["throw", "reject", "pending"])
  it(`settles ${mode} connect with owned socket`, async () => {
    vi.useFakeTimers();
    state.connect = mode;
    const pending = expect(
      openOwnedPostgresDatabase({ ...options, connectTimeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "CONNECT" });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(state.sockets[0]?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
for (const mode of ["throw", "reject", "pending"])
  it(`reports ${mode} close failure after transport closure`, async () => {
    vi.useFakeTimers();
    const owner = await pool();
    state.end = mode;
    const pending = expect(owner.close()).rejects.toMatchObject({ code: "CLEANUP" });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(client().socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

it("refuses concurrent query and release during active query then awaits it", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = () => undefined;
  const pending = expect(connection.query("select", [])).rejects.toMatchObject({ code: "ABORTED" });
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "CONCURRENT" });
  expect(() => connection.release()).toThrow();
  await pending;
  await owner.close();
  expect(client().calls).toHaveLength(1);
});

it("captures owner options and detaches the original signal listener", async () => {
  vi.useFakeTimers();
  const original = new AbortController();
  const replacement = new AbortController();
  const mutable = { ...options, signal: original.signal, queryTimeoutMs: 100, timeoutMs: 1000 };
  const owner = await openOwnedPostgresPool(mutable);
  closers.push(owner.close);
  mutable.signal = replacement.signal;
  mutable.queryTimeoutMs = Number.NaN;
  mutable.timeoutMs = Number.NaN;
  replacement.abort();
  const connection = await owner.pool.connect();
  await connection.query("select", []);
  connection.release();
  await owner.close();
  original.abort();
  expect(owner.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => client().emit("error", new Error("private-late"))).not.toThrow();
});

it("refuses an unadmitted connection and ambient TLS disable before constructing a client", async () => {
  await expect(
    openOwnedPostgresDatabase({ connection: { ...options.connection } }),
  ).rejects.toMatchObject({ code: "CONFIGURATION" });
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  await expect(openOwnedPostgresDatabase(options)).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(state.clients).toHaveLength(0);
});

it("runs committed attestation and readiness helpers over the real maintained dialect", async () => {
  const { createHash } = await import("node:crypto");
  const { completeDatabaseRestoreReplayAttestation, assertDatabaseRestoreReplayReady } =
    await import("../src/restore.js");
  const epoch = "private-restore-epoch-".repeat(3);
  const hash = createHash("sha256").update(epoch).digest("hex");
  const completedAt = "2026-10-12T20:00:00.000Z";
  const record = {
    database_name: "nutrition",
    database_oid: "123",
    restore_epoch_hash: hash,
    reconciliation_digest: "a".repeat(64),
    replayed_subject_count: "12",
    singleton: true,
    completed_at: new Date(completedAt),
    updated_at: new Date(completedAt),
  };
  const owner = await openOwnedPostgresDatabase(options);
  closers.push(owner.close);
  const queries: string[] = [];
  let attestationValues: unknown;
  state.query = (query, owned) =>
    queueMicrotask(() => {
      const text = String(Reflect.get(query, "text"));
      queries.push(text);
      if (["begin", "commit", "rollback"].includes(text))
        finish(query, owned, [], text.toUpperCase(), null);
      else if (text.includes("pg_catalog.current_database()"))
        finish(query, owned, [{ database_name: "nutrition", database_oid: "123" }]);
      else if (text.startsWith("insert")) {
        attestationValues = Reflect.get(query, "values");
        finish(query, owned, [record], "INSERT", 1);
      } else
        finish(query, owned, [
          { database_name: "nutrition", database_oid: "123", restore_epoch_hash: hash },
        ]);
    });
  await owner.database.connection().execute(async (db) => {
    const result = await completeDatabaseRestoreReplayAttestation(db, {
      restoreEpoch: epoch,
      reconciliationDigest: "a".repeat(64),
      replayedSubjectCount: 12,
      completedAt,
    });
    expect(result).toEqual({
      databaseName: "nutrition",
      databaseOid: "123",
      reconciliationDigest: "a".repeat(64),
      replayedSubjectCount: "12",
      restoreEpochHash: hash,
      completedAt,
    });
    expect(JSON.stringify(result)).not.toContain(epoch);
    expect(attestationValues).toContain(hash);
    expect(attestationValues).not.toContain(epoch);
    await assertDatabaseRestoreReplayReady(db, { restoreEpoch: epoch });
  });
  expect(queries).toHaveLength(6);
  expect(queries[3]).toBe("commit");
  expect(state.clients).toHaveLength(1);
});

it("accepts exact parameter/flat array cardinality and scalar types", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  await connection.query("select", Array(1024).fill("a"));
  await connection.query("select", [Array(1024).fill("a")]);
  const date = new Date("2026-01-01T00:00:00Z");
  reply([{ x: null, y: false, z: 1, d: date }]);
  const result = await connection.query("select", [null, false, Number.MAX_SAFE_INTEGER, date]);
  expect(result.rows).toEqual([{ x: null, y: false, z: 1, d: date }]);
  date.setFullYear(2027);
  expect((result.rows[0] as { d: Date }).d.getUTCFullYear()).toBe(2026);
});

it("accepts exact field limits then rejects excess cardinality", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  const row = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`x${i}`, null]));
  reply([row]);
  expect((await connection.query("select", [])).rows).toEqual([row]);
  reply([{ ["x".repeat(256)]: "a" }]);
  await connection.query("select", []);
  reply([{ ...row, excess: null }]);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
});
for (const text of ["", "x".repeat(65_537)])
  it("rejects invalid SQL size before dispatch", async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    await expect(connection.query(text, [])).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(client().calls).toHaveLength(0);
  });

it("counts the oversized string already decoded before refusing retained results", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  reply([{ x: "x".repeat(1_048_577) }]);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
  expect(owner.usage().decodedBytes).toBe(1_048_578);
});
it("rejects total result bytes spanning individually valid rows", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  reply([{ x: "a".repeat(524_287) }, { x: "b".repeat(524_288) }]);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
  expect(owner.usage().decodedBytes).toBe(1_048_577);
});

for (const kind of ["changed", "missing", "extra", "getter", "prototype"])
  it(`rejects ${kind} decoded field identities`, async () => {
    const owner = await pool();
    const connection = await owner.pool.connect();
    const getter = vi.fn(() => "private-epoch");
    state.query = (q, c) =>
      queueMicrotask(() => {
        const result = { command: "SELECT", rowCount: 1, fields: [{ name: "x" }], rows: [] };
        let row: object = { x: "a" };
        if (kind === "missing") row = {};
        if (kind === "extra") row = { x: "a", extra: "private-epoch" };
        if (kind === "getter") Object.defineProperty(row, "x", { get: getter });
        if (kind === "prototype") row = Object.create({ private: "private-epoch" });
        q.emit("row", row, result);
        if (kind === "changed") result.fields = [{ name: "y" }];
        c.current = undefined;
        q.emit("end", result);
      });
    await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
    expect(getter).not.toHaveBeenCalled();
  });

it("ignores late events after settlement without mutating usage or interrupting another query", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  await connection.query("select", []);
  const first = client().calls[0] as Query;
  state.query = () => undefined;
  const second = connection.query("select", []);
  const usage = owner.usage();
  first.emit("row", { private: "private-epoch" }, {});
  first.emit("end", {});
  expect(() => first.emit("error", new Error("private-late"))).not.toThrow();
  expect(owner.usage()).toEqual(usage);
  expect(owner.signal.aborted).toBe(false);
  finish(client().calls[1] as Query, client(), []);
  await second;
});

it("rejects abort before opening without a client or socket", async () => {
  const abort = new AbortController();
  abort.abort(new Error("private-epoch"));
  await expect(
    openOwnedPostgresDatabase({ ...options, signal: abort.signal }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(state.clients).toHaveLength(0);
  expect(state.sockets).toHaveLength(0);
});
it("closes and awaits an active query with no successful result", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = () => undefined;
  const pending = expect(connection.query("select", [])).rejects.toMatchObject({ code: "ABORTED" });
  await owner.close();
  await pending;
  expect(client().endCalls).toBe(1);
  expect(client().socket.destroyed).toBe(true);
});
it("refuses idle expiry before new dispatch even after a reservation release", async () => {
  vi.useFakeTimers();
  const owner = await pool({ timeoutMs: 10 });
  const connection = await owner.pool.connect();
  connection.release();
  await vi.advanceTimersByTimeAsync(10);
  await expect(owner.pool.connect()).rejects.toMatchObject({ code: "ABORTED" });
  expect(client().calls).toHaveLength(0);
  await owner.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("uses only the remaining owner lifetime for a late-starting query", async () => {
  vi.useFakeTimers();
  const owner = await pool({ timeoutMs: 100, queryTimeoutMs: 100 });
  const connection = await owner.pool.connect();
  await vi.advanceTimersByTimeAsync(90);
  state.query = () => undefined;
  const pending = expect(connection.query("select", [])).rejects.toMatchObject({ code: "ABORTED" });
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  await owner.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("sanitizes synchronous dispatch failure and consumes its admitted attempt", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = () => {
    throw new Error("private-sql private-epoch");
  };
  await expect(connection.query("private-sql", [])).rejects.toMatchObject({
    code: "QUERY",
    message: "Owned PostgreSQL session failed (QUERY)",
  });
  expect(owner.usage().queries).toBe(1);
  expect(owner.signal.aborted).toBe(true);
});
it("does not report transaction success or fabricate rollback after a driver failure", async () => {
  const owner = await openOwnedPostgresDatabase(options);
  closers.push(owner.close);
  const texts: string[] = [];
  state.query = (q, c) =>
    queueMicrotask(() => {
      const text = String(Reflect.get(q, "text"));
      texts.push(text);
      if (text === "begin") finish(q, c, [], "BEGIN", null);
      else {
        c.current = undefined;
        q.emit("error", new Error("private-driver"));
      }
    });
  await expect(
    owner.database.transaction().execute(async (tx) => sql`mutation`.execute(tx)),
  ).rejects.toMatchObject({ code: "QUERY" });
  expect(texts).toEqual(["begin", "mutation"]);
  await owner.close();
});

it("counts an oversized later field before refusing the whole row", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  reply([{ first: "ok", later: "x".repeat(1_048_577) }]);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "RESULT" });
  expect(owner.usage().decodedBytes).toBe(1_048_589);
});

it("latches synchronous rejection before a previously queued row can reach the collector", async () => {
  const owner = await pool();
  const connection = await owner.pool.connect();
  state.query = (query, owned) => {
    queueMicrotask(() => finish(query, owned, [{ private: "private-epoch" }]));
    throw new Error("private-driver");
  };
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "QUERY" });
  expect(owner.usage().decodedBytes).toBe(0);
  await expect(connection.query("select", [])).rejects.toMatchObject({ code: "QUERY" });
  expect(client().calls).toHaveLength(1);
});

it("starts object queries in the fixed application schema with existing TLS and timeouts", async () => {
  await pool();
  expect(client().config).toMatchObject({
    options: `-c search_path=${migrationSearchPath("public").replaceAll(" ", "")}`,
    application_name: "nutrition-postgres-replay",
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 0,
    query_timeout: 0,
    statement_timeout: 15_000,
    lock_timeout: 15_000,
    idle_in_transaction_session_timeout: 300_000,
  });
  expect(client().config.options).toBe("-c search_path=public,pg_catalog,pg_temp");
});

it.each([
  "complete",
  "catalog-first",
  "missing-table",
  "foreign-table",
  "missing-constraint",
  "wrong-constraint",
])(
  "keeps migration readiness and erasure classification on one connection: %s",
  async (inventory) => {
    const migrations = await discoverMigrations();
    const owner = await openOwnedPostgresDatabase(options);
    closers.push(owner.close);
    const startupPath =
      inventory === "catalog-first"
        ? "pg_catalog,public,pg_temp"
        : client().config.options?.replace("-c search_path=", "");
    if (!startupPath) throw new Error("Missing fixture startup path");
    let localPath: string | undefined;
    let transactionOpen = false;
    let activeQueries = 0;
    const commands: string[] = [];
    const catalogSchemas: string[] = [];
    const mutations: string[] = [];
    const effectiveSchema = () => (localPath ?? startupPath).split(",")[0]?.trim();
    state.query = (query, owned) => {
      expect(activeQueries++).toBe(0);
      queueMicrotask(() => {
        try {
          const text = String(Reflect.get(query, "text")).replace(/\s+/gu, " ").trim();
          const values: unknown[] = Reflect.get(query, "values") ?? [];
          const done = (
            rows: unknown[],
            command = "SELECT",
            count: number | null = rows.length,
          ) => {
            activeQueries--;
            finish(query, owned, rows, command, count);
          };
          if (["begin", "commit", "rollback"].includes(text)) {
            commands.push(text);
            expect(transactionOpen).toBe(text !== "begin");
            transactionOpen = text === "begin";
            // PostgreSQL SET LOCAL is discarded when its transaction ends.
            localPath = undefined;
            return done([], text.toUpperCase(), null);
          }
          expect(transactionOpen).toBe(true);
          if (text.includes("from pg_catalog.pg_settings"))
            return done([{ setting: localPath ?? startupPath, source: "client" }]);
          if (text.startsWith("select pg_catalog.set_config(")) {
            expect(text).toContain("'search_path'");
            expect(text).toContain("true");
            expect(values).toEqual([migrationSearchPath("public")]);
            localPath = String(values[0]);
            return done([{ set_config: localPath }]);
          }
          if (text.includes(".app_schema_migration")) {
            expect(text).toContain('from "public".app_schema_migration');
            expect(effectiveSchema()).toBe("public");
            return done(migrations.map(({ name, checksum }) => ({ name, checksum })));
          }
          if (
            text.startsWith("select pg_advisory_xact_lock(") ||
            text.startsWith("select set_config(")
          )
            return done([]);
          if (text.includes("current_schema()::regnamespace")) {
            const schema = effectiveSchema();
            catalogSchemas.push(schema ?? "missing");
            if (schema !== "public") return done([]);
            if (text.startsWith("with recursive linked(oid)")) {
              const tables = [
                ...new Set([
                  ...EXPORT_ENTITY_SPECS.map(({ table }) => table),
                  ...USER_LINKED_EXPORT_EXCLUSIONS,
                ]),
              ];
              if (inventory === "missing-table") tables.pop();
              if (inventory === "foreign-table") tables.push("unclassified_fixture");
              return done(tables.map((table_name) => ({ table_name })));
            }
            expect(text).toContain("from pg_constraint edge");
            const constraints = ERASURE_TABLE_SPECS.flatMap((spec) => {
              if (
                spec.strategy !== "cascade" &&
                spec.strategy !== "empty" &&
                spec.strategy !== "retain"
              )
                return [];
              return [
                {
                  table_name: spec.table,
                  parent_table: spec.parentTable,
                  constraint_name: spec.constraintName,
                  delete_action: spec.strategy === "cascade" ? "c" : spec.deleteAction,
                  all_columns_not_null: spec.strategy === "cascade" ? true : spec.allColumnsNotNull,
                },
              ];
            });
            if (inventory === "missing-constraint") constraints.pop();
            if (inventory === "wrong-constraint" && constraints[0])
              constraints[0].parent_table = "foreign_parent";
            return done(constraints);
          }
          if (text.startsWith("select count(*)::text count")) return done([{ count: "0" }]);
          if (text.startsWith('select "id" from "account_erasure_job"')) return done([]);
          if (/^(create temporary table|insert into|delete from) /u.test(text)) {
            expect(catalogSchemas).toEqual(["public", "public"]);
            mutations.push(text);
            const command = text.split(" ")[0]?.toUpperCase();
            return done([], command, command === "CREATE" ? null : 0);
          }
          throw new Error(`Unhandled schema fixture query: ${text}`);
        } catch (error) {
          activeQueries = 0;
          owned.current = undefined;
          query.emit("error", error);
        }
      });
    };
    await owner.database.connection().execute(async (db) => {
      await assertDatabaseMigrationLedgerReady(db);
      expect(transactionOpen).toBe(false);
      expect(localPath).toBeUndefined();
      expect(effectiveSchema()).toBe(startupPath.split(",")[0]?.trim());
      const replay = replayExternalErasureLedgerEntry(db, {
        subjectUserId: "00000000-0000-4000-8000-000000000001",
        ledgerEntryId: "synthetic-ledger",
        ackDigest: "a".repeat(64),
        recordedAt: "2026-01-01T00:00:00.000Z",
      });
      if (inventory === "complete") {
        await replay;
        expect(mutations.some((text) => text.startsWith('delete from "app_user"'))).toBe(true);
        expect(commands).toEqual(["begin", "commit", "begin", "commit"]);
      } else {
        await expect(replay).rejects.toThrow("Account-erasure schema inventory is not current");
        expect(mutations).toEqual([]);
        expect(commands).toEqual(["begin", "commit", "begin", "rollback"]);
      }
    });
    expect(catalogSchemas.length).toBeGreaterThan(0);
    expect(transactionOpen).toBe(false);
    expect(activeQueries).toBe(0);
    expect(state.clients).toHaveLength(1);
    expect(state.sockets).toHaveLength(1);
    await owner.close();
    expect(client().endCalls).toBe(1);
    expect(client().socket.destroyed).toBe(true);
  },
);

it("runs the actual catalog identity guard with observed identity and safe result projection", async () => {
  const owner = await openOwnedPostgresDatabase(options);
  closers.push(owner.close);
  reply([{ database_name: "nutrition", database_oid: "123", private_extra: "private-epoch" }]);
  expect(
    await assertDatabaseRestoreTargetIdentity(owner.database, {
      databaseName: "nutrition",
      databaseOid: "123",
    }),
  ).toEqual({ databaseName: "nutrition", databaseOid: "123" });
  expect(Reflect.get(client().calls[0] as object, "text")).toContain("pg_catalog.current_database");
});

it("prepares the owner role and target on one pinned owned connection", async () => {
  const owner = await openOwnedPostgresDatabase(options);
  closers.push(owner.close);
  const queries: string[] = [];
  state.query = (query, owned) =>
    queueMicrotask(() => {
      const text = String(Reflect.get(query, "text")).replace(/\s+/gu, " ").trim();
      queries.push(text);
      if (queries.length === 1) finish(query, owned, [], "SET", null);
      else if (queries.length === 2) finish(query, owned, [{ role: "nutrition_owner" }]);
      else finish(query, owned, [{ database_name: "nutrition", database_oid: "123" }]);
    });
  await owner.database.connection().execute(async (db) => {
    expect(
      await prepareDatabaseRestoreReplaySession(db, {
        databaseName: "nutrition",
        databaseOid: "123",
        expectedOwner: "nutrition_owner",
      }),
    ).toEqual({ databaseName: "nutrition", databaseOid: "123" });
  });
  expect(queries).toEqual([
    'set role "nutrition_owner"',
    "select current_user::pg_catalog.text as role",
    "select pg_catalog.current_database() database_name, (select oid::pg_catalog.text from pg_catalog.pg_database where datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) database_oid",
  ]);
  expect(state.clients).toHaveLength(1);
  expect(client().calls).toHaveLength(3);
});
