# ADR 0031: Recipe nutrition basis and coverage

Status: Source complete; local validation passed; automatic and release evidence pending.

## Context

Saved recipes already contain immutable nutrient vectors per 100 g and, when
servings are defined, per serving. The editors silently choose one vector. Their
amount presentation can make unknown contributions look like a measured zero,
and the mobile display does not identify its basis. The existing diary formatter
already preserves unknown, partial, trace and quantified-zero distinctions.

## Acceptance card

- User task: inspect the nutrition of an exact saved recipe version and compare
  its existing per-serving and per-100 g values on web and mobile.
- Observable result: an explicit selected basis and saved version label; serving
  defaults when available, otherwise only per 100 g. Changing recipes or saved
  versions resets to that default. Existing amounts and coverage qualifications
  render through each client's `nutrientDisplay` helper without new calculations.
- Boundaries: unsaved ingredient/yield edits and diary logging quantity do not
  change the saved nutrition display. Preserve attribution, retention warnings,
  private owner/session fences, stable save retries and exact-version log payloads.
  Retained controls from a previous selection or session cannot alter the new view.
- Affected surfaces: web and native recipe editors and actual-component state
  regressions. No API, schema, dependency or persisted data changes.
- Exclusions: live catalogue, inferred nutrition, nutrition advice, arbitrary
  portion calculations, cloud services, phone exposure and release enablement.
- Required evidence: focused actual-component tests for both vectors, no-serving
  recipes, measured zero/unknown/partial/trace, selection/version/session changes,
  unchanged save/log semantics and no network writes from display controls;
  independent in-task review; canonical `pnpm check`, `pnpm build`, applicable
  license/config/dependency gates and fresh native exports; bounded synthetic
  web/BFF Chrome visual QA with its fixture limitations recorded separately.
- Stop condition: reviewed source and passing applicable local gates, normal
  commit/push under standing authorization, and exact automatic check states
  recorded. Physical native, assistive-technology, independent Claude Code,
  hosted and release acceptance remain separate.

## Decision

Reuse the saved vectors and the existing client-local nutrient formatter. Expose
basis controls only for available vectors, bind their state to the selected saved
recipe, and identify that unsaved edits are excluded. Keep selection in memory
and separate from both the editable builder and diary logging quantity.

## Consequences

The same unknown, lower-bound and measured-zero vocabulary used in the diary
will be visible in recipe inspection. No conversion, rounding, nutrient inference
or mutation is introduced. Source harnesses and exported native bundles do not
prove native rendering, device lifecycle or screen-reader acceptance.

## Alternatives

Recomputing from the builder would introduce an unsaved calculation contract and
new correctness obligations. A single implicit vector cannot support comparison.
A new shared formatter package is unnecessary for this bounded presentation change.

## Review triggers

Revisit this decision before live draft calculations, new portion bases, formatter
semantics, persistence, nutrition guidance, or changes to saved-vector contracts.

## Local checkpoint (2026-09-10)

Independent in-task review found no remaining actionable source issue. Final
canonical checks passed with 438 web and 649 mobile tests (including 10 native
runner tests), plus 157 root policy tests. Type/test graphs passed 17/17 with
15 cached tasks each. Build passed 11/11 with 9 cached and fresh web/iOS/Android
outputs. Dependency/config and license policy passed. Synthetic production
Next/BFF Chrome QA verified both bases, saved/draft/log separation, no-serving
recipes, keyboard selection, long-label wrapping at 390 px, and expiry closure.
It performs no real API/database integration or saved-recipe/log mutation.
Actual-component regressions preserve those existing payload/retry contracts.
Exact automatic status and independent Claude Code/release acceptance remain
separate; no production, hosted or physical-device approval is implied.
