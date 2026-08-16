# `@nutrition-tracker/db`

Typed Kysely access and forward-only PostgreSQL migrations for the modular
monolith. PostgreSQL owns constraints and historical truth; packages above this
layer own authorization and domain orchestration.

## Commands

```sh
pnpm --filter @nutrition-tracker/db typecheck
pnpm --filter @nutrition-tracker/db test
pnpm --filter @nutrition-tracker/db build
pnpm --filter @nutrition-tracker/db db:migrate
```

The migration runner:

- discovers numbered SQL files in lexical order;
- computes a SHA-256 for each file;
- serializes runners with a PostgreSQL advisory lock;
- applies the pending set in one transaction;
- records checksums in `app_schema_migration`; and
- refuses modified or missing applied files.

It deliberately has no down-migration API. Use expand/migrate/contract and a new
forward migration to repair schema. See the
[migration runbook](../../infra/runbooks/database-migrations.md).

### 0004 legacy diary compatibility gate

Migration `0004_diary_accounts_and_revisions.sql` upgrades the legacy diary into
the immutable, food-only revision model. Before creating any new object, it
checks every non-deleted legacy entry. Active entries must be public,
source-backed branded/generic foods with complete source-release attribution and
a resolvable profile/day time zone. A serving-less portion must already be
canonical grams (`input_unit = 'g'` and `quantity = resolved_grams`); legacy
ounce or other ambiguous portions cannot be safely reconstructed. A referenced
serving must use `input_unit = 'serving'`, have a gram weight, and satisfy
`resolved_grams = quantity * serving.gram_weight` exactly. Active notes,
quick-adds, recipes, custom or source-less foods, ambiguous portions, and
malformed snapshots block the migration transactionally. Export or remediate
those rows before retrying. Deleted unsupported kinds may remain as tombstones
only when every copied immutable field is structurally valid; position, numeric,
date/time, text, source-summary, and per-entry nutrient-vector checks apply to
deleted rows too.

The same preflight protects public response bounds: normalized email/profile
fields must fit their contracts, dates and timestamps must be finite in UTC,
numeric values must not be `NaN`/infinite, the active nutrient registry and every
entry/day nutrient union are limited to 256, and an active day is limited to 50
entries. Fifty is the controlled-beta limit for the non-paginated endpoint and
keeps a synthetic 50-by-256 response within the roughly 5 MiB mobile-memory
budget. Pagination is required before raising it.

Legacy `client_operation_id` values remain reserved. Version 0001 did not retain
the digest or response needed to reconstruct an exact replay, so a post-upgrade
reuse returns the typed `DIARY_IDEMPOTENCY_CONFLICT` error rather than attempting
the mutation or surfacing a raw unique-key error.

## Client

```ts
import { createDatabaseFromEnvironment } from "@nutrition-tracker/db";

const database = createDatabaseFromEnvironment();
// Pass `database` to repositories; call `database.destroy()` at shutdown.
```

Numeric and `bigint` PostgreSQL values are represented as strings when selected,
matching the `pg` driver's precision-preserving defaults. Domain code must use the
nutrition package's exact-decimal conversion rather than JavaScript `number` for
stored arithmetic.

The application should supply UUIDv7 values for user-facing IDs where locality is
valuable. PostgreSQL's `gen_random_uuid()` default is a safe local/import fallback,
not the canonical ID-generation policy.

## Lock order and immutable catalogue children

All writers must preserve this global order:

1. Diary mutations take the per-user advisory lock, then lock the active account.
2. New food logs lock source, food, food version, and source release in that order;
   they then pin the nutrient registry and finally lock affected diary-day IDs in
   sorted order. Cross-day moves use the same sorted day set.
3. Nutrient mapping writers lock their source first, then the global nutrient
   registry advisory lock, and process mapping inputs sorted by canonical nutrient
   code and source key. Raw nutrient inserts/active-state updates take that registry
   lock in a `BEFORE STATEMENT` trigger.
4. Source-backed `food_nutrient_value` and `food_serving` inserts lock source, food,
   version, and release and are accepted only while the release is `imported`.
   Promotion makes those children permanently closed. Custom source-less versions
   remain available to user-owned privacy workflows.

Do not introduce a nutrient-before-source or unsorted multi-day/multi-mapping path.
The deterministic concurrency tests intentionally pause each side of these orders
to guard against deadlocks, post-revocation logs, mixed nutrient generations, and
open-to-locked diary races. Day reads use one read-only `REPEATABLE READ` snapshot;
writes use `READ COMMITTED` behind the per-user lock so idempotent replays observe a
just-committed operation.

## Promoted food-search read model

`promoted_food_search_catalogue_v1` is the only catalogue source for search-index
rebuilds. It fails closed unless a food is public, current, non-quarantined, tied
to the source's active promoted release, backed by a completed/materialized import,
and owned by an active source with recorded rights review. Historical, rolled-back,
disabled, and quarantined rows therefore cannot leak into a new index.

Use `consumeFoodSearchProjectionSnapshot` for a complete index build. It pages all
documents inside one read-only `REPEATABLE READ` transaction and supplies a stable
source-release generation digest, projection revision, and expected document
count. The worker must durably spool and close this transaction before waiting on
the external search service. Do not stitch a rebuild together with independent
`pageFoodSearchProjection` calls; those calls
deliberately represent separate snapshots and are intended for bounded API/admin
reads. Documents include stable string IDs/numerics, release provenance, market and
language, validated canonical GTIN-14 identities, and deterministically ordered
servings.

`lookupPromotedFoodByBarcode` validates the GS1 check digit and treats GTIN-8,
GTIN-12, and GTIN-13 as equivalent to their zero-padded GTIN-14 identity. An
explicit market is preferred before global market `001`; without a market, global
wins before lexical market order. `searchPromotedFoodsPostgres` is a bounded,
two-second PostgreSQL trigram fallback, not the primary relevance engine.

Search rebuild workers use `claimFoodSearchRebuildEvents`,
`publishFoodSearchProjectionAndAcknowledgeEvents`, and
`releaseFoodSearchRebuildEvents` for bounded, coalesced at-least-once delivery.
Claims use `FOR UPDATE SKIP LOCKED`, recover stale locks, bind acknowledgements to
a stable worker ID, accept only sanitized failure codes, and dead-letter after
eight exponentially backed-off failures. A successful worker transaction asserts
the exact snapshot revision, records it as published, and acknowledges the whole
owned batch atomically. Manual rebuilds use `publishFoodSearchProjectionRevision`.
`getFoodSearchProjectionPublicationState` remains unpublished until a verified
build and must gate external-index reads. Wrap the complete build, swap, and
publication in `withFoodSearchRebuildLock`; a `null` result means another builder
owns the dedicated session advisory lock. Catalogue eligibility/metadata triggers
take the matching transaction lock, so relevant writes intentionally wait until
the verified publication finishes.
