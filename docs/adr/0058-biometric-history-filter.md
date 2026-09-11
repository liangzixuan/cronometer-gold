# ADR 0058: Filter loaded biometric history by metric

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the roadmap. Add an independent local metric filter
to web/native biometric history so one kind of loaded reading is easier to find.
This changes presentation of existing authenticated history, not what is fetched.

## Acceptance card

- Use the exact metric definition ID as the selected value, with All metrics as
  the default/reset. Derive shown rows from the existing loaded history snapshot;
  preserve server order, exact numeric strings, dates/times/zones, source and
  existing missing-definition labels. Never filter the backing history or cursor.
- Build choices from current definitions in existing order, including archived
  definitions if returned, followed by missing-definition IDs from loaded rows in
  first-seen order. Retain the selected ID as an option if it disappears from the
  current definitions/rows. Known labels use name and canonical unit; disambiguate
  identical labels with full IDs. Unavailable metadata is explicit and includes
  the full ID. Do not infer units, collapse duplicate names or drop unknown rows.
- Show truthful Showing X of Y loaded readings and explicit loaded-only meaning.
  A selected metric with zero matches says no loaded readings match. Preserve
  current unverified/unavailable, exact UTC range, error and continuation wording;
  never claim an entire window/history is empty just because its filter is empty.
  Keep window navigation, Reload and Load more outside the filtered row count.
- Keep the choice across same-private-scope paging, window changes, Reload,
  transient/invalid-cursor failures and full refresh. Reset to All metrics when
  the existing owner/profile scope is replaced or private data closes. Reuse
  existing lifecycle policy and hide stale private labels; do not introduce new
  backgrounding or identity rules. Retained callbacks cannot restore an old scope.
- Reuse existing history-control availability: filter controls are disabled
  while history reads, full loading or biometric writes block history controls.
  Use a filter-only value/ref and generation fence for genuine selection changes;
  choosing the current ID or resetting All while already All is a true no-op.
  Never advance history/read or editor/write ownership, abort a read, start a
  request, allocate a mutation operation, store a preference or alter an outbox.
- Extend existing row-action guards only to require the current filter generation
  and current visible membership before Edit/Delete effects, including retained
  callbacks and A-to-B-to-A changes before paint. Keep accepted write cleanup and
  raw editor/pending retry bodies and keys independent if its row becomes hidden.
  Preserve separate trend metric/range, metric composer, custom-food and reminder
  inputs. Filtering must not select a trend or editor metric.
- Use a labelled History metric web control and existing native selectable-control
  pattern with accessible selection/reset semantics. Keyboard and 390 px long
  duplicate/missing labels remain usable; no new dependency, helper or style system.
- Scope exactly eight paths: apps/web/src/app/health/HealthClient.tsx and its
  HealthClient.state.test.ts; apps/mobile/src/retention/RetentionScreen.tsx and
  scripts/custom-food-nutrient-composer.test.mjs; this ADR/index, build plan and
  additive release gates. No API/parser/schema/shared helper/dependency/outbox,
  general controller or unrelated hardening changes.
- Focused actual-component/helper/type/format proof covers ID and duplicate/missing
  choices, exact rows/counts, true no-op, stale hidden actions, zero-match paging,
  window/reload/errors, raw drafts/independent inputs and retry/receipt ownership.
  Obtain independent source review, then freeze before fresh canonical check,
  build, licenses and production web/both native exports. Dependency inputs stay
  unchanged; prior audit is historical, and hosted audit is separately observed.
- Use a complete core nutrient fixture and normal production Next/BFF auth in
  dedicated Chrome. Verify chosen/all/duplicate/missing metrics, zero-match
  continuation and retry, exact rows, dirty editor/trend preservation, keyboard,
  narrow layout and expiry. Journal zero filter requests separately from explicit
  reads; no domain writes. Checkpoint before QA and close only owned tabs/processes.
- Stop after reviewed source/local evidence, normal commit/non-force push under
  standing authorization, exact automatic observation and dated readiness/CURRENT.
  Physical native/protected storage, assistive technology, concurrent React, real
  persistence, external Claude Code, hosted and release acceptance remain separate.

## Consequences and review triggers

The filter makes loaded readings easier to inspect without adding server filtering
or tying history navigation to trends. Revisit if metric identity, loaded-history
ownership, mutation receipts, private scope or pagination contracts change.

## Local evidence and limits (UTC 2026-09-11T17:44:03.055468+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 883 web tests, 1350 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Dedicated Chrome production Next/BFF QA passed with a complete 15-core-nutrient
synthetic fixture. Exact metric-ID/duplicate/archived/missing choices, All reset,
zero-match paging, same-cursor 503-to-200 retry (2 of 103 matching readings after
overlap merge), exact values/time/source, earlier/empty/reload/recent retention,
dirty editor/trend/food/reminder independence and keyboard/390px/expiry passed.
Local filtering kept request counts 26-to-26 and 29-to-29; explicit setup/trend/
history reads are separate. 38 requests (37 GET and one synthetic login POST),
zero domain writes. Owned Chrome tab closed, viewport reset and verified test
processes stopped; ports 3008/4008 absent. Browser-adapter/date setup corrections
are retained in observations; native popup pixels, assistive technology, real
persistence, physical native/protected storage, concurrent React, external Claude,
hosted and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
