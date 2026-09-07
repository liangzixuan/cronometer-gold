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
corrected approval/guard ACLs plus
migration-0016's two food-search function search paths and exact
source-eligibility trigger plus migration-0017's four food/serving/barcode
function search paths and exact statement-trigger bindings plus
migration-0018's four active-nutrient lock functions and seven exact trigger
bindings plus migration-0019's frozen materialization contract, replacement
activation-authority constraint, identifier-only promotion/rollback functions,
activation authority guard, migration-0020's sealed stage/validate boundary,
and migration-0021's independent exact-100-gram nutrition semantic attestation
with NFC, exact ECMAScript whitespace, JavaScript UTF-16-unit bounds, and
numeric-versus-string `100` parity plus the complete shared-food/outbox trigger
surface. The transactional repair policy
pins 54 function identities, 54 exact trigger bindings, the sixteen
authority-evidence column definitions, all eight authority CHECKs,
and the unique activation-to-batch index. Before creating a
dump, the drill requires the exact 21 `public.app_schema_migration` names and
SHA-256s from the tracked migration files, ignoring any owner-schema shadow
ledger, and corroborates that ledger after restore. The drill then
compares a canonical source/target role, schema, type, table, sequence,
column-ACL, function, trigger, authority-constraint, and authority-index
fingerprint. It also
rechecks the exact target database owner, ACL, effective login allowlist, and session isolation immediately before
success. It leaves `PUBLIC CONNECT` revoked. If the policy, owner, fingerprint,
or target isolation differs, stop the rehearsal; do not improvise grants.

Do not interpolate an unreviewed variable into a delete/drop command. Cleanup of a
drill database is a separate approved action after evidence is retained.

## Validation

Run and save results without exporting payload values:

1. Before `pg_dump`, require exact `(name, checksum)` equality between
   `public.app_schema_migration` and every tracked migration filename/file-byte
   SHA-256; ignore an owner-schema shadow. Recheck the source ledger and
   corroborate the restored target against the same tracked manifest.
2. Verify the target database owner, exact database ACL, revoked `PUBLIC CONNECT`,
   and reviewed effective login allowlist,
   then verify the canonical post-restore database-authority fingerprint. The
   fingerprint must cover capability-role attributes and memberships;
   schema/table/sequence/column and exact function owners and ACLs; every
   authority/`SECURITY DEFINER` signature, owner, executable semantics, trigger
   definition, and pinned `search_path`, including migration-0016's
   source-eligibility trigger and its two-function projection call chain and
   migration-0017's remaining four outbox functions and exact trigger bindings
   plus migration-0018's four nutrient-lock functions and seven bindings and
   migration-0019's exact wrapper/guard bodies plus migration-0020's five
   stage/validate workflow functions, owner-only seal helper, three guards, and
   migration-0021's exact semantic functions, public wrappers, owner-only `_v1`
   implementations and database-state batch attestor, two guards, immutable
   record/batch attestations, and fail-closed approval/promotion/non-null rollback
   checks; exact per-function ACLs, sixteen authority-evidence column definitions,
   all eight authority CHECKs, the unique
   activation-to-batch index, and the complete protected trigger surface; and
   absence of `PUBLIC EXECUTE` on every `SECURITY DEFINER` workflow function and
   owner-only authority guard. Other reviewed ordinary security-invoker
   functions may retain PostgreSQL default `PUBLIC EXECUTE`.
   Hash and retain the canonical result with the drill evidence.
   Prove denial of owner-capable runtime credentials separately after deployment
   identities exist; the EXPAND local-owner drill does not prove it.
