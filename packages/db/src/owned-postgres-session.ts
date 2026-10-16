import {
  ownedPostgresFailure as fail,
  type OwnedPostgresSessionOptions,
  openOwnedPostgresOwner,
} from "./owned-postgres-owner.js";

export {
  OwnedPostgresSessionError,
  type OwnedPostgresSessionOptions,
} from "./owned-postgres-owner.js";

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

/** Scalar backup contract; object queries use the separate owned database API. */
export async function openOwnedPostgresSession(
  options: OwnedPostgresSessionOptions,
): Promise<OwnedPostgresSession> {
  const owner = await openOwnedPostgresOwner(options, "nutrition-postgres-backup");
  return Object.freeze({
    signal: owner.signal,
    close: owner.close,
    async query(input: OwnedPostgresQuery) {
      owner.assertAvailable();
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
      const rows: string[][] = [];
      return owner.execute(
        {
          text: input.text,
          values: [...(input.values ?? [])],
          rowMode: "array",
        } as import("pg").QueryArrayConfig,
        {
          row(row) {
            if (
              rows.length !== 0 ||
              !Array.isArray(row) ||
              row.length !== 1 ||
              typeof row[0] !== "string" ||
              Buffer.byteLength(row[0]) > 1_048_576
            )
              throw fail("RESULT");
            rows.push([...row]);
          },
          end() {
            return { rows };
          },
        },
        input.signal,
      );
    },
  });
}
