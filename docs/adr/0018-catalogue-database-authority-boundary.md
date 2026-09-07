# ADR 0018: Catalogue database-authority boundary

- Status: Accepted for bounded EXPAND and DEPLOY-0 source verification; live
  identity provisioning, DEPLOY, and CONTRACT remain blocked
- Date: 2026-09-05

## Context

The catalogue workflow persists strong evidence: a staged batch binds its
artifact and release provenance, validation freezes digest-bound evidence, three
independent approval classes precede promotion, and activation is atomic. Those
workflow states do not by themselves establish database authority. The API,
worker, ingestion CLI, migration process, and PostgreSQL bootstrap currently use
an owner-capable application identity in local and production-like Compose
configuration. A principal with direct table DML can therefore manufacture the
same row sequence that a reviewed workflow would create.

An authority string supplied by a caller is descriptive evidence, not database
authentication. PostgreSQL must derive the database principal and its permitted
capability from the authenticated session. The boundary must also survive
logical restore: `pg_dump`/`pg_restore --no-owner --no-privileges` intentionally
does not preserve object owners or ACLs, and database roles are cluster-global
objects that are not included in a per-database dump.

The catalogue tables share food, barcode, outbox, and private/custom-food
workflows. A blanket table revoke or immediate owner-credential replacement
would break supported application paths. The change therefore needs an
expand/deploy/contract sequence with explicit compatibility and fail-closed
readiness gates.

## Decision

The EXPAND phase establishes seven static PostgreSQL capability roles:

- `nutrition_catalogue_stage`
- `nutrition_catalogue_validate`
- `nutrition_catalogue_approve_data`
- `nutrition_catalogue_approve_quality`
- `nutrition_catalogue_approve_rights`
- `nutrition_catalogue_promote_activate`
- `nutrition_catalogue_rollback`

They are `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`. Existing incompatible roles with one of
these names are a migration failure, not something the migration silently
alters. Login identities and membership are deployment concerns and are not
created by the application migration.

At the migration-0014 boundary, this first phase placed only reviewer approval behind a narrow
`SECURITY DEFINER` function. The migration pins its trusted per-schema
`search_path` to `pg_catalog`, the captured application schema, and `pg_temp` in
that order; caller and temporary-schema paths cannot redirect relation lookup.
The function is not executable by `PUBLIC`; non-owner execution is granted only
to the matching data, quality, or rights capability role. It derives the login
identity from `session_user`, requires exactly one reviewer capability, and
requires that capability to match the requested approval class. It locks and
checks the batch, binds the approval to the batch's frozen validation and rights
digests, preserves exact idempotent replay, and rejects a divergent replay.
Persisted audit evidence records the database login principal and capability
role; those values are database-derived rather than accepted from the caller.

At the migration-0015 boundary, database-audit fields on new or changed
activation-history rows remained constrained to a paired `NULL` state. Stage,
validation, promotion, activation, and rollback could not claim database-derived
authority until their own reviewed wrappers existed. Migration 0019 later
replaced that temporary fence for its fixed-purpose promotion/rollback functions.
The forward 0015 hardening also detects any pre-existing ordinary or admin
membership in the capability roles and any paired non-NULL activation-authority
evidence accepted by 0014. It installs the stricter activation constraint as
`NOT VALID`, so new forged rows are rejected without letting legacy rows roll
back the ACL correction. It first normalizes the approval function to an
owner-only EXECUTE ACL and grants the three reviewer roles only when neither
unsafe condition exists. Independently, it validates the constraint whenever no
legacy paired non-NULL activation-authority evidence exists; capability
membership alone therefore leaves reviewer execution disabled but does not keep
the constraint unvalidated. Either unsafe condition blocks complete readiness
through its corresponding ACL, membership, or constraint evidence. Cleanup
alone does not enable the boundary; repair and enablement require a new reviewed
forward policy.

