# ADR 0024: Durable diary corrections and atomic day ordering

## Status

Accepted for local source implementation. Signed-device lifecycle, protected-storage,
OS-kill, accessibility, hosted, and controlled-beta evidence remain blocked.

## Context

ADR 0023 generalized the native encrypted FIFO for public-food, recipe, and custom-food
creates, but intentionally left repeat, update, delete, and manual ordering online-only.
Those operations need stronger evidence than a create: a retry must prove the exact source
revision it acted on, a correction may affect two local days, and ordering must change one
complete day all at once. Replaying scalar `position` patches could expose a partial order,
silently overwrite another client, or acknowledge the wrong result after restart.

The existing native journal is limited to 50 items of at most 1,600 UTF-8 bytes each in
protected storage. A valid private note may contain 2,000 Unicode code points and therefore
does not always fit. The web has stable in-memory retry identities but no durable browser
journal. A diary day also retains the zone in which it was created; that zone can differ from
the owner's current profile zone after travel or a settings change.

## Decision

Native diary journal version 3 adds a closed union of repeat, update, delete, and full-day
reorder operations while preserving lossless parsing and replay of versions 1 and 2. Routes,
methods, identifiers, concurrency headers, and query markers are derived from the parsed
operation kind; protected storage never supplies an arbitrary URL or header. The existing
owner-bound 50-item FIFO, persist-before-send rule, one-foreground-request rule, terminal-head
recovery, and no-eviction policy continue to apply.

Every correction records the expected entry revision. Its server receipt uses protocol `v1`
and binds the operation UUID, correction kind, one expected subject, one exact result subject
and state, and the authoritative affected-day revisions. Update and delete for an entry cannot
be queued behind another pending update or delete for that entry. Repeat is independent because
it reads a pinned immutable source revision and creates a new entry. A time-changing update and
every repeat carry the current profile-zone precondition; exact idempotent replay is checked
before later profile-zone drift is rejected.

Version 3 remains lossless within the reviewed 1,600-byte slot. It never truncates notes and
never silently falls back to an online-only send after a capacity failure. A correction whose
serialized envelope is too large receives a typed capacity error and is not sent. This means a
valid long note can still be edited online but is not claimed as universally queueable offline.

Manual ordering is one `PUT /v1/diary/days/:localDate/order` operation over a completely loaded,
open day of at most 50 active entries. The compact body contains all four canonical meal keys;
each value is an exact permutation of that meal's baseline indexes. Version 1 does not move an
entry between meals. The request binds an exact day revision, the current profile-zone guard,
and a lowercase SHA-256 digest of the baseline. Reorder cannot be queued while any earlier
operation touches that day, and a later operation touching the day cannot be queued behind a
pending reorder.

The canonical digest payload is the UTF-8 JSON encoding of:

```text
["diary-day-order-v1", localDate, dayTimeZone, orderedGroups]
```

`orderedGroups` is breakfast, lunch, dinner, then snacks; each group contains ordered
`[entryId, entryRevision, position]` tuples. The current profile zone is the concurrency guard,
while `dayTimeZone` is the persisted diary-day zone used by the digest and receipt. They are
deliberately distinct. The client persists both the expected baseline digest and expected final
digest, so a post-restart acknowledgment proves the intended result without persisting up to 50
UUIDs.

The server locks the owner diary and exact day, verifies replay before later state checks,
validates the complete baseline and digest, then assigns contiguous positions `0..n-1` within
each meal. Only entries whose numeric position changes receive one new immutable revision;
unchanged entries retain their revision. The day revision increments exactly once, including a
valid no-op. The operation ledger stores the canonical final groups, previous and final digests,
expected and resulting day revisions, operation UUID, local date, and day zone. Any malformed,
stale, locked, cross-owner, mismatched-digest, or idempotency-reuse request fails closed.

The browser uses the same strong correction and reorder protocols and validates receipts, but
its retry UUIDs remain memory-only. Browser recipe and custom-food logging now opt into their
existing paired profile-zone guards; authoring remains online-only. Neither client gains an
offline catalogue, a readable cold-start diary cache, parallel or background delivery, or
cross-meal reordering from this decision.

## Consequences

A person can queue a repeat, edit, or deletion, close and reopen the native app, and later get
one exact confirmation or an explicit conflict. Once a complete day is loaded, web and mobile
can move entries within a meal without exposing a half-applied sequence. Another client that
changed the entry, day, profile zone, or order wins visibly through a typed conflict and refresh;
it is never silently overwritten.

Immutable revisions and exact receipts increase database and test volume. Compact permutations
avoid exceeding protected-storage bounds, but require the complete day before ordering. The
1,600-byte bound means offline editing of every syntactically valid 2,000-code-point note is not
yet supported. Source tests can prove deterministic serialization, FIFO dependencies, receipt
matching, API/DB transactions, and web convergence; they cannot substitute for signed iOS and
Android protected-storage, lifecycle, OS-kill, screen-reader, or real-network acceptance.

## Alternatives considered

- **Scalar position patches:** rejected because a crash or competing client can observe or leave
  a partial order.
- **Persist every entry UUID in a reorder:** rejected because a 50-entry day can exceed the
  reviewed protected-storage slot.
- **Truncate long notes:** rejected because a private note must be lossless.
- **Send oversized corrections immediately:** rejected because success followed by process death
  can lose the retry identity and create ambiguous state.
- **Use the diary-day zone as the profile guard:** rejected because historical day zones and the
  current profile zone legitimately differ.
- **Create a browser database in this slice:** deferred; it changes logout, erasure, multi-tab,
  corruption, and storage-threat boundaries.
- **Claim full offline sync:** rejected because catalogue and readable diary data are not cached.

## Review triggers

Review this decision before changing the journal version or slot/count bounds; adding operation
kinds, arbitrary routes, cross-meal moves, partial-day reorder, bulk edits, background/parallel
delivery, browser persistence, note truncation, automatic discard/expiry, or readable offline
catalogue/diary caches; changing current-profile versus persisted-day zone semantics, digest
bytes, revision transitions, receipt fields, dependency rules, replay ordering, owner fencing,
or erasure cascades; or claiming signed-device, accessibility, hosted, controlled-beta, or full
offline-sync acceptance.
