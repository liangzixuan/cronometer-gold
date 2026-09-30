import type { EventEmitter } from "node:events";
import { rootCertificates } from "node:tls";
import type { ClientConfig } from "pg";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TestSocket extends EventEmitter {
  destroyed: boolean;
  destroy(): TestSocket;
}
interface TestQuery extends EventEmitter {
  readonly config: unknown;
}
type TestConfig = Omit<ClientConfig, "stream"> & { stream: () => TestSocket };
interface TestClient extends EventEmitter {
  readonly config: TestConfig;
  readonly socket: TestSocket;
  queryCalls: TestQuery[];
  endCalls: number;
  current: TestQuery | undefined;
}

const state = vi.hoisted(() => ({
  clients: [] as TestClient[],
  sockets: [] as TestSocket[],
  connect: "ok",
  actualClient: undefined as undefined | ((config: TestConfig) => TestClient),
  end: "ok",
  query: undefined as undefined | ((query: TestQuery, client: TestClient) => void),
}));

vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  const { isIP } = await vi.importActual<typeof import("node:net")>("node:net");
  return {
    isIP,
    Socket: class extends EventEmitter {
      destroyed = false;
      writable = true;
      setNoDelay() {
        return this;
      }
      connect() {
        throw new Error("synthetic synchronous socket connect failure");
      }
      end() {
        return this;
      }
      write(_bytes: unknown, callback?: () => void) {
        callback?.();
        return true;
      }
      constructor() {
        super();
        state.sockets.push(this);
      }
      destroy() {
        if (!this.destroyed) {
          this.destroyed = true;
          queueMicrotask(() => this.emit("close"));
        }
        return this;
      }
    },
  };
});
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class SyntheticClient extends EventEmitter {
    readonly socket: TestSocket;
    queryCalls: TestQuery[] = [];
    endCalls = 0;
    current: TestQuery | undefined;
    connectingReject: ((error: unknown) => void) | undefined;
    constructor(readonly config: TestConfig) {
      super();
      state.clients.push(this);
      this.socket = config.stream();
      this.socket.once("close", () => {
        this.connectingReject?.(new Error("private connection URL"));
        this.current?.emit("error", new Error("private SQL parameter"));
        this.current = undefined;
        this.emit("end");
      });
    }
    connect() {
      if (state.connect === "reject") return Promise.reject(new Error("private password"));
      if (state.connect === "pending")
        return new Promise((_resolve, reject) => {
          this.connectingReject = reject;
        });
      return Promise.resolve(this);
    }
    query(query: TestQuery) {
      this.queryCalls.push(query);
      this.current = query;
      if (state.query) state.query(query, this);
      else
        queueMicrotask(() => {
          this.current = undefined;
          query.emit("end", {});
        });
      return query;
    }
    end() {
      this.endCalls++;
      if (state.end === "reject") return Promise.reject(new Error("private cleanup URL"));
      if (this.socket.destroyed) return Promise.resolve();
      const ended = new Promise<void>((resolve) => this.once("end", resolve));
      if (state.end !== "pending") this.socket.destroy();
      return ended;
    }
  }
  return {
    Query: class extends EventEmitter {
      constructor(readonly config: unknown) {
        super();
      }
    },
    Client: vi.fn(function ClientMock(config: TestConfig) {
      return state.actualClient ? state.actualClient(config) : new SyntheticClient(config);
    }),
  };
});

import {
  type OwnedPostgresSessionOptions,
  openOwnedPostgresSession,
} from "../src/owned-postgres-session.js";

import { normalizePostgresBackupConnection } from "../src/postgres-backup-connection.js";

