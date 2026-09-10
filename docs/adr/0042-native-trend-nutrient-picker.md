# ADR 0042: Select every loaded nutrient for native Health trends

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context

The native Health trend chips use `nutrients.slice(0, 24)`, while the existing
targetable parser accepts up to 256 unique nutrient IDs. Web already exposes the
whole loaded list with names and units. A valid later native nutrient is therefore
unreachable. This is a source/contract gap, not evidence of current live catalogue
breadth; the targetable list is still not the complete nutrient registry.

## Acceptance card

- User task: find and choose any loaded targetable nutrient, then explicitly load
  its existing local-day trend. Native choices retain source order and distinct
  IDs, display names and units, and include every loaded item up to 256.
- Local filtering: separate name filter, at most 200 characters, with trimmed
  case-insensitive literal substring matching and explicit Clear. Filtering/Clear
  never chooses a nutrient, loads data, changes dates or changes a result. Show
  matched/loaded counts, truthful no-match, verified-empty and unavailable states.
  Keep the selected nutrient name/unit visible when the filter hides its choice.
  Same-value edits and selections are usable no-ops. Use accessible labels,
  selected/disabled states and existing native wrapping layout primitives.
- Selection/results: choosing a different nutrient is local and clears only its
  prior nutrient result. Date changes clear both trend results; biometric changes
  clear only the biometric result. Filter-only changes preserve a current pending
  request and existing result. Label loaded results from parsed response identity,
  name/unit, range and time zone; do not relabel old values as a newly chosen series.
  Preserve exact zero, trace/partial/unknown/missing labels and existing nutrition
  math and service date-range behavior. No new estimates, rounding or advice.
- Refresh: invalidate old picker and Load controls synchronously when full private
  refresh starts. A failed refresh leaves metadata unavailable, retaining existing
  Refresh/error guidance. On successful same-scope refresh retain the filter and
  selected ID if it is still present; if removed, clear that choice rather than
  silently substituting another. The first successful installation may retain the
  existing first-item default. An installed empty nutrient list still permits
  existing biometric-only loading when its selected definition is valid.
- Current scope: separate trend/filter/input generations bind retained callbacks
  and pending reads to the current owner/session/token/API, profile time zone,
  mounted/foreground lifecycle, installed registry and exact captured selection,
  date and biometric inputs. Reject stale before-effects callbacks, edit/restore
  cycles, duplicate before-paint Load, replacement lists, background/unmount and
  obsolete response/JSON/401/finally paths. Hide obsolete trend values before scope
  effects install. Filter/choice actions never advance custom-editor generations
  or close saved-food disclosures. Pending unrelated work does not itself prevent
  a current local picker action.
- Bounded loading seam: use a scoped read path for the existing paired nutrient/
  biometric GETs so current-request checks happen before private installation or
  unauthorized handling. Require returned nutrient ID/unit and nonnull aggregate
  IDs/units to match the captured choice, plus exact from/to/timeZone; require the
  paired biometric definition ID and range/zone to match its initiator. Abort
  obsolete reads; only the owning trend read may release its busy state or publish
  status. Do not alter the shared mutation request helper, body/key protocols,
  custom/composer/log/reminder/health/privacy operations, outbox or storage.
  Participating metric-list updates must retain accepted same-owner write cleanup
  and functional merges after another metric receipt or same-owner full refresh;
  trend metadata eligibility must not discard an already accepted write. Reject
  old private-owner/session receipts independently of list freshness.
- Independence: preserve other draft fields, selected biometric/date fields during
  filter/nutrient actions, saved-food disclosures, custom uncertainty/retry body
  and key, and unrelated shared busy/message state. Necessary participating date/
  biometric callback guards must not expand into unrelated workflow refactors.
- Affected source: RetentionScreen and its existing actual-screen component suite;
  this ADR/index, roadmap and additive release gates. No new production helper,
  endpoint/schema/dependency, web, App routing, storage, outbox or math change.
- Evidence: actual-screen tests for 31/256 rows, duplicate names/distinct IDs and
  units, last-item exact GET, literal/trim/case/bounds/Clear/no-match/empty behavior,
  no-request filter/choice actions, selected/result identity and draft/operation
  independence. Test wrong response metadata and late read/JSON/401/finally,
  private/input/refresh/foreground/unmount/replay controls. Affected mobile types/
  format and independent review precede frozen canonical check/build/license gates
  and fresh native exports. Native-only scope needs no web/browser surrogate.
- Stop: reviewed source and applicable local gates pass, normal commit/non-force
  push under standing authorization, exact automatic observation and compact
  readiness recorded. Mocks/exports do not prove concurrent React, rendered-device
  layout, assistive technology, real persistence, external Claude Code, hosted,
  signed-device or release acceptance.

## Decision and consequences

Expose the complete loaded choice list through a local name filter and preserve
explicit trend loading. Bind the participating read/result seam to its exact
current inputs. The registry's existing availability and completeness limits stay
honest; no additional catalogue acquisition or backend capability is implied.

## Review triggers

Revisit before remote nutrient search, new catalogue coverage, saved picker
preferences, automatic loading, cross-series calculations or changed trend contracts.

## Local evidence and limits (2026-09-10)

Independent in-task acceptance and final source reviews passed. The native picker
exposes the whole installed targetable list through local name filtering, keeps
selection visible, and labels response results by their captured series/range/zone.
The scoped paired read rejects wrong metadata and obsolete private/input responses
without changing the shared mutation helper or unrelated operation protocols.

Focused native verification passed 220 tests, including actual
RetentionScreen behavior and the relevant compatibility checks; affected types,
formatting and diff checks passed. Frozen canonical `pnpm check`, `pnpm build`
and `pnpm licenses:check` passed. Native tests/types/builds were fresh:
1062 native tests plus 10 export-runner checks,
both platform exports, 157 root tests, and 535 production
packages with 14 reviewed exceptions. Unchanged web
655 results and builds were cached. Unchanged optional integration
cases skipped in the cached graph total 89.

Actual-screen fixtures cover all 256 choices, duplicate names and units,
literal filtering and no-request local actions, explicit last-item loading,
response/aggregate identity, empty and removed choices, stale callbacks and late
fetch/JSON/401/finally behavior. They preserve other drafts, saved-food disclosures
and existing uncertainty/retry body/key behavior. No browser surrogate or local
service was used for this native-only slice. Raw commands, versions, timestamps,
hashes, failures, cached/skipped counts and review evidence remain outside Git in
the Windows readiness handoff.

Synthetic hook/host tests and native exports do not prove concurrent React,
rendered-device layout, assistive technology, real persistence, independent
Claude Code, hosted, signed-device or release acceptance.
