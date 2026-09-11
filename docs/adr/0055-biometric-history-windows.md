# ADR 0055: Navigate earlier biometric history windows

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the Nourishing roadmap. Both Health clients currently
load a recent range and expose continuation only inside that range. Expose bounded
Earlier window, Newer window, Recent history and Reload history controls using
the existing authenticated biometric events endpoint.

## Acceptance card

- Capture one recent anchor per private scope, preserving the baseline bounds of
  now minus 120 days through now plus one day. Each window spans exactly 121
  elapsed days. Earlier/Newer shift by that width; Recent returns to the captured
  recent window and Newer cannot go beyond it. Both API endpoints are inclusive;
  adjacent windows share an exact boundary. Label exact UTC endpoints, inclusion,
  loaded count and whether more rows remain, separately from each reading's saved
  local date/time/zone. Do not claim an immutable or globally complete history.
- Retain limit 100 and existing event/cursor parsing. Never round or subtract a
  millisecond from boundaries. Disable a direction if a full target window would
  escape 0100-01-02T00:00:00.000Z through 9999-12-30T23:59:59.999Z. These deliberately
  conservative UI bounds respect existing four-digit local-date parsing and zone
  offsets; this slice does not change parsers or promise ancient-date support.
- Use a history-only request and installed range/cursor identity. Navigation and
  explicit Reload replace rows; continuation captures the exact installed range
  and cursor and merges overlapping IDs in server order. Empty windows remain
  navigable. A transient/malformed page failure retains rows and cursor for retry;
  continuation 400 drops the cursor and requires explicit Reload history. No
  automatic restart. Never display retained old rows under a new range label.
- Reject duplicate requests and obsolete fetch, JSON, status, 401, error and
  finalizer effects using current history, private owner/profile and lifecycle
  identity. Same-owner full Retry/Refresh preserves the selected exact range and
  invalidates pending history reads; private replacement resets the recent anchor.
  History movement must not invoke full initialization or change trends, custom
  food filters/composers/disclosures, reminders, pinned logs or their pending keys.
- Preserve raw biometric editor fields, original timestamp precision, exact
  unresolved retry body/key and ordinary accepted cleanup across history movement.
  Serialize history reads with biometric save/delete using a live event-operation
  guard independent of shared busy state. Preserve valid accepted receipt cleanup
  through unrelated read/lifecycle changes. Install/remove an accepted reading by
  membership in the current inclusive range. Retained old-row Edit/Delete controls
  require exact current row and range before draft, confirmation or request effects.
- Scope: HealthClient.tsx and its existing state suite, RetentionScreen.tsx and
  scripts/custom-food-nutrient-composer.test.mjs, this ADR/index, build plan and
  additive release gates (eight paths). No shared helper, API, parser, database,
  dependency, outbox or general request/controller changes.
- Require focused actual-component/helper regressions, affected types/format and
  independent source review. Cover exact ranges and boundaries, continuation and
  failures, empty windows, stale responses/controls/private transitions, dirty
  editor and independent inputs, exact retries and read/write receipt ordering.
  Freeze source before fresh canonical check/build/licenses and client outputs.
- Source-validated synthetic production Next/BFF dedicated-Chrome QA must reach
  earlier readings, continue and retry a page, recover an invalid cursor through
  explicit Reload, return to Recent and preserve a dirty biometric edit and trend
  inputs. Verify no domain writes, keyboard/narrow layout and session expiry.
  Keep all 15 core nutrient definitions, normal auth/session guards, source
  checkpoints, private evidence and verified owned-process/tab cleanup.
- Stop condition: reviewed local source and required evidence, normal commit and
  non-force push under standing authorization, exact automatic observation and
  template-based readiness checkpoint. Real persistence, physical native and
  protected storage, assistive technology, concurrent React, external Claude Code,
  hosted and release acceptance remain separate.

## Consequences and alternatives

Explicit fixed windows make older records reachable through the existing bounded
endpoint without coupling history to trend inputs. Shared inclusive boundaries
can repeat a reading across adjacent windows and avoid gaps at database microsecond
precision. Enlarging the global range or automatic scrolling would obscure range
and request ownership. Changing date parsers is outside this bounded slice.

## Review triggers

Revisit when range/cursor contracts, timestamp parsing, event mutation receipts,
private ownership, lifecycle or history/trend initialization changes. Preserve all
existing review, validation, privacy and release gates.

## Local evidence and limits (UTC 2026-09-11T06:42:54.120246+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 840 web tests, 1301 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Source-validated synthetic production Next/BFF in dedicated Chrome verified the
corrected initial recovery: an invalidated history load exposed an unverified
range with enabled Reload; keyboard Reload returned two recent readings. Earlier
loaded 100 readings in the adjacent inclusive range. A 503 preserved rows/cursor;
explicit retry used the identical query and cursor and merged one overlap plus two
new readings into 102. An empty terminal page removed continuation. A further empty
window remained navigable, and Newer restored the prior exact range. Cursor 400
kept 100 rows and required explicit Reload without automatic restart; Reload
restored the same range without a cursor. Recent returned to the captured range.
The dirty manual edit retained exact value 71.23456700, date, time and metric;
trend dates, custom-food name and reminder draft stayed unchanged. All 43 upstream
requests contained zero domain writes; after draft setup, history actions requested
only event pages and owner revalidation. Keyboard and 390px layout checks passed
with client/scroll widths both 375px. Expired Reload returned to sign-in and removed
private controls. The owned Chrome tab was closed, viewport reset and both verified
processes stopped normally; ports 3008/4008 were absent.

The first browser attempt exposed disabled initial-history recovery despite all
19 fixture requests succeeding. Its logs, old source review and canonical pass
remain preserved. The correction added five asynchronous initial/full-load
regressions and received fresh review, canonical gates and the successful repeat
journey above. This is synthetic browser/BFF evidence; real persistence, physical
native/protected storage, assistive technology, concurrent React, external Claude
Code, hosted and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
