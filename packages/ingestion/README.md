# `@nutrition-tracker/ingestion`

Transport-neutral ingestion primitives for versioned USDA FoodData Central and Health Canada CNF
releases. The package has no database dependency.

## Public boundaries

- `parseFoodSourceManifest` validates the exact manifest v3 runtime contract;
  `assertImportReadyManifest` applies the stricter legal, attestation, and release-expectation gate.
- `acquireArtifact` streams local/test or allow-listed HTTPS bytes into a content-addressed cache,
  verifies an independently pinned SHA-256 and byte count, and returns an immutable acquisition
  observation. Cache hits and local files are explicitly ineligible as independent release
  attestations.
- `extractZipArchive` preflights every central-directory entry, rejects links, encryption, path
  ambiguity and archive bombs, then lazily writes only selected members with atomic no-replace
  promotion. `expectedFiles` is the exact full regular-file inventory by default, while the
  optional, unique `selectedFiles` subset controls which already-preflighted members are written.
  `required-subset` remains only for callers that do not yet have a full inventory.
- `withExtractedZipArchive` closes the ZIP and, when an exact archive expectation is supplied,
  re-verifies its bound descriptor before invoking a bounded consumer. It retains every exact
  destination-parent handle until that consumer finishes. A consumer failure rolls back only
  extractor-owned identities through those retained handles; success revalidates every output and
  bound directory before releasing ownership. Consumers must treat extracted files as read-only
  and defer external commits until the scoped promise resolves.
- `parseDelimitedObjects`, `adaptFdcJsonRelease`, `stageFdcCsvRecordDetailed`,
  `adaptCnfTables`, and `stageCnfRecordDetailed` preserve source provenance and explicit
  known/trace/unknown semantics. Invalid child facts are returned as durable exclusion evidence
  instead of becoming zero or discarding an otherwise valid food.
- `runResumableBatch` coordinates optimistic checkpoints with an idempotent sink so a crash between
  the sink write and checkpoint update can be replayed safely.

Canonical nutrient fields default to `null`. `proposeCanonicalNutrientMapping` is only a mapping
proposal for review; production promotion must resolve mappings from the versioned authoritative
source-nutrient map.

## USDA FDC full-CSV archive contract

`parseFdcCsvArchive` is the database-free, bounded inspection boundary for a
reviewed full-download CSV ZIP. The caller must provide the exact complete
regular-file inventory and one explicit disposition for every member. Exactly
seven CSV roles are adapter inputs: food, branded food, food nutrient, nutrient,
food-nutrient derivation, food portion, and measure unit. Every other CSV must be
declared reference-only with
`unmaterialized-supporting-table-v1`; non-CSV publisher documentation must be a
guide with `publisher-documentation-v1`. Paths are learned from the reviewed
inventory rather than assumed from an archive naming convention.

The parser loads only bounded nutrient, derivation, and measure-unit lookup
tables. It writes the four potentially large relations to private, fixed-count
SHA-256 partitions, joins one partition and one food at a time, updates
deterministic count/digest evidence, and discards each staged record. All row,
field, lookup, individual and combined partition, fan-out, spool,
archive-member, and expanded-byte limits fail closed. The result contains
table, conservation, disposition, semantic, processing, source-mix, and
canonical per-market GTIN-collision evidence; it never contains the full
catalogue and the package has no database dependency. Semantic and GTIN evidence
declare their SHA-256-partition/key ordering, and the partition algorithm,
count, and limits are baseline-bound rather than implicit.

Raw `food.data_type` and branded `market_country` values are accepted only
through explicit reviewed mappings supplied by the manifest. Unknown values
quarantine their parent food; no substring, default-country, or display-label
guess is used. Nutrient derivation foreign keys are joined to their published
codes, a strictly positive limit of quantitation converts a missing/zero amount
to trace while LOQ zero preserves a known zero, and
`household_serving_fulltext` can produce a label serving. A blank portion
amount defaults to one only for FNDDS; SR Legacy descriptions may fall back to
their nonblank modifier, while other blank amounts remain invalid child facts.
Valid GTIN-8/12/13/14 values are normalized to GTIN-14 before identity and
collision analysis.

