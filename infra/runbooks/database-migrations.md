# Forward-only database migrations

## Rules

1. Migration names are zero-padded and monotonic, for example
   `0002_add_food_identity_mapping.sql`.
2. An applied file is immutable. The runner verifies SHA-256 checksums and stops if
   a file is changed or removed.
3. SQL files contain no `BEGIN`, `COMMIT`, or rollback/down section. The runner owns
   one PostgreSQL transaction and advisory lock for the pending set.
4. Never put bulk food data into a schema migration. Import jobs use staging,
   validation, and atomic release promotion.
5. Use expand/migrate/contract across releases. A deploy must remain compatible
   with the previous application version; destructive contract work gets a later
   migration only after readers have moved and a recovery window has passed.
6. Review lock behavior, table scans, index-build mode, statement timeout, disk
   headroom, and replica lag before production execution.

## Local execution

```sh
pnpm --filter @nutrition-tracker/db test
pnpm --filter @nutrition-tracker/db typecheck
pnpm --filter @nutrition-tracker/db db:migrate
pnpm --filter @nutrition-tracker/db db:migrate
```

The second run must report no pending migrations. An integration test should also
build a fresh database from zero before merge.

## Production checklist

- [ ] Change and rollback-forward plan reviewed; no secret or user data in SQL.
- [ ] Current automated backup/PITR health verified and restore drill is in date.
- [ ] Application compatibility window documented.
- [ ] Query plan/lock duration rehearsed on representative volume.
- [ ] Exact artifact and migration checksums captured in the deployment record.
- [ ] One migration runner enabled; application instances cannot race it.
- [ ] Error rate, database connections, locks, replica lag, disk, and outbox lag watched.
- [ ] Post-deploy invariants and application smoke tests pass.

## 0004 diary preflight and remediation

`0004_diary_accounts_and_revisions.sql` intentionally supports only active
legacy entries that can be represented by the new public, source-backed food
diary contract. It aborts before any DDL if a non-deleted note, quick-add,
recipe, custom/source-less food, malformed food snapshot, or invalid profile/day
time zone exists. Serving-less portions must use canonical grams with
`quantity = resolved_grams`; an old `quantity = 1, input_unit = 'oz'` row cannot
be rendered safely even if it has a resolved gram weight, so it also blocks the
migration. Rows with a serving reference must use `input_unit = 'serving'` and
must exactly satisfy `resolved_grams = quantity * serving.gram_weight`; otherwise
display and subsequent edits would diverge. The PostgreSQL error includes the
incompatible count and up to five example entry IDs.

Before retrying, export the affected records for retention and either migrate
them to a reviewed source-backed food record or remove them through an approved
privacy/data-remediation process. Do not fabricate source attribution. Deleted
unsupported kinds may remain and are migrated as tombstones only when their
copied immutable payload is structurally valid. Deleted rows still undergo
bounded-text, finite numeric/date/time, canonical nutrient-unit, position, and
256-component vector checks. Rehearse this check against a restored production
snapshot before the deployment window.

The preflight also rejects malformed/non-normalized account emails, profiles
that cannot satisfy the public response schema, invalid empty diary days, more
than 256 active nutrients, a legacy entry or active-day nutrient union above
256, and an active day above the 50-entry controlled-beta response limit.
Timestamp year checks are evaluated in UTC, independent of the operator session
zone. Numeric `NaN` or infinite catalogue/diary facts fail before DDL.

The migration's greater-than-50 rejection is an immutable historical upgrade
and representation boundary. Response pagination does not change, supersede,
or retroactively reinterpret that preflight, and `0004` must never be edited to
admit a larger legacy day. Runtime writes and coherent whole-day aggregation
also retain the independent 50-active-entry cap after paginated reads are
introduced. Raising either boundary requires new scale and client evidence plus
a forward-only migration or explicitly compatible runtime decision; pagination
alone is not that evidence.

Pre-0004 diary entries already own their `client_operation_id`, but the old
schema has no request digest or result payload. Those keys are therefore treated
as reservations after upgrade: reuse deterministically returns
`DIARY_IDEMPOTENCY_CONFLICT`; exact replay is not reconstructable.

## 0005 recipe and goal preflight

`0005_recipes_and_goals.sql` requires the experimental legacy `recipe` and
`nutrition_goal` root tables to be empty before it creates any new object. The
old tables do not contain the immutable yield provenance, complete nutrient
vectors, source attribution, equation inputs, or idempotency digests required by
the production contracts. The migration therefore aborts before DDL instead of
inventing that evidence. It takes a write-blocking lock before this check so a
legacy application instance cannot insert a root between preflight and schema
conversion; drain old writers and rehearse the lock duration before deployment.

Rehearse the preflight against a restored snapshot. If it fails, export the
experimental rows, retain the export under the approved data-handling policy,
and either recreate them through the reviewed APIs after migration or perform a
separately approved remediation. Retry the whole forward migration after the
roots are empty. There is no down migration; a failed attempt rolls back with no
`app_schema_migration` ledger row, and recovery remains a forward repair or a
verified restore/cutover.

After deployment, API readiness compares the exact ordered migration ledger with
the bundled files and checksums. A reachable database that is missing `0005`, has
an extra unknown migration, or records a different checksum remains unready; do
not bypass this as a rollout shortcut.

Recipe and goal tables add privacy cascades for their owner-controlled data, but
this migration does not implement whole-account erasure. Existing diary,
custom-food, audit, and immutable-history edges still require the separately
reviewed privileged deletion workflow before account-deletion compliance can be
claimed.

## Catalogue and diary lock-order audit

Keep the canonical order `source -> food -> version -> release -> nutrient
registry -> sorted diary days`. Mapping registration locks its source before the
global nutrient-registry advisory and processes each set by canonical nutrient
code then source key. Cross-day diary mutations sort source/target day IDs. The
per-user diary advisory and active-account row lock precede this chain. Reversing
source/nutrient order can deadlock mapping registration with diary creation;
locking days in caller order can deadlock opposing moves.

Imported source-backed servings and nutrient facts may be inserted only while
their release is `imported`. The insert guard locks and revalidates the
source/food/version/release chain, so a child either commits before promotion or
is rejected after promotion. Never append children to a promoted, failed, or
quarantined release.

## Failure behavior

The transaction rolls back the pending schema set and does not write its migration
ledger row. Capture the PostgreSQL error and blocking-query evidence. Correct the
problem with a new or not-yet-applied migration; never edit a migration already
recorded in any shared environment.

There are no automated down migrations. Recovery is forward repair or, for a
catastrophic deployment, restoring a verified backup into a new database and
performing a reviewed cutover.
