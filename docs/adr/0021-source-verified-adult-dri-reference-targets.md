# ADR 0021: Source-verified adult DRI reference-target candidate

- Status: Accepted as a source-verified candidate for local implementation;
  clinical review, commercial enablement, and controlled-beta acceptance are
  blocked
- Date: 2026-09-07
- Scope: an optional, explicitly applied U.S.–Canada Dietary Reference Intake
  template for eligible adults aged 19 through 50

## Context

ADR 0006 requires nutrient goals to preserve their source and meaning and
rejected automatic DRI selection without a pinned jurisdiction, life-stage
group, and review policy. The product nevertheless needs a bounded way for a
person to copy recognized population reference values into private goals.

The current Health Canada DRI tables distinguish Recommended Dietary Allowances
(RDAs), Adequate Intakes (AIs), Tolerable Upper Intake Levels (ULs), and Chronic
Disease Risk Reduction Intakes (CDRRs). An RDA or AI can be a goal for usual
average intake, but an AI is not equivalent to an RDA. A UL is not a recommended
intake, and absence of a UL is not evidence that unlimited intake is safe.

The tables apply to normal, apparently healthy people eating a typical mixed
North American diet. Values differ by age, sex group, pregnancy, and lactation,
and some have important source footnotes. The profile records birth date and
`sexAtBirth`, but cannot establish pregnancy, lactation, diagnosis, medication,
diet pattern, malabsorption, or sweat-loss status. Silent profile-derived
defaults would make a stronger individualized claim than the data supports.

## Decision

Define one immutable candidate template:

- template code `us-ca-dri-adults-19-50`, version `1`;
- groups `male-19-50` and `female-19-50`;
- source set `health-canada-dri-tables`, version `2025-11-19`;
- title “U.S.–Canada DRI reference values (ages 19–50)”; and
- subtitle “Population reference values for apparently healthy, nonpregnant,
  nonlactating adults; not individualized medical advice.”

The age range combines the official 19–30 and 31–50 rows only because every
included value is identical within each group across those rows. The template
is inapplicable before age 19. Materialization records the person's 51st
birthday as immutable `eligibleThroughExclusive`; reference-template current
reads and further template-backed revision fail closed at that boundary. This
does not rewrite the existing goal root's interval semantics. Extending the
range requires another version and review.

There is no universal adult variant. The user explicitly selects a group, and
the server verifies that effective-date age is 19 through 50 and a locked
profile revision has matching `female` or `male` `sexAtBirth`. Missing,
`intersex`, `not_specified`, mismatched, or stale profile data fails closed for
the template; manual goals remain available. This describes source and profile
limitations, not gender identity or an individualized nutrition classification.

The user previews the complete change. The mutation carries top-level
`expectedOwnerUserId` and `expectedProfileRevision` plus a
`referenceTargetSet` containing the template code/version, group code, and
`eligibilityAcknowledgement: { policyCode, policyVersion, accepted: true }`.
The acknowledgement policy code is
`us-ca-dri-adults-19-50-eligibility-ack`, version `1`. The server enforces that
exact closed shape; client-only state is insufficient. The exact text is:

> I confirm this template’s age/sex group and nonpregnant, nonlactating scope
> apply to me. I understand it may not fit medical conditions, medications,
> clinician-directed diets, current smoking, vegetarian iron needs, or
> unusually high sweat loss, and I can edit or remove it.

Persist only the selected group, template and acknowledgement versions,
profile revision, effective-date age, boolean confirmation, and server time
needed to explain the immutable goal. Do not collect individual condition,
diagnosis, medication, pregnancy, lactation, diet, or smoking answers. Treat
the retained selection and acknowledgement as sensitive profile-derived data:
exclude them from logs and analytics and include them in authenticated export,
erasure, backup, restore, and privacy review.

The server, never the client, materializes the vector by stable nutrient code
under the active nutrient-registry lock. It verifies every definition is active,
targetable, and in the exact canonical unit; any missing code or unit mismatch
aborts the whole write. A reference mutation carries `nutrientTargets: []` and
the closed `referenceTargetSet` selection plus effective-date, energy,
top-level owner/profile, idempotency, and revision preconditions—not numeric
target values.

Every population reference is `targetAmount`, with `minimumAmount` null,
because an RDA or AI is a usual-intake reference rather than a hard daily
minimum. Only an aggregate-compatible UL is `maximumAmount`. Per-target metadata
records `referenceType` (`rda` or `ai`),
`timeBasis: usual-average-daily-intake`, `maximumReferenceType` (`ul` or null),
the exact source page/table, and source version.

