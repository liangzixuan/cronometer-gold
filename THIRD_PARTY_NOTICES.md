# Third-Party Notices

This inventory is a release gate, not a substitute for the license text shipped
with each dependency or dataset. The lockfile and source manifests are the
auditable record of the exact versions used.

## Application dependencies

The initial foundation uses permissively licensed tools including TypeScript,
Fastify, Next.js, React, React Native/Expo, Kysely, Vitest, Biome, and supporting
packages. CI must regenerate and review the production dependency license list
before a release.

The initial dependency graph also contains reviewed transitive exceptions:
platform sharp/libvips binaries under LGPL-3.0-or-later, unmodified
`lightningcss` components under MPL-2.0, and `caniuse-lite` data under CC-BY-4.0.
Their notice, attribution, source/relinking, and modification obligations remain
a release gate; the automated policy is recorded in `config/license-policy.json`.

The sharp/libvips 1.3.4 platform packages retain their upstream
LGPL-3.0-or-later classification. Their bundled library notices list Cairo
1.18.6 under MPL-1.1. Preserve those notices and review the complete binary
bundle's distribution, source and relinking obligations before release.

## Food data

- USDA FoodData Central: public-domain/CC0 source; attribution is retained as a
  product trust and provenance requirement.
- Canadian Nutrient File: use is conditional on the exact release terms recorded
  in `data/manifests/cnf.json` and approval before ingestion.
- Open Food Facts: ODbL data must remain behind the documented isolated boundary;
  it is not part of the initial canonical store without legal review.
- Cronometer CRDB, CFCD, copy, assets, and proprietary data are not inputs.

## Release rule

No dependency, dataset, model, font, image, or copied text may enter a release
without a version, source, license classification, and owner in the provenance
inventory.
