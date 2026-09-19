# ADR 0092: Protect native biometric reading drafts

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

The native reading form preserves exact decimal text and the saved event's
timestamp precision. Opening Edit on a saved row immediately replaces the form,
even when it contains a new reading or corrections to that same row. Cancel on
an edited reading also resets it immediately. Both paths can erase unsaved
value/date/time without an explicit decision.

History reload, range movement and filtering already preserve the draft. Metric
selection deliberately keeps a new reading's value/date/time. Those established
behaviors do not need additional replacement prompts.

## Decision and acceptance

Capture a baseline for new and saved-reading drafts. Compare the exact raw value,
local date and local time; partially entered or invalid input is unsaved work.
Dirty same/other-row Edit and edited-reading Cancel offer an inline Keep editing
or action-specific discard choice. Pristine replacements remain direct. Keep
retains the metric, every raw field, original saved event/revision and timestamp
precision without a request or operation allocation. Discard performs only the
captured replacement once; it does not save or delete a reading.

Bind replacement and choice callbacks to the current draft, private/profile scope,
foreground lifecycle and request state. Revalidate the selected history row before
opening it. Stale or repeated callbacks, including those retained before a rerender,
must not replace newer work. Make the choice reachable and announced, and hide
obsolete private decisions immediately. Preserve exact mutation retries, unchanged
timestamp omission, imported-reading restrictions and unrelated private drafts.

## Consequences, alternatives and review triggers

One draft remains in memory until accepted save, explicit replacement or existing
private-scope cleanup. Asking for every pristine transition creates unnecessary
friction; silently resetting the form loses work. Existing native inline choices
support this local decision without a new API or persistent draft store.

This slice protects reading Edit/Cancel replacement only. It does not change
definition editing, conflict policy, deliberate metric selection, history browsing,
navigation outside this screen, OS termination or intentional session cleanup.
It adds no dependency, API/schema, offline mutation, service or device operation.
Revisit when editable fields, reading identity, scope, request ownership or
navigation changes.

## Validation

Demonstrate replacement loss paths on original source, then verify raw decimal and
date/time preservation, pristine/reverted fields, same/other row, Keep/Discard,
original revision/precision and exact retries. Exercise changed targets, retained
callbacks before rerender, duplicate decisions, pending requests and private,
profile, background and unmount boundaries. Retain existing reading/history/filter/
date coverage, run native types and scoped Biome, and independently review source
and documentation before final canonical `pnpm check` and `pnpm build`.

Record all three actual CI and nine actual container jobs at this slice's exact
commit. Predecessor success does not transfer. Hook-harness and export evidence
do not establish concurrent React, signed-device, assistive-technology, hosted or
release acceptance. Existing formal release and supply-chain gates remain intact.


Development evidence on September 19, 2026: seven replacement-loss regressions
failed on original source. Final focused validation passed 504 cases in two
actual files (487 screen cases, including 31 new cases, plus 17 recipe/goal
helpers), zero skips. Native types and scoped Biome passed. Independent source
review corrected an obsolete hidden decision after history/filter/read/delete
transitions and aligned field availability with request guards; the draft remains
intact when those decisions retire. The existing date-shortcut regression now
uses explicit discard while retaining its stale-callback assertions. No open
source finding remains. Final canonical and exact-commit automatic evidence is
pending in the dated outside-Git readiness record.
