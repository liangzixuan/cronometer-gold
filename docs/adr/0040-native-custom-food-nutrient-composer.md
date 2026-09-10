# ADR 0040: Compose named nutrient rows for native custom foods

Status: Source complete; local native component validation and exports passed; automatic, independent and release acceptance pending.

## Context

Native custom-food editing currently requires numeric-ID canonical nutrient lines.
The workspace already loads a named targetable nutrient registry, and web exposes
named nutrient/state/amount controls. The existing targetable registry excludes
energy and is not the complete nutrient registry, so replacing the canonical text
editor would remove an existing way to enter calories and other nutrient IDs.

## Acceptance card

- User task: choose an available nutrient by name/unit, explicitly enter its
  quantified amount per 100 g or select trace/unknown, and add that row to the
  current custom-food draft before choosing Create private food or Save new version.
- Observable result: a separate named-row composer in the native custom-food
  section, with visible name/unit, explicit quantified/trace/unknown state, exact
  amount and the four existing unknown reasons. Amount and unknown reason start
  unchosen; require an explicit reason for unknown. No default
  measured zero, guessed quantity, unit conversion or nutrition arithmetic.
  Every loaded picker nutrient remains reachable; a bounded displayed subset must
  have a local name filter and truthful result guidance. Picker edits and Add are
  local only, without requests or an implicit save. Retain name/unit and per-100-g
  meaning in accessible labels. Use existing wrapping native layout primitives.
- Lossless compatibility: canonical text remains the authoritative existing
  editor and manual edit/remove path. Explain that the named picker is incomplete,
  including energy, and retain existing/manual numeric-ID rows. Explicit Add
  appends one validated line without rewriting any existing byte, order, whitespace,
  newline, exact decimal or unknown reason. Empty or failed picker loading must
  not remove the manual path or require picker membership for manual IDs.
  No named overwrite/update/remove is
  included; duplicate choices are rejected with actionable local feedback.
- Validation: move the existing canonical parser unchanged to a focused helper,
  keeping its old screen export compatible. Append accepts an empty/whitespace
  draft or a fully valid existing draft, an available selected ID and one valid
  contract row. Reject malformed existing text, malformed candidate/state fields,
  unknown picker IDs, duplicate IDs, more than 256 rows or over 12,000 resulting
  text characters without changing the draft. Existing parser numeric IDs,
  200-character exact nonnegative decimals and 1–256 distinct rows remain unchanged.
  Preserve explicit zero, trace and all four unknown reasons as separate states.
- Independence: composer search/selection/state/amount/reason does not mutate
  canonical text until Add, overwrite shared action status, alter other custom
  metadata or unrelated retention/log/trend/reminder/health/privacy state, or
  change stored mutation body/key. Add changes only canonical text and its own
  local status/draft. Successful Add clears the entered amount for the next row;
  switching to another custom draft or cancelling clears the composer.
- Custom-editor lifecycle: use current owner/session/API and installed scope,
  mounted/foreground and closure guards for the new composer and its custom draft
  actions. Pass existing owner ID/session epoch from HealthRoute without remounting
  unrelated retention flows. Reject retained stale input/choice/Add/Save/Revise/
  Cancel callbacks, same-render double actions and late custom-save responses.
  Hide/reset old custom/composer values before replacement scope effects install;
  loading, busy, background, closed or invalid scope cannot append/save. Same-value
  local actions must not strand current controls. Preserve an unchanged uncertain
  save's exact body/key through transport or malformed success receipts until
  valid custom acceptance. A different serialized draft body uses its existing
  distinct operation identity; an unchanged unresolved body retains its exact retry
  body/key, including edits away and back. Draft generations fence stale controls
  without rotating unresolved save identity. A stale success,
  failure or finally cannot clear a later draft or overwrite its busy/status state.
  Scope changes clear obsolete custom retry ownership without changing other
  operation families. A current 401 closes custom work before async cleanup.
- Bounded integration: guard only custom editing/saving, its loaded-food list
  installation/paging and the composer seams needed for this feature. Old-owner
  pages cannot append into a newly installed list. A deferred registry read that
  cannot install across background has explicit Refresh private data recovery,
  preserving manual draft text. Require the actual active foreground state.
  Reuse existing stable save request/receipt contracts
  and selected version/revision semantics; do not rewrite unrelated controllers,
  queued diary logging, archive, reminders, biometrics or erasure flows. New disabled
  options on shared input/chip wrappers must preserve other callers by default.
