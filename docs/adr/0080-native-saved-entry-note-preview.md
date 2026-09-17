# ADR 0080: Compact native saved diary entry-note previews

Status: Implemented at `28f6e4f`; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

The native diary renders the complete saved private note on every food and
recipe entry. Several long notes can dominate the daily list. ADR 0078 bounds
the separate standalone day note; entry notes need the same reading control.

## Decision and acceptance

Start each saved entry note with an exact prefix of at most 240 Unicode code
points and four explicit lines. Preserve whitespace and line separators, avoid
splitting a surrogate pair or CRLF, and append a display ellipsis only when text
is shortened. Short notes retain their complete display; null notes remain absent.

Each shortened note has Show full note and Show less controls. Full view displays
every saved character. Visible text and accessibility text reflect the same
collapsed or expanded view; controls identify the entry by name, portion and time
and expose expanded state. This is source accessibility support, not evidence
that a physical screen reader has accepted the flow.

Keep expansion independent per exact saved entry snapshot and private scope.
Reset it on snapshot replacement and date/private/lifecycle changes; reject
retained controls after their view has changed. Pagination and meal collapse must
not allow an old callback to reveal a different entry or retired snapshot.
Expanding or collapsing alone performs no request or mutation.

Reuse the existing day-note prefix rule without changing saved data. Editing
still receives the exact full note; save, clear, repeat, pending operations,
protected outbox, nutrition totals and provenance keep their existing contracts.

## Consequences, alternatives and review triggers

Always showing full text avoids a control but lets long notes overwhelm the list.
Native visual line clipping alone cannot provide the same exact text boundary
for accessibility labels. An explicit prefix and expansion preserve full access
while keeping the initial view bounded; actual wrapping depends on device/font.

The state is ephemeral and native-only. This adds no persistence, web behavior,
API/schema, dependency or release change. It does not establish physical-device,
assistive-technology or cross-client acceptance. Revisit when entry snapshot
identity, lifecycle, note limits or display rules change. Formal release gates
remain unchanged.

## Validation

Demonstrate the long-note regression before the fix, then exercise exact short,
null, long, emoji and mixed-newline text; independent entry expansion; snapshot,
date, private-scope and lifecycle resets; stale callbacks; and absence of network
or write effects. Preserve the editor, repeat, pagination and outbox assertions.
Pass focused native tests, types/format, independent in-task review, canonical
check/build and exact-commit automatic checks. Record cached and skipped results
separately from fresh execution in the dated readiness evidence.

## Delivery evidence

Delivered at `28f6e4f10fbcbbb5253fec1b069e6a132ff47773`. All 23 new
regressions failed on original source before the focused suite passed 120/120.
Independent native/documentation review and types/format passed. September 17
canonical check passed 1,768 fresh cases, replayed 2,327 cached passes and
93 cached opt-in skips; build passed eleven tasks, ten cached, with fresh native
exports. No dependency, installation, audit or paid review was needed.

[CI 35187106773](https://github.com/liangzixuan/cronometer-gold/actions/runs/35187106773)
and [container 35187106789](https://github.com/liangzixuan/cronometer-gold/actions/runs/35187106789)
passed all three/nine actual jobs on attempt one. The final web job completed
September 17 at 07:15:27 UTC; the 07:25:20 observation retained each outcome.
At 07:25:41, local/tracking/live heads matched with a clean tree and all nine
committed file hashes matching the reviewed freeze. These results apply to this
commit; device, assistive and release acceptance remain separate.
