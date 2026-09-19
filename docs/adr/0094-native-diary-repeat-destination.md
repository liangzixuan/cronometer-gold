# ADR 0094: Choose the native diary repeat destination

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

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
were unchanged. Existing assertions remain intact. Final canonical and
exact-commit automatic evidence remains pending in the dated outside-Git record.