- Required evidence: helper tests for exact validation, empty/CRLF/whitespace/
  legacy/manual preservation and boundaries; actual RetentionScreen tests for
  named selection, all states, no request before explicit save, exact create/
  revision/retry body and key, unchanged other drafts, current/stale controls,
  before-effects private replacement, foreground/unmount and late receipt races;
  actual HealthRoute owner/session wiring, affected mobile types/format,
  independent review, canonical check/build/license
  gates and fresh native exports. This native-only scope does not require a web
  surrogate or browser fixture. Test stubs/exports do not establish rendered-device
  layout, assistive technology, real persistence or signed-device acceptance.
- Affected source: mobile RetentionScreen, new actual-component suite, focused
  custom-food-nutrients helper/tests, two identity props in App HealthRoute;
  this ADR/index, roadmap and additive release gates. No web implementation,
  endpoint/schema/dependency/storage/outbox/nutrition-math or mutation-contract change.
- Stop condition: reviewed source and applicable local gates pass; normal commit
  and non-force push under standing authorization; exact automatic states and
  compact readiness recorded. External Claude Code, real services, physical
  native/accessibility, hosted and release acceptance remain separate.

## Decision

Add a named append composer while retaining the lossless canonical text path.
Keep pure validation separate from component state and apply narrow custom-editor
ownership guards before integrating with the existing explicit save flow.

## Alternatives

A complete editor replacement needs a separately reviewed full-registry contract.
Hardcoded nutrient IDs or an inferred calorie entry would misrepresent source
identity. Rewriting the full retention lifecycle would expand unrelated scope.

## Consequences

People can add available nutrients by name and explicit evidence state, while
manual/existing rows remain usable. Editing/removing canonical rows still uses the
existing text field. The composer does not save a custom food or claim completeness.

## Review triggers

Revisit before a full nutrient registry, named editing/removal, unit conversion,
nutrient defaults, retained composer preferences or changed mutation/lifecycle contracts.


## Local evidence (September 10, 2026)

Independent in-task review verified the pure helper, actual RetentionScreen suite,
HealthRoute identity wiring and custom-only integration. Focused helper validation
passed 81 tests and actual component validation passed 40
tests, with affected mobile types, formatting and diff checks. The original parser
behavior remains unchanged; named append validates candidate shape, current picker
membership, combined row/character bounds and duplicates while retaining existing
canonical bytes and exact states. Manual entry remains available when the named
registry is empty or cannot be installed.

Component evidence covers reachable named choices and explicit blank amount/reason,
quantified zero/decimals, trace/all unknown reasons, independent drafts, no request
before explicit save, exact create/revision body and retry key, malformed success
receipt recovery and A-to-B-to-A unresolved identity. Current draft/private scope,
render-before-effects, stale field/choice/Add/Save/Revise/Cancel, foreground/unmount
and late custom-save ownership cases are verified with platform mocks. Receipt
acceptance preserves existing service normalization/expanded nutrient snapshots;
entered sparse rows need not equal the returned full nutrient registry.
Custom-list paging and cursor ownership reject old-scope continuations. Only the
actual active lifecycle state permits custom actions; Refresh private data recovers
a deferred registry read without clearing manual draft text.

Canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` exited zero between
2026-09-10T10:18:47Z and 2026-09-10T10:19:26Z. Native tests passed
982 cases plus 10 native runner tests; root
policy passed 157. Mobile types/tests/build were freshly executed.
Unchanged web/package cache status, graph counts and exact native export identities
are recorded in the Windows readiness evidence; cache replay is not a fresh run.
License policy passed 535 production packages with
14 reviewed exceptions. All nine candidate hashes remained
unchanged during gates. Final prose updates are limited to this ADR, its index and
the build plan; application/helper/tests/release-gate hashes retain that evidence.

No browser surrogate, test service, database, dependency install, production audit,
manual workflow control, cloud or quota action was needed. Native component mocks
and iOS/Android exports establish bounded source behavior, not rendered-device
layout, concurrent React scheduling, assistive technology, real persistence,
external Claude Code review, hosted
availability, signed-device or release acceptance. Those gates remain separate.
