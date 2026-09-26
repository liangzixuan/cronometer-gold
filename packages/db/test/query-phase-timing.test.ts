import type { PluginTransformQueryArgs } from "kysely";
import { describe, expect, it } from "vitest";

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
