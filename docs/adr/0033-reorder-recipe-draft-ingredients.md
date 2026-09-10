# ADR 0033: Reorder ingredients in a recipe draft

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Both recipe builders preserve ingredient order through existing create/revision
requests, but the editor only exposes quantity, note and removal controls. A
person assembling a recipe needs to arrange its ingredients without deleting and
re-adding exact saved food or nested-recipe versions.

## Acceptance card

- User task: move an ingredient up or down in a new or saved recipe draft on web
  and mobile, then explicitly create or publish the revised order.
- Observable result: each ingredient row has labelled Move up and Move down
  buttons with its name and position in the accessible label. Boundary moves are
  disabled; empty and single-ingredient lists remain valid. Buttons support
  ordinary keyboard/touch interaction and fit narrow web layouts.
- Data boundary: swap existing ingredient objects by stable client identity,
  preserving public/private food and nested recipe version pins, exact grams or
  serving amounts, notes, attribution and all other recipe fields. Repeated
  ingredients must remain distinct. Existing adapters generate contiguous request
  positions from final array order. No automatic quantity or nutrition changes.
- Draft boundary: moves are local until explicit Create/Publish; saved recipe
  nutrition, logging version and original history remain unchanged. Reordering
  marks a saved editor dirty and invalidates a pending copy-discard confirmation.
  Restoring the original editable order can return the editor to clean state.
- Interaction boundary: preserve owner/session/lifecycle and busy guards. A
  retained move, quantity, note or removal callback from a previous draft/order
  cannot operate on a different ingredient or later selection. Recheck membership
  and boundaries at the action; preserve exact-body/key retries after a failed
  save and distinct intent for later changed orders under existing save rules.
- Affected files: web/mobile recipe components and actual-component regression
  tests, this ADR, its index, roadmap and release-gate documentation.
- Exclusions: drag-and-drop, persisted draft storage, offline recipe writes,
  bulk sorting, API/schema/dependency/calculation changes, catalogue, phone
  exposure, infrastructure and release enablement.
- Required evidence: component move/boundary/duplicate/pin/portion/dirty/copy/
  stale/busy/lifecycle/create/revision/retry regressions; independent in-task
  review; canonical check/build/license gates with fresh client/native outputs;
  synthetic production Next/BFF Chrome keyboard, narrow layout, local-only move,
  explicit save and readback. Record fixture limits separately from real API,
  database, physical native and assistive-technology acceptance.
- Stop condition: reviewed source and applicable local gates pass, normal
  commit/non-force push under standing authorization, exact automatic run states
  and a compact continuation checkpoint recorded. Independent Claude Code and
  all external/device/release gates remain separate.

## Decision

Add bounded adjacent move buttons within the existing ingredient rows. Keep the
existing array as the draft ordering authority and use current create/revision
contracts for persistence. Guard moves by the current draft and ingredient
identity, and invalidate copy-discard choices through the existing draft update.

## Consequences

Ingredient order becomes editable without reconstructing provenance or amounts.
The interface needs no new backend contract or gesture library. Local moves do
not alter the saved recipe or diary history. Source tests and a synthetic browser
fixture do not establish native device, real database or release acceptance.

## Alternatives

Drag-and-drop introduces gesture and accessibility work beyond this bounded
change. Remove-and-readd loses editable details and invites quantity mistakes.
Automatic sorting cannot express a person's intended preparation order.

## Source validation

The September 10, 2026 UTC checkpoint passed independent in-task review, canonical
`pnpm check`, `pnpm build` and `pnpm licenses:check`. Fresh execution includes
473 web tests, 680 mobile tests plus 10 runner tests, and 157 root policy tests.
Type and test graphs each passed 17/17 with 15 cached; build passed 11/11 with 9
cached and fresh production web, iOS and Android outputs. License policy covered
535 production packages and 14 reviewed exceptions. Unchanged opt-in service
skips and cache replay do not establish fresh integration health.

Focused component regressions cover empty/single/boundary lists, mixed exact
public/private food and nested pins/portions/notes, duplicate ingredient versions,
create/revision positions, dirty/copy confirmation invalidation, move-and-restore
stale controls, busy/private lifecycle fences and order-specific save retries.
Web uses current draft generation for retained field actions; native also tracks
ingredient membership/order so same-order field updates can preserve each other.

Synthetic production Next/BFF Chrome QA verified keyboard moves, boundary button
states, exact notes/quantities staying with reordered rows, a long ingredient name
and wrapped controls at 390 px, and no recipe writes before explicit saving.
Create returned one independent recipe in the requested order. Revision simulated
an accepted write with a lost receipt; exact-body/key retry confirmed one new
revision, preserving the original saved version. Saved nutrition/logging stayed
on the saved version while reordering; another move invalidated a pending
copy-discard choice. Revision readback and expired-session closure passed.
These checks do not establish real API/database persistence, physical native,
assistive-technology, independent Claude Code or release acceptance.

## Review triggers

Revisit before drag-and-drop, bulk sorting, persisted/offline drafts, order-aware
nutrition calculations, or changing recipe version and save/retry contracts.
