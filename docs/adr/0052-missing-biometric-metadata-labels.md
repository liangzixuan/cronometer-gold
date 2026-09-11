# ADR 0052: Label missing biometric metadata on web

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

Web biometric history shows an empty unit and generic Metric name when a saved
reading's exact definition is absent from the loaded definitions. Native already
labels unavailable metadata. Explicit web fallback labels make the limitation
visible without inventing a name or unit or fetching additional data.

## Acceptance card

- Change only the two saved-history fallback strings in HealthClient.tsx:
  an unavailable canonicalUnit reads unit unavailable; an unavailable name reads
  Metric unavailable. Keep known headings as exact value, canonical unit and
  metric name in their existing order. Match definitions by the exact saved ID.
- Apply the same fallback to manual and imported readings. Preserve saved exact
  values, date/time/zone/source, raw drafts, manual-only controls, write bodies,
  operation keys, paging, session/lifecycle guards and native behavior.
- Scope is five paths: the web component, this ADR/index, build plan and additive
  release gates. No state, helpers, requests, lookups, tests, dependencies, parser,
  controller, storage or API changes. Reuse existing focused suites for this
  small reversible text change; do not add tests that mirror the literals.
- Verify existing component/helper suites, affected types/format and independent
  source review; run frozen canonical check/build/licenses. A source-validated
  synthetic production Next/BFF in dedicated Chrome checks known and missing
  definitions for manual/imported records, exact values/time/source, raw draft
  independence, no added requests, readable 390px wrapping and private closure
  on expired-session route reload. Keep the full checked-in core nutrient registry.
- Stop after local/browser proof and review, normal commit/non-force push, exact
  automatic observation and compact readiness. Real persistence, physical native,
  assistive technology, external Claude Code, hosted and release acceptance stay
  separate. Do not change unavailable-definition editing behavior in this slice.

## Review triggers

Revisit if a definition can omit individual metadata fields, metadata acquisition
changes, or editing/import policy changes. These labels report availability;
they do not infer units or diagnose the cause of missing metadata.

## Local evidence and limits (UTC 2026-09-11T00:30:22.083920+00:00)

All 79 existing focused web component/helper tests passed, with affected
types/format and independent source review. No tests or native source changed.
Fresh canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
737 web tests, 1217 native tests plus 10 native runner checks,
157 root checks, production Next and both native exports. All task graphs
used zero cached tasks. License policy covered 535 production packages
with 14 reviewed exceptions; 89 optional integration cases remained skipped.

Source-validated synthetic production Next/BFF in dedicated Chrome showed explicit
missing name/unit labels for manual and imported readings. Known headings, exact
values and saved date/time/zone/source stayed unchanged. Raw draft edits left
history unchanged and added no requests. Five cards wrapped at 390px; expired
session route reload returned to sign-in and closed private biometrics. No domain
writes occurred. The owned tab and verified test processes were closed; ports
3008/4008 were absent. Real persistence, device, assistive technology, external
Claude Code, hosted and release acceptance remain separate.

Exact UTC commands, hashes and review evidence are outside Git in the Windows
readiness record.
