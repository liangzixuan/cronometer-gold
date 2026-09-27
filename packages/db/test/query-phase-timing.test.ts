import { CompiledQuery, type LogEvent, type PluginTransformQueryArgs } from "kysely";
import { describe, expect, it } from "vitest";
import * as phaseTiming from "./query-phase-timing.js";
import { createQueryPhaseTiming } from "./query-phase-timing.js";

const query = (kind: "SelectQueryNode" | "InsertQueryNode" = "SelectQueryNode") =>
  ({ node: { kind }, queryId: { queryId: "test" } }) satisfies PluginTransformQueryArgs;

describe("bounded recipe query phase timings", () => {
  it("returns the exact query and result while retaining only numeric aggregates", async () => {
    let now = 10;
    const timing = createQueryPhaseTiming(() => now);
    const input = query();
    const result = { rows: [{ privateName: "not for output" }] };
    expect(timing.plugin.transformQuery(input)).toBe(input.node);
    now = 12.7;
    expect(await timing.plugin.transformResult({ queryId: input.queryId, result })).toBe(result);
    expect(timing.take()).toEqual([
      { kind: "select", started: 1, completed: 1, totalMs: 3, maxMs: 3 },
    ]);
    expect(timing.take()).toEqual([]);
  });

  it("attributes overlapping completions by query identity and keeps counts separate", async () => {
    let now = 0;
    const timing = createQueryPhaseTiming(() => now);
    const a = query();
    const b = query();
    const c = query("InsertQueryNode");
    timing.plugin.transformQuery(a);
    now = 2;
    timing.plugin.transformQuery(b);
    timing.plugin.transformQuery(c);
    now = 5;
    await timing.plugin.transformResult({ queryId: b.queryId, result: { rows: [] } });
    now = 7;
    await timing.plugin.transformResult({ queryId: a.queryId, result: { rows: [] } });
    expect(timing.take()).toEqual([
      { kind: "select", started: 2, completed: 2, totalMs: 10, maxMs: 7 },
      { kind: "insert", started: 1, completed: 0, totalMs: 0, maxMs: 0 },
    ]);
    now = 9;
    await timing.plugin.transformResult({ queryId: c.queryId, result: { rows: [] } });
    expect(timing.take()).toEqual([]);
  });

  it("does not copy raw SQL, parameters, result rows or unmatched results into output", async () => {
    const timing = createQueryPhaseTiming(() => 1);
    const input = {
      node: { kind: "RawNode", sqlFragments: ["sensitive SQL"], parameters: [] },
      queryId: { queryId: "sensitive identifier" },
    } satisfies PluginTransformQueryArgs;
    expect(timing.plugin.transformQuery(input)).toBe(input.node);
    const result = { rows: [{ secret: "private result" }] };
    expect(await timing.plugin.transformResult({ queryId: { queryId: "unmatched" }, result })).toBe(
      result,
    );
    expect(timing.take()).toEqual([
      { kind: "raw", started: 1, completed: 0, totalMs: 0, maxMs: 0 },
    ]);
  });
});

function driverEvent(
  statement: string,
  duration: number,
  level: "query" | "error" = "query",
): LogEvent {
  const common = {
    query: CompiledQuery.raw(statement, ["PRIVATE_PARAMETER_CANARY"]),
    queryDurationMillis: duration,
  };
  return level === "query"
    ? { level, ...common }
    : { level, ...common, error: new Error("PRIVATE_ERROR_CANARY") };
}

