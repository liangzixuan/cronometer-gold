# ADR 0073: Find nutrient rows in native drafts

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

Drafts can contain 256 nutrient rows. The existing name query filters the Add
picker, while finding a current row to Edit or Remove still requires scrolling.

- User task: filter current native draft rows with a separate name-or-exact-ID
  query and Clear. Preserve the raw query within 200 characters, trim only for
  matching, use literal case-insensitive current loaded-name substring matching
  or exact string ID equality, and retain source row order. Whitespace-only query
  shows all rows; numeric IDs must never be converted or matched by numeric prefix.
  Missing metadata still supports exact ID matching with existing fallback labels.
- Use existing inputs/layouts and truthful matched/total, no-match, empty-draft
  and invalid/duplicate-text recovery states. Invalid text must not report a
  guessed total or offer row actions. Current metadata refresh updates matching
  and labels without changing the query or canonical draft.
- Filtering and Clear affect only local list visibility. Preserve canonical bytes,
  every other food field, Add-picker query, composer entry/acknowledgement, active
  Edit/Apply target and exact explicit Save/retry. A filtered-out active row remains
  editable in the composer. Query-only changes must not make Apply or Save stale,
  allocate operations, issue requests, enqueue work, auto-select rows, replace a
  draft or invalidate an unrelated pending Copy/Revise choice.
- Give the filter its own state/ref identity. Search/Clear and row Edit/Remove
  callbacks must reject stale filter identity after query changes and restoration;
  do not add this visibility guard to Apply/Save. Keep current draft/composer/
  metadata/private/lifecycle/loading/write guards. Reset the filter on deliberate
  draft reset/replacement and private-scope reset; preserve it during current
  food/raw-row edits and metadata refresh. Same raw query is a no-op; Clear removes
  whitespace too. Hidden private scope must not display old query or row matches.
- Scope: RetentionScreen.tsx and its existing component suite, this ADR/index,
  build plan and additive release gates (six files). The canonical helper and
  helper tests stay unchanged. No web, API, schema, persistence, dependency,
  shared-style, full-registry, browser/service/device/cloud change.
- Evidence: compact component cases for exact ID/name/order/counts, duplicate
  names and literal query characters, fallback/metadata refresh, whitespace/bounds/
  no-match/empty/invalid recovery, hidden active Edit/Apply and exact Save/retry,
  independent composer query/raw preservation, query ABA/retained row actions and
  private/reset/write boundaries. Extend existing cases where useful. Focused
  component plus unchanged helper tests, native types/format and independent source
  review precede frozen canonical check/build/licenses and both native exports,
  followed by final staged review. Do not repeat broad gates while agents edit.
- Stop after source/local gates, authorized normal commit/non-force push, exact
  automatic observation and dated readiness. Native synchronous hook/host tests
  and exports do not establish every concurrent React interleaving, device layout,
  assistive behavior, real persistence/protected storage, external Claude Code,
  hosted or release acceptance. No successor implementation in this slice.

## Decision and consequences

Keep draft-row search independent of the Add composer and canonical draft. Only
visible row actions depend on the filter receipt; Save and an already active edit
retain their original draft authority. This makes long drafts easier to navigate
without turning a view preference into a data edit. Revisit when row identity,
metadata ownership, private reset or composer/save semantics change.

## Local evidence and limits (2026-09-14)

Native draft rows now have their own local query and Clear. Matching uses current
names literally/case-insensitively or exact string IDs, retaining source order and
truthful matched totals and invalid/empty/no-match recovery. Missing metadata keeps
ID matching available. The Add-picker query remains separate.

Filtering preserves canonical bytes, food fields, composer acknowledgement and
active Edit/Apply even for a hidden row. Filter receipt guards protect retained
query and row actions across query restoration; Apply/Save and pending Copy/Revise
choices retain their existing authority. Deliberate draft/private resets clear
the query, while ordinary edits and metadata refresh preserve it. Canonical helper
and tests remain unchanged; no local requests, operations or queue were added.
Focused component/helper checks, native types/format and independent source review
passed before canonical validation.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1515 native tests plus 10 runner checks, 1008 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Native hook/host and export proof does not
establish rendered-device or assistive behavior, every concurrent React interleaving,
real persistence/protected storage, external Claude Code, hosted or release
acceptance. No browser or service was used for this native-only behavior change.
