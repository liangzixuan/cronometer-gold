# ADR 0065: Clear the native named nutrient filter

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context

The native custom-food named nutrient composer has local name search and a
matching count. A no-match query currently requires deleting the text manually
before browsing available nutrients again. Other local filters already expose Clear.

## Acceptance card

- User task: restore all currently available named nutrient choices with an
  explicit Clear nutrient filter button next to the existing search field.
  Reuse the existing secondary Button and composerDisabled state.
- Route Clear through changeComposer({ query: "" }). Preserve the selected
  nutrient ID, raw amount, state, unknown reason and canonical manual nutrient
  text, other editors, loaded data, and explicit Add/save/retry behavior.
  Use the existing query-edit feedback and copy-choice invalidation behavior.
  Clear with an empty query is the existing true no-op.
- Restore the existing available list in its existing order with exact IDs,
  labels and units. Do not select or add a nutrient automatically. Clearing a
  filter issues no request, domain write, operation allocation or queue mutation.
- Reuse current composer/private/registry/lifecycle guards. Pending saves,
  unavailable or refreshing metadata, stale callbacks, private-context changes
  and hidden/unmounted state must not admit a retained Clear callback. Do not
  add a new controller or change the existing query transition to achieve this.
  This local composer has no new profile-zone policy.
- Scope: RetentionScreen.tsx, its existing component suite, this ADR/index,
  build plan and additive release gates. No web, helper, API, schema, parser,
  dependency, storage, remote search or background behavior change.
- Evidence: compact meaningful component cases for no-match recovery, exact
  draft/selection/state/reason preservation, empty-query no-op and stale/private/
  pending-save rejection. Extend/reuse existing ownership and retry cases where
  possible. Focused checks, affected types/format, independent source review,
  frozen canonical pnpm check/build/licenses and native exports.
- Stop: reviewed source and applicable local gates pass; normal commit and
  non-force push, exact automatic observation and dated readiness recorded.
  Hook/host tests and exports do not prove physical-device layout, assistive
  technology, every concurrent React interleaving, real persistence/protected
  storage, external Claude Code, hosted or release acceptance. No browser
  surrogate or device/cloud action is needed for this native-only slice.

## Decision and consequences

Add one explicit reset action through the existing guarded query transition.
The action improves recovery from an empty search result without introducing
another state protocol. Revisit if search becomes remote or persisted, or if
the composer contract changes.

## Local evidence and limits (2026-09-14)

Production changes add one secondary button using the existing composerDisabled
state and changeComposer query transition. Existing guard/controller functions
remain unchanged. Focused component/helper checks, affected types/format and
independent source review passed. Clear restores available choices and preserves
the selected nutrient, raw amount/state/reason, canonical text and other drafts.
Empty Clear is a no-op; current/stale/private/pending-save and exact retry
behavior retain their existing guards. Only explicit Add or save changes the
corresponding draft or remote data.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1440 native tests plus 10 runner checks, 993 web tests,
157 root checks, both native exports and production Next. Zero cached
tasks; 535 production licenses with 14 reviewed exceptions;
89 optional integration cases remained skipped.

Exact commands, times, versions, hashes, reviews and automatic observations are
recorded in Windows readiness outside Git. No browser or service was needed.
Native hook/host and export evidence does not prove physical-device layout,
assistive technology, every concurrent React interleaving, real persistence or
protected storage, external Claude Code, hosted or release acceptance.
