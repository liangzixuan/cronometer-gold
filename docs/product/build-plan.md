# Product Build Plan

This repository implements an independent consumer nutrition tracker. It does
not use Cronometer code, branding, assets, copy, or proprietary food records.

## Product promise

The first complete release lets a person track everything they eat and
accurately understand calories, macronutrients, and micronutrients. Accuracy
means preserving source provenance and missingness—not presenting absent values
as measured zeros.

## Delivery sequence

1. **Foundation (complete):** modular monorepo, exact nutrition math, immutable
   diary snapshots, PostgreSQL schema, API/client shells, CI, and local services.
2. **Canonical food ingestion core (complete):** release-candidate manifests and
   real-data adapters for USDA FoodData Central and Health Canada CNF, plus
   resumable staging, validation, atomic activation, rollback, and provenance.
3. **Food search (complete):** disposable Meilisearch projection,
   generic/branded intent, autocomplete, typo tolerance, reviewed synonyms,
   bounded recent/favorite reranking, and authoritative exact barcode lookup.
4. **Diary vertical slice (complete):** account/profile, local-day diary, serving
   selection, add/edit/delete, meal groups, exact daily totals, and retry-safe
   idempotency.
5. **Recipes and goals (complete):** yield-aware versioned recipes, immutable
   recipe diary snapshots, versioned targets, bounded energy estimates, and
   lower-bound nutrient progress.
6. **Retention features (next):** trends, exports, repeat logging, reminders, custom
   foods/biometrics, and platform health integrations.
7. **Subscription features:** advanced reports, long-range analytics, premium
   automation, and coaching only after the free tracking loop is excellent.

## Non-negotiable engineering rules

- PostgreSQL is authoritative; search and cache are rebuildable projections.
- Food-source terms are reviewed before ingestion. Every release has a manifest,
  checksum, license record, and reproducible import run.
- Nutrient arithmetic uses exact decimals and distinguishes known zero, trace,
  and unknown values.
- Logged nutrition is snapshotted and cannot be rewritten by later catalogue,
  serving, goal, or recipe changes.
- Private health data is least-privilege, encrypted in transit and at rest,
  excluded from telemetry, exportable, and deletable.
- Begin as a modular monolith. Extract ingestion/search workers only when load or
  operational isolation justifies it.

## Canonical-ingestion boundary

The release pipeline, real FDC/CNF parsers, immutable database workflow, approval
gates, atomic promotion, idempotent replay, and forward rollback are implemented
and tested. A live FDC release has intentionally not been promoted: the checked-in
candidate remains non-importable until two independently authenticated operators
agree on the streamed artifact, rights review is recorded, immutable object
storage is provisioned, and the complete nutrient map is reviewed. Current-vs-
candidate database reconciliation now atomically emits canonical, digest-bound,
read-only evidence into a private, symlink-free repo-local `.local-data` evidence
tree only after database cleanup, without granting approval or promotion
eligibility. Separate retained full-registry mapping review, high-impact nutrient
outlier review, search/index evidence, and the CNF operator staging command
remain pre-activation work; their absence blocks a live release but not the
completed ingestion-core milestone. Promoted releases freeze the complete active
mapping-revision set for exact historical revalidation, and canonical report
hashing/writing is incremental. The database observer and document builder still
retain full validated snapshots and the result object, so representative
full-FDC peak-memory evidence remains a live-release blocker. Tests use
synthetic approvals only to verify the transaction and historical-snapshot
invariants; they are not production attestations.

## Food-search boundary

The search index is generated from one coherent promoted-catalogue snapshot,
versioned, count-verified, and atomically swapped. PostgreSQL remains authoritative
for source rights and barcode identity. Projection revisions, fail-closed API
checks, `no-store` responses, and a bounded PostgreSQL fallback prevent an old or
unpublished index from extending a rights change. The public document excludes
user and health data and carries reviewed attribution through API, web, and mobile
surfaces. Search relevance and the PostgreSQL-to-Meilisearch publication path are
covered by real-service integration tests.

## Diary boundary

The write-capable private loop now uses normalized password accounts, bounded
scrypt work, revocable opaque sessions, server-side ownership checks, strong
entry revision preconditions, and UUID/digest-bound diary idempotency. Web bearer
tokens remain in a host-only Secure/HttpOnly/SameSite cookie behind origin checks
and a nonce CSP; native tokens use platform secure storage. Every food entry pins
its food version, source release, reviewed attribution, effective IANA time zone,
serving resolution, nutrition-engine version, and immutable reason-counted
nutrient vector. Day reads are coherent snapshots, cross-day moves advance both
day revisions, and trace, quantified zero, partial coverage, and unknown remain
distinct through the clients.

The checked-in food-release candidates are still deliberately non-promotable,
so diary integration evidence uses a synthetic promoted catalogue fixture rather
than claiming a live USDA or CNF release. Password recovery, email verification,
durable cross-restart offline queues, account export/deletion, and signed-device
preview testing remain controlled-beta gates rather than hidden claims of this
milestone. Until diary entries are paginated, a local day is capped at 50 food
entries so the full immutable nutrient vectors remain within a reviewed response
and mobile-memory budget.

## Recipes-and-goals boundary

An authenticated person can create and revise a private recipe from immutable
food or nested-recipe versions, provide measured or estimated final yield, and
log either grams or a defined serving. Recipe versions retain the exact resolved
ingredients, calculation and identity-retention assumptions, reason-counted
nutrient coverage, warnings, and transitive source attribution. Cycles, excessive
depth or closure, cross-owner dependencies, ambiguous servings, and stale
revisions fail closed. A diary log pins the selected recipe version and remains
unchanged by later recipe edits.

Daily goals are immutable revisions with explicit effective dates. Energy can be
a user-supplied fixed value or a visibly estimated Mifflin–St Jeor result for the
reviewed adult/profile boundary, multiplied by an explicitly selected PAL. The
snapshot retains every input and source and does not add ordinary exercise a
second time. Nutrient targets are user-supplied and source-labelled; this
milestone does not silently invent DRI defaults. Progress is derived from one
coherent diary/goal snapshot and labels trace, partial, or unknown intake as a
known lower bound rather than exact completion. Web and native clients preserve
idempotent retry bodies and exact recipe versions.

Migration `0005` deliberately refuses experimental legacy recipe or goal roots
that lack the immutable evidence required by these contracts. They require a
reviewed export/remediation and API-based recreation; the migration does not
fabricate nutrition, yield, source, or equation history. Whole-account erasure,
automatic reference targets, retention-factor datasets, therapeutic goals, and
signed-device validation remain controlled-beta work and are not claimed here.

## Next acceptance target

Retention features are complete when an authenticated person can inspect
timezone-correct nutrient trends, export a complete and machine-readable copy of
their account and immutable nutrition history, repeat a prior log without
silently selecting newer food or recipe versions, and configure reminders that
remain consented, revocable, and free of health details on lock screens. Custom
foods, biometrics, and platform-health imports must preserve provenance,
deduplicate retries, expose conflicts, and remain deletable. Account erasure,
backup restore, export reconciliation, notification delivery, and signed-device
flows must pass end-to-end drills before this milestone is called complete.