| Nutrient code | Unit | Basis | Male | Female | Maximum |
| --- | --- | --- | ---: | ---: | ---: |
| `carbohydrate` | `g` | RDA | 130 | 130 | — |
| `protein` | `g` | RDA | 56 | 46 | — |
| `fiber` | `g` | AI | 38 | 25 | — |
| `sodium` | `mg` | AI | 1500 | 1500 | — |
| `potassium` | `mg` | AI | 3400 | 2600 | — |
| `calcium` | `mg` | RDA | 1000 | 1000 | 2500 UL |
| `iron` | `mg` | RDA | 8 | 18 | 45 UL |
| `vitamin-c` | `mg` | RDA | 90 | 75 | 2000 UL |
| `vitamin-d` | `ug` | RDA | 15 | 15 | 100 UL |
| `vitamin-b12` | `ug` | RDA | 2.4 | 2.4 | — |
| `folate-dfe` | `ug_DFE` | RDA | 400 | 400 | — |
| `vitamin-a-rae` | `ug_RAE` | RDA | 900 | 700 | — |

The existing energy target is preserved exactly. Version 1 omits total fat
because its relevant adult reference is an AMDR percentage of energy, which the
fixed-amount model cannot faithfully express. It omits `sugars` because the
registry represents total sugars while the cited guidance addresses added
sugars. It does not store sodium's 2300 mg CDRR as a maximum because a CDRR is
not a UL. It omits the vitamin A UL because that UL applies only to preformed
vitamin A while `vitamin-a-rae` aggregates retinol and provitamin carotenoids.
It omits the folate UL because that UL applies to synthetic folic acid and is
expressed as folic acid, not DFE. It invents no maximum where a UL is not
determinable.

The following qualification is prominent in the chooser, preview, and goal
detail rather than hidden behind a link:

> This optional template copies U.S.–Canada population reference values into
> your goals. It is for usual intake by apparently healthy adults in the
> selected group, not a diagnosis, prescription, or proof of adequacy. A single
> day above or below a reference does not determine nutrient status.

The interface calls an RDA, AI, UL, and CDRR by its real type. It states that a
UL is not a target or guarantee of safety and does not describe diary results as
“deficient,” “toxic,” “safe,” “normal,” “optimal,” “needed,” or “recommended
for you.” It may say that recorded intake is being compared with the selected
population reference.

The candidate carries these source qualifications:

- pregnancy, lactation, pediatrics, adults over 50, diagnosed deficiencies,
  kidney or cardiac disease, medication-directed electrolyte restrictions,
  malabsorption or bariatric care, eating-disorder care, therapeutic diets,
  clinician-set goals, and athlete sweat replacement are out of scope;
- the potassium AI does not apply when a condition or medication impairs
  potassium excretion, and the feature does not advise supplements or salt
  substitutes;
- the source adds 35 mg/day vitamin C for current smokers;
- the source states iron requirements are 1.8 times higher for vegetarian diets
  because of lower bioavailability, and its female iron row uses population
  menstruation assumptions rather than an individual assessment;
- the vitamin D values assume minimal sun exposure;
- unusually high sweat loss may require individualized sodium intake; and
- total DFE does not establish compliance with separate folic-acid advice for
  people capable of becoming pregnant.

A template application creates an immutable sourced snapshot. Editing a
materialized amount creates another goal version and marks that target as a user
override; it cannot continue claiming the changed value is the exact template
value. Published template version `1` is never mutated. A source change creates
a new immutable version and explicit new preview; existing goals are not
silently upgraded.

Apply and attest migration 0023 first, then deploy the additive API, and only
then expose the chooser in clients. Older/manual goals remain valid with absent
template metadata. Roll back clients or API if needed, but do not reverse the
forward-compatible migration. New
clients interpret absence as manual but reject malformed present metadata. An
older API rejects the new application contract instead of accepting fallback
client-authored values. Legacy clients may display ordinary target fields, but
only a capable client may apply or describe a reference template.

`REFERENCE_TARGETS_ENABLED` is a strict server-side gate and defaults to
`false`. While it is disabled, authenticated discovery returns `404` for
capability negotiation, and create or revise requests carrying a reference
selection return `503` before persistence; manual goal writes and legacy goal
reads remain available. The exact `true` opt-in is permitted only for local and
test evidence. Production configuration rejects that opt-in until the three
reviews below are recorded and a separately reviewed change releases the gate.

