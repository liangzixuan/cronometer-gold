# ADR 0022: Bounded multi-day nutrition reports

- Status: Accepted for local implementation; hosted, signed-device, cross-client,
  and accessibility acceptance remain evidence-gated
- Date: 2026-09-07
- Scope: owner-private nutrition trends across PostgreSQL, API, web, and mobile

## Context

The diary and goal surfaces provide trustworthy one-day totals, but people also
need to see whether calories, macronutrients, and micronutrients change across
days. A chart can easily become misleading if it treats an absent nutrient as
zero, discards traces, mixes database snapshots, silently changes time-zone or
goal semantics, or asks each client to perform decimal arithmetic differently.

ADR 0005 preserves each immutable entry revision's original local coordinates
when a profile time zone changes. ADR 0007 separately requires nutrition trends
to use a bounded local-date range in the active profile time zone. The report
projection must satisfy both rules without rewriting diary history.

The goal schema retains immutable versions, but a goal root records only its
current-version pointer, not the database-valid interval during which each older
version was current. A report therefore cannot reconstruct an unambiguous
historically-current intra-root revision without a schema change.

## Decision

Add the authenticated, additive
`GET /v1/reports/nutrition?from=YYYY-MM-DD&to=YYYY-MM-DD` route. The query is
closed and its inclusive range contains 1 through 31 profile-local days. Every
response is owner-scoped, `Cache-Control: no-store`, and carries the owner,
profile revision, active canonical IANA time zone, user-data watermark, database
snapshot instant, and a general-wellness notice.

One PostgreSQL `REPEATABLE READ`, `READ ONLY` transaction resolves the active
owner/profile, nutrient registry, current non-tombstone diary-entry heads,
immutable nutrient snapshots, and applicable goal roots. The range contains at
most 2,000 current entry heads. Exceeding a bound or observing inconsistent
persisted evidence fails closed; no partial report is returned.

The report uses the active profile time zone at the report snapshot to derive
each day's UTC `startsAt` and exclusive `endsAt`, including daylight-saving
transitions. It rebuckets current immutable entry heads by their stored
`occurredAt` instants for this view only. It does not modify their original
local date, local time, or effective time zone. Each day exposes the contributing
diary IDs, diary local dates and revisions, and distinct source entry time zones
so the projection remains explainable. The response declares
`dateBasis: active-profile-time-zone-v1`.

Every response contains exactly the fixed 15-nutrient core vector. A day with no
entries has a null aggregate for every series. A nonempty day always has all 15
aggregates; an absent stored nutrient row contributes one explicit
`unknown/not_reported` value rather than zero. Exact quantified zero, trace,
partial coverage, wholly unknown coverage, and an empty day remain distinct.
Series summaries reconcile complete, partial, unknown, and missing days; exact
and trace counts are separate evidence dimensions.

Goal roots retain their saved effective intervals. For each intersecting root,
the report reads the current immutable goal version inside the same report
snapshot, honors reference-target applicability expiry, and exposes the selected
version and contiguous target segments. The response declares
`goalVersionBasis: current-version-at-report-snapshot-v1`; it does not claim
that today's current version was the version viewed on an earlier diary date.
Reconstructing historical intra-root head validity requires a future migration
that records version-validity intervals.

The server chooses one exact-decimal chart scale per nutrient from the greatest
known intake or saved minimum, target, or maximum threshold in the range, using
`1` only when every candidate is zero or absent. It emits bounded, three-place
presentation percentages under
`scalePolicy: max-intake-or-saved-threshold-v1`. Web and mobile select among
the returned series locally and render those percentages; they do not coerce
nutrition amounts through binary floating-point arithmetic.

The report is descriptive general-wellness history. It does not diagnose
deficiency or toxicity, grade nutritional adequacy, prescribe intake, or infer
causation.

## Consequences

No migration, cache, background job, chart dependency, or new retained entity
family is required. The response is bounded to 31 days, 15 series, and 465
points, making local nutrient switching immediate and keeping the database work
reviewable.

A later goal revision may produce a different target overlay for the same dates,
but the returned version IDs and snapshot metadata make that reading explicit.
Diary amounts remain tied to immutable entry revisions and are never recomputed
from a current food, recipe, or catalogue version.

Local source and integration tests can establish calculation, ownership,
time-zone, and missingness behavior. They do not establish hosted load,
production catalogue usefulness, physical-device rendering, accessibility, or
controlled-beta acceptance.

## Alternatives considered

- **Return zeros for absent rows:** rejected because it fabricates measurement
  and violates the existing missingness invariant.
- **Group by each entry's original diary date:** rejected for this trend view
  because ADR 0007 selects the active-profile-zone report basis. Original
  coordinates remain exposed as evidence and are never rewritten.
- **Issue one day request per chart point:** rejected because the reads can span
  different snapshots and create internally inconsistent trends and goal
  overlays.
- **Let clients calculate scales and percentages:** rejected because independent
  floating-point conversions can disagree and can hide overflow or invalid
  persisted values.
- **Present an older goal version as historically current:** rejected because the
  existing schema cannot prove that validity interval.
- **Add a charting package:** deferred; the bounded first slice needs simple bars
  and markers and does not justify another dependency or supply-chain surface.

## Review triggers

Review this decision before increasing the date, nutrient, or entry-head bounds;
adding weekly/monthly aggregation, saved reports, export/PDF, sharing, caches,
scores, balance meters, recommendations, or medical interpretation; changing
the active-zone projection; adding goal-version validity history; including
biometrics, exercise, supplements, or fasting; or claiming hosted,
signed-device, accessibility, controlled-beta, or production acceptance.
