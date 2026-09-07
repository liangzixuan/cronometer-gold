# ADR 0020: Configure diary presentation groups without changing entry identity

- Status: Accepted for local implementation; signed-device and controlled-beta
  acceptance remain evidence-gated
- Date: 2026-09-07
- Scope: owner-specific diary group labels and display order in the private API,
  web client, and mobile client

## Context

Diary entries currently use one of four stable meal-slot identities:
`breakfast`, `lunch`, `dinner`, or `snacks`. Those identities are present in
immutable entry revisions, idempotency digests, deep links, mobile quick-add
outbox envelopes, and the canonical database order protected by ADR 0012.
Changing or deleting them would therefore be a data migration and compatibility
decision, not a cosmetic preference.

People still need the common daily-use ability to name these sections in a way
that matches their routine and to place them in a preferred visual order. That
does not require new entry identities. Treating a mutable label as identity,
changing server pagination order, or widening an offline envelope would create
unnecessary risk to existing diary history.

## Decision

Add a versioned, owner-specific diary presentation preference for exactly the
four existing canonical meal slots. Version 1 is an ordered array containing
each slot exactly once and one mutable label for each slot. Array order is the
client display order. The slot remains the value used by all API requests,
database rows, URLs, operation digests, pagination, exports, and offline
envelopes.

Store the preference below the existing private `user_profile.preferences`
JSON object. Updating it merges only its namespaced value and preserves every
unrelated preference. The public profile representation exposes the typed
presentation value, never the raw preferences object. A missing, unsupported,
or malformed persisted value resolves to the four product defaults without
making private screens unavailable.

Profile reads and writes retain the existing authenticated, owner-scoped,
`Cache-Control: no-store` boundary. Every diary-group write requires the current
strong profile revision through `If-Match` and a body `expectedOwnerUserId`
equal to the authenticated principal. The expected owner is a transport
precondition: when supplied it is checked before normalization or persistence
and is never stored. It prevents a delayed save initiated under one account from
reaching a different account after the client's authentication context changes.
One concurrent edit wins and a stale edit receives the existing generic
profile-conflict response. Clients that omit `diaryGroups` from an otherwise
current profile patch cannot erase the stored preference when updating another
field.

Deploy the API before a client that writes this preference. For one rollout and
rollback compatibility window, web and mobile treat an absent `diaryGroups`
property from a pre-feature API or cached session as a fresh copy of the four
defaults; a present but malformed value still fails closed. This read fallback
does not claim configuration support from the older API: a write containing the
new closed-schema fields is rejected rather than silently accepted. For API-first
zero-downtime deployment, a legacy patch that does not contain `diaryGroups` may
omit `expectedOwnerUserId`. A patch containing `diaryGroups` must include it, and
an owner-only no-op patch is invalid. New clients send the precondition for group
saves; an older closed-schema API rejects both new fields rather than accepting
an unguarded write.

Normalize every submitted label with NFKC and trim surrounding whitespace.
After normalization, a label must be non-empty, contain at most 40 Unicode
scalar values and 120 UTF-8 bytes, contain no control or format code point, and
be valid Unicode text. Labels must be unique after ECMAScript's deterministic
default Unicode lowercase mapping. This is not a full Unicode case-folding
claim. These are product and storage bounds, not a claim that labels are public
or safe to log.

Web and mobile must use the returned array for diary headings and every
meal-selection surface, including food, recipe, custom-food/retention, edit,
and receipt copy. Configuration provides rename, move earlier/later, and reset
to defaults. All mutations continue to submit the canonical slot. A server
page remains canonically ordered under ADR 0012, while clients group and render
the loaded entries in the owner's presentation order. Until all pages load, an
empty rendered group must retain the existing non-authoritative empty wording.

This first slice deliberately does not add, delete, archive, restore, or hide a
group. It also does not add timestamps, group subtotals, or group-level quick
add. Those behaviors require durable group identities and explicit rules for
immutable history, queued operations, inaccessible entries, defaults, exports,
erasure, and cursor compatibility.

## Consequences

Existing diary rows and revisions require no migration. Pagination cursor
payloads and snapshot digests remain byte-for-byte governed by their canonical
server order, and the native quick-add envelope remains unchanged. A queued
canonical slot can be displayed with the current label after a rename without
rewriting or losing the operation.

The preference shares the profile revision. An unrelated profile update can
therefore make an open group editor stale; the client must reload instead of
silently overwriting the newer profile. Because profile preferences already
participate in account export, erasure, backup, restore, and the user-data
watermark, this slice creates no new retained entity family.

The product gains customizable meal naming and ordering, not arbitrary diary
sections. Documentation and UI must keep that distinction explicit until the
larger identity migration is designed and accepted.

## Alternatives considered

- **Create arbitrary groups now:** deferred because immutable entry revisions,
  legacy requests, deep links, pagination, and queued quick adds need a durable
  group-identity migration and archive semantics.
- **Use mutable labels as entry identity:** rejected because a rename would
  rewrite meaning in historical records and invalidate retries.
- **Change database/page order with the preference:** rejected because ADR 0012
  binds canonical order into coherent pagination and would require a new cursor
  version plus mixed-client rollout evidence.
- **Store labels only on each device:** rejected because web and mobile would
  disagree and device loss would discard an account preference.
- **Hide a configured group:** deferred because existing or later-loaded entries
  must never become inaccessible or appear absent.

## Review triggers

Review this decision before adding, deleting, hiding, archiving, or restoring a
group; increasing the group or label bounds; changing canonical meal-slot
identity or database/page order; binding presentation preferences into a cursor
or mutation digest; persisting labels in the mobile outbox; placing labels in
logs, analytics, notifications, or another principal's view; changing profile
export/erasure treatment; or claiming signed-device, accessibility,
controlled-beta, or production acceptance.
