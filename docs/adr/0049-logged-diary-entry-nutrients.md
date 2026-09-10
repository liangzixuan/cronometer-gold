# ADR 0049: Inspect nutrients for a logged diary portion

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context

Diary entries already contain immutable nutrient snapshots for the logged portion.
Their rows show energy, but inspecting other nutrients requires reviewing whole-day
totals. A local disclosure can expose the existing entry values directly.

## Acceptance card

- Task: Show or Hide nutrients for an individual loaded diary entry on web/native.
  Default closed; multiple entries open independently. Label the saved logged
  portion and entry revision, including while an unsaved editor is open.
- Render every existing entry.nutrients row in source order using the unchanged
  nutrientDisplay helper and saved name/unit. Preserve exact strings, quantified
  zero, lower bounds, trace, partial, unknown and coverage qualification; support
  the existing 256-row bound and an explicit unavailable message for an empty
  vector. No new math, rounding, target percentages, lookup, interpretation,
  nutrient registry join or serving conversion.
- Show/Hide is local and makes no requests or writes. Preserve entry order,
  loaded/total counts, whole-day totals, paging/retry, meal choices, raw editor
  fields, messages, pending correction/repeat/reorder body/key identity and native
  protected-queue state. A read-only disclosure may remain available during an
  edit or pending operation when its installed snapshot remains current.
- Bind visibility and callbacks to current private/date/route/lifecycle scope and
  the exact installed entry snapshot. Use independent presentation state and
  synchronous generation guards; repeated/retained Show/Hide cannot undo a later
  choice. A changed or removed entry starts closed. Full reload invalidates old
  disclosures immediately and stays closed through failure until current data is
  installed. Before replacement-scope effects, old details cannot be exposed.
- Valid coherent pagination preserves unchanged entry objects and their choices;
  new entries start closed. Page failure retains current choices; a stale page
  follows the existing full-refresh boundary. Do not change merge/cursor rules.
  Collapsing a meal hides its details and rejects retained hidden-row actions;
  reopening restores choices for unchanged entries. Do not change editor/queue
  protections or meal-collapse semantics. Date replacement, private closure,
  background and unmount invalidate details and retained callbacks.
- Controls have meaningful entry-specific labels and expanded state; web buttons
  are non-submit, keyboard usable and associated with matching content. Preserve
  focus on Show/Hide. Long names/units and exact decimals wrap at 390 pixels.
- Source scope: web DiaryClient.tsx and DiaryClient.state.test.ts; native
  DiaryScreen.tsx and existing diary-group-collapse.test.mjs; this ADR/index,
  build plan and additive release gates (eight paths). No shared helper,
  API/schema/dependency/storage/outbox, authorization or nutrition-math change.
- Evidence: focused actual-component states, food/private-food/recipe, exact
  values and all missingness/empty/256-row cases; independent controls, no request,
  raw edit and pending retry identity; coherent paging/error/stale refresh,
  revision/date/route/private/lifecycle/hidden/stale callbacks; affected types and
  formatting, early independent review. Frozen canonical check/build/licenses
  and fresh web/native outputs. Source-validated synthetic production Next/BFF
  in dedicated Chrome proves values, local toggles, draft independence, paging
  retry, meal/date closure, keyboard, narrow layout and session expiry. No browser
  domain write is required; real correction persistence remains existing gated work.
- Stop: reviewed source and applicable local/browser proof pass, normal commit
  and non-force push, exact automatic observation and compact readiness. Real
  persistence, physical native, assistive technology, concurrent React,
  independent Claude Code, hosted and release acceptance remain separate.

## Decision and consequences

Render existing saved nutrient evidence independently of edits. This makes an
individual logged portion inspectable without changing a diary snapshot. Whole-day
totals retain their existing meaning. Details close on a full reload so a replaced
snapshot requires a new inspection action; coherent paging retains current choices.

## Review triggers

Revisit before nutrient sorting/filtering, editing within details, derived targets,
per-serving calculations, retained preferences or a changed diary snapshot contract.

## Local evidence and limits (September 10, 2026)

Focused checks passed 88 web and 83 native
tests, with affected types/format and independent in-task review. Frozen canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed. Fresh evidence includes
737 web tests, 1217 native tests and 10 native runner checks,
both client type checks, production Next and iOS/Android exports. Root policy
passed 157 checks; licenses covered 535 production packages with
14 reviewed exceptions. All task graphs ran with zero cache reuse;
89 optional integration cases remained skipped.

A source-validated in-memory three-day fixture and production Next/BFF in dedicated
Chrome proved exact logged-portion values, zero/trace/partial/unknown qualifiers,
an empty nutrient vector, independent Show/Hide without requests, and preserved
raw editor fields. Coherent paging failure/retry retained open unchanged entries;
meal collapse/reopen retained choices, date replacement reset them, and session
expiry closed private content. Keyboard focus and 390-pixel wrapping passed.
The owned Chrome tab and verified loopback test processes were closed; ports
3008/4008 were absent. Browser actions made no domain writes; correction/retry
identity remains component-test evidence. Synthetic data, mocked components and
exports do not establish real persistence, physical native, assistive technology,
concurrent React, external Claude Code, hosted or release acceptance.

Exact UTC commands, hashes, review corrections and observations remain outside Git
in the Windows readiness record.
