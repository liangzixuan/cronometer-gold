# ADR 0043: Filter loaded saved custom foods by name

Status: Source/local complete; synthetic Chrome QA passed; automatic, external reviewer, device and release acceptance separate.

## Context

Web and native Health currently render every loaded saved custom-food card.
A local name filter can reduce scanning while preserving saved nutrient details,
draft editing, pinned logging and the existing paged collection. API list pages
currently request active records only; archived records may remain in client
state after an archive. Loaded records are not an archived-library search.

## Acceptance card

- User task: find a loaded saved custom food by part of its name, inspect a match,
  clear the filter or explicitly load more, while preserving current editing and
  logging work. Both clients have a visible labeled field and explicit Clear.
- Matching: retain raw text up to 200 characters; use trimmed, case-insensitive
  literal name substring matching. Blank/whitespace shows all loaded records.
  Preserve source order, exact IDs and duplicate names. No sorting, fuzzy/accent
  matching, automatic selection, request or form submission from Filter/Clear.
- Collection: derive only visible saved cards from the full loaded array. Show
  matched and loaded counts, no-match and truthful first-page verification.
  Unverified empty arrays or null cursors must not imply an empty/complete listing;
  a manual accepted save after failed initial loading does not verify the list.
  Distinguish loading/unavailable, verified empty and no matches. Keep Load more
  and recovery controls reachable at zero matches. Failed continuation retains
  rows/query/cursor; overlap deduplicates with existing semantics; an empty terminal
  page retains accumulated rows. Say when more records may be available or no more
  remain in this listing, without claiming remote or archived-library coverage.
- Independence: do not mutate backing lists, disclosure state or editor/composer/
  log/trend/biometric/reminder fields, selected food/version, pending operation
  bodies/keys, nutrition values, shared busy/message state or read generations.
  Hiding a card hides its details visually; Clear restores its prior disclosure
  state. The existing full-refresh disclosure reset remains unchanged. Local
  filtering remains usable during same-private reads/writes where scope is valid.
- Scope: own synchronous filter value/generation guards reject retained field/
  Clear callbacks after a newer filter edit, private owner/session/API/profile
  replacement, closure, hidden/background lifecycle or unmount. Same-value edits
  and empty Clear are harmless no-ops. Hide/reset private query and old rows before
  replacement-scope effects install; closure resets the query. Background hides
  query and rows and invalidates retained callbacks, but returning to the same
  private/profile scope may restore the query. Retain query across same-private paging,
  full refresh, errors, retries and accepted writes. A refreshed session object
  alone must not erase the query for the same private owner/profile context.
  Collection verification must follow successful current list installation;
  do not repurpose mutation/read guards to discard valid accepted write cleanup.
- Accessibility: clear visible labels, live matched/loaded feedback, keyboard
  operation and usable 390-pixel web layout. Filtering does not steal focus or
  hide paging, recovery, the separate editor or log form. Long and duplicate saved
  names and expanded exact nutrient details remain readable.
- Source: HealthClient and existing state suite; RetentionScreen and existing
  actual-screen custom-food suite; this ADR/index, roadmap and additive release
  gates. No new helper, endpoint, schema, dependency, storage, outbox, archive
  semantics, refresh control or nutrition calculation. Eight expected paths.
- Evidence: actual-component matching/bounds/no-op/stale/duplicate/order/count/
  first-page-failure/verified-empty/paging-overlap/terminal/refresh/lifecycle cases,
  preserved disclosures/drafts/trends and exact operation retry identity, affected
  types/format and early independent review. Freeze integrated source before
  canonical check/build/licenses and fresh client outputs. Use production Next/
  BFF with a source-validated synthetic loopback fixture in dedicated Chrome for
  no-request filtering, hidden/open details and dirty draft restoration, explicit
  zero-match paging/failure/retry, keyboard/narrow and session-expiry closure.
  Browser domain writes are unnecessary; operation identity uses component proof.
- Stop: independent source/evidence review and applicable local gates pass, normal
  commit/non-force push under standing authorization, exact automatic observation
  and compact Windows readiness recorded. Synthetic/mocked proof does not close
  real persistence, concurrent React, physical native, assistive technology,
  independent Claude Code, hosted, signed-device or release acceptance.

## Decision and consequences

Keep local query state independent and derive only the visible cards. Explicit
counts and pagination explain the boundary of the currently loaded listing.
Existing food editing, logging, disclosure and mutation authority remain intact.

## Review triggers

Revisit before remote search, archived-library browsing, sorting/ranking, saved
preferences, changed pagination contracts or automatic selection/logging.


## Local evidence and limits (2026-09-10)

Independent in-task acceptance and final source reviews passed. Focused actual-
component and related checks passed 62 web and
246 native tests; affected types, formatting and
diff checks passed. Filtering derives visible cards without changing the stored
collection or operation identity. Initial-list verification is separate from
manually accepted saved records, and same-private paging/refresh retains query.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed.
Both clients' types/tests/builds were fresh: 671 web,
1088 native plus 10 native runner checks,
both platform exports, and 157 root checks. License policy passed
535 production packages with 14 reviewed
exceptions. Unchanged package cache reuse and 89
optional integration skips remain explicit in the raw readiness evidence.

Production Next/BFF with a source-parsed synthetic loopback upstream passed the
dedicated Chrome filtering journey. Local filter/Clear made no request; duplicate
names, loaded counts, hidden/open details and dirty editor/log values survived.
Zero-match paging, failure/retry, overlap dedup and the empty terminal page kept
collection meaning and explicit controls. Keyboard, 390-pixel layout, long exact
nutrient details and session-expiry closure were observed. No domain writes were
made by the browser. Only owned QA processes and the owned Chrome tab were closed,
and both loopback listeners were verified absent.

Exact commands, versions, timestamps, hashes, initial failures, raw fixture/access
logs, observations and delivery state are retained outside Git in Windows
readiness. Browser data is synthetic; operation/retry/lifecycle proof uses the
component harness. Neither proves real persistence, concurrent React, physical
native, assistive technology, independent Claude Code, hosted or release acceptance.
