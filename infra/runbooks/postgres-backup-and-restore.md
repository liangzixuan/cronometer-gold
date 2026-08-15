# PostgreSQL backup and restore starter

This is the baseline for logical-backup drills. Production managed PostgreSQL also
needs encrypted automated snapshots, point-in-time recovery, retention, and a
documented regional failure strategy. A backup is not accepted until a restore and
application validation succeed.

## Safety boundary

- Restore into a newly created, explicitly named database or isolated instance.
- Never run restore commands against the current production database.
- Resolve source, target, environment, region, encryption, retention, and ticket
  before execution. Use separate credentials with minimum required privileges.
- Pause no service and perform no cutover without the incident/change owner.
- Treat the dump as sensitive health-adjacent data. Encrypt it, restrict access,
  avoid shell history, and retain it only per policy.

## Logical backup

Set task-specific variables in a protected shell or secret runner; do not commit
their values:

```sh
export NUTRITION_BACKUP_SOURCE_URL='<source connection URL>'
export NUTRITION_BACKUP_FILE='/approved/encrypted/path/nutrition-YYYYMMDDTHHMMSS.dump'
pg_dump --dbname="$NUTRITION_BACKUP_SOURCE_URL" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$NUTRITION_BACKUP_FILE"
shasum -a 256 "$NUTRITION_BACKUP_FILE"
pg_restore --list "$NUTRITION_BACKUP_FILE"
```

Record the SHA-256, byte size, PostgreSQL version, database migration ledger,
start/end timestamps, encryption/key reference, and retention expiry outside the
dump. A successful exit alone is not restore proof.

## Restore rehearsal

The target must be a new empty database whose name includes the drill or incident
identifier:

```sh
export NUTRITION_RESTORE_ADMIN_URL='<isolated admin connection URL>'
export NUTRITION_RESTORE_DB='nutrition_restore_<ticket>'
export NUTRITION_RESTORE_TARGET_URL='<new empty target connection URL>'

createdb --maintenance-db="$NUTRITION_RESTORE_ADMIN_URL" "$NUTRITION_RESTORE_DB"
pg_restore --dbname="$NUTRITION_RESTORE_TARGET_URL" \
  --exit-on-error --single-transaction --no-owner --no-privileges \
  "$NUTRITION_BACKUP_FILE"
```

Do not interpolate an unreviewed variable into a delete/drop command. Cleanup of a
drill database is a separate approved action after evidence is retained.

## Validation

Run and save results without exporting payload values:

1. Compare migration names/checksums in `app_schema_migration`.
2. Compare counts and min/max timestamps for each major table; reconcile expected
   in-flight differences for online logical backups.
3. Confirm all constraints are validated and required extensions exist.
4. Run authentication, food detail/search fallback, diary totals, recipe, goal,
   outbox, and export smoke tests with synthetic accounts.
5. Verify current-version pointers reference their own roots and no promoted source
   release points to a missing artifact.
6. Verify a sample diary entry renders exclusively from its nutrient snapshot.
7. Measure actual recovery-point and recovery-time objectives and record gaps.

## Managed PITR incident outline

1. Declare incident owner and desired recovery timestamp using database and outbox
   evidence; account for clock/time-zone conversion explicitly.
2. Restore the managed snapshot/PITR stream to a new instance.
3. Keep writes disabled while the validation checklist runs.
4. Reconcile outbox side effects and idempotency keys around the recovery point.
5. Approve cutover, rotate credentials/endpoints, and monitor error/outbox lag.
6. Preserve the old instance read-only for the approved evidence window, then use
   the provider's governed retirement workflow.
