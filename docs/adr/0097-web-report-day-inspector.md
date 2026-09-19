# ADR 0097: Inspect every nutrient for one web report day

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

The web report chart and exact daily evidence table follow one selected nutrient.
Inspecting a single day's full nutrition therefore requires changing that chart
selection repeatedly, even though the coherent private response already contains
all 15 core nutrients. The native day inspector established in ADR 0095 provides
this useful daily view; the web report needs the same bounded capability.

## Decision and acceptance

Add an explicit, date-labelled View all nutrients action beside each report day.
Show at most one day's detail at a time; selecting another day replaces the detail,
and Hide collapses it. Keep the selected chart nutrient, target periods and
existing selected-nutrient print behavior intact. Use semantic section/table
markup and expanded/control relationships with the existing report styles.

Read all 15 nutrient series from the same loaded report and that exact day.
Reuse the existing amount, coverage, saved-threshold and comparison formatters.
Preserve exact decimals, units, quantified zero, trace, partial coverage, unknown
and missing-day distinctions. Preserve saved goal/source context without adding
recommendations, averaging, new arithmetic, synthetic values or network requests.
The existing source-diary actions retain their current-diary caveat and guards.

Bind the disclosure and its actions to the current private report context.
Dirty date inputs, snapshot/range/route replacement and private lifecycle/session
changes retire it. Returning draft dates to old values cannot revive old detail.
Retained open/close callbacks must not reopen retired data or override a newer
day selection. Reuse the established ready, owner/profile, route and private gates.

## Consequences, alternatives and review triggers

A local disclosure makes daily evidence easier to inspect without overloading
the chart or requesting another snapshot. Changing the chart selection 15 times
would preserve current behavior but make comparison across nutrients cumbersome.
Showing every nutrient for every day at once would expand the bounded 31-day
report into an unnecessarily long table. One selected-day detail keeps that
interaction explicit and bounded.

This changes only the web report presentation and component-state tests. It adds
no API, schema, dependency, storage, print-scope, source-catalogue or nutrition
policy change. Revisit if report series alignment, private lifecycle, selected-
nutrient printing or report formatters change.

## Validation

Exercise the actual component harness with exact, zero, trace, partial, unknown,
missing-day and saved-target cases; one-day replacement/collapse; no additional
requests; preserved chart/print selection and current-diary navigation; dirty-date
ABA, route/snapshot/session replacement and stale/private callbacks. Run report
helper tests, affected web types and scoped Biome. Independently review the final
client and documentation, then run canonical `pnpm check` and `pnpm build`.
Delivery requires all three actual CI jobs and all nine actual container jobs
at the exact resulting commit.

Component harness and build evidence do not prove real-browser responsive layout,
concurrent React, assistive-technology, physical-device, hosted or release
acceptance. This slice does not authorize browser/services, installation, audit,
device actions or paid review. All existing release and approval gates remain.


Development evidence on September 19, 2026: the baseline missing-disclosure
regression failed before implementation. Final focused checks passed 163 cases
with no skips: 91 actual-component cases and 72 report helper/print cases,
including 20 new component cases. Web types and scoped Biome passed. Independent
review covered exact day/series evidence, dirty-date ABA, snapshot/private/route
retirement, current and retained callbacks, focus/visibility lifecycle, and
preserved chart/print selection and guarded diary links.

The initial missing-capability failure remains recorded. Component state tests
are deterministic hook evidence; browser layout, concurrent React and assistive-
technology acceptance remain unexecuted for this slice. Final canonical and
exact-commit automatic evidence remains pending in the dated outside-Git record.
