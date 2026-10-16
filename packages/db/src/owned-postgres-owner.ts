import { Socket } from "node:net";

import { Client, type ClientConfig, Query, type QueryConfig } from "pg";

import { migrationSearchPath } from "./migrator.js";
import {
  type PostgresBackupConnection,
  postgresBackupClientConfig,
} from "./postgres-backup-connection.js";

export interface OwnedPostgresSessionOptions {
  readonly connection: PostgresBackupConnection;
  readonly connectTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class OwnedPostgresSessionError extends Error {
  constructor(
    readonly code:
      | "CONFIGURATION"
      | "CONNECT"
      | "QUERY"
      | "RESULT"
      | "ABORTED"
      | "CLOSED"
      | "CONCURRENT"
      | "CLEANUP",
  ) {
    super(`Owned PostgreSQL session failed (${code})`);
    this.name = "OwnedPostgresSessionError";
  }
}

const CLEANUP_MS = 5_000;
export const ownedPostgresFailure = (code: OwnedPostgresSessionError["code"]) =>
  new OwnedPostgresSessionError(code);

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw ownedPostgresFailure("CONFIGURATION");
  return result;
}

function signalValid(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw ownedPostgresFailure("CONFIGURATION");
}

function settings(options: OwnedPostgresSessionOptions, applicationName: string): ClientConfig {
  const allowed = new Set([
    "connection",
    "connectTimeoutMs",
    "queryTimeoutMs",
    "timeoutMs",
    "signal",
  ]);
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowed.has(key))
  )
    throw ownedPostgresFailure("CONFIGURATION");
  signalValid(options.signal);
  let connection: ClientConfig;
  try {
    connection = postgresBackupClientConfig(options.connection);
  } catch {
    throw ownedPostgresFailure("CONFIGURATION");
  }
  const queryTimeout = bound(options.queryTimeoutMs, 15_000, 60_000);
  return {
    ...connection,
    application_name: applicationName,
    // The owner controls connect cancellation; a pg setup throw can otherwise
    // leave the driver's inaccessible connection timer installed.
    connectionTimeoutMillis: 0,
    statement_timeout: queryTimeout,
    lock_timeout: queryTimeout,
    idle_in_transaction_session_timeout: bound(options.timeoutMs, 300_000, 3_600_000),
    query_timeout: 0,
    // Startup options are whitespace-delimited; keep the maintained path one value.
    options: `-c search_path=${
      applicationName === "nutrition-postgres-replay"
        ? migrationSearchPath("public").replaceAll(" ", "")
        : "pg_catalog,public,pg_temp"
    }`,
  };
}

const fail = ownedPostgresFailure;

export interface OwnedPostgresCollector<T> {
  row(row: unknown, result: unknown): void;
  end(result: unknown): T;
}

