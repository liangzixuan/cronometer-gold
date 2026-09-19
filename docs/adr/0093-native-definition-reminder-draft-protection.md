# ADR 0093: Protect native definition and reminder drafts

Status: Source complete and reviewed; final canonical and exact-commit automatic evidence pending.

## Context

The native metric-definition and reminder editors immediately replace unsaved
fields when the person revises another saved item or cancels an edit. A definition
save also clears the form after its response, even if newer input was entered
while the request was pending. These are related losses of in-memory draft work;
addressing both editors together completes one coherent metadata-editing slice.

## Decision and acceptance

Keep an exact baseline for new and saved definition/reminder drafts. Compare raw
fields, including partial or invalid input. Dirty Revise/Edit and Cancel offer
reachable, announced Keep editing and action-specific discard choices. Pristine
or fully reverted drafts transition directly. Keep preserves every field, original
identity/revision and retry operation. Discard executes only the captured current
replacement once; neither choice saves data or requests notification access.

Bind choices to the current draft, target and private/profile/lifecycle context.
Retire obsolete decisions safely when their inputs or scope change. Retained,
repeated or pre-render callbacks cannot replace newer work. Accepted definition
receipts still merge into current metadata, but may clear only the submitted
draft. Newer typing and existing concurrent archive/receipt behavior survive.

Preserve immutable saved metric units, exact mutation retries, private-state
cleanup, reminder consent/permission requests, scheduling and revocation policy.
Keep the definition and reminder editors independent of each other and of other
private forms on the screen.

## Consequences, alternatives and review triggers

The draft stays in memory until accepted save of that draft, explicit replacement
or existing private-scope cleanup. Prompting for pristine changes adds friction;
silently replacing dirty fields loses work. Existing inline native choices make
the decision explicit without a new API or persistent draft store.

This protects the two editors' local replacement and definition receipt cleanup.
It does not add cross-screen navigation, OS-termination, offline persistence,
revision-conflict recovery, notification policy or device acceptance. No API,
schema, dependency, service, browser or device changes are needed. Revisit if
editable fields, identity/revision, request ownership or lifecycle rules change.

## Validation

Demonstrate the loss paths on original source, then verify exact raw fields and
revision/retry identity through Keep; pristine/reverted transitions; one-time
discard; changed targets and stale callbacks; and lifecycle/private/request
boundaries. Verify delayed definition receipts retain newer input and concurrent
archive behavior. Choices must have no permission or scheduling side effects.

Run the actual-screen behavioral harness, affected native types and scoped Biome.
Independently review the final source and documentation, freeze the seven files,
then run canonical `pnpm check` and `pnpm build`. Record all three actual CI and
nine actual container jobs at this exact commit. Predecessor success does not
transfer. Hook-harness and export proof do not establish concurrent React,
physical-device, assistive-technology, hosted or release acceptance; those formal
gates remain separate.


Development evidence on September 19, 2026: eight loss-path regressions failed
on original source. Final focused validation passed 528 cases in three files:
515 actual-screen cases, including 28 new cases, plus thirteen notification and
foreground helper cases. Native types and scoped Biome passed. Independent review
aligned Archive/Revoke availability with the new guards while retaining concurrent
definition save/archive. Two existing reminder tests now use explicit discard and
retain their stale-callback assertions. No open source finding remains. Final
canonical and exact-commit automatic evidence is pending in the dated outside-Git
readiness record.
