# ADR 0026: Coordinated profile-local Today overview

- Status: Accepted for local implementation; hosted, signed-device, physical cross-client, and
  assistive-technology evidence blocked
- Date: 2026-09-09

## Context

The daily tracking loop is split across separate diary, hydration, and activity screens even
though each domain already exposes an owner-private, profile-local day contract. A person can
record food, water, and activity but cannot see whether all three parts of a selected day have
entries without leaving the diary and independently reconstructing the date.

Combining the three domains into a new server aggregate would create another contract and imply
one transactionally coherent snapshot across independently revisioned ledgers. It would also
invite unsupported net-energy or earned-calorie arithmetic. The existing exact day contracts are
sufficient for a presentation-level overview when their independent loading and error states
remain visible.

## Decision

### Date and navigation

- The diary's selected `YYYY-MM-DD` in the authenticated profile's current IANA time zone is the
  sole view date for the coordinated Today overview.
- Web navigation carries that date in the existing hydration and activity query strings. Native
  navigation passes the date through typed callbacks into both detail screens and preserves it
  when returning to the diary.
- A client must never silently replace a deliberately selected date with the device's current
  date when opening or returning from hydration or activity.
- Coordination uses the shared local-date lookup key only. It does not recalculate, move, or
  re-bucket persisted historical entries when a profile time zone changes; their immutable entry
  coordinates and existing domain rules remain authoritative.

### Presentation and arithmetic boundary

- The existing diary response remains authoritative for food entries and nutrition totals.
- The hydration card independently reads the existing private hydration-day route and shows the
  exact plain-water total in milliliters plus active entry count for the selected date.
- The activity card independently reads the existing private activity-day route and shows the
  exact total recorded duration in minutes plus active entry count for the selected date.
  This is the sum of recorded durations: overlaps remain additive, and an activity crossing
  midnight remains assigned wholly to its immutable start local date.
- Hydration and activity values never enter nutrition, goal, progress, remaining-calorie,
  energy-balance, PAL, report, or `exercise_budget_kcal` calculations. Activity self-reported
  calories are not summed or displayed as a day total.
- The surface is called a daily overview, not a coherent cross-domain snapshot. Each card retains
  the authority and revision semantics of its own route.

### Loading, failure, and privacy

- Diary, hydration, and activity load independently. Each summary distinguishes loading, a
  confirmed empty day, and an error, and each failed summary provides its own retry without
  hiding successfully loaded domains.
- Requests and state are fenced by initiating owner, authenticated session generation, profile
  time zone, selected date, and request generation. A delayed response for an earlier identity,
  zone, date, or generation cannot render into the current overview.
- Any `401` closes all owner-private overview state through the existing unauthorized-session
  path. The activity read carries its existing initiating-owner guard. The web hydration BFF now
  requires the same expected-owner input and, with the immutable incoming session token,
  revalidates `/v1/auth/me` before it fetches hydration; a mismatch closes private state before
  hydration data is requested. Both summaries remain session-authoritative, are fenced again
  before state installation, and continue to return private no-store data.
- Summary links, states, values, and retry actions require accessible names and status semantics.

### Scope and acceptance boundary

This slice adds no database migration, backend `/v1` route or response revision, dependency,
retained data family, outbox operation, hydration target or advice, non-water fluid,
activity-energy estimate, reminder, wearable import, background work, or phone exposure. It does
tighten the internal web hydration BFF read contract with a required expected-owner header and
same-token owner preflight.

Local acceptance requires web and native tests for exact selected-date propagation, profile-local
date boundaries including a daylight-saving transition, delayed stale responses, independent
empty and partial-failure states, per-card retry, unauthorized closure, accessible labels, and
the absence of cross-domain calorie arithmetic. The ordered source gates must pass.

Passing those gates closes only the coordinated Today overview source slice. Hosted behavior,
signed iOS/Android lifecycle and navigation, physical cross-client convergence, keyboard and
screen-reader review, VoiceOver/TalkBack review, controlled-beta evidence, and production release
remain open.

## Consequences

- A person can answer the basic daily question—whether food, water, and activity were recorded—on
  one date-aligned surface and continue into the matching detail screen.
- A failure in one ledger does not misrepresent another ledger as missing or make the useful
  parts of the day disappear.
- Existing domain contracts and privacy boundaries remain authoritative; the UI does not invent
  stronger consistency or energy meaning than the server provides.
- More advanced dashboards, targets, coaching, streaks, scores, and energy adjustments remain
  separate product decisions.

## Alternatives rejected

- A new combined API response would add a cross-domain contract and still could not honestly
  promise one revision without a broader database transaction and ownership design.
- Showing activity calories beside food calories would encourage unsupported net- or
  remaining-energy interpretation and would aggregate a deliberately nullable self-reported
  field.
- Defaulting detail screens to the current device day would make navigation lose the user's
  selected historical date.
- Treating a failed card as an empty day would turn availability failure into false user data.
- Expanding hydration targets, offline mutation, wearables, or reminders would combine unrelated
  policy and device-review milestones with this presentation slice.

## Review triggers

Revisit this ADR before adding a combined backend aggregate; claiming atomic cross-domain
consistency; adding hydration or activity targets, scores, advice, streaks, or reminders; using
activity in any nutrition or energy calculation; caching private overview data durably; widening
offline/background behavior; or exposing the overview to a physical device or public network.
