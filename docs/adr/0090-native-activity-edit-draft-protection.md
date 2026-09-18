# ADR 0090: Protect native activity edits during local navigation

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

The native activity history lets a person correct a saved entry's name, duration,
optional self-reported calories, local start date and time. Opening another row,
Cancel and day navigation currently replace or clear that editor immediately.
Unsaved corrections can disappear before the person chooses to save.
The independent Add form already protects replacement through Use details;
that protection does not cover the saved-entry editor.

## Decision and acceptance

Compare all five exact raw editable strings with the original saved-entry draft.
Whitespace and invalid partial input count as edits; restoring the original
strings makes the draft pristine. Pristine Cancel, row replacement and day
navigation retain their direct behavior.

When those actions would replace a dirty editor, show an inline Keep editing
and explicit discard choice. Cover opening another row, Cancel, Previous/Next,
Jump to today and a committed valid different date. Opening or keeping the
choice does not fetch, write, allocate an operation ID, switch the selected day
or replace the draft. Keep restores the selected-day input after deferred typed
navigation. Accepted discard applies only the captured local action and never
saves or deletes an activity. Invalid dates and unchanged-day blur must not
discard edits or leave the controls unusable.

Bind choices to the current editor, source/target day, entry, private scope and
action generation. Reject retained or duplicate decisions after edits, another
choice, replacement, reload, a mutation, backgrounding or unmount. Respect
existing in-flight request exclusion and private-session closure. Hide the prompt
before replacement-scope effects run; scroll to its measured anchor and announce
the choice when requested from the lower editor controls. Preserve the
independent Add draft, reuse behavior, saved-entry revision and exact ambiguous
mutation retry body/key/revision. Existing day reload retains the edit draft;
it does not implicitly rebase it onto newer saved values.

## Consequences, alternatives and review triggers

Local navigation can no longer silently discard accepted editor fields. Always
prompting adds friction to pristine editors; unconditional replacement loses
work. The inline choice follows existing native draft-protection patterns and
can reject obsolete callbacks without asynchronous platform-dialog state.

This slice changes only the native screen and its behavioral tests. It adds no
API/schema, dependency, nutrition calculation, earned-calorie adjustment or
outbox behavior. It does not persist drafts, protect app-level navigation or
OS termination, redesign revision-conflict recovery, or change intentional
private-scope cleanup. Revisit when editor fields, day navigation, revision
identity or request/lifecycle ownership change.

## Validation

Use actual-screen regressions for all five dirty fields, clean/reverted drafts,
Keep/discard across each transition, typed-date recovery, invalid/same-date input,
stale/duplicate/pre-render callbacks, lifecycle and private guards, in-flight
writes, same-day reload and unchanged exact mutation retries. Demonstrate relevant
failures on original source, then pass focused activity screen/helper suites,
native types and scoped Biome. Independently review source and prose before
canonical pnpm check and pnpm build on frozen final source. Record all three CI
and nine actual container jobs at the successor commit separately.

Hook-harness and export evidence do not establish concurrent React, signed-device,
assistive-technology, hosted or release acceptance. No dependency installation,
production audit, paid external review, service/browser/device or cloud action is
part of this slice; existing formal gates remain unchanged.

Development evidence on September 18, 2026: 23 new regressions failed on original
source while seven preservation cases passed (56 existing cases deliberately
filtered). Independent review found and corrected pre-effect prompt visibility
and offscreen-choice presentation; six review regressions failed before those
corrections. Final focused validation passed 111 cases (95 screen, 16 helper),
zero skips, plus native types and scoped Biome. Independent source review found
no open issue. Final canonical and exact-commit automatic results remain pending
in the dated outside-Git readiness record.
