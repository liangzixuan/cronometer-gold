# ADR 0056: Reminder day presets

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the Nourishing roadmap. Common reminder schedules
currently require individual day toggles. Add Weekdays, Weekends and Every day
beside the existing web/native day controls, as local draft actions.

## Acceptance card

- Weekdays selects Monday through Friday [1,2,3,4,5]; Weekends selects Saturday
  and Sunday [6,7]; Every day selects [1,2,3,4,5,6,7]. Changed selections use these
  ascending arrays. Derive pressed/selected state from membership. Selecting an
  already matching preset is a true no-op: preserve the draft and original array,
  including an unordered saved array, messages and exact existing retry body/key.
  Individual day controls remain available and may produce a custom or empty set;
  preserve existing empty-set validation at explicit submission.
- Presets change only draft days. Preserve label, local time, edited ID/revision,
  paused/active status, current profile-zone semantics and all other Health inputs.
  Saved schedule cards remain unchanged until an accepted explicit Save. Preserve
  existing Edit/Cancel/reset behavior and web consent checkbox DOM identity and
  checked state. Presets never grant, clear or request consent, submit a form,
  allocate an operation, fetch, save, prompt or reconcile device schedules.
- Use narrowly scoped reminder draft/private/profile/lifecycle identity for the
  participating preset, field, individual-day, status, Edit, Cancel and submit
  actions. Retained controls cannot restore an old draft or touch another private
  scope. Reject duplicate submissions and protect reminder draft actions with a
  live reminder save lease independent of shared busy state. Native protection
  starts before the permission await and lasts through save/reconciliation;
  denial releases controls and sends no Create. Retire obsolete private leases
  without discarding accepted same-private cleanup or stranding a new scope.
- Keep existing reminder request bodies, headers, paths, revision semantics,
  operation-key derivation and scheduling policy. Canonical preset A-to-B-to-A
  retries reuse the original unresolved body/key. Keep general request helpers,
  pause/resume/revoke behavior and other client state outside the implementation.
  A narrow reminder-only guard may fence response effects where required by the
  new lease; do not refactor shared transport or weaken privacy/consent gates.
- Scope: HealthClient.tsx and HealthClient.state.test.ts, RetentionScreen.tsx and
  scripts/custom-food-nutrient-composer.test.mjs, this ADR/index, build plan and
  additive release gates (eight paths). No shared helper, parser, API, database,
  dependency, notification adapter, scheduler, outbox or permission-policy changes.
- Require meaningful actual-component regressions for memberships/no-op/overrides,
  unchanged fields/cards/consent, zero local-action side effects, stale controls,
  permission/save ownership, exact Create/PATCH and failed canonical preset retry.
  Run affected helpers/types/format and independent source review, then freeze
  before fresh canonical check/build/licenses and web/native outputs.
- Source-validated synthetic production Next/BFF dedicated-Chrome QA must exercise
  all presets and an individual override, Create and paused Edit, unchanged raw
  fields/consent and saved cards, explicit save/retry/readback, keyboard/pressed
  states, narrow layout and session expiry. Record zero requests from local preset
  actions separately from explicit synthetic saves. Include all 15 core nutrients,
  normal auth/session guards, private evidence and verified owned cleanup.
- Stop after reviewed source/local proof, normal commit and non-force push under
  standing authorization, exact automatic observation and a template-based dated
  readiness checkpoint. Physical native/protected storage, actual notification
  delivery, assistive technology, concurrent React, external Claude Code, hosted
  and release acceptance remain separate.

## Consequences and alternatives

Local shortcuts reduce repetitive toggles while retaining individual overrides
and deliberate consent/submission. Membership-based no-ops avoid gratuitously
reordering saved arrays used by unresolved request identities. Automatic saving or
notification changes would alter unrelated authority and are unnecessary.

## Review triggers

Revisit when reminder draft identity, day numbering, request-key derivation,
consent, profile ownership or notification scheduling contracts change. Preserve
existing validation, privacy, scheduling and release gates.

## Local evidence and limits (UTC 2026-09-11T08:37:42.747320+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 862 web tests, 1327 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Source-validated synthetic production Next/BFF in dedicated Chrome verified all
three presets, membership-based pressed states, an individual override and a
matching-preset no-op. The label Preset morning draft, time 19:45 and independent
unsaved custom-food name stayed unchanged. Required unchecked consent blocked
Create; presets neither checked nor cleared consent. After explicit consent, a
synthetic POST 503 retained the draft, error and saved cards. Weekdays-to-Weekends-
to-Weekdays sent no requests; explicit retry POST 201 used identical body and
operation digests and displayed the saved weekday schedule. Paused Edit loaded
the unordered weekend fixture correctly; matching preset, Cancel and changed
preset sent no request. Explicit PATCH used If-Match 3, retained label/time/paused
status and saved weekdays using the existing UTC profile-zone semantics.
Authenticated reload read back both saved schedules. All 34 upstream requests
included exactly 3 deliberate synthetic writes (failed Create, retry and paused
update); local-only action checkpoints added zero requests. Keyboard and 390px
layout passed with client/scroll widths both 375px. Expired Reload returned to
sign-in and removed private controls. The owned Chrome tab was closed, viewport
reset and both identity-verified processes stopped normally; ports 3008/4008 absent.

This is memory-only browser/BFF evidence. Component regressions verify raw unordered no-ops and unchanged consent element
structure; browser QA verifies checked-state preservation. Native permission and
reconciliation checks use mocks.
Real persistence, physical native/protected storage and permission prompts, actual
notification delivery, assistive technology, concurrent React, external Claude
Code, hosted and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
