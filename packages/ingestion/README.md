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
  promotion. Exact-member mode is the default; CNF documentation bundles must explicitly select
  `required-subset`.
- `parseDelimitedObjects`, `adaptFdcJsonRelease`, `stageFdcCsvRecordDetailed`,
  `adaptCnfTables`, and `stageCnfRecordDetailed` preserve source provenance and explicit
  known/trace/unknown semantics. Invalid child facts are returned as durable exclusion evidence
  instead of becoming zero or discarding an otherwise valid food.
- `runResumableBatch` coordinates optimistic checkpoints with an idempotent sink so a crash between
  the sink write and checkpoint update can be replayed safely.

Canonical nutrient fields default to `null`. `proposeCanonicalNutrientMapping` is only a mapping
proposal for review; production promotion must resolve mappings from the versioned authoritative
source-nutrient map.

## Network boundary

Release HTTP requests require an explicit host/path allowlist, HTTPS, redirect revalidation, and a
public-address DNS preflight. A DNS preflight cannot by itself eliminate DNS rebinding between
resolution and the underlying fetch connection. Production workers therefore require an outbound
egress allowlist or a resolver/HTTP dispatcher that pins the validated address through connection
establishment. File and insecure/private-network modes exist only behind explicit test flags and
must not be enabled in release jobs.