This decision authorizes source implementation behind fail-closed gates only.
It is a source-verified candidate, not clinically reviewed functionality and
not commercially enabled. A named registered dietitian or qualified clinical-
science owner must approve the values, units, threshold types, applicability,
qualifications, copy, and test evidence. Legal/privacy review must approve the
intended use and demographic-data treatment. Copyright counsel or the rights
owner must approve commercial use and presentation of source material. Until
all three reviews are recorded, builds must not advertise or enable the template
for controlled-beta or commercial users.

Use product-authored presentation, the minimum necessary numerical facts, and
links/attribution. Do not reproduce source tables or prose, Government of Canada
or NASEM branding or logos, or imply either organization reviewed, endorsed, or
certified this product.

## Sources and versions

The overview and three definition/value table pages were revalidated on
2026-09-07 and each lists 2025-11-19 under “Page details”; version 1 pins that
table-page date as its source-set version. The supplemental report-list page was
also revalidated on 2026-09-07 and lists 2025-10-31 under “Page details”:

- DRI definitions and interpretation:
  <https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables.html>
- macronutrient values:
  <https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html>
- element values:
  <https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html>
- vitamin values:
  <https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html>
- official report/version list:
  <https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/dietary-reference-intake-report-list.html>
- NIH potassium applicability qualification:
  <https://ods.od.nih.gov/factsheets/Potassium-HealthProfessional/>
- NIH iron and vegetarian-diet qualification:
  <https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/>

Per-target source versions are `HC-2025-11-19/IOM-2005` for carbohydrate,
protein, and fiber; `HC-2025-11-19/NASEM-2019` for sodium and potassium;
`HC-2025-11-19/IOM-2011` for calcium and vitamin D;
`HC-2025-11-19/IOM-2001` for iron and vitamin A;
`HC-2025-11-19/IOM-2000` for vitamin C; and
`HC-2025-11-19/IOM-1998` for folate and vitamin B12. The underlying reports are
<https://doi.org/10.17226/10490>, <https://doi.org/10.17226/25353>,
<https://doi.org/10.17226/13050>, <https://doi.org/10.17226/10026>,
<https://doi.org/10.17226/9810>, and <https://doi.org/10.17226/6015>.

Health Canada's terms distinguish non-commercial reproduction from commercial
redistribution and note that some material has third-party copyright:
<https://www.canada.ca/en/transparency/terms.html>. That is a review input, not
a conclusion that commercial use is licensed.

## Consequences

This first useful template is intentionally narrower than the full DRI matrix.
It gives eligible users an explainable starting point without pretending to
personalize clinical nutrition or misrepresenting source-specific upper limits.
Some users must continue to enter clinician-provided or personal goals manually.

Birth date, group selection, acknowledgement, and finite expiry make an
application auditable but add profile, privacy, idempotency, export/erasure, and
mixed-client tests. Server-authoritative materialization prevents a compromised
or stale client from changing a published vector while presenting it as
official.

## Alternatives considered

- **One universal adult template:** rejected because protein, fiber, potassium,
  iron, vitamin C, and vitamin A differ between the two source groups.
- **FDA Daily Values:** rejected because label-comparison values are not a
  substitute for age/life-stage DRI planning references.
- **Infer and apply from the profile:** rejected because the profile cannot
  establish full applicability and consent must be explicit.
- **Treat every upper-looking number as `maximumAmount`:** rejected because
  CDRR and source/form-specific UL semantics are not interchangeable.
- **Copy source tables or wording:** rejected because the product needs original
  presentation and a resolved commercial rights position.
- **Continue past age 50:** rejected because values change and the goal would
  outlive its recorded evidence boundary.

## Review triggers

Review this decision before changing any value, unit, reference type, source
page/version, group, age or life-stage boundary, expiry rule, acknowledgement,
warning, or source presentation; adding pregnancy, lactation, pediatric,
older-adult, diet-pattern, condition, medication, supplement, therapeutic, or
activity-specific variants; representing AMDRs or CDRRs; inferring or
auto-applying a template; modifying profile demographic semantics; sending
reference selections to logs, analytics, notifications, or another principal;
changing export/erasure behavior; or claiming clinical review, government
endorsement, controlled-beta acceptance, or commercial availability.
