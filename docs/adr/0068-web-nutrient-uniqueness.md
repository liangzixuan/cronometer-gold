# ADR 0068: Prevent duplicate web nutrient choices

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer and release acceptance remain separate.

## Context and acceptance card

Custom-food nutrient rows offer IDs already selected in another row. Choosing
one replaces the row with a quantified zero and leaves Save to explain the
duplicate. The existing Add action already avoids represented IDs.

- User task: change a nutrient without creating a duplicate or losing raw values
  to an invalid selection. Disable and annotate alternatives used by another row.
  Retain the current option, exact names/units/order and existing saved fallback.
- Reject duplicate, unloaded, missing-row and same-ID transitions before mutation.
  Same-ID selection preserves raw amount/state/reason and all other draft fields.
  A valid different loaded ID keeps the existing quantified default amount 0.
  Removing or changing another row releases its previous ID for selection.
- Reuse currentCustomNutrientMetadata and existing custom/private ownership.
  Preserve pending-save local editing, exact save validation and ambiguous retry;
  do not couple choices to trend query/date/series or introduce a new controller.
- Scope: HealthClient.tsx and its existing state suite, this ADR/index, build plan
  and additive release gates. No native, helper contract, parser, API, dependency,
  shared style, persistence or live catalogue change.
- Evidence: compact actual-component transitions cover duplicate/same-ID no-ops,
  available ID release/defaults, distinct IDs with shared names, legacy fallbacks
  and stale/private/metadata guards with no local requests or operation allocation.
  Reuse existing save/ownership suites. Affected types/format, independent source
  review, frozen canonical check/build/licenses and production synthetic Chrome
  with complete core metadata, raw-row/option/request accounting, keyboard/narrow
  layout and owned cleanup precede final review and delivery.
- Stop after local gates, final review, normal commit/non-force push, exact-commit
  automatic observation and dated readiness. Synthetic hook/BFF/browser evidence
  does not establish real persistence, cross-owner service/restore/privacy, every
  concurrent React interleaving, assistive technology, external Claude Code,
  physical device, hosted or release acceptance. No cloud/workflow control included.

## Decision and consequences

Prevent an invalid choice at the existing row selector, retaining the server and
save-time uniqueness checks. Existing invalid legacy rows remain editable without
silently repairing or deleting them. Revisit if row uniqueness, registry ownership,
fallback choices or different-ID defaults change.

## Local evidence and limits (2026-09-14)

Used nutrient alternatives are disabled and labeled in each row selector while
current and saved fallback choices remain available. Duplicate, same-ID, unloaded
and stale changes are rejected before touching raw draft values. A valid different
choice resets only its row to quantified zero, and changing/removing rows releases
their old IDs. Existing metadata/private ownership, pending-save editing and
explicit save/retry remain intact. Focused component/helper checks, affected
types/format and independent source review passed.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1003 web tests, 1441 native tests plus 10 runner checks,
157 root checks, production Next and both native exports. Zero cached tasks;
535 production licenses/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Production Next/BFF dedicated Chrome proof used complete core definitions and
verified exact ordered choices, disabled used alternatives, same-ID raw-value
preservation, valid row changes and released IDs after change/removal. Keyboard
selection and narrow layout passed; local operations issued no requests. Expiry
and owned tab/process cleanup passed.

Exact commands, times, versions, source/build hashes, reviews and automatic state
are in Windows readiness outside Git. Synthetic hook/browser evidence does not
prove real persistence, every concurrent React interleaving, assistive technology,
native device, external Claude Code, hosted or release acceptance.
