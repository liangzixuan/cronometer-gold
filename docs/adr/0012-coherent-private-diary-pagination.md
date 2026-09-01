# ADR 0012: Define coherent private diary pagination

- Status: Accepted for local implementation; controlled-beta and release
  acceptance remain evidence-gated
- Date: 2026-09-01
- Scope: authenticated diary-day reads in the API, web client, and mobile client

## Context

A diary day is currently a bounded coherent object. One authenticated owner can
read at most 50 active entries together with whole-day nutrient totals. The
bound prevents an unexpectedly large immutable nutrient-vector response, but a
worst-case valid day can still exceed one megabyte and is awkward to render on
resource-constrained clients.

Silently truncating that object would be a correctness bug. A client could show
page-only totals as whole-day totals, report an unloaded meal as empty, mutate a
previous date after a date switch, or append entries from two different day
revisions. A plain offset or page number would also drift when an entry is
added, edited, moved, repeated, restored, or deleted between requests. Diary
payloads are private health-adjacent data, so a continuation token must not
become a readable, replayable identifier bundle or a new telemetry surface.

The existing unpaginated contract is used by more than the diary screens. A
server-first change therefore needs an explicit compatibility boundary rather
than changing an unlabeled full-day response into a partial response.

## Decision

Keep the existing 50-active-entry write and full-day aggregation cap. Response
pagination does not authorize a larger diary day; raising the cap requires
separate payload, query, mutation, aggregation, and client-virtualization
evidence.

An authenticated request that does not opt into pagination keeps the legacy
behavior: it returns the complete day, up to the hard 50-entry limit. New diary
clients opt in with a bounded limit of at most 20 and consume the returned
continuation token. A paginated response is always labeled with `page`; every
page repeats the authoritative whole-day `totals` and `totalEntries`. Loaded
entry count is a separate client presentation fact and must never change the
meaning of those whole-day fields.

The canonical order is explicit rather than dependent on text collation:
`breakfast`, `lunch`, `dinner`, then `snacks`; within a meal group, entries are
ordered by position, occurrence time, and immutable entry identity. Changing
that order is a cursor-contract change.

Continuation tokens are stateless opaque values protected by authenticated
encryption in the API. Their protected payload binds the owner, local date,
requested limit, day identity and revision, effective profile time-zone value,
day status, a server-only exact PostgreSQL microsecond update token, a canonical
SHA-256 digest over that complete day/profile generation and the complete
ordered entry/current-revision identity set, and the exact continuation
position. The exact token and digest are encrypted cursor state, not new public
response fields; public `updatedAt` keeps its existing millisecond JSON
representation. The API validates the current authenticated and diary context
before returning another page. A malformed, tampered, cross-owner, cross-date,
or wrong-limit token receives the same generic invalid-cursor response. A valid
token whose bound day revision, effective profile time-zone value, day status,
exact microsecond token, or snapshot digest is no longer current receives a
typed stale-page response. The client must discard the partial page set and
restart from the first page. The API must not expose which protected binding
failed through more specific errors. Locking, unlocking, changing day metadata,
or changing any ordered entry head therefore invalidates an in-flight page set
even when public `updatedAt` and the day revision appear unchanged.

Tokens are request-scoped continuation capabilities. Clients and servers must
not log, export, persist, analyze, or place them in telemetry, crash reports,
history, durable caches, or account exports. Diary responses remain private and
`Cache-Control: no-store`; pagination creates no public or shared-diary access.
Page numbers, unsigned offsets, server-side cursor records, and unlabeled
partial-day defaults are not part of this contract.

Deployment compatibility is ordered and server-first. The API and shared
contract must accept legacy full-day readers before web or mobile starts asking
for pages. Each client must tolerate the labeled response, merge only pages with
the same day/revision/time-zone/total metadata, reject duplicates, restart on
the typed stale response, and prevent actions against a previously rendered
date. Removing the legacy full-day path or widening the day cap is a later,
separately reviewed decision.

## Consequences

Whole-day nutrient correctness stays centralized in the existing bounded,
coherent database read; it is not recomputed from one page or replaced by SQL
that loses unknown/not-reported semantics. Repeating totals adds a small amount
of response data but lets every page render truthful day progress. The 20-entry
limit bounds each transfer and incremental rendering batch; a client may still
append up to the independently retained 50-entry write and aggregation cap.

A mutation during pagination deliberately costs a restart. That is preferable
to duplicating, omitting, or mixing immutable entry revisions. Key rotation can
invalidate in-flight tokens and therefore needs a reviewed overlap or explicit
restart plan. The optional path preserves current internal full-day consumers,
but it also means both response shapes require compatibility tests until the
legacy path is retired.

This decision accepts only the local implementation boundary. Static, unit,
integration, and synthetic tests do not satisfy controlled-beta accessibility,
physical-device, privacy, or independent-review gates.

## Alternatives considered

- **Raise or remove the 50-entry cap:** rejected because response pagination
  alone does not prove write, aggregate, query, or virtualized-client behavior
  above the reviewed bound.
- **Silently paginate every read:** rejected because legacy readers would treat
  a partial day and page-only entry list as complete.
- **Return page-only totals:** rejected because it changes the meaning of diary
  progress and can label unknown nutrient contribution as zero.
- **Use page numbers, plain offsets, or an unsigned keyset:** rejected because
  mutations cause drift and readable tokens disclose private ordering context.
- **Keep server-side cursor state:** rejected because it creates another private
  data store, expiry process, recovery surface, and ownership boundary without
  need at the current scale.
- **Append across a revision change:** rejected because the resulting screen is
  not a coherent diary snapshot.
- **Infer meal order from lexical database order:** rejected because it does not
  express the product's breakfast/lunch/dinner/snacks sequence.

## Review triggers

Review this decision before raising or removing the 50-entry cap; changing the
20-entry client maximum, canonical meal/entry ordering, exact update-generation
token, snapshot-digest inputs, or the diary metadata fields that invalidate a
cursor; sharing a diary with another principal; adding delegated access;
changing how profile revisions or
effective profile time-zone state affect a cursor; rotating, replacing, or
distributing the cursor encryption keys; storing or exporting a token; changing
cursor lifetime or error taxonomy; removing the legacy full-day response; or
using diary data
outside the existing private, authenticated, `no-store` boundary.
