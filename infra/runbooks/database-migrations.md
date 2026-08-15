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

## Failure behavior

The transaction rolls back the pending schema set and does not write its migration
ledger row. Capture the PostgreSQL error and blocking-query evidence. Correct the
problem with a new or not-yet-applied migration; never edit a migration already
recorded in any shared environment.

There are no automated down migrations. Recovery is forward repair or, for a
catastrophic deployment, restoring a verified backup into a new database and
performing a reviewed cutover.
