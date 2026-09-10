# ADR 0030: Review pasted ingredient lines in the mobile recipe builder

- Status: Source complete and local gates passed; delivery, automatic and release evidence pending
- Date: 2026-09-09
- Scope: M4B mobile new-recipe review, preserving M4A semantics

## Context

M4A lets a web user turn pasted ingredient lines into explicitly reviewed,
version-pinned recipe ingredients. The mobile builder has the same recipe and
portion contracts but no pasted-list review. Its asynchronous open/save behavior
must not replace a newer draft while review is in progress.

## Decision

Add an in-memory native review panel only to the new-recipe builder. Reuse the
unchanged M4A line parser and bounds through the existing contracts workspace:
50 nonblank lines, 500 characters per original line, 25,050 total characters.
Retain exact original text, order and duplicates, and reject excess without
truncation. Preserve the web helper exports and behavior when extracting this
shared parser. The shared module is a pure local-input utility, not a new API.

Start each line unresolved. Require a separately submitted search query, an
existing public food version and an explicitly entered positive exact decimal in
grams or a positive gram-resolved serving. Display source attribution. Do not
infer identities, nutrition, units, conversions, 100 grams or one serving from
pasted text. Reopening a line invalidates its earlier confirmation.

Require confirmation of every line and one explicit final transfer. Revalidate
the account, then append to the latest new-recipe draft, checking the combined
50-ingredient bound again. Consume the review generation once. Preserve all
current fields, prior ingredients, yield and serving configuration. Cancellation
changes none of the recipe draft.

Keep raw lines separate from notes, save payloads, search queries, URLs, logs and
storage. Only an explicit query reaches public search; credentials reach the
configured private API only. Clear review on cancel, success, owner/API/credential
scope replacement, session closure, unmount and app background/inactive events.
Returning to the foreground must not restore discarded private review text.

Fence search, authentication, private loads and save receipts across every await,
including JSON parsing, with mounted/session/request and relevant generation
identity. A retained handler cannot append into a replaced builder, install old
private data or close a newer session. Disable unavailable native controls and
expose their state and meaningful labels to accessibility services.

Preserve existing stable save-body/idempotency-key semantics through retryable
network, authorization-service or receipt failures. A 401 or proven owner mismatch
closes private state; a retryable 503 does not mean the owner changed. Aborting a
request is not evidence that the server did not write. The existing protected
recipe-logging outbox remains authoritative; this adds no offline recipe editing.

## Acceptance

- Shared parser behavior and its original test cases remain unchanged; web helper
  compatibility and exact portion construction continue to pass.
- Native helper tests cover explicit exact amounts, gram/serving boundaries,
  provenance, distinct line identities and rejection of unresolved/capacity errors.
- Tests call the actual panel and screen callbacks/effects using deterministic
  native host mocks. Cover delayed fetch/JSON, owner/token/API changes, disabled
  state, unmount, effect replay, app lifecycle, cancel/reopen, latest-draft edits,
  capacity changes, duplicate transfer and stable save replay after retryable
  failures. Prove raw text is absent from outgoing payloads and automatic queries.
- Applicable types, lint, dependency/config/license checks, canonical check/build
  and Expo exports pass. Record executed/cached/skipped work and exact source.
- Keep native rendering, keyboard/screen-reader, signed physical-device,
  cross-client and hosted acceptance separate from mocked callbacks and exports.

## Boundaries and consequences

No new external dependency, API/schema, server entity, source acquisition, URL
fetch, automatic food creation, nutrition inference, AI service, photo/voice input,
sharing, background write or paid capability is introduced. No EAS/signing,
phone exposure, hosted rollout or workflow dispatch follows from this ADR.

M4A automatic evidence and M3B print follow-up remain separate. The user approved
M4A source delivery and the next mobile source step; this sequencing does not waive
independent Claude Code, catalogue, privacy, device or release gates. The build
plan's implemented/source/local/automatic/release vocabulary remains unchanged.

## Local evidence (2026-09-10 UTC)

Independent in-task review findings are resolved. Canonical `pnpm check` passed:
157 root policy tests, 75 contracts tests, 428 web tests and 625 mobile tests plus
10 native runner tests. Native review coverage includes 43 actual-screen lifecycle
cases, 31 actual-panel cases and 33 exact-quantity cases. The nine unchanged parser
cases moved from web to contracts. Type and test graphs passed 17/17 tasks (11 and
12 cached respectively); database/service opt-in skips remain explicit in the
outside-Git readiness record and do not establish fresh service integration.

`pnpm build` passed 11/11 tasks (7 cached), with fresh iOS and Android Expo exports.
Dependency/native configuration, formatting, boundaries and license policy passed
(535 production packages, 14 existing reviewed exceptions). All 16 changed/new
files retained their captured bytes throughout the final run. Only these status
paragraphs changed afterward; diff, references and application fingerprints were
checked before delivery. No dependency, API/schema or outbox implementation changed.
Local production audit, physical/native rendering, keyboard/screen-reader, hosted,
independent Claude Code and release gates remain separate. No M4B push or automatic
result is claimed by this local checkpoint.
