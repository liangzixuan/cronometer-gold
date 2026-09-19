# ADR 0096: Choose native activity time occurrences explicitly

Status: Implemented at `e3eb556`; local and exact-commit automatic evidence passed. Device/release acceptance remains separate.

## Context

A local clock minute can occur twice when the time-zone offset moves backward.
The native activity form accepts HH:MM, but its deliberate Add and date/time
correction paths convert that input to one instant without asking which occurrence
the person intended. Untouched captured Add timestamps and non-time corrections
already preserve the exact existing instant; that behavior must remain intact.

## Decision and acceptance

Use the existing shared local-minute candidate resolver for deliberately selected
activity start times. When the minute has multiple occurrences, offer explicit
Earlier/Later choices with their UTC offsets and require a current candidate
before sending. Invalid and nonexistent local times remain rejected. Cover both
new activities, including the reused-name/duration workflow, and corrections.
Allow deliberate selection of the other occurrence of the same displayed minute.

Preserve the exact captured timestamp for an untouched Add default. Name,
duration and self-reported-energy corrections alone must preserve the saved
occurrence, seconds/milliseconds and stored zone. Explain that explicitly choosing
a time occurrence uses minute precision. Changing input coordinates or their
private/day context retires old choices. A retained callback must not apply an
old candidate to newer input, revive private data or bypass the existing ready,
revision, lifecycle and scope checks.

Keep the existing dirty-edit Keep/Discard behavior, expected-profile-zone
precondition, strong entry revision, validated mutation receipt and exact
idempotent retries. Activity remains online-only; its optional self-reported
energy remains history and never changes targets, remaining calories or PAL.

## Consequences, alternatives and review triggers

This adds an explicit user decision where the old conversion silently chose one
occurrence. It reuses the existing IANA-based candidate resolver without changing
its contract or time arithmetic. Automatically choosing Earlier or Later would
leave the intent ambiguous. A broad cross-client time-editor redesign is outside
this bounded slice; web and other logging forms are unchanged.

No API, schema, dependency, storage, catalogue, notification or nutrition policy
changes are included. Revisit if the supported timestamp precision, shared
candidate resolver, profile-zone precondition or native lifecycle contract changes.

## Validation

Use helper and actual-screen behavior tests for ordinary minutes, both fold
occurrences, a non-hour transition, gaps, exact untouched defaults, non-time
correction precision, same-minute occurrence changes, retired candidates,
private/stale actions and exact retries. Run affected native types and scoped
Biome, independently review final source and documentation, then canonical
`pnpm check` and `pnpm build`. Delivery requires all three actual CI jobs and all
nine actual container jobs at the exact resulting commit.

Hook-harness and native export results do not prove concurrent React, real-device
TZDB/lifecycle behavior, assistive-technology, hosted or release acceptance. This
slice does not authorize services, browser/device QA, installation, audit or paid
review; those existing boundaries remain unchanged.


Development evidence on September 19, 2026: three baseline regressions failed
before implementation. Final focused checks passed 130 cases with no skips:
108 actual-screen cases and 22 helper cases, including 19 new cases. Native
types and scoped Biome passed. Independent review covered current candidate
validation, exact default/non-time precision, loaded-zone replacement, protected
Keep/Discard, scope/lifecycle guards and exact uncertain retries.

Development failures remain recorded: the first run exposed a captured-default
regression on date-away/back; its existing assertion was preserved and the
implementation corrected. An earlier expectation for manual same-minute input
was updated to require the new explicit choice. Expanded tests also caught
reference invalidation without a render after identical time input. Deliberate
time re-entry now requests a render, while unchanged metadata/date values and
reselecting the current candidate remain true no-ops. Final canonical and exact-
commit automatic evidence was pending at the source checkpoint; the following
delivery record closes that dated state.


## Delivery evidence

Delivered at `e3eb556febdb9ca97fe01b8f307d8868e32c8804`. Canonical check on
September 19 passed 2,137 fresh cases plus 2,327 cached cases, with 93 cached
opt-in skips. Build passed 11 tasks, ten cached, with fresh native exports.
The 16:48:41 UTC official observation records all three actual jobs in
[CI 35451489011](https://github.com/liangzixuan/cronometer-gold/actions/runs/35451489011)
and all nine actual jobs in
[container run 35451489006](https://github.com/liangzixuan/cronometer-gold/actions/runs/35451489006)
completed successfully on attempt one at that exact commit. At 16:49:22 UTC,
clean local, tracking and live heads and nine reviewed working-tree/committed
hashes matched. Earlier pending observations remain dated history. These results
do not establish physical-device, assistive-technology or release acceptance.