Forward migration 0016 hardens the existing food-source eligibility projection
call chain before any non-owner catalogue DML is introduced. It fails closed
unless the two application-schema `SECURITY INVOKER` functions retain their
exact owner, body, executable metadata, default ACL, and unconfigured pre-state,
and unless the ordinary enabled `food_source` trigger is bound to the exact
application-schema trigger function and definition. It then pins both functions'
`search_path` to `pg_catalog`, the captured application schema, and `pg_temp`
without changing their bodies, owners, ACLs, or invoker semantics and without
granting any authority. At the 0016 boundary this closed only the `food_source`
source-eligibility path; `enqueue_food_search_food_eligibility_change`,
`enqueue_food_search_serving_insert`, `enqueue_food_search_barcode_insert`, and
`enqueue_food_search_barcode_update` still resolved their own unqualified
relations and revision-function call through the caller's ambient path and
required the subsequent 0017 attestation.

Forward migration 0017 completes that bounded namespace hardening for the four
remaining food-search outbox paths. It fails closed unless
`enqueue_food_search_food_eligibility_change`,
`enqueue_food_search_serving_insert`, `enqueue_food_search_barcode_insert`, and
`enqueue_food_search_barcode_update` retain their exact application-schema
identity, owner, body, executable metadata, default ACL, unconfigured pre-state,
and `SECURITY INVOKER` status, and unless their four ordinary enabled statement
triggers retain the exact application-schema bindings and definitions. It then
pins only their function-local `search_path` to `pg_catalog`, the captured
application schema, and `pg_temp`. It changes no function body, owner, ACL,
invoker status, table, or trigger and grants no privilege. This prevents an
ambient caller or temporary schema from redirecting those trigger-side relation
and revision-function lookups; it does not authorize direct non-owner DML.
Fixed-purpose shared-table wrappers and a database-enforced writer/reader lock
protocol remain prerequisites to runtime privilege profiles and caller cutover.

Forward migration 0018 closes the active-nutrient-registry lock prerequisite
without introducing a runtime role or elevated function. It attests the exact
pre-migration writer and recipe-reconciliation functions plus their seven
trigger bindings, creates a default-ACL `SECURITY INVOKER` shared-reader helper,
replaces the recipe reconciler's broad table lock with that helper, and pins all
four function search paths. The writer trigger now covers insert, every update,
and delete, so changes to activation, display metadata, units, dimensions, or
row existence serialize against diary, recipe, goal, custom-food, and catalogue
materialization readers. Application readers use the same shared advisory key,
and promotion acquires it after the per-source lock. Fixed-purpose shared-food
and workflow wrappers were still required at that boundary.

Forward migration 0019 closes the promotion/rollback portion of that wrapper
prerequisite without performing a deployment cutover. Validation now freezes
the exact canonical materialization document and SHA-256 for each valid record,
contract version 1, and the complete active nutrient-mapping revision set before
any approval. Identifier-only promotion and rollback `SECURITY DEFINER`
functions consume that frozen evidence; no caller can submit materialization
JSON, write shared tables directly, or supply database audit identity. A pinned
activation guard derives principal and capability from `session_user`.
Capability-mediated promotion requires three distinct database-authenticated
reviewers, while owner/local compatibility retains paired null audit fields.
Promotion preserves batch, source, per-source advisory, then shared registry
lock order. The roles remain `NOLOGIN` and unassigned, so source availability
does not authorize live identities or calls.

Forward migration 0020 closes the fixed-purpose stage/validate portion of the
wrapper prerequisite without assigning a login or performing caller cutover.
Three stage functions create or exactly resume a pre-registered source attempt,
append an atomic contiguous chunk of at most 250 records with its durable
checkpoint, and persist immutable parser evidence. A batch is capped at 10,000
records and 64 MiB of stored canonical-payload JSON. The last stage operation
records a database-computed seal over provenance, the full parser evidence, the
exact stage checkpoint, the complete ordered record set, and the active
nutrient-mapping revisions. After sealing,
guards reject record insertion, stage-checkpoint mutation, and audit/seal
rewrites. A validate-only observation function exposes the bounded sealed input,
and a validate-only finalizer accepts only that exact observation and seal. The
observation response and validation request are each capped at 128 MiB. Both
recompute the seal under the established source and nutrient-registry lock order,
and validation must use a different authenticated database login from staging.
The functions derive principals and capabilities from `session_user`; callers
cannot submit those audit fields. The stage and validate roles receive only
schema `USAGE` and exact function `EXECUTE`, never table, column, or sequence
privileges. Six nullable audit/seal columns preserve owner/local and historical
compatibility. Both capability roles remain `NOLOGIN` and unassigned.

