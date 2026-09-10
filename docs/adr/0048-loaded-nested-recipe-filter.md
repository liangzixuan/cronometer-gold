# ADR 0048: Filter loaded nested-recipe ingredient choices

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context

Both recipe builders display every loaded non-self recipe as a nested ingredient
choice. ADR 0039's saved-list filter deliberately leaves these choices unchanged.
A separate local name filter helps people find an ingredient without changing the
saved list, food search, active draft or exact pinned recipe version.

## Acceptance card

- Task: type part of a recipe name in the nested-ingredient picker, inspect the
  matching loaded choices and explicitly pin one; Clear restores eligible choices.
- Match raw text bounded to 200 characters using trimmed, lower-case literal
  name substring matching. Whitespace shows every eligible loaded choice. Keep
  source order and distinct IDs for duplicate names. Exclude the current recipe
  by ID, preserving the existing self/cap guards and exact recipe/version/name/
  100-gram pin. No ranking, fuzzy matching, conversion or automatic selection.
- Keep a separate query and Clear from saved-list filtering and ingredient-food
  search. Derive visible candidates from the unchanged full loaded collection.
  Show matching and eligible-loaded counts, including zero matches. Distinguish
  unverified initial data, verified empty/no eligible choices, incomplete paging
  and complete loaded data. Explain that more recipes may remain and keep the
  existing explicit Load more/retry reachable even with zero matches. Do not add
  a server/global search or pagination contract.
- Filter/Clear make no requests or writes. Preserve top-level saved filter/rows,
  food query/results, selection, raw builder and ingredient order/notes/quantities,
  review/import/copy choice, nutrition basis, log fields and pending body/key maps.
  Retain this local query through same-private-workspace paging, retry and recipe
  actions. Only explicit pin changes the builder through the existing edit path.
- Use a small independent synchronous query guard; repeated same-value input is
  a no-op. Reject stale input/Clear/pin callbacks from a superseded picker query,
  invalid private scope, lifecycle closure, obsolete builder or replaced loaded
  choice. A retained choice cannot pin a version no longer offered by the current
  loaded collection. Reuse current lifecycle/edit guards; do not broaden shared
  controller or pending-operation semantics. Hide/clear replaced private queries
  and candidates before replacement-scope effects expose them.
- Respect existing builder availability during initial loading, active operations
  and invalid/private state. Keep a visible label, selected ingredient context,
  non-submit web controls, keyboard usability and 390-pixel layout. Clear does
  not steal focus or erase other work. Existing recipe paging stays explicit.
- Source scope: web RecipesClient and existing state tests; native RecipesScreen
  and existing recipe-ingredient-review tests; this ADR/index, build plan and
  release gates (eight paths). No helper, API/schema/dependency/outbox/storage or
  nutrition math change.
- Evidence: focused actual-component matching/bounds/whitespace/same-value/Clear,
  duplicate/order/self/cap/version pins, initial/empty/paged/no-match meaning,
  no-request and draft/filter/review/log independence, stale query/choice/private/
  lifecycle callbacks and existing exact retry regressions. Affected types/format,
  independent review, frozen canonical check/build/licenses and fresh client
  outputs. Production Next/BFF with source-validated synthetic upstream in
  dedicated Chrome proves no-request filtering, draft/exact pin, paging at zero
  matches/retry, keyboard/narrow and expiry; no browser write is required.
- Stop: reviewed source and applicable local/browser proof pass, normal commit
  and non-force push, exact automatic observation and compact readiness recorded.
  Real persistence, physical native, assistive technology, concurrent React,
  independent Claude Code, hosted and release acceptance remain separate.

## Decision and alternatives

Add independent local presentation state to each nested picker and retain the
existing explicit pin operation. Reusing saved-list or food search would couple
different tasks; server search would require new paging and query semantics.

## Consequences and review triggers

Finding an already loaded recipe requires less scanning. Unloaded records still
require explicit paging. Revisit before global search, retained preferences,
sorting, changed list consistency, automatic pinning or version-refresh policy.

## Local evidence and limits (September 10, 2026)

Focused checks passed 144 web and 186 native
tests, with affected types/format and independent in-task review. Frozen canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed. Fresh client evidence:
719 web and 1193 native tests, 10 native runner checks,
both client type checks, production Next and iOS/Android exports. Root policy
passed 157 checks. Licenses passed for 535 production packages with
14 reviewed exceptions. All task graphs ran with zero cache reuse;
89 optional integration cases remained skipped.

The source-validated in-memory fixture and production Next/BFF in dedicated
Chrome proved independent filtering without requests, preserved raw draft and
saved-filter context, self-exclusion, duplicate names/order and an exact explicit
nested-version pin at 100 grams. Initial failure, no-match paging, continuation
failure/retry and overlapping/empty-terminal pages retained truthful counts.
Keyboard, 390-pixel picker controls and session-expiry closure passed. The owned
tab and verified test processes were closed; ports 3008/4008 were absent afterward.
Browser recipe routes were read-only; save/log retry identity is component-test
evidence. This bounded synthetic proof does not establish real persistence,
physical native, assistive technology, concurrent React, independent Claude Code,
hosted or release acceptance.

Exact UTC commands, hashes, review corrections and automatic observations are
retained outside Git in Windows readiness.
