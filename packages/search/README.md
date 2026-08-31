# Food search core

This package owns public food discovery, not private/custom-food search. It provides:

- strict public search documents, including reviewed licence/attribution metadata, and a converter
  for the PostgreSQL promoted-food projection;
- normalized keyword, intent, locale, market-plus-global, and canonical GTIN-14 queries;
- HMAC-authenticated cursors bound to query, filters, page size, hashed preference state, and the
  immutable active index generation;
- curated food synonyms and typo-tolerant Meilisearch settings with typos disabled for numbers and
  barcodes;
- bounded, deterministic favorite/recent reranking performed after shared-index search;
- safe autocomplete that returns plain labels and never backend highlight markup;
- an abortable REST adapter and task polling with request/task timeouts;
- generation rebuilds with repeatable-read snapshots, batching, count verification, atomic swap,
  post-swap verification, rollback, and explicit non-fatal cleanup debt when displaced-index
  deletion must be retried.

There is deliberately no user, diary, health, favorite, or recent-use field in
`FoodSearchDocument`. User preferences are supplied to `FoodSearchService` for a single request and
only their digest enters a cursor fingerprint. Custom foods require a separate authenticated
PostgreSQL path.

## Runtime wiring

```ts
const client = new MeilisearchHttpClient({
  host: config.meiliUrl,
  apiKey: config.meiliSearchKey,
});

const search = new FoodSearchService({
  backend: new MeilisearchFoodSearchBackend({ client }),
  cursorSecret: config.searchCursorSecret,
});
```

The API should receive a search-only key. The rebuild worker receives a mutation key scoped to
`foods*` for creating, configuring, swapping, inspecting, and deleting indexes, plus a distinct
task-observer key with only `tasks.get` across `*`; the broader index scope is necessary because
Meilisearch index-swap task records do not carry index UIDs. Pass the observer as `taskApiKey` so it
is used only by `getTask()` and `waitForTask()`. TLS is required outside loopback. Never log any key
or a raw preference collection.

`FoodSearchProjectionSource.openSnapshot()` must provide one coherent count-and-row view. The
production worker materializes that view to a bounded private spool inside a repeatable-read
transaction, closes PostgreSQL, then streams the spool while Meilisearch tasks run. Its `close()`
method removes the spool; the rebuild always calls it. Convert DB documents through
`toFoodSearchDocument()`.

## Verification

```sh
pnpm --filter @nutrition-tracker/search typecheck
pnpm --filter @nutrition-tracker/search test
pnpm --filter @nutrition-tracker/search build
```

The real integration suite is opt-in and destructive to the `foods` index on the designated test
server. Use an isolated Meilisearch instance:

```sh
TEST_MEILI_URL=http://127.0.0.1:7700 \
node node_modules/dotenv-cli/cli.js --override --no-expand \
  -e /absolute/path/to/owner-only-scoped-meili.env -- \
  pnpm --filter @nutrition-tracker/search test:integration
```

The private file must contain distinct `MEILI_SEARCH_KEY`,
`MEILI_ADMIN_KEY`, and `MEILI_TASK_OBSERVER_KEY` values created by the
fixed-policy bootstrap. The integration deliberately does not accept the
master key as a shortcut.

It rebuilds more than 500 documents in batches and verifies typo search, synonyms, generic/branded
intent, dynamic kind tie-breaking, autocomplete, barcode equivalence, local preference reranking,
exclusion of private/quarantined projection rows, atomic generation replacement, and warmed p95
latency at or below 500 ms.
