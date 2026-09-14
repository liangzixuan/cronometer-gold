# ADR 0067: Explain unavailable web nutrient additions

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer and release acceptance remain separate.

## Context and acceptance card

The custom-food Add nutrient button silently does nothing when every loaded ID
is already represented or the loaded list is empty.

- User task: understand whether another nutrient can be added to a private food
  draft. Disable Add when there is no remaining verified loaded choice. Show
  distinct exhausted, empty and unavailable feedback, associated with the action.
  Removing a represented row restores Add when a loaded choice becomes available.
- Derive the first unused ID in existing source order; preserve quantified default
  amount 0, exact IDs/units, legacy rows, raw amounts/states/reasons and other fields.
  Preserve explicit save, ambiguous retry and current local editing during a save.
- Reuse accepted nutrient metadata identity/values/scope and custom/private guards.
  Reject retained Add callbacks after draft, registry, lifecycle or owner changes;
  do not couple this action to trend filter, date or series generations. No new
  loader, controller, remote search, persistence, API or parser contract.
- Scope: HealthClient.tsx and its existing state suite, this ADR/index, build plan
  and additive release gates. No native, dependency or shared-style changes.
- Evidence: compact actual-component cases for exhaustion/removal/source order,
  empty/unavailable and stale controls, exact raw draft preservation and no network
  or operation allocation from local additions. Reuse existing ownership/retry
  evidence rather than duplicate its matrix. Affected types/format, independent
  source review, frozen canonical check/build/licenses and production synthetic
  Chrome proof with the complete checked-in core registry, keyboard/narrow layout,
  request accounting and owned cleanup precede final review and delivery.
- Stop after local gates, final review, normal commit/non-force push, exact-commit
  automatic observation and dated readiness. Synthetic BFF/browser evidence does
  not establish real persistence, cross-owner service/restore/privacy, physical
  device, external Claude Code, hosted or release acceptance. No cloud, workflow
  control, live catalogue or device action is included.

## Decision and consequences

Explain availability at the existing action instead of creating a new picker.
Use the accepted registry and draft guards so stale metadata cannot offer Add.
Full labels and existing row editing remain intact. Revisit this decision if
registry ownership, row uniqueness or Add defaults change.

## Local evidence and limits (2026-09-14)

The existing Add action now explains verified availability and is disabled when
no current loaded choice remains. Empty and unavailable metadata have distinct
feedback; removal restores a choice without changing other raw rows. Accepted
registry and custom-draft guards preserve exact IDs, first-unused order/defaults,
private ownership and explicit save/retry. Focused component/helper checks,
affected types/format and independent source review passed.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1000 web tests, 1441 native tests plus 10 runner checks,
157 root checks, production Next and both native exports. Zero cached tasks;
535 production licenses/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Production Next/BFF dedicated Chrome proof used complete core definitions and
verified exhaustion, removal/re-add, exact raw draft preservation, keyboard and
narrow layout, empty/unavailable feedback and recovery. Local row operations
issued no requests. Expiry and owned tab/process cleanup passed.

Exact commands, times, versions, source/build hashes, reviews and automatic state
are in Windows readiness outside Git. Synthetic hook/browser evidence does not
prove real persistence, every concurrent React interleaving, assistive technology,
native device, external Claude Code, hosted or release acceptance.
