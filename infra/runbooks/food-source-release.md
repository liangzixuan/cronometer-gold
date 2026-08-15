# Food-source release promotion

## Objective

Turn a pinned upstream artifact into a reproducible, rights-reviewed source release
without mutating the currently served catalogue.

## Acquire

1. Start from a source-specific manifest under `data/manifests`.
2. Reconfirm the official download URL, terms, licence, publication identifier, and
   planned product use. Record the reviewer and date.
3. Download into immutable object storage through an allow-listed job. Calculate
   SHA-256 and byte size while streaming; never ingest a floating URL directly.
4. Replace all template/null artifact fields in the manifest. Promotion rejects
   a missing or placeholder checksum.
5. Record a `food_source_release` row with status `imported`; do not mark it current.

## Parse and quarantine

- Run a pinned parser/container against the stored artifact, not the network.
- Load source-scoped staging tables. Retain original identifiers, language, market,
  bases, units, derivation/missingness flags, and rejected-row reason.
- Map source nutrients only through reviewed `source_nutrient_map` rows.
- Reject unknown units and schema drift. Do not coerce missing values to zero.
- Validate record counts, duplicates, impossible/negative values, serving
  conversions, calorie/macro consistency ranges, barcode syntax, and referential
  integrity. Report results by data type rather than hiding them in one pass rate.

## Diff and approve

Compare against the current promoted release:

- added/removed/changed source IDs and nutrient/serving counts;
- nutrient-mapping and unit changes;
- zero-to-missing and missing-to-zero transitions;
- barcode reassignment/collision rate by market;
- representative search relevance and zero-result rate;
- quarantined rows and high-impact nutrient outliers;
- index document count, build time, p95 latency, and memory/disk footprint.

Data engineering, product quality, and rights reviewers sign the promotion record.
Unexplained schema, rights, count, or quality changes block promotion.

## Promote

In one database transaction, create immutable food versions, advance only validated
food current-version pointers, mark the source release promoted, and enqueue an
outbox index-build event. Build a new search index off-line and atomically switch
the read alias only after its benchmark passes.

Existing diary snapshots never change. A food removed upstream remains available
to historical entries but is not offered for new search selection.

## Forward rollback

Do not mutate the bad release. Mark affected current food roots archived or advance
them to corrected versions from a new release, switch the search alias back to the
last healthy build, and publish compensating idempotent outbox events. Preserve the
raw artifact, failed validation, and audit trail for investigation and retention.
