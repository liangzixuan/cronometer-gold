# ADR 0018: Catalogue database-authority boundary

- Status: Accepted for bounded EXPAND implementation; deploy and CONTRACT
  phases remain blocked
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

The migration is forward-only. Recovery uses a new reviewed migration; it does
not drop or recreate authority evidence in place.

## Consequences

- Reviewer approval can be tested against a database-authenticated boundary
  without claiming that the remaining catalogue workflow is isolated.
- Static capability names make deployment, restore, and evidence expectations
  reviewable, while cluster login creation and secrets stay outside migrations.
- Owner/local compatibility prevents an unsafe all-at-once cutover, but it also
  means direct owner DML remains trusted during EXPAND and live M0B remains
  blocked.
- Logical restore runs under an explicit expected owner, reapplies the pinned
  migration-0014 function/trigger and migration-0015 constraint/ACL policy, and
  requires canonical authority-fingerprint parity while `PUBLIC CONNECT`
  remains revoked. Migration-ledger parity alone is not sufficient readiness
  evidence.
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
