# ADR 0006: Versioned recipes and explainable nutrition goals

- Status: Accepted
- Date: 2026-08-16
- Owners: Product, domain engineering, clinical/scientific review

## Context

Recipes combine mutable catalogue facts, portion conversions, preparation yield,
and incomplete nutrient panels. Nutrition goals add a second kind of mutable
input: a selected target or an estimate derived from a person's profile. If
either is recalculated from current data, historical diary totals and goal
comparisons can change silently.

Energy estimates also have a narrower evidence boundary than their familiar UI
labels imply. The original Mifflin–St Jeor resting-energy equation was derived
from 498 healthy adults aged 19 through 78. FAO defines physical activity level
(PAL) as 24-hour total energy expenditure divided by BMR; PAL already represents
habitual total activity rather than an activity baseline to which ordinary
exercise should automatically be added.

## Decision

### Recipe revisions

1. A recipe has a stable owner-scoped root and immutable numbered revisions.
   Changing its name, ingredients, yield, serving count, or calculation inputs
   creates a new revision and advances the root pointer atomically.
2. Every ingredient references an exact food version or an exact nested-recipe
   version. Ingredient mass is resolved to grams before calculation and stored;
   unit ambiguity is rejected rather than guessed.
3. A revision has at most 50 ingredients and nested resolution has a maximum
   depth of 10. The database and domain layer both reject cycles and cross-owner
   nested recipes. Coverage-counter fan-out must remain an exact signed 32-bit
   integer; repeated nesting that exceeds that bound is rejected before
   persistence rather than saturated or exposed as a server error.
4. Final yield grams are required and identified as measured or estimated.
   Yield changes concentration, not total nutrient mass. Serving count is
   optional; logging by serving is available only when it exists.
5. Retention factors default to exactly one and that assumption remains visible.
   A future reviewed retention dataset must be named and versioned rather than
   silently replacing the default.
6. Calculation preserves quantified zero, trace, and reason-counted unknown
   contributions. It returns a known lower bound plus coverage metadata and
   visible warnings for estimated or implausible yield and incomplete nutrients.
7. A diary recipe entry pins the exact recipe revision, resolved portion,
   calculation-engine version, recipe warnings, and immutable nutrient vector.
   Later recipe edits cannot rewrite the entry.

The calculation is:

```text
recipe nutrient total =
  sum((ingredient grams / 100) * ingredient nutrient per 100 g * retention factor)

per 100 g = recipe nutrient total / final yield grams * 100
per serving = recipe nutrient total / serving count
```

### Goal revisions

1. A nutrition goal is a versioned user-owned root with explicit effective
   dates. A comparison selects the goal that was active for that local date and
   never rewrites the diary or a prior goal revision.
2. Fixed daily energy targets are available to every supported profile.
3. An optional adult estimate uses Mifflin–St Jeor only when age is 19 through
   78, weight and height are present, and the user has explicitly selected the
   equation's male or female constant. No value is inferred from a name or other
   gender text. In every other profile state, derived mode fails closed and the
   user may choose a fixed target.
4. The resting-energy estimate is:

   ```text
   REE = 10 * weight_kg + 6.25 * height_cm - 5 * age_years + constant
   constant = 5 (male equation) or -161 (female equation)
   ```

   The PAL-total estimate is `estimated TEE = REE * PAL`. PAL must be selected
   explicitly within the reviewed sustained-adult range 1.40 through 2.40. The
   result does not automatically add ordinary logged exercise a second time.
5. Every derived result snapshots equation code/version, source URL, input
   values, PAL value/category, calculation date, assumptions, and rationale. UI
   copy calls it an estimate, not a measured metabolism or prescription.
6. Nutrient minimum, target, and maximum amounts are user-supplied, use the
   nutrient's canonical unit, and carry an explicit source label/version. The
   initial product does not invent DRI defaults or conflate RDA/AI goals with UL
   limits.
7. Progress reports known intake as a lower bound when any contributing food or
   recipe is trace or unknown. They do not serialize a reassuring percent as
   fact for incomplete data. Minimum, maximum, and range targets retain distinct
   status semantics.
8. A revision has at most 256 nutrient targets. Recipe, goal, and progress
   responses are private and `Cache-Control: no-store`.

Mutations require UUID-bound idempotency and revisions use strong optimistic
preconditions. Ownership is enforced in PostgreSQL-backed repositories, not by
accepting caller-supplied owner IDs.

## Sources and applicability

- Mifflin MD et al., “A new predictive equation for resting energy expenditure
  in healthy individuals,” 1990, PMID 2305711:
  <https://pubmed.ncbi.nlm.nih.gov/2305711/>
- FAO/WHO/UNU, *Human energy requirements*, definitions and adult PAL
  classification: <https://www.fao.org/4/y5686e/y5686e04.htm> and
  <https://www.fao.org/4/y5686e/y5686e07.htm>

This is a general-wellness estimate. Pediatrics, pregnancy/lactation,
clinician-set therapeutic targets, eating-disorder interventions, disease-based
recommendations, and automatic DRI selection remain outside this decision and
require separate scientific, clinical, legal, and UX review.

## Consequences

- Recipe edits consume more storage but remain reproducible and safe for diary
  history.
- Users must provide explicit yield and goal assumptions; the product cannot
  hide uncertainty behind convenient defaults.
- Nested recipes require bounded graph validation and coherent version reads.
- Daily progress can be incomplete even when its known amount looks high.
- Derived energy depends on current profile inputs at revision creation, but the
  resulting snapshot does not change when the profile changes later.

## Rejected alternatives

- Recalculating historical entries from a recipe's current ingredients silently
  changes logged nutrition.
- Treating missing ingredient nutrients as zero produces false completeness.
- Adding logged workouts to a PAL-total estimate double counts habitual activity.
- Automatically selecting DRI targets without a pinned jurisdiction, table,
  life-stage group, and clinical policy creates misleading recommendations.
- An unrestricted recursive recipe graph can exhaust request and database
  resources even when it contains no simple cycle.

## Review triggers

- Addition of a retention-factor dataset or cooking/preparation model.
- Shared or collaborative recipes across owners.
- A different energy equation, component-mode expenditure, wearable adjustment,
  or automatic calorie adaptation.
- Automatic jurisdiction-specific reference targets or any therapeutic target.
- Raising ingredient, nesting, or target limits, or extracting recipes/goals
  from the modular monolith.