export interface OwnedPostgresOwner {
  readonly signal: AbortSignal;
  assertAvailable(): void;
  interrupt(): void;
  execute<T>(
    config: QueryConfig,
    collector: OwnedPostgresCollector<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close(): Promise<void>;
}

// Internal lifecycle shared by the scalar backup session and object-query adapter.
// pg owns its protocol/TLS implementation; this owner controls only its fresh socket.
export async function openOwnedPostgresOwner(
  options: OwnedPostgresSessionOptions,
  applicationName: "nutrition-postgres-backup" | "nutrition-postgres-replay",
): Promise<OwnedPostgresOwner> {
  const config = settings(options, applicationName);
  const externalSignal = options.signal;
  const connectTimeoutMs = bound(options.connectTimeoutMs, 5_000, 30_000);
  const queryTimeoutMs = bound(options.queryTimeoutMs, 15_000, 60_000);
  const timeoutMs = bound(options.timeoutMs, 300_000, 3_600_000);
  if (externalSignal?.aborted) throw fail("ABORTED");
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const socket = new Socket();
  const ignoreSocketError = () => undefined;
  socket.on("error", ignoreSocketError);
  const socketClosed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      socket.off("error", ignoreSocketError);
      resolve();
    }),
  );
  let client: Client;
  try {
    client = new Client({ ...config, stream: () => socket });
  } catch {
    socket.destroy();
    await socketClosed;
    throw fail("CONFIGURATION");
  }
  let connected = false;
  let unavailable = false;
  let busy = false;
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const interrupt = () => {
    unavailable = true;
    if (!controller.signal.aborted) controller.abort(fail("ABORTED"));
    socket.destroy();
  };
  // Retain the listener until client end: a disconnect must not become an
  // unhandled EventEmitter error, even after a query has already rejected.
  const clientError = () => interrupt();
  client.on("error", clientError);
  const detachClient = () => {
    client.off("end", detachClient);
    client.off("error", clientError);
    // A late driver error remains handled without retaining the owner closure.
    client.off("error", ignoreSocketError);
    client.on("error", ignoreSocketError);
  };
  client.once("end", detachClient);
  const lifetime = setTimeout(interrupt, timeoutMs);
  externalSignal?.addEventListener("abort", interrupt, { once: true });

  function close(): Promise<void> {
    if (closing) return closing;
    unavailable = true;
    clearTimeout(lifetime);
    externalSignal?.removeEventListener("abort", interrupt);
    const pending = active;
    closing = (async () => {
      if (!connected) {
        // connect() has already settled. A synchronous transport setup failure
        // can precede pg's connection-end listener, so client.end() may never
        // settle. No query was admitted: close the transport we own directly.
        socket.destroy();
        await socketClosed;
        detachClient();
        return;
      }
      let cleanupFailed = false;
      const force = setTimeout(() => {
        cleanupFailed = true;
        socket.destroy();
      }, CLEANUP_MS);
      let ending: Promise<void>;
      try {
        ending = Promise.resolve(client.end());
      } catch {
        cleanupFailed = true;
        socket.destroy();
        ending = Promise.resolve();
      }
      // A driver close failure still requires closure of our own transport.
      const ended = ending.catch(() => {
        cleanupFailed = true;
        socket.destroy();
      });
      if (pending) interrupt();
      try {
        await Promise.all([
          ended,
          socketClosed,
          pending?.then(
            () => undefined,
            () => undefined,
          ),
        ]);
      } finally {
        clearTimeout(force);
        detachClient();
      }
      if (cleanupFailed) throw fail("CLEANUP");
    })();
    return closing;
  }

  let connectFailed = false;
  const connectAbort = () => interrupt();
  const connectTimer = setTimeout(connectAbort, connectTimeoutMs);
  try {
    const connecting = client.connect();
    active = connecting;
    if (externalSignal?.aborted) interrupt();
    await connecting;
    connected = true;
    if (controller.signal.aborted) throw fail("ABORTED");
  } catch {
    connectFailed = true;
  } finally {
    active = undefined;
    clearTimeout(connectTimer);
  }
  if (connectFailed) {
    interrupt();
    const primary = fail(externalSignal?.aborted ? "ABORTED" : "CONNECT");
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], "PostgreSQL connection and cleanup failed");
    }
    throw primary;
  }

  function assertAvailable() {
    if (performance.now() >= deadline && !unavailable) interrupt();
    if (unavailable) throw fail(controller.signal.aborted ? "ABORTED" : "CLOSED");
  }

  return Object.freeze({
    signal: controller.signal,
    close,
    interrupt,
    assertAvailable,
    async execute<T>(
      config: QueryConfig,
      collector: OwnedPostgresCollector<T>,
      querySignal?: AbortSignal,
    ): Promise<T> {
      assertAvailable();
      if (busy) throw fail("CONCURRENT");
      signalValid(querySignal);
      if (querySignal?.aborted) {
        interrupt();
        throw fail("ABORTED");
      }
      busy = true;
      let resultInvalid = false;
      let terminal = false;
      let query: Query;
      try {
        query = new Query(config);
      } catch {
        busy = false;
        interrupt();
        throw fail("QUERY");
      }
      let rejectOperation: (error: Error) => void = () => undefined;
      const operation = new Promise<T>((resolve, reject) => {
        rejectOperation = (error) => {
          if (terminal) return;
          terminal = true;
          reject(error);
        };
        query.on("row", (row, result) => {
          if (terminal || resultInvalid || controller.signal.aborted) return;
          try {
            collector.row(row, result);
          } catch {
            resultInvalid = true;
            interrupt();
          }
        });
        query.on("error", () => {
          if (terminal) return;
          terminal = true;
          reject(fail(resultInvalid ? "RESULT" : controller.signal.aborted ? "ABORTED" : "QUERY"));
        });
        query.on("end", (result) => {
          if (terminal) return;
          terminal = true;
          if (resultInvalid) {
            reject(fail("RESULT"));
            return;
          }
          try {
            assertAvailable();
          } catch {
            reject(fail("ABORTED"));
            return;
          }
          let value: T;
          try {
            value = collector.end(result);
          } catch {
            resultInvalid = true;
            interrupt();
            reject(fail("RESULT"));
            return;
          }
          try {
            assertAvailable();
            resolve(value);
          } catch {
            reject(fail("ABORTED"));
          }
        });
      });
      active = operation;
      const timeout = setTimeout(
        interrupt,
        Math.min(queryTimeoutMs, Math.max(0, deadline - performance.now())),
      );
      querySignal?.addEventListener("abort", interrupt, { once: true });
      try {
        if (querySignal?.aborted || controller.signal.aborted) {
          interrupt();
          rejectOperation(fail("ABORTED"));
        } else {
          try {
            client.query(query);
          } catch {
            rejectOperation(fail("QUERY"));
          }
        }
        return await operation;
      } catch (error) {
        interrupt();
        if (error instanceof OwnedPostgresSessionError) throw error;
        throw fail("QUERY");
      } finally {
        terminal = true;
        query.removeAllListeners("row");
        query.removeAllListeners("end");
        query.removeAllListeners("error");
        query.on("error", ignoreSocketError);
        clearTimeout(timeout);
        querySignal?.removeEventListener("abort", interrupt);
        active = undefined;
        busy = false;
      }
    },
  });
}
