# ADR 0078: Compact native saved day-note previews

Status: Implemented at b9a081c; local and exact-commit automatic evidence passed.
Device, accessibility and release acceptance remain separate.

## Context

A valid saved day note can contain 2,000 Unicode scalar values and many line
breaks. The native diary currently renders all of it before the food controls.
Long notes can therefore dominate routine food logging. The web editor already
has a bounded textarea; this slice addresses the native saved-text presentation.

## Decision and acceptance

Show an exact prefix of a long saved note, bounded to 240 Unicode scalar values
and four explicit text lines. Recognize CRLF, CR, LF and Unicode line/paragraph
separators without normalizing stored text. Mark an excerpt and offer Show full
note / Show less only when text was actually shortened. Keep short, absent and
cleared states unchanged. This is a text bound, not a fixed device line count;
wrapping, font scale and native accessibility rendering remain device evidence.

Expansion is a local viewing choice for the current owner/session/date/saved
revision. A replacement cannot inherit another note's expansion, and retained
callbacks must respect current private, view and lifecycle authority before
changing the display. The control exposes button role and expanded state.

Expansion/collapse issues no request and changes no model, draft, conflict,
receipt, retry envelope, nutrition state or persistence. Full exact saved text
remains available through expansion and editing. Draft inputs and conflict
comparison text retain their existing complete text and behavior.

## Alternatives and consequences

Rendering every saved note keeps a simple UI but allows excessive scrolling.
Unconditional line clipping can hide text without a usable expansion control;
layout-event heuristics introduce platform-dependent clipping decisions. A
bounded Unicode-safe prefix is deterministic and independently testable, though
its rendered height still varies with wrapping and text size.

No endpoint, schema, shared contract, dependency, offline storage or persistence
change is included. Revisit if note limits, saved-note identity, client lifecycle,
or editing/reconciliation behavior change. Existing signed-device, privacy,
accessibility and release gates remain authoritative.

## Validation

Actual-component tests cover Unicode and line boundaries, unchanged short/empty
states, exact full text, request-free expand/collapse, saved-note replacement and
stale/private/date callbacks, and unchanged raw editing and retry behavior. Run
focused tests, relevant native types/format, independent in-task review, final
canonical check/build with native exports, and exact-commit automatic checks.
Record fresh/cached/skipped evidence separately in dated readiness. Component
harnesses and exports do not establish physical-device or assistive behavior.

## Delivered evidence

Commit `b9a081c9b9a20a646832adb93942aeb5a4d33ada` passed 39 focused component
cases, native types/format and canonical check/build. September 17 local check
recorded 1,734 fresh passes, 2,327 cached passes and 93 cached opt-in skips;
native iOS/Android exports ran fresh in an 11-task build with ten cached tasks.
[CI 35172357843](https://github.com/liangzixuan/cronometer-gold/actions/runs/35172357843)
and [container 35172357822](https://github.com/liangzixuan/cronometer-gold/actions/runs/35172357822)
passed all three/nine actual jobs on attempt one, verified at 03:36:02 UTC.
These results cover that commit and preserve the device/release limits above.
