# ADR 0098: Choose web activity time occurrences explicitly

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

When a time-zone offset moves backward, a local clock minute can occur twice.
The web activity Add form silently resolves deliberate input to the earlier
occurrence. Its correction path compares date and HH:MM, so a person cannot
choose the other occurrence of the same displayed minute. Native ADR 0096
provides explicit choices; web activity should offer the same bounded workflow.

## Decision and acceptance

Reuse the existing shared local-minute candidate resolver. For deliberate Add
and time corrections in a repeated minute, present Earlier/Later choices labelled
with their UTC offsets and require a current candidate before sending. Reject
invalid and nonexistent minutes. Support non-hour transitions and an explicit
change between occurrences of the same displayed minute.

Keep the exact captured instant for an untouched Add default, including its
seconds and milliseconds. Metadata-only corrections preserve the saved instant
and stored zone. Explain that explicitly choosing an occurrence uses minute
precision. No automatic choice is made for deliberately entered ambiguous input.

Retire choices when date, time, loaded zone, day or private context changes.
Retained callbacks must not select a candidate for newer coordinates or reopen
retired private state. Preserve existing ready, owner, route and revision guards,
activity reuse and draft protections, receipt validation, and exact idempotency
keys/bodies on uncertain retries. Self-reported activity energy remains history;
it never adjusts saved nutrient goals, remaining calories or PAL.

## Consequences, alternatives and review triggers

An explicit choice resolves a demonstrated input ambiguity without changing
timestamp contracts or inventing time arithmetic. Always taking the earlier
occurrence leaves the person's intent unknown; guessing the later occurrence
has the same problem. A broad cross-client time-editor redesign is unnecessary
for this bounded web activity correction.

This changes only the web activity component and its helper/state tests. It adds
no API, schema, dependency, storage, catalogue, notification or nutrition policy
change. Revisit if timestamp precision, the shared candidate resolver, loaded-zone
preconditions or private lifecycle and retry contracts change.

## Validation

Independent source review found no open blocker. The final focused run passed
86 cases: 61 actual-component cases, 16 request-helper cases and nine existing
activity-parser cases. The 28 new cases cover both fold occurrences, non-hour
folds, gaps, current-candidate validation, exact untouched defaults, metadata-only
precision, same-minute corrections, reuse, date/zone replacement, stale/private
callbacks and exact retries. Web types and scoped Biome passed on the reviewed
three-file source. Two intended baseline regressions and an initial outdated
automatic-earlier test expectation remain recorded.

Final canonical `pnpm check` and `pnpm build`, and exact-commit automatic evidence,
remain pending in the dated outside-Git record. Delivery requires all three actual
CI jobs and all nine actual container jobs at the resulting commit.

Deterministic hook and build evidence does not prove concurrent React, real-browser
TZDB or layout behavior, assistive-technology, physical-device, hosted or release
acceptance. This slice does not authorize browser/services, installation, audit,
device actions or paid review. All existing release and approval gates remain.
