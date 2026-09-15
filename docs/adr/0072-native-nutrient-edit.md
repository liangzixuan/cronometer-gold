# ADR 0072: Edit named nutrient rows in native drafts

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

The native draft now exposes named rows and Remove, but correcting a value still
requires numeric-ID text editing or removal and re-addition that changes order.

- User task: Edit a current parsed row by name or explicit ID fallback, load its
  exact amount/state/reason into the existing composer with a fixed captured ID,
  and explicitly Apply to update that row in place. Use existing layout/controls;
  distinguish editing from adding. Names/units come only from current metadata.
  Missing or failed metadata still permits ID-based edits with truthful labels.
- A pure replaceCanonicalNutrientInput(value, nutrientId, candidate) validates the
  entire input and strict candidate, requires a present unique exact target ID
  matching the candidate, and changes only the selected raw line content. Preserve
  its position, every LF/CRLF delimiter, blank line and unrelated byte. Matching
  parsed state and exact decimal string/reason returns the original text including
  selected whitespace; 0 and 0.00 remain distinct strings. No conversion, rounding,
  remove/reappend or unrelated serialization. Retain existing 256-row/200-character
  amount validation without inventing an overall raw-text limit. Original parser,
  append and removal behavior remain byte-identical.
- Entering or switching Edit must not discard unfinished composer input or a
  pending row edit. Explain Add/Apply-or-clear recovery and preserve all scratch.
  Repeating Edit for the current row is a no-op. Any active edit requires Apply or
  Clear before Save, including unchanged loaded values. Successful Apply acknowledges
  the entry and exits editing; same-value Apply changes no canonical bytes. Clear
  exits editing without modifying canonical rows and preserves the filter query.
- Bind edit identity to the captured target/source and current registry receipt.
  A later raw edit, remove/re-add, or edit/restore must not let a new or retained
  Apply overwrite a changed target. Preserve stale scratch for clear/recovery.
  Current draft/composer/private/lifecycle/loading/write guards remain authoritative;
  reset/replacement/private/success paths clear edit identity synchronously. Retain
  exact explicit Save/retry and unfinished Add protection. No local requests,
  operation allocation, queue action, auto-add or auto-save from Edit/Apply/Clear.
- Preserve other raw food fields, filter, canonical rows and create/revision
  identity. Invalid/duplicate text offers manual recovery without guessed row
  controls. Pending Copy/Revise choices are invalidated by current edit activity
  through existing guards; current Keep/Discard semantics remain intact.
- Scope: RetentionScreen.tsx and its existing component suite, custom-food-nutrients
  helper and existing helper suite, this ADR/index, build plan and additive release
  gates. No web, API, schema, storage, dependency, shared style, full registry or
  browser/service/device/cloud change. Root owns integration and delivery.
- Evidence: compact helper cases for exact no-op and first/middle/last replacement,
  mixed delimiters, raw precision/states/reasons/legacy IDs, mismatch/absent/invalid/
  duplicate rejection and existing boundaries. Component cases for exact Edit/Apply/
  Save and retry, unchanged edit Save protection, scratch/switch/clear/no-op behavior,
  fallback metadata, stale target/source/registry/private/lifecycle/write controls
  and no local operations. Extend existing boundary cases where practical. Focused
  tests/types/format and independent source review precede frozen canonical
  check/build/licenses and both native exports, followed by final staged review.
- Stop after source/local gates, authorized normal commit/non-force push, exact
  automatic observation and dated readiness. Native synchronous hook/host tests
  and exports do not establish every concurrent React interleaving, device layout,
  assistive behavior, real persistence/protected storage, external Claude Code,
  hosted or release acceptance. No successor implementation in this slice.

## Decision and consequences

Keep the canonical draft authoritative while the composer holds an explicit edit.
Apply changes one validated raw row; Clear abandons only composer work. Requiring
resolution before another edit or Save avoids silent omission. Captured source
identity prevents stale edits overwriting later manual work. Revisit when canonical
syntax, composer acknowledgement, metadata ownership or save semantics change.

## Local evidence and limits (2026-09-14)

Native draft rows now offer fixed-ID Edit and explicit Apply through the composer,
using current names/units or an explicit ID fallback. Replacement validates the
whole draft and candidate, keeps row position and every delimiter/unrelated byte,
and returns original raw text when parsed values are unchanged. Exact decimal
strings remain distinct; original parser, append and removal stay unchanged.

Active edits require Apply or Clear before Save or switching rows. Repeating Edit
preserves scratch; Clear exits without canonical mutation. Captured target/source
and current registry/private/lifecycle/write guards reject stale callbacks while
other raw fields, filter and explicit Save/retry retain their existing semantics.
Focused helper/component checks, affected types/format and independent source
review passed. Edit/Apply/Clear introduce no local requests, operations or queue.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1509 native tests plus 10 runner checks, 1008 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Native hook/host and export proof does not
establish rendered-device or assistive behavior, every concurrent React interleaving,
real persistence/protected storage, external Claude Code, hosted or release
acceptance. No browser or service was used for this native-only behavior change.
