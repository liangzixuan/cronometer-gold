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

This first phase places only reviewer approval behind a narrow
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

The database-audit fields on new or changed activation-history rows remain
constrained to a paired `NULL` state during EXPAND. Stage, validation, promotion,
activation, and rollback cannot claim database-derived authority until their own
reviewed wrappers exist.
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
outgoing memberships. Stage, validate, promote/activate, and rollback
capabilities must retain zero incoming memberships until their reviewed
functions and callers exist. No application migration creates production
logins or grants these deployment memberships.

The verifier requires `public` to be the only non-system schema and checks its
exact ACLs, grantors, and `pg_database_owner` ownership; the exact database ACL;
relation, type, default, and column ACL state; required owners; the versioned
activation constraint; all 17 authority function signatures, executable semantics, source
hashes, ACLs, and expected configuration; every other public routine for unsafe
ownership, explicit ACL, or `SECURITY DEFINER`; and the exact 20-trigger set on
the six protected catalogue tables. It also checks the exact effective login
allowlist, revoked `PUBLIC CONNECT`, safe role and login attributes, zero owned
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

This decision does not yet authorize live catalogue work. The following remain
required before database authority can be considered closed:

1. Narrow stage, validate, promote-and-activate, and rollback functions that
   preserve the existing transactional and shared-table invariants.
2. Deployment-specific login identities, short-lived or otherwise reviewed
   credentials, and an externally authenticated principal-to-login binding.
3. API, worker, ingestion, migration, backup, and restore credential separation,
   followed by caller cutover to the functions.
4. CONTRACT-phase revocation of direct catalogue DML and owner-capable runtime
   credentials after compatibility evidence passes.
5. An ordinary-deploy readiness fingerprint and positive and negative role
   canaries. The isolated restore drill pins the migration-0014 function/trigger
   manifest and the forward migration-0015 activation-null constraint and
   corrected ACL, but it does not substitute for deployed login separation or
   canaries through those real identities.

The bounded DEPLOY-0 implementation defines and locally proves the required
policy, structural evidence, and canary behavior for item 5. It does not satisfy
the live part of that item until separately reviewed deployment identities prove
the same result in the target environment. Live DEPLOY and CONTRACT remain
blocked by all applicable items above.

The migration is forward-only. Recovery uses a new reviewed migration; it does
not drop or recreate authority evidence in place.

## Consequences

- Reviewer approval can be tested against a database-authenticated boundary
  without claiming that the remaining catalogue workflow is isolated.
- Static capability names make deployment, restore, and evidence expectations
  reviewable, while cluster login creation and secrets stay outside migrations.
- DEPLOY-0 now has a reviewable credential-free policy, structural verifier,
  strict local CLI, and zero-write canary runner without implying that any live
  identity or deployment exists.
- Owner/local compatibility prevents an unsafe all-at-once cutover, but it also
  means direct owner DML remains trusted during EXPAND and live M0B remains
  blocked.
- Logical restore runs under an explicit expected owner, reapplies the pinned
  migration-0014 function/trigger and migration-0015 constraint/ACL policy, and
  requires the exact tracked filename/file-byte-SHA ledger from
  `public.app_schema_migration` before `pg_dump`, then version-6 canonical
  authority-fingerprint parity including column ACL state while `PUBLIC
  CONNECT` remains revoked. An owner-schema shadow and migration-ledger parity
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
