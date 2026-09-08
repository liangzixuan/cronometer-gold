# ADR 0023: Generalize the native diary logging outbox

- Status: Accepted for local implementation; signed-device and general offline
  synchronization acceptance remain evidence-gated
- Date: 2026-09-08
- Scope: native mobile creates for public foods, exact recipe versions, and exact
  private custom-food versions

## Context

ADR 0013 made one public-food, default-serving, amount-one create durable across
process death and ambiguous network responses. That is useful but it does not
cover the normal logging loop: a person may choose another serving amount, use
grams, or log a recipe or private custom food. Those paths currently retain an
idempotency key only while the process survives, so an app kill can force a
choice between losing intent and risking a duplicate.

The existing 50-slot device-only SecureStore journal, owner fence, registration
hold, foreground FIFO runner, exact server replay, terminal-head recovery, and
private-device cleanup ledger already provide the reviewed durability boundary.
Creating separate queues per food kind would destroy the user's single ordering
of diary intent and make capacity, cleanup, and failure recovery ambiguous.

Recipe and custom-food logging derive a profile-local day from an instant just as
public-food logging does. A first delivery must therefore use the same atomic
profile-time-zone precondition. A client refresh alone cannot close the race with
another client's profile update.

## Decision

Generalize the existing native journal in place to one closed union of diary-log
operations:

- the legacy version-1 public-food/default-serving/amount-one envelope;
- a version-2 public-food log with either a positive default-serving amount or a
  positive gram amount;
- a version-2 exact recipe-version log with either a positive recipe-serving
  amount or a positive gram amount; and
- a version-2 exact private custom-food-version log with either its pinned
  serving and a positive amount or a positive gram amount.

Keep the version-1 manifest, storage keys, 50 fixed slots,
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility, 1,600-byte per-slot limit, owner
binding, and cleanup enumeration. Existing committed version-1 items remain
valid and replay through the same FIFO without rewriting or loss. New item kinds
do not create another manifest, queue, capacity pool, or runner.

Each version-2 envelope contains only the immutable request and the bounded
identity needed to render and verify it: sequence, owner, UUID operation ID,
enqueue instant, expected IANA profile zone, selected local date, operation kind,
bounded label and portion text, fixed source-root/version identifiers, exact
portion, meal, occurred-at instant, and optional terminal block state. It contains
no token, arbitrary URL, arbitrary header, response body, search query, barcode,
cursor, private note, recipe definition, custom-food definition, or catalogue
document.

The controller derives one allow-listed route and method from the operation kind;
persisted data cannot select a host, route, method, or header. It persists and
reads back the operation before any network byte, retains one app-wide
registration hold and receipt fanout, and drains at most one head at a time only
while foregrounded. Item 51 fails without eviction. A terminal head cannot be
skipped or reordered; the app-wide diary status names the bounded item, date,
group, and failure and offers exact retry or confirmed head-only discard.

Every new request pairs `profileTimeZonePrecondition=v1` with
`X-Expected-Profile-Time-Zone`. Public-food, recipe-log, and custom-food-log
routes reject either signal alone. Their guarded idempotency domains bind the
canonical expected zone. The database returns an exact stored replay before
comparing the current zone; a first delivery after zone drift returns typed
`409 DIARY_TIME_ZONE_CHANGED` with no diary write. Backend convergence precedes
release of the generalized client.

The head is acknowledged only for `201` with `replayed:false` or `200` with
`replayed:true` after the strict diary-mutation parser accepts the response and
the entry exactly matches the stored kind, immutable version, portion, meal,
instant, selected date, expected zone, and affected-day record. A private
custom-food receipt matches its root ID, mapped immutable version ID, and pinned
version number. Malformed or contradictory success remains pending.

The web public-food search experience may submit positive default-serving or gram
quantities through its existing online request path with the paired profile-time-zone
precondition, but its retry identity remains in memory and it does not gain browser
persistence from this decision. Existing web recipe and custom-food logging are
legacy online-only paths outside this decision: they use neither this outbox nor the
paired profile-time-zone precondition and therefore retain a profile-time-zone race
until separate convergence work. Recipe and custom-food authoring also remain
online-only.

M1C is split into two source slices. M1C-A is this native durable logging union plus
public-food quantity selection and guarded browser/mobile public-food convergence;
it makes no browser/mobile recipe/custom-food logging parity claim. M1C-B remains responsible for
durable repeat, edit, and delete plus a day-revision-bound atomic entry-ordering
protocol. A scalar per-entry position patch is not accepted as an atomic reorder
design.

## Consequences

A person can record already-loaded foods, recipes, and custom foods during a
network interruption, restart the app, and later receive exactly one confirmed
entry per operation. A failure in any kind blocks all later kinds in the same
user-visible order until reviewed. The queue is a private mutation journal, not
an offline catalogue or diary cache; after a cold restart, content that was never
loaded remains unavailable offline.

The bounded display and identity fields fit the existing reviewed slot limit.
Persisting notes or full definitions would violate that review and requires a
new storage decision. Source tests can prove parser closure, crash recovery,
mixed-kind FIFO behavior, exact receipts, time-zone drift, cleanup, and API/DB
convergence, but they do not prove platform keystore, OS-kill, lifecycle, or
accessibility behavior in signed iOS and Android binaries.

## Alternatives considered

- **One queue per kind:** rejected because it loses a single causal order and
  creates conflicting capacity and terminal-head semantics.
- **Keep recipe and custom logs in memory:** rejected because process death can
  lose the exact idempotency identity after a successful server commit.
- **Persist arbitrary requests:** rejected because it expands the credential,
  corruption, validation, and erasure surface beyond a closed diary-log union.
- **Fetch the profile immediately before replay:** rejected because the zone may
  change between that read and the mutation transaction.
- **Include edits, deletes, repeat, and reorder now:** rejected because
  corrections need stronger revision/dependency receipts, notes exceed this
  envelope's reviewed shape, and reorder requires one atomic day operation.
- **Claim full offline mode:** rejected because this decision stores neither the
  catalogue nor an authoritative readable diary cache.

## Review triggers

Review this decision before changing the item count, slot size, SecureStore
accessibility, owner model, fixed operation union, terminal or ambiguous status
classification, acknowledgment matching, endpoint derivation, guarded digest,
time-zone lock/replay order, or cleanup behavior; adding notes, definitions,
catalogue or diary caches, edits, deletes, repeats, reorder, background delivery,
automatic expiry/discard, parallel sends, or web persistence; or claiming
signed-device, general offline-sync, controlled-beta, or release acceptance.
