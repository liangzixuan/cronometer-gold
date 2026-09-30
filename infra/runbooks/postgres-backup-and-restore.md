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

## Encrypted off-host artifact boundary

`EncryptedPostgresBackupStore` in `@nutrition-tracker/artifact-store` binds a
canonical manifest, source-evidence bytes and a custom-format dump inside the
existing authenticated encryption envelope. It uses the distinct `postgres_backup`
purpose and the `POSTGRES_BACKUP_CURRENT_KEY_ID` /
`POSTGRES_BACKUP_ENCRYPTION_KEYS` configuration. Export and erasure-ledger key
domains and artifact formats remain separate.

The manifest records the backup UUID, deployment target, database name, exact
source revision, exported snapshot identifier, capture timestamp, and the dump
and source evidence's byte sizes and SHA-256 digests. The format marker is
`nutrition-postgres-backup-v2`. Canonical bytes are compact UTF-8 JSON with these
keys in order: `backupId`, `capturedAt`, `databaseName`, `deploymentTarget`,
`dumpBytes`, `dumpSha256`, `formatVersion`, `snapshotId`, `sourceEvidenceBytes`,
`sourceEvidenceSha256`, `sourceRevision`. Do not include a trailing newline,
extra keys or duplicate keys. The frame is `NTPB0002`, a four-byte big-endian
manifest length, the manifest, the source evidence, then the dump. The manifest
is limited to 16 KiB and the evidence to 1 MiB; excess evidence fails without
truncation. This replaces the unpublished v1 frame.

Publication copies and validates the supplied evidence bytes against the
manifest before starting the raw write. Recovery requires the expected backup,
target, database, revision, snapshot and manifest SHA-256. It authenticates the
complete envelope and checks the manifest, evidence and entire dump before
returning `sourceEvidence` and a dump stream. Storage treats the evidence as
opaque bytes. A `PGDMP` prefix is a preliminary format check; it does not establish
that `pg_restore` will accept the archive.

The separate `scripts/postgres-backup-evidence.mjs` adapter defines the canonical
`nutrition-postgres-restore-evidence-v1` record. Use
`serializePostgresBackupEvidence(evidence, expectedOwner)` before publication and
`parsePostgresBackupEvidence(recovered.sourceEvidence, expectedOwner)` before
accepting recovered evidence. The expected owner must come from the reviewed
restore plan. The adapter retains the full authority fingerprint and migration
ledger, checks their digests and the pinned policy, and calls the existing restore
validators. It requires exact table coverage with canonical PostgreSQL int8 row
counts and zero unvalidated constraints. Its returned record can be passed to
`compareRestoreEvidence` with separately validated target evidence. Byte
authentication alone does not establish these policy checks.

The caller must supply an explicit temporary directory and maximum dump size.
Choose a verified protected mount under the restore policy above; the library's
private directory and file permissions do not prove tmpfs or volume encryption.
Dispose the recovered artifact in a `finally` block after consuming or abandoning
its stream. The library removes its owned plaintext spool on validation failure
or cancellation. This is file cleanup, not a guarantee of physical media erasure.

Use a create-only raw-store adapter that consumes each upload through EOF and
rejects an existing object key. The existing file adapter publishes with an
exclusive hard link, and the S3 adapter signs `If-None-Match: *`. An arbitrary
injected `RawArtifactStore` does not prove those properties. Do not delete an
object after a duplicate or ambiguous publication failure. Before cloud use,
qualify the provider's create-only and exact-version behavior with the reviewed
principal; keep retention, native version identity and capacity admission as
separate requirements.

