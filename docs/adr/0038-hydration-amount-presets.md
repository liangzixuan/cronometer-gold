# ADR 0038: Hydration amount presets in the Add form

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Web and mobile hydration Add forms accept exact whole milliliters and a local
time. Common amounts currently require typing. Two explicit draft controls can
reduce that entry work without altering the hydration ledger or its retry model.

## Acceptance card

- User task: choose 250 mL or 500 mL in the existing hydration Add form, review
  the amount and time, then explicitly add the entry on web or mobile.
- Observable result: clearly labeled 250 mL and 500 mL buttons replace only the
  amount draft, through the same guarded path as ordinary amount editing. They
  are not additive controls or saved preferences. Manual custom amounts remain
  available with the existing whole-number bounds. Indicate the current choice
  and announce the amount without suggesting an intake target or recommendation.
- Time and date: preserve the selected local date, visible start time and exact
  untouched-default instant/fold. An amount choice cannot turn the time into an
  explicit minute edit, copy historical metadata or silently change the date.
  Preserve existing draft behavior on day changes and normal timezone validation.
- Explicit save: choosing or rechoosing a preset sends no request and changes no
  history entry or total. Add remains necessary. Buttons inside the web form must
  not submit it. Repeated choice of an already-current amount must remain usable
  and must not advance a guard generation without a corresponding current view.
- Retry: retain the existing frozen pending operation, serialized body and
  operation key after uncertain acceptance. Presets and participating draft edits
  are unavailable while a write, pending retry, reconciliation or accepted-write
  refresh is unresolved. Retry saved change replays exactly that operation.
  A preset is an ordinary field edit, not an activity-reuse-style new intent.
  Preserve accepted-write/read-failure cleanup before the owned refresh.
- Coherence: new and participating Add amount/time/submit/date/retry controls must
  synchronously reject retained stale actions, busy starts, replaced day/private
  owner/session/profile/route state and unmount/background state. An old receipt,
  error or finally callback cannot clear, reload or re-enable another scope's
  draft. Keep existing correction, exact time, owner, revision, pending retry and
  lifecycle behavior; protect an active row editor from preset side effects.
- Accessibility: keyboard-reachable web controls, accurate selected/disabled
  semantics, concise amount feedback and usable 390-pixel/native layouts. Do not
  infer physical-device or assistive-technology acceptance from source tests.
- Required evidence: focused actual-component tests for preset/manual transitions,
  no write until Add, repeated same-value selection, exact time/default fold,
  frozen pending retry and busy/stale/private/date/lifecycle guards; existing
  correction regressions, affected types and formatting, independent in-task
  review, canonical check/build/license gates and native exports; source-validated
  synthetic production Next/BFF dedicated-Chrome keyboard/narrow/create/readback,
  lost-confirmation exact retry, accepted-write/read-failure recovery, selected-day
  and expiry checks. No real-service or physical-device claim is made.
- Affected source: web HydrationClient and its existing actual-component suite;
  native HydrationScreen and existing hydration-corrections suite; this ADR/index,
  roadmap and release gates. No API/schema/dependency/storage/outbox/math change.
- Exclusions: hydration targets or advice, automatic logging, unit conversions,
  additive counters, remembered presets, custom preset configuration, reminders,
  offline hydration queue, live services, phone/hosted/catalogue/release enablement.
- Stop condition: reviewed source and applicable local gates pass; normal commit
  and non-force push under standing authorization; exact automatic states and
  compact handoff recorded. Independent Claude Code and physical-device, hosted,
  real-persistence and release acceptance remain separate.

## Decision

Offer two amount-only draft choices beside the existing Add amount field. Keep
explicit Add and the established pending-operation retry contract. Share current
draft guards with manual editing instead of adding a separate persistence or
operation-identity mechanism.

## Alternatives

Immediate logging would skip time and amount review. Additive volume buttons
would introduce arithmetic and could surprise someone expecting a replacement.
User-configurable or remembered presets require a separate retained preference.

## Consequences

Common volumes need less typing. Existing custom amounts, time semantics and
correction/retry rules remain available. Presets affect no ledger value until Add.

## Review triggers

Revisit before automatic or additive logging, saved configuration, new units,
hydration recommendations, offline writes or changed retry/private-scope contracts.


## Local evidence (September 10, 2026)

Independent in-task review verified the frozen web/native components and their
existing actual-component suites. Focused checks passed 69 web and
52 native tests, plus affected types, formatting and diff checks.
Presets retain the frozen pending operation and share guarded amount editing;
review corrections preserve same-value usability, installed private scope, stale
draft/receipt rejection, active row editors and sign-out during a deferred read.

Canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` exited zero between
2026-09-10T08:55:23Z and 2026-09-10T08:56:11Z. Fresh client tests
passed 619 web and 845 native cases plus
10 native runner tests; root policy passed 157.
Type/test graphs each completed 17/17 tasks with 15 cached; build completed 11/11
with 9 cached and fresh web production/iOS/Android output. License policy passed
535 production packages with 14 reviewed
exceptions. Eight candidate file hashes stayed unchanged during gates. Cached
package results and service-gated skips do not establish fresh service integration.

The source-validated in-memory fixture and production Next/BFF in dedicated Chrome
proved exact preset and custom amounts, repeated selection, no request before Add,
retained selected time, keyboard/390-pixel controls, original entries unchanged,
and exact totals after explicit creates. The interrupted confirmation retried the
same body/key and created no duplicate. A separately accepted create whose read
failed cleared its amount, disabled Add/presets and recovered the history through
a read retry without another create. Selected-day behavior and session-expiry
closure passed. Exact counts, command times and fixture/parser hashes are retained
outside Git in the Windows readiness evidence.

The owned Chrome tab was closed, viewport reset and exact owned QA processes
stopped; both loopback listeners were absent. No Codex closure was observed.
These checks establish bounded source behavior, not real persistence, physical
native, assistive technology, independent Claude Code, hosted or release acceptance.
