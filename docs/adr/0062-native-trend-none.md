# ADR 0062: Nutrition-only Health trends on native

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context

Web already offers None for its optional biometric trend. Native lists only saved
metrics, although its existing explicit loader supports nutrient-only reads and
same-private metadata refresh preserves an empty biometric selection.

## Acceptance card

- User task: select None for the native Health trend biometric series, then use
  the existing Load action to inspect nutrition alone. Keep saved metric choices
  and their source order available so a person can restore two-series loading.
- Route the empty definition ID through existing current trend-input ownership.
  A matching None is a true no-op before abort, state, status or request changes.
  A changed selection retires the superseded trend read and clears only its old
  biometric result; preserve nutrient results and exact display semantics.
- Keep dates and 7/30/90-day shortcuts, selected nutrient and search, raw custom
  food/biometric/reminder drafts, history, pending writes, retry identity, queues
  and shared busy/status ownership. None is local: no request, domain write or
  operation allocation. Explicit Load with None issues the existing nutrient GET
  only; selecting a saved metric restores the existing paired GETs.
- Preserve None on successful same-private metadata refresh. Keep current empty,
  missing-definition and first-install policies. Existing stale input, metadata,
  private/session/profile-zone, lifecycle and before-paint guards remain in force;
  obsolete callbacks/responses/finally paths cannot replace later work.
- Affected source: native RetentionScreen and its existing actual-component
  suite, this ADR/index, roadmap and additive release gates. No web, shared helper,
  API, parser, schema, dependency, persistence or mutation-controller change.
- Evidence: meaningful actual-component regressions for None/no-op, preservation,
  explicit one/two-series reads, refresh and stale/private/zone ownership; affected
  types/format and independent review; frozen canonical pnpm check, pnpm build,
  pnpm licenses:check and fresh native exports. Do not use web browser QA as a
  surrogate for this native control.
- Stop: reviewed source and applicable local gates pass, normal commit/non-force
  push, exact automatic observation and dated readiness recorded. Native mocks
  and exports do not establish rendered-device layout, assistive technology,
  concurrent React, real persistence/protected storage, external Claude Code,
  hosted, signed-device or release acceptance.

## Decision and consequences

Expose the existing optional-series contract with a None chip and admit its empty
ID through the current guarded input handler. Reuse the loader and refresh policy.
Revisit before persisting preferences or changing trend contracts or auto-loading.

## Local evidence and limits (2026-09-14)

The None choice reuses the guarded input handler. The shared loader, refresh
policy, mutation paths and protected queues are unchanged. Focused native
actual-component checks, affected types/format and independent source review
passed. The regressions cover explicit one/two-series loading, no-op and preserved
state, refresh, obsolete reads/callbacks and private/zone/retry ownership.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1438 native tests plus 10 native runner checks,
970 web tests, 157 root checks, both native exports and production Next.
All task graphs used zero cached tasks. License policy covered 535
production packages with 14 reviewed exceptions; 89 optional
integration cases remained skipped. Exact logs, versions, timestamps, source
hashes, reviews and automatic observations are in Windows readiness outside Git.

No browser or service was needed for this native-only slice. Hook/host tests and
native exports do not prove concurrent React, rendered-device layout, assistive
technology, real persistence/protected storage, external Claude Code, hosted,
signed-device or release acceptance.
