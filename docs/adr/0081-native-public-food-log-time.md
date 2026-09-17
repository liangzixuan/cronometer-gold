# ADR 0081: Optional local time for native public-food logging

Status: Implemented at ddd19bb; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

Native public-food search lets a person choose a date, meal and quantity, but
always timestamps an Add automatically. Someone recording an earlier meal must
correct it afterward. Recipe logging already exposes an optional time through
the existing diary resolver. The public-food search and barcode result paths
share one Add action and can expose the same choice without a new API contract.

## Decision and acceptance

Add a blank-default Local time (optional) field beside the diary destination.
Show HH:mm guidance and the current profile time zone. Blank preserves the exact
current instant for today, including seconds and repeated-hour identity, and
local noon for another date. An explicit raw HH:mm uses the unchanged local
date/time resolver. Reject malformed, whitespace and nonexistent daylight-saving
times before enqueue. Preserve its existing repeated-hour resolution; this does
not introduce a fold selector or a new timezone calculation policy.

Apply the choice to both search results and barcode results, for default-serving
and gram quantities. Preserve the exact selected food version, raw quantity,
meal, local date and queue envelope. Editing the time sends no request. Ordinary
search, quantity and meal changes retain it. Route/private/profile replacement
clears the optional time's old context; retained Add and draft controls must not
enqueue against a replaced context or an inactive/unmounted screen.

The selected instant is resolved once for an explicit Add, then secured by the
existing owner-bound durable queue. Draft or clock changes never rewrite a
secured operation, and retry sends its exact existing identity/body. A retired
asynchronous outcome must not overwrite a new view. Keep receipt ownership and
the existing private-session and profile-zone authority intact.

## Consequences, alternatives and review triggers

Automatic timestamps remain the quick default. Correcting every earlier meal
after logging adds avoidable work. A required time adds friction, while a new
date picker or shared date-math change would expand this slice. Reusing the
existing optional-input convention keeps the change bounded and consistent.

This is a native client slice. No web, API/schema, queue protocol, dependency,
camera capture, background delivery, protected storage or server authority
change is included. No installation, audit, service/device/cloud action or paid
review is part of it. Component and export evidence do not establish physical
device, accessibility, hosted or release acceptance. Revisit when route/session
ownership, timestamp policy or queue semantics change.

## Validation

Demonstrate the missing time choice on original source, then exercise search and
barcode Add with serving/gram quantities; blank today/other-day defaults;
midnight, malformed inputs, DST gap/fold behavior; stale route/private/lifecycle
controls; and exact queued retry after draft and clock changes. Reuse existing
helper/outbox coverage and an in-memory real controller where useful. Pass native
types/format, independent in-task review, frozen canonical check/build and the
exact commit's three CI/nine actual container jobs. Record cache and skip limits
in the dated readiness evidence outside Git.


Development evidence on September 17, 2026: the existing helper/search/outbox
baseline passed 84 cases. The initial component suite had 30 failures and one
existing automatic-time pass on original source. Independent review identified
a late receipt crossing a focus/background lifecycle boundary; four additional
regressions failed before binding receipt ownership to its originating epoch.
The final focused suite passed all 119 cases (35 component and 84 existing),
with native types/format and independent source/documentation review passing.
Receipt ownership survives ordinary draft edits while retired lifecycle outcomes
cannot publish into the renewed view. Canonical check/build and the pushed
commit's automatic outcomes are recorded separately in dated readiness evidence.
The synchronous hook harness is not concurrent React or physical-device proof.


## Delivery evidence

Delivered at `ddd19bb83435818c2ad4e424e912238b0dd8dff5`. Final canonical
pnpm check passed 1,803 fresh tests, with 2,327 cached passes and 93 cached opt-in
skips. Build passed all 11 tasks, ten cached; Android/iOS exports were fresh.
All three jobs in [CI 35249813414](https://github.com/liangzixuan/cronometer-gold/actions/runs/35249813414)
and all nine actual jobs in [container 35249813424](https://github.com/liangzixuan/cronometer-gold/actions/runs/35249813424)
passed on attempt one. The final container job completed September 17, 2026,
18:22:44 UTC; the 18:24:11 UTC observation verified complete job inventories.
Clean matching local/tracking/live heads and all eight frozen committed files
were reverified at 18:24:10 UTC. This evidence retains its exact commit scope.
