# ADR 0045: Native biometric reading units and identity

Status: Source/local complete; automatic, independent reviewer, device and release acceptance separate.

## Context

Native biometric reading choices display only metric names, the value field has
no unit context, and saved readings omit their units. Web already qualifies
metric choices and saved values with the definition's canonical unit. Native
also permits changing the selected metric during Edit, while the existing event
revision contract correctly retains the original event's definition.

Definitions have stable IDs and immutable canonical units; their names can be
revised. Events expose their definition ID and exact value. A current loaded
definition is therefore a safe unit source, but its name is current metadata,
not an immutable historical label. The existing definitions endpoint defaults
to active records. Archived metadata can remain locally after archive, while a
fresh list may omit the definition of a historical reading.

## Acceptance card

- User task: choose a biometric metric, enter a value with its unit visible, and
  understand saved readings without finding the metric definition elsewhere.
  Scope is native parity through existing data, with no conversion or advice.
- Metric choices show the current loaded name and exact canonical unit, keyed
  by definition ID. Distinguish same-name choices with different units. Show the
  selected metric/unit beside the exact-value field and in its accessible
  context. Manual custom metric definitions remain available.
- Saved readings join current loaded definitions by the event's exact
  definition ID. Preserve raw decimal strings, including zero, negative values
  and long precision; append the canonical unit without arithmetic, trimming,
  localization or unit inference. Keep existing date/time/source context and
  manual versus imported action availability. Retained archived definitions can
  supply units. Missing definitions explicitly mean metric/unit unavailable;
  never borrow the selected reading's metric, infer kg from a name, hide a raw
  reading or add a background lookup to fill the gap.
- Edit stays bound to `eventDraft.event.definitionId`. Disable metric chips
  during Edit, and prevent both selection and definition Use from retargeting
  the reading. A current-value functional updater may reject a replaced draft,
  an active edit and same-value changes; a retained pre-Edit action must not
  relabel the edited value. Definition Use must still perform its existing
  independent trend selection. Cancel/new reading restores normal selection.
- Preserve exact values and timestamp behavior, definition/event editing,
  pagination and unrelated custom-food/composer/filter/disclosure/log/trend work.
  Labels and ordinary selection cause no new read or write. Existing Create and
  revision request bodies, revision headers, operation identities, ambiguous
  retries, receipt handling and service validation remain unchanged.
- Scope: RetentionScreen and its existing actual-screen suite; this ADR/index,
  build plan and additive release gates (six source paths). A narrow roadmap
  cleanup marks the September 9 execution narrative historical and replaces
  stale statements that hydration time editing/M1F source work are unfinished.
  Keep dated automatic observations and all remaining acceptance gates explicit.
- Evidence: compact actual-component regressions for name/unit identity, long
  labels, exact values, renamed/archived/missing metadata and imported rows;
  selected/Edit/Cancel behavior and retained pre-Edit selection/Use; unchanged
  POST/PATCH body, original timestamp/revision and ambiguous retry identity.
  Existing relevant retention/parser regressions, affected types/format and
  early independent review. Freeze source before canonical check/build/license
  gates and fresh native tests/types/iOS/Android exports; record unchanged web
  cache reuse honestly. No browser surrogate is required for a native-only UI.
- Exclusions: new API/schema/helper file/dependency/storage/outbox, conversion,
  metric recommendation, history filters or reads, archived-definition fetching,
  generic private/read/mutation controller rewrite, web implementation, device
  exposure, signing, catalogue, hosting or release enablement.
- Stop: reviewed source and applicable local gates pass, normal commit/non-force
  push under standing authorization, exact automatic observation and compact
  readiness recorded. Mocked component output and source exports do not prove
  physical native layout, assistive technology, concurrent React, real
  persistence, independent Claude Code, hosted or release acceptance.

## Decision and consequences

Use the already parsed definition ID/unit relationship for presentation. Keep
an edited event's metric immutable in the UI, matching the existing revision
contract. Missing metadata stays explicit rather than becoming a guessed unit.
There is no nutrition or measurement calculation and no persistence change.

## Review triggers

Revisit before unit conversion, editable metric identity or canonical units,
historical definition snapshots, archived metadata retrieval, or history filters.


## Local evidence and limits (September 10, 2026)

Independent in-task acceptance and source reviews passed. Focused native actual-
component and related retention/parser checks passed 299
tests, with affected types, formatting and diff checks. Unit-qualified metric
choices/input/history preserve exact strings and current-name metadata. Missing
metadata stays unavailable. Current and retained selection/Use actions cannot
retarget an edited reading; Use retains its separate trend selection. Existing
POST/PATCH bodies, revision handling, exact untouched timestamps and ambiguous
retry identity remain unchanged.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed.
Native types, tests and builds were fresh: 1141 native tests plus
10 native runner checks and both iOS/Android exports.
Root policy passed 157 checks. Unchanged web 690 tests,
types and production build were reused from cache; this slice has no fresh web
or browser claim. License policy passed 535 production packages
with 14 reviewed exceptions. Unchanged package cache reuse
and 89 optional integration skips remain
explicit in raw readiness evidence.

The roadmap now labels its September 9 execution narrative historical and
corrects the obsolete hydration time-editor/M1F implementation status. Dated
automatic observations and all unresolved external acceptance gates remain.

Exact commands, UTC timestamps, versions, hashes, retained failures and delivery
state are recorded outside Git in Windows readiness. Actual-screen mocks verify
component behavior and accessible properties; exports verify source compilation.
Neither proves physical native layout, assistive technology, concurrent React,
real persistence, independent Claude Code, hosted or release acceptance. No
browser surrogate, device exposure, dependency install or release action was used.
