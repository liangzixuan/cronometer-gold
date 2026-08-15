# Food-source release promotion

## Objective

Turn a pinned upstream artifact into a reproducible, rights-reviewed source release
without mutating the currently served catalogue.

## Acquire

1. Start from a source-specific manifest under `data/manifests`.
2. Reconfirm the official download URL, terms, licence, publication identifier, and
   planned product use. Record the reviewer and date.
3. Inspect `publisherIntegrity`. If the publisher supplies SHA-256, capture the
   checksum and its official evidence URL. Do not label MD5, an ETag, or an
   undocumented portal `hash` as SHA-256.
4. Operator A streams the pinned official HTTPS URL through an allow-listed
   acquisition job, computes SHA-256 and byte size during the stream, and writes an
   immutable raw object plus an acquisition observation. The job rejects local
   files, non-HTTPS transport, private/link-local destinations, host changes, and
   redirects outside the source allow-list. Do not retain query strings, user info,
   or temporary signed redirect credentials in the manifest or logs.
5. Operator B, using a distinct authenticated principal and acquisition ID and a
   fresh publisher download rather than Operator A's object or cache, independently
   computes a second observation. A cache hit is never an independent attestation.
   The URL, SHA-256, and byte size must match. If a publisher SHA-256 exists, both
   observations must also match it.
6. On any mismatch, stop. Preserve both observations, check whether the upstream
   file was republished, reacquire twice, and create a new candidate release when
   upstream bytes changed. Never choose one digest by hand.
7. After a match, copy the digest and size into `artifact.sha256` and
   `artifact.byteSize`, set a content-addressed, object-locked `objectUri`, and retain official metadata,
   terms, response headers, and observations beside the raw object.
8. Replace the remaining template/null fields. The validator requires at least two
   distinct matching observations before `templateOnly` can become false.
9. Record an immutable-provenance `food_import_batch` in `staging`; do not create
   or mark a catalogue release current. The `food_source_release` row is created
   only inside the later atomic promotion transaction, after validation and all
   role approvals, so a merely downloaded artifact cannot appear publishable.

The CLI does not authenticate a human by itself. Run release commands only inside
the approved release runner, which validates an OIDC or workload-identity
assertion and injects the authenticated principal and immutable run reference.
The runner owns the short-lived, least-privilege database credential; direct
developer-shell promotion and shared database credentials are prohibited. Raw
principal flags are deliberately not supported.

The runner injects the reviewed parser image/build SHA-256 and stores the exact
manifest bytes at a separate content-addressed, object-locked URI. The CLI binds
the parser build and active nutrient-mapping revision digests into the batch
identity and refuses to continue if either changes during an attempt.

Independent agreement protects against an incomplete transfer and unnoticed
republishing when no publisher digest exists. It is not a publisher signature.
Approximate page sizes and HEAD `Content-Length` values are planning evidence only;
the canonical byte size comes from the verified streamed object.

## Parse and quarantine

- Run a pinned parser/container against the stored artifact, not the network.
- Resume record staging from the durable `stage` checkpoint. A crash between a
  chunk commit and checkpoint update safely replays the identical chunk; a retry
  after validation returns the frozen validation result and cannot reopen rows.
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

No automated reconciliation command is shipped in the ingestion-core milestone.
Until that digest-bound report is implemented, these comparisons require
independently retained review evidence and a live source release must not be
approved. CNF likewise has a production parser adapter but no operator staging
command yet; its first activation remains blocked.

Data engineering, product quality, and rights reviewers sign distinct immutable
role approvals bound to both the manifest SHA-256 and validation-report SHA-256.
No principal may satisfy more than one required role for the same release.
Unexplained schema, rights, count, or quality changes block promotion.

## Promote

In one database transaction, create the imported source release and immutable food
versions, advance only validated food current-version pointers, mark the source
release promoted, and enqueue an
outbox index-build event. Build a new search index off-line and atomically switch
the read alias only after its benchmark passes.

Existing diary snapshots never change. A food removed upstream remains available
to historical entries but is not offered for new search selection.

## Forward rollback

Do not mutate the bad release. Mark affected current food roots archived or advance
them to corrected versions from a new release, switch the search alias back to the
last healthy build, and publish compensating idempotent outbox events. Preserve the
raw artifact, failed validation, and audit trail for investigation and retention.
