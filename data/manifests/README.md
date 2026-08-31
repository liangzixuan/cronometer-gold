# Food-source manifests

A manifest is the machine-readable gate between an upstream download and the
canonical food database. The checked-in `.example.json` files are rights and
mapping fixtures, not import-ready releases: `templateOnly` is true and artifact
checksums are intentionally null rather than fabricated.

Manifest version 3 adds explicit publisher-integrity metadata, independently
auditable fresh-download observations, and separates the immutable acquisition and
rights manifest from post-validation promotion approvals. Earlier manifests are
intentionally rejected rather than silently bypassing the current verification gate.

Release-specific `.candidate.json` files pin official release identities and
download URLs, but they are also non-importable templates. A candidate may record
publisher-reported display sizes and non-authoritative HTTP observations without
claiming that the artifact has been acquired or verified.

Before ingestion:

1. Copy the relevant example to a release-specific filename such as
   `usda-fdc-2026-10-15.json`.
2. Revalidate every official URL and term on the acquisition date.
3. Pin the upstream release and raw download URL. When the publisher supplies a
   SHA-256, record its value and evidence URL under `publisherIntegrity`.
4. Have two authenticated, distinct operators independently stream the official
   HTTPS URL without a shared cache and produce matching `acquisitionObservations`.
   Each observation retains its acquisition ID, stable operator principal, tool,
   fresh-download flag, requested and resolved URL, safe response metadata,
   SHA-256, and byte size. Only then copy the matching SHA-256 and byte size to the
   artifact fields and retain the raw object at a content-addressed, object-locked
   URI. Every legitimate redirect destination must be an exact, query-free entry
   in `permittedResolvedUrls`; ephemeral signed query strings are never retained.
5. Pin the parser version and immutable build/image SHA-256, fill validation
   expectations, and record the rights
   reviewer/evidence. Set `templateOnly` to false only when complete.
6. Validate against `food-source-manifest.schema.json` and retain the exact manifest
   beside the raw object. The database release row stores both URIs/checksums.

## Health Canada CNF inventory and parser baseline

For CNF, `validation.expectedFiles` is a unique, exact inventory of every regular
file in the aggregate ZIP. It must include the five adapter-input CSVs
(`Food_Name.csv`, `Nutrient_Amount.csv`, `Nutrient_Name.csv`,
`Measure_Weight_Conversion.csv`, and `Measure_Name.csv`), the four
reference-only CSVs (`Food_Source.csv`, `CNF_Food_Group.csv`,
`Nutrient_Source.csv`, and `Measure_Type.csv`), and the exact path of every
English/French non-CSV guide observed during controlled acquisition. Do not
guess guide names, omit them because they are not parsed, or use a
required-subset policy for an import-ready CNF release. Any other CSV is
undeclared schema, not a guide.

The checked-in CNF candidate lists the known nine-CSV contract, but it is not
evidence of the aggregate ZIP's complete inventory. Keep it `templateOnly` until
the real archive has been acquired under the release controls and every guide
path has been recorded. The manifest schema rejects duplicate expected members.

After pinning the independently agreed artifact SHA-256 and byte size, parser
version, immutable parser-build SHA-256, and full inventory, run the database-free
inspection command against the stored artifact:

```sh
INGEST_PARSER_BUILD_SHA256=<reviewed-lowercase-sha256> \
pnpm --filter @nutrition-tracker/ingest cli -- cnf inspect \
  data/manifests/<cnf-release>.json \
  --artifact .local-data/acquired/<cnf-release>.zip \
  --cache-dir .local-data/cache \
  --extract-dir .local-data/extracted-cnf-inspect
```

The command verifies the artifact and parser-build pins, preflights the exact
full inventory, parses all nine CSVs, and prints a `baseline` object. It does not
mutate the manifest, access PostgreSQL, create an acquisition attestation, grant
approval, or prove a live release. Review the evidence, then copy every emitted
baseline key and exact value into
`validation.releaseSpecificExpectations`. Those keys bind the full-inventory
count/digest; every table's byte size, raw/header/ordered-row digests and row
count; the ordered table-evidence digest; source/emitted/excluded/skipped counts;
description-language partition; exclusion-reason digest; and accepted source
payload digest.

`catalogue stage-cnf` recomputes and compares every generated baseline value
before it creates a database connection. A missing or changed key fails before
staging. This parser baseline complements rather than replaces the two fresh
acquisition observations, rights evidence, reviewed nutrient mappings, immutable
artifact/manifest objects, and later role approvals.

Import is blocked when rights are pending, the raw artifact/checksum is missing,
the parser is not pinned, or executable validation expectations are absent. Later
data, quality, and rights approvals are immutable database records bound to the
manifest and validation-report digests; they are deliberately not mutable fields in
this manifest. Never edit an imported manifest; create a new source release.

The schema requires at least two observations for any non-template manifest. The
ingestion validator additionally requires distinct normalized operator principals
and acquisition IDs, fresh HTTPS downloads, and every observation to match the
manifest URL, SHA-256, and byte size. An
ETag, `Last-Modified`, `Content-Length`, approximate website size, or unlabeled
32-character portal hash does not substitute for SHA-256.

These fixtures do not replace legal review. See
[`ADR 0001`](../../docs/adr/0001-food-source-rights-and-provenance.md) and the
[official release catalogue](../../docs/ingestion/official-source-releases.md).
