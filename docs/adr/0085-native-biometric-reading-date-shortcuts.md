# ADR 0085: Native biometric reading date shortcuts

Status: Implemented at ab2c6de; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

Native food-entry flows now provide Today and Yesterday. Logging or editing a
biometric reading still requires a typed date. Existing synchronous reading-draft
and history guards support the same small convenience without new state machinery.

## Decision and acceptance

Add Today and Yesterday beside Local date in native Log/Edit reading. Compute
Today in the profile time zone at activation and Yesterday as its previous
calendar date using the existing helpers. A screen left open across midnight
uses the new day; never derive Yesterday by subtracting a fixed duration.

Update only localDate. Preserve manual entry, required local time, raw exact
value, metric identity/unit, edited event identity/revision, original timestamp
metadata, history window/filter and unrelated private drafts. Same-date selection
is a no-op and date choice sends no request. Log/Save reading remains explicit.
Returning an edit to its original date/time retains the existing measuredAt
omission, preserving timestamp precision and daylight-saving occurrence. Explicit
changed dates use the existing profile-local conversion and validation policy.

Reuse canEditReading, the synchronous draft setter and history/private/lifecycle
guards. Retired draft/context callbacks and loading, history-read or event-write
callbacks remain inert. Retain disabled-state capture and accessible Button
roles/states. Keep save/request/receipt behavior unchanged. A same-date ambiguous
retry preserves its exact body, operation key and If-Match revision; choosing a
different date intentionally changes the request. Reading writes remain online
operations, not protected diary-outbox entries.

## Consequences, alternatives and review triggers

Common dates need fewer keystrokes, while manual date entry covers other dates.
A calendar picker or generalized control would expand this bounded change.
No new origin/lifecycle architecture, App routing, API/schema, date-helper, queue
or dependency behavior is needed. Revisit when reading draft ownership, timestamp
conversion, edit precision or history/write lifecycle changes.

No installation, audit, paid review, browser/service/device/cloud action or
release enablement is included. Component/export evidence is not concurrent
React, physical-device, assistive, hosted, scientific or release acceptance.

## Validation

Use the existing biometric section of the actual-screen retention harness and
date tests. Record baseline and new regressions failing on original source,
then passing fixed source: calendar boundaries/midnight, exact new/edit requests,
required time, unchanged original timestamp, same-date retries and preserved
other drafts/history. Cover stale draft/private/profile/lifecycle and in-flight
read/write controls. Pass types/format, independent native/documentation review
and frozen canonical pnpm check/build. Record fresh/cached/skipped counts and the
pushed commit's three CI/nine actual container job outcomes outside Git.


Development evidence on September 18, 2026: the 427-case baseline passed.
The 14 new screen regressions failed on original source with 397 existing
cases passing. Fixed source passed all 441 focused cases (411 screen and 30
date cases), native types/format and independent native/documentation review.
The existing synchronous hook harness does not establish concurrent React or
physical-device behavior. Final canonical and exact-commit automatic outcomes
are recorded below and in dated readiness evidence outside Git.


## Delivery evidence

Delivered at `ab2c6dec89981f5ae2c299003ff8b1d39c8125f7`. Canonical pnpm
check passed 1,860 fresh tests, with 2,327 cached passes and 93 cached opt-in skips.
Build passed 11 tasks, ten cached; Android/iOS exports were fresh. All three
actual jobs in [CI 35302039063](https://github.com/liangzixuan/cronometer-gold/actions/runs/35302039063)
and all nine actual jobs in [container 35302039029](https://github.com/liangzixuan/cronometer-gold/actions/runs/35302039029)
passed on attempt one. The final web job completed September 18, 2026 at
04:35:47 UTC. The 07:23:30 UTC observation verified complete job inventories and
successes; clean matching local/tracking/live heads and all seven frozen committed
files were reverified at 07:23:28 UTC. Evidence is scoped to this exact commit;
device and release acceptance remain separate.
