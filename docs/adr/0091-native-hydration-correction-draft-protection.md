# ADR 0091: Preserve native hydration correction drafts

Status: Implemented at `58a48f9`; local and exact-commit automatic evidence passed. Device/release acceptance remains separate.

## Context

A hydration correction can include a raw amount, an explicit local date/time and
a repeated-hour occurrence choice. Native Cancel, row replacement and selected-day
navigation clear it without a decision. More surprisingly, successfully adding
another drink or deleting another entry also clears it: every accepted mutation
uses the same editor cleanup. Conflict Reload likewise drops the draft before
the replacement read succeeds. These paths can erase a correction that was never
saved or deliberately discarded.

## Decision and acceptance

Keep one correction draft tied to its exact saved entry and original revision.
Compare raw amount, time-edit mode, local date/time, captured zone and occurrence;
partial or invalid input remains meaningful unsaved work. Pristine local actions
remain direct. Dirty Cancel, opening another row, a valid different selected date
or conflict Reload requires an inline Keep editing or action-specific discard
choice. Keep preserves every field and restores the selected-day input without
fetching, writing, generating an operation ID or rebasing the entry revision.
Invalid and same-day date submissions do not discard the correction.

Successful Add or deletion of a different entry preserves the correction through
the day refresh. A validated save or deletion of the edited entry may clear it.
Preserve the exact serialized request, idempotency key and revision during ambiguous
acceptance and retry. A refreshed day does not silently adopt a newer revision
into the correction. Explicit discard/reload clears it only after a validated
same-day read; failed recovery retains the draft and required-reload guard.

Bind actions and decisions to the current private scope, foreground lifecycle,
selected day, draft and request state. Ignore obsolete or duplicate callbacks,
including changes before rerender. A replacement scope cannot briefly display an
old private choice before effects run. Scroll to the choice and announce it when
requested; lower editor controls must not leave the decision offscreen.

## Consequences, alternatives and review triggers

This repairs the correction lifecycle in one slice, including interactions with
the independent Add form. Blocking all unrelated actions would prevent useful
logging while correcting a row; clearing every editor after every mutation loses
work. Always asking on pristine drafts adds avoidable friction. Existing native
inline decision patterns support explicit, scoped replacement without new APIs.

The slice changes only native client state and behavioral tests. It does not add
draft persistence, protect navigation outside this screen or OS termination,
change intentional private-scope cleanup, add offline mutation, change hydration
math, or provide intake advice. No API/schema, dependency or service change is
required. Revisit when editable fields, entry identity, time-zone handling,
mutation receipts, request ownership or navigation change.

## Validation

Demonstrate the loss paths on original source, then verify dirty/pristine/reverted
fields, date/time and repeated-hour choices, Keep/discard transitions, unrelated
mutation success, failed refresh and conflict recovery, exact retries, stale and
duplicate callbacks, and session/foreground/unmount fences. Run the actual-screen
and hydration helper suites, native types and scoped Biome. Independently review
the integrated source and prose before canonical `pnpm check` and `pnpm build` on
the final frozen source. Record all three actual CI and nine actual container
jobs at its own commit; predecessor success does not transfer.

Hook-harness and export evidence do not establish concurrent React, signed-device,
assistive-technology, hosted or release acceptance. No installation, local audit,
paid external review, services, browser QA, device or cloud action is authorized
by this slice. Existing formal release and supply-chain gates remain intact.

Development evidence on September 19, 2026: ten targeted regressions failed on
original source using valid mutation inputs (56 other screen cases filtered).
The final focused suites passed 77 cases (66 screen, eleven helper), zero skips,
plus native types and scoped Biome. Independent review corrected the retained
absent-row presentation and its save guard, and made a captured-zone mismatch
expose explicit recovery. The retained row does not enter the authoritative day
count or total. No open source finding remained. Final canonical and automatic
results, pending at the source snapshot, subsequently passed as recorded below.


## Delivery evidence

Delivered at `58a48f945c04fffebda8dcbd4b90658de04f5110`. The final reviewed
source passed canonical `pnpm check` on September 19, 2026 at 01:56:14–40 UTC:
2,015 fresh cases, 2,327 cached passes and 93 cached opt-in skips. Canonical
`pnpm build` passed at 01:56:59–01:57:18 UTC, with eleven successful tasks,
ten cached and fresh native exports. Cached/skipped cases are not fresh services.

At 03:38 UTC, official exact-commit observations confirmed all three actual
[CI jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35414271122)
and all nine actual
[container jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35414271110)
completed successfully on attempt one. The 03:39:12 UTC completion verifier found
clean matching local/tracking/live heads and all seven reviewed working-tree and
committed hashes. This closes source delivery, not signed-device or release gates.
