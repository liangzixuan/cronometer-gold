# ADR 0035: Open source diary days from nutrition report evidence

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Report daily evidence preserves the source diaries contributing to a snapshot,
but a person must currently navigate separately to inspect those entries. Report
days use the active profile timezone; contributing source diary dates can differ
from a report date by up to two calendar days. Linking only the report date could
therefore miss contributing entries. Existing web date routes and native Today
navigation can open those diaries without changing the report or diary APIs.

## Acceptance card

- User task: open the diary days underlying a nutrition report's daily evidence
  on web and mobile, including a date with no recorded entries.
- Observable result: each exact daily evidence row/card offers labelled Open
  diary for YYYY-MM-DD actions. For a day with entries, use its parsed
  `sourceDiaries` local dates, deduplicated and sorted. Keep the report date visible
  separately. Distinct diary identifiers sharing a date must produce one action;
  several source dates must remain individually reachable. Do not substitute
  the active-profile report date for contributing source dates.
- Missing-day boundary: when the parsed day has no entries and no contributing
  diaries, offer its report date as the diary destination. Preserve Missing and
  all quantified-zero, partial, trace, unknown and exact-amount evidence.
- Meaning: explain that report days are grouped in the profile timezone, source
  diary dates may differ, and actions open the current diary. They do not replay
  the report snapshot or guarantee its captured revisions remain current.
- Navigation: web uses the existing /dashboard?date= route; mobile uses existing
  Today navigation with the selected date and refresh key. Dates must come only
  from the current parsed day. No domain writes, new API requests before explicit
  activation, new endpoints, or report calculations are introduced by the actions.
- Coherence: enable actions only for a current loaded snapshot/session and applied
  dates. Unapplied date edits disable them with Update report guidance. Guard
  retained or duplicate actions, range/route/session/owner/profile replacement,
  loading/error/closed state, effect replay and native background/unmount. A
  stale callback cannot navigate or reopen private output. Preserve retry and
  adjacent-period behavior; do not broaden the previous card's state changes.
- Print: explicit navigation invalidates pending/active web print preparation
  before departure. Diary actions and their explanatory copy are screen-only;
  the existing printable report retains its exact evidence and layout.
- Accessibility: meaningful date-specific names, keyboard activation and visible
  focus; several dates and long explanatory text remain usable at 390 px.
- Affected source: report components and focused actual-component tests,
  report-scoped helpers/tests only if needed, native report route wiring and its
  focused test if needed, this ADR/index, roadmap and release-gate documentation.
- Exclusions: diary editing, snapshot reconstruction, return-route persistence,
  comparison math, new retained state, dependencies, schemas, API changes,
  protected outbox changes, physical-device/hosted/catalogue/signing or release
  enablement. Ordinary existing diary destination behavior remains authoritative.
- Required evidence: same-date/multiple-date/dedup/missing/timezone regressions;
  actual-component current/dirty/stale/duplicate/private/lifecycle navigation
  guards and web print invalidation; native route/date wiring; independent
  in-task review; canonical check/build/license gates and native exports;
  synthetic production Next/BFF Chrome keyboard/narrow destination checks,
  source-date difference and missing-day flow, session closure and no domain writes.
- Stop condition: reviewed source and applicable local checks pass, normal
  commit/non-force push under standing authorization, exact automatic status and
  compact continuation evidence recorded. Real persistence, physical native,
  assistive-technology, independent Claude Code and release acceptance stay separate.

## Decision

Expose the source diary dates already recorded in a coherent report snapshot,
with a report-date fallback for missing days. Keep current diary navigation and
historical report evidence distinct. Reuse existing destinations and private
interaction guards rather than adding a second diary reader to Reports.

## Consequences

A person can inspect underlying days without retyping their dates, including
timezone-shifted source diaries. The opened diary may have newer entries or
revisions than the report. Source and synthetic proof do not establish native
device, real persistence or release acceptance.

## Source validation

The September 10, 2026 UTC checkpoint passed independent in-task review, canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check`. Fresh execution includes
546 web tests, 752 mobile tests plus 10 runner tests, and 157 root policy tests.
Type/test graphs each passed 17/17 with 15 cached; build passed 11/11 with 9
cached and fresh production web, iOS and Android outputs. License policy covered
535 production packages and 14 reviewed exceptions. Cached tasks and unchanged
opt-in service skips do not establish fresh integration health.

Focused helper/component regressions cover sorted/deduplicated source dates,
missing days, all existing nutrient missingness states, source dates outside the
report range and extreme report bounds, dirty/restored fields, stale/duplicate
actions, route/session/profile and lifecycle changes, and print cancellation.
Web actions avoid prefetch and recover if routing throws. Native ReportsRoute
forwards the chosen date, refresh key and actual screen focus to existing Today
navigation; leaving hides/fences the snapshot and returning reloads the applied
period so fresh actions work while retained departure callbacks remain rejected.

Synthetic production Next/BFF Chrome QA verified a September 4 report day opens
its September 3 and September 4 source diaries, with September 3 outside the
loaded range. Duplicate source dates produced one action within their row.
The missing September 8 day retained Missing evidence and opened September 8.
Each destination displayed its exact date and valid empty current diary; this is
distinct from the captured nonempty report. Browser Back restored the report
range and usable actions. Keyboard activation, dirty-date disabling/restoration,
date-specific labels, visible focus, and wrapped explanation/buttons at 390 px
passed; the existing wide evidence table retains horizontal scrolling.
Fixture logs proved no source diary prefetch, one diary read per explicit action
and no domain writes. Expiry on another action returned to sign-in. Fixture-only
digest arguments and auxiliary overview headers were corrected without changing
application guards. Printable output and all API/contracts remained unchanged.
These checks do not establish real API/database, physical native,
assistive-technology, independent Claude Code or release acceptance.

## Review triggers

Revisit before snapshot reconstruction, persisted return routes, editing from
reports, comparison calculations, longer ranges or new report/diary contracts.
