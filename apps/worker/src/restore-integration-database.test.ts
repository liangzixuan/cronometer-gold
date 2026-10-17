import type { Database } from "@nutrition-tracker/db";
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRestoreIntegrationDatabase } from "../test/restore-integration-database.js";

const calls = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  createDatabase: calls.create,
}));
const sourceUrl = "postgresql://nutrition_local:synthetic@127.0.0.1:5432/nutrition_tracker";
function fixture() {
  const events: string[] = [];
  const queries: CompiledQuery[] = [];
  const connections: string[] = [];
  const state = {
    exists: false,
    name: "",
    oid: "23456",
    owner: "nutrition_local",
    lookups: 0,
    collision: false,
    badOwner: false,
    wrongConnection: false,
    missingBinding: false,
    changedOid: false,
    changedOwner: false,
    ambiguousCreate: false,
    closeFailure: false,
    dropFailure: false,
    residue: false,
  };
  calls.create.mockImplementation(({ connectionString }: { connectionString: string }) => {
    connections.push(connectionString);
    const own = new URL(connectionString).pathname !== "/nutrition_tracker";
    class Driver extends DummyDriver {
      override async acquireConnection(): Promise<DatabaseConnection> {
        return {
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            queries.push(query);
            const text = query.sql.replace(/\s+/g, " ").trim();
            let rows: unknown[] = [];
            if (text.startsWith("create database")) {
              events.push("create");
              state.exists = true;
              state.name = text.match(/^create database "([^"]+)"/)?.[1] ?? "";
              if (state.ambiguousCreate) throw new Error("creation outcome uncertain");
            } else if (text.startsWith("drop database")) {
              events.push("drop");
              if (state.dropFailure) throw new Error("owned drop failed");
              if (!state.residue) state.exists = false;
            } else if (text.includes("current_database()")) {
              events.push(own ? "connected" : "source");
              rows = [
                {
                  database_name: own
                    ? state.wrongConnection
                      ? "substituted_database"
                      : state.name
                    : "nutrition_tracker",
                  database_oid: own ? state.oid : "12345",
                  database_owner: state.badOwner ? "other_owner" : state.owner,
                  session_principal: state.owner,
                },
              ];
            } else if (text.startsWith("select exists")) {
              events.push(state.lookups ? "absence" : "collision");
              rows = [{ exists: state.collision || state.exists }];
            } else if (text.startsWith("select") && text.includes("pg_catalog.pg_database")) {
              state.lookups++;
              events.push(state.lookups === 1 ? "bind" : "recheck");
              rows =
                state.exists && !state.missingBinding
                  ? [
                      {
                        database_oid: state.lookups > 1 && state.changedOid ? "99999" : state.oid,
                        database_owner:
                          state.lookups > 1 && state.changedOwner ? "other_owner" : state.owner,
                      },
                    ]
                  : [];
            } else throw new Error(`Unexpected controlled SQL: ${text}`);
            return { rows: rows as R[] };
          },
          streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
            throw new Error("Unexpected stream");
          },
        };
      }
      override async destroy() {
        events.push(own ? "close-owned" : "close-bootstrap");
        if (own && state.closeFailure) throw new Error("owned close failed");
      }
    }
    return new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new Driver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  });
  return { events, queries, connections, state };
}
beforeEach(() => {
  calls.create.mockReset();
});

