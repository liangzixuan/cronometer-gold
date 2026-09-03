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

### USDA FDC Foundation inventory and baseline

Only after the two independent acquisitions agree may an operator copy their
exact SHA-256 and byte size into a controlled FDC working manifest. Pin the
executing ingestion package version and reviewed immutable parser-build digest,
and retain the exact single JSON member under `validation.expectedFiles`. Then
run the local, database-free evidence check from the retained artifact:

```sh
INGEST_PARSER_BUILD_SHA256=<reviewed-lowercase-sha256> \
pnpm --filter @nutrition-tracker/ingest cli -- fdc inspect \
  data/manifests/<fdc-foundation-release>.json \
  --artifact .local-data/acquired/<fdc-foundation-release>.zip \
  --cache-dir .local-data/cache \
  --extract-dir .local-data/extracted-fdc-inspect
```

Use a new private extraction directory. The command accepts no actor and no
authority-changing option, opens no database, and performs no network download.
It verifies the local ZIP against the manifest-pinned SHA-256 and byte size and
reopens the verified cache object with `O_NOFOLLOW`. Extraction reads that same
bound descriptor and, before returning, rechecks its pathname, captured file
identity, exact length, and SHA-256. A pathname replacement or same-inode
mutation fails closed and rolls back extracted outputs. The command also binds
the runtime parser build plus executing parser package/version to the manifest
and enforces the exact FDC Foundation dimensions:
`application/zip`, `dataTypes: ["Foundation"]`, `languages: ["en"]`,
`markets: ["US"]`, and `sourceIdentityFields: ["fdcId", "dataType"]`. Any
missing or extra regular file is rejected. The selected member is opened with
`O_NOFOLLOW`; its captured regular-file identity is checked before and after an
exact-length read, and the hash of the bytes actually parsed must match the
extractor's evidence.

The result explicitly binds `manifestSha256`, exact inventory/member evidence,
parser identity and metrics, and semantic parser evidence. The semantic evidence
includes a canonical accepted-record digest plus digests of the complete ordered
quarantine, excluded-nutrient, excluded-portion, and excluded-attribute arrays,
including dispositions and reasons. The complete `baseline` repeats the reviewed
count, payload, and semantic values. Every key must already match
`validation.releaseSpecificExpectations`; a missing or changed value is schema or
parser drift and stops the release. For reviewability, a mismatch still prints
the full computed local evidence and `baseline`; `baselineReview.status` is
`review-required`, its deterministic `mismatches` name every missing or changed
key, and the command exits nonzero. A complete match emits
`matched-manifest-expectations`. Both use
`non-qualifying-local-baseline-comparison-v1` and explicitly set
`qualifiesAsAcquisitionOrApprovalEvidence: false`; neither result is permission
to edit, stage, approve, or promote anything. Copy proposed values only into a
controlled working manifest for independent review, then rerun the inspection to
prove the reviewed values match.

This inspection is local evidence only. It creates no acquisition observation,
rights decision, approval, batch, promotion eligibility, current-release pointer,
or search-index switch. Its `localVerification` object is explicitly
`non-qualifying-local-artifact-verification-v1` with
`qualifiesAsAcquisitionObservation: false`, and it emits no acquisition-shaped
identity or approval claim. It does not change `templateOnly`.

If extraction succeeds but JSON parsing or baseline comparison fails, the
captured expected member is deliberately retained in the operator-owned private
extraction directory (`0700` directory, `0600` single-link file). Automatic
cleanup could delete a path replaced after capture; inspect the failure, confirm
the retained identity, and remove it deliberately. The checked-in FDC candidate
retains null artifact/parser pins and no invented semantic expectations, and is
expected to fail until controlled acquisition and parser review supply real
evidence. Never fill those fields from a HEAD response, approximate publisher
size, local guess, or a single download.

Once the working manifest independently passes every import-ready gate,
`catalogue stage-fdc` accepts only its one manifest and the four documented path/
object options. Unknown or authority-shaped options are rejected before manifest
or database access. The command performs descriptor-bound artifact verification,
exact inventory and member parsing, and strict baseline comparison before it opens
PostgreSQL or can register a source or create a batch. A preflight failure must
therefore leave the database unopened and unchanged.

### USDA FDC full-CSV inventory and bounded inspection

The full CSV has a separate evidence-only command; it is not an input to the
Foundation JSON staging command. Use it only after two authenticated fresh
downloads agree and a controlled working manifest pins the exact artifact,
parser package/version/build, and complete observed regular-file inventory:

From the repository root, create or normalize the untracked private local root
before the first inspection:

```sh
install -d -m 0700 .local-data
test "$(stat -c '%a' .local-data)" = 700
```

Replace every angle-bracket placeholder in the example below before running it;
the example is not directly pasteable with placeholders intact. Dependencies
must already be installed and the workspace packages built.

```sh
INGEST_PARSER_BUILD_SHA256=<reviewed-lowercase-sha256> \
pnpm --filter @nutrition-tracker/ingest cli -- fdc inspect-csv \
  data/manifests/<fdc-full-csv-release>.json \
  --artifact .local-data/acquired/<fdc-full-csv-release>.zip \
  --cache-dir .local-data/cache-fdc-csv \
  --extract-dir .local-data/extracted-fdc-csv-proposal-<run-id>
```

