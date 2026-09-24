# ADR 0105: Publish reviewed V2 catalogue batches with atomic visibility

Status: Source implementation and independent review complete; offline checks
and the separately approved 251-record PostgreSQL rehearsal passed. Attempt 2
passed all 12 cases after the reviewed transaction-ownership correction.
Attempt 1's authority failure remains recorded. Final delivery checks and
exact-commit automatic evidence remain pending. All six beta exits stay open.

## Context

ADR0104 prepares, validates and reconciles admitted V2 batches in bounded pages,
then binds three distinct reviewer decisions to exact retained evidence. Its legacy
consumer fences deliberately reject publication. The existing public food view,
barcode lookup, diary and recipe selection depend on current food pointers and
completed materialization evidence, so changing only a source-release pointer
cannot publish V2 safely.

## Decision

Test bounded off-current materialization followed by the existing style of atomic
food-pointer and barcode cutover. Cover rollback, public eligibility and using the
published V2 release as the next reconciliation baseline in the same package.
Do not copy V2 evidence into legacy validation columns or remove V1 consumer fences.

The publisher begins a separate, immutable lineage while the original reviewed
validation context is current. Bind the admission, seal, validation terminal,
reconciliation terminal, provenance, frozen mappings, baseline and all required
authenticated reviewer decisions. Original validation context and hashes remain
immutable. Publication's own inactive writes advance the dependency generation;
each request must prove continuity, serialize its check and writes, and record only
its own transaction's resulting generation. Unrelated changes, including changes
away and back, invalidate progress. Never suppress generation triggers, rebase a
stale context or accept a caller-selected generation.

Retain each exact private page request before mutation. SQL consumes only frozen
validated records and creates bounded immutable off-current versions, nutrients
and servings. Current pointers, archival flags, barcode assignments and source
activation remain unchanged until the terminal transaction. Page receipts,
counters, abandoned state and retained evidence obey explicit admission budgets.
Changed, skipped, overlapping, reordered or tampered requests fail. Lost responses
require explicit replay of the original request and verification of its receipt.

A bounded finalization pass attests persisted materialization, complete coverage
and exact accounting. The final transaction rechecks current authority, provenance,
review decisions, dependency generation, baseline and barcode conflicts, then
atomically changes the intended source's pointers, archival state, barcodes,
activation audit and deduplicated outbox event. Failure rolls all visibility
changes back. A replay cannot reactivate a superseded release.

The shared public eligibility contract must recognize complete V2 publication
without fabricating completed V1 evidence. Partial work stays invisible. Preserve
private/custom-food behavior, historical diary and recipe snapshots, nutrient
missingness and stale-version rejection. Rollback and deactivation retain their
restricted authority, history and cross-source barcode checks. Define and test
supported V1/V2 transitions and successor baselines explicitly.

Search preparation and rebuild evidence must bind candidate/current identities,
projection revisions and authoritative hydration. An unexecuted index benchmark,
SQL activation or unit test does not establish search or alias-switch acceptance.
Update authority, restore and privacy inventories alongside the source change.

## Resource decision and stop condition

The final cutover remains O(N) in affected source food/barcode rows. Measure both
candidate and prior baseline, removals, barcode replacement, generation triggers,
audit/outbox and transaction/WAL cost. Do not call the operation metadata only or
constant time. Enforce the existing two-second lock and thirty-second statement
timeouts and separately reviewed workload budgets. No limit increase follows from
an unsuccessful run.

If atomic cutover cannot fit the accepted envelope, preserve the failed evidence
and stop this approach. A release-scoped reader/barcode redesign then needs its
own coherent review of all consumers, writers, rollback and baselines. Synthetic
proof cannot establish resource acceptance for the unacquired full USDA candidate.

## Acceptance and execution

Before expensive final checks, independently review state transitions, SQL authority,
lock order, generation continuity, privacy and consumer seams. Prove focused
regressions for interrupted invisibility, exact replay/restart, tampering, expiry,
wrong/multiple roles, distinct reviewers, dependency drift, late barcode conflicts,
rollback, V2 successor baselines and legacy/private/historical compatibility.

A separately approved synthetic service rehearsal starts with one complete
251-record multi-page lifecycle using the production adapters and retained-request
helpers. It includes restricted logins, publication visibility, exact replay,
rollback, successor baselines and authority/restore verification. This small run
does not establish a publication memory limit or full-candidate capacity. Larger
workloads require a subsequent reviewed resource proposal that measures process
memory, transaction/lock and storage cost through its defined cleanup scope.
Earlier failed results remain evidence.

