# ADR 0084: Native custom-food log date shortcuts

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

Native public-food and saved-recipe logging offer Today and Yesterday. Custom-
food logging still requires a typed date. It already accepts a required local
clock time and pins an exact private food version. Complete the recent-date
choices while preserving that time policy and the person's other drafts.

## Decision and acceptance

Add Today and Yesterday buttons beside the custom-food log Local date. Compute
Today in the profile time zone when activated; Yesterday is the previous calendar
date through the existing date helper, not a fixed-duration subtraction. Resolve
the new date at activation even when the screen has remained open across midnight.

Change only localDate. Keep manual date entry, required local time, raw quantity,
portion kind, meal, exact food/version, unsaved custom-food editor/composer,
filters and secured operations. Date choice sends no request or enqueue. Secure
& log pinned version stays the explicit action; time validation and protected
retry bytes/identity remain unchanged. Selecting the existing date is a no-op.

Guard the new actions with synchronous draft identity and a draft-origin token
bound to private/profile and queue-controller context. Opening a log draft records
its origin; ordinary edits cannot rebind an older draft to a replacement context.
An old-origin draft keeps the new shortcuts disabled until reopened. Existing
scope/epoch guards reject inactive, unmounted or retired callbacks; loading,
busy and in-flight enqueue actions are inert. Give the buttons accessible button
roles and disabled states. This is scoped to the new shortcuts, not a claim that
all existing custom-log actions use the same guards.

## Consequences, alternatives and review triggers

Recent dates require fewer keystrokes and match the other native food-entry
flows. Manual input remains for any other date. A calendar picker, generalized
control abstraction or broad logging refactor would expand this bounded change.
Small draft-reference/origin metadata supports the new controls without changing
the existing Log, Cancel or receipt behavior. Revisit if draft ownership, profile
context, queue identity or required-time policy changes.

No App routing, API/schema, date-helper behavior, queue protocol or dependency
change is included. No installation, audit, paid review, browser/service/device/
cloud action or release enablement. Component and native-export evidence is not
concurrent React, physical-device, assistive, hosted or release acceptance.

## Validation

Use the existing actual-screen custom-food harness and affected date/food/outbox
suites. Capture a baseline and new regressions failing on original source before
passing fixed source. Cover profile-local dates, midnight/calendar boundaries,
preserved drafts and required time, explicit exact-version logging, stale and
replaced-origin controls, private/profile/controller changes, lifecycle/busy
states and unchanged secured retry requests. Pass native types/format, independent
native/documentation review and frozen canonical pnpm check/build. Record cached/
skipped evidence explicitly, then the pushed commit's actual three CI and nine
container jobs in the dated readiness record outside Git.


Development evidence on September 18, 2026: the 577-case baseline passed.
The 15 new screen regressions failed on original source, with 382 existing
cases passing. Fixed source passed all 592 focused cases (397 screen and 195
food/date/outbox cases), native types/format and independent native/documentation
review. The existing synchronous hook harness does not establish concurrent
React or physical-device behavior. Final canonical and exact-commit automatic
outcomes will be recorded separately in the dated readiness evidence outside Git.
