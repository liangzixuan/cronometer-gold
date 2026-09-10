# ADR 0037: Reuse activity details in a new draft

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Activity history exposes Edit and Delete, but repeating a walk or workout
requires entering its details again. The existing Add form and validated create
contract can reuse exact saved details without changing the original entry or
estimating calories. The new action must remain distinct from a retry of an
earlier submission with the same body.

## Acceptance card

- User task: use a saved activity's details as the starting point for a new
  activity on web and mobile, then review and explicitly add it.
- Observable result: history offers a clearly named reuse action. Copy only
  the parsed exact name, whole-minute duration and nullable self-reported energy
  into existing Add fields. Null becomes blank; positive decimals retain exact digits. Zero remains invalid
  under the existing contract and must not be newly accepted. Do not copy original ID/revision/occurredAt,
  source local date/time, timezone, or affected-day metadata into a create draft.
- Time: retain the selected day and current Add start time, including the existing
  untouched-default instant/fold behavior. Reuse cannot silently move the day or
  rewrite the time. Preserve existing Add detail drafts when switching dates,
  while invalidating any pending reuse choice. Normal existing validation and
  timezone pairing apply at Add.
- Review: reuse alone makes no domain write or request. The original history and
  totals stay unchanged. Explain that details are ready for review and Add remains
  necessary. Keep the Add form reachable with keyboard focus on web and usable
  native/narrow layouts. Preserve self-reported-calorie meaning and energy policy.
- Draft protection: if copied-over Add fields contain content, show an explicit
  keep/replace choice. Bind it to the exact source snapshot and current draft,
  selected day/time and private scope. Any intervening draft/time edit, source
  replacement, date/load/session/profile/route/lifecycle change invalidates it.
  Cancel preserves the exact draft and retry identity. Reuse is unavailable during
  row editing or a mutation; it must not discard either kind of unsaved work.
- Intent and retry: accepting reuse creates a fresh private draft intent even
  when it produces the same create body as an earlier ambiguous attempt. Repeated
  submit/retry of one unchanged draft retains its exact body and operation key.
  Do not recycle a prior receipt as a new activity or clear a newer draft when
  an older request completes. Preserve accepted-write/read-failure recovery and
  source identity/timezone checks. Existing update/delete request contracts stay.
- Coherence: add synchronous fences for new controls and participating draft,
  date and mutation receipts as needed. Reject retained/double actions, busy starts,
  stale loads/receipts, unmount/background and private owner/token/API/profile/route
  changes. An old action or confirmation cannot copy private details or submit,
  reload or clear another scope's draft. Preserve normal lifecycle replay/retry.
- Evidence: focused actual-component web/native tests for exact/null fields and zero rejection,
  time preservation, keep/replace and stale confirmation, no write until explicit
  Add, original/history totals unchanged, fresh intent versus unchanged retry,
  late receipt/private/date/lifecycle fences; types/format; independent review;
  canonical check/build/license gates and native exports; source-validated
  synthetic production Next/BFF Chrome keyboard/390 px/reuse/create/readback and
  lost-receipt retry, dirty cancellation/replacement, date and expiry checks.
- Affected source: activity components and focused actual-component tests;
  existing test mocks or scoped helpers only when required, this ADR/index,
  roadmap and release gates. No API/schema/dependency/outbox/calculation change.
- Exclusions: activity search/templates/favorites, automatic logging, recurring
  schedules, calorie estimates, food-budget adjustment, offline activity queue,
  durable draft preferences, real services/devices/hosted/catalogue/release enablement.
- Stop condition: reviewed source and applicable local gates pass; normal commit
  and non-force push under standing authorization; exact automatic states and
  compact handoff recorded. Real persistence, physical native, assistive technology,
  independent Claude Code and release acceptance remain separate.

## Decision

Reuse exact recorded fields in the existing Add draft and keep submission explicit.
Treat accepting reuse as a new draft intent while preserving the established
retry contract within that intent. Bind replacement choices and asynchronous
receipts to current private draft state.

## Alternatives

Immediate repeat logging would skip the date/time and field review. Persisted
templates introduce a retained entity and are unnecessary for this task. Copying
the entire saved entry would incorrectly transfer identity and historical time.

## Consequences

People can log a repeated activity with less typing while reviewing duration,
self-reported energy and start time. Reuse has no effect until explicit Add.
This source slice does not establish offline, physical-device or release acceptance.

## Review triggers

Revisit before automatic repeats, persisted templates/drafts, offline operations,
new activity calculations or changes to create idempotency and privacy contracts.


## Local evidence (September 10, 2026)

Independent in-task review verified the frozen web and mobile files after the
draft, date, lifecycle and accepted-receipt corrections. Focused suites passed
52 web tests (31 actual-component and 21 existing helper/parser/proxy tests) and
56 mobile tests (40 actual screen/route and 16 helper tests), plus types and format.

Canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` all exited zero
between 08:14:35 and 08:15:19 UTC on eight unchanged candidate files. Fresh client
tests passed 600 web and 821 mobile cases plus 10 native runner tests; root policy
tests passed 157. Type and test graphs each completed 17/17 tasks with 15 cached;
build completed 11/11 with 9 cached, including fresh web production and native
iOS/Android exports. License policy passed 535 production packages with 14
reviewed exceptions. Existing service-gated skips and cached package evidence
remain distinct from fresh integration or real-service acceptance.

The source-validated in-memory fixture and production Next/BFF in dedicated Chrome
proved exact null/0.001/123.456 reuse, retained date/time, dirty Keep/Replace,
keyboard focus, 390-pixel layout, intervening time/date cancellation, preserved
Add drafts across date changes, and private closure after session expiry. Reuse
and confirmation sent no activity POST. Four explicit submissions produced three
new entries: the interrupted confirmation and retry had identical body/key hashes,
while a fresh accepted reuse used a new key for the same body. Original seed
entries stayed unchanged. The synthetic hydration bootstrap header was corrected
to match its existing BFF owner verification; the final overview and sign-out
passed. No application guard changed for the fixture.

The owned Chrome tab was closed and viewport reset. Cleanup verified PID, start
time and command before stopping the fixture and web processes; both loopback
listeners were absent at 08:24:26 UTC. No Codex closure occurred during this QA.
Exact logs, hashes, command timing, fixture correction and cleanup evidence remain
in the external Windows readiness record. These checks establish bounded source
behavior, not real persistence, physical native, assistive technology, independent
Claude Code, hosted or release acceptance.
