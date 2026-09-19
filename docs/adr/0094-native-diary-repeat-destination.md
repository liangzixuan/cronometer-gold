# ADR 0094: Choose the native diary repeat destination

Status: Implemented at `8e0db9e`; local and exact-commit automatic evidence passed. Device/release acceptance remains separate.

## Context

The native diary can repeat a pinned logged food or recipe only to today in its
original meal group. Reusing that same entry on another day or meal therefore
requires extra work, although the existing durable repeat contract already accepts
an explicit destination date and group.

## Decision and acceptance

Keep the one-tap Repeat today shortcut. Add a per-entry Repeat to composer with a
profile-local calendar date and the configured meal groups. Show the selected
destination, explicit confirmation and Cancel. Keep the source group expanded
while the composer is open. Opening, changing or cancelling a destination creates
no operation. Validate the calendar date before enqueue and use the existing
quick-add instant policy: the current instant for today, noon in the profile time
zone for another date. This slice does not offer a custom time.

An explicit confirmation queues the original source entry identity and revision
through the existing protected FIFO. Preserve source and destination dependency
checks, exact retries and immutable pinned food/recipe contents, quantity and note.
Leave the original entry and confirmed totals unchanged until a server receipt.
Retain the destination after a known enqueue failure; accepted or ambiguous enqueue
must not invite another submission. Preserve ambiguous-storage recovery and drain
the durable operation even if its originating screen context has since changed.

Fence duplicate and retained callbacks against the current composer, source
snapshot, day, profile, session, foreground state and request context. Retire a
composer when its source or private context is replaced; stale callbacks must not
enqueue or restore private UI. Display destination group names from the configured
stable group identifiers and announce the destination and validation feedback.

## Consequences, alternatives and review triggers

This exposes an existing repeat capability without new API, schema, dependencies
or storage formats. A date/group composer avoids searching for the original food
or rebuilding a recipe. Keeping Repeat today preserves its existing fast path.
Adding custom time, quantity changes, bulk repeat or persistent drafts would widen
the task and is deferred. Local composition is not OS-termination or cross-screen
navigation protection. Revisit if source identity, repeat envelopes, group
identifiers, time policy, queue dependencies or lifecycle ownership change.

## Validation

Use the actual DiaryScreen harness to verify explicit date/group envelopes,
unchanged Repeat today, invalid-date and Cancel zero-enqueue behavior, source and
target dependencies, duplicate/stale callbacks, enqueue outcomes, refresh/receipt
replacement and private cleanup. Reuse the existing outbox and date helper tests;
run affected native types and scoped Biome. Independently review final source and
documentation, freeze the seven files, then run canonical `pnpm check` and
`pnpm build`. Require all three actual CI and nine actual container jobs at the
delivered commit. Predecessor success does not transfer.

Hook-harness and export evidence do not establish concurrent React, physical-device,
assistive-technology, hosted or release acceptance. Those formal gates remain
separate. No services, browser/device QA, installation or local production audit
is part of this slice.

Development evidence on September 19, 2026: four missing-capability cases failed
on original source. Final focused validation passed 184 cases with no skips:
108 actual-screen cases, including 27 new cases, plus 30 diary-helper and 46
durable-outbox cases. Native types and scoped Biome passed. Independent review
added controller-identity fencing and explicit validation announcements and made
the new tests' clock deterministic. A malformed pagination test fixture was
corrected to the existing 20-entry page contract; production parsers and gates
were unchanged. Existing assertions remain intact. At that development checkpoint,
final canonical and exact-commit automatic evidence was still pending.

## Delivery evidence

Delivered at `8e0db9e71381e19fa813bba9ed8ae4b02194db69`. Canonical check on
September 19 passed 2,101 fresh cases plus 2,327 cached cases, with 93 cached
opt-in skips. Build passed 11 tasks, ten cached, with fresh native exports.
The 12:57:16 UTC official observation records all three actual jobs in
[CI 35440114966](https://github.com/liangzixuan/cronometer-gold/actions/runs/35440114966)
and all nine actual jobs in
[container run 35440114959](https://github.com/liangzixuan/cronometer-gold/actions/runs/35440114959)
completed successfully on attempt one at that exact commit. At 12:57:58 UTC,
clean local, tracking and live heads and seven reviewed working-tree/committed
hashes matched. Prior pending observations remain dated history; these results
do not establish physical-device or release acceptance.
