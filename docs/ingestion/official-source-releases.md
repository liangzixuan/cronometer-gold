# Official source release catalogue

Research status: 2026-08-15. This catalogue uses publisher-operated sources only.
It records what can be pinned before an operator acquisition; it does not approve
the candidates for ingestion or replace a rights review.

The current FDC Foundation adapter has also been exercised against the official
April 2026 artifact; see the
[dated parser smoke](./fdc-foundation-2026-04-30-smoke.md). Its locally computed
digest is intentionally not copied into an import-ready manifest without the
independent acquisition and review gates.

## Selected release artifacts

| Candidate | Official release identity | Durable official artifact | Publisher size | Integrity status |
| --- | --- | --- | --- | --- |
| USDA Foundation JSON, first slice | FoodData Central 15.0, 2026-04-30; Foundation Foods 04/2026 | [Foundation JSON ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip) | 459K zipped; 6.5M unzipped | No publisher SHA-256 is shown on the release page or artifact response. |
| USDA full CSV, scale target | FoodData Central 15.0, 2026-04-30; Full Download of All Data Types 04/2026 | [Full CSV ZIP](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_csv_2026-04-30.zip) | 460M zipped; 3.1G unzipped | No publisher SHA-256 is shown on the release page or artifact response. |
| Health Canada CNF | Canadian Nutrient File 2026; dataset published 2026-05-14; resource `019f2a90-e3a9-489d-b6e1-f74f4ba1d006` | [CNF aggregate ZIP](https://open.canada.ca/data/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109/resource/019f2a90-e3a9-489d-b6e1-f74f4ba1d006/download/cnf_fcen_all-files-data_2026.zip) | No size declared in portal metadata | The aggregate resource has an empty `hash` and null `size` in official portal metadata. |

The [FoodData Central download page](https://fdc.nal.usda.gov/download-datasets/)
identifies April 2026 as the current Foundation, Branded, and full-download release.
The same table identifies FNDDS 2021–2023 as the October 2024 release and SR Legacy
as the final April 2018 release. The full archive contains all current data types,
so its contents do not share one source-data vintage.

The official [FoodData Central update log](https://fdc.nal.usda.gov/log/) identifies
the major release as FoodData Central 15.0 on 2026-04-30, matching the day token in
both publisher artifact filenames.

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
CSV candidate remains the representative scale test and eventual US catalogue seed.

CNF 2026's aggregate ZIP contains nine relational CSV data files used by ingestion:

- `Food_Name.csv`, `Food_Source.csv`, and `CNF_Food_Group.csv`;
- `Nutrient_Amount.csv`, `Nutrient_Name.csv`, and `Nutrient_Source.csv`;
- `Measure_Weight_Conversion.csv`, `Measure_Type.csv`, and `Measure_Name.csv`.

The archive also contains English and French guides. Documentation is retained as
release evidence but is not parsed into catalogue records.

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
- CNF's individual portal hashes need publisher clarification before they can be
  treated as anything stronger than unlabeled metadata.
- Rights review must confirm presentation of CNF attribution in product screens,
  exports, and any future public API.
