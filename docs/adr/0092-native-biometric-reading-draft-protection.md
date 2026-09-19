# ADR 0092: Protect native biometric reading drafts

Status: Implemented at `6d8189b`; local and exact-commit automatic evidence passed. Device/release acceptance remains separate.

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
source finding remained. Final canonical and automatic results, pending at the
source snapshot, subsequently passed as recorded below.


## Delivery evidence

Delivered at `6d8189bfb6ff2d1084bf9fbfaba79d646c1aac0c`. The final reviewed
source passed canonical `pnpm check` on September 19, 2026 at 07:21:50–07:22:15 UTC:
2,046 fresh cases, 2,327 cached passes and 93 cached opt-in skips. Canonical
`pnpm build` passed at 07:22:36–52 UTC, with eleven successful tasks, ten cached
and fresh native exports. Cached/skipped cases are not fresh service evidence.

The 09:08:09 UTC official exact-commit observation confirmed all three actual
[CI jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35429227459)
and all nine actual
[container jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35429227472)
completed successfully on attempt one. The 09:09:05 UTC completion verifier found
clean matching local/tracking/live heads and all seven reviewed working-tree and
committed hashes. This closes source delivery, not signed-device or release gates.