This module authenticates caller-supplied evidence. It does not collect a
PostgreSQL snapshot or verify that the dump came from the claimed database.
Future collection must keep the exporting transaction open while `pg_dump
--snapshot` and the source-evidence reads use that same exported snapshot. The
identifier remains available only until the exporting transaction ends. Cluster-
global roles require their separately reviewed policy because `pg_dump` covers
one database. See the [PostgreSQL snapshot documentation](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
and [pg_dump reference](https://www.postgresql.org/docs/17/app-pgdump.html).

The shared query definitions in `scripts/postgres-restore-evidence-queries.mjs`
serve both the existing synchronous drill and
`scripts/postgres-restore-evidence-collector.mjs`. The asynchronous collector
uses one caller-owned query adapter and returns the complete validated source
evidence for the backup serializer. It does not connect to a database, acquire a
pooled connection, run pg_dump or publish an artifact.

Prepare the collector on an exclusively owned, idle connection before starting
the backup transaction. Preparation derives normalized expected view definitions
from the reviewed source queries, then rolls back its temporary objects. Those
definitions remain private to that collector. PostgreSQL forbids CREATE, ALTER
and DROP in a read-only transaction, so this preparation cannot be moved into the
exported snapshot or made legal by a savepoint. The existing synchronous view
collector retains its original behavior. [Transaction restrictions](https://www.postgresql.org/docs/17/sql-set-transaction.html).

Keep the same connection for preparation and collection. The adapter must enforce
query bounds and actual cancellation; the collector passes cancellation through
and awaits each started operation. It does not promise to stop a driver that
ignores the signal or to close a connection it does not own. Collection performs
read-only evidence queries without committing or rolling back the caller's
snapshot. It checks the same backend, database and principals, read-only
repeatable-read settings, snapshot and transaction identity before and after the
reads. PostgreSQL holds an exclusive virtual transaction lock until a transaction
ends; its identity distinguishes separate transactions even when their visible
snapshots match. [PostgreSQL lock view](https://www.postgresql.org/docs/17/view-pg-locks.html).
The backup operator still needs an owned, bounded connection and
qualified pg_dump process, with cleanup awaited on every outcome. Do not infer
snapshot provenance solely from a returned record or a caller-supplied identifier.

The connection-owner layer is now `openOwnedPostgresSession` in the database
package. It constructs one fresh `pg.Client` with a dedicated owned socket;
callers cannot provide a pool or preconnected client. Its bounded query adapter
uses public pg row events and closes the transport on cancellation or deadline.
Results are bounded after pg decodes each row; this is not a protocol-parser
memory limit. Verify-full TLS is the default. Disabled TLS requires a literal
loopback address, and URL query/fragment overrides and process-wide TLS bypass
are rejected. Driver errors are reported as bounded operation codes.

`scripts/postgres-backup-snapshot.mjs` provides
`withPostgresBackupSnapshot(options, consume)`. Supply `expectedOwner`, the
connection record returned by `normalizePostgresBackupConnection` and reviewed
operation bounds. The record contains credentials and explicit CA bytes; it belongs
in private process configuration, never an evidence file or command log. The function prepares the
unchanged collector on its newly idle connection, begins a read-only
repeatable-read transaction, exports its snapshot and collects the validated
source evidence. The awaited consumer receives `snapshotId`, canonical
`sourceEvidence` bytes and `signal`. The transaction stays open until that
consumer settles. Rollback and connection closure must finish before success;
primary and cleanup failure phases remain distinct even for falsey rejections.
A cancelled or closed session cannot be reused, and queries are serialized.

The default lifetime is five minutes, with an explicit maximum of one hour;
connect and query bounds default to five and fifteen seconds. Cleanup gets five
seconds before forcing transport closure and reporting a cleanup failure. Select
bounds that fit the reviewed operation and the current authorization window.
The consumer must await its owned work and honor cancellation. Arbitrary
JavaScript that ignores the signal cannot be terminated safely in-process.
The local operator below owns the pg_dump process and applies its independent
bounds; the snapshot wrapper alone does not run pg_dump or prove snapshot import. Synthetic
transport and session tests do not establish live driver, TLS, snapshot or
host-capacity qualification.

### Local dump and encrypted publication

Call `runPostgresBackup` from `scripts/postgres-backup.mjs` from a reviewed local
operator. Its configuration includes `connection: { connectionString, sslMode,
caCertificate }`, `expectedOwner`, `sourceRevision`, `deploymentTarget`, a new
`backupId` UUID, private `tmpfsRoot` and `outputDirectory`, `maxDumpBytes`,
`timeoutMs`, a distinct `postgres_backup` key ring and `tools` entries for
`pgDump` and `pgRestore`. Each tool entry contains its reviewed absolute path,
exact SHA-256 and exact PostgreSQL 17 version line. Both tools must have the same
minor version. These input bindings do not establish native binary provenance or
host qualification.

The operator normalizes connection fields once, then supplies that same frozen
record to the Node session and libpq environment. Verify-full requires an explicit
PEM CA bundle, limited to 64 KiB and sixteen CA certificates, and a DNS hostname.
Literal IPv4 and IPv6 addresses are rejected in verify-full mode because the
installed Node driver and libpq do not authenticate the same IP identity. Identical normalized
bytes go to `pg.ssl.ca` and the private libpq root-certificate file. Hostname and
certificate verification stay enabled, with TLS 1.2–1.3 selected for both clients.
Missing passwords, malformed escapes, control characters, multi-host/socket URLs,
query/fragment overrides and process-wide TLS disablement are rejected. Disabled
TLS is available only on literal loopback. The normalized record and key ring
contain secrets and must never be logged.

Child environments are built from an allowlist. The owned 0600 password file
escapes backslashes and colons; no password is passed in argv or `PGPASSWORD`.
Private HOME and explicit nonexistent client-certificate paths prevent ambient
client certificates. GSS encryption is disabled so it cannot supersede TLS.

Both placement roots must already exist as owner-private 0700 directories with
no symlinked or untrusted-writable path components. The plaintext root must also
report the Linux tmpfs filesystem type. The operator creates its own 0700
directory, exclusive 0600 password/CA files and exclusive 0600 dump. It preserves
the existing full custom dump flags (`--compress=9 --no-owner --no-privileges`)
and adds the actual exported snapshot ID. No table or data filters are applied.
The exporting transaction remains open while the bounded dump process and
streams settle.

After snapshot rollback and closure succeed, `pg_restore --list` must succeed
before encryption. Its output is capped at 8 MiB; discarded stderr is capped at
64 KiB. The dump limit is explicit and cannot exceed 2 GiB. The total operator
deadline is explicit and cannot exceed thirty minutes. A fixed supervisor runs
under the operator's current Node executable with the allowlisted environment,
without inherited Node options or a shell. It remains the process-group leader
until cleanup completes; its bounded IPC status distinguishes native exit from
intentional supervisor shutdown. Missing, malformed or duplicate status fails.
Cancellation sends TERM to this owned group, then KILL after two seconds even
when the native leader has already exited. Normal native completion also closes
the entire owned group. No signal is sent after the supervisor has been reaped.
The operator awaits child/stdio closure and checks Linux process-group state for
up to five seconds. Zombies are terminated processes whose parent still needs
to reap them; a live member after the observation bound is a cleanup failure.
Select bounds that fit the authorization window. An uninterruptible OS process
cannot be made safe by abandoning its promise, and supervisor shutdown is not
accepted without group cleanup. The current Node runtime also needs host and
native-runtime qualification.

The actual `EncryptedPostgresBackupStore` and `FileRawArtifactStore` publish a
local ciphertext artifact under the v2 immutable object key. Publication binds
actual dump size/hash, canonical same-snapshot evidence, source revision and
capture time. The operator awaits the dump read stream and plaintext-directory
cleanup before returning its bounded result. A duplicate or ambiguous
publication failure preserves any existing ciphertext and is never retried or
deleted automatically. Unlinking the tmpfs files is cleanup, not a claim of
physical erasure.

This layer does not provide an unattended service, choose a trusted host, publish
off-host, recover a target database or establish release readiness. Mocked driver
and protocol cases, bounded real synthetic leader/descendant cleanup regressions,
and a real local encryption round trip do not qualify real TLS, snapshot import,
representative capacity, native tools or recovery objectives.

The existing restore drill creates its own local dump. Its successful result does
not validate a downloaded off-host artifact. Deployment still requires the
collector, actual encrypted publication/download, a new isolated restore target,
the authority and erasure-replay checks below, and measured recovery objectives.
A library round trip or upload must never grant application readiness.

## Local authenticated restore operator

`runPostgresRestore` in `scripts/postgres-restore.mjs` consumes the encrypted
file artifact produced by the local backup operator. Its explicit inputs are
`expectedBackup` (backup UUID, source database, deployment target, revision,
snapshot and manifest SHA-256), `expectedOwner`, `keyRing`,
`artifactDirectory`, `tmpfsRoot`, `maintenanceConnection`,
`targetConnection`, `targetDatabase`, `connectAllowlist`,
`deniedRuntimePrincipals`, `tools: { pgRestore, psql }`,
`maxDumpBytes`, `timeoutMs` and optional `signal`. Each tool has an
absolute protected path, SHA-256 and exact PostgreSQL 17 patch-version string;
both versions must match. Those bindings do not qualify the native runtime.

Both connections use the backup normalizer. Host, port, TLS mode and explicit
CA must match; databases must differ. Verified TLS requires a DNS host because
the installed driver does not reliably verify literal IP identities. Plaintext
is allowed only for explicit loopback `127.0.0.1` or `::1`. No ambient
libpq settings or URL overrides are inherited. Credentials stay in owned
mode-0600 files below a verified private tmpfs directory.

Before any database creation, the operator authenticates the entire encrypted
artifact and validates its full source evidence against the independently
supplied expected owner. It refuses source/existing targets and creates only a
new `nutrition_restore_*` database from `template0`, initially with
`ALLOW_CONNECTIONS false`. It records the new OID, revokes PUBLIC CONNECT,
and runs the unchanged database owner, exact ACL, effective-login allowlist and
zero-session checks. The allowlist must already have effective access through
reviewed existing roles; this operator grants no maintenance privileges or role
memberships. Every named runtime principal must exist, be disjoint from the
allowlist and lack effective CONNECT, including inherited/superuser access.

After that boundary passes, the operator enables maintenance connections.
It feeds the authenticated `recovered.dump` stream to `pg_restore` with an
explicit validated `--dbname`, `--single-transaction`,
`--exit-on-error`, `--no-owner`, `--no-privileges` and `--role`.
The recovered stream's filesystem path contains the envelope frame and must
never be used as a dump filename. Shared process ownership counts the exact
authenticated input length, applies backpressure, awaits input/output closure,
and retains the existing pinned-supervisor group cleanup. A separate pinned
`psql -X` invocation applies the unchanged authority SQL with
`ON_ERROR_STOP=1`. Raw tool diagnostics are not returned.

An owned target session then collects the full current authority, ledger and
table evidence in a read-only repeatable-read transaction. It compares this to
the authenticated snapshot evidence, not today's source database. The same
production readiness predicate must reject the target's actual attestation
for a freshly generated restore epoch. Only the distinct stale-attestation
error is expected; malformed identity, SQL, transport or cleanup failures fail
the operation.

The operator closes target sessions before the final zero-session check,
disposes plaintext, removes owned credential files and keeps ciphertext.
On failure it retains the database. After owned activity settles, it re-fences
only a target whose recorded name and OID still match. Unknown CREATE outcomes,
identity replacement or failed re-fencing remain explicit cleanup failures;
there is no automatic DROP or unrelated session termination. Unlinking files
does not prove physical erasure.

A successful result is `local-restore-verified`, `localOnly: true`,
`erasureReplayRequired: true` and `applicationTrafficBlocked: true`.
Keep its fresh `restoreEpoch` for the existing external-ledger replay and
later API/worker configuration. This operation never writes an attestation,
grants runtime CONNECT, starts applications or performs cutover. Live restore,
native TLS/tools, actual identity isolation, external erasure replay, off-host
recovery, capacity, recovery objectives and independent release acceptance
remain required.

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
numeric-versus-string `100` parity plus migration-0022's authenticated
database-actor binding and the complete shared-food/outbox trigger
surface. The transactional repair policy
pins 54 function identities, 54 exact trigger bindings, the sixteen
authority-evidence column definitions, all nine authority CHECKs,
and the unique activation-to-batch index. Before creating a
dump, the drill requires the complete `public.app_schema_migration` names and
SHA-256s from every tracked migration file, ignoring any owner-schema shadow
ledger, and corroborates that ledger after restore. The drill then
compares a canonical source/target role, schema, type, table, sequence,
column-ACL, function, trigger, authority-constraint, and authority-index
fingerprint. It also
rechecks the exact target database owner, ACL, effective login allowlist, and session isolation immediately before
success. It leaves `PUBLIC CONNECT` revoked. If the policy, owner, fingerprint,
or target isolation differs, stop the rehearsal; do not improvise grants.

Do not interpolate an unreviewed variable into a delete/drop command. Cleanup of a
drill database is a separate approved action after evidence is retained.

Migration 0026 adds standalone day-note roots, immutable revisions and operation
receipts, plus the current export-completion inventory fence. Restore their full
schema and history using the complete forward migration set. A cleared note still
has retained history. For an owner covered by an authenticated erasure-ledger
record, replay must remove all three note families before restore readiness is
attested. Active owners' saved and cleared history remains intact. The existing
source/target authority fingerprint and exact ledger checks remain required.

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
   checks plus migration-0022's three session-bound public wrapper bodies and
   two actor-equality CHECKs; exact per-function ACLs, sixteen authority-evidence column definitions,
   all nine authority CHECKs, the unique
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
   functions are present and pinned after migrations 0019 through 0022.

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
   even when its table is outside `public`; all nine authority CHECKs, the sixteen
   authority-evidence columns, the unique activation-to-batch index, safe roles,
   and memberships. The policy, evidence, canary, and CLI report use schema
   version 6. The effective-login allowlist and seven isolated verifier sessions
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
   direct non-owner DML. Migrations 0019 through 0022 grant execute only to
   unassigned `NOLOGIN` workflow capabilities and grant no table, column, or sequence
   privilege. Keep runtime cutover blocked until independently operated
   stage/validate callers, external-principal binding, any remaining
   fixed-purpose writer profiles, and representative-scale evidence exist and
   target positive and negative role canaries exercise the complete boundary.
   Migration 0022 proves database-session audit binding, not external identity
   verification, live identity separation, or caller operation.

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
   fingerprint schema is version 16. It binds exact public-column ACL rows, the
   sixteen authority-evidence column definitions, all nine authority CHECKs, the unique
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
