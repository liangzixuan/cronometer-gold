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
- Preprovision the exact reviewed cluster-global roles before restore. Database
  migrations and per-database logical dumps do not create deployment login
  identities. Reject a role-name collision whose attributes or membership differ
  from the versioned policy.
- In a deployment with separated identities, block `CONNECT` for `PUBLIC` and
  every application/runtime principal before restore, terminate any pre-existing
  target sessions, and allow only the reviewed restore identities. The current
  EXPAND CI drill uses its local owner login as the restore executor; it verifies
  an explicit login allowlist but does not prove a separate runtime fence.
- Treat the dump as sensitive health-adjacent data. Encrypt it, restrict access,
  avoid shell history, and retain it only per policy.
- The automated drill currently accepts only `--dump-protection tmpfs` after it
  verifies the exact real directory and mount type, refuses a pre-existing path
  or symlink, creates the artifact under `umask 077`, attests exact executor
  ownership and mode `0600`, and proves mandatory artifact removal.
  `encrypted_volume` remains fail-closed until the runner can verify encryption
  independently; a declaration alone is not evidence. Generic `/tmp` and
  unverified filesystems are rejected.

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
# Before pg_restore, use the reviewed admin procedure to revoke CONNECT from
# PUBLIC and every runtime principal, terminate existing target sessions, and
# verify that the restore operator is the only remaining connection.
pg_restore --dbname="$NUTRITION_RESTORE_TARGET_URL" \
  --exit-on-error --single-transaction --no-owner --no-privileges \
  "$NUTRITION_BACKUP_FILE"
```

`--no-owner` makes restored objects belong to the restore executor or an explicit
`pg_restore --role`; `--no-privileges` omits GRANT/REVOKE state. These flags avoid
replaying source-cluster identities, but their successful exit is evidence that
data and definitions restored—not that database authority is safe.

The automated `scripts/postgres-restore-drill.mjs` path requires
`--expected-owner` and an exact `--connect-allowlist`, creates and restores the
target under that reviewed role, revokes `PUBLIC CONNECT`, and transactionally
applies the SHA-256-pinned
`packages/db/restore/0014_catalogue_authority_policy.sql`. That policy pins the
migration-0014 function/trigger manifest and the forward migration-0015
activation-null constraint and corrected approval/guard ACLs. The drill then compares a
canonical source/target role, schema, type, table, sequence, function, trigger,
and authority-constraint fingerprint. It also rechecks the exact target database
owner, ACL, effective login allowlist, and session isolation immediately before
success. It leaves `PUBLIC CONNECT` revoked. If the policy, owner, fingerprint,
or target isolation differs, stop the rehearsal; do not improvise grants.

Do not interpolate an unreviewed variable into a delete/drop command. Cleanup of a
drill database is a separate approved action after evidence is retained.

## Validation

Run and save results without exporting payload values:

1. Compare migration names/checksums in `app_schema_migration`.
2. Verify the target database owner, exact database ACL, revoked `PUBLIC CONNECT`,
   and reviewed effective login allowlist,
   then verify the canonical post-restore database-authority fingerprint. The
   fingerprint must cover capability-role attributes and memberships;
   schema/table/sequence and exact function owners and ACLs; every
   authority/`SECURITY DEFINER` signature, owner, executable semantics, trigger
   definition, and pinned `search_path`; the exact validated migration-0015
   activation-audit null constraint; and absence of `PUBLIC EXECUTE` on the
   `SECURITY DEFINER` approval function and its approval guard. Other ordinary
   security-invoker functions may retain PostgreSQL default `PUBLIC EXECUTE`.
   Hash and retain the canonical result with the drill evidence.
   Prove denial of owner-capable runtime credentials separately after deployment
   identities exist; the EXPAND local-owner drill does not prove it.
3. Defer positive real-login role canaries to DEPLOY, where reviewed login-to-
   capability memberships and their cleanup/final-state policy exist. The EXPAND
   restore policy requires zero incoming and outgoing capability memberships, so
   never add an ad hoc membership to make this drill pass. DEPLOY canaries must
   prove that a reviewer may invoke only its matching approval capability, cannot
   impersonate another review class, and cannot modify approval rows directly;
   API, worker, and unrelated roles must be denied. Stage, validate,
   promote-and-activate, and rollback remain fail-closed until their narrow
   functions and CONTRACT cutover exist. Save error classes and identifiers,
   never row payloads or credentials, and run the final fingerprint only after
   any explicitly approved transient canary membership has been revoked.
4. Compare counts and min/max timestamps for each major table; reconcile expected
   in-flight differences for online logical backups.
5. Confirm all constraints are validated and required extensions exist.
6. Confirm restored nullable database-principal/capability audit fields exactly
   match the dump. Never backfill or infer a historical actor, role, or approval
   authority from an application string, object owner, restore operator, or
   present-day membership.
7. Before starting or probing the API, decrypt and replay every external account-
   erasure ledger entry whose subject exists in the restored snapshot, using the
   restore-only version-list/exact-version-read principal and historical locator
   and ledger key rings. Reject missing, ambiguous, truncated, or delete-marker
   histories; reconcile every replayed subject to zero live rows. Generate a new
   `DATABASE_RESTORE_EPOCH` for this target—never reuse the source/PITR value—and
   pass that same epoch to the offline replay command and, only afterward, the API
   and worker deployments. A restored API and worker must remain unready until
   this step writes the matching database-name/OID/epoch attestation.
8. Run authentication, food detail/search fallback, diary totals, recipe, goal,
   outbox, and export smoke tests with synthetic accounts.
9. Verify current-version pointers reference their own roots and no promoted source
   release points to a missing artifact.
10. Verify a sample diary entry renders exclusively from its nutrient snapshot.
11. Only after the fingerprint, role canaries, erasure replay, and application
    validation pass may the change owner grant runtime `CONNECT`. Before traffic
    starts, recheck the unchanged authority fingerprint plus the exact database
    owner and ACL, revoked `PUBLIC CONNECT`, the newly reviewed effective-login
    allowlist, and zero unexpected sessions.
12. Measure actual recovery-point and recovery-time objectives and record gaps.

## Managed PITR incident outline

1. Declare incident owner and desired recovery timestamp using database and outbox
   evidence; account for clock/time-zone conversion explicitly.
2. Restore the managed snapshot/PITR stream to a new instance.
3. Keep runtime `CONNECT` and all application traffic disabled while the
   versioned owner/ACL policy, authority fingerprint, role canaries,
   erasure-ledger replay, and the validation checklist run.
4. Reconcile outbox side effects and idempotency keys around the recovery point.
5. Approve cutover, rotate credentials/endpoints, and monitor error/outbox lag.
6. Preserve the old instance read-only for the approved evidence window, then use
   the provider's governed retirement workflow.
