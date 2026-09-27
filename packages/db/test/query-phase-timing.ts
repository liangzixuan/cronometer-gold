import type { KyselyPlugin, LogEvent, Logger, PluginTransformQueryArgs } from "kysely";

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

type DriverCommandKind = QueryKind | "begin" | "commit" | "rollback";

function driverCommandKind(event: LogEvent): DriverCommandKind {
  switch (event.query.query.kind) {
    case "SelectQueryNode":
      return "select";
    case "InsertQueryNode":
      return "insert";
    case "UpdateQueryNode":
      return "update";
    case "DeleteQueryNode":
      return "delete";
    case "RawNode":
      // Exact fixed commands emitted by this fixture's installed PostgreSQL driver.
      switch (event.query.sql) {
        case "begin":
        case "start transaction isolation level read committed":
        case "start transaction isolation level repeatable read":
        case "start transaction isolation level repeatable read read only":
          return "begin";
        case "commit":
          return "commit";
        case "rollback":
          return "rollback";
        default:
          return "raw";
      }
    default:
      return "other";
  }
}

/**
 * Test-only Kysely driver completions, including failed queries and transactions.
 * Retains only static kinds, status counts and durations; SQL is compared with
 * fixed transaction commands but never retained, nor are parameters/errors/rows.
 * Each event belongs to its completion phase. Timings exclude connection acquisition
 * and compilation, overlap plugin timings, and can overlap under concurrency.
 */
export function createDriverPhaseTiming() {
  let phase = new Map<
    DriverCommandKind,
    { succeeded: number; failed: number; totalMs: number; maxMs: number }
  >();
  const log: Logger = (event) => {
    const kind = driverCommandKind(event);
    let timing = phase.get(kind);
    if (!timing) {
      timing = { succeeded: 0, failed: 0, totalMs: 0, maxMs: 0 };
      phase.set(kind, timing);
    }
    if (event.level === "error") timing.failed += 1;
    else timing.succeeded += 1;
    const duration = Math.max(0, event.queryDurationMillis);
    timing.totalMs += duration;
    timing.maxMs = Math.max(timing.maxMs, duration);
  };
  return {
    log,
    take() {
      const report = [...phase].map(([kind, timing]) => ({
        kind,
        succeeded: timing.succeeded,
        failed: timing.failed,
        totalMs: Math.round(timing.totalMs),
        maxMs: Math.round(timing.maxMs),
      }));
      phase = new Map();
      return report;
    },
  };
}
