# ADR 0013: Define a durable native public-food quick-add outbox

- Status: Accepted for local implementation; signed-device and general offline
  synchronization acceptance remain evidence-gated
- Date: 2026-09-01
- Scope: native mobile creates through `POST /v1/diary/entries` for promoted
  public foods with reviewed gram-resolved default servings

## Context

The native quick-add path currently keeps an idempotency key and request body
only in process memory. That protects an ambiguous response while the process
survives, but an operating-system kill or app restart can lose the identity
needed to replay the exact request. Creating a new operation after that loss can
duplicate a diary entry.

The server already stores one canonical request digest and immutable result for
each authenticated owner and operation ID in the same PostgreSQL transaction as
the diary mutation. A durable client can therefore recover from a crash after
commit by replaying the exact operation. The durable state is private diary
intent, however, and must not become an unencrypted cache of credentials,
searches, cursors, notes, or arbitrary requests.

A queued request also stores an instant while the server derives its diary day
from the profile time zone at first delivery. Another client can change that
profile value while the phone is offline. A client-side profile refresh narrows
but cannot close the race, so exact selected-day preservation requires a server
precondition in the create transaction.

## Decision

Implement one deliberately bounded native outbox. It accepts only creates for a
promoted public food version and its reviewed gram-resolved default serving,
with serving amount exactly one. It does not accept edits, deletes, repeats,
recipes, custom foods, notes, arbitrary serving quantities, or other HTTP
operations. Web persistence, background execution, and manual reordering are
separate decisions.

Persist at most 50 active items per device in native `SecureStore` using
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The journal has a small versioned manifest and
50 fixed, enumerable slots. Each strict closed envelope contains only its
sequence, authenticated owner ID, UUID operation ID, enqueue time, selected
local date, expected IANA profile time zone, bounded display labels, and the
exact create body. It contains no bearer or reauthentication token, response
body, arbitrary header or URL, pagination or search cursor, query or barcode,
search text, private note, edit payload, recipe, or custom-food request.

The cap includes a blocked head. Item 51 fails before any network request, and
the client never evicts an older item to make room. There is no time-to-live or
age-based deletion: `enqueuedAt` is informational, and an unacknowledged
operation remains until exact verified delivery, confirmed head-only discard,
or mandatory private-device cleanup.

Append is persist-and-read-back before the first network byte. Journal append,
acknowledgment, block, retry, discard, and clear operations are serialized and
guarded by the expected owner, sequence, head identity, and controller epoch.
The manifest advances only after its slot is durable. A successful response
removes only the expected head, and only after that removal is durable may the
runner continue to the next item. Fixed enumeration permits complete cleanup
even when the manifest is absent or corrupt.

Each newly appended operation receives an in-memory registration hold before
its first storage await. An already-running startup or foreground drain treats
that held head as pending. The initiating screen first records the exact
operation ID with its receipt subscriber, then releases only that ID while
requesting a drain. Lifecycle drain requests without an ID cannot release a new
enqueue. A restarted controller has no new-enqueue hold and may replay the
already durable head after the app-wide receipt fanout is installed.

Run one FIFO drain promise and at most one request at a time while the native app
is foregrounded. Authenticated startup, foreground resume, enqueue, and explicit
retry may request a drain. Background or inactive state aborts the current
request and starts no timer, connectivity daemon, headless task, or Expo
background job. An abort or lost response retains the exact operation.

A response acknowledges the head only when it is `201` with `replayed:false` or
`200` with `replayed:true`, passes the strict diary-mutation contract, returns
the same public food version, serving, meal, instant, expected time zone and
selected local date, and identifies that date in its affected-day metadata.
Network failures, aborts, `408`, `425`, `429`, server errors, and malformed or
contradictory success responses remain ambiguous and pending.

Definitive `400`, `403`, `404`, `409`, `410`, `412`, `422`, or `428` responses
persistently block the FIFO head. The UI exposes its bounded label, date, meal,
and status and offers exact retry or confirmed head-only discard. It cannot
skip or reorder the item. The first `401` synchronously fences and aborts the
runner, closes private UI, and enters one app-global unauthorized cleanup
flight; no trailing item may be sent.

