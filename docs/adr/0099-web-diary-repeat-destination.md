# ADR 0099: Choose the web diary repeat destination

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

The web diary can repeat a pinned logged food or recipe only into today's source
meal group. Repeating yesterday's breakfast into tomorrow's lunch requires a
second edit, even though the existing repeat request and receipt already support
the desired timestamp and meal identity. Native ADR 0094 offers that destination
choice. The web client should expose it with the same exact-source guarantees.

## Decision and acceptance

Keep the existing Repeat today shortcut and its timestamp behavior. Add one
source-bound Repeat to composer with a valid local date and a configured meal
group, using the four stable identities and the person's saved labels and order.
Only explicit confirmation sends a mutation. Coordinate edits and Cancel stay
local. Reuse the existing quick-add timestamp helper for this new path: an exact
current instant for today, or profile-local noon for another date. No new time or
nutrition arithmetic is introduced.

Use the existing pinned source revision, profile-zone precondition, repeat
request, semantic receipt checks and authoritative diary refresh. Both food and
recipe snapshots retain their exact source provenance and portions. A destination
choice does not reconstruct nutrients, change serving amounts or update goals.

An uncertain request retains its exact source, destination, timestamp, body,
headers, URL and idempotency key. Show its pinned destination and an explicit
retry action. Neither a new choice nor Repeat today may replace that envelope
or present it as a fresh operation. Existing late-response, revision-conflict and
profile-zone recovery behavior remains in force.

Retire the unsent composer when its source, view, selected day, profile or private
context changes. Fence retained callbacks across those transitions and lifecycle
closure. Preserve paging, entry editing, configured groups, collapse controls,
saved notes, nutrient disclosures, private ownership and confirmed-only totals.

## Consequences, alternatives and review triggers

The person can repeat one exact logged portion directly to the intended day and
meal. Repeat-then-edit adds an unnecessary mutation and a second failure boundary.
Adding another repeat endpoint, changing snapshot contracts, or inventing browser
offline storage is unnecessary. The existing pending-operation identity remains
authoritative until its outcome is reconciled.

Revisit if repeat receipts, source revisions, configured group identities,
profile-zone rules or private lifecycle semantics change. This slice adds no API,
schema, dependency, retained entity, nutrition policy or background operation.

## Validation

Independent source review and 115 focused cases passed: 80 actual component
cases (24 new) plus 35 diary helpers. Coverage includes foods and recipes, saved
group labels/order, current/future/historical dates, invalid and skipped dates,
local Cancel, authoritative same-day totals, unchanged other-day totals, stale
private/view callbacks and exact retries across midnight. A review finding added
a visibility fence for retained explicit retry controls after meal collapse;
expanding the meal preserves the original request for a safe visible retry.
Existing late-response and receipt/conflict recovery cases remain intact.
Web types and scoped Biome passed on the final reviewed client and tests.
The intended missing-control and collapsed-retry regressions and intermediate
syntax, fixture and type failures remain recorded in the outside-Git evidence.

Final canonical `pnpm check` and `pnpm build`, and exact-commit automatic evidence,
remain pending in the dated outside-Git record. Delivery requires all three actual
CI jobs and all nine actual container jobs at the resulting commit.

Deterministic component and build evidence does not prove real-browser layout,
concurrent React, assistive technology, signed-device, hosted or release acceptance.
No service/browser action, installation, local audit or paid review is part of
this slice; existing external acceptance and approval gates remain unchanged.
