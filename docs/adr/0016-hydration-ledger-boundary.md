# ADR 0016: Private hydration-ledger boundary

- Status: Accepted for local implementation; targets, offline mutation, and
  device evidence blocked
- Date: 2026-09-03

## Context

M1 requires a useful daily water-tracking loop. Water intake is private health
data, but it is not a food, nutrient measurement, energy adjustment, or medical
recommendation. Reusing diary food entries would incorrectly attach catalogue
provenance and nutrient semantics. Reusing biometric events would model intake
as a body measurement and would make future import semantics ambiguous.

The current clients also have no general offline mutation protocol or signed-
device evidence. This slice therefore needs a small owner-scoped ledger that is
fully exportable and erasable without implying hydration advice, background
delivery, or device integration.

## Decision

### Meaning and bounds

- One hydration entry records plain water consumed as an exact integer number
  of milliliters. The amount is from 1 through 20,000 mL.
- A profile-local day permits at most 64 active entries and an exact active
  total of at most 100,000 mL. These are overflow and abuse bounds, not safe-
  intake guidance, a target, or a recommendation.
- Hydration never changes energy, macro, micronutrient, food, recipe, diary, or
  goal calculations. This slice has no beverage catalogue, other-fluid
  equivalence, target, progress score, reminder, or clinical interpretation.
- `occurredAt` is a finite RFC 3339 instant. The server derives and persists its
  local date and local time from the authenticated profile's current IANA time
  zone; callers cannot assign either value directly.

### Private HTTP contract

All routes require the existing bearer session and return `Cache-Control:
no-store`.

- `GET /v1/hydration?date=YYYY-MM-DD` rejects unknown query keys and returns the
  owned persisted day, its ordered active entries, exact `totalMilliliters`,
  current profile time zone, a day synchronization revision, and a strong
  `"h-<sha256-base64url>"` ETag over the exact canonical response. An empty day
  is represented without fabricating an entry or target.
- `POST /v1/hydration/entries` requires a UUID `Idempotency-Key` and accepts only
  `{amountMilliliters, occurredAt}`. First application returns 201; an exact
  replay returns 200 with the same result. The optional delayed-delivery guard
  is the paired `profileTimeZonePrecondition=v1` query marker and
  `X-Expected-Profile-Time-Zone` header. Supplying only one is invalid; a changed
  profile time zone fails with `409 HYDRATION_TIME_ZONE_CHANGED`.
- `PATCH /v1/hydration/entries/:entryId` requires a UUID `Idempotency-Key`, a
  strong `If-Match` entry revision, and a nonempty subset of
  `{amountMilliliters, occurredAt}`. An amount-only correction preserves the
  stored instant, local coordinates, and effective time zone. A change to
  `occurredAt` derives new coordinates with the current profile zone and may move
  the entry between local days while atomically enforcing both days' bounds.
- `DELETE /v1/hydration/entries/:entryId` requires the same idempotency and
  strong revision preconditions. It creates an immutable delete revision and
  returns `entry: null` with the affected day revision.

Owned misses are indistinguishable from absent entries. Malformed input and a
missing or malformed idempotency key are 400; a missing `If-Match` is 428 and a
malformed one is 400. Stale revisions are 412, idempotency/time-zone conflicts
are 409, and an operational entry/day bound violation is 422. Mutation responses
expose whether the operation was replayed and identify all affected local days.
Create and update responses carry a strong entry-revision ETag; deletion carries
none because no live entry remains.

### Persistence and concurrency

Migration 0010 creates `hydration_day`, `hydration_entry`,
`hydration_entry_revision`, and `hydration_operation`.

- At most one owned `hydration_day` row exists per local date. Its monotonically
  increasing revision changes for every active-head mutation affecting that day.
  Totals are always derived from active current revisions; they are not stored.
- Each entry has an owned mutable head pointing through a deferred composite
  foreign key to an append-only immutable revision. Delete is a logical
  tombstone, not physical history loss.
- Every revision records the exact amount, instant, derived local date/time,
  effective time zone, operation, and revision number. Revision and operation
  rows reject updates and deletes outside whole-account erasure cascades.
- Each owner-scoped UUID operation stores a canonical request digest and result.
  Exact retries return the prior result; reuse with any different method,
  target, precondition, or body fails closed.
- Mutations take bounded owner/day locks in deterministic order and enforce entry
  and total caps against active heads. Creates and timestamp-changing updates
  derive coordinates from the authenticated profile time zone inside the
  transaction; amount-only corrections preserve the prior coordinates. A move
  atomically advances both source and destination day revisions.
- All four tables are directly or transitively owned by `app_user` with reviewed
  non-null cascade paths. They participate in the closed privacy-export schema
  registry, immutable JSON/CSV reconciliation, and whole-account erasure proof.

### Client boundary

Web exposes a same-origin `/hydration` screen and bounded private BFF routes.
Mobile exposes a first-class Hydration screen. Both allow date navigation,
exact total display, add, amount correction, and confirmed delete, with explicit
loading and error states. Labels say water and milliliters; they do not display
a goal, percent, warning, or medical interpretation.

The private PATCH contract supports an explicit `occurredAt` change, but neither
current client exposes time editing. That client work remains open.

This slice sends mutations only while the client is active and online. It does
not add browser persistence, a native outbox, background work, manual reorder,
notifications, HealthKit/Health Connect hydration, camera input, or a device-
accessible API listener. Existing session storage and sign-out behavior remain
unchanged.

### Rollout and acceptance boundary

The coordinated rollout order is migration, API, web, then mobile. Local
acceptance requires twice-current migration evidence, mismatch readiness
refusal, focused contract/domain/database/API/client tests, the expanded
all-entity privacy export-and-erasure drill, source checks, build, license gate,
restore, search, and exact loopback readiness.

Passing local gates closes only the plain-water online CRUD source slice. It
does not close M1, M2, controlled beta, accessibility acceptance, production
abuse protection, signed-device behavior, cross-client convergence, or any
medical/scientific review.

## Consequences

- Hydration history is immutable, retry-safe, timezone-explainable, exportable,
  and erasable without contaminating nutrition arithmetic.
- Changing profile time zones affects later creates and explicit `occurredAt`
  changes. An amount-only correction preserves the entry's stored instant, local
  coordinates, and effective zone; every prior revision keeps its original
  interpretation.
- The high operational ceiling avoids presenting a recommendation while still
  bounding queries, arithmetic, exports, and clients.
- General offline mutation remains open; the diary quick-add outbox is not
  widened to carry hydration requests.

## Alternatives rejected

- Logging water as a zero-calorie food would fabricate catalogue/nutrient
  meaning and couple hydration to diary provenance.
- Treating intake as a biometric would conflate an action with a body
  measurement and complicate platform imports.
- Storing only one mutable daily total would lose individual-event correction,
  immutable history, and exact replay evidence.
- Adding a default target would create an unreviewed clinical/product claim.
- Reusing the native diary outbox would silently broaden its closed create-only
  public-food envelope and deployment contract.

## Review triggers

Revisit this ADR before adding hydration targets or advice, non-water fluids,
nutrient equivalence, reminders, device/platform imports, background or offline
mutations, manual ordering, shared-household data, changing bounds, or using
hydration in any energy, nutrient, or health score.
