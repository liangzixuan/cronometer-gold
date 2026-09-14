# ADR 0061: Health trend date shortcuts

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the roadmap. Add Last 7 days, Last 30 days and
Last 90 days to web/native Health trends so users can choose an inclusive recent
range without entering both dates. Keep custom From/To entry and existing
series choices. Each press uses the current verified profile time zone.

## Acceptance card

- Capture the current instant once per accepted press, derive its profile-local
  date with the existing calendar helpers, set To to that date and From to
  shiftLocalDate(today, 1 - N). Do not use a memoized startup day, UTC day,
  duration subtraction or a timer. Reject invalid or unsupported derived dates
  locally. These are convenience actions, not a persistent range mode.
- Install the date pair atomically. A pair already equal to current raw From/To
  is a true no-op before abort, generation, setters, result/message changes or
  requests, including while reads are pending or failed.
- Preserve custom date editing and selected nutrient/biometric IDs. Preserve
  native nutrient search, history filters/windows/pages and exact raw biometric,
  custom-food, log and reminder drafts. Do not clear mutation maps, allocate
  operations, touch protected queues, alter write payloads/keys/receipts or block
  solely because an unrelated write is pending.
- Reuse native trendInputsRef, installed private/profile scope, metadata ownership
  and abortTrendRead. Web may consolidate From/To into one synchronous range
  state/ref and a narrow controls epoch. Keep React functional updaters pure.
  Preserve initialization's nonempty custom dates and existing reset behavior.
- Reject retained shortcut callbacks after intervening input/series replacements,
  including raw A-to-B-to-A edits before paint, full refresh, private closure,
  profile/time-zone change, background/unmount and stale installed metadata.
  Use existing private/read lifecycle policies rather than unrelated new global
  ownership. Changed ranges abort only the prior trend read before replacement;
  stale responses/errors/finally cannot republish or unlock newer work.
- Preserve each client's loading policy: web's existing automatic effect loads
  the final pair with existing selected IDs; native requires its explicit Load
  local-day trends action. Avoid intermediate date-pair requests. Changed native
  ranges clear old trend results; web follows its existing loading presentation.
  Presets issue no domain writes and matching choices issue no requests.
- Show three plainly labeled secondary buttons near date inputs, with concise
  text that ranges end today in the profile time zone. Keep existing totals,
  exact-zero/lower-bound/missing data labels and date/zone result meaning.
  No client nutrition math, advice, new backend contract or selected preset mode.
- Scope eight paths: apps/web/src/app/health/HealthClient.tsx,
  apps/web/src/app/health/HealthClient.state.test.ts,
  apps/mobile/src/retention/RetentionScreen.tsx,
  apps/mobile/scripts/custom-food-nutrient-composer.test.mjs, this ADR, ADR index,
  build plan and additive release gates. Shared helpers/parsers, APIs, schemas,
  dependencies, reporting and history paging remain outside this slice.
- Require focused actual-component and relevant helper/type/format checks:
  inclusive 7/30/90 dates, profile-vs-UTC midnight, fresh clock per press,
  leap/year/DST boundaries, one captured instant, no-op/atomic updates,
  custom override/selected series, raw draft and retry independence,
  stale/private/zone/before-paint guards, delayed reads and truthful rendering.
  Record all failures and skips. Independent source GO precedes frozen fresh
  canonical pnpm check, pnpm build and pnpm licenses:check.
- Dedicated Chrome QA uses production Next/BFF with normal authentication and
  an isolated loopback read-only synthetic upstream. Validate fixture envelopes
  with source parsers and all 15 core nutrients. Verify all three ranges,
  matching-choice zero requests, custom override, selected series, unchanged raw
  drafts/history, actual result dates and missingness, keyboard, 390px and expiry.
  Source tests cover native explicit loading and calendar edges; browser results
  do not establish physical-device, real persistence or clinical acceptance.
- Stop after two in-task reviews, passing local evidence, normal commit/non-force
  push under standing authorization, exact automatic observation and dated
  readiness/CURRENT handoff. External Claude Code, concurrent React, assistive
  technology, real persistence, physical native/protected storage, hosted and
  release acceptance remain separate.

## Consequences and review triggers

The shortcuts reduce repeated date entry while keeping manual control. Revisit
if profile-local date semantics, range limits, trend ownership or loading policy
changes. Broader automatic rolling ranges and report presets are excluded.

## Local evidence and limits (UTC 2026-09-14T04:58:56.765887+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 970 web tests, 1422 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Dedicated Chrome production Next/BFF QA passed with a read-only synthetic fixture containing all 15 core nutrients and 14 targetable definitions. Last 7/30/90 days used current America/Chicago inclusive ranges; each changed shortcut loaded exactly two selected-series trends and one existing session check, with no intermediate pairs. 2 matching-choice checkpoints issued zero requests. Custom dates, selected series, raw custom-food/biometric/reminder drafts and the unchanged two-row history were preserved.

Sparse results retained exact zero, the 12.340006 lower bound, null No data and exact biometric strings with correct local dates. The 53 upstream requests contained one synthetic login POST and otherwise GETs; no domain writes occurred. Keyboard, 390px and expiry passed. The owned Chrome tab was closed, viewport reset and both verified test processes stopped; ports 3008/4008 were absent.

Native explicit loading and calendar/DST/year/private/stale/no-op cases are covered by focused source tests. Synthetic browser QA does not prove real persistence, concurrent React, assistive technology, physical native/protected storage, external Claude Code, hosted or release acceptance.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
