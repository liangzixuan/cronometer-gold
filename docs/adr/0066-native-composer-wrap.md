# ADR 0066: Wrap native named nutrient choices

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

Native custom-food nutrient choices show complete names and units in ordinary
chips. Long labels lack the width bound already used by nearby trend choices.

- User task: read a long nutrient name and unit before selecting it. Enable the
  existing ChipRow wrapLabels option on the named nutrient composer only.
  Reuse maxWidth: 100%, minWidth: 0 and flexShrink: 1; retain the full Text label
  without a new line cap, ellipsis, abbreviation, conversion or inferred unit.
- Preserve exact labels, IDs, loaded order, radio selection/disabled state,
  search/Clear, raw amount/state/reason, canonical text, explicit Add/save and
  all existing private/registry/lifecycle, request, operation and queue behavior.
  This is one presentation prop; change no handler, controller or shared style.
- Scope: RetentionScreen.tsx, the existing custom-food-nutrient-composer suite,
  this ADR/index, build plan and additive release gates. No web, helper, API,
  parser, schema, dependency, storage or remote-search change.
- Evidence: one compact component case covers a maximum-length name/unit,
  complete labels and wrapping styles, duplicate names with distinct units/IDs,
  source order, selected state and exact-ID explicit Add. Filtering/Clear and
  local selection preserve raw input and issue no requests or queue operations.
  Reuse existing guards/retries; affected types/format and independent review,
  followed by frozen canonical pnpm check/build/licenses and native exports.
- Stop after source/local gates and final review, normal commit/non-force push,
  exact automatic observation and dated readiness. Hook/host and export proof
  does not establish physical-device layout, assistive technology, every
  concurrent React interleaving, real persistence, external Claude Code, hosted
  or release acceptance. No browser surrogate or device/cloud action is needed.

## Decision

Reuse the existing wrapping option for this picker. Keep label content and
selection behavior intact. Revisit if the shared chip layout or label policy
changes; physical-device acceptance remains a separate gate.

## Local evidence and limits (2026-09-14)

Production enables one existing wrapLabels prop. Every other production byte,
including labels, callbacks and shared styles, remains unchanged. Focused
component/helper checks, types/format and independent source review passed:
maximum-length name/unit text, source order and selected IDs remain intact,
wrapping styles apply, and explicit Add uses the selected exact nutrient ID.
Search/Clear and local selection retain raw values without requests or queues.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1441 native tests plus 10 runner checks, 993 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source hashes, reviews and automatic observations are
recorded in Windows readiness outside Git. Hook/host, style and export evidence
does not prove physical layout, assistive technology, every concurrent React
interleaving, real persistence, external Claude Code, hosted or release acceptance.
No browser or service was used for this native-only presentation change.
