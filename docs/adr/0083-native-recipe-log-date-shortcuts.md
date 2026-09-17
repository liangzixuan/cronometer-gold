# ADR 0083: Native saved-recipe log date shortcuts

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

Native public-food logging has Today and Yesterday shortcuts under ADR 0082.
Saved-recipe logging still requires a typed date despite using the same
profile-local date policy. Adding the two choices makes recent-meal logging
consistent without changing the recipe or diary contracts.

## Decision and acceptance

Add labelled Today and Yesterday buttons beside the saved-recipe log date.
Resolve Today from the clock at activation in the current profile time zone;
Yesterday is the previous local calendar date using the existing diary helpers.
Do not subtract a fixed duration from the current instant. A screen left open
across midnight uses the new day when the person taps a shortcut.

Keep manual date entry and optional time. A shortcut changes only the date
draft: preserve the selected exact recipe revision, portion kind, raw amount,
meal, time, unsaved recipe builder, filters, nutrition basis and secured logs.
It sends no fetch or enqueue; Secure & log recipe remains the explicit action.
Existing blank-time now/noon behavior and explicit-time validation remain intact.
Protected retries retain their original body and identity after date changes.

Route both controls through existing selected-recipe, draft, private/profile,
lifecycle and in-flight guards. Retained callbacks cannot edit a replaced draft
or selection; inactive, unmounted and busy callbacks remain inert. Use button
roles and disabled states rather than treating the relative choices as radios.

## Consequences, alternatives and review triggers

The common recent dates require fewer keystrokes while manual input covers other
dates. A new calendar picker or generalized date-control abstraction would expand
this small parity change. Existing local-calendar helpers and logging guards
remain the authority. Revisit when selected-recipe ownership, log draft or time
policy changes.

This native slice changes no App routing, API/schema, date-helper behavior,
queue protocol or dependency. No install, audit, paid review, service/device/cloud
action or release enablement is included. Component/native export evidence does
not establish concurrent React, physical-device, assistive, hosted or release
acceptance.

## Validation

Reuse the existing recipe-screen harness and date/outbox tests. Record baseline
results, demonstrate shortcut regressions on original source, then cover profile
date differences, midnight, calendar boundaries, unchanged other drafts, stale/
busy/private/lifecycle controls and exact protected retry after date selection.
Pass native types/format, independent native/documentation review and frozen
canonical pnpm check/build. Record cache/skip limits and the pushed commit's
three CI/nine actual container jobs in dated readiness evidence outside Git.


Development evidence on September 17, 2026: the 300-case baseline passed.
Fourteen new shortcut cases and the expanded existing real-queue retry case
failed on original source (15 failures, 206 existing passes). After implementation,
all 314 focused cases passed: 221 recipe-screen cases and 93 existing recipe/date/
outbox cases. Native types/format and independent native/documentation review
passed. The existing synchronous hook harness is not concurrent React or physical-
device proof. Final canonical and automatic outcomes will be recorded separately
in the dated readiness evidence outside Git.
