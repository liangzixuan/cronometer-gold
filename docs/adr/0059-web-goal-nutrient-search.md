# ADR 0059: Search the web goal nutrient picker

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the roadmap. Add name/code search and Clear to the web
goal nutrient picker, matching the useful native flow described by ADR 0046.
Search helps find loaded nutrients; adding a target and publishing a goal remain
separate explicit actions.

## Acceptance card

- Provide a labelled Find a nutrient input and Clear nutrient search action.
  Keep raw query text bounded at 100 characters. Use literal, case-insensitive
  substring matching against combined name/code text with a trimmed query, as
  native does. Do not add unit search, sorting, fuzzy matching, requests, storage,
  target advice, conversions or automatic target creation.
- Derive available choices from the current loaded registry, excluding exact IDs
  already present in the draft. Show every match in source order with exact name
  and unit; preserve distinct IDs even when names match. Retain the preferred
  selected ID when it is still a match; otherwise display the first matching ID
  or an empty choice. Add must use that displayed ID, never a hidden preference.
  Clear changes only the query; it must not modify target rows or raw goal fields.
- Show matching, available and loaded counts with loaded-only meaning. Distinguish
  no loaded registry, all loaded nutrients already added, and no available matches.
  Loading/error states must not claim authoritative empty data; preserve existing
  status/Retry. Add is disabled without a current available match or at the
  existing 256-target cap. Removing a target restores its availability.
- Query/selection/Clear have narrow presentation ownership, separate from existing
  read/write generation, candidate identity and pending mutation map. Same raw
  query/selection and Clear while empty are true no-ops. Preserve raw energy,
  effective date, threshold/source/version/rationale fields, profile/reference
  inputs, acknowledgement and exact pending body/key across search changes.
- Retain query across same-scope refresh and New goal; reset on actual selected
  progress-date or private owner/profile scope replacement and sign-in closure.
  Reuse existing lifecycle policy. Fence retained picker callbacks using current
  mounted/route/session/date and read-generation evidence plus live auth/load/
  write/profile controller checks. Search must never advance request generation,
  abort work, allocate an operation, or change save/receipt ownership.
- Preserve historical and source-verified/reference locks and explicit Customize.
  Use the existing availability boundaries for the new picker, including pending
  private reads, goal writes and profile writes. Do not rewrite other controls,
  requests or general identity policy. A narrow functional Add updater may reject
  a replaced builder and recheck current lock/duplicate/cap before creating a row.
  Reject hidden/stale Add/query/selection callbacks after presentation or scope
  changes, including A-to-B-to-A. Raw builder edits before paint must invalidate
  retained Add; query/selection remain independent of unrelated raw edits. Prefer
  this over converting all builder setters.
- Scope six files: apps/web/src/app/goals/GoalsClient.tsx, a new actual-component
  GoalsClient.state.test.ts, this ADR, ADR index, build plan and additive release
  gates. Native/API/BFF/parsers/reference policy/helpers/dependencies/outbox and
  unrelated hardening remain outside this slice.
- Require focused actual-component cases with real parsers for all bounded
  choices, exact ID/name/unit/search/count/selection/Add/remove semantics, no-op
  and zero-request behavior, raw drafts, locks, stale/private/route/read/write
  controls, exact Create/revision/ambiguous retry and accepted receipt behavior.
  Include existing goal/recipe/reference helper tests, affected types/format and
  independent review before freezing canonical check/build/licenses and production
  web plus native exports. Dependencies stay unchanged; older audit is historical.
- Dedicated Chrome uses production Next and normal BFF authentication with an
  isolated loopback synthetic upstream. Preserve all 15 core nutrients in fixture
  metadata and follow the actual goal targetable contract (14 non-energy core
  nutrients). Validate source parsers and reference availability without weakening
  them. Verify name/code/literal/empty/Clear, explicit Add, raw source/draft fields,
  synthetic Create/revision/retry, keyboard/390px and expiry. Search request counts
  stay zero; explicit reads and bounded in-memory synthetic goal writes are
  journaled separately. No live catalogue or real backend writes are authorized.
- Stop after reviewed source/local evidence, normal commit/non-force push under
  standing authorization, exact automatic observation and readiness/CURRENT.
  Preserve real persistence, physical native/protected storage, assistive
  technology, concurrent React, external Claude Code, hosted and release gates.

## Consequences and review triggers

The picker becomes searchable without changing goal interpretation or publication.
Revisit if registry bounds, goal draft ownership, private scope, reference locks,
or exact mutation/retry contracts change. Native already provides its own search;
this slice changes only the web client.

## Local evidence and limits (UTC 2026-09-11T18:22:32.960534+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 911 web tests, 1350 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Dedicated Chrome QA passed with production Next/BFF and a loopback synthetic fixture containing all 15 core nutrients and 14 non-energy targetable choices. Search by name/code, literal matching, Clear, displayed-choice Add/remove, truthful counts, raw draft preservation, keyboard use, 390px layout and expiry passed. Local search checkpoints remained 14→14, 15→15, with zero request deltas.

The fixture accepted a revision in memory and returned 503; retry returned 200 with the same exact body/key/precondition. Explicit Create returned 201, and current/progress readback passed on its effective date. The 33 upstream requests include 3 synthetic goal-write attempts (2 accepted changes and 1 replay); there were no live backend writes.

The owned Chrome tab was closed, the viewport reset, and both verified test processes stopped. Ports 3008/4008 were absent. OS select-popup pixels, assistive technology, concurrent React, real persistence, physical native/protected storage, external Claude Code, hosted and release acceptance remain unproven.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
