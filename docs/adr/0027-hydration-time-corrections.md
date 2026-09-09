# ADR 0027: Explicit hydration time corrections

- Status: Accepted for local implementation; hosted and physical-client acceptance pending
- Date: 2026-09-09

## User task

A person can correct how much plain water was logged and, when explicitly chosen,
when it was logged. Web and mobile show the same profile-local date/time meaning,
preserve historical precision on amount-only changes, and make a move to another
day visible without mixing hydration into food or activity calculations.

## Context

The API already permits timestamp corrections, but the clients expose only amount
changes. An unconditional timestamp resubmission can erase sub-minute precision
or move an old entry under a newer profile zone. Resolving a repeated local minute
without a choice can save a different instant from the one the person intended.

## Decision

The existing hydration ledger, immutable revisions, routes, strong entry revision,
idempotency, day bounds, export and erasure remain authoritative. No migration or
new retained entity is needed. ADR 0016 remains the historical base contract.

### Guarded timestamp updates

Legacy hydration PATCH without a query marker or expected-zone header retains its
existing body and digest semantics. An additive guarded timestamp correction uses
both `profileTimeZonePrecondition=v1` and `X-Expected-Profile-Time-Zone`. The server
rejects incomplete, duplicate, invalid or unexpected guards and a guard on an
amount-only patch. The new clients use the guard whenever they send `occurredAt`.
An older server rejects the new query marker rather than accepting an unguarded
time correction; rollout is API-first.

The expected zone is part of the operation's canonical digest. After checking for
an exact accepted replay, the database compares it with the current authenticated
profile zone under the existing profile lock and before any write. A mismatch
returns the existing typed `409 HYDRATION_TIME_ZONE_CHANGED` with no entry, day,
revision or watermark change. An exact accepted replay still succeeds after a
later zone change. A stale entry revision remains 412. Session ownership never
comes from a client-authored identity claim.

### Edit meaning and daylight saving

Changing the amount alone omits `occurredAt`. It must preserve the original instant,
seconds/milliseconds, historical zone and repeated-hour identity exactly.

Changing time is an explicit action. Its editable date and minute are displayed
in the loaded current profile zone, identified beside the controls. The historical
entry's original coordinates remain understandable; opening an editor or changing
an amount does not re-bucket the entry into a newer profile zone.

A shared pure resolver enumerates matching UTC instants for the chosen local
minute and IANA zone. Invalid calendar dates and nonexistent wall times are
rejected. A repeated minute requires an explicit earlier/later occurrence choice
showing the corresponding UTC offsets. There is no silent daylight-saving choice.
Changing the draft date, minute or zone clears that choice. Generic diary,
activity and recipe time helpers keep their current behavior outside this slice.

### Save, retry and navigation

The pending operation binds the initiating entry ID, original revision, exact
serialized body and expected zone to one idempotency key. Transport ambiguity
retains that operation for exact retry. A typed no-write zone/revision conflict
offers reloading current evidence and explicit reconfirmation; it does not
silently rewrite and resubmit a pending correction.

Before claiming acceptance, the client checks the returned subject, submitted
values and instant/zone, and relevant affected-day identities. Once an accepted
write is proven, failure to refresh the day is a read failure: offer a read retry
without creating another write. A cross-day correction refreshes the selected
source day, announces the destination and offers navigation to it. Returning to
Today preserves the selected overview date. Day, form, request, session and owner
changes must not render or submit stale private state.

## Local acceptance

- Same-day correction, cross-day move and exact water totals; repeated identical
  requests do not duplicate revisions or entries.
- Amount-only correction of an entry at the later occurrence of a repeated
  minute, with fractional seconds and a historical zone, preserves its instant.
- Chicago spring gap and autumn fold, Lord Howe's half-hour transition, a skipped
  calendar day, leap/invalid dates, and supported four-digit early years.
- Zone drift under the locked profile, accepted replay after drift, stale entry
  revision, malformed guard pairs, cross-owner entries and destination bounds.
- Lost-response retry, accepted-write/read-failure, stale response closure and
  accessible date/time, occurrence-choice, error and navigation controls.
- Synthetic browser daily-loop interaction and the required source/service
  validation. Local tests do not substitute for signed native, real assistive-
  technology, hosted, cross-client or controlled-beta evidence.

## Consequences and alternatives

One shared resolver keeps the two clients' occurrence choices consistent and uses
the runtime timezone database. Date, minute and zone memoization avoids repeating
resolution during unrelated renders. Native timezone data and accessibility still
need physical-client evidence. The additive server guard requires API-first rollout
but preserves exact legacy request digests and accepted replay behavior.

Reusing the generic local-time helper would silently select an occurrence; always
resubmitting the original time would change precision or historical coordinates.
A new timestamp library or ledger migration is unnecessary for this bounded
correction flow. Those alternatives are not adopted.

## Exclusions and review triggers

No water target, intake advice, non-water fluid, reminder, diary outbox expansion,
offline/background mutation, wearable/health import, calorie arithmetic, phone
exposure, cloud action or live data release is introduced. Revisit this ADR before
changing those boundaries, replacing legacy PATCH semantics, changing timestamp
precision or making generic diary time conversion changes.