Successful parsing retains only the declared CSV inputs for review and removes
its private spool after identity-bound cleanup; guides are preflighted but not
extracted. FDC parsing runs inside the extractor-owned scope, so a parse failure
rolls back exact CSV identities through their original bound parents even if a
public parent path was renamed and replaced. This boundary is currently proven
with synthetic fixtures. It does not establish the real archive inventory,
headers, raw-value mappings, scale budget, acquisition identity, rights
decision, database staging, or promotion eligibility.

## Health Canada CNF archive contract

`parseCnfArchive` requires the exact full regular-file inventory. It must contain
the nine declared CSVs below and may additionally contain only explicitly named
non-CSV guides. The extractor performs a two-pass preflight over every archive
entry, including guides, but selects only the nine CSVs for extraction and
parsing. A duplicate, missing, or extra inventory member, an undeclared CSV, or
a selected member outside the inventory fails closed.

| Archive member | Disposition | Reference-only reason |
| --- | --- | --- |
| `Food_Name.csv` | adapter input | — |
| `Food_Source.csv` | reference-only | `food_source_reference_not_materialized_v1` |
| `CNF_Food_Group.csv` | reference-only | `upstream_food_group_taxonomy_not_materialized_v1` |
| `Nutrient_Amount.csv` | adapter input | — |
| `Nutrient_Name.csv` | adapter input | — |
| `Nutrient_Source.csv` | reference-only | `nutrient_source_lookup_not_materialized_v1` |
| `Measure_Weight_Conversion.csv` | adapter input | — |
| `Measure_Type.csv` | reference-only | `measure_type_lookup_not_materialized_v1` |
| `Measure_Name.csv` | adapter input | — |

Reference-only tables are still parsed and included in evidence. Their versioned
reason identifies why their rows are not currently materialized and prevents a
successful run from masquerading as silent row loss. No lookup or nutrient
mapping is inferred from those files.

Each CSV is streamed through bounded fatal UTF-8 and RFC 4180 parsing with exact,
unique headers. Evidence records the member path and byte size, raw-byte SHA-256,
ordered headers and header SHA-256, data-row count, ordered canonical-row
SHA-256, disposition, and reason. The result also binds the canonically sorted
full inventory and the ordered nine-table evidence with aggregate SHA-256
digests. Adapter conservation requires:

- `Food_Name.csv`: source rows = emitted records + quarantined records;
- `Nutrient_Amount.csv`: source rows = emitted nutrients + excluded nutrients;
- `Measure_Weight_Conversion.csv`: source rows = emitted portions + excluded
  measures + reason-counted skipped measures.

The adapter also emits an immutable, globally source-indexed `rowDispositions`
partition for those three tables. Its exact emitted, quarantined, excluded, and
skipped entries are bound by `rowDispositionsSha256` rather than inferred from
aggregate counts.

Known zero, trace, and unknown nutrient states remain distinct throughout the
adapter. A child row with a missing, invalid, or unknown `Food_Code` aborts at
the known-parent boundary. Once a valid `Food_Code` resolves to a quarantined
parent food, its child nutrient and measure rows become durable reason-counted
exclusion evidence; they cannot disappear or become zero.

Successful parsing deliberately retains the nine extracted CSVs for downstream
staging and review, while guides are never extracted. Extraction requires a
canonical current-user-owned `0700` root and creates `0700` parents plus `0600`
files. This boundary is intentionally POSIX-only and must run on Linux (including
the supported WSL2 environment); it relies on current-UID checks, POSIX open
flags, and parent handles bound through `/proc/self/fd`. The extractor keeps its
read/write handle open through hard-link publication, re-reads the bytes, and
returns the final device, inode, owner, mode, timestamps, size, link count, and
SHA-256 to the parser. Parsing runs inside the extractor-owned scope, uses
`O_NOFOLLOW`, and requires that extractor identity before and after each
stream. On any extraction or parse failure, cleanup uses the still-bound
original parent, moves only an exact captured inode into a random private
quarantine, revalidates its identity and content, and then removes it. It
preserves replacements and unowned hard links and returns the operation error
followed by every cleanup error when rollback is incomplete.

## Network boundary

Release HTTP requests require an explicit host/path allowlist, HTTPS, redirect revalidation, and a
public-address DNS preflight. A DNS preflight cannot by itself eliminate DNS rebinding between
resolution and the underlying fetch connection. Production workers therefore require an outbound
egress allowlist or a resolver/HTTP dispatcher that pins the validated address through connection
establishment. File and insecure/private-network modes exist only behind explicit test flags and
must not be enabled in release jobs.
