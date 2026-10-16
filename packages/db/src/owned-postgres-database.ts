import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient } from "kysely";

import {
  ownedPostgresFailure as fail,
  OwnedPostgresSessionError,
  type OwnedPostgresSessionOptions,
  openOwnedPostgresOwner,
} from "./owned-postgres-owner.js";
import type { Database } from "./types.js";

const MiB = 1_048_576;
const LIMITS = Object.freeze({
  queries: 4096,
  sql: 65_536,
  totalSql: 16 * MiB,
  parameters: 1024,
  parameterString: 8192,
  parameterBytes: MiB,
  totalParameters: 32 * MiB,
  rows: 1024,
  fields: 128,
  fieldName: 256,
  resultBytes: MiB,
  totalResults: 32 * MiB,
});
type Scalar = null | string | boolean | number | Date;
type Parameter = Scalar | string[];
type Row = Record<string, Scalar>;
interface Result {
  command: string;
  rowCount: number | null;
  rows: Row[];
}

function data(object: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor || !("value" in descriptor)) throw fail("CONFIGURATION");
  return descriptor.value;
}

function array(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw fail("CONFIGURATION");
  return Array.from({ length: value.length }, (_, index) => data(value, String(index)));
}

function scalar(value: unknown, stringLimit: number): { value: Scalar; bytes: number } {
  if (value === null) return { value, bytes: 1 };
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes > stringLimit) throw fail("CONFIGURATION");
    return { value, bytes };
  }
  if (typeof value === "boolean") return { value, bytes: 1 };
  if (typeof value === "number" && Number.isSafeInteger(value)) return { value, bytes: 8 };
  if (
    value instanceof Date &&
    Object.getPrototypeOf(value) === Date.prototype &&
    Reflect.ownKeys(value).length === 0
  ) {
    const time = Date.prototype.getTime.call(value);
    if (Number.isFinite(time)) return { value: new Date(time), bytes: 8 };
  }
  throw fail("CONFIGURATION");
}

function parameters(input: unknown): { values: Parameter[]; bytes: number } {
  let bytes = 0;
  const values = array(input, LIMITS.parameters).map((value) => {
    if (Array.isArray(value))
      return array(value, LIMITS.parameters).map((entry) => {
        if (typeof entry !== "string") throw fail("CONFIGURATION");
        const copy = scalar(entry, LIMITS.parameterString);
        bytes += copy.bytes;
        return entry;
      });
    const copy = scalar(value, LIMITS.parameterString);
    bytes += copy.bytes;
    return copy.value;
  });
  if (bytes > LIMITS.parameterBytes) throw fail("CONFIGURATION");
  return { values, bytes };
}

function fields(result: unknown): string[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw fail("RESULT");
  const names = array(data(result, "fields"), LIMITS.fields).map((field) => {
    if (!field || typeof field !== "object") throw fail("RESULT");
    const name = data(field, "name");
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      Buffer.byteLength(name) > LIMITS.fieldName ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      throw fail("RESULT");
    return name;
  });
  if (new Set(names).size !== names.length) throw fail("RESULT");
  return names;
}

const MUTATIONS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const UTILITIES = new Set([
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SET",
  "CREATE",
  "DROP",
  "SAVEPOINT",
  "RELEASE",
]);

