# ADR 0071: Remove named nutrient rows from native drafts

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

The native named nutrient composer appends rows, but removing one still requires
editing its numeric-ID line in the canonical text field (ADR 0040).

- User task: remove an unwanted custom-food nutrient row by name. Show current
  parsable draft rows in their existing order, with exact loaded name/unit or an
  explicit nutrient-ID fallback, exact amount or trace/unknown reason, and an
  unambiguous accessible Remove control. Use existing layouts and controls.
- A narrow pure removeCanonicalNutrientInput(value, nutrientId) helper validates
  the entire current input with the unchanged parser, requires a present unique
  exact ID, and removes only that raw line's content including its surrounding
  whitespace. Preserve every LF/CRLF delimiter, blank line and unrelated byte;
  do not normalize, round, convert units, infer names or reserialize other rows.
  Removing the last row may leave an empty draft; existing Save still requires
  at least one row. Existing parser and append behavior remain byte-identical.
- Invalid or duplicate raw input must not offer guessed row removals; show a
  concise explanation directing the user to the existing canonical text field.
  Empty drafts have truthful empty state. Missing/failed named metadata uses an
  explicit ID fallback without disabling otherwise valid manual-row removal.
- A current explicit Remove modifies only canonical nutrient text. Preserve all
  raw food fields, composer/query/entry acknowledgement, create/revision identity
  and exact explicit Save/retry. No automatic append/save, local request, operation
  allocation or queue action. Reuse current draft/composer/private/lifecycle/
  loading/write guards; retain callback identity across edit/restore, replacement
  and refresh. Invalidate a pending Copy/Revise choice through existing draft
  replacement. Do not use stale metadata labels as authority for another row.
- Scope: RetentionScreen.tsx, its existing component suite, custom-food-nutrients
  helper and existing helper suite, this ADR/index, build plan and additive release
  gates. No web, API, schema, storage, dependency or shared-style change. Named
  row editing, full nutrient registry and service/device work are later slices.
- Evidence: compact helper cases prove exact first/middle/last removal, mixed
  delimiters/blank lines/whitespace, states/reasons/zero/precision/legacy IDs and
  invalid/duplicate/absent targets. Component cases prove known/fallback labels,
  invalid/empty states, raw preservation, last-row recovery, unavailable metadata,
  current callbacks/private/busy guards and exact explicit Save/retry with the
  unfinished-entry protection intact. Focused tests/types/format and independent
  source review precede frozen canonical check/build/licenses and both native
  exports, followed by final staged review.
- Stop after source/local gates, authorized normal commit/non-force push, exact
  automatic observation and dated readiness. Native hook/host and export proof
  does not establish all concurrent React interleavings, physical-device or
  assistive behavior, real persistence/protected storage, external Claude Code,
  hosted or release acceptance. No browser/service/cloud/workflow/device action.

## Decision and consequences

Use the canonical text as the authority and add deliberate removal without
replacing the manual editor. Preserve line delimiters even for the removed row;
an empty line is preferable to changing unrelated raw formatting. Full validation
before removal avoids guessing through malformed or duplicate input. Revisit if
canonical syntax, metadata ownership, acknowledgement or save semantics change.

## Local evidence and limits (2026-09-14)

Native drafts now show current parsed nutrient rows with exact loaded names/units
or explicit ID fallbacks and distinct Remove controls. Invalid or duplicate input
keeps manual recovery, and empty drafts have an empty state. Removal validates
the entire current input and deletes only the selected raw line content, retaining
every delimiter and unrelated byte. The original parser and append are unchanged.

Current draft/composer/metadata/private/lifecycle/write guards protect retained
callbacks. Removal preserves raw food fields, composer/filter/acknowledgement and
exact explicit Save/retry. Last-row removal leaves a draft that must regain a row
before Save. Focused helper/component checks, affected types/format and independent
source review passed; no local request, operation or queue action was introduced.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1488 native tests plus 10 runner checks, 1008 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Native hook/host and export proof does not
establish rendered-device or assistive behavior, every concurrent React interleaving,
real persistence/protected storage, external Claude Code, hosted or release
acceptance. No browser or service was used for this native-only behavior change.
