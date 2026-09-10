# ADR 0050: Show saved reminder weekdays

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context

Saved reminder cards show time, time zone and status but omit their saved weekdays.
Both clients already receive validated daysOfWeek and define Monday-to-Sunday labels.
Showing that membership makes a saved schedule understandable without entering Edit.

## Acceptance card

- Task: read the saved weekdays of a reminder on web/native beside its existing
  exact time, time zone and status, including active, paused and revoked records.
- Add a clearly labelled Saved days line. Use existing dayNames in Monday-to-Sunday
  order and membership in the saved daysOfWeek array; Sunday is 7. Show explicit
  weekday labels for a single day, an unordered subset or all seven days. Do not
  sort/mutate saved arrays, infer delivery success or describe a paused/revoked
  schedule as currently delivering notifications.
- This is derived presentation only. Preserve raw reminder drafts and saved
  values, existing editor/buttons, operation body/key identity, session/lifecycle
  guards, notification permissions, protected scheduling and revocation behavior.
  Rendering adds no state, helper, interaction, request or scheduling call.
- Source scope: HealthClient.tsx and RetentionScreen.tsx, this ADR/index, build
  plan and additive release gates (six paths). No tests are added for this small
  reversible display change; run the existing actual-component/helper suites,
  affected types/format and independent source review. No API/schema/dependency,
  storage/controller/math, notification delivery or release behavior changes.
- Evidence: existing focused suites, types/format and independent review; frozen
  canonical check/build/licenses with fresh client outputs. Source-validated
  synthetic production Next/BFF in dedicated Chrome checks Sunday, unordered
  subsets, all seven days and all statuses, unchanged saved display during raw
  edits, no added requests, readable 390px layout and private expiry closure.
- Stop: reviewed source and applicable local/browser proof pass, normal commit
  and non-force push, exact automatic observation and compact readiness. Physical
  native, assistive technology, notification delivery, real persistence, external
  Claude Code, hosted and release acceptance remain separate.

## Decision and review triggers

Render a saved membership label from existing parsed data. No new state or refresh
protocol is required. Revisit before locale-aware weekday labels, calendar dates,
rescheduling, delivery claims or a changed reminder contract.

## Local evidence and limits (September 10, 2026)

Existing focused checks passed 79 web and 212 native tests,
with affected types, formatting and independent in-task source review. No tests
were added or edited for this small presentation change. Fresh canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed: 737 web tests,
1217 native tests plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with 14 reviewed exceptions;
89 optional integration cases remained skipped.

A source-validated in-memory fixture and production Next/BFF in dedicated Chrome
verified Sunday, unordered subsets and all seven weekdays across active, paused
and revoked records. Exact saved time, zone and status remained visible. Raw
editor changes left saved labels unchanged and added no requests. The 390-pixel
layout and private session-expiry closure passed. Browser actions made no domain
writes. Owned tabs and verified test processes were closed; ports 3008/4008 were
absent. Physical native, assistive technology, notification delivery, real
persistence, external Claude Code, hosted and release acceptance remain separate.

Exact UTC commands, hashes, reviews and observations remain outside Git in the
Windows readiness record.