Do not guess archive paths from historical filenames. Classify every observed
member in `releaseSpecificExpectations` with
`fdcCsvDisposition:<archive-path>`. Exactly one member must fill each adapter
role: `food`, `branded-food`, `food-nutrient`, `nutrient`,
`food-nutrient-derivation`, `food-portion`, and `measure-unit`. Classify every
other CSV as `reference-only:unmaterialized-supporting-table-v1` and each
non-CSV publisher document as `guide:publisher-documentation-v1`. Any unlisted,
missing, duplicate, case-colliding, or differently classified member stops the
inspection.

Review the exact publisher values before adding
`fdcCsvDataTypeMapping:<raw-value>` and
`fdcCsvMarketMapping:<raw-value>` entries. Mapping targets must remain inside the
manifest's reviewed data types and markets; `fdcCsvDefaultMarketCode` applies
only to non-branded foods. An unknown raw value quarantines the food and its
children instead of being inferred.

The command is Linux/WSL-only and accepts repository-relative paths under
`data/manifests` and `.local-data`; it rejects Windows, `/mnt/<drive>`, absolute,
traversing, and symlink-escaping paths. The two authority roots must be real
current-user-owned directories and `.local-data` must be mode `0700`. Use a new
empty extraction directory for every proposal or reviewed rerun; successful
inspection retains selected CSV inputs and no-replace extraction deliberately
rejects a reused directory. It verifies the exact supplied artifact, preflights
the full ZIP, parses bounded lookup tables, disk-partitions the four large
relations, joins one partition at a time, and emits deterministic table,
conservation, disposition, semantic, resource, source-mix, context, canonical
per-market GTIN-collision, and baseline evidence. It opens no database and
accepts no identity or authority option.

A first baseline proposal deliberately exits nonzero. Independently review all
counts, ordered-header and row digests, mappings, exclusions, quarantines,
partition limits, spool footprint, source-type/market histograms, canonical
GTIN-14 collision groups, and conservation equations before copying the entire
baseline into the controlled working manifest and rerunning with another new
empty extraction directory. A match is still non-qualifying local verification:
it creates no acquisition record, rights decision, approval, batch, promotion
eligibility, or current pointer.

Only synthetic archives currently prove this implementation. Before any live
staging work, complete dual acquisition, full inventory/header review,
rights/attribution and nutrient-mapping review, representative 460 MB/3.1 GB
scale and scratch-capacity evidence, and a separately reviewed streaming
database-staging design. Do not use this inspector's retained CSV files or output
as an acquisition attestation, and do not retrofit the Foundation JSON staging
command to consume them during an operator run.

### Health Canada CNF inventory and baseline

The CNF nine-CSV parser contract is not the archive inventory. Before changing a
CNF candidate from `templateOnly`, record a unique, exact
`validation.expectedFiles` list containing all nine CSVs and every non-CSV
English/French guide path observed in the acquired aggregate. The five adapter
inputs are `Food_Name.csv`, `Nutrient_Amount.csv`, `Nutrient_Name.csv`,
`Measure_Weight_Conversion.csv`, and `Measure_Name.csv`. The other four are
parsed reference-only evidence with durable reasons:

- `Food_Source.csv`: `food_source_reference_not_materialized_v1`;
- `CNF_Food_Group.csv`:
  `upstream_food_group_taxonomy_not_materialized_v1`;
- `Nutrient_Source.csv`: `nutrient_source_lookup_not_materialized_v1`;
- `Measure_Type.csv`: `measure_type_lookup_not_materialized_v1`.

Do not guess the guide names, omit them because they are not adapter inputs, or
classify an unknown CSV as a guide. The full inventory must exactly equal all
regular files in the ZIP.

After the two independent acquisitions agree and the artifact SHA-256/byte size,
parser version/build digest, and full inventory have been pinned, run the
evidence-only inspection against the retained object from a reviewed WSL parser
build:

```sh
INGEST_PARSER_BUILD_SHA256=<reviewed-lowercase-sha256> \
pnpm --filter @nutrition-tracker/ingest cli -- cnf inspect \
  data/manifests/<cnf-release>.json \
  --artifact .local-data/acquired/<cnf-release>.zip \
  --cache-dir .local-data/cache \
  --extract-dir .local-data/extracted-cnf-inspect
```

Use a new private extraction directory. This command accepts no actor, accesses
no database, and creates no acquisition observation or approval. It verifies the
manifest-pinned artifact and runtime parser-build digest, preflights the complete
ZIP under the archive limits, parses the nine CSVs as bounded fatal UTF-8/RFC
4180, and emits exact inventory, table, conservation, language, exclusion, and
accepted-payload evidence. Review its `baseline` object, then copy every key and
exact value to `validation.releaseSpecificExpectations`; the command never edits
the manifest for the operator.