const options = {
  connection: normalizePostgresBackupConnection({
    connectionString: "postgresql://backup:synthetic@database.test/nutrition",
    caCertificate: rootCertificates[0] ?? "",
  }),
};
const select = { text: "select 'evidence'::text", values: [], rowMode: "array" as const };
beforeEach(() => {
  state.clients.length = 0;
  state.sockets.length = 0;
  state.connect = "ok";
  state.actualClient = undefined;
  state.end = "ok";
  state.query = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function firstClient(): TestClient {
  const value = state.clients[0];
  if (!value) throw new Error("synthetic client missing");
  return value;
}
function firstSocket(): TestSocket {
  const value = state.sockets[0];
  if (!value) throw new Error("synthetic socket missing");
  return value;
}

function reply(rows: unknown[]) {
  state.query = (query, client) =>
    queueMicrotask(() => {
      for (const row of rows) query.emit("row", row);
      client.current = undefined;
      query.emit("end", {});
    });
}

it("owns one fresh verified-TLS client and closes it idempotently", async () => {
  const session = await openOwnedPostgresSession(options);
  expect(state.clients).toHaveLength(1);
  const client = firstClient();
  expect(client.config).toMatchObject({
    ssl: { rejectUnauthorized: true },
    query_timeout: 0,
    application_name: "nutrition-postgres-backup",
  });
  expect(client.config).not.toHaveProperty("pipeline");
  reply([["evidence"]]);
  expect(await session.query(select)).toEqual({ rows: [["evidence"]] });
  expect(client.queryCalls[0]?.listenerCount("row")).toBe(1);
  expect(client.queryCalls[0]).not.toHaveProperty("callback");
  await session.close();
  await session.close();
  expect(client.endCalls).toBe(1);
  expect(client.socket.destroyed).toBe(true);
  await expect(session.query(select)).rejects.toMatchObject({ code: "CLOSED" });
  expect(() => client.emit("error", new Error("late private error"))).not.toThrow();
});

for (const changes of [
  { connectionString: "invalid" },
  { connectionString: "https://backup@database.test/nutrition" },
  { connectionString: "postgresql://backup@database.test/nutrition?sslmode=disable" },
  { connectionString: "postgresql://backup@database.test/nutrition#override" },
  { connectionString: "postgresql://database.test/nutrition" },
  { connectionString: "postgresql://backup@database.test" },
  { sslMode: "disable" },
  { sslMode: "require" },
  { timeoutMs: 0 },
  { timeoutMs: 3_600_001 },
  { queryTimeoutMs: Number.NaN },
  { connectTimeoutMs: 30_001 },
  { client: {} },
  { pool: {} },
  { signal: {} },
]) {
  it(`rejects unsafe configuration ${JSON.stringify(changes)}`, async () => {
    await expect(
      openOwnedPostgresSession({ ...options, ...changes } as OwnedPostgresSessionOptions),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(state.clients).toHaveLength(0);
  });
}
for (const host of ["127.0.0.1", "[::1]"]) {
  it(`permits explicit disabled TLS only on literal loopback ${host}`, async () => {
    const session = await openOwnedPostgresSession({
      connection: normalizePostgresBackupConnection({
        connectionString: `postgresql://backup:synthetic@${host}/nutrition`,
        sslMode: "disable",
      }),
    });
    expect(firstClient().config.ssl).toBe(false);
    await session.close();
  });
}
it("rejects process-wide TLS bypass before constructing transport", async () => {
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  await expect(openOwnedPostgresSession(options)).rejects.toMatchObject({ code: "CONFIGURATION" });
  expect(state.sockets).toHaveLength(0);
});
it("pre-aborted work opens no connection", async () => {
  await expect(
    openOwnedPostgresSession({ ...options, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(state.clients).toHaveLength(0);
});
it("abort during connect awaits owned transport cleanup", async () => {
  state.connect = "pending";
  const controller = new AbortController();
  const opening = openOwnedPostgresSession({ ...options, signal: controller.signal });
  const rejected = expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  await rejected;
  expect(firstClient().endCalls).toBe(0);
  expect(firstSocket().destroyed).toBe(true);
});
it("connect rejection exposes only a bounded error and closes", async () => {
  state.connect = "reject";
  await expect(openOwnedPostgresSession(options)).rejects.toThrow(
    "Owned PostgreSQL session failed (CONNECT)",
  );
  expect(firstClient().endCalls).toBe(0);
});
it("connect deadline destroys transport and settles connection attempt", async () => {
  vi.useFakeTimers();
  state.connect = "pending";
  const opening = openOwnedPostgresSession({ ...options, connectTimeoutMs: 10 });
  const rejected = expect(opening).rejects.toMatchObject({ code: "CONNECT" });
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(firstSocket().destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
for (const rows of [[["one"], ["two"]], [["a", "b"]], [[123]], [["x".repeat(1_048_577)]]]) {
  it(`rejects oversized/malformed scalar response ${rows.length}:${typeof rows[0]?.[0]}`, async () => {
    const session = await openOwnedPostgresSession(options);
    reply(rows);
    await expect(session.query(select)).rejects.toMatchObject({ code: "RESULT" });
    await expect(session.query(select)).rejects.toMatchObject({ code: "ABORTED" });
    await session.close();
  });
}
it("admits only one query at a time and awaits the original result", async () => {
  const session = await openOwnedPostgresSession(options);
  state.query = () => undefined;
  const pending = session.query(select);
  await expect(session.query(select)).rejects.toMatchObject({ code: "CONCURRENT" });
  expect(firstClient().queryCalls).toHaveLength(1);
  firstClient().current?.emit("row", ["ok"]);
  firstClient().current?.emit("end", {});
  firstClient().current = undefined;
  expect(await pending).toEqual({ rows: [["ok"]] });
  await session.close();
});
it("query cancellation interrupts actual owned transport and permanently discards owner", async () => {
  const session = await openOwnedPostgresSession(options);
  state.query = () => undefined;
  const controller = new AbortController();
  const pending = session.query({ ...select, signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  await rejected;
  await session.close();
  expect(firstSocket().destroyed).toBe(true);
  await expect(session.query(select)).rejects.toMatchObject({ code: "ABORTED" });
});
it("query timeout disconnects instead of returning while work remains active", async () => {
  vi.useFakeTimers();
  const session = await openOwnedPostgresSession({ ...options, queryTimeoutMs: 10 });
  state.query = () => undefined;
  const pending = session.query(select);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  await session.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("overall deadline closes an idle snapshot connection", async () => {
  vi.useFakeTimers();
  const session = await openOwnedPostgresSession({ ...options, timeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  expect(session.signal.aborted).toBe(true);
  expect(firstSocket().destroyed).toBe(true);
  await session.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("a synchronous submission failure is sanitized and cannot leave owner reusable", async () => {
  const session = await openOwnedPostgresSession(options);
  state.query = () => {
    throw new Error("private password SQL");
  };
  await expect(session.query(select)).rejects.toMatchObject({ code: "QUERY" });
  await session.close();
  expect(firstSocket().destroyed).toBe(true);
});
it("close waits for any active query settlement", async () => {
  const session = await openOwnedPostgresSession(options);
  state.query = () => undefined;
  const pending = session.query(select);
  const rejection = expect(pending).rejects.toThrow();
  await session.close();
  await rejection;
  expect(firstSocket().destroyed).toBe(true);
});
it("a stuck graceful close is force-closed and reported as cleanup failure", async () => {
  vi.useFakeTimers();
  const session = await openOwnedPostgresSession(options);
  state.end = "pending";
  const closing = session.close();
  const rejected = expect(closing).rejects.toMatchObject({ code: "CLEANUP" });
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect(firstSocket().destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("driver close failure still destroys transport without leaking raw text", async () => {
  const session = await openOwnedPostgresSession(options);
  state.end = "reject";
  await expect(session.close()).rejects.toThrow("Owned PostgreSQL session failed (CLEANUP)");
  expect(firstSocket().destroyed).toBe(true);
});
it("never starts graceful driver shutdown after initial connection failure", async () => {
  state.connect = "reject";
  state.end = "reject";
  await expect(openOwnedPostgresSession(options)).rejects.toMatchObject({ code: "CONNECT" });
  expect(firstClient().endCalls).toBe(0);
  expect(firstSocket().destroyed).toBe(true);
});

it("captures accepted owner deadlines and signal before caller mutation", async () => {
  vi.useFakeTimers();
  const original = new AbortController();
  const replacement = new AbortController();
  const mutable = { ...options, queryTimeoutMs: 10, timeoutMs: 100, signal: original.signal };
  const session = await openOwnedPostgresSession(mutable);
  mutable.queryTimeoutMs = Number.NaN;
  mutable.timeoutMs = Number.NaN;
  mutable.signal = replacement.signal;
  reply([["ok"]]);
  expect(await session.query(select)).toEqual({ rows: [["ok"]] });
  replacement.abort();
  expect(session.signal.aborted).toBe(false);
  await session.close();
  original.abort();
  expect(session.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("removes the admitted query signal listener even when the input is mutated", async () => {
  const session = await openOwnedPostgresSession(options);
  const original = new AbortController();
  const replacement = new AbortController();
  const mutable = { ...select, signal: original.signal };
  state.query = () => undefined;
  const pending = session.query(mutable);
  mutable.signal = replacement.signal;
  firstClient().current?.emit("row", ["ok"]);
  firstClient().current?.emit("end", {});
  firstClient().current = undefined;
  expect(await pending).toEqual({ rows: [["ok"]] });
  original.abort();
  expect(session.signal.aborted).toBe(false);
  reply([["still owned"]]);
  expect(await session.query(select)).toEqual({ rows: [["still owned"]] });
  await session.close();
});

it("settles installed pg synchronous socket setup failure after owned transport closure", async () => {
  vi.useFakeTimers();
  const actualPg = await vi.importActual<typeof import("pg")>("pg");
  const clients: import("pg").Client[] = [];
  state.actualClient = (config) => {
    const client = new actualPg.Client(config as ClientConfig);
    clients.push(client);
    return client as unknown as TestClient;
  };
  let settled = false;
  let failure: unknown;
  const opening = openOwnedPostgresSession(options).catch((error: unknown) => {
    failure = error;
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(settled).toBe(true);
  await opening;
  expect(failure).toMatchObject({
    code: "CONNECT",
    message: "Owned PostgreSQL session failed (CONNECT)",
  });
  expect(clients).toHaveLength(1);
  expect(firstSocket().destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(clients[0]?.listenerCount("end")).toBe(0);
  expect(() => clients[0]?.emit("error", new Error("late private driver error"))).not.toThrow();
});
