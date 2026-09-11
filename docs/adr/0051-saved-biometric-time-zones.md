# ADR 0051: Show saved biometric dates, times and time zones

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context

Web biometric history formats measuredAt in the browser zone. Native shows the
saved local date and time but omits the zone and seconds. Each parsed reading
already carries localDate, measuredAt and a supported timeZone. History should
make the saved date/time context explicit, including manual and imported records.
Existing localTimeInTimeZone helpers return HH:mm and serve editor behavior;
changing those shared helpers would unnecessarily expand this display task.

## Acceptance card

- Show each saved reading's localDate, HH:mm:ss in its saved timeZone, explicit
  timeZone and existing source kind on web/native. Use an inline standard Intl
  time formatter with explicit hour/minute/second, en-GB and hourCycle h23 so
  midnight reads 00 and seconds remain visible. Preserve the saved instant and
  date; do not derive the date from the browser zone or append UTC seconds.
- Cover manual/imported readings, nonzero seconds, midnight/date boundaries and
  zones different from the browser/profile. Retain metric-name/unit fallbacks,
  exact values and current source labels. Milliseconds remain stored unchanged;
  the history displays seconds and does not imply timestamp rounding on write.
- This is derived presentation only. Preserve editor minute precision, raw
  drafts, operation body/key identity, paging, session and lifecycle guards.
  Add no state, shared helper, controller, request, storage or API behavior.
- Six source paths: HealthClient.tsx, RetentionScreen.tsx, this ADR/index, build
  plan and additive release gates. Reuse existing actual-component/helper tests
  for this small reversible change; add no tests that mirror the rendering.
- Required evidence: focused existing suites, types/format, independent review;
  frozen canonical check/build/licenses with fresh client outputs. Source-parsed
  synthetic production Next/BFF in dedicated Chrome verifies saved dates/zones,
  seconds/midnight, imported/manual history, draft independence, no added requests,
  readable 390px layout and private closure on expired-session route reload.
- Stop after review and local/browser proof, normal commit/non-force push, exact
  automatic observation and compact readiness. Physical native, assistive
  technology, real persistence, external Claude Code, hosted and release
  acceptance remain separate. No notification or scheduling change is involved.

## Decision and review triggers

Format the saved-zone history time locally in each component, keeping shared
editor helpers unchanged. Revisit before localized history formats, subsecond
display, timestamp editing, parser contracts or loading behavior change.

## Local evidence and limits (UTC 2026-09-11T00:06:24.954414+00:00)

Existing focused checks passed 79 web and 248 native tests,
with affected types, formatting and independent in-task source review. No tests
were added or edited for this small presentation change. Fresh canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed: 737 web tests,
1217 native tests plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with 14 reviewed exceptions;
89 optional integration cases remained skipped.

A source-validated in-memory fixture and production Next/BFF in dedicated Chrome
verified four manual/imported records across America/Chicago, Asia/Tokyo and UTC,
including nonzero seconds, midnight and a saved date boundary. Saved local dates,
saved-zone HH:mm:ss, explicit zones and existing source labels remained visible.
Raw editor changes left saved history unchanged and added no requests. The
390-pixel layout and private session-expiry closure on route reload passed.
Browser actions made no domain writes. Owned tabs and verified test processes
were closed; ports 3008/4008 were absent. Physical native, assistive technology,
real persistence, external Claude Code, hosted and release acceptance remain
separate.

Exact UTC commands, hashes, reviews and observations remain outside Git in the
Windows readiness record.