On success, the nine CSVs remain in the extraction directory for review and the
guide members have not been extracted. On failure, the parser removes only
selected files whose captured device, inode, size, regular-file status, and
single-link count still match. It preserves a replaced file and reports the
cleanup failure; when both parsing and cleanup fail, retain and review both
errors. Do not treat any extracted file or local cache hit as an independent
publisher acquisition.

After rights review and every other import-ready field is complete, validate the
final manifest and run staging only through the approved release runner:

```sh
pnpm --filter @nutrition-tracker/ingest cli -- manifest validate \
  data/manifests/<cnf-release>.json --import-ready

pnpm --filter @nutrition-tracker/ingest cli -- catalogue stage-cnf \
  data/manifests/<cnf-release>.json \
  --artifact .local-data/acquired/<cnf-release>.zip \
  --cache-dir .local-data/cache \
  --extract-dir .local-data/extracted-cnf-stage \
  --manifest-object-uri s3://<object-locked-bucket>/sha256/<manifest-sha256>/manifest.json
```

The runner must inject the externally authenticated method, stable principal,
immutable run reference, reviewed `INGEST_PARSER_BUILD_SHA256`, and a
least-privilege database credential; never substitute caller-authored identity.
The manifest object URI must contain the exact manifest SHA-256. Before creating
a database connection, staging checks the import-ready gate, verified artifact,
exact archive inventory, all nine table contracts, and every generated parser
baseline value.

Database staging resumes in chunks of 250 from a validated checkpoint. It stores
one canonical-digest-bound parser report containing the exact inventory/table
evidence, dispositions and reference-only reasons, exclusions and reason counts,
adapter conservation, artifact/parser/mapping identity, and trusted actor. A
conflicting report is rejected, update/delete triggers make the row immutable,
and validation independently verifies the report structure, digests,
provenance, and count sums. A retry of a `ready`, `quarantined`, or `completed`
batch returns its frozen validation evidence without reopening staged rows.

The command emits final JSON only after the database connection closes. If both
the operation and required cleanup fail, both errors are reported; if cleanup
alone fails, no successful result is printed. A returned `ready` status or
`promotionEligible: true` is validation evidence, not an approval, release
promotion, or search-alias switch.

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

For the database-resident comparisons, generate a digest-bound document after
validation with:

```sh
pnpm --filter @nutrition-tracker/ingest cli -- catalogue reconcile \
  --batch-id <uuid> \
  --expected-current-release-id <uuid|none> \
  --expected-validation-digest <lowercase-sha256> \
  --report-out .local-data/evidence/catalogue-reconciliation/<batch-id>.json
```

This is a read-only evidence command with no actor. It rejects positional,
missing, repeated, unknown, or malformed arguments before database access,
requires the caller's exact current-release expectation, and permits output only
beneath the ignored repo-local `.local-data/evidence/catalogue-reconciliation`
root. Absolute, escaping, Windows, `/mnt/c`, or symbolic-link paths are refused.
Every evidence-tree parent must be current-user-owned with mode `0700`; the
database connection must close successfully before publication begins. The
canonical report is written and synchronized through a same-directory,
no-follow, exclusive mode-`0600` temporary inode, atomically published through a
no-clobber hard link, and followed by temporary-name cleanup and directory
synchronization. Standard output is emitted only after that sequence succeeds;
an interruption cannot expose a truncated final report. The command neither
records an approval nor marks the batch eligible for promotion.

Canonical SHA-256 calculation and report-file writing stream canonical chunks
and avoid allocating a second full serialized document. The current database
observer and pure builder still retain the validated baseline/candidate
snapshots and result object in memory. A live full-FDC reconciliation remains
blocked until representative peak-memory and footprint evidence passes the
reviewed release budget; do not infer bounded-memory operation from streaming
output alone.

The document covers database catalogue records, referenced materialized mapping
transitions, quarantine evidence, and barcode attempts/rates. Mapping digests
bind the full reviewed registry, but transition rows are explicitly scoped to
materialized observations and are not a complete registry diff. It retains the
complete accepted baseline- and candidate-barcode assignment populations and
complete per-food nutrient-state matrix so barcode transitions, market rates,
and missingness transitions can be recomputed exactly; quarantined records
remain visible but never enter the
barcode-rate population. Independently
retain and review the full nutrient-mapping registry diff, high-impact nutrient
outlier review, and search/index evidence above, including relevance,
zero-result, document-count, build-time, latency, and footprint results.
Database reconciliation cannot authorize approval, promotion, or an alias
switch. CNF now has an evidence-only inspection command and an operator staging
command, but its first activation remains blocked until the published artifact
is acquired twice under distinct authenticated principals, its complete guide
inventory and real baselines are reviewed, rights and attribution are approved,
artifact and manifest objects are immutable, the nutrient map is reviewed, and
representative parser scale, database reconciliation, outlier, and search/index
evidence all pass. Synthetic fixture tests satisfy none of those release gates.

Promotion stores the complete sorted active mapping-revision ID set in the
immutable release validation summary. Historical baseline verification reloads
that exact set and recomputes the full registry digest, including revisions used
only by warning-excluded nutrients and mappings unused by every staged record.
Older releases without this evidence fail closed and require a separately
reviewed recovery decision; current mapping state must not be substituted.

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