describe("bounded driver completion phase timings", () => {
  it("aggregates completed success and failure durations without rounding individual samples", async () => {
    const timing = phaseTiming.createDriverPhaseTiming();
    await timing.log(driverEvent("begin", 0.49));
    await timing.log(driverEvent("begin", 0.49));
    await timing.log(driverEvent("begin", 0.62, "error"));
    expect(timing.take()).toEqual([
      { kind: "begin", succeeded: 2, failed: 1, totalMs: 2, maxMs: 1 },
    ]);
    expect(timing.take()).toEqual([]);
  });
  it("recognizes only the exact finite transaction command strings", async () => {
    const timing = phaseTiming.createDriverPhaseTiming();
    for (const statement of [
      "begin",
      "start transaction isolation level read committed",
      "start transaction isolation level repeatable read",
      "start transaction isolation level repeatable read read only",
      "commit",
      "rollback",
      "BEGIN",
      "begin;",
      "begin PRIVATE_SQL_CANARY",
      " commit",
      "rollback -- PRIVATE_SQL_CANARY",
      "start transaction isolation level serializable",
    ]) {
      await timing.log(driverEvent(statement, 1));
    }
    expect(timing.take()).toEqual([
      { kind: "begin", succeeded: 4, failed: 0, totalMs: 4, maxMs: 1 },
      { kind: "commit", succeeded: 1, failed: 0, totalMs: 1, maxMs: 1 },
      { kind: "rollback", succeeded: 1, failed: 0, totalMs: 1, maxMs: 1 },
      { kind: "raw", succeeded: 6, failed: 0, totalMs: 6, maxMs: 1 },
    ]);
  });

  it("classifies ordinary completions by AST kind rather than parsing SQL text", async () => {
    const timing = phaseTiming.createDriverPhaseTiming();
    const kinds = [
      "SelectQueryNode",
      "InsertQueryNode",
      "UpdateQueryNode",
      "DeleteQueryNode",
      "RawNode",
      "CreateTableNode",
    ] as const;
    for (const [index, kind] of kinds.entries()) {
      const raw = CompiledQuery.raw("delete PRIVATE_SQL_CANARY", ["PRIVATE_PARAMETER_CANARY"]);
      const event = {
        level: "query" as const,
        query: { ...raw, query: { kind } as CompiledQuery["query"] },
        queryDurationMillis: index + 1,
      };
      await timing.log(event);
    }
    expect(timing.take()).toEqual([
      { kind: "select", succeeded: 1, failed: 0, totalMs: 1, maxMs: 1 },
      { kind: "insert", succeeded: 1, failed: 0, totalMs: 2, maxMs: 2 },
      { kind: "update", succeeded: 1, failed: 0, totalMs: 3, maxMs: 3 },
      { kind: "delete", succeeded: 1, failed: 0, totalMs: 4, maxMs: 4 },
      { kind: "raw", succeeded: 1, failed: 0, totalMs: 5, maxMs: 5 },
      { kind: "other", succeeded: 1, failed: 0, totalMs: 6, maxMs: 6 },
    ]);
  });

  it("attributes a late completion to its completion phase without revising earlier reports", async () => {
    const timing = phaseTiming.createDriverPhaseTiming();
    const lateCompletion = driverEvent("PRIVATE_LATE_SQL_CANARY", 9, "error");
    expect(timing.take()).toEqual([]);
    await timing.log(driverEvent("commit", 2));
    const priorPhase = timing.take();
    expect(priorPhase).toEqual([{ kind: "commit", succeeded: 1, failed: 0, totalMs: 2, maxMs: 2 }]);
    await timing.log(lateCompletion);
    await timing.log(driverEvent("commit", 3));
    expect(timing.take()).toEqual([
      { kind: "raw", succeeded: 0, failed: 1, totalMs: 9, maxMs: 9 },
      { kind: "commit", succeeded: 1, failed: 0, totalMs: 3, maxMs: 3 },
    ]);
    expect(priorPhase).toEqual([{ kind: "commit", succeeded: 1, failed: 0, totalMs: 2, maxMs: 2 }]);
    expect(timing.take()).toEqual([]);
    expect(phaseTiming.createDriverPhaseTiming().take()).toEqual([]);
  });

  it("leaves frozen input untouched and emits only bounded numeric aggregates without inspecting private fields", async () => {
    const timing = phaseTiming.createDriverPhaseTiming();
    const compiled = Object.freeze({
      ...CompiledQuery.raw("PRIVATE_SQL_CANARY"),
      queryId: Object.freeze({ queryId: "PRIVATE_IDENTIFIER_CANARY" }),
      get parameters(): readonly unknown[] {
        throw new Error("PRIVATE_PARAMETER_CANARY must not be read");
      },
    });
    const event = Object.freeze({
      level: "error" as const,
      query: compiled,
      queryDurationMillis: 4.25,
      get error(): unknown {
        throw new Error("PRIVATE_ERROR_CANARY must not be read");
      },
      get rows(): unknown {
        throw new Error("PRIVATE_RESULT_CANARY must not be read");
      },
    });
    await timing.log(event);
    const rows = timing.take();
    expect(rows).toEqual([{ kind: "raw", succeeded: 0, failed: 1, totalMs: 4, maxMs: 4 }]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
    expect(event.query).toBe(compiled);
    expect(event.queryDurationMillis).toBe(4.25);
  });
});