Required final source checks, canonical check/build, explicit-file normal commit
and non-force push, and exact-commit automatic CI/container jobs remain necessary.
Real services, acquisition/storage, target credentials/cutover and live activation
require their concrete action-specific approvals. This source package grants none.

## Rehearsal checkpoint: September 24, 2026 UTC

Attempt 1 used the reviewed source in `reviewed-source-final-01.json` at base
`38167263b3050b4aec0746b8577a5c6eb365750e`; its source manifest SHA-256 is
`8f4f53428effda9bfbffec934ef902eb12027705f3e82ff25adb37e456c64a54`.
The 251-record publication lifecycle passed from 00:24:43 to 00:24:57 UTC.
The canaries ran from 00:25:00 to 00:25:03 UTC: restore and nine endpoint fixtures
passed; authority verification failed. Total: 12 executed, 11 passed, one failed,
zero skipped. Owned-resource cleanup completed at 00:25:09 UTC. Preserve this
failed attempt and its original source identity after any correction.

The authority failure exposed a production helper that began and committed an
inner transaction while its caller owned a manually begun transaction. That
commit reset the caller's local `search_path`; schema-qualified foreign-key
renderings were the symptom. The correction addresses transaction ownership and
the affected caller/tests. Exact policy assertions remain intact. Independent
review and 273 focused cases, database types and scoped formatting checks passed.
Two new ownership regressions failed before the fix; their failures remain recorded.

The user separately approved attempt 2 on the corrected source. It ran from
01:16:26.476771 to 01:17:03.644326 UTC and passed all 12 executed cases: the
251-record publication lifecycle, authority and restore canaries, and nine
endpoint fixtures. There were zero failures or skips. Owned-resource cleanup
completed at 01:17:04.799030 UTC without failures. The engine was empty; Docker
service/socket and containerd were inactive and disabled, the socket was
unavailable and permanent group membership was unchanged.

Attempt 2 used `reviewed-source-final-02.json` at the same base, SHA-256
`72cea8125efda1d23b5743925e893deafa301e47318af764773f3f2d579e8835`,
and service manifest SHA-256
`9dc4084e9e626a1ec7e10ba5a6e802fd5a6e1140401ba87f253302bb4ce3399d`.
Proof is retained in `service-rehearsal-za3twnrg`. Frozen source and runtime hashes
remained intact. That one-session approval is consumed; these results do not
authorize another run or replace the pending exact-commit automatic checks.

The lifecycle exercises bounded publication, activation, rollback and successor
baselines with synthetic records. Its view/search-projection and barcode checks
do not establish a Meilisearch rebuild or alias switch. The restore canary and
publication-history inventory checks do not establish backup/restore acceptance
for a populated publication. Publication resource limits, full USDA scale,
external identity/caller cutover, hosted operation and release acceptance remain
open. The small functional result does not qualify the 256 MiB peak/32 MiB growth
resource limits or inherit ADR0104's historical memory proof.

## Consequences and alternatives

Migrations 0031 and 0032 add the publication state machine and update its public
eligibility and baseline consumers. Legacy evidence keeps its original meaning;
the legacy rollback entrypoints reject V2 involvement. The retained CLI exposes
prepare, submit and context reads for each explicit operation, with no automatic
retry or replacement of an uncertain request. See the
[command guide](../ingestion/catalogue-paged-publication.md).

Authority deployment evidence becomes version 8; restore fingerprints become
version 16. Both include the eligibility view's exact definition and options.
They compile the fixed reviewed query into a temporary view in an owned
savepoint and compare PostgreSQL's parsed definitions. Rolling back that scope
restores temporary objects and local settings while leaving a caller-owned
transaction open. Standalone calls own their enclosing transaction. The
expected query comes from source. This inspection needs TEMP-view permission and
does not derive expected policy from the observed target. Function bodies, ACLs,
relation ownership and the new publication columns/constraints/indexes remain
separately attested. Privacy inventory excludes only the explicitly classified
catalogue evidence and rejects its direct or version-mediated private-food links.

Updating only the source's active-release pointer would leave food pointers and
barcode lookup inconsistent. Writing legacy completion fields for a V2 batch
would misrepresent validation and allow incompatible consumers to accept it.
A release-scoped read model could reduce terminal work but requires a broader
consumer and writer redesign. This package preserves existing reader contracts
and makes its O(N) terminal cost explicit. Revisit that choice if the measured
cutover fails the accepted resource envelope or consumers require new semantics.
