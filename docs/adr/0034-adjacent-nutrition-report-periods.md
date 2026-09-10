# ADR 0034: Previous and next nutrition report periods

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Web and mobile reports expose presets and manual From/To fields, but comparing
adjacent periods requires re-entering dates. Existing bounded snapshot readers
already support any valid inclusive 1–31-day interval. Calendar-day navigation
can reuse those readers without changing report data or calculations.

## Acceptance card

- User task: move to the previous or next report period on web/mobile without
  retyping its two dates or losing the selected nutrient.
- Observable result: labelled Previous period and Next period buttons shift the
  loaded interval by its inclusive day count. For September 1–7, Previous opens
  August 25–31 and Next opens September 8–14. The new period has the same length,
  is adjacent without overlap/gaps, and retains the selected nutrient.
- Calendar boundary: use UTC calendar-day arithmetic on date-only strings through
  existing helpers, not elapsed local hours or calendar-month assumptions. Validate
  input/output and retain the report service's 0002-01-01 through 9998-12-31 bounds
  and inclusive 1–31-day limit. Disable only the unavailable direction at a bound.
  Future date ranges remain governed by existing report policy; do not add a new
  today clamp. Leap years, month/year crossings and DST must preserve date counts.
- Draft boundary: navigation is based on the loaded/applied period. Disable it
  when either date field differs from that period, including invalid edits, and
  explain that Update report applies those dates first. Never silently discard
  date edits or infer a navigation range from a partially edited pair.
- Request boundary: one user move commits a new range through the existing loader,
  updates displayed dates and web URL, immediately clears the prior visible/print
  snapshot, and performs one report read for the chosen range. Keep existing
  session/profile revalidation reads. Preserve all report evidence, missingness,
  exact amounts, goal versions, timezone and selected-nutrient behavior.
- Interaction boundary: enable only for a coherent loaded report and available
  current session. Loading/error/closed or stale owner/session/profile/range/draft
  callbacks must not navigate or resurrect a previous snapshot. Repeated retained
  activation before render cannot send duplicate requests. Keep normal retry,
  abort, effect replay and lifecycle guards. A move invalidates pending/active web
  print preparation just as committing a manual range does.
- Affected files: report components, existing per-client date helpers/helper
  tests, actual-component state tests (add mobile coverage where absent), this
  ADR/index, roadmap and release-gate documentation.
- Exclusions: side-by-side or percent-change calculations, automatic advice,
  additional report length, report/API/schema/dependency or export changes,
  persisted UI settings, hosted/device/signing/catalogue and release enablement.
- Required evidence: helper boundary/leap/month/year/DST/count regressions;
  component previous/next, nutrient retention, dirty-date, loading/error/boundary,
  single-request/stale/owner/session and web print invalidation; independent
  in-task review; canonical check/build/license gates and native exports;
  synthetic production Next/BFF Chrome keyboard/narrow navigation, dates/URL,
  selection, dirty field, failed-read retry and expiry proof with fixture limits.
- Stop condition: reviewed source and applicable local gates pass, normal
  commit/non-force push under standing authorization, exact automatic status and
  compact continuation evidence recorded. Real persistence, physical native,
  assistive-technology, independent Claude Code and release gates stay separate.

## Decision

Add adjacent-period controls using the validated loaded range and existing
snapshot loaders. Treat unapplied date fields explicitly rather than guessing
their intent. Reuse date-only arithmetic and preserve a single coherent snapshot
and selected nutrient through the transition.

## Consequences

Adjacent windows are easier to inspect while existing nutrition, rights, privacy
and report bounds remain authoritative. A failed new load exposes retry for that
period and cannot leave the previous snapshot labelled as current. This remains
a source feature until applicable automatic and external acceptance is complete.

## Alternatives

Calendar-month shifting changes interval length and can overlap or skip days.
Using partly edited date fields risks discarding user intent. Simultaneously
loading comparison windows adds data and analysis beyond this bounded feature.

## Source validation

The September 10, 2026 UTC checkpoint passed independent in-task review, canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check`. Fresh execution includes
513 web tests, 725 mobile tests plus 10 runner tests, and 157 root policy tests.
Type/test graphs each passed 17/17 with 15 cached; build passed 11/11 with 9
cached and fresh production web, iOS and Android outputs. License policy covered
535 production packages and 14 reviewed exceptions. Cached tasks and unchanged
opt-in service skips do not establish fresh integration health.

Focused helper and actual-component regressions cover inclusive lengths, service
bounds, early years, leap/month/year/DST crossings, nutrient selection, dirty and
restored date fields, duplicate/retained controls, failed-range retry, scope and
lifecycle changes, explicit session closure, and pending/active print invalidation.
Report-scoped UTC arithmetic avoids the generic Date.UTC year-00–99 remapping.
Owned URL echoes and installation of the profile verified for the exact response
avoid duplicate reads; replacement-route controls and delayed receipts remain
guarded before passive cleanup.

Synthetic production Next/BFF Chrome QA verified September 4–10 to August 28–
September 3 and back, matching dates/URL and retained Protein selection, including
keyboard activation. Dirty dates disabled navigation/print with Update report
guidance while nutrient selection stayed usable; restoring dates made no read.
Controls and guidance fit at 390 px. A failed September 11–17 load cleared the
old snapshot; one explicit retry loaded that same period and retained Sodium.
Fixture logs proved one report read per range action, one failed read plus one
retry, and no domain writes. Expiry during another move returned to sign-in.
These checks do not establish real API/database, physical native,
assistive-technology, independent Claude Code or release acceptance.

## Review triggers

Revisit before comparison math, calendar-month modes, persisted filters, longer
ranges, background prefetch, new report data or changes to session/print gates.
