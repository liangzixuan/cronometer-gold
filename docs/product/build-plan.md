# Product Build Plan

This repository implements an independent consumer nutrition tracker. It does
not use Cronometer code, branding, assets, copy, or proprietary food records.

## Product promise

The first complete release lets a person track everything they eat and
accurately understand calories, macronutrients, and micronutrients. Accuracy
means preserving source provenance and missingness—not presenting absent values
as measured zeros.

## Delivery sequence

1. **Foundation (current):** modular monorepo, exact nutrition math, immutable
   diary snapshots, PostgreSQL schema, API/client shells, CI, and local services.
2. **Canonical food ingestion:** pinned USDA FoodData Central and Health Canada
   CNF releases, resumable staging, validation, reconciliation, and provenance.
3. **Food search:** disposable Meilisearch projection, generic/branded intent,
   autocomplete, typo tolerance, synonyms, recent/favorite boosts, and barcode
   exact lookup.
4. **Diary vertical slice:** account/profile, local-day diary, serving selection,
   add/edit/delete, meal groups, daily totals, and offline-safe idempotency.
5. **Recipes and goals:** yield-aware recipe calculation, versioned targets,
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

## Next acceptance target

The next milestone is complete when one pinned FDC release can be downloaded by
an operator, checksum-verified, staged, validated, imported idempotently into
versioned food/source/nutrient records, and rolled back by deactivating the
release without changing historical diary snapshots.
