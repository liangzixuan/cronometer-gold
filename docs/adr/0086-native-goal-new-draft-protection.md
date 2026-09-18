# ADR 0086: Native goal New-draft protection

Status: Implemented at 053afe0; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

Start a new goal currently replaces an edited saved goal immediately. The
existing Copy saved goal action asks before discarding edits, but ADR 0060
explicitly excluded general New behavior. Protecting this reset prevents
accidental draft loss without changing goal publication or nutrition policy.

## Decision and acceptance

An unchanged loaded saved goal can start a new blank draft immediately. When
its goal builder has unsaved changes, Start a new goal first offers Keep editing
or Discard edits and start a new goal. Keep preserves exact raw goal fields and
retry state. Explicit discard uses the existing empty draft for the selected
valid progress date; creating or publishing a goal remains a separate action.
Neither opening nor resolving the choice sends a goal request or allocates a
write operation.

Compare the complete loaded builder after applied-reference construction,
bound to its saved goal, load generation, progress date and private/profile
context. This baseline is independent of Copy's fixed-manual-goal eligibility:
manual, derived and applied-reference goals retain their existing semantics.
Exact builder changes, including raw values, trigger confirmation; reverting to
the loaded builder restores the immediate path. Nutrient-search and separate
profile birth/sex drafts are not goal edits and remain preserved.

Reuse the existing synchronous builder and replacement-choice lifecycle. Only
one choice is actionable. Edits and replacement choices invalidate old callbacks
synchronously. Reject retained New/Keep/Discard callbacks after draft changes,
loads, context/date changes, active goal/profile/candidate requests, private
closure or unmount. Expose disabled action state accessibly. New must not become
dependent on the narrower CopySource when an effective-date edit retires it.

## Consequences, alternatives and review triggers

Edited saved goals require an explicit discard before a blank draft replaces
them. Unchanged goals retain one-action New. A navigation-wide draft manager or
confirmation for every pristine reset would expand this slice unnecessarily.
The loaded baseline extends existing state guards; it is not a general offline
or navigation persistence mechanism. Revisit when builder fields, reference
materialization, load identity or replacement actions change.

No web/App/API/schema/outbox/dependency change, refresh/conflict redesign,
clinical behavior, automatic target defaults or release enablement is included.
No installation, production audit, paid review, browser/service/device/cloud
or workflow action is required. Component/export proof does not establish
concurrent React, physical-device, assistive or release acceptance.

## Validation

Use the existing actual-screen goal harness for pristine/edited/reverted saved
goals, exact raw Keep behavior, explicit discard, unchanged retry identity and
manual/derived/reference boundaries. Cover overlapping choices and stale
callbacks across edits, load, date/private/profile changes and active requests.
Update prior unconditional-New expectations to require explicit discard.
Record new regressions failing before implementation and passing afterward.
Run focused goal/reference tests, native types/format and independent review,
then frozen canonical pnpm check/build. Record fresh/cached/skipped evidence,
normal commit/push and the exact commit's three CI/nine actual container outcomes
outside Git. Formal device and release acceptance remain separate.


Development evidence on September 18, 2026: baseline 74 cases passed. The screen
suite added 22 cases and adapted two prior immediate-reset expectations; pre-fix
execution recorded 21 failures and 51 passes. After implementation, 95 cases
passed and one assertion incorrectly inspected Text children for a TextInput
value. Correcting that assertion produced 96 passing focused cases (72 screen,
17 goal helpers, seven reference helpers), no skips. Native types/format and
independent source/documentation review passed. The synchronous hook harness
does not establish concurrent React or physical-device behavior. Final canonical
and exact-commit automatic outcomes are recorded below and outside Git.


## Delivery evidence

Delivered at `053afe02096dd39723af35e3f32a68c93e9730d2`. Canonical pnpm check
passed 1,882 fresh tests, with 2,327 cached passes and 93 cached opt-in skips.
Build passed 11 tasks, ten cached; Android/iOS exports were fresh. The first
canonical attempt found eight test callback-return lint errors; corrected loop
bodies passed scoped Biome check and all 96 focused cases before final validation.
Application source was unchanged by that correction; the failure remains recorded.

All three actual jobs in [CI 35320683018](https://github.com/liangzixuan/cronometer-gold/actions/runs/35320683018)
and all nine actual jobs in [container 35320683031](https://github.com/liangzixuan/cronometer-gold/actions/runs/35320683031)
passed on attempt one. The final web job completed September 18, 2026 at
09:06:23 UTC. The 09:07:32 UTC observation verified complete actual job inventories
and success; clean matching local/tracking/live heads and all seven frozen
committed files were reverified at 09:10:22 UTC. Evidence is scoped to this
commit; device and release acceptance remain separate.