Forward migration 0021 closes that validator-document nutrient-semantic trust
gap without assigning a login or performing caller cutover. PostgreSQL now
independently reconstructs the exact 100-gram nutrient result from every sealed
canonical payload and its reviewed mapping revision, then requires an exact
match to the frozen food document. Contract-version-1 SHA-256 attestations are
frozen on each classified record and the batch. Known conversions, known zero,
trace, unknown/omitted nutrients, duplicate handling, mapping identity, and the
exact 100-gram basis are part of the database check. Approval, promotion, and
rollback to a non-null release fail closed unless the complete record set and
batch are attested. Deactivation remains possible with a null target.
Nutrition text is normalized to NFC, trimmed and collapsed with the exact
ECMAScript whitespace set, and bounded in JavaScript UTF-16 code units. A JSON
number equal to `100`, including `100.0`, is valid; a string must be exactly
`"100"`.

Migration 0021 refuses a pre-existing `ready` or `promoting` batch instead of
fabricating evidence. Historical unattested completed releases remain
representable and an existing active pointer may remain, but the release is
inert: it cannot be newly approved, promoted, represented as semantically
attested, or selected as a rollback target. Independent validator execution,
caller profiles, credentials, external-principal binding, and cutover evidence
remain required before live catalogue ingestion is authorized. Direct
schema-owner SQL remains trusted during EXPAND. The hard limits are safety
ceilings, not representative full-catalogue scale evidence; a bounded, paged
production protocol and measured memory, disk, lock, timeout, and retry budgets
remain open.

Forward migration 0022 binds capability-mediated audit labels to PostgreSQL's
authenticated session identity. The public approval, promotion, and rollback
signatures remain compatible, but for a non-owner session their descriptive
principal argument is ignored and the owner-only implementation receives
`session_user`. The approval and activation authority CHECKs require the stored
label to equal `database_principal`, and migration preflight refuses ambiguous
historical rows rather than rewriting them. Owner/local calls retain a supplied
label with paired-null database authority. This closes database-audit
misattribution only; it does not verify an external OIDC/workload assertion,
provision a login, assign a capability, or perform caller cutover.

The supported protocol is deliberately narrower than arbitrary owner SQL:
application transactions take the shared lock before entering the affected
read/write chain. Direct owner recipe DML is unsupported because its row and
foreign-key locks can precede the deferred reconciler. `TRUNCATE nutrient` and
nutrient DDL are also outside the trigger protocol because PostgreSQL can take a
table lock before firing a statement trigger. Maintenance must quiesce runtime
callers and acquire the exclusive advisory key before any such table-locking
statement. Generic recipe or truncate triggers must not be used as a shortcut;
safe non-owner access requires the fixed-purpose wrappers and reviewed lock
ordering described below.

### Bounded DEPLOY-0 policy and canary contract

This ADR also accepts a bounded DEPLOY-0 source verifier for a canonical,
credential-free reviewer-login policy. The implementation parses the policy,
requires the exact `public.app_schema_migration` names and SHA-256s from the
tracked migration files, checks the authority structure, and runs zero-write
canaries through seven isolated database sessions. It does not provision a
login, issue a credential, change a membership, deploy anything, or authorize a
live deployment.

The deployment policy names deployment login and capability-role identifiers
and their expected membership, but it contains no password, token, private-key
material, connection URL, or private identity-provider claim. It is exact,
canonical JSON with one trailing newline and must remain under an ignored,
mode-0600 `.local-data` path. Credentials and the externally authenticated
principal-to-login binding remain outside Git and must be short-lived or
otherwise separately reviewed. Connection URLs are supplied only through the
seven dedicated environment variables and are never emitted by the verifier.
The canonical schema is `public`, owned by `pg_database_owner`.

