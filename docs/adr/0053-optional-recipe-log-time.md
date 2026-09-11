# ADR 0053: Optional local time for saved recipe logs

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

Saved recipes already log an immutable recipe revision and an occurredAt instant.
An optional local time lets someone place a recipe on a chosen diary day without
changing the established automatic defaults or introducing another queue format.
Use the existing profile-zone wall-clock resolver and its DST convention.

## Acceptance card

- Add a blank-default Local time (optional) HH:mm field on web and native. Blank
  retains actual now for today, including seconds and repeated-hour identity, or
  profile-local noon for another day. Explain both defaults and the verified zone.
  Explicit raw HH:mm uses recipeLogInstant; invalid, whitespace and DST-gap input
  fails before a write. A partially filled native browser time control is invalid
  even when its DOM string is empty; only a valid fully empty control is automatic.
  Check this at Log and zone confirmation. Midnight is valid. No new fold selector.
- Web preserves legacy automatic pending intent keys and lazy timestamp creation.
  An explicit-time discriminator distinguishes deliberate edits. Unchanged and
  A-to-B-to-A unresolved retries recover their exact original body and key. Native
  keeps fresh IDs per deliberate enqueue; the existing durable queue owns exact
  body/key replay and ambiguous-enqueue recovery. No second identity mechanism.
- Preserve the exact recipe version, raw amount, portion, meal, date and unrelated
  builder, review, filters and nutrition choices. Time resets when a saved selection
  is installed or cleared, on New/copy/save replacement and private/route reset;
  ordinary date or other log edits retain time. Native profile replacement clears
  time provenance and fences old callbacks. A web typed zone conflict retains raw
  date/time for deliberate confirmation together in the newly verified zone.
- Bind participating time/date/amount/portion/meal, Log and review controls to the
  current selected version, log draft and private/route/profile context. Same-value
  edits remain usable. Reject retained stale controls before side effects without
  coupling log edits to builder/filter generations. Keep acceptance of a valid
  write independent of same-owner list refresh; preserve native receipt registration
  and release across background/unmount. Limit changes to the log-specific seams.
- Scope is ten paths: web RecipesClient.tsx and its state suite, web recipes-goals.ts
  and its helper suite, native RecipesScreen.tsx and the existing ingredient-review
  component suite, this ADR/index, build plan and additive release gates. No backend,
  shared date math, API, outbox/controller/schema, dependency or deployment changes.
- Extend focused actual-component/helper tests for automatic today/past time,
  explicit dates/midnight/DST, invalid no-write, precise retry identity, stale
  controls, resets and profile review while preserving unrelated drafts. Run
  affected types/format and independent review before frozen canonical check,
  build and licenses with fresh client outputs.
- Source-validated production Next/BFF synthetic QA in dedicated Chrome proves
  explicit past time through recipe logging and diary readback, blank automatic,
  lost-receipt exact retry, keyboard/clear/narrow usability and expired-session
  private closure. Keep the full core nutrient registry. Checkpoint first and
  close only owned tabs and verified test processes.
- Finish with independent review, normal commit/non-force push, exact automatic
  observation and compact readiness. Real persistence, physical native/protected
  storage/OS-kill, assistive technology, concurrent React, external Claude Code,
  hosted and release acceptance remain separate.

## Consequences and alternatives

Leaving time blank preserves current behavior without rounding today's instant
through a wall-clock field. Prefilling the current minute or adding another outbox
protocol would alter existing semantics and is unnecessary. Explicit repeated-hour
input retains the existing resolver's deterministic choice; it cannot select both
occurrences. An explicit time remains a draft until the existing Log action.

## Review triggers

Revisit if profile-zone confirmation, DST selection, recipe version replacement,
or durable enqueue/receipt ownership changes. Do not weaken those boundaries to
make this optional control pass.

## Local evidence and limits (UTC 2026-09-11T03:06:10.588994+00:00)

Focused web/native actual-component and helper checks, affected types/format and
independent source review passed. New regressions cover automatic/explicit times,
DST, exact retries, stale controls, selected/profile/private resets and unrelated
draft independence. Native component evidence also exercises the real queue with
in-memory storage and simulated network failure; it does not prove device storage.
Fresh canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
775 web tests, 1253 native tests plus 10 native runner checks,
157 root checks, production Next and both native exports. All task graphs
used zero cached tasks. License policy covered 535 production packages
with 14 reviewed exceptions; 89 optional integration cases remained skipped.

Source-validated synthetic production Next/BFF in dedicated Chrome verified an
explicit past recipe time (18:45 America/Chicago), exact saved revision and raw
1.250000 bowl amount, accepted diary readback and a lost-receipt retry with identical
bytes/key and one entry. Dirty recipe name/ingredient note and filters remained
independent. Blank past-day noon and precise today-now defaults passed. Incomplete
browser time was rejected before a request, fully empty time recovered, and a DST
gap wrote nothing. Keyboard use and 390px layout passed; an expired-session route
reload returned to sign-in and closed private recipe controls. The owned Chrome
tab and verified test processes were closed, with ports3008/4008 absent.
This is synthetic memory/BFF/browser evidence. Real persistence, physical native/
protected storage/OS-kill, assistive technology, concurrent React, external Claude
Code, hosted and release acceptance remain separate.

Exact commands, hashes, review records and browser/request evidence are outside
Git in the Windows readiness record. External acceptance remains separate.
