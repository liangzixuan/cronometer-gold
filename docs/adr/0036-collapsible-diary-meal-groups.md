# ADR 0036: Collapse diary meal groups

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Diary views show every loaded entry across four owner-labelled meal groups.
A person reviewing a long day cannot temporarily hide a meal they have finished
reviewing. Stable meal slots already identify these groups independently of their
labels and order. Presentation controls can reduce scrolling without changing
the diary, its exact whole-day totals, or coherent page loading.

## Acceptance card

- User task: temporarily collapse and reopen individual diary meal groups on
  web and mobile while reviewing the selected day.
- Observable result: groups start expanded. Each group offers an explicit,
  meaningfully labelled expand/collapse control, using stable meal-slot identity
  rather than label or position. Keep the meal heading and Add food reachable.
  Collapsing hides only the group's loaded-entry content; reopening restores it.
- Meaning: keep the whole-day loaded/total-entry count, exact nutrition totals,
  page loading/retry controls and status available. Do not present hidden entries
  as absent or infer full-meal counts from the currently loaded page. Preserve
  the distinction between no entries and no entries loaded for this meal yet.
- State: keep collapse choices in memory within the current owner/session/date.
  Reset on date/session replacement; label or display-order changes cannot move
  a collapse choice to another stable meal. Same-day coherent page loads retain
  choices. No local storage, profile writes or retained entity is introduced.
- Work in progress: an active editor or pending mutation must remain visible.
  Disable collapse while busy or force the affected group open, including native
  protected-queue states as appropriate, without changing queue persistence,
  retry, acknowledgement, ordering or correction behavior. Closing a group cannot
  silently discard a draft. Existing queue controls remain reachable outside it.
- Coherence: reject stale retained toggle actions after date/session/owner or
  relevant lifecycle changes; honor current private/loading/error scope. Toggling
  must not initiate requests or domain writes, alter entry order/quantities/notes,
  reload overview cards or disturb exact totals. Preserve all existing guards.
- Accessibility: real buttons with meaningful group names, expanded/disabled
  states, web keyboard activation and visible focus; headings and Add food remain
  usable at 390 px with long custom labels. Hidden entry controls are not keyboard
  or accessibility targets. Preserve native accessibility semantics.
- Affected source: diary components and focused actual-component regressions;
  existing web styles only if necessary; this ADR/index, roadmap and release gates.
- Exclusions: API/schema/dependency/nutrition math, persisted collapse preferences,
  bulk collapse controls, new meal subtotals/count calculations, diary mutations,
  protected outbox changes, real service/device/hosted/catalogue/release enablement.
- Required evidence: default and independent toggles; stable identities under
  labels/order; date/session/stale/lifecycle resets; editor/busy protections;
  totals, paging and missingness preservation; no toggle requests/writes;
  actual-component web/native tests and types; independent in-task review;
  canonical check/build/license gates and native exports; source-validated
  synthetic production Next/BFF Chrome narrow/keyboard/paging/editor/date QA.
- Stop condition: reviewed source and applicable local gates pass; commit and
  non-force push under standing authorization; record exact automatic results and
  a compact continuation. Real persistence, physical native, assistive-technology,
  independent Claude Code and release acceptance remain separate.

## Decision

Add default-expanded in-memory meal presentation controls to existing diary
readers. Bind choices to stable meal identity and private selected-day scope,
without changing the authoritative day snapshot or pagination.

## Alternatives

Persisted profile preferences add cross-client and retained-state behavior that
is unnecessary for this review task. Removing entries from the underlying diary
view model could corrupt totals or pagination, so visibility is applied only to
rendered meal content. Automatic collapse could hide work without user intent.

## Consequences

People can focus on one meal while the whole-day evidence remains available.
Choices reset on a new day or session. Busy/editor protections may temporarily
keep a meal expanded. Source and synthetic proof do not establish signed-device,
real persistence or release acceptance.

## Source validation

Independent in-task review cleared the frozen components and all five app/test
fingerprints. Fresh focused checks passed: 80 web tests (23 actual-component
plus 57 existing diary/proxy/group/overview tests) and 31 mobile tests (29 collapse
plus two existing summary tests), with types, Biome and diff checks. Early review
resolved same-paint editor/write/request fencing, visible paging-disabled state,
native route-prop replacement before effects, and pending-queue hold transitions.
Invalid synthetic cursors/nutrient fixtures and selector/type corrections remain
recorded separately; no parser or authority gate was weakened.

Canonical local checks passed on September 10, 2026 UTC: `pnpm check`,
`pnpm build` and `pnpm licenses:check`. Fresh tests include 569 web, 781 mobile
plus 10 runner tests, and 157 root policy tests. Type/test graphs each passed
17/17 with 15 cached; build passed 11/11 with nine cached and fresh production
web, Android and iOS exports. License policy covered 535 production packages
and 14 reviewed exceptions. Cached service tasks and opt-in skips are inherited
results, not fresh database/API or real persistence evidence.

Synthetic production Next/BFF Chrome QA passed against strict source-validated
three-day fixtures with all 15 core nutrients and reconciled whole-day totals.
On a 20-of-24 page, breakfast and lunch collapsed independently; hidden entry
controls left the keyboard sequence, Add food remained reachable, and Return
activated the next meal toggle. A long label and controls wrapped at 390 px with
visible keyboard focus. Dinner's no-entries-loaded wording remained while its
empty loaded group was collapsed. One synthetic page failure kept choices and
totals intact; retry merged all 24 entries, preserving collapse, and reopening
dinner revealed the four additional entries. Snacks then correctly said No entries.

An active dinner editor disabled its collapse, preserved an exact quantity and
note draft while another group toggled, and Cancel restored the original entry.
Changing to a short day reset groups to expanded; a truly empty day retained its
existing guidance, and returning to Today reset choices again. Session expiry
cleared private content and returned to sign-in. The explicit dinner toggle made
no upstream request; all browser actions made no domain writes. The temporary
viewport and owned Chrome tab were cleared, both verified loopback processes
stopped gracefully and their listeners disappeared. No Codex closure occurred.

These bounded source/synthetic checks do not replace actual persistence,
physical native, assistive-technology, independent Claude Code or release gates.

## Review triggers

Revisit before persisted preferences, bulk group actions, group subtotals,
different paging contracts or changes to protected diary operation handling.
