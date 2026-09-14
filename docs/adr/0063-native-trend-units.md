# ADR 0063: Units in native Health trend metric choices

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context

Native trend metric choices show names and archived status. Two saved metrics
with the same name and different canonical units cannot be distinguished before
loading. Web already includes canonical units; native has an existing wrapping
label option used by other choices.

## Acceptance card

- User task: distinguish a native Health trend metric by its exact saved name and
  canonical unit before selecting it. Render name (unit), followed by the existing
  archived suffix. Use existing wrapping labels for long choices.
- Preserve None without a unit, source order, exact IDs, selected/disabled radio
  state, unavailable/empty metadata behavior and explicit existing Load. Selecting
  same-name metrics must still send the selected definition ID; labels perform no
  conversion, inference or rounding.
- Keep input/read/private/lifecycle handlers, dates/presets, nutrient/search, raw
  editors, history, operations/retries and protected queues unchanged. Rendering
  and local selection do not add requests or domain writes.
- Scope: native RetentionScreen label and wrapLabels prop, its existing component
  suite, this ADR/index, build plan and additive release gates. No web, helper,
  state, controller, parser, API, schema, storage or dependency change.
- Evidence: update existing label-dependent assertions and one compact behavioral
  case for same-name/different-unit, long/archived choices, None/source order,
  wrapping styles, selected state and exact definition-ID GET. Reuse existing
  focused ownership/retry tests; affected types/format and independent review;
  frozen canonical pnpm check/build/licenses and fresh native exports.
- Stop: reviewed source and local gates pass, normal commit/non-force push,
  exact automatic observation and readiness recorded. Native hook/host tests and
  exports do not prove rendered-device layout, assistive technology, concurrent
  React, real persistence/protected storage, external Claude Code, hosted or
  release acceptance. No browser surrogate is required for native labels.

## Decision and consequences

Include authoritative canonicalUnit in existing labels and reuse wrapLabels.
Keeping only names would preserve the ambiguity; introducing a new formatter or
controller is unnecessary. Revisit if displayed units differ from saved canonical
units, localization changes unit policy or trend contracts change.

## Local evidence and limits (2026-09-14)

Only metric label text and the existing wrapLabels prop changed in production.
Focused actual-component/helper checks, affected types/format and independent
source review passed. Same-name metrics with different units remain distinct by
ID, long/archived choices use existing wrapping styles and None remains unchanged.
Explicit reads retain the chosen ID; existing draft/operation/queue behavior stays.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1439 native tests plus 10 native runner checks, 970 web tests,
157 root checks, both native exports and production Next. All task graphs
used zero cached tasks. Licenses covered 535 production packages with
14 reviewed exceptions; 89 optional integration cases remained skipped.

Exact commands, times, versions, hashes, reviews and automatic observations are
recorded in Windows readiness outside Git. No browser/service was needed. Native
hook/host and export evidence does not prove rendered-device layout, assistive
technology, concurrent React, real persistence/protected storage, external Claude
Code, hosted, signed-device or release acceptance.
