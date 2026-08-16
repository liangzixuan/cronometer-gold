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
