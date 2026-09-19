# ADR 0095: Inspect every nutrient for one native report day

Status: Implemented at `bae63da`; local and exact-commit automatic evidence passed. Device/release acceptance remains separate.

## Context

The native report's chart and exact daily list show one selected nutrient at a
time. To inspect one day's calories, macronutrients and micronutrients, a person
must repeatedly switch the chart selection and find the date. The validated
report already contains all 15 core nutrient series for every date in the same
private snapshot.

## Decision and acceptance

Add a date-labelled View all nutrients disclosure to each existing daily card.
Show at most one day's disclosure; choosing another day replaces it and Hide
closes it. Display all 15 nutrient names with exact amount strings, units,
coverage and saved-target comparisons using the existing report point formatter.
Preserve the distinctions between a missing day, unknown or partial coverage,
trace values and quantified zero. Do not calculate another total, average,
percentage or recommendation.

The disclosure reads only the current validated report. Opening, switching and
closing it cause no request or mutation and preserve the chart's selected
nutrient and existing current-diary links. Keep report-zone, snapshot and saved-
target context visible. Use explicit date-specific accessible labels, expanded
state and wrapping rows.

Retire the disclosure when date inputs change, the report is reloaded or replaced,
or its owner/session/profile, focus or foreground context changes. Returning a
date draft to its previous value must not restore a retired disclosure. Guard
retained callbacks against replaced snapshots, draft generations and superseded
open/close actions; they must not reveal stale private values or replace a newer
selection. Existing diary navigation keeps its own current-snapshot guard.

## Consequences, alternatives and review triggers

This is a bounded view of existing evidence. It avoids 15 repeated selector
changes without adding requests, storage, dependencies, API/schema changes or
nutrition arithmetic. Expanding every day by default would repeat up to 465 rows;
a single explicit disclosure bounds the extra content to 15 rows. Export, new
charts, multi-day aggregation and cross-screen persistence remain outside scope.
Revisit if the core nutrient inventory, aligned report dates, point formatter or
private snapshot ownership changes.

## Validation

Use the actual-screen harness for all 15 exact rows, coverage/target distinctions,
open/close/day switching, retained chart selection, no extra requests and the
existing diary links. Verify invalidation across dirty and reverted dates,
reload/range changes, private scope, focus, app lifecycle and stale callbacks.
Reuse report-helper checks, then affected native types and scoped Biome.
Independently review the final source and documentation before canonical
`pnpm check` and `pnpm build`. Require all three actual CI and nine actual
container jobs at the delivered commit; predecessor success does not transfer.

Hook-harness and native export evidence do not establish concurrent React,
physical-device, assistive-technology, hosted or release acceptance. No service,
browser/device QA, installation or local production audit is part of this slice.


Development evidence on September 19, 2026: the initial missing-capability test
failed against the original screen before passing with the inspector. Final
focused checks passed 100 cases with no skips: 64 actual-screen cases, including
17 new cases, and 36 report-helper cases. Native types and scoped Biome passed.
Independent review required units in accessible row labels even for unknown or
missing amounts. One expanded-test failure was an expectation missing the word
“the” from the existing zero-target explanation; the expectation was corrected
without changing the formatter or weakening its assertion. Final canonical and
exact-commit automatic evidence was pending at the source checkpoint; delivery
results below close that dated state.


## Delivery evidence

Delivered at `bae63da2e8ee50b4c1323361a85c7cab9d0fd775`. Canonical check on
September 19 passed 2,118 fresh cases plus 2,327 cached cases, with 93 cached
opt-in skips. Build passed 11 tasks, ten cached, with fresh native exports.
The 14:51:23 UTC official observation records all three actual jobs in
[CI 35445576918](https://github.com/liangzixuan/cronometer-gold/actions/runs/35445576918)
and all nine actual jobs in
[container run 35445576938](https://github.com/liangzixuan/cronometer-gold/actions/runs/35445576938)
completed successfully on attempt one at that exact commit. At 14:52:01 UTC,
clean local, tracking and live heads and seven reviewed working-tree/committed
hashes matched. Earlier pending observations remain dated history. These results
do not establish physical-device, assistive-technology or release acceptance.