Only the three reviewer logins may receive capability membership in this
bounded policy. Each must be a safe PostgreSQL login (`LOGIN`, `INHERIT`,
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and
`NOBYPASSRLS`), have no owned database objects, and have exactly one outgoing
membership: its matching data, quality, or rights reviewer capability. On
PostgreSQL 17 that membership must be represented by `ADMIN FALSE`,
`INHERIT TRUE`, and `SET FALSE`. The reviewer must have no direct catalogue table or
sequence DML and no `CREATE` privilege on the application schema. The seven
capability roles remain safe `NOLOGIN` roles with no owned objects and no
outgoing memberships. Stage, validate, promotion, and rollback now have
fixed-purpose functions but no deployed caller. All four capabilities retain
zero incoming memberships in DEPLOY-0. No
application migration creates production logins or grants these deployment
memberships.

The verifier requires `public` to be the only non-system schema and checks its
exact ACLs, grantors, and `pg_database_owner` ownership; the exact database ACL;
relation, type, default, and column ACL state; required owners; all nine
authority CHECKs; the sixteen pinned authority-evidence columns; the unique
activation-to-batch index; all 54 authority function signatures,
executable semantics, source hash, exact per-function ACL, and expected
configuration;
every other public routine for unsafe ownership, explicit ACL, or
`SECURITY DEFINER`; and the exact 54-trigger authority set across the
complete protected shared-food/outbox surface, including each trigger's table
and function schema. Every binding of a dedicated public authority trigger
function enters the evidence even when its table is outside `public`. It also checks the
exact effective login allowlist, revoked `PUBLIC CONNECT`, safe role and login attributes, zero owned
objects, the complete touched membership graph, effective table/column/sequence
privileges, and exactly seven expected backend identities with no other client
session in the target database. The migration ledger must match source before
this evidence is collected.

The canaries are intentionally zero-write. A matching reviewer calls
`catalogue_record_import_approval` with valid-shaped input and a nonexistent
batch UUID and must reach SQLSTATE `23503`, proving authorization was accepted
before the function's unknown-batch outcome without creating data. A mismatched
reviewer must reach `42501` before batch lookup. An unassigned login and the API
and worker logins must reach `42501` at the function `EXECUTE` boundary. A
non-executing `EXPLAIN INSERT` proves direct reviewer approval-table DML is
denied with `42501` without consuming an identity value. The canonical stable
structure projection and approval row count must be identical before and after.
Volatile backend PIDs are excluded from that projection; the projection is
retained with its SHA-256 so a reviewer can recompute the digest independently.
The exact membership graph rejects a multi-capability deployment before canaries;
the separate authority-boundary integration test continues to prove that a
transient multi-capability reviewer fails closed. Canary output contains no
credentials, connection strings, tokens, or row payloads.

TLS verification defaults to `verify-full`. `disable` is accepted only when all
seven URLs use literal `127.0.0.1` or `::1`; URL query parameters and fragments,
non-PostgreSQL schemes, and `NODE_TLS_REJECT_UNAUTHORIZED=0` are rejected. The
verifier closes every connection successfully before exclusively creating and
syncing a new mode-0600 evidence file under `.local-data`; it refuses overwrite
and removes an incomplete file on failure.

The logical-restore fingerprint continues to require zero capability
memberships. A restored database remains fenced while restore policy is
reapplied and verified. Only a separate reviewed deploy procedure may then
establish the policy's memberships and run the deploy fingerprint and
zero-write canaries. DEPLOY-0 does not weaken or replace restore readiness.

The pre-existing owner/local path remains temporarily compatible during EXPAND.
An owner may record an approval through the same function without a deployed
capability membership, and its new database-principal audit fields remain null.
Existing rows are also left null. The migration never invents historical
database actors or capability grants.

The deployment policy, evidence, canary, and CLI report use schema version 6.
This decision does not yet authorize live catalogue work. The following remain
required before database authority can be considered closed:

1. Any remaining fixed-purpose recipe/shared-food writers needed to remove the
   API/worker need for unrelated table mutation privilege. Migrations 0019
   through 0022 supply promotion/rollback, stage/validate, independent
   database semantic-attestation functions but do not deploy their callers.
2. Deployment-specific login identities, short-lived or otherwise reviewed
   credentials, and an externally authenticated principal-to-login binding.
3. API, worker, ingestion, migration, backup, and restore credential separation,
   followed by caller cutover to the functions.
