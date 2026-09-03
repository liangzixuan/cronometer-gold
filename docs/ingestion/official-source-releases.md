# Official source release catalogue

Initial research date: 2026-08-15. Latest strict-HTTPS revalidation: 2026-09-03
UTC. This catalogue uses publisher-operated sources only. It records what can
be pinned before an operator acquisition; it does not approve the candidates
for ingestion or replace a rights review.

The current FDC Foundation adapter has also been exercised against the official
April 2026 artifact; see the
[dated parser smoke](./fdc-foundation-2026-04-30-smoke.md). Its locally computed
digest is intentionally not copied into an import-ready manifest without the
independent acquisition and review gates.

## Selected release artifacts

| Candidate | Official release identity | Publisher artifact URL | Publisher size | Integrity status |
| --- | --- | --- | --- | --- |
| USDA Foundation JSON, first slice | FoodData Central 15.0, 2026-04-30; Foundation Foods 04/2026 | [Foundation JSON ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip) | 459K zipped; 6.5M unzipped | No publisher SHA-256 is shown on the release page or artifact response. |
| USDA full CSV, scale target | Historical 2026-04-30 selection: FoodData Central 15.0, Full Download of All Data Types 04/2026; identity of the bytes served after 2026-08-19 is unresolved | [Full CSV ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_csv_2026-04-30.zip) | 460M zipped; 3.1G unzipped | No publisher SHA-256 is shown on the release page or artifact response. |
| Health Canada CNF | Canadian Nutrient File 2026; dataset published 2026-05-14; resource `019f2a90-e3a9-489d-b6e1-f74f4ba1d006` | [CNF aggregate ZIP](https://open.canada.ca/data/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109/resource/019f2a90-e3a9-489d-b6e1-f74f4ba1d006/download/cnf_fcen_all-files-data_2026.zip) | No size declared in portal metadata | The aggregate resource has an empty `hash` and null `size` in official portal metadata. |

"Publisher artifact URL" identifies an authoritative publisher location, not an
immutable object or digest pin. The full-CSV URL has demonstrably served
different bytes, so its currently served content remains unpinned and blocked.

The [FoodData Central download page](https://fdc.nal.usda.gov/download-datasets/)
identifies April 2026 as the current Foundation, Branded, and full-download release.
The same table identifies FNDDS 2021–2023 as the October 2024 release and SR Legacy
as the final April 2018 release. The full archive contains all current data types,
so its contents do not share one source-data vintage.

The official [FoodData Central update log](https://fdc.nal.usda.gov/log/) identifies
the initial selection's major release as FoodData Central 15.0 on 2026-04-30,
matching the day token in both publisher artifact filenames.

The [Open Government dataset record](https://open.canada.ca/data/en/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109)
identifies CNF 2026 and its aggregate resource. Its official
[package metadata API](https://open.canada.ca/data/api/action/package_show?id=1b6139bd-ed7e-4043-bc28-ff00e10f3109)
reports `date_published` 2026-05-14, record creation 2026-05-19, and modification
2026-06-03; it records creation and last modification of the aggregate ZIP resource
on 2026-06-03. Health Canada's [CNF page](https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/nutrient-data/canadian-nutrient-file-about-us.html)
reports 5,993 foods, up to 173 nutrients, bilingual content, and relational CSVs.

## Size observations, not checksums

HTTP observations on 2026-08-15 returned these exact `Content-Length` values:

- FDC Foundation JSON ZIP: 469,303 bytes.
- FDC full CSV ZIP: 481,510,693 bytes.
- CNF aggregate ZIP after the portal redirect: 26,656,195 bytes.

These values help capacity planning and detect obvious later changes, but they are
not canonical manifest byte sizes until a verified acquisition streams the entire
object. FDC ETags and Azure blob ETags are likewise not accepted as content hashes.

### Revalidation on 2026-09-03 UTC

Strict HTTPS `HEAD` observations on 2026-09-03 found the Foundation JSON and CNF
aggregate lengths unchanged at 469,303 and 26,656,195 bytes, with respective
`Last-Modified` dates of 2026-04-29 and 2026-06-03. The full FDC CSV response
reported 481,517,495 bytes and a `Last-Modified` date of 2026-08-19, still
differing from the 481,510,693-byte 2026-08-15 observation above. These headers
are drift detection only, not an acquisition or checksum. Temporary signed CNF
redirect parameters are neither recorded nor treated as artifact identity.

USDA still labels the full download 04/2026, while its update log lists branded
data version 15.4 on 2026-08-20. It is not publisher-confirmed that the changed
archive bytes correspond to that log entry. The full-CSV candidate therefore
remains blocked: preserve the historical observation, make a fresh release-
identity decision, and obtain two matching controlled acquisitions before
pinning or staging new bytes.

The Canadian portal lists 32-character `hash` values for the individual CSV
resources, but it does not identify the algorithm in the dataset response and the
aggregate ZIP has no hash. The ingestion gate therefore does not promote those
values to SHA-256. It downloads the aggregate ZIP twice under distinct operator
identities and records matching locally computed SHA-256 observations.

## Formats and initial scope

FoodData Central publishes both JSON and Excel-compatible CSV archives. The small
Foundation JSON candidate contains one JSON member and is the first executable
slice. It exercises nested nutrient, portion, and provenance parsing without making
the initial run depend on a roughly 460 MB compressed branded catalogue. The full
CSV candidate remains the representative scale target and eventual US catalogue
seed. A database-free `fdc inspect-csv` boundary now enforces a manifest-declared
exact inventory, explicit per-member dispositions and raw-value mappings,
bounded lookup tables, disk-partitioned joins, conservation, and deterministic
baseline evidence. That implementation is proven only with synthetic archives;
the live archive has not been acquired, inventoried, mapped, parsed at scale, or
staged. The checked-in candidate therefore remains intentionally unpinned and
non-executable.

CNF 2026's aggregate ZIP has a fixed nine-CSV ingestion contract. Five tables are
adapter inputs and four are parsed, measured reference-only evidence:

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

The aggregate also contains English and French guides. The import-ready manifest
must name their exact non-CSV archive paths along with the nine CSVs so
`expectedFiles` describes the complete regular-file inventory. Guides are
preflighted and retained as release evidence but are not extracted into the
parser workspace. An additional CSV is schema drift, not documentation.

The implemented `cnf inspect` command verifies a pinned local artifact and
reviewed parser build, strictly parses all nine CSVs, and emits full-inventory,
per-table, conservation, exclusion-reason, and language-partition baselines
without accessing the database. `catalogue stage-cnf` requires an import-ready
manifest and trusted runner, repeats those checks before opening PostgreSQL,
checkpoints staging, and records immutable parser evidence that validation
re-verifies. These paths are covered with synthetic fixtures only; they do not
claim that the published 2026 aggregate has been acquired, baselined, or
activated.

## Rights and attribution

USDA's [official API guide](https://fdc.nal.usda.gov/api-guide/) states that
FoodData Central data are public domain, are published under CC0 1.0, need no use
permission, and requests that products list FoodData Central as the data source.
The candidates retain source IDs and the requested citation even though CC0 does
not require attribution.

The CNF portal assigns the
[Open Government Licence — Canada 2.0](https://open.canada.ca/en/open-government-licence-canada).
That licence permits commercial use, copying, modification, publication,
translation, adaptation, and distribution, subject to source acknowledgement. It
does not grant third-party rights or rights in official marks and does not permit
an implication of government endorsement. Product and export attribution must use
the reviewed fixture in the release manifest.

These are engineering classifications, not legal advice. A named reviewer must
approve the exact product use before either candidate becomes import-ready.

## Remaining validation unknowns

- Neither publisher currently authenticates the selected aggregate artifact with
  SHA-256. Two independent acquisitions are required for every release.
- FDC does not expose a separately numbered download-schema version. The parser
  version and accepted-field snapshot must supply our reproducibility boundary.
- The complete April 2026 full-CSV archive member list and row-count baseline must
  be captured during controlled acquisition; it is intentionally not guessed here.
- Full-CSV ordered headers, observed raw `data_type` and `market_country` values,
  explicit mappings, partition/spool footprint, and peak-memory evidence must be
  captured and reviewed against the real artifact before staging design begins.
- The complete CNF aggregate member list, including exact English/French guide
  paths, and every real-artifact table/parser baseline must be captured and
  independently reviewed during controlled acquisition; the checked-in
  nine-CSV candidate is not that evidence.
- CNF's individual portal hashes need publisher clarification before they can be
  treated as anything stronger than unlabeled metadata.
- Rights review must confirm presentation of CNF attribution in product screens,
  exports, and any future public API.
- Real-CNF staging, parser-scale/peak-memory evidence, immutable storage,
  reviewed nutrient mappings, database reconciliation, high-impact outlier
  review, and search/index evidence remain activation blockers.
