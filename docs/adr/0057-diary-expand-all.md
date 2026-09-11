# ADR 0057: Expand all diary meals

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the roadmap. After collapsing several diary meal
groups, restoring the full day requires a separate action for each meal. Add one
local Expand all meals button to the web and native diary ledger.

## Acceptance card

- Expand all meals clears only the current collapsed meal membership. Reuse the
  existing scoped presentation Set/ref and generation; advance the generation
  once for a change. If membership is already empty, return without a state or
  generation write. Keep the button mounted and enabled while the current ledger
  is available, including when already expanded, to retain keyboard focus.
- Render the action alongside the loaded-entry overview for a nonempty diary
  ledger. Respect existing loading, paging, error, private/date/route and mutation
  availability and retained-callback guards. Use the web canUseMealControls seam
  and share native toggle ownership and live-outbox checks, removing only the
  single-meal entry prerequisite for the all-meal action. Do not create a new
  controller or broaden unrelated identity hardening.
- Preserve stable meal IDs, labels/order, entry order, exact totals and missingness,
  loaded/total counts, cursor/retry behavior, overview cards, Add food links and
  individual collapse controls. This action does not load missing pages, fetch,
  allocate operations, persist preferences, mutate entries or touch the outbox.
- Preserve entry nutrient disclosure choices and raw edit drafts. Web expansion
  may reveal other meals while its current editor stays intact. Native editor,
  mutation and protected-queue holds keep their existing forced-open/disabled
  behavior, including live controller changes before a render. A stale callback
  cannot clear a newer collapse choice, another day or private scope.
- Use real labelled web/native buttons with existing disabled/focus semantics.
  Do not present a toggle/pressed state for the one-way action. Keyboard activation
  and long meal names must remain usable at 390 px. Hidden/empty ledgers do not
  expose a misleading action; repeated current expansion is a true no-op.
- Scope exactly eight paths: apps/web/src/app/dashboard/DiaryClient.tsx and its
  existing DiaryClient.state.test.ts; apps/mobile/src/diary/DiaryScreen.tsx and
  scripts/diary-group-collapse.test.mjs; this ADR/index, build plan and additive
  release gates. No API/schema/shared helper/dependency/style/outbox changes.
- Focused actual-component regressions cover multiple groups, no-op/generation,
  stale controls, private/day/read transitions, editor and native queue holds,
  preserved nutrient disclosures/totals/pages and zero local side effects. Run
  affected helpers/types/format and early independent review. Freeze before fresh
  canonical check/build/licenses and production web/both native exports.
- Source-validated production Next/BFF dedicated-Chrome QA uses a complete core
  nutrient fixture and normal auth/session guards. Exercise multi-meal expansion,
  repeat and keyboard activation, nutrient/dirty-editor preservation, coherent
  page load/retry, date/empty-day boundaries, 390 px and session expiry. Journal
  local-action zero requests separately from explicit reads; no domain writes.
- Stop after reviewed source/local proof, normal commit/non-force push under
  standing authorization, exact automatic observation and dated readiness plus
  CURRENT. Physical native/protected storage, assistive technology, concurrent
  React, real persistence, external Claude Code, hosted and release remain separate.

## Consequences and alternatives

The action restores the loaded day overview without changing what is loaded or
saved. Persisted preferences, automatic expansion and bulk collapse add behavior
outside this small presentation task and are unnecessary.

## Review triggers

Revisit when meal presentation ownership, editor visibility, nutrient disclosures,
coherent pagination or protected queue holds change. Preserve all release gates.

## Approved dependency prerequisite (2026-09-11)

The original product change passed focused review, but its first canonical check
failed at the unchanged online Expo compatibility gate. The user then approved
the prepared six direct patch updates and exactly 16 version-specific release-age
exceptions, and authorized the local production audit disclosure to npm's advisory
API. The initial failed check, original source freeze, registry metadata and exact
proposal remain preserved in the dated Windows readiness evidence.

Amend the original eight-path dependency exclusion only for this prerequisite:
apps/mobile/package.json, pnpm-lock.yaml and pnpm-workspace.yaml bring the final
scope to eleven paths before the validation consistency repair below. Direct versions are expo 57.0.22, expo-camera 57.0.5,
expo-crypto ~57.0.3, expo-file-system 57.0.7, expo-notifications 57.0.18 and
expo-secure-store ~57.0.4. Preserve original range style, all four reviewed product
and test files, strict peers, build allowlist, registry/TLS, provenance, existing
exceptions and all remaining policy. Accept only the proposal's exact 16 new
version exceptions; do not broaden or disable release-age validation.

Review the resolved graph, perform a strict frozen install and affected checks,
then freeze the integrated source before fresh canonical check/build/licenses and
production audit. Browser QA and delivery depend on those checks. Retain any new
failure and stop dependent work; do not bypass compatibility or audit assertions.
Hosted audit, external review, physical devices and release remain separate.

### Exact native validation pins

The next canonical check passed Expo dependency compatibility and failed only
because check-native-config.mjs still expected the prior camera and notification
versions. Add apps/mobile/scripts/check-native-config.mjs to the named prerequisite
(twelve paths): update exactly those two expected strings to the approved versions.
Preserve the exact equality checks and all generated native permission, transport,
identifier, backup and release assertions. Exercise the real config gate and its
existing relevant tests. This is a consistency repair, not a gate exemption.
The failed eleven-path canonical attempt and source freeze remain preserved.

## Local evidence and limits (UTC 2026-09-11T17:09:15.144489+00:00)

Focused actual-component/helper checks, affected types/format and independent
source/dependency review and the strict frozen dependency install passed. Fresh
canonical `pnpm check`, `pnpm build`, `pnpm licenses:check` and `pnpm audit:prod`
passed with the existing reviewed advisory handling: 865 web tests, 1331 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Dedicated-Chrome production Next/BFF synthetic QA passed. One action restored
two collapsed meals, with keyboard focus and repeated activation intact. Exact
nutrient disclosure text, totals, row order, loaded counts and the raw unsaved
quantity/note survived. Local controls produced zero requests (8 before/after).
A controlled page failure retained 20 rows; retry used the identical cursor and
loaded all 24, with dinner expansion and nutrient state preserved. Prior-day and
empty-day boundaries, return to today, the 390 px long-label/number layout and
expiry to sign-in passed. The run recorded 30 synthetic requests, zero domain
writes, and two expiry 401s. The owned Chrome tab closed, viewport reset and both
identity-verified loopback services stopped. This is synthetic browser evidence;
native device, real persistence, assistive and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
