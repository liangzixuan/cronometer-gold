# ADR 0079: Protect native recipe drafts during replacement

Status: Implemented at `bacc261`; local and exact-commit automatic evidence passed; device/release acceptance separate.

## Context

The native recipe workspace lets a person edit a new or saved recipe, but New
recipe and saved-card opening can replace that builder without confirming the
loss of unsaved edits. A revision conflict also automatically opens current
server values, overwriting the rejected draft. Copying a saved recipe already
has an explicit discard choice; ordinary replacement needs equivalent care.

## Decision and acceptance

Compare the exact editable builder content with its saved baseline or the empty
new-recipe baseline. New recipe and saved-card opening require an inline Keep
editing / explicit discard choice when that content is dirty. A pristine
builder keeps the direct action. Keep editing does not fetch, save or reset the
builder, selected nutrition, ingredient state or diary-log draft.

An accepted discard may start a blank builder or load the selected saved recipe.
Opening a prompt alone performs neither action. Choices belong to the current
builder, target, private scope and lifecycle; duplicate and retained callbacks
must not replace subsequent work. In-flight saves and logs cannot be aborted by
New recipe. Preserve existing owner checks and stale-response rejection.

A 412 save conflict retains the complete rejected builder and explains that the
saved recipe changed. It must not automatically replace the builder or change
its expected revision. The person may explicitly choose to discard edits and
open saved values. This slice adds no automatic merge, rebase, force-save or
server-write authority. Ambiguous-save retries retain their existing exact
payload and operation identity; opening/declining a prompt changes no write.

## Alternatives, limits and review triggers

Unconditional replacement is simpler but loses edits. Always prompting adds
friction for pristine drafts. A visible inline choice uses existing component
state and can reject stale actions without asynchronous platform-dialog state.

This is a native builder correction. It protects accepted builder content;
unconfirmed scratch inside the separate pasted-ingredient review is not part of
that content. It does not add persistence, protect every app-level navigation or
unmount, or change the web client, API/schema, nutrition math, ingredient
provenance or dependency graph. Existing saved-copy and diary
logging behavior remain in force. Revisit when builder fields, request ownership,
recipe revision semantics or navigation lifecycle change.

## Validation

Demonstrate the draft-loss regression on pre-fix source, then pass component
tests for pristine/dirty New and Open, Keep/discard, stale choices, conflict
preservation, failed loads and in-flight writes. Retain exact retry and existing
copy/log assertions. Complete native types/format, independent in-task review,
canonical check/build and exact-commit automatic checks. Record cache/skip
boundaries. Component/export proof does not establish physical-device or
assistive acceptance; formal reviewer and release gates remain unchanged.

## Delivery evidence

Delivered as `bacc261b0b61bf61f74e7aa14daba09fa9201510`. Focused native tests
passed 207/207 after eight initial regressions were demonstrated on pre-fix
source. Independent code/documentation review, native types/format and canonical
gates passed. September 17 local check recorded 1,745 fresh passes, 2,327 cached
passes and 93 cached opt-in skips; build passed eleven tasks with ten cached and
fresh Android/iOS exports. These results do not rerun prior service/device work.

[CI 35180214548](https://github.com/liangzixuan/cronometer-gold/actions/runs/35180214548)
and [container 35180214556](https://github.com/liangzixuan/cronometer-gold/actions/runs/35180214556)
passed all three and nine actual jobs on attempt one. The September 17 05:33 UTC
observation records every job; the last container job completed at 05:26:51 UTC.
The successor preflight confirmed clean, equal local/tracking/live heads. These
results apply to this commit and do not establish release acceptance.
