# ADR 0082: Native public-food log date shortcuts

Status: Implemented at 2e77f20; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

Public-food search and barcode results share a native diary destination with a
manual YYYY-MM-DD date. Optional local time is available under ADR 0081, but
recording yesterday's meal still requires typing its calendar date. Today and
Yesterday cover common retrospective logging without a new picker or API.

## Decision and acceptance

Add Today and Yesterday controls beside the existing diary date input. Resolve
Today in the current profile time zone from the clock at activation. Resolve
Yesterday by shifting that local calendar date by one day with the unchanged
diary helpers; do not subtract a fixed duration from the current instant. A
screen left open across midnight must use the new day when the control is used.

Keep manual date entry and the explicit Add action. A shortcut changes only the
date draft: retain optional time, meal, raw quantities, selected food versions,
search/barcode results and secured requests. It sends no fetch or enqueue. The
existing blank/explicit time validation still runs at Add, and durable retries
keep their original bytes and identity even after a different date is selected.

Reuse the existing draft/context/lifecycle and in-flight guards. Retained
callbacks cannot change a replaced draft or route/private/profile context;
inactive, unmounted and busy controls remain inert. Both search and barcode
paths use the shared destination, with labelled buttons and disabled state.

## Consequences, alternatives and review triggers

People can choose the common recent dates without typing them. Manual entry
continues to support any valid date; a calendar picker would add unnecessary
scope. Existing profile-local helpers preserve the calendar/time policy. Revisit
this decision when destination ownership, time policy or queued logging changes.

This slice changes native presentation and its focused tests. It adds no web,
API/schema, queue protocol, dependency or date-helper behavior. No installation,
audit, service/device/cloud or paid review is included. Component/native export
proof does not establish signed-device, accessibility, hosted or release acceptance.

## Validation

Use the existing actual-screen hook harness. Demonstrate missing shortcuts on
original source, then verify search/barcode parity, profile-zone date differences,
midnight and calendar boundaries, unchanged drafts, stale/busy/lifecycle controls
and exact durable retry after a date selection. Pass focused tests, native types
and formatting, independent source/documentation review and frozen canonical
pnpm check/build. Record fresh/cached/skipped limits and the exact pushed commit's
three CI/nine actual container jobs in dated readiness evidence outside Git.


Development evidence on September 17, 2026: the 119-case baseline passed.
Fourteen added shortcut cases and the expanded existing durable-retry case
failed on original source (15 failures, 34 existing passes). After implementation,
all 133 focused cases passed: 49 actual-screen cases and 84 existing helper/search/
outbox cases. Native types/format and independent source/documentation review
passed. The synchronous hook harness does not establish concurrent React or
physical-device behavior. Final canonical and automatic outcomes are recorded
separately in the dated readiness evidence.


## Delivery evidence

Delivered at `2e77f20e9ff1b6f8fb3cf67e8d21ce3c50d4f1cb`. Canonical pnpm
check passed 1,817 fresh tests, with 2,327 cached passes and 93 cached opt-in skips.
Build passed 11 tasks, ten cached; Android/iOS exports were fresh. All three
actual jobs in [CI 35261057866](https://github.com/liangzixuan/cronometer-gold/actions/runs/35261057866)
and all nine actual jobs in [container 35261057887](https://github.com/liangzixuan/cronometer-gold/actions/runs/35261057887)
passed on attempt one. The final web job completed September 17, 2026, 20:14:35 UTC.
The 21:15:24 UTC observation verified exact job inventories and successful
outcomes; clean matching local/tracking/live heads and all seven frozen committed
files were reverified at 21:15:21 UTC. This evidence retains its exact commit scope.
