# ADR 0070: Protect unfinished native nutrient input when saving

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

Native custom-food Save serializes appended canonical rows and clears the named
nutrient composer on success. Unappended input can therefore be omitted and lost.
Successful Add keeps the selected nutrient/state/reason and clears only amount;
search filtering and that acknowledged residue must not prevent ordinary Save.

- User task: save a custom food without losing unfinished named nutrient input.
  Guard Create and Save before operation allocation or requests when entry work
  differs from its acknowledged state. Keep explicit Add authoritative; never
  silently append, parse/round away raw work, or save while dropping that work.
- Track exact nutrient ID, state, raw amount and unknown reason, excluding query.
  Reset acknowledgement with the editor and after a successful explicit Add or
  Clear nutrient entry. Failed Add does not acknowledge work. Query-only changes
  and ordinary post-Add Save remain valid, including trace and unknown rows.
- Explain Add-or-clear recovery near the composer. Clear nutrient entry resets
  only entry controls, preserving the filter, all raw food fields and canonical
  rows. Clearing remains available when the named registry is unavailable, with
  current draft/composer/private/lifecycle/loading/pending-write guards intact.
  Save remains an explicit action after recovery; no silent retry or write.
- Preserve canonical manual editing, exact ID/revision/create intent, payload and
  retry identity, receipts, private/source ownership and existing Copy/Revise,
  registry/refresh, lifecycle, busy/write and queue behavior. No new storage,
  API, parser, helper, dependency, web, service or shared-style change.
- Scope: RetentionScreen.tsx and its existing custom-food-nutrient-composer suite,
  this ADR/index, build plan and additive release gates. Compact actual-component
  cases cover quantified zero/precision/invalid raw input, trace/unknown/reason,
  failed Add, local Add/Clear recovery, query-only/post-Add saves, stale/private/
  write/reset/refresh callbacks and exact request/retry. Reuse existing coverage.
- Evidence: focused behavior/helpers, affected types/format and independent
  source review precede frozen canonical pnpm check/build/licenses and both
  native exports. Root review verifies the existing save/controller/operation/
  queue contract outside the new pre-write guard. No web browser surrogate is
  needed for this native-only behavior.
- Stop after source/local gates and final review, normal commit/non-force push,
  exact-commit automatic observation and dated readiness. Hook/host and exports
  do not establish every concurrent React interleaving, physical-device or
  assistive-technology behavior, real persistence/protected storage, external
  Claude Code, hosted or release acceptance. No cloud/workflow/device action.

## Decision and consequences

Keep a narrow acknowledgement for nutrient-entry controls, separate from search
and the food draft. A blanket nonblank-composer guard would block valid post-Add
saves; automatically appending would change the explicit Add contract. Revisit
the acknowledgement if composer reset, canonical editing or save semantics change.

## Local evidence and limits (2026-09-14)

Native Create and Save now stop before allocating operations or sending requests
when named nutrient entry work has not been acknowledged. Add-or-clear guidance
preserves raw input. Clear nutrient entry resets entry controls while preserving
the filter and every food/canonical field. Successful Add and editor reset update
the acknowledgement; failed Add does not. Query-only changes and ordinary
post-Add Save remain valid, including trace and unknown rows. Existing exact
create/revision/retry and private/draft/write guards remain intact.

Focused actual-component/helper checks, affected types/format and independent
source review passed. Cases cover raw precision/zero/invalid input, trace and
unknown reasons, failed Add, local Clear/Add recovery, registry unavailability,
current callbacks, reset/refresh and exact save/retry behavior.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1472 native tests plus 10 runner checks, 1008 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Native hook/host and export proof does not
establish rendered-device or assistive behavior, every concurrent React interleaving,
real persistence/protected storage, external Claude Code, hosted or release
acceptance. No browser or service was used for this native-only behavior change.
