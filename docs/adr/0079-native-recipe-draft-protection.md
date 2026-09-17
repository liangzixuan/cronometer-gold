# ADR 0079: Protect native recipe drafts during replacement

Status: Accepted; source validation recorded in current readiness.

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
