# ADR 0047: Activity Add duration presets

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context

Both activity Add forms require typing duration. The current API accepts whole
minutes from 1 through 1,440. Three explicit draft shortcuts reduce typing while
preserving manual duration, chosen start time and independent self-reported energy.

## Acceptance card

- Task: choose 15, 30 or 60 minutes on web/native, review the existing Add draft,
  then explicitly Add entry. These controls replace only duration; they are not
  additive, remembered preferences, activity advice or automatic logging.
- Route presets through the ordinary guarded duration edit. Preserve name,
  optional exact self-reported calories, selected day/time and untouched default
  instant/fold. Keep custom whole-minute entry and existing 1–1,440 validation.
  No nutrition math, inferred calories, API/schema/helper/dependency change.
- Selecting or repeating a preset sends no request, changes no saved entry or
  total, and starts no reuse-style creation intent. A duration-only same-value
  no-op must happen after current-control checks and before draft/generation or
  reuse-choice changes. Do not extend this to same-minute time edits, which
  intentionally clear untouched-default time provenance.
- A changed duration follows ordinary reuse-choice invalidation. Reuse existing
  draft/action guards to reject retained pre-change duration/other-field/Add/date
  callbacks where they participate in this form. A narrow native action-generation
  advance on a changed duration is sufficient; no controller or generic private
  scope rewrite. Preserve independent row Edit state and unrelated field behavior.
- Match existing Add availability during loading, active writes, date/private
  invalidity, reconciliation and lifecycle closure. Preserve the current pending
  mutation map, exact body/key replay and accepted-write/read-failure handling.
  Presets follow ordinary Activity field-edit retry semantics, including returning
  to an earlier body; do not transplant hydration's different pending-edit policy.
- Provide clear minute labels, selected/disabled accessibility state, concise
  duration feedback, keyboard-operable non-submit web buttons and wrapping at
  narrow widths. Manual entry may leave every shortcut unselected.
- Files: web ActivityClient and its existing state suite; native ActivityScreen
  and existing activity-reuse suite; this ADR/index, build plan and release gates
  (eight paths). Use existing styles or component-local native styles.
- Evidence: focused actual-component preset/manual/same-value/no-request tests,
  unchanged chosen/default time and optional calories, stale controls and reuse
  choice, row Edit independence, disabled/private/date states and exact body/key
  retries. Relevant existing activity regressions, types/format and independent
  review before frozen canonical check/build/licenses; both client outputs fresh.
- Browser proof: source-validated synthetic upstream with production Next/BFF,
  dedicated Chrome keyboard and 390-pixel controls, no write before Add, preset
  and custom creates/readback with original entry unchanged, chosen-day/time,
  lost-confirmation exact retry and session-expiry closure. Existing component
  coverage retains accepted-write/read-failure and lifecycle safeguards. Stop
  only owned tabs and verified QA processes, and record final loopback listeners.
- Stop: reviewed source and required local/browser proof pass, normal commit and
  non-force push under standing authorization, exact automatic observation and
  compact readiness. Synthetic memory/host mocks/exports do not prove real
  persistence, physical native, assistive technology, concurrent React,
  independent Claude Code, hosted or release acceptance.

## Decision and consequences

Expose three amount-replacement buttons alongside the existing duration input.
The ordinary duration path remains the single edit seam and explicit Add remains
the only create action. Revisit before configurable presets, remembered values,
automatic logging, activity recommendations or changed operation semantics.

## Local evidence and limits (September 10, 2026)

Focused checks passed 58 web and 72 native
tests, with affected types/format and independent in-task review. Frozen canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed. Fresh client evidence:
702 web and 1171 native tests, 10 native
runner checks, both client type checks, production Next and iOS/Android exports.
Root policy passed 157 checks. Licenses passed for 535 production
packages with 14 reviewed exceptions. Cached package results and
89 optional integration skips remain explicit.

The source-validated in-memory fixture and production Next/BFF in dedicated
Chrome proved preset/manual duration, repeated selection without submission,
chosen time and optional energy, explicit create/readback, unchanged original
entries, and lost-confirmation retry with the exact body/key and no duplicate.
Keyboard and 390-pixel controls, selected-day behavior and session-expiry closure
passed. The owned tab and verified test processes were closed; ports 3008/4008
were absent afterward. This bounded synthetic proof does not establish real
persistence, physical native, assistive technology, concurrent React, independent
Claude Code, hosted or release acceptance.

Exact commands, UTC, hashes, review corrections and delivery/automatic observations
are retained outside Git in Windows readiness.
