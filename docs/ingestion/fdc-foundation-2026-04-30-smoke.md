# FDC Foundation April 2026 parser smoke

On 2026-08-15, the operator CLI inspected a locally held copy of the official
USDA FoodData Central Foundation JSON April 2026 ZIP. This is engineering smoke
evidence, not a publisher checksum, rights approval, independent acquisition
attestation, or production-promotion authorization.

Observed artifact:

- bytes: `469303`
- locally computed SHA-256:
  `186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a`
- expected archive member:
  `FoodData_Central_foundation_food_json_2026-04-30.json`

Deterministic parser result:

- accepted food records: `363`
- quarantined top-level literal-null records: `32`
- granular nutrient exclusions: `10` (negative source amounts; never coerced)
- granular portion exclusions: `0`
- ordered accepted-source-payload digest:
  `dcf29c40425720c1e305f3798786fea9bcac7e2d662e26a3b861157519c4bd18`

The raw ZIP and extraction output remain under ignored local or controlled object
storage. They are not committed to Git. A promotable manifest still requires a
second fresh acquisition by a distinct authenticated principal, matching bytes,
rights review, a pinned parser build, reviewed nutrient mappings, and three
digest-bound release approvals.
