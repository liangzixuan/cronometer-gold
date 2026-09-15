# ADR 0075: Preserve web Diary Repeat retries across clock changes

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer and release acceptance remain separate.

## Context and acceptance card

Repeat currently computes a new current minute and request body on every click.
Its operation key contains the body. An ambiguous result followed by a retry after
a minute or local midnight can therefore create a new operation despite the UI
promising the same request. Existing immediate-retry coverage does not advance time.

- User task: retry an unresolved Repeat without accidentally creating another
  entry. First record a deterministic failing baseline at minute and profile-local
  midnight boundaries before editing production source.
- Retain one exact unresolved request per source entry in the current private
  owner: serialized body, target day, URL/source date, source revision, expected
  time zone and idempotency key. Stable identity must not include a newly computed
  clock value or turn a fresh same-owner source/profile reload into a new intent.
  Different source entries keep independent requests; no request is auto-replayed.
- Transport failures, non-definitive HTTP errors and malformed/mismatched success
  receipts retain the envelope. Only a verified matching receipt, the existing
  explicit DIARY_TIME_ZONE_CHANGED 409 or 412 recovery, or private close/unmount
  retires it. A generic 409 is not proof of non-acceptance. Retire verified success
  before follow-up reads so failed readback cannot recreate the accepted Repeat.
  Identity-check retirement so late old responses cannot erase a newer intent.
- A deliberate Repeat after verified completion gets a new current timestamp and
  operation ID. Reuse all existing receipt validation/server contracts and definitive
  conflict recovery. Preserve original expected zone/revision on unresolved retry;
  let the server's accepted replay and precondition handling remain authoritative.
- Reject stale/private/closed/loading/active-mutation invocations before request or
  allocation, using current view/page/session/source ownership. Preserve existing
  supported Repeat after meal collapse and retry across implicit-today midnight;
  presentation-only collapse and a changed clock must not invalidate the intent.
  Do not alter other mutation helpers or general navigation/private behavior.
- Scope: DiaryClient.tsx and DiaryClient.state.test.ts, this ADR/index, build plan
  and additive release gates (six files). One local in-memory retry map is allowed;
  no helper/backend/native/schema/persistence/dependency or release change. No
  storage, cloud, workflow controls, real-user writes or live catalogue actions.
- Evidence: baseline failure, compact clock-controlled ambiguous retry identity,
  success then new deliberate intent, independent entries, exact receipt validation,
  definitive versus generic conflicts, fresh same-owner reload and retained private
  callbacks. Focused actual-component and unchanged diary helper tests, web types/
  format and independent source review precede frozen canonical check/build/license
  gates. Production Next/BFF with a validated loopback synthetic upstream and a
  dedicated Chrome session must verify delayed retry accounting, verified success,
  ordinary subsequent Repeat, visible recovery and expiry with owned cleanup.
- Stop after local gates, final staged review, authorized normal commit/non-force
  push, exact automatic observation and dated readiness. Synthetic component/BFF/
  browser proof is not real persistence, every concurrent React interleaving,
  physical device, assistive technology, external Claude Code, hosted or release
  acceptance. No successor implementation in this slice.

## Decision, alternatives and consequences

Keep the complete first request for an unresolved intent instead of caching only
an ID derived from a changing body. Freezing the global clock or reusing one ID with
new bytes would hide the issue or violate idempotency. The request is memory-only
and does not promise recovery across reload or remount. Revisit when Repeat identity,
private ownership, definitive conflict or server replay semantics change.

## Local evidence and limits (2026-09-15)

Clock-controlled regressions reproduced changed request bytes and operation IDs
at minute and Chicago-midnight boundaries on the unchanged source. The fix keeps
one unresolved envelope per private owner/source entry, including original body,
URL, revision, expected zone and operation ID. Ambiguous errors and fresh same-owner
reloads preserve it; validated success or existing definitive conflicts retire only
that captured request. A subsequent deliberate Repeat creates a new operation.

Current callback/private/view and response ownership are checked separately,
preserving supported meal collapse and midnight retry. Verified success releases
the intent before readback. Helper/server contracts and other mutations remain
unchanged. Focused component/helper checks, web types/format and independent source
review passed before frozen canonical validation.

Frozen `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1019 web tests, 1519 native tests plus 10 runner checks and
157 root checks; production Next and both native exports passed with zero cached tasks.
Licenses: 535 packages/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Production Next/BFF dedicated Chrome proof used a parser-validated loopback
synthetic upstream. An accepted Repeat with an ambiguous response was retried after
a real minute boundary with identical upstream bytes/preconditions/key and one
created result; a later deliberate Repeat created a distinct operation/result.
Visible recovery, expiry and owned tab/process cleanup passed. BFF request mapping
limits are recorded separately from component proof of the original browser URL.

Commands, UTC, versions, source/build hashes, reviews and automatic observations
are in Windows readiness outside Git. Synthetic component/BFF/browser proof does
not establish real persistence, every concurrent React interleaving, physical
device, assistive technology, external Claude Code, hosted or release acceptance.
The retry envelope is memory-only; reload/remount recovery is outside this slice.
