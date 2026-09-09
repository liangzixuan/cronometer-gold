# ADR 0028: Print the current nutrition report on web

- Status: Accepted for source implementation; native browser and automatic evidence pending
- Date: 2026-09-09
- Scope: M3B web presentation of the existing M3A report snapshot

## Context

M3A already returns one bounded, owner-scoped, coherent 1–31-day report across
15 core nutrients. Users need a portable copy of the report they are viewing.
Creating another export service would add retained artifacts, expiry, access and
worker obligations that are unnecessary for this bounded source slice.

Printing must preserve the report's exact evidence. Missing days and unknown
amounts cannot become zero; trace and partial coverage cannot imply complete
measurement. Saved thresholds and their reference expiry remain evidence, not
new advice. A stale print callback must not hand a closed or superseded report
to the browser.

## Decision

Add **Print current report** to the web Reports flow. Use native `window.print()`
and the user's browser print dialog, including its Save as PDF destination.
Do not add an API, server-generated file, retained entity, storage, queue,
external dependency, scheduled delivery or sharing channel.

The print action verifies the current session using the existing private session
endpoint. It does not fetch a replacement report or silently change the printed
snapshot. Require a ready report whose owner, profile revision and time zone match
the session, and bind the print attempt to its report object, applied range,
selected nutrient and active generations. Any pending date edits, reload,
selection change, logout attempt, session closure or unmount invalidates that
attempt. Check captured state after every asynchronous boundary.

Mount a separate static print presentation only for the verified capture. The
print surface is hidden by default. A synchronous `beforeprint` fence exposes it
only for the current armed action; browser Ctrl+P without that preparation prints
neutral guidance, not the private screen. Hide application navigation, account
identity, forms and other screen controls in print media. Clear authorization on
`afterprint`, returned/ignored printing, thrown errors and lifecycle invalidation.
A failed or canceled print does not imply a successful save.

The browser owns the print preview and output after handoff. The app cannot
revoke an already captured preview, PDF or printer spool, nor determine that the
user saved it from `afterprint`. Optional browser-added headers/footers are also
browser settings. The feature does not claim continuous authentication inside an
already opened browser print dialog or protection from a compromised browser.

## Printable evidence

Use the loaded snapshot and selected nutrient only. Keep:

- applied range, active profile time zone and exact capture instant;
- exact amounts and units, quantified zero, trace, partial, unknown and missing;
- summary counts, chart scale and exact saved thresholds/comparisons;
- complete daily values, coverage, comparisons and target-period boundaries;
- source diary revisions, source zones and exact local-day UTC bounds;
- saved goal versions, source labels/versions, reference provenance and expiry;
- profile revision, data watermark and the existing wellness notice.

Do not round source amounts through JavaScript numbers. Existing normalized chart
percentages may be used for drawing only; exact strings remain the evidence.
Do not infer additional nutrient recommendations or reinterpret historical goals.

Provide readable monochrome Letter and A4 layouts with complete tables, repeated
column headers, wrapping identifiers and sensible page breaks. Avoid scroll
containers, fixed page-height content, clipped overflow and reliance on color.

## Acceptance and validation

1. A ready report prints its current selected nutrient and exact snapshot only
   after session verification. Loading, failed, superseded or closed state cannot
   arm output; stale async callbacks and retained event handlers cannot revive it.
2. Direct browser printing is closed by default. Cancellation, ignored/throwing
   printing, StrictMode effect replay and repeated attempts leave no authorized
   hidden private snapshot behind.
3. All 15 nutrient selections reconcile to report helpers. Fixtures include
   quantified zero, trace, partial/unknown/missing, thresholds, reference expiry,
   large exact values, long provenance and varying local-day UTC boundaries.
4. Inspect browser-rendered PDFs for 1-, 7- and 31-day reports on both Letter and
   A4: no clipped content, complete evidence, repeated headers and no app controls.
5. Run focused component/parser/BFF tests, affected types/formatting, canonical
   check/build and applicable static/license/source gates after integration.
   Record actual execution, cache reuse, skipped opt-ins and exact source hashes.
   Browser session integration uses synthetic local data. Repeat database/restore
   suites if a discovered change reaches their behavior; earlier evidence remains
   historical. Exact-commit automatic CI and supply-chain checks still apply.

Source/local completion is narrower than the roadmap's implemented definition
when automatic evidence is pending. Independent Claude Code review and applicable
hosted, device, accessibility, catalogue and release approvals remain separate.

## Consequences and alternatives

This gives users a portable report without expanding server retention or delivery
infrastructure. The browser controls destination, margins and paper settings, so
representative PDF rendering is required alongside unit tests.

A server PDF/export endpoint, all-nutrient booklet and scheduled report delivery
are deferred. Mobile OS printing, automatic sharing, scores/advice and hosted
activation remain outside M3B. These require their own bounded acceptance cards.

## Platform references checked 2026-09-09

- [HTML printing specification](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#printing)
- [Window.print](https://developer.mozilla.org/en-US/docs/Web/API/Window/print)
- [Beforeprint](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeprint_event)
- [Print media and paged CSS](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)

## Evidence update — 2026-09-09

Checkpoint `514e2c1` preserves the reviewed print implementation. Canonical source
checks/build and six synthetic 1-, 7- and 31-day Letter/A4 PDFs passed. Production
Next/BFF with a loopback synthetic upstream verified the bounded session and
invalidation paths; this is not fresh API/database evidence. The user confirmed
native Chrome preview and Cancel, and subsequent browser inspection found the
print action enabled, authorization cleared and no mounted private print snapshot.

Repeat printing and direct Ctrl+P remain unconfirmed manual checks. Proceeding
with source checkpoint delivery does not close these checks or establish full
local acceptance. Applicable exact-commit CI/container evidence, independent Claude
Code review and the existing release gates remain required. The decision above
and its acceptance criteria are unchanged.
