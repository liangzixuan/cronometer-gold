import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { collectCatalogueAuthorityViewEvidence } from "../src/catalogue-authority-deployment-runtime.js";
import { CATALOGUE_PAGED_VIEW_POLICY } from "../src/catalogue-paged-authority-policy.js";
import type { Database } from "../src/types.js";

function fixture(missing = false, failQuery = false) {
  const queries: CompiledQuery[] = [];
  const transactions: string[] = [];
  class Driver extends DummyDriver {
    override async beginTransaction() {
      transactions.push("begin");
    }
    override async commitTransaction() {
      transactions.push("commit");
    }
    override async rollbackTransaction() {
      transactions.push("rollback");
    }
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          if (failQuery && query.sql.trim().startsWith("select")) {
            throw new Error("synthetic view query failure");
          }
          return {
            rows: (query.sql.trim().startsWith("select") && !missing
              ? [{ definition_matches: true, options: [] }]
              : []) as R[],
          };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("Unexpected stream");
        },
      };
    }
  }
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries, transactions };
}

describe("source-defined catalogue view attestation", () => {
  it("pins the unchanged full query from the reviewed consumer migration", () => {
    const source = readFileSync(
      new URL("../migrations/0032_catalogue_publication_consumers.sql", import.meta.url),
      "utf8",
    );
    const query = source.match(
      /create or replace view promoted_food_search_catalogue_v1 as\n([\s\S]*?);\n\ncreate or replace function/u,
    )?.[1];
    const expected = CATALOGUE_PAGED_VIEW_POLICY[0];
    expect(expected?.query).toBe(query);
    expect(expected?.sourceSha256).toBe(
      createHash("sha256")
        .update(query ?? "")
        .digest("hex"),
    );
  });
  it("parses only source policy in one transaction, compares both definitions, and cleans its view", async () => {
    const { db, queries, transactions } = fixture();
    try {
      expect(await collectCatalogueAuthorityViewEvidence(db)).toEqual(
        CATALOGUE_PAGED_VIEW_POLICY.map(({ name, sourceSha256 }) => ({
          name,
          sourceSha256,
          definitionMatches: true,
          options: [],
        })),
      );
      expect(transactions).toEqual(["begin", "commit"]);
      expect(queries).toHaveLength(7);
      expect(queries[1]?.sql).toContain("set local search_path = pg_catalog, public, pg_temp");
      expect(queries[2]?.sql).toContain(CATALOGUE_PAGED_VIEW_POLICY[0]?.query);
      expect(queries[2]?.sql).toMatch(/^create temporary view "catalogue_expected_[a-f0-9]+" as /u);
      expect(queries[3]?.sql).toContain("pg_catalog.pg_get_viewdef(actual.oid, false)");
      expect(queries[3]?.sql).toContain("coalesce(actual.reloptions, array[]::text[])");
      expect(queries[4]?.sql).toMatch(/^drop view "pg_temp"\."catalogue_expected_[a-f0-9]+"$/u);
    } finally {
      await db.destroy();
    }
  });
  it("keeps a caller transaction open and rolls back only its owned temporary scope", async () => {
    const { db, queries, transactions } = fixture();
    const caller = await db.startTransaction().execute();
    try {
      const result = await collectCatalogueAuthorityViewEvidence(caller);
      expect(result).toHaveLength(CATALOGUE_PAGED_VIEW_POLICY.length);
      expect(transactions).toEqual(["begin"]);
      expect(caller.isCommitted).toBe(false);
      expect(caller.isRolledBack).toBe(false);
      const savepoint = queries[0]?.sql.match(
        /^savepoint "(catalogue_view_scope_[a-f0-9]+)"$/u,
      )?.[1];
      expect(savepoint).toBeDefined();
      expect(queries.at(-2)?.sql).toBe(`rollback to savepoint "${savepoint}"`);
      expect(queries.at(-1)?.sql).toBe(`release savepoint "${savepoint}"`);
      expect(queries.findIndex((query) => query.sql.startsWith("savepoint "))).toBeLessThan(
        queries.findIndex((query) => query.sql.startsWith("set local search_path")),
      );
    } finally {
      await caller.rollback().execute();
      expect(transactions).toEqual(["begin", "rollback"]);
      await db.destroy();
    }
  });
  it("cleans a failed borrowed scope without ending the caller transaction", async () => {
    const { db, queries, transactions } = fixture(true);
    const caller = await db.startTransaction().execute();
    try {
      await expect(collectCatalogueAuthorityViewEvidence(caller)).rejects.toThrow(
        "view is unavailable",
      );
      expect(transactions).toEqual(["begin"]);
      expect(caller.isCommitted).toBe(false);
      expect(caller.isRolledBack).toBe(false);
      const savepoint = queries[0]?.sql.match(
        /^savepoint "(catalogue_view_scope_[a-f0-9]+)"$/u,
      )?.[1];
      expect(savepoint).toBeDefined();
      expect(queries.at(-2)?.sql).toBe(`rollback to savepoint "${savepoint}"`);
      expect(queries.at(-1)?.sql).toBe(`release savepoint "${savepoint}"`);
    } finally {
      await caller.rollback().execute();
      expect(transactions).toEqual(["begin", "rollback"]);
      await db.destroy();
    }
  });
  it("recovers its savepoint after a SQL failure without rolling back the caller", async () => {
    const { db, queries, transactions } = fixture(false, true);
    const caller = await db.startTransaction().execute();
    try {
      await expect(collectCatalogueAuthorityViewEvidence(caller)).rejects.toThrow(
        "synthetic view query failure",
      );
      expect(transactions).toEqual(["begin"]);
      const savepoint = queries[0]?.sql.match(
        /^savepoint "(catalogue_view_scope_[a-f0-9]+)"$/u,
      )?.[1];
      expect(savepoint).toBeDefined();
      expect(queries.at(-2)?.sql).toBe(`rollback to savepoint "${savepoint}"`);
      expect(queries.at(-1)?.sql).toBe(`release savepoint "${savepoint}"`);
      expect(caller.isCommitted).toBe(false);
      expect(caller.isRolledBack).toBe(false);
    } finally {
      await caller.rollback().execute();
      expect(transactions).toEqual(["begin", "rollback"]);
      await db.destroy();
    }
  });
  it("rolls back the temporary view when the actual view is missing", async () => {
    const { db, queries, transactions } = fixture(true);
    try {
      await expect(collectCatalogueAuthorityViewEvidence(db)).rejects.toThrow(
        "view is unavailable",
      );
      expect(transactions).toEqual(["begin", "rollback"]);
      expect(queries).toHaveLength(6);
      expect(queries.at(-2)?.sql).toMatch(/^rollback to savepoint /u);
      expect(queries.at(-1)?.sql).toMatch(/^release savepoint /u);
    } finally {
      await db.destroy();
    }
  });
});
