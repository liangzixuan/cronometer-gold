import { Socket } from "node:net";

import { Client, type ClientConfig, Query } from "pg";

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

export interface OwnedPostgresQuery {
  readonly text: string;
  readonly values?: readonly string[];
  readonly rowMode: "array";
  readonly signal?: AbortSignal;
}

export interface OwnedPostgresSession {
  readonly signal: AbortSignal;
  query(query: OwnedPostgresQuery): Promise<{ readonly rows: readonly (readonly string[])[] }>;
  close(): Promise<void>;
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

const RESULT_BYTES = 1_048_576;
const CLEANUP_MS = 5_000;
const fail = (code: OwnedPostgresSessionError["code"]) => new OwnedPostgresSessionError(code);

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw fail("CONFIGURATION");
  return result;
}

function signalValid(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail("CONFIGURATION");
}

function settings(options: OwnedPostgresSessionOptions): ClientConfig {
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
    throw fail("CONFIGURATION");
  signalValid(options.signal);
  let connection: ClientConfig;
  try {
    connection = postgresBackupClientConfig(options.connection);
  } catch {
    throw fail("CONFIGURATION");
  }
  const queryTimeout = bound(options.queryTimeoutMs, 15_000, 60_000);
  return {
    ...connection,
    application_name: "nutrition-postgres-backup",
    // The owner controls connect cancellation; a pg setup throw can otherwise
    // leave the driver's inaccessible connection timer installed.
    connectionTimeoutMillis: 0,
    statement_timeout: queryTimeout,
    lock_timeout: queryTimeout,
    idle_in_transaction_session_timeout: bound(options.timeoutMs, 300_000, 3_600_000),
    query_timeout: 0,
    options: "-c search_path=pg_catalog,public,pg_temp",
  };
}

/**
 * Owns a newly created, non-pipelined Client and its transport. No pool or caller
 * client is accepted. The stream factory is pg's public configuration API; pg
 * still performs normal TLS negotiation and hostname/certificate verification.
 * Result limits apply after pg decodes a row, not before protocol allocation.
 */
export async function openOwnedPostgresSession(
  options: OwnedPostgresSessionOptions,
): Promise<OwnedPostgresSession> {
  const config = settings(options);
  const externalSignal = options.signal;
  const connectTimeoutMs = bound(options.connectTimeoutMs, 5_000, 30_000);
  const queryTimeoutMs = bound(options.queryTimeoutMs, 15_000, 60_000);
  const timeoutMs = bound(options.timeoutMs, 300_000, 3_600_000);
  if (externalSignal?.aborted) throw fail("ABORTED");
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
      if (pending) socket.destroy();
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

  return Object.freeze({
    signal: controller.signal,
    close,
    async query(input: OwnedPostgresQuery) {
      if (unavailable) throw fail(controller.signal.aborted ? "ABORTED" : "CLOSED");
      if (busy) throw fail("CONCURRENT");
      signalValid(input?.signal);
      if (
        !input ||
        typeof input.text !== "string" ||
        input.text.length === 0 ||
        Buffer.byteLength(input.text) > 65_536 ||
        input.rowMode !== "array" ||
        !Array.isArray(input.values ?? []) ||
        (input.values?.length ?? 0) > 32 ||
        input.values?.some((value) => typeof value !== "string" || Buffer.byteLength(value) > 8192)
      )
        throw fail("CONFIGURATION");
      const querySignal = input.signal;
      if (querySignal?.aborted) {
        interrupt();
        throw fail("ABORTED");
      }
      busy = true;
      const rows: string[][] = [];
      let resultInvalid = false;
      let query: Query<string[]>;
      try {
        query = new Query<string[]>({
          text: input.text,
          values: [...(input.values ?? [])],
          rowMode: "array",
        } as import("pg").QueryArrayConfig);
      } catch {
        busy = false;
        interrupt();
        throw fail("QUERY");
      }
      let rejectOperation: (error: Error) => void = () => undefined;
      const operation = new Promise<{ rows: string[][] }>((resolve, reject) => {
        rejectOperation = reject;
        query.on("row", (row) => {
          if (resultInvalid) return;
          if (
            rows.length !== 0 ||
            !Array.isArray(row) ||
            row.length !== 1 ||
            typeof row[0] !== "string" ||
            Buffer.byteLength(row[0], "utf8") > RESULT_BYTES
          ) {
            resultInvalid = true;
            interrupt();
            return;
          }
          rows.push([...row]);
        });
        query.on("error", () =>
          reject(fail(resultInvalid ? "RESULT" : controller.signal.aborted ? "ABORTED" : "QUERY")),
        );
        query.on("end", () => {
          if (resultInvalid) reject(fail("RESULT"));
          else if (controller.signal.aborted) reject(fail("ABORTED"));
          else resolve({ rows });
        });
      });
      active = operation;
      const timeout = setTimeout(interrupt, queryTimeoutMs);
      querySignal?.addEventListener("abort", interrupt, { once: true });
      try {
        if (querySignal?.aborted || controller.signal.aborted) {
          interrupt();
          rejectOperation(fail("ABORTED"));
        } else {
          // Public Query row events avoid pg's automatic result accumulation.
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
        clearTimeout(timeout);
        querySignal?.removeEventListener("abort", interrupt);
        active = undefined;
        busy = false;
      }
    },
  });
}
