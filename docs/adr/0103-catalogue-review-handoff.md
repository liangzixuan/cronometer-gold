# ADR 0103: Reconcile capability validation and submit restricted reviewer decisions

Status: Source and bounded local proof complete. Independent review, focused
checks, pre-service canonical check/build and the approved PostgreSQL rehearsal
passed. Delivery requires final canonical gates and exact-commit automatic proof.
All six beta exits remain open.

## Context

[ADR 0102](0102-fdc-csv-independent-validation.md) is delivered at `af65b98`
with all three CI and nine actual container jobs successful on attempt one.
Its validation digest includes the original PostgreSQL observation hash. The
owner-oriented reconciliation path rebuilds a digest without that field and
therefore rejects the independently validated candidate. Supplying the legacy
digest instead would disconnect the report from the committed validation.

The existing approval wrapper also reads and locks workflow tables before calling
SQL. A reviewer login with only its designated capability cannot use that wrapper.
These are downstream consumer gaps in checklist C1's bounded catalogue workflow.

## Decision

Reconciliation accepts the retained ADR0102 request with explicit whole-file
SHA-256 and byte-size pins. The CLI uses the same private-file reader and strict
canonical decoder as submission, checks the requested batch and validation digest
before connecting, and passes the original request to the read-only transaction.
All three file options must be present together. A legacy candidate keeps its
existing input path.

For a capability candidate, verify the request against the committed digest,
staging seal and validator identity, then compare its provenance, parser evidence,
policy, mapping revisions, ordered record results, issues and frozen food documents
with the database and current semantic recomputation. Preserve the original opaque
observation hash; do not replace it with a fresh observation or claim that a client
serializer reproduces PostgreSQL JSONB text. A missing request, changed file or
binding, stale mapping or changed materialization fails closed. The resulting
digest must match both the explicit caller pin and the stored batch digest.

Existing current-release provenance, approval, count and materialized-food checks
remain. Also bind the current release's validation-summary digest to its completed
batch digest. Baseline verification uses frozen evidence and does not reconstruct
the historical observation, so it needs no second retained request.

Add `catalogue submit-approval` for an explicit batch, data/quality/rights role,
rights-manifest and validation digests, database principal and approval reference.
The consumer requires a real non-owner, non-privileged login with exactly the
requested catalogue reviewer capability and no effective-role change. The explicit
principal must equal the actual session principal. It invokes only the public
`catalogue_record_import_approval` authority; it has no owner fallback or direct
workflow table access.

SQL retains authenticated actor binding, current live-reviewed evidence, ready
state, digest checks, nutrition semantic recheck and immutable approval replay.
An exact retry returns `wasAlreadyApproved: true`; a changed decision fails. The
CLI reports success after required connection cleanup. Preserve the exact command
if acknowledgement or output is uncertain. This command records one decision and
does not promote or activate a release. It does not appoint the caller to an
independent reviewer role or make a synthetic identity a real external identity.

## Scope and proof

There are no migrations, grants, SQL authority or cap changes. The retained request
has ADR0102's existing bounds. Reconciliation still holds a bounded snapshot in
memory and still needs its existing read-capable database connection. Full-scale
paging, restricted reconciliation access, external identity/caller cutover, target
canaries, live catalogue evidence and release acceptance remain separate work.

Independent review, 244 focused offline cases, affected types and scoped Biome
passed. The tests reproduce the original mismatch, preserve legacy candidate and
baseline behavior, and reject changed retained evidence, baseline digest drift and
unsafe reviewer authority. They also cover exact requests, cleanup, receipt failures
and replay. Pre-service canonical check/build passed. Delivery requires final
canonical gates and exact-commit automatic proof.

The separately approved PostgreSQL rehearsal passed on its first attempt on
September 21, 2026, at 03:23:17.239362-03:23:32.328412 UTC. Five cases executed,
zero skipped: four repeated offline fixture cases and one actual database case.
The bounded stage, independent validation, reconciliation and three-reviewer
handoff passed, including denied direct access, wrong/owner/multiple roles,
spoofed identity, changed decisions, exact uncertain-response replay and unchanged
active state after approval. The fixture-nonrelease rejection stayed intact.
Positive approvals used separately constructed synthetic live-reviewed evidence;
the explicitly approved disposable-database promotion then provided a capability
baseline for a subsequent candidate. No fixture batch was relabelled and no SQL
check was weakened. No live data, hosted target or release decision was involved.

Owned resources were removed and service shutdown passed. [Current
readiness](../quality/current-readiness.md) records the log, hash and cleanup
evidence. ADR0102's earlier service approval and this completed ADR0103 session
are consumed; neither authorizes another session. Failed attempts and earlier
opt-in skips remain recorded as such. This proof does not close C1, C2 or any beta
exit.

## Alternatives and review triggers

Reusing the owner digest cannot identify the committed capability validation.
Granting reviewer table access would expand authority without solving the missing
consumer. Keeping the original request and calling the existing SQL approval
function preserves both boundaries without a migration.

Revisit this decision for new request formats, paging or larger limits, changed
SQL replay/state rules, restricted reconciliation access, target credential
cutover or a change to the required independent review scopes.
