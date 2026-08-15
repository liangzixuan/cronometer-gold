# Food-source manifests

A manifest is the machine-readable gate between an upstream download and the
canonical food database. The checked-in `.example.json` files are rights and
mapping fixtures, not import-ready releases: `templateOnly` is true and artifact
checksums are intentionally null rather than fabricated.

Before ingestion:

1. Copy the relevant example to a release-specific filename such as
   `usda-fdc-2026-10-15.json`.
2. Revalidate every official URL and term on the acquisition date.
3. Pin the upstream release and raw download URL; stream it to immutable object
   storage and record its real SHA-256 and byte size.
4. Pin the parser version, fill validation expectations, and record the rights
   reviewer/evidence. Set `templateOnly` to false only when complete.
5. Validate against `food-source-manifest.schema.json` and retain the exact manifest
   beside the raw object. The database release row stores both URIs/checksums.

Promotion is blocked when rights are pending, the raw artifact/checksum is missing,
the parser is not pinned, or validation rules fail. Never edit a promoted manifest;
create a new source release.

These fixtures do not replace legal review. See
[`ADR 0001`](../../docs/adr/0001-food-source-rights-and-provenance.md).