Sign-out, terminal unauthorized, accepted erasure, owner mismatch, orphaned
credential recovery, or unrecoverable journal corruption must clear all fixed
slots. The versioned private-cleanup marker includes that deletion as its first
local step, migrates an older marker by adding the step, and blocks private UI
until failed deletion can be retried. A storage operation already waiting when
cleanup begins cannot resurrect the queue after the controller epoch changes.

Guarded creates use both
`profileTimeZonePrecondition=v1` and
`X-Expected-Profile-Time-Zone`. The two signals are paired: either alone is a
generic validation error. Their guarded digest has a separate versioned domain
and binds the canonical expected zone; requests with neither keep the legacy
digest and behavior byte-for-byte.

The database takes the existing per-owner diary advisory lock, locks the active
account row, returns an exact stored replay if one exists, then reads the
profile time zone in a fresh statement. A first delivery whose canonical
expected and current zones differ commits nothing and returns typed
`409 DIARY_TIME_ZONE_CHANGED` without exposing either value. Exact guarded and
legacy replays remain valid after a later profile change. Profile updates take
the same account-row lock, so first-delivery comparison and day derivation are
atomic without a migration.

The query marker is also fail-closed capability negotiation: the pre-feature
route's closed empty-query validator rejects it before persistence, whereas an
unknown custom header alone would be ignored. Backend support and fleet
convergence precede release of a client that sends guarded requests.

## Consequences

Process death before send, after server commit, or before local dequeue can be
recovered without manufacturing a second operation. Two deliberate identical
Add presses remain two distinct operations. FIFO blocking is intentionally
conservative: one invalid promoted food or serving stops later queued creates
until the person reviews the head.

SecureStore is a bounded private journal rather than a general offline
database. Fifty small fixed envelopes are reviewable and deterministically
erasable, but this design does not prove performance, persistence, lock/unlock,
OS-kill, accessibility, or lifecycle behavior on a signed iOS or Android
binary. Those remain physical-device acceptance gates.

The time-zone precondition adds one backward-compatible server path and one
typed conflict. Legacy callers do not opt in. A future general offline system
must not silently widen this create-only contract or treat local queue order as
authoritative diary-entry order.

## Alternatives considered

- **Keep the in-memory map:** rejected because process death loses the operation
  identity needed for exact replay.
- **Create a new operation after restart:** rejected because a lost successful
  response can then become a duplicate diary entry.
- **Use unencrypted filesystem, AsyncStorage, or an arbitrary request cache:**
  rejected because queued diary intent is private and broad persistence expands
  the credential, corruption, and erasure surface.
- **Run in the background:** rejected because this slice has no reviewed
  background-network, power, lifecycle, or signed-device evidence.
- **Skip a terminal head:** rejected because it changes FIFO semantics and can
  deliver later diary intent out of order without user review.
- **Expire items by age:** rejected because silent deletion loses explicit
  diary intent; a future retention limit needs user-facing review semantics.
- **Compare a freshly fetched profile in the client:** rejected because the
  profile can change after that read and before first delivery.
- **Signal the precondition with a header only:** rejected because an older API
  can ignore it and persist on the wrong local day.

## Review triggers

Review this decision before changing the 50-item or slot-size bounds; persisting
another field or operation type; adding edits, deletes, repeats, recipes,
custom foods, notes, quantities, background work, timers, connectivity
listeners, web persistence, manual reorder, automatic discard, or expiry;
changing SecureStore accessibility or journal ownership; sending more than one
request at a time; changing terminal or ambiguous status classification;
changing acknowledgment matching; changing the guarded digest, query marker,
header, error taxonomy, lock order, or replay-before-precondition rule; allowing
mixed backend fleets; sharing a device queue across accounts; or claiming
signed-device, general offline-sync, controlled-beta, or release acceptance.
