# Food-search architecture

Status: implementation milestone, reviewed 2026-08-15.

## Authority and privacy boundary

PostgreSQL is the catalogue authority. The shared Meilisearch index is disposable
and contains only public generic or branded foods whose current version belongs to
the source's currently promoted release. Archived, private, quarantined,
superseded, deactivated, incomplete-import, and unreviewed-source rows fail closed.
Sources must separately allow commercial use and redistribution. Reviewed licence
and attribution metadata travels with every search hit and autocomplete suggestion;
clients render the reviewed attribution text whenever the source requires it.
Search output never changes a food, nutrient value, serving, barcode, release, or
historical diary snapshot.

The shared document has no user, diary, favorite, recent-use, biometric, note, or
health field. Authenticated favorite and recent-food preferences are applied to a
bounded candidate window after shared-index retrieval. They are neither written to
Meilisearch nor included verbatim in cursors or logs.

## Projection lifecycle

1. Acquire one coherent, read-only PostgreSQL catalogue snapshot and serialize its
   public rows to a size- and count-bounded `0600` spool on encrypted ephemeral
   storage.
2. Close the PostgreSQL snapshot, then stream the spool into a uniquely named
   generation index. No external search task is awaited inside the database
   transaction.
3. Apply versioned settings before accepting traffic.
4. Wait for every asynchronous settings/document task and fail on timeout or task
   error.
5. Compare the indexed document count with the authoritative snapshot count.
6. Verify that the projection revision captured with the snapshot is still the
   current PostgreSQL revision, then atomically swap the successful generation
   into the stable `foods` index.
7. Verify the stable count and swap the prior generation back on failure.
8. In one PostgreSQL transaction, record the verified revision as published and
   acknowledge the complete claimed outbox batch.
9. Delete the displaced generation only after verification succeeds. A deletion
   failure becomes visible cleanup debt; it does not invalidate or rebuild a
   successfully published generation.

A failed build leaves or restores the prior stable index. On the first build, the
stable placeholder is created only after the generation is complete, so clients
cannot mistake a build-in-progress empty index for authoritative zero results.
Each retry uses a new generation and refuses to overwrite any existing generation
name. Activation, rollback, rights, and public-eligibility changes use the
transactional outbox. A worker claims a bounded event batch and acknowledges that
batch after one full rebuild; events arriving during the rebuild remain for the
next snapshot.

Meilisearch documents that settings and document writes are asynchronous tasks and
that index swaps are atomic. Those behaviors are explicit adapter contracts rather
than timing assumptions:

- <https://www.meilisearch.com/docs/capabilities/indexing/tasks_and_batches/monitor_tasks>
- <https://www.meilisearch.com/docs/resources/internals/indexes>

## Credential boundary

The API receives only the fixed search key (`search` on `foods`). The worker's
`MEILI_ADMIN_KEY` is a mutation key limited to
`indexes.create`, `indexes.get`, `indexes.delete`, `indexes.swap`,
`documents.add`, `settings.update`, and `stats.get` on `foods*`; it has no
search, task, or key-management action. Task observation is deliberately split
to `MEILI_TASK_OBSERVER_KEY`, whose only action is `tasks.get`. Its index scope
is `*` because Meilisearch index-swap task records have no index UID and are
otherwise hidden from an index-scoped key. The HTTP adapter uses this observer
only for `/tasks/:uid` polling and uses the mutation or search key on every
other route. All three scoped keys are distinct from one another and from the
master bootstrap key.

## Relevance contract

Searchable attributes are intentionally bounded and ordered: normalized food name,
display name, brand, reviewed aliases, and useful serving labels. Filters are
limited to public catalogue dimensions such as kind, market, language, source, and
data quality. Exact words and attribute order win before intent-specific sort
tie-breaks. Typo tolerance stays enabled for food words and disabled on numerical
identifiers. A small reviewed synonym set covers true food-name equivalence; it is
not an uncontrolled thesaurus.

The request accepts `all`, `generic`, or `branded` intent. Explicit generic or
branded intent is a filter. With `all`, inferred intent is only a late
deterministic tie-break, so a weak generic result cannot outrank an exact branded
match. Autocomplete uses the same eligibility and attribute contract with a
smaller candidate and response limit.

Relevant Meilisearch settings are documented at:

- <https://www.meilisearch.com/docs/reference/api/settings/list-all-settings>
- <https://www.meilisearch.com/docs/capabilities/full_text_search/relevancy/typo_tolerance_settings>
- <https://www.meilisearch.com/docs/capabilities/full_text_search/how_to/configure_searchable_attributes>

## Barcode contract

Barcode lookup is an authoritative PostgreSQL exact lookup, not fuzzy text search.
It accepts GTIN-8, GTIN-12, GTIN-13, or GTIN-14 only after validating the GS1 check
digit. Shorter GTINs are right-justified and zero-padded to a 14-digit comparison
identity. A requested market wins, then global market `001`; without a market,
global wins and lexical market order is the deterministic fallback.

GS1 states that GTIN-8, GTIN-12, and GTIN-13 may be represented in a zero-padded
14-digit field without changing the identifier:
<https://ref.gs1.org/guidelines/2d-in-retail/1.0.0/>.

## Failure behavior

- Invalid text, filters, cursor, or check digit returns a safe client error.
- Meilisearch unavailability may use the bounded PostgreSQL trigram fallback for a
  first page; it never writes fallback results back to catalogue truth.
- An unpublished or changed PostgreSQL projection revision uses that same
  authoritative fallback. Indexed results are accepted only when matching
  current/published revision reads are equal and unchanged before and after the
  query, including empty pages.
- Barcode lookup remains available while Meilisearch is unavailable.
- All public food-search responses are `no-store`; shared caching cannot extend a
  source-rights revocation beyond the authoritative request-time checks.
- A cursor is integrity-protected and bound to normalized query, filters, intent,
  page size, preference-state digest, and the indexed catalogue generation. A
  generation swap makes old continuations fail closed instead of returning
  duplicate or skipped foods.
- Query text, cursor contents, and preference identifiers are excluded from
  lifecycle logs.

## Milestone evidence

Release gates cover strict types and schemas, unit relevance vectors, real
PostgreSQL eligibility/exclusion and barcode cases, live Meilisearch typo/synonym/
autocomplete/swap behavior, warm latency fixtures, dependency audit, and license
policy. The ignored government-source archives are not required for search CI;
synthetic promoted foods exercise the same public projection boundary.
