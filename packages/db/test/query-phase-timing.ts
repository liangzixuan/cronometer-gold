import type { KyselyPlugin, PluginTransformQueryArgs } from "kysely";

type QueryKind = "select" | "insert" | "update" | "delete" | "raw" | "other";
interface QueryTiming {
  started: number;
  completed: number;
  totalMs: number;
  maxMs: number;
}

/**
 * Test-only transform-to-result timings, including compilation, queueing and execution.
 * No SQL, parameters, identifiers or result rows are inspected. Failed queries and
 * driver transaction commands have no completion sample; concurrent durations overlap.
 * take() reports a phase once, so later completions cannot revise an emitted phase.
 */
export function createQueryPhaseTiming(now = () => performance.now()) {
  let phase = new Map<QueryKind, QueryTiming>();
  const pending = new WeakMap<object, { at: number; timing: QueryTiming }>();
  const kindOf = (node: PluginTransformQueryArgs["node"]): QueryKind => {
    switch (node.kind) {
      case "SelectQueryNode":
        return "select";
      case "InsertQueryNode":
        return "insert";
      case "UpdateQueryNode":
        return "update";
      case "DeleteQueryNode":
        return "delete";
      case "RawNode":
        return "raw";
      default:
        return "other";
    }
  };
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      const kind = kindOf(args.node);
      let timing = phase.get(kind);
      if (!timing) {
        timing = { started: 0, completed: 0, totalMs: 0, maxMs: 0 };
        phase.set(kind, timing);
      }
      timing.started += 1;
      pending.set(args.queryId, { at: now(), timing });
      return args.node;
    },
    async transformResult(args) {
      const query = pending.get(args.queryId);
      if (query) {
        pending.delete(args.queryId);
        const duration = Math.max(0, now() - query.at);
        query.timing.completed += 1;
        query.timing.totalMs += duration;
        query.timing.maxMs = Math.max(query.timing.maxMs, duration);
      }
      return args.result;
    },
  };
  return {
    plugin,
    take() {
      const report = [...phase].map(([kind, timing]) => ({
        kind,
        started: timing.started,
        completed: timing.completed,
        totalMs: Math.round(timing.totalMs),
        maxMs: Math.round(timing.maxMs),
      }));
      phase = new Map();
      return report;
    },
  };
}
