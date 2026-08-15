# ADR 0001: Food-source rights and provenance

- Status: Accepted with a per-release legal/rights gate
- Date: 2026-08-15
- Owners: Product, data engineering, legal/privacy reviewer

## Context

The food corpus is both scientific input and licensed material. Nutrient values,
servings, names, barcodes, images, and the database as a collection can have
different rights. Similar food names do not establish that two records are the
same, and combining databases can change the obligations of the resulting work.
An upstream API response is not evidence that commercial storage or redistribution
is permitted.

## Decision

1. Every provider has a `food_source` registry row and every acquired artifact has
   an immutable `food_source_release` row. No food, serving, barcode, or nutrient
   value is publishable without that chain.
2. Every import begins with a checked-in manifest matching
   `data/manifests/food-source-manifest.schema.json`. The actual artifact checksum,
   size, terms snapshot, parser version, validation result, and acquisition time
   are recorded before promotion.
3. A source is inactive by default. Promotion requires an `approved` or explicitly
   `restricted` rights review, documented attribution, and confirmation of
   commercial-use and redistribution terms for the planned product behavior.
4. USDA FoodData Central is the initial US generic/branded seed. Its data are
   treated as CC0/public-domain material, while the product still displays the
   USDA-requested citation and retains source IDs.
5. Canadian Nutrient File 2026 is the Canadian generic complement. It remains in
   its own source namespace and carries the Open Government Licence — Canada
   attribution. The exact commercial presentation and attribution fixture must
   pass the release review.
6. Open Food Facts is not blended into the canonical FDC/CNF database until
   counsel resolves ODbL database/share-alike effects for the intended schema,
   search index, API, and exports. If evaluated, it uses separate tables/indexes
   and an independently removable projection.
7. NCCDB, Cronometer CRDB/CFCD, scraped competitor content, and any provider whose
   contract does not expressly allow the intended use are blocked. User access to
   a product never implies a right to ingest its database.
8. Cross-source deduplication is a reversible identity mapping, not destructive
   row merging. Original records and provenance remain addressable.
9. Missing nutrient data stays unknown. Importers must not convert absence into
   numeric zero.

This is an engineering control, not legal advice. A qualified reviewer owns the
rights decision for each source and major product-use change.

## Consequences

- Imports take more work, but any displayed value can identify source, release,
  transformation, and basis.
- Search can group equivalent-looking foods while details and exports retain the
  source boundary.
- A source can be disabled and its projection removed without corrupting diary
  snapshots.
- Raw artifacts and terms snapshots require versioned object storage and retention.
- Paid data procurement remains possible without replacing the canonical model.

## Rejected alternatives

- A single denormalized food table loses licence and release boundaries.
- Live provider calls make history irreproducible and availability vendor-bound.
- Name-based destructive merging makes corrections and source removal unsafe.
- “Publicly reachable” or “on GitHub” is not an acceptable rights classification.

## Review triggers

- A new source, country, media type, barcode supplier, or user-submitted catalogue.
- Export, public API, model-training, or data-licensing functionality.
- Changed upstream terms or a provider takedown request.
- Any proposal to mix an ODbL/copyleft database with a proprietary catalogue.
