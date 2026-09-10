# ADR 0032: Copy a saved recipe to a new draft

Status: Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending.

## Context

Both recipe clients can start a blank recipe or revise an existing one. A person
needs to make a variation while preserving the original. Existing saved-to-builder
converters and authenticated create routes support a separate draft without new
API, schema or nutrition calculations.

## Acceptance card

- User task: copy the selected saved recipe version into a separate new private
  draft on web and mobile, edit it and create a distinct recipe.
- Observable result: `Copy to new draft` identifies the saved name/version being
  copied. Preserve editable name, description, instructions, notes, yield source,
  exact yield/serving values and pinned ingredient versions. Existing converters
  preserve food portions and nested-recipe resolved grams; no inferred amounts.
  Keep the original name editable instead of silently truncating a copy prefix.
- Unsaved edits: clean editors copy immediately. Dirty editors first show an
  inline choice to keep editing or discard edits and copy the saved version.
  The confirmation is tied to that selection and exact draft generation; later
  edits, selection changes, New, save, session/lifecycle changes and retained
  callbacks cannot confirm a different draft. Cancellation preserves every field.
- Draft boundary: clear original recipe ID/revision, saved nutrition and logging
  selection; reset raw ingredient-review/search state. Copy is an in-memory
  transition with no request or write. The original remains unchanged. The new
  recipe only persists through the existing explicit Create recipe action.
- Mutation boundary: the copy has its own creation intent and retry identity;
  it cannot replay an unresolved create from an earlier draft. Retain exact
  body/key retries within the new draft, block copy during an active save/log,
  and reject delayed original receipts or controls after transition.
- Affected surfaces: two recipe clients, their existing actual-component tests,
  ADR/roadmap/release evidence. No API/schema/dependency or persistence changes.
- Exclusions: copying unsaved edits, duplicating history or diary entries, bulk
  operations, offline recipe creation, automatic names/nutrition, catalogue,
  cloud, phone exposure and release enablement.
- Required evidence: actual-component clean/dirty/cancel/stale copy journeys,
  precise public/private food and nested-version/quantity preservation, distinct
  create payload with no original identity/precondition, independent retry
  identity, and owner/session/lifecycle guards; independent in-task review;
  canonical `pnpm check`, `pnpm build`, dependency/config/license gates and native
  exports; synthetic production web/BFF Chrome copy/edit/create and narrow-layout
  QA with fixture limits recorded separately.
- Stop condition: reviewed source, applicable local gates passed, normal
  commit/push under standing authorization, exact automatic states recorded.
  Physical native/assistive-technology, independent Claude Code, hosted,
  catalogue and release acceptance remain separate.

## Decision

Reuse the existing saved-to-builder conversion and create route. Place copying
beside the selected saved recipe, identify its saved source, and keep the new
builder independent from saved nutrition and diary logging. Require an explicit
in-product discard decision only when copying would replace unsaved fields.
Give new copied drafts their own creation intent while preserving retry semantics.

## Consequences

Recipe variations need no original revision mutation. An explicit discard choice
protects work without adding a persisted draft or private browser storage. The
existing save endpoint remains authoritative for ownership, provenance, limits,
rights and calculations. Source tests and synthetic BFF responses cannot prove
real database persistence, native rendering or release acceptance.

## Alternatives

Copying the dirty editor would blur saved-version provenance. Editing the original
would not preserve its current recipe identity. Disabling copying whenever dirty
would require leaving the flow to recover the saved values; a scoped inline choice
is clearer. Adding a backend duplicate endpoint adds no required capability here.

## Source validation

The September 10, 2026 UTC checkpoint passed independent in-task review and
canonical `pnpm check`, `pnpm build` and `pnpm licenses:check`. Fresh runs include
455 web tests, 658 mobile tests plus 10 runner tests, and 157 root policy tests.
The type and test graphs each passed 17/17 tasks with 15 valid cache replays;
build passed 11/11 with 9 cached tasks and fresh production web, iOS and Android
outputs. License policy covered 535 production packages and 14 reviewed exceptions.
Unchanged service skips/cache replay do not establish fresh integration health.

Focused component regressions cover public/private foods, nested recipes, exact
pins/portions, clean and dirty copying, cancellation, stale callbacks, busy and
private lifecycle boundaries, independent creation intent and exact-body retries.
Review additionally closed stale original field/form/log handlers, invalidated
mobile late log-receipt UI observation without cancelling its durable queue, and
kept web dirty comparison on raw editable request fields rather than metadata.

Synthetic production Next/BFF QA in dedicated Chrome verified keyboard keep-editing,
discard-and-copy, clean immediate copying, saved-field preservation and hidden
saved nutrition/logging in the new draft. Explicit Create received a simulated
lost receipt; retry used the same body/key and confirmed exactly one independent
recipe while the original stayed unchanged. Copy itself sent no recipe write.
The confirmation wrapped at a 390 px viewport without page overflow; session
expiry closed the draft and returned to login. Owned browser/server cleanup was
verified. This fixture is not real API/database persistence, physical native,
assistive-technology, independent Claude Code or release acceptance.

## Review triggers

Revisit before copying history, unsaved edits, diary entries, persisted drafts,
bulk duplication, new portion conversions, or changing create/retry contracts.
