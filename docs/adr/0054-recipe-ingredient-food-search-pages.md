# ADR 0054: Page reviewed foods in recipe ingredient search

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the Nourishing roadmap. Both recipe builders currently
discard the search response cursor, limiting ingredient choice to the first 20
reviewed foods. Expose explicit continuation using existing search contracts.

## Acceptance card

- Web/native show the committed normalized query and loaded result count, with
  explicit Load more when a cursor exists. Reuse existing NFKC/trim/whitespace
  normalization, intent all, limit 20, opaque cursor validation and food-version
  merge helpers. Preserve loaded objects and source order across page overlap;
  distinct immutable versions and duplicate names remain distinct choices.
- Raw typing makes no request. Label retained results with their committed query;
  disable Add/Load more while raw text differs from its committed draft. Same-value
  input is a no-op; old A-to-B-to-A controls cannot regain authority. A new explicit
  Search replaces rows and cursor. Continuation captures the committed normalized
  query and exact current cursor, independent of unsubmitted text.
- A transient or malformed continuation failure preserves loaded rows and cursor
  for explicit retry. A continuation HTTP 400 removes the cursor and asks for a
  fresh Search without automatically restarting. Empty terminal and nonterminal
  pages remain distinguishable; loaded counts never claim catalogue completeness.
- Fence current request, query/result, owner/profile/private/route and relevant
  builder contexts before fetch/JSON/status/install/error/finally side effects.
  Prevent duplicate before-paint requests. Add requires the exact current result
  object, current rendered builder and existing readiness, serving and 50-row
  guards before allocating a row key or displaying success. Preserve exact public
  food-version and serving pins, including later-page choices.
- New/copy/open/save replacement and private/profile/lifecycle transitions reset
  or invalidate search as appropriate. Preserve ordinary unsaved builder edits,
  ingredient notes/order, pasted review, saved/nested filters, nutrition choices
  and recipe-log date/time/amount/portion/meal plus pending save/log identity.
  Search, continuation and Add must not write a recipe before explicit Save.
- Scope: two recipe components and their existing state suites, this ADR/index,
  build plan and additive release gates (eight paths). No shared helper, API,
  parser, ranking, catalogue, dependency, outbox, controller or backend changes.
- Require focused actual-component/helper regressions, affected types/format and
  independent source review. Cover overlap and empty pages, raw-query/request
  ownership, stale results/statuses/controls, transient retry versus invalid cursor,
  later-page exact pins, cap and draft/log independence. Then freeze and run
  canonical check/build/licenses with fresh client outputs.
- Source-validated synthetic production Next/BFF dedicated-Chrome QA must reach a
  later-page food and Add it to a dirty builder, exercise continuation retry and
  invalid-cursor recovery, and verify draft/log-time independence, no premature
  writes, keyboard/narrow layout and expired-session closure. Keep all 15 core
  nutrient definitions, normal auth guards, source checkpoints and owned cleanup.
- Stop condition: reviewed local source and required evidence, normal commit and
  non-force push under standing authorization, exact automatic observation and
  compact readiness checkpoint. Real catalogue/persistence, physical native and
  protected storage, assistive technology, concurrent React, external Claude Code,
  hosted and release acceptance remain separate.

## Consequences and alternatives

Explicit continuation keeps requests deliberate and bounded while making more
reviewed foods selectable. Increasing a global limit or adding automatic infinite
scroll would change shared behavior unnecessarily. Invalid cursors require a new
search so the user can see that the result set has been replaced.

## Review triggers

Revisit when search cursor identity, version merging, recipe builder replacement,
private ownership or native lifecycle behavior changes. Preserve existing gates.

## Local evidence and limits (UTC 2026-09-11T04:58:07.206777+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 804 web tests, 1277 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Source-validated synthetic production Next/BFF in dedicated Chrome verified
20 initial reviewed foods, overlap-preserving continuation to 22 and an empty final
page. A 503 kept rows/cursor and explicit retry used the identical query/cursor;
a 400 kept rows, removed Load more and asked for Search again without claiming
exhaustion or automatically restarting. Raw query edits made no request and
disabled retained choices; an explicit lentils query replaced the loaded results.
Later-page serving and grams-only Add preserved the dirty name, original ingredient
note/125.000009 g, order, filters, nutrition basis and log date/time/1.250000 amount.
Both Add actions made no request; all 26 upstream requests contained zero domain
writes. Exact outgoing version/serving pins were verified in component tests.
Keyboard Search/Load more and 390px replacement-search/no-horizontal-overflow checks
passed. Expired-session reload returned to sign-in and removed private controls.
The owned Chrome tab was closed, viewport reset, and both verified test processes
stopped normally with ports 3008/4008 absent. This is synthetic browser/BFF evidence;
real catalogue/persistence, physical native/protected storage, assistive technology,
concurrent React, external Claude Code, hosted and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
