import assert from "node:assert/strict";

function matchesRuntime(runtime, directory, runId) {
  return (
    runtime.version === 2 &&
    runtime.syntheticOnly === true &&
    runtime.runtime === directory &&
    runtime.runId === runId
  );
}

export function assertCatalogueRuntime(runtime, { directory, runId, postgresPort, meiliPort }) {
  assert(
    matchesRuntime(runtime, directory, runId) &&
      String(runtime.ports.postgres) === postgresPort &&
      String(runtime.ports.meilisearch) === meiliPort,
    "Service targets must match the selected runtime",
  );
}

export function assertAccountRuntime(runtime, { directory, runId, apiPort }) {
  assert(
    matchesRuntime(runtime, directory, runId) && String(runtime.ports.api) === apiPort,
    "API target must match the selected runtime",
  );
}