4. CONTRACT-phase revocation of direct catalogue DML and owner-capable runtime
   credentials after compatibility evidence passes.
5. An ordinary-deploy readiness fingerprint and positive and negative role
   canaries. The isolated restore drill pins the migration-0014 function/trigger
   manifest, the forward migration-0015 interim activation constraint and corrected
   ACL, and migration-0016's two food-search function search paths plus exact
   source-eligibility trigger plus migration-0017's four function search paths
   and exact food/serving/barcode trigger bindings plus migration-0018's four
   nutrient-lock functions and seven trigger bindings plus migration-0019's
   frozen materialization and promotion/rollback authority boundary plus
   migration-0020's sealed stage/validate boundary plus migration-0021's exact
   100-gram semantic attestation, but it does not
   substitute for deployed login separation or canaries through those real
   identities.

The bounded DEPLOY-0 implementation defines and locally proves the required
policy, structural evidence, and canary behavior for item 5. It does not satisfy
the live part of that item until separately reviewed deployment identities prove
the same result in the target environment. Live DEPLOY and CONTRACT remain
blocked by all applicable items above.

The migration is forward-only. Recovery uses a new reviewed migration; it does
not drop or recreate authority evidence in place.

## Consequences

- Staging, validation, reviewer approval, promotion, and rollback can be tested
  through fixed-purpose database-authenticated boundaries without claiming that
  runtime identity separation or caller cutover is complete.
- Static capability names make deployment, restore, and evidence expectations
  reviewable, while cluster login creation and secrets stay outside migrations.
- DEPLOY-0 now has a reviewable credential-free policy, structural verifier,
  strict local CLI, and zero-write canary runner without implying that any live
  identity or deployment exists.
- Owner/local compatibility prevents an unsafe all-at-once cutover, but it also
  means direct owner DML remains trusted during EXPAND and live M0B remains
  blocked.
- Logical restore runs under an explicit expected owner, reapplies the pinned
  migration-0014 function/trigger, migration-0015 approval/guard ACL
  corrections, and
  migration-0016 and migration-0017 food-search function/trigger policies plus
  migration-0018's nutrient lock protocol plus migration-0019's frozen
  materialization, replacement activation-authority constraint, and
  promotion/rollback boundary plus migration-0020's stage/validate functions,
  immutable staging seal, audit columns, constraints, and guards, and
  migration-0021's independent exact-100-gram semantic attestation, and
  migration-0022's authenticated database-actor binding. The repair policy pins
  54 function identities, 54 exact trigger bindings, the sixteen
  authority-evidence columns, all nine authority CHECKs, and the unique
  activation-to-batch index; the canonical fingerprint
  covers that same full authority set. It
  requires the exact tracked filename/file-byte-SHA ledger from
  `public.app_schema_migration` before `pg_dump`, then version-13 canonical
  authority-fingerprint parity including column ACL state, the frozen-evidence
  column definitions, the authority index, and each trigger's table schema while
  `PUBLIC CONNECT` remains revoked. Public-table triggers and
  every cross-schema binding of a dedicated public authority trigger function
  enter that fingerprint. An owner-schema shadow and migration-ledger parity
  alone are not sufficient readiness evidence.
- Nullable audit fields accurately distinguish pre-boundary or owner-compatible
  rows from approvals authenticated by a non-owner database principal.

## Alternatives rejected

- Caller-supplied principal names, custom session settings, or
  `application_name` do not authenticate an actor.
- A single ingestion service role would retain the ability to self-stage,
  self-review, promote, and roll back.
- Granting reviewer roles direct table DML would reproduce the original trust
  gap.
- Immediate broad revocation is unsafe while catalogue and private workflows
  share tables and callers still use ambient `DATABASE_URL` authority.
- Treating `--no-owner --no-privileges` restore as ready would silently move
  ownership to the restore executor and omit required ACLs.

## Review triggers

Revisit this ADR before adding any remaining workflow function; issuing or
federating a production login; changing role membership or inheritance; splitting
promotion from activation; adding row-level security; changing shared-table
ownership; performing a deploy or CONTRACT cutover; or changing the backup,
restore, readiness-fingerprint, or role-canary policy.
