# ADR 0074: Prevent duplicate native nutrient choices

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context and acceptance card

The native Add picker offers nutrient IDs already present in the draft. A user can
select one and enter a value before Add rejects the duplicate, leaving unfinished
input that blocks Save. Web already prevents duplicate choices under ADR 0068.

- User task: recognize represented nutrient IDs before choosing or adding a new
  row. Keep current loaded names, units, order and literal name filtering; annotate
  and disable occupied alternatives. Counts distinguish loaded matches from unused
  loaded IDs. Duplicate names remain independent by exact string ID.
- Derive occupancy only from the existing full canonical parser. Empty draft has
  no occupied IDs; invalid or duplicate text has unknown occupancy, disables new
  selection/Add and gives manual recovery without guessed counts or silent repair.
  Removing a valid row releases only its exact ID. Metadata absence/refresh retains
  existing current-registry authority and cannot enable an unloaded ID.
- Retain selected occupied IDs after Add/Apply or manual text changes, exact raw
  amount/state/reason, both filters, food fields and acknowledged post-Add state.
  Same-ID selection and rejected occupied/unloaded/invalid transitions are no-ops
  before composer/status/Copy-choice mutation. Never auto-clear or choose another
  ID. Explain recovery through Clear nutrient entry and Edit of the existing row,
  choosing an unused nutrient, or fixing manual text as appropriate.
- Disable Add and reject its direct/retained callback unless the current draft
  parses and the selected current loaded ID is unrepresented. Keep the full append
  helper authoritative. Reuse current private/draft/composer/metadata/lifecycle/
  loading/write guards; old callbacks must not revive after intervening changes.
  New availability guards apply only to new nutrient choice/Add, never Apply or
  Save. Preserve active fixed-row Edit/Apply, explicit Save/retry, pending choices,
  row filtering and local operation/queue behavior.
- Scope: RetentionScreen.tsx, its component suite, this ADR/index, build plan and
  additive release gates (six files). Optional per-item disabled support in the
  screen-local ChipRow is allowed; existing callers retain their behavior. No new
  state/controller, canonical helper/test, web/API/schema/persistence/dependency,
  shared-style, registry expansion, browser/service/device/cloud change.
- Evidence: compact actual-component cases cover occupied/unused/matching counts,
  exact IDs with shared names, invalid/empty/manual recovery, removal/reselection,
  retained raw choice and acknowledged Add, stale/private/metadata/write guards,
  active editing, and exact Save/retry with no local requests or operations.
  Adapt existing duplicate-selection fixtures to preserve their original purpose.
  Focused component and unchanged helper tests, native types/format and independent
  source review precede frozen canonical check/build/licenses and both native
  exports, followed by final staged review. Do not run broad gates during edits.
- Stop after source/local gates, authorized normal commit/non-force push, exact
  automatic observation and dated readiness. Native synchronous hook/host tests
  and exports do not prove every concurrent React interleaving, device layout,
  assistive behavior, real persistence/protected storage, external Claude Code,
  hosted or release acceptance. No successor implementation in this slice.

## Decision, alternatives and consequences

Reuse the parsed draft and current registry to guard new choices and Add before
mutation, retaining occupied selections as context for current work. Deferring
every duplicate to Add leaves avoidable unfinished input; automatically replacing
the selection would lose intent. The parser and Save validation remain unchanged.
Revisit when row identity, metadata ownership, canonical parsing or composer/save
semantics change.

## Local evidence and limits (2026-09-14)

The native Add picker now annotates and disables occupied exact IDs while retaining
loaded names, units, order and name filtering. Counts distinguish loaded matches
from unused IDs. The full parser determines occupancy; invalid text has manual
recovery without guessed IDs, and removing a row releases only its exact ID.

New selection and Add reject occupied/unloaded/invalid choices before mutation.
Retained current choice, exact amount/state/reason, both filters and acknowledged
post-Add state stay intact, including same-ID no-ops. Fixed-row Apply, Save/retry,
private/draft/metadata authority, canonical helpers and local operations remain
unchanged. Screen-local per-item disabled support preserves existing callers.
Focused component/helper checks, native types/format and independent source review
passed before canonical validation.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1519 native tests plus 10 runner checks, 1008 web and
157 root checks, both native exports and production Next; zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Native hook/host and export proof does not
establish rendered-device or assistive behavior, every concurrent React interleaving,
real persistence/protected storage, external Claude Code, hosted or release
acceptance. No browser or service was used for this native-only behavior change.