describe("owned public-schema restore integration database", () => {
  it("uses an isolated database/public contract, binds identity and drops only after connection closure", async () => {
    const f = fixture();
    const result = await withRestoreIntegrationDatabase(sourceUrl, async (input) => {
      expect(input.identity).toEqual({ databaseName: f.state.name, databaseOid: "23456" });
      const url = new URL(input.databaseUrl);
      expect(url.pathname).toBe(`/${f.state.name}`);
      expect(url.searchParams.get("options")).toBe("-csearch_path=public");
      expect(url.hostname).toBe("127.0.0.1");
      expect(f.events).not.toContain("drop");
      return "verified replay";
    });
    expect(result).toBe("verified replay");
    expect(f.events).toEqual([
      "source",
      "collision",
      "create",
      "bind",
      "connected",
      "close-owned",
      "recheck",
      "drop",
      "absence",
      "close-bootstrap",
    ]);
    expect(f.state.exists).toBe(false);
    expect(f.connections).toHaveLength(2);
    const create = f.queries.find((q) => q.sql.includes("create database"));
    expect(create?.sql).toMatch(
      /^\s*create database "restore_replay_[a-f0-9]{24}" owner "nutrition_local" template template0\s*$/,
    );
    const drop = f.queries.find((q) => q.sql.includes("drop database"));
    expect(drop?.sql.trim()).toBe(`drop database "${f.state.name}"`);
    expect(JSON.stringify(f.queries)).not.toContain("force");
    expect(JSON.stringify(f.queries)).not.toContain("cascade");
  });
  it.each([
    "postgresql://user:synthetic@remote.invalid/source",
    "postgresql://user:synthetic@localhost/source",
    "https://127.0.0.1/source",
    "postgresql://user:synthetic@127.0.0.1/source?options=-csearch_path=private",
    "postgresql://user:synthetic@127.0.0.1/source#fragment",
    "not a URL",
  ])("rejects unqualified bootstrap %s before creating a client", async (url) => {
    fixture();
    await expect(withRestoreIntegrationDatabase(url, async () => null)).rejects.toThrow(
      "literal loopback",
    );
    expect(calls.create).not.toHaveBeenCalled();
  });
  it.each(["collision", "badOwner"] as const)(
    "does not create or drop when %s is observed",
    async (flag) => {
      const f = fixture();
      f.state[flag] = true;
      await expect(withRestoreIntegrationDatabase(sourceUrl, async () => null)).rejects.toThrow();
      expect(f.events).not.toContain("create");
      expect(f.events).not.toContain("drop");
      expect(f.events.at(-1)).toBe("close-bootstrap");
    },
  );
  it("retains an uncertain creation instead of dropping an unbound database", async () => {
    const f = fixture();
    f.state.ambiguousCreate = true;
    await expect(withRestoreIntegrationDatabase(sourceUrl, async () => null)).rejects.toThrow();
    expect(f.state.exists).toBe(true);
    expect(f.events).not.toContain("drop");
  });
  it("retains a created database when its ownership receipt cannot be read", async () => {
    const f = fixture();
    f.state.missingBinding = true;
    await expect(withRestoreIntegrationDatabase(sourceUrl, async () => null)).rejects.toThrow();
    expect(f.state.exists).toBe(true);
    expect(f.events).not.toContain("drop");
  });
  it("rejects a substituted connection and cleans only the pinned owned database", async () => {
    const f = fixture();
    f.state.wrongConnection = true;
    const work = vi.fn();
    await expect(withRestoreIntegrationDatabase(sourceUrl, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(f.events).toContain("drop");
    expect(f.state.exists).toBe(false);
  });
  it.each(["changedOid", "changedOwner", "closeFailure"] as const)(
    "preserves the database on cleanup %s",
    async (flag) => {
      const f = fixture();
      f.state[flag] = true;
      await expect(withRestoreIntegrationDatabase(sourceUrl, async () => null)).rejects.toThrow();
      expect(f.events).not.toContain("drop");
      expect(f.state.exists).toBe(true);
      expect(f.events.at(-1)).toBe("close-bootstrap");
    },
  );
  it("preserves the original replay error and a cleanup failure together", async () => {
    const f = fixture();
    f.state.dropFailure = true;
    const original = new Error("replay failed");
    const error = await withRestoreIntegrationDatabase(sourceUrl, async () => {
      throw original;
    }).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(original);
    expect(error.errors.some((e: Error) => e.message === "owned drop failed")).toBe(true);
    expect(f.events.at(-1)).toBe("close-bootstrap");
  });
  it("rejects incomplete cleanup instead of returning the replay result", async () => {
    const f = fixture();
    f.state.residue = true;
    await expect(
      withRestoreIntegrationDatabase(sourceUrl, async () => "success"),
    ).rejects.toThrow();
    expect(f.events).toContain("absence");
    expect(f.state.exists).toBe(true);
  });
  it("still closes and removes its isolated database when the replay callback fails", async () => {
    const f = fixture();
    const original = new Error("positive replay assertion failed");
    const error = await withRestoreIntegrationDatabase(sourceUrl, async () => {
      throw original;
    }).catch((error) => error);
    expect(error.errors).toContain(original);
    expect(f.state.exists).toBe(false);
    expect(f.events.at(-1)).toBe("close-bootstrap");
  });
});
