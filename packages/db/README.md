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

### Catalogue workflow authority EXPAND boundary

The current EXPAND slice freezes the canonical validation digest on
`food_import_batch` in the same update as the validated summary and routes
`approveBatch` through `catalogue_record_import_approval`. The function preserves
exact approval replay while binding non-owner calls to their database principal
and reviewer capability. Existing owner/local workflows remain compatible and
record nullable database-audit fields.

`approveBatch` treats `trustedSchema` as internal deployment configuration, not
request or imported catalogue input. It defaults to `public`; isolated-schema
tools must pass their migration schema explicitly. Before approval reads, the
client verifies that the ambient `food_import_batch` resolves to that exact
relation and attests the exact approval-function body, executable metadata,
owner, and ACL plus the approval-guard body, exact owner-only ACL, and ordinary
enabled trigger. It then pins the transaction-local search path before any
approval read.

This is EXPAND only. Owner compatibility remains in place; non-owner role cutover
and the database wrappers for the other catalogue workflow phases are still
pending. Do not revoke owner-era privileges or treat this slice as the CONTRACT
phase. Forward migration 0015 keeps the database-audit fields on new or changed
activation/rollback rows constrained to paired `NULL` values until those reviewed
wrappers exist. It
detects pre-cutover capability-role membership and legacy paired non-NULL
activation-authority evidence after installing the stricter constraint as `NOT
VALID` and reducing the approval function to owner-only execution. It grants the
exact three reviewer roles only when neither unsafe condition exists.
Independently, it validates the constraint whenever no legacy paired non-NULL
activation-authority evidence exists; membership alone keeps reviewer execution
disabled but leaves the constraint validated. Either unsafe condition commits a
guarded state with readiness blocked through its corresponding evidence; repair
requires a new reviewed forward policy rather than replaying this non-idempotent
migration.

Logical restores use the transactional policy in
`restore/0014_catalogue_authority_policy.sql`. It pins the migration-0014
function/trigger boundary plus the forward migration-0015 activation-null
constraint and approval/guard-ACL corrections. The repository restore drill
pins that file's SHA-256, requires an explicit expected owner, keeps `PUBLIC CONNECT`
revoked, enforces an exact effective login allowlist, and compares a canonical
role/schema/type/relation/function/trigger/authority-constraint fingerprint before
external-ledger replay or API probing. The current EXPAND CI executor and owner
are the same local login, so this restore control does not claim deployment
runtime separation or close the remaining role-canary or CONTRACT work.

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

### 0005 recipe and goal compatibility gate

Migration `0005_recipes_and_goals.sql` intentionally fails before any DDL when
an experimental deployment contains a legacy `recipe` or `nutrition_goal` root.
Those reserved tables did not retain enough evidence to reconstruct immutable
final-yield semantics, complete nutrient aggregates, reviewed energy snapshots,
or idempotency digests/results. Do not fabricate that history. Export and
remediate the experimental rows, retry the entire migration transaction, and
verify the normal fresh-schema and 0004-to-0005 upgrade gates. There is no down
migration.

Recipe and goal child rows cascade when an unreferenced owning root is removed;
an immutable recipe version referenced by diary history remains retained. This
does not make direct `app_user` deletion a supported erasure workflow. Legacy
diary, custom-food, operation, and audit edges still require a separately
designed privileged privacy-erasure process for the controlled beta.

### 0006 retention compatibility and privacy gate

Migration `0006_retention_features.sql` takes a write-conflicting lock on the
legacy food roots and fails before any retention DDL when a pre-0006 custom food
exists. The reserved schema does not contain the immutable version, explicit
trace/unknown missingness, serving, operation-digest, or owner provenance needed
by the retention model. Export/remediate those rows and retry the whole migration;
do not fabricate evidence. The migration also validates the two staged 0002
reviewer-principal constraints. It is forward-only and has no down migration.

Retention writes preserve exact decimals, immutable version IDs, user ownership,
active-account gates, and the existing user/source/nutrient/day lock order. Custom
foods materialize a complete active-registry vector, default to provisional and
estimated owner-entered provenance, and may feed owner recipes. Archiving blocks
new recipe dependencies while old recipe and diary snapshots stay readable.
Platform imports are signed, device/integration/cursor-epoch bound, replay-safe,
and deduplicated by immutable provider source IDs; device recovery appends a
rebind revision and begins a null cursor epoch without inferring deletions.

Privacy export capture uses one bounded (five-minute) PostgreSQL 17
`REPEATABLE READ` transaction to materialize canonical, keyset-ordered rows into
the immutable DB spool. The callback, 0600 filesystem spool, encryption, and
object-store I/O run only after that transaction closes. Every entity reconciles
source/export counts, watermark, and SHA-256 over the exact canonical NDJSON row
set; diary daily nutrient totals and biometric/import identity counts provide a
second semantic digest. A closed schema fingerprint makes a new/unclassified DB
column fail the export before capture instead of silently leaking it.
Only one queued/running/retryable-failed export may exist per owner; an advisory
user lock and a partial unique index enforce that rule for repository and raw
writes. The worker passes its exact spool byte ceiling into
`withPrivacyExportSnapshot` (bounded by the shared 10 GiB maximum). PostgreSQL
counts each canonical NDJSON row before insertion, rolls the entire snapshot back
on overflow, and terminalizes the deterministic failure for governed operator
requeue instead of repeating the same capture 20 times. Every failed/stale retry
purges its prior record/entity spool before rebuilding.

