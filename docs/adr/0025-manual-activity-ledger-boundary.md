# ADR 0025: Private manual-activity ledger boundary

- Status: Accepted for local implementation; automatic energy adjustment, offline mutation,
  platform import, and device evidence blocked
- Date: 2026-09-08

## Context

M1D requires a useful activity-history loop without corrupting the product's accepted energy
model. An activity is not food, a nutrient snapshot, hydration, or a biometric measurement.
Treating it as any of those would give it false provenance or measurement semantics.

The current derived goal is resting energy multiplied by a 24-hour physical-activity-level
factor, plus an explicit adjustment. PAL already includes ordinary habitual activity. Adding
logged exercise energy to that goal or subtracting it from intake would count the same activity
twice unless a new scientific and product policy deliberately changes the model.

Users may know a duration without knowing calories. A missing value must therefore remain
missing rather than becoming zero or a calculated estimate. The clients also have no reviewed
general offline protocol for this new operation family.

## Decision

### Meaning and bounds

- A manual activity entry records a private user-authored name, duration, optional
  self-reported energy, and start instant. The server derives the entry's local date and time
  from the authenticated profile's current IANA time zone. The whole entry belongs to its start
  local date even when its duration crosses midnight.
- Names use NFC, trim and collapse whitespace, reject control characters and malformed Unicode,
  and are bounded to 120 Unicode code points and 480 UTF-8 bytes.
- Duration is an exact integer from 1 through 1,440 minutes. One owner-local start day permits
  at most 64 active entries. Overlapping entries are allowed, so the exact
  `totalDurationMinutes` is a sum of recorded durations and may exceed 1,440.
- `selfReportedEnergyKilocalories` is required as a nullable wire field. `null` means the user
  did not enter a value. A present value is a canonical positive decimal string no greater than
  20,000 with at most three fractional digits. The day contract has no calorie aggregate.
- These bounds limit abuse and arithmetic; they are not exercise, energy-expenditure, or medical
  guidance.

### Energy and PAL boundary

Activity entries are informational history only. The application does not infer calories from
an activity name or duration. No activity table, service, route, report, or client changes a
nutrition goal, remaining calories, goal progress, dietary total, energy balance, PAL factor,
explicit goal adjustment, or `exercise_budget_kcal`. Fixed and derived goals both remain
unchanged.

Clients must explain that optional calories are self-reported and do not change nutrition goals
or remaining calories. Where PAL is used, they must explain that ordinary activity is already
included. Any future earned-calorie, net-energy, wearable-energy, MET, or exercise-budget feature
requires a new product/scientific decision and a versioned calculation policy.

### Private HTTP contract

All routes require the existing bearer session plus `X-Expected-Owner-User-Id`, derive authority
only from that session, reject a mismatched initiating owner with `409 ACTIVITY_OWNER_CHANGED`, and
return `Cache-Control: no-store`.

- `GET /v1/activities?date=YYYY-MM-DD` returns ordered active entries, the exact duration sum,
  the current profile zone, a day synchronization revision, and a strong
  `"a-<sha256-base64url>"` ETag over the canonical response. An absent day is an empty
  revision-zero day, not an invented activity or calorie value.
- `POST /v1/activities/entries?profileTimeZonePrecondition=v1` requires a UUID
  `Idempotency-Key`, the initiating owner header, the paired canonical
  `X-Expected-Profile-Time-Zone`, and exactly
  `{name,durationMinutes,selfReportedEnergyKilocalories,occurredAt}`. First application returns
  201; exact replay returns 200.
- `PATCH /v1/activities/entries/:entryId` requires the owner header, a UUID key, a strong
  `If-Match`, and a
  nonempty closed subset of authored fields. A patch containing `occurredAt` also requires the
  paired time-zone guard. It may atomically move the entry between days. A patch without the
  instant preserves the stored coordinates and zone; `selfReportedEnergyKilocalories: null`
  explicitly clears that field.
- `DELETE /v1/activities/entries/:entryId` requires the same owner, identity, and revision
  preconditions, accepts no body, appends an immutable tombstone, and returns `entry: null`.

Every mutation returns exact replay state and one or two affected-day revisions. Canonical
request digests bind the method, subject, expected revision, body, and any expected zone. Owned
misses are indistinguishable from absent entries. A changed initiating account returns
`409 ACTIVITY_OWNER_CHANGED`; new zone drift returns `409 ACTIVITY_TIME_ZONE_CHANGED`; stale
revisions return 412; bounds return 422.

### Persistence, privacy, and clients

Migration 0025 adds owner-scoped `activity_day`, `activity_entry`, immutable
`activity_entry_revision`, and immutable `activity_operation` tables. Composite owner foreign
keys, deferred current-head validation, contiguous revisions, logical deletion, deterministic
owner/day locks, digest-bound operation receipts, and the shared user-data watermark follow the
hydration ledger's proven concurrency shape. A correction or deletion never rewrites history.

All four families participate in the closed privacy schema registry, JSON/CSV account export,
reviewed cascade graph, writer fencing, erasure drill, and logical-restore evidence. Activity
names, times, durations, and energy values are sensitive payloads and must not enter logs or
telemetry.

Web and mobile expose a first-class Activity page with local-date navigation, exact recorded-
duration total, add, correction, and confirmed deletion. Energy appears only on an individual
entry as self-reported or not entered. Mutations are foreground and online only. This slice does
not widen the diary outbox, add browser persistence, request HealthKit or Health Connect activity
permissions, import wearables, calculate METs, run in the background, or expose the API to a
phone.

### Rollout and acceptance boundary

The coordinated order is migration/privacy registry, API, web, then mobile. Local acceptance
requires twice-current migration and mismatch-readiness evidence; contract, domain, database,
API, web, mobile, privacy/export/erasure, and PAL-isolation tests; the ordered source gates;
restore and local-service integration; and exact loopback readiness.

Passing those gates closes only the owner-private online manual-activity CRUD/history source
slice. Hosted, signed-device, cross-client, keyboard/screen-reader, VoiceOver/TalkBack,
controlled-beta, and production abuse evidence remain open.

## Consequences

- Users can keep and correct a private activity history without creating fake food or biometric
  records and without silently changing what they are told to eat.
- Missing calories remain honest. A duration-only entry is complete activity history for what the
  user entered, but it is never presented as zero energy.
- Immutable, replay-safe history is exportable and erasable; day navigation is bounded.
- Automatic exercise-energy accounting, offline delivery, device ingestion, and activity
  catalogues remain explicit future milestones rather than accidental behavior.

## Alternatives rejected

- Adding activities to the food diary would fabricate nutrient/catalogue provenance.
- Reusing biometric events would confuse a user action with a measured body state.
- Automatically estimating calories from name and duration would create an unreviewed model and
  hide uncertainty.
- Adding self-reported calories to a PAL-derived target would double-count ordinary activity.
- Treating absent calories as zero or publishing a partial day calorie total would imply false
  completeness.
- Widening the native diary outbox or platform-health permissions would bypass their closed
  storage, privacy, and signed-device review boundaries.

## Review triggers

Revisit this ADR before changing bounds or normalization; adding categories, notes, definitions,
goals, reminders, coaching, range reports, sharing, imports, wearables, background/offline
mutation, energy estimates, earned calories, net-energy calculations, or any use of activity in a
nutrition target, progress indicator, health score, or medical interpretation.
