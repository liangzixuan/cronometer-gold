import assert from "node:assert/strict";
import { join } from "node:path";

// Maintained worker composition and bounded polls above raw controlled PG/network replies.
export function runtimeWorkerWire(state) {
  let runtime;
  const applications = [],
    events = [],
    polls = [];
  const networkCounts = () => [
    state.api.requests.length,
    state.meili.requests.length,
    state.wire.requests.length,
    state.wire.issuerRequests.length,
  ];
  return {
    applications,
    events,
    polls,
    async start() {
      assert(!runtime);
      const priorFetch = globalThis.fetch;
      globalThis.fetch = state.meili.fetch;
      try {
        const { createWorkerPollRuntime } = await import("../apps/worker/dist/worker-runtime.js");
        runtime = await createWorkerPollRuntime({
          environment: {
            ...state.config.model.services.worker.environment,
            NODE_EXTRA_CA_CERTS: join(state.input.root, "pki/ca.crt"),
            RETENTION_EXPORT_SPOOL_DIR: join(state.input.root, "data/worker/export-spool"),
            SEARCH_REBUILD_SPOOL_DIR: join(state.input.root, "data/worker/search-spool"),
          },
          clock: () => new Date("2026-10-18T00:00:00.000Z"),
          onOperationalEvent: (event) => events.push(event),
        });
        applications.push(runtime);
      } finally {
        globalThis.fetch = priorFetch;
      }
    },
    async poll(signal = AbortSignal.timeout(10000)) {
      assert(runtime);
      const before = structuredClone(state.sql.tables),
        queryStart = state.queries.length,
        eventStart = events.length,
        failureStart = state.queryFailures?.length ?? 0,
        networks = networkCounts(),
        indexBefore = structuredClone(state.meili.indexes.get("foods"));
      const pending = (before.get("outbox_event") ?? []).filter(
        (row) => row.published_at === null && row.dead_lettered_at === null,
      );
      state.sql.workerIdle.beginPoll();
      try {
        await runtime.pollOnce(signal);
      } finally {
        state.sql.workerIdle.endPoll();
      }
      const observed = {
        mode: pending.length ? "rebuilt" : "idle",
        queries: state.queries.slice(queryStart),
        events: events.slice(eventStart),
        failures: (state.queryFailures ?? []).slice(failureStart),
      };
      polls.push(observed);
      if (observed.failures.length)
        process.stdout.write(`${JSON.stringify({ workerPoll: observed })}\n`);
      assert.deepEqual(observed.failures, [], JSON.stringify(observed));
      if (pending.length) {
        assert.equal(pending.length, 2);
        const event = observed.events[0];
        assert.equal(observed.events.length, 1);
        assert.equal(event.event, "search.rebuild.completed");
        assert.equal(event.level, "info");
        assert.equal(event.eventCount, pending.length);
        assert.equal(event.includedCount, 1);
        assert(pending.some((row) => row.id === event.eventId));
        const expected = structuredClone(before),
          afterRows = state.sql.tables.get("outbox_event");
        expected.set(
          "outbox_event",
          expected.get("outbox_event").map((row) => {
            const after = afterRows.find((item) => item.id === row.id);
            assert(after?.published_at instanceof Date && after.published_at >= row.available_at);
            return {
              ...row,
              published_at: after.published_at,
              last_error: null,
              locked_at: null,
              locked_by: null,
            };
          }),
        );
        const revision = state.sql.tables.get("food_search_projection_revision")[0],
          originalRevision = expected.get("food_search_projection_revision")[0];
        assert(
          revision.updated_at instanceof Date && revision.updated_at >= originalRevision.updated_at,
        );
        expected.set("food_search_projection_revision", [
          { ...originalRevision, updated_at: revision.updated_at },
        ]);
        assert.deepEqual(state.sql.tables, expected);
        const afterNetworks = networkCounts();
        assert.deepEqual(
          [afterNetworks[0], ...afterNetworks.slice(2)],
          [networks[0], ...networks.slice(2)],
        );
        assert(afterNetworks[1] > networks[1]);
        const requests = state.meili.requests.slice(networks[1]);
        assert.equal(
          requests.filter(([method, path]) => method === "POST" && path === "/swap-indexes").length,
          1,
        );
        assert(requests.some(([method, path]) => method === "POST" && path.endsWith("/documents")));
        assert(
          requests.some(
            ([method, path]) =>
              method === "DELETE" && path.startsWith("/indexes/") && path !== "/indexes/foods",
          ),
        );
        const rebuiltIndex = state.meili.indexes.get("foods");
        assert.equal(rebuiltIndex.length, 1);
        assert.notEqual(rebuiltIndex[0].searchGeneration, indexBefore[0].searchGeneration);
        assert(
          requests.some(
            ([method, path]) =>
              method === "DELETE" && path === `/indexes/${rebuiltIndex[0].searchGeneration}`,
          ),
        );
        assert(!state.meili.indexes.has(rebuiltIndex[0].searchGeneration));
        const content = (rows) => rows.map(({ searchGeneration, ...row }) => row);
        assert.deepEqual(content(rebuiltIndex), content(indexBefore));
      } else {
        assert.deepEqual(state.sql.tables, before);
        assert.deepEqual(networkCounts(), networks);
        assert.deepEqual(observed.events, [], JSON.stringify(observed));
        assert.equal(observed.queries.length, 27, JSON.stringify(observed));
      }
      const complete = state.sql.workerIdle.assertComplete();
      assert.equal(complete.rebuilt, pending.length > 0);
    },
    async close() {
      if (!runtime) return;
      const current = runtime;
      try {
        await current.close();
        await assert.rejects(current.pollOnce(), /Worker poll runtime is closed/u);
      } finally {
        runtime = undefined;
      }
    },
  };
}