/** Internal public-dialect adapter. The package entry point exposes only the owned database. */
export async function openOwnedPostgresPool(options: OwnedPostgresSessionOptions) {
  const owner = await openOwnedPostgresOwner(options, "nutrition-postgres-replay");
  let reservation: object | undefined;
  let active = false;
  let queryFailure: OwnedPostgresSessionError | undefined;
  const usage = { queries: 0, sqlBytes: 0, parameterBytes: 0, decodedBytes: 0 };
  const pool: PostgresPool = Object.freeze({
    options: Object.freeze({}),
    end: owner.close,
    async connect(): Promise<PostgresPoolClient> {
      owner.assertAvailable();
      if (reservation) throw fail("CONCURRENT");
      const admitted = {};
      reservation = admitted;
      const assertReservation = () => {
        if (reservation !== admitted) throw fail("CLOSED");
        if (queryFailure) throw queryFailure;
        owner.assertAvailable();
      };
      const query = async (text: unknown, input: unknown): Promise<Result> => {
        assertReservation();
        if (active) throw fail("CONCURRENT");
        let snapshot: { values: Parameter[]; bytes: number };
        try {
          if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text) > LIMITS.sql)
            throw fail("CONFIGURATION");
          snapshot = parameters(input);
          const sqlBytes = Buffer.byteLength(text);
          if (
            usage.queries >= LIMITS.queries ||
            usage.sqlBytes + sqlBytes > LIMITS.totalSql ||
            usage.parameterBytes + snapshot.bytes > LIMITS.totalParameters
          )
            throw fail("CONFIGURATION");
          usage.queries++;
          usage.sqlBytes += sqlBytes;
          usage.parameterBytes += snapshot.bytes;
        } catch {
          queryFailure ??= fail("CONFIGURATION");
          owner.interrupt();
          throw queryFailure;
        }
        active = true;
        const rows: Row[] = [];
        let names: string[] | undefined;
        let resultBytes = 0;
        let metadata: unknown;
        const validateFields = (result: unknown) => {
          const observed = fields(result);
          if (
            names &&
            (names.length !== observed.length ||
              names.some((name, index) => name !== observed[index]))
          )
            throw fail("RESULT");
          names ??= observed;
        };
        try {
          return await owner.execute(
            { text, values: snapshot.values, name: `owned_${usage.queries}` },
            {
              row(row, result) {
                validateFields(result);
                if (metadata !== undefined && metadata !== result) throw fail("RESULT");
                metadata = result;
                if (
                  !row ||
                  typeof row !== "object" ||
                  Array.isArray(row) ||
                  ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
                  Reflect.ownKeys(row).length !== names?.length
                )
                  throw fail("RESULT");
                const copy: Row = {};
                let bytes = 0;
                for (const name of names ?? []) {
                  const item = scalar(data(row, name), Number.MAX_SAFE_INTEGER);
                  bytes += Buffer.byteLength(name) + item.bytes;
                  copy[name] = item.value;
                }
                // Count decoded payload even for the last rejected bounded row.
                resultBytes += bytes;
                usage.decodedBytes += bytes;
                if (
                  rows.length >= LIMITS.rows ||
                  resultBytes > LIMITS.resultBytes ||
                  usage.decodedBytes > LIMITS.totalResults
                )
                  throw fail("RESULT");
                rows.push(copy);
              },
              end(result) {
                validateFields(result);
                if (metadata !== undefined && metadata !== result) throw fail("RESULT");
                const command = data(result as object, "command");
                const rowCount = data(result as object, "rowCount");
                // Row events disable pg's automatic accumulation; never accept a
                // second, unaccounted result array or multiple command results.
                if (array(data(result as object, "rows"), 0).length !== 0) throw fail("RESULT");
                if (
                  command === "SELECT" ||
                  (typeof command === "string" && MUTATIONS.has(command))
                ) {
                  if (
                    typeof rowCount !== "number" ||
                    !Number.isSafeInteger(rowCount) ||
                    rowCount < rows.length ||
                    (command === "SELECT" && rowCount !== rows.length)
                  )
                    throw fail("RESULT");
                } else if (
                  typeof command !== "string" ||
                  !UTILITIES.has(command) ||
                  rowCount !== null ||
                  rows.length !== 0 ||
                  names?.length !== 0
                )
                  throw fail("RESULT");
                return { command, rowCount: rowCount as number | null, rows };
              },
            },
          );
        } catch (error) {
          // A maintained transaction may attempt rollback after interruption.
          // Refuse that dispatch with the original sanitized query failure.
          queryFailure ??= error instanceof OwnedPostgresSessionError ? error : fail("QUERY");
          throw queryFailure;
        } finally {
          active = false;
        }
      };
      return Object.freeze({
        // Kysely's public structural type understates pg's utility tags/null
        // counts. Preserve validated real metadata; the maintained driver uses
        // affected counts only for its four mutation tags. Cursor calls refuse
        // at the same input validation boundary before any dispatch.
        query: query as PostgresPoolClient["query"],
        release() {
          if (reservation !== admitted) throw fail("CLOSED");
          if (active) {
            owner.interrupt();
            throw fail("CONCURRENT");
          }
          reservation = undefined;
        },
      });
    },
  });
  return Object.freeze({
    pool,
    signal: owner.signal,
    close: owner.close,
    usage: () => Object.freeze({ ...usage }),
  });
}

export interface OwnedPostgresDatabase {
  readonly database: Kysely<Database>;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

/** Supply owner cancellation; always await close(), even before the first query. */
export async function openOwnedPostgresDatabase(
  options: OwnedPostgresSessionOptions,
): Promise<OwnedPostgresDatabase> {
  const owner = await openOwnedPostgresPool(options);
  const database = new Kysely<Database>({ dialect: new PostgresDialect({ pool: owner.pool }) });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    database,
    signal: owner.signal,
    close() {
      closing ??= (async () => {
        try {
          await database.destroy();
        } finally {
          await owner.close();
        }
      })();
      return closing;
    },
  });
}
