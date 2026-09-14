# ADR 0064: Search web Health trend nutrients

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer and release acceptance remain separate.

## Context

Web Health trends expose the whole loaded targetable nutrient registry in one
select. Native already offers a local name filter. Finding a nutrient in a long
loaded list should not alter existing trend results or select another series.

## Acceptance card

- User task: find a loaded trend nutrient by name, then deliberately select its
  existing trend. Add a labeled Find a trend nutrient by name input, Clear trend
  nutrient filter and truthful matching/loaded counts. Match trimmed,
  case-insensitive literal name text, preserve raw text up to 200 characters,
  reject overlength callback values and preserve loaded order, IDs and units.
- Typing/Clear changes only local filter state. It issues no request, selects no
  nutrient, aborts no trend read and changes no dates, presets, biometric choice,
  results, status, raw custom/biometric/reminder/log drafts, operation or retry.
  Same raw query and Clear-empty are true no-ops. Do not change the automatic
  trend effect, shared request/write helpers or mutation controllers.
- Keep the current valid selected option represented in source order when it
  does not match, with an explicit current-selection annotation outside the
  matching count. Distinguish no matches, verified empty and unavailable lists.
  If the retained selected ID lacks current metadata, show an unavailable selected
  placeholder without inventing name/unit or substituting another nutrient.
  Only a current matching loaded ID can change selection; choosing the current
  retained selection is a no-op. Deliberate selection keeps existing auto-loading.
- Use a separate synchronous raw-filter identity and accepted registry identity/
  private-profile scope. Reject stale query/Clear/selection callbacks, raw edit-
  restore cycles and excluded/unknown IDs before effects, during full/profile
  refresh, hidden/unmounted/closed or changed private/profile state. Do not advance
  trend-read input generations on filter-only changes. Same-scope metadata refresh
  retains query; private/profile replacement resets it and hides obsolete data.
- Scope: HealthClient.tsx and its existing state suite, this ADR/index, build plan
  and additive release gates. Reuse styles; no API/schema/parser/dependency/native,
  shared helper, storage, calculation, advice or remote search change.
- Evidence: focused actual-component/helper/type/format tests for matching,
  identities/counts/empty/missing metadata, no-request/results/draft/retry behavior,
  explicit exact-ID loading and stale/private/refresh/visibility callbacks;
  independent source review before frozen canonical check/build/licenses.
  Production Next/BFF synthetic dedicated-Chrome proof with all 15 core registry
  entries and additional synthetic targetable choices: search/Clear/no-request,
  selected-outside-filter/no-match, later-ID loading, preserved raw drafts/exact
  results, keyboard, 390px and expiry. Checkpoint source before browser QA and
  close only owned tabs; stop only verified owned loopback processes.
- Stop: reviewed source and applicable local/browser gates pass, normal commit/
  non-force push, exact automatic observation and dated readiness recorded.
  Synthetic browser/hook tests do not prove real persistence, concurrent React,
  assistive technology, native devices, external Claude Code, hosted or release
  acceptance. Existing integration/release gates remain separate.

## Decision and consequences

Filter the existing loaded registry locally while explicitly retaining selected
context. A separate query identity keeps search from replacing pending trend work.
Remote search or automatic first-match selection would change the contract and
is unnecessary. Revisit for remote catalogue search, persisted filters or changed
trend/private-loading contracts.

## Local evidence and limits (2026-09-14)

The separate raw query and accepted registry ownership preserve current selection,
results, pending reads and raw drafts while filtering. Matching choices retain
existing automatic loading. Focused component/helper checks, affected types/format
and independent source review passed, including private/profile refresh, retained
callbacks, missing metadata and unchanged retry behavior.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
993 web tests, 1439 native tests plus 10 runner checks,
157 root checks, production Next and both native exports. Zero cached tasks;
535 production licenses/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Production Next/BFF dedicated Chrome proof used a complete core registry and
32 targetable choices. Search/Clear issued no requests, preserved selected
context and exact sparse results/raw drafts; deliberate later-ID selection kept
existing automatic reads. Literal/case/whitespace, no-match, distinct units/IDs,
keyboard, narrow layout and expiry passed. Owned tab/process cleanup completed.

Exact commands, times, versions, source/build hashes, review and automatic state
are in Windows readiness outside Git. Synthetic hook/browser evidence does not
prove real persistence, concurrent React, assistive technology, native device,
external Claude Code, hosted or release acceptance.
