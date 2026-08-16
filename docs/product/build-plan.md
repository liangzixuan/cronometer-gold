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
5. **Recipes and goals (next):** yield-aware recipe calculation, versioned targets,
   energy equations, nutrient coverage, and explainable recommendations.
6. **Retention features:** trends, exports, repeat logging, reminders, custom
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
candidate reconciliation tooling and the CNF operator staging command remain
pre-activation work; their absence blocks a live release but not the completed
ingestion-core milestone. Tests use
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

## Next acceptance target

Recipes and goals are complete when an authenticated user can build a versioned,
yield-aware recipe from immutable food/recipe revisions, log an exact serving,
and compare the resulting calories, macros, and micronutrients with versioned
daily targets. Recipe cycles, unit ambiguity, retention/yield assumptions, and
unknown nutrient coverage must fail visibly; energy equations and target sources
must remain explainable and independently testable.
