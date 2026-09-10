# ADR 0039: Filter loaded saved recipes by name

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

The web and native recipe workspaces show paged saved recipes and a separate
ingredient-food search. Finding a saved name currently requires scanning every
loaded row. A local presentation filter can narrow those rows while preserving
selected details, unsaved work and the existing paged collection contract.

## Acceptance card

- User task: type part of a saved recipe name, inspect matching loaded recipes,
  clear the filter or explicitly load more records, without disturbing active work.
- Observable result: a clearly labeled filter for loaded saved recipes and a
  Clear action on web/mobile. Retain raw text up to 200 characters; matching uses
  trim().toLowerCase() and a literal name.toLowerCase().includes() substring.
  Blank/whitespace shows all loaded records. Preserve original order and distinct
  IDs for duplicate names; no locale-dependent sorting, fuzzy or accent matching.
- Collection meaning: derive only the visible top-level saved list from the full
  loaded array. Show matching and loaded counts separately, including zero matches.
  Keep Load more and its cursor available even with zero visible rows. Explicitly
  state when more records may remain; never imply a search over unloaded records.
  An initial empty array/null cursor is unverified, not an empty complete library.
  Initial loading/error, successful empty first page, failed continuation, overlap/
  dedup and an empty terminal page must have truthful, noncontradictory status.
  Existing shared load copy may use accumulated count when needed; do not change
  paging, merge, ordering or endpoint semantics.
- Independence: typing, retyping the same value and clearing make no request or
  write, including no ingredient search, open, save or loader call. Do not change
  the backing recipes array, nested-recipe choices, selected details, builder,
  copy choice, ingredient-review/import state, nutrition basis, log date/time/meal,
  or any operation body/key. A selected recipe filtered out of the rail stays open.
  Filter actions must not invalidate builder/review/selection generations or
  overwrite shared action messages. No form submission is implicit.
- State: retain the query through same-private-workspace paging, refresh, errors,
  retries and recipe actions. Use its own synchronous value/generation guards;
  same-value actions cannot advance a ref without a corresponding current view.
  Pure local filtering may remain usable during same-scope reads/writes after
  private scope is valid. Reject retained stale field/Clear callbacks, unmount,
  closed/background or replaced owner/session/API/profile/route scope, following
  the existing client lifecycle. Clear/hide private query on scope replacement or
  closure; never expose an old query or rows before new-scope effects install.
  Preserve existing pending operation/lifecycle recovery instead of broad refactors.
- Accessibility: visible label, current loaded/matched feedback, usable Clear,
  keyboard and 390-pixel layouts. Filtering must not steal focus, collapse the
  workspace or hide paging and recovery controls. Clear returns to the full loaded
  list with existing selected/draft context intact.
- Required evidence: focused actual-component web/native tests for exact matching,
  whitespace, repeated values, clear, duplicate/order/paging/no-match/initial-error/
  empty-terminal meaning; no requests and exact selected/builder/copy/import/
  nutrition/log/nested-choice invariance, saved-operation retry identity and stale/
  private/lifecycle callbacks; affected types/format, independent in-task review,
  canonical check/build/license gates and exports; source-validated production
  Next/BFF dedicated-Chrome filtered selected-draft, paged/no-match/retry/clear,
  keyboard/narrow and expiry proof. Synthetic browser writes are unnecessary.
- Affected source: web RecipesClient and its existing state suite; native
  RecipesScreen and existing recipe-ingredient-review suite; this ADR/index,
  roadmap and additive release gates. No helper/API/schema/dependency/storage/
  outbox/nutrition calculation or recipe mutation contract change.
- Exclusions: server/global search, search ranking, sorting, fuzzy matching,
  favorites/tags, retained preferences, new pagination contracts, automatic
  selection/logging, real services/devices/catalogue/hosted/release enablement.
- Stop condition: reviewed source and applicable local gates pass; normal commit
  and non-force push under standing authorization; exact automatic states and
  compact readiness recorded. Independent Claude Code, physical native, actual
  persistence, assistive technology, hosted and release acceptance remain separate.

## Decision

Keep saved-name filter state independent and derive the visible saved rows only.
Keep collection evidence and explicit pagination visible so local matches cannot
be mistaken for a complete-library search. Preserve all current recipe work.

## Alternatives

Server search needs a new query contract and paging semantics. Reusing ingredient
search would mix separate tasks. Filtering the backing array would lose nested
choices and collection evidence. Automatic selection could discard unsaved work.

## Consequences

People can locate loaded saved names with less scanning. They still need explicit
Load more to inspect unloaded records, and all editing/logging remains explicit.

## Review triggers

Revisit before global search, retained filters, sorting/ranking, changed collection
consistency, automatic selection or new private-workspace lifecycle contracts.


## Local evidence (September 10, 2026)

Independent in-task review verified the frozen web/native components and existing
actual-component suites. Focused checks passed 130 web tests (79 component and
51 existing helpers) and 164 native tests (114 screen and 50 existing helpers),
plus affected types, formatting and diff checks. Coverage proves literal/trimmed/
bounded matching, duplicate names and loaded order, same-value/stale callbacks,
initial verification, failed/overlapping/empty continuation pages, preserved
selection/drafts/review/copy/import/nutrition/log choices, exact save/log retry
identity and private/profile/route/lifecycle closure. Profile changes clear the
query through existing profile installation without adding requests or changing
loaded collection or pending operations.

Canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` exited zero between
2026-09-10T09:27:39Z and 2026-09-10T09:28:24Z. Fresh client tests
passed 637 web and 861 native cases plus
10 native runner tests; root policy passed 157.
Type/test and build graph cache counts, fresh production web/iOS/Android output
identities and command logs are retained in the Windows readiness evidence.
License policy passed 535 production packages with
14 reviewed exceptions. Eight candidate file hashes stayed
unchanged during gates. Cached package results and service-gated skips do not
establish fresh service integration.

The source-validated in-memory fixture and production Next/BFF in dedicated Chrome
proved local filtering with no request, mixed-case/whitespace matching, retained
selected detail and dirty draft, and explicit paging at zero matches. A failed
second page retained query, rows and retry; overlapping records deduplicated to
52 loaded recipes, and an empty final page preserved those rows and complete-list
meaning. Clear, keyboard and 390-pixel controls, long names and session-expiry
closure passed. Browser recipe routes were read-only; exact save/log retry
identity is component-test evidence. Fixture/parser hashes, request counts,
observed states and command times are retained outside Git.

The owned Chrome tab was closed, viewport reset and exact owned QA processes
stopped; both loopback listeners were absent. No Codex closure was observed.
These checks establish bounded source behavior, not real persistence, physical
native, assistive technology, independent Claude Code, hosted or release acceptance.
