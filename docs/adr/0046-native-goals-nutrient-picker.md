# ADR 0046: Native Goals nutrient picker

Status: Source/local complete; automatic, device, independent reviewer and release acceptance separate.

## Context

The native Goals query already searches every eligible loaded nutrient by name
and code, but displays only its first 20 matches. Choices omit units, and no
count or no-match feedback explains the list. Web exposes every eligible loaded
definition with its name and unit. The existing native parser bounds the loaded
registry at 256 entries; target identity is the nutrient ID.

## Acceptance card

- Task: find any loaded nutrient and explicitly add its threshold row to a native
  goal draft. Show all matching eligible definitions in source order, with exact
  names and units in visible and accessible Add labels. Preserve distinct IDs,
  including same-name nutrients, and allow long labels to wrap.
- Keep existing 100-character query input and trimmed, case-insensitive substring
  matching against the combined name/code text. No unit search, sort, pagination,
  conversion, target advice or automatic selection/addition.
- Show matching, available and loaded counts. Available excludes IDs already in
  the draft. Distinguish no loaded nutrients, all loaded nutrients already added,
  and no query matches. Initial/failed loading must not claim an authoritative
  empty registry; use existing status/Refresh and truthful loaded-only language.
- Clear changes only the query. Filtering/Clear preserves every raw draft field,
  selected reference state and pending save identity, and issues no request.
  Keep existing query lifecycle across refresh/new draft. Explicit Add removes
  that ID from available matches; removing its draft row makes it available again.
- Preserve historical and verified-reference locks and existing explicit
  Customize behavior. Bound picker controls while loading/saving/profile saving.
  A narrow functional Add updater may reject replaced builders, locked drafts,
  duplicates and the existing 256-target cap. Reuse existing request identity
  and controller checks where needed to reject a retained Add action; do not
  rewrite shared reads, writes, private scope or mutation/receipt controllers.
- Files: GoalsScreen.tsx, a new focused actual-component Goals picker suite,
  this ADR, ADR index, build plan and additive release gates (six paths).
  API/contracts/parsers/reference policies/web/dependencies stay unchanged.
- Evidence: actual-component all-256/beyond-20, exact ID/unit/long-label, search,
  counts/empty/Clear, Add/remove, raw-draft preservation, historical/reference
  locks and retained Add cases; unchanged explicit save body and ambiguous retry
  identity. Relevant existing goal/reference helper tests, types/format and
  independent review before frozen canonical check/build/licenses. Native tests,
  types and platform exports must be fresh; unchanged web cache reuse explicit.
- Stop: reviewed source, passing applicable local gates, normal commit/non-force
  push under standing authorization, exact automatic observation and compact
  readiness. No browser surrogate is needed for this native-only source change.
  Device layout, assistive technology, concurrent React, real persistence,
  independent Claude Code, hosted and release acceptance remain separate.

## Decision and consequences

Render the existing bounded registry rather than truncating matching choices.
Keep query state independent of the explicit goal builder and save operation.
Counts describe loaded data only. Revisit this approach if the registry bound
grows or real-device measurement demonstrates a need for virtualization.

## Local evidence and limits (September 10, 2026)

Focused native component and goal/reference checks passed 38 tests,
with affected types, formatting and independent in-task review. Frozen canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check` passed. Native types,
1155 tests, 10 runner checks and iOS/Android
exports were fresh. Root policy passed 157 checks. Unchanged web
690 tests/types/build were cached. License policy passed 535
packages with 14 reviewed exceptions; 89
optional integration skips remain explicit in raw evidence.

Native host mocks and exports do not establish physical layout, assistive
technology, concurrent React, real persistence, independent Claude Code, hosted
or release acceptance. No browser surrogate or service/device exposure was used.

Exact commands, UTC, source hashes, retained failures and delivery/automatic
observations are recorded outside Git in Windows readiness.