Workers must register every JSON/CSV object key with
`stagePrivacyExportArtifacts` before PUT, then mark the exact job/snapshot/worker
artifact uploaded. Completion is fenced to that snapshot and promotes only the
registered keys. All artifacts in one completed job have one common expiry, so a
completed job cannot expose a partially expired set before that instant. Failed
uploads become globally claimable cleanup work with stale-lock recovery, a
20-attempt dead letter, and verified deletion evidence. Workers renew claimed work
at most every five minutes with `renewRetentionWorkLease`; a PUT in progress also
uses `renewPrivacyExportStagedArtifactUploadLease`, which atomically extends its
object fence and owning export-job lease. Loss of either renewal is a hard stop.
Claim-time and explicit-failure terminal transitions append payload-free durable
events consumed through `claimRetentionDeadLetterEvents`. Requeueing a terminal
job or either artifact cleanup requires an external operator-approval digest and
appends immutable `retention_job_recovery_audit` evidence. Erasure requeue retains
the original `started_at`, which is the already-appended ledger record time.
Account erasure atomically cancels staged uploads and enumerates both staged and
completed keys; completion refuses until the sets and deletion evidence match.
Before either live erasure or offline restore replay deletes a row, one complete
typed table policy must exactly match the transitive `app_user` FK graph. Explicit
entries generate both the subject DELETE and its zero-row reconciliation;
cascades name an exact all-NOT-NULL constraint and parent path; retained/empty
exceptions name and validate their exact `SET NULL`/`RESTRICT` relationship. A
new table, nullable/unrelated cascade, or changed FK action therefore fails before
the account row can be removed.

Before deleting application rows, the worker must append an encrypted external
restore-erasure ledger record and supply its reference/digest acknowledgement.
Only a random receipt, aggregate deletion counts, policy/timestamps, and the
backup caveat remain locally; subject IDs, locators, request/session evidence,
object keys, and restore-ledger identifiers are scrubbed. A restored backup must
run `replayExternalErasureLedgerEntry` for every authenticated external entry and
require its zero-row reconciliation before serving. The offline process then calls
`completeDatabaseRestoreReplayAttestation` with an explicit deployment restore
epoch, reconciled subject count, and digest. Production readiness calls
`assertDatabaseReady` with that same explicit epoch; it verifies both the complete
migration ledger and the SHA-256 epoch attestation bound to the current database
name/OID. The DB library never reads an ambient restore epoch. The external
encrypted ledger and ciphertext object lifecycle are operational dependencies
outside PostgreSQL.

### 0010 private hydration ledger

Migration `0010_hydration_ledger.sql` creates four owner-scoped tables:
`hydration_day`, `hydration_entry`, `hydration_entry_revision`, and
`hydration_operation`. An entry head points to one immutable contiguous revision
chain; deletion appends a tombstone revision instead of erasing history. The
operation ledger stores a canonical request digest and exact result for
owner-scoped UUID replay. Direct revision, operation, entry, and day deletion is
guarded; whole-account erasure uses reviewed non-null cascades from `app_user`.
All four tables participate in the closed privacy-export schema and exact
JSON/CSV and zero-row erasure reconciliation.

Hydration amounts are exact integers from 1 through 20,000 mL. Database checks
and serialized repository writes cap each profile-local day at 64 active entries
and 100,000 total mL. Those limits are operational bounds, not health guidance.
The server derives finite local dates and millisecond local times from each
finite `occurred_at` instant and the active profile's canonical IANA zone.
Immutable revisions retain that effective zone and their original local
coordinates; a day read separately exposes the profile's current zone.

Hydration writers take a hydration-specific per-owner advisory lock, lock the
active account, read the current profile zone, lock an active entry head when
needed, and lock affected day IDs in deterministic order. Create/update/delete
recheck caps in that transaction. Amount-only corrections preserve the stored
instant, local coordinates, and effective zone; updates that change `occurred_at`
derive new coordinates from the current profile zone and may move days, advancing
both day revisions. Reads use one read-only `REPEATABLE READ` snapshot. Repository
writes therefore preserve owner isolation, exact idempotent replay, strong
revision preconditions, consistent day revisions, immutable history, and bounded
totals under concurrency. Schema guards independently enforce owner references,
contiguous immutable revision history, head consistency, and entry/day bounds.
Direct SQL is not a supported hydration mutation protocol and is not promised to
advance application day synchronization tokens. Migration 0010 is forward-only
and has no down migration.

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
   Hydration mutations use their dedicated per-owner advisory namespace, then
   lock the active account, read the current profile, lock the entry head, and
   lock sorted affected days.
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
5. Recipe writers lock the active user, then all source IDs, food IDs, immutable
   food-version IDs, and release IDs in sorted order before nested recipe roots
   and the nutrient registry. Recipe diary writes retain that source-first order
   before sorted diary-day locks. Goal writers lock the active user and coherent
   profile snapshot, then goal roots and the nutrient registry. Multi-root goal
   and nested-recipe sets are always sorted.

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