3. Keep target-environment real-login role canaries deferred to live DEPLOY.
   ADR 0018 now includes a source-only DEPLOY-0 parser, structural verifier,
   strict CLI, and zero-write canary runner for a canonical credential-free
   policy, proven with disposable real logins in an isolated loopback database.
   This tooling never
   creates a login, issues a credential, or changes an ACL or membership. The
   policy contains expected identifiers, safe role attributes, and membership
   options, but no connection URL, credential, private key, token, or private
   identity-provider claim. It permits only three reviewer logins, each with
   exactly its matching approval capability and PostgreSQL 17 membership options
   `ADMIN FALSE`, `INHERIT TRUE`, and `SET FALSE`. Reviewer logins must own no
   objects, hold no other membership, have no effective catalogue
   table/column/sequence privilege, and have no schema `CREATE` privilege. Stage,
   validate, promote-and-activate, and rollback capabilities remain unassigned
   and fail closed until their caller profiles and cutovers exist. Their narrow
   functions are present and pinned after migrations 0019 through 0021.

   The EXPAND restore policy continues to require zero incoming and outgoing
   capability memberships, so never add an ad hoc membership to make this drill
   pass. After restore policy and its zero-membership fingerprint pass, only a
   separate reviewed deploy procedure may establish the exact DEPLOY-0 reviewer
   memberships. After that procedure, the deploy verifier requires the exact
   tracked `public` migration ledger; requires `public` to be the only
   non-system schema and to be owned by
   `pg_database_owner`; exact database, schema, relation, type, function, and
   membership ACLs and grantors; no default or column ACL drift; all
   54 authority function hashes/semantics/configuration values and
   exact execute ACLs, safe authority on every other public routine, and the
   exact 54-trigger protected shared-food/outbox authority set with
   exact table and function schemas,
   including every binding of a dedicated public authority trigger function
   even when its table is outside `public`; all eight authority CHECKs, the sixteen
   authority-evidence columns, the unique activation-to-batch index, safe roles,
   and memberships. The policy, evidence, canary, and CLI report use schema
   version 5. The effective-login allowlist and seven isolated verifier sessions
   permit no other
   target-database client. Its zero-write canaries prove all of the following:

   - a matching reviewer reaches `23503` after calling the approval function
     with valid-shaped input and a nonexistent batch UUID;
   - a mismatched reviewer reaches `42501` before batch lookup;
   - unassigned, API, and worker logins reach `42501` at the function `EXECUTE`
     boundary; and
   - a non-executing direct reviewer approval-table `EXPLAIN INSERT` reaches
     `42501` without consuming an identity value.

   Migrations 0017 and 0018 grant no runtime privilege and do not authorize
   direct non-owner DML. Migrations 0019 through 0021 grant execute only to
   unassigned `NOLOGIN` workflow capabilities and grant no table, column, or sequence
   privilege. Keep runtime cutover blocked until independently operated
   stage/validate callers, external-principal binding, any remaining
   fixed-purpose writer profiles, and representative-scale evidence exist and
   target positive and negative role canaries exercise the complete boundary.
   Migration 0021 proves database recomputation, not live identity separation or
   caller operation.

   The exact membership graph structurally rejects a multi-capability deployment
   before canaries; the separate authority-boundary integration test retains its
   transient multi-capability `42501` regression. The final canonical fingerprint
   and approval row count must equal their initial values. Persist the canonical
   credential-free stable structure projection alongside its SHA-256 so the
   digest is independently recomputable; exclude volatile backend PIDs. Save only error classes
   and bounded identifiers, never row payloads or credentials. Connection URLs
   are environment-only. TLS defaults to `verify-full`; `disable` is loopback-only,
   URL query/fragment overrides and process-wide Node TLS bypass are rejected,
   and successful connection cleanup precedes creation of a new mode-0600
   evidence file under ignored `.local-data`. A future reviewed procedure must
   define target login and credential provisioning, authenticated principal
   binding, API/worker/ingestion/migration/backup/restore credential separation,
   narrow workflow-function callers, cutover and cleanup, final membership
   state, target canaries, and CONTRACT direct-DML/owner-runtime revocation. The
   restore fingerprint itself stays zero-membership. Live DEPLOY and CONTRACT
   remain blocked.

   Separately, the logical restore drill's internal canonical authority
   fingerprint schema is version 12. It binds exact public-column ACL rows, the
   sixteen authority-evidence column definitions, all eight authority CHECKs, the unique
   activation-to-batch index, the independent count of non-NULL column ACL
   attributes, each trigger's table schema, every public-table trigger, and every
   cross-schema binding of a dedicated public authority trigger function. The
   final report emits the fingerprint SHA-256, not the internal evidence
   document.
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
