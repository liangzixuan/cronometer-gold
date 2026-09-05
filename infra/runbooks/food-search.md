# Food-search projection operations

PostgreSQL is the catalogue authority. Meilisearch contains only a disposable,
public projection of the current promoted food versions. Never add user IDs,
diary history, favorites, recents, custom foods, biometrics, or free-form notes
to the shared index.

## Preconditions

- Database migrations are current, including the promoted-food eligibility view.
- `DATABASE_URL` uses a read-capable service identity with statement timeouts.
- `MEILI_URL` uses TLS outside loopback.
- The API receives `MEILI_SEARCH_KEY` with only `search` on `foods`.
- The worker receives a distinct `MEILI_ADMIN_KEY` mutation key limited to the
  reviewed create/get/delete/swap, document-add, settings-update, and stats-get
  actions on `foods*`, plus `MEILI_TASK_OBSERVER_KEY` with only `tasks.get` on
  `*`. The observer's broad index scope is required because index-swap task
  records do not carry index UIDs. Neither worker key may manage keys or search.
- `SEARCH_REBUILD_WORKER_ID` is a stable workload identity, not a person or
  machine-local random value.
- `SEARCH_REBUILD_SPOOL_DIR` points to a capacity-monitored, encrypted ephemeral
  volume in production. The configured byte and document limits exceed the
  expected projection with headroom.
- A catalogue source is not searchable until its reviewed release is promoted.

## Manual rebuild

Use this after initial deployment, index loss, settings changes, or a recovery
where the outbox consumer was unavailable:

```sh
pnpm --filter @nutrition-tracker/worker search:rebuild
```

The projection starts with `published_revision = NULL`; an arbitrary preexisting
`foods` index is never trusted after the migration. Keep keyword traffic on the
bounded PostgreSQL fallback until this first verified manual rebuild publishes
the current revision.

The command opens one repeatable-read catalogue snapshot, writes its public rows
to a bounded `0600` NDJSON spool, fsyncs it, and closes the transaction before any
Meilisearch task waits. It then writes a new uniquely named generation, verifies
the emitted and indexed counts, and atomically swaps the stable `foods` index. The
spool is revalidated while read and removed on every normal or error path. It never
mutates catalogue records. A PostgreSQL advisory lock prevents an older concurrent
snapshot from swapping after a newer one.

The normal worker consumes `catalogue.source_release_activated` outbox events,
including source-rights and public-eligibility changes. It atomically claims a
bounded batch, performs one complete rebuild, and acknowledges the full owned
batch in the same transaction that records the verified published revision.
Failure records one sanitized error class and schedules each event for a bounded
retry or terminal dead letter.

The rebuild holds the dedicated advisory lock through revision verification,
the Meilisearch swap, and the atomic publish/ack transaction. Projection-mutating
source, food, current-version barcode, and current-version serving triggers take
the matching transaction lock before they can commit. Such catalogue writes are
therefore intentionally blocked for the duration of a rebuild; keep those write
transactions short and alert on lock wait time. A mutation that began during the
build commits afterward, advances `current_revision`, and leaves the API in
PostgreSQL fallback until its next event is rebuilt. The API must compare the
exact `{current_revision, published_revision}` state both before and after a
Meilisearch query and discard the result if either read differs or is unpublished.

## Verification

After a rebuild, verify:

1. emitted projection count equals the new generation's document count;
2. the stable index count matches after the swap;
3. exact GTIN-8/12/13/14 variants resolve to the same valid GTIN-14 identity;
4. representative generic, branded, synonym, typo, market, and language
   fixtures rank as expected;
5. a quarantined version, archived food, private/custom food, inactive source,
   and superseded version are absent;
6. a source without redistribution approval is absent, and required reviewed
   attribution appears in search, autocomplete, and barcode results;
7. API fallback remains bounded and functional while Meilisearch is stopped.

Run the automated gates with:

```sh
pnpm --filter @nutrition-tracker/db test
pnpm --filter @nutrition-tracker/search test:integration
pnpm verify
```

The live Meilisearch integrations require `TEST_MEILI_URL` plus the generated
`MEILI_SEARCH_KEY`, `MEILI_ADMIN_KEY`, and `MEILI_TASK_OBSERVER_KEY`. Load
those three scoped values from the owner-only bootstrap output; never substitute
the master key. For a fresh absent absolute output path, the standalone
`scoped-meili-keys.mjs --output-file <path>` bootstrap consumes only
`MEILI_MASTER_KEY`, `MEILI_URL`, and `MEILI_PORT` from the environment. It does
not trust the intentionally non-authoritative scoped placeholders in a newly
copied `.env`; after policy and permission canaries pass, it writes the generated
keys through an exclusive owner-only mode-`0600` file descriptor. Load that file
over `.env`, then run `scoped-meili-keys.mjs` with no arguments: replay mode
treats all ambient scoped values as exact expectations and fails on any mismatch.

## Legacy mutation-key revocation

The former worker key UID
`2aac5083-d036-4b24-8bb4-2b9ae77a90f1` includes broader wildcard permissions.
Creating the new fixed mutation and task-observer keys does not silently delete
that legacy record. Treat revocation as a separately approved post-readiness
rollout step:

1. Bootstrap the new fixed keys and atomically install both worker values.
2. Run the full deployment preflight, one complete rebuild, worker/API
   readiness, and search assertions using only the three scoped keys.
3. In an isolated loopback fixture first, delete the legacy UID with a
   master-authenticated, strict-TLS request; prove the old credential is denied,
   the new mutation and observer canaries still pass, and readiness remains
   healthy.
4. Only after recording that evidence, repeat the exact deletion against the
   reviewed production endpoint and immediately rerun readiness and search.

Do not auto-revoke during bootstrap: a partially rolled-out worker could still
depend on the legacy key. Never print the master or scoped key while gathering
revocation evidence, and never disable TLS verification.

## Failure and rollback

- Before the atomic swap, failure leaves the current stable index untouched and
  deletes the incomplete generation.
- During a first build, no empty stable index is exposed before the complete
  generation is ready.
- After a swap, failed post-swap verification swaps the prior generation back
  before cleanup.
- A failed deletion of the displaced index is cleanup debt, not a failed
  publication. Acknowledge the activation, alert on the retained index UID, and
  retry only that deletion through the reviewed cleanup operation.
- If Meilisearch is unavailable, first-page keyword/autocomplete calls may use
  the bounded PostgreSQL trigram fallback; continuation cursors fail closed.
  Barcode lookup always uses the authoritative PostgreSQL mapping.
- If search results expose an ineligible food, disable the API search route or
  revoke its search key before changing catalogue rights. If the revocation
  transaction is waiting on the rebuild advisory lock, cancel the active worker
  rebuild through the deployment platform, let the database revocation commit,
  and verify `current_revision <> published_revision`. Keep search disabled (or
  on the PostgreSQL eligibility-view fallback) until a verified rebuild makes
  the revisions equal. Preserve logs without query text. Do not repair the index
  by hand.
- Catalogue rollback emits another activation event. Rebuild from PostgreSQL;
  never point the index at a historical generation without verifying the
  current source-release set.

## Privacy and observability

API lifecycle logs include route templates, status, duration, and server-issued
request IDs only. They exclude raw URLs and query strings. Meilisearch keys must
not appear in logs or error bodies. Monitor request latency, backend error rate,
zero-result rate, rebuild and spool duration/size, free spool capacity, outbox
age/batch size/retry count, cleanup debt, document-count drift, and fallback usage
without retaining search terms by default.
