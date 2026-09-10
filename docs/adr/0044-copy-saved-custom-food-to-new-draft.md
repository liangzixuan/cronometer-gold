# ADR 0044: Copy a saved custom food to a new draft

Status: Source/local complete; synthetic Chrome QA passed; automatic, external reviewer, device and release acceptance separate.

## Context

Both Health clients can revise a saved custom food, but cannot use it as a new
private food while preserving the original. Existing saved-to-draft converters
and Create contracts already preserve editable fields and exact nutrient inputs.
Current Create retry keys are body-based, so a new copy needs a distinct creation
intent without changing retries within an existing intent.

## Acceptance card

- User task: choose Copy to new draft beside a loaded saved custom food, edit the
  new draft if desired, then explicitly Create a separate private food. Identify
  the saved source name/version. Copy itself makes no request or persisted write.
  The original saved food and pinned diary history remain unchanged.
- Exact copy: retain saved name (no automatic prefix/truncation), brand, notes,
  optional serving label/exact grams and source-ordered nutrient IDs, quantified
  decimal strings including zero, trace and all explicit unknown reasons. Preserve
  nutrients absent from the targetable picker. Clear only saved food ID/revision
  for creation; no inferred amounts, rounding, renaming or nutrition math. Web
  must visibly identify unavailable saved nutrient options from the saved snapshot
  without adding to the registry or changing the serialized request body.
- Unsaved work: blank/pristine or unchanged saved-revision editors copy directly.
  Any populated unsaved new draft, including an unchanged copied draft, needs an
  inline Keep editing / Discard draft and copy saved version choice before
  replacement. Compare raw editable values (including whitespace), not normalized
  bodies or saved provenance metadata. Native unappended nutrient composer input
  counts as unsaved work; the choice explicitly covers these inputs before reset.
  Keep editing preserves every field and operation. Accepted Copy installs the
  saved fields and resets native composer scratch through its existing mechanism.
- Confirmation identity: bind the choice to exact current saved object/version,
  raw draft/composer generation, private/profile context and lifecycle. Later
  edits (including edit/restore), Revise, Cancel, save attempt, replaced source,
  full refresh, closure/background/unmount or scope replacement cannot authorize
  another draft/source. Same-value field edits are harmless. Filter/disclosure
  changes do not mutate draft/copy generations; a filtered-out source may still
  be copied only while its exact saved object remains valid and identified.
- Draft and intent: each accepted Copy rotates a private in-memory creation
  intent. A cancelled/rejected choice, field edits, filter/paging, same-private
  profile refresh or background alone do not rotate it. Preserve body-keyed
  A-to-B-to-A retries and malformed/ambiguous receipt retries within that intent;
  a later accepted identical Copy must use a fresh Create operation identity.
  Create uses the existing POST with no original revision path or If-Match header.
  Do not clear unrelated operation history or modify update/log/outbox contracts.
- Pending work: block Copy and duplicate custom saves through a live custom-write
  owner, even if an unrelated action clears shared busy. Custom field/row/form/
  Revise/Cancel controls retained from an earlier draft cannot affect a later
  copy. Check current private/request/draft identity before custom receipt/JSON/
  unauthorized/error/finally UI effects; old receipts cannot clear a newer draft.
  Preserve valid same-private accepted write merging/cleanup after an independent
  list refresh; list/read freshness must not discard accepted write handling.
  A custom-only guarded request/receipt path is permitted where the existing web
  generic request cannot enforce this; leave the shared request helper unchanged.
- Independence: preserve loaded lists, saved-food name filter, nutrient disclosure
  state, pinned log draft/version/date/time/quantity, trends, biometrics, reminders,
  privacy work and unrelated busy/message ownership. Copy status uses its own
  identified context. Existing full-refresh/lifecycle disclosure behavior remains.
- Scope: HealthClient and existing state suite; RetentionScreen and existing
  custom-food actual-screen suite; this ADR/index, roadmap and additive release
  gates. Eight expected paths. No new helper file, API/schema/dependency/storage,
  outbox, archive behavior, bulk copy, history copy or automatic logging/write.
- Evidence: focused actual-component clean/dirty/Keep/Discard/stale-copy and field
  callbacks, exact saved fields/states/non-targetable IDs/decimal bounds, distinct
  Create vs revision, stable retries and new-copy intent, pending-write overlap,
  accepted receipt/list-refresh and private/lifecycle cases; affected types/format
  and early independent review. Freeze source before canonical check/build/license
  gates and fresh client outputs. Dedicated Chrome production Next/BFF synthetic
  proof covers dirty/cancel/confirm, filter/detail/log independence, exact copied
  values, explicit Create with a simulated lost receipt and identical body/key
  retry, distinct new record with original unchanged, keyboard/narrow and expiry.
  Synthetic writes are limited to disposable in-memory fixture foods.
- Stop: reviewed source, applicable local gates and synthetic browser proof pass,
  normal commit/non-force push under standing authorization, exact automatic
  observations and compact readiness recorded. Mocks/synthetic responses do not
  establish real persistence, concurrent React, physical native, assistive
  technology, independent Claude Code, hosted, signed-device or release acceptance.

## Decision and consequences

Reuse saved-to-draft conversion and explicit Create. Protect draft replacement
with a source-bound inline choice and keep creation intent independent from
view/read generations. No backend duplicate operation or nutrition conversion is
needed. The API remains authoritative for saved data and idempotency.

## Review triggers

Revisit before persistent drafts, bulk/history copy, copying unsaved edits,
changed creation intent or retry contracts, or offline custom-food creation.


## Local evidence and limits (2026-09-10)

Independent in-task acceptance and final source reviews passed. Focused actual-
component and related checks passed 81 web and
287 native tests; affected types, formatting and
diff checks passed. Copy preserves raw saved fields and nutrient states, protects
unsaved editor/composer work, and has a distinct creation intent with stable
retries. The web nutrient validator now accepts the existing contract's canonical
non-negative decimal bound, including `0.0000` and 200-character values; serving
validation remains unchanged. Accepted saves survive both response orderings of
an independent full-list refresh, while a higher already-listed revision remains
visible and successful receipt cleanup still completes.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed.
Both clients' types/tests/builds were fresh: 690 web,
1129 native plus 10 native runner checks,
both platform exports, and 157 root checks. License policy passed
535 production packages with 14 reviewed
exceptions. Unchanged package cache reuse and 89
optional integration skips remain explicit in the raw readiness evidence.

Production Next/BFF with a source-validated synthetic loopback upstream passed
the dedicated Chrome copy journey. Local Copy and dirty Keep/Discard controls
made no request. Exact saved fields, fallback nutrient identities and long decimal
strings reached explicit Create without an original-revision precondition. A
simulated interrupted receipt retried the same operation/body; a later accepted
identical Copy created a distinct memory-only record. The original stayed
unchanged. Filter/details and pinned-log work remained independent. Keyboard,
390-pixel layout and expiry closure were observed. Only owned QA processes and
the owned Chrome tab were closed; both loopback listeners were verified absent.

Exact commands, versions, timestamps, hashes, initial failures, raw fixture/access
logs, observations and delivery state are retained outside Git in Windows
readiness. Browser writes affect only disposable in-memory synthetic records;
they do not prove real persistence. Component harnesses do not establish
concurrent React, physical native or assistive technology. Independent Claude
Code, hosted, signed-device and release acceptance remain separate.
