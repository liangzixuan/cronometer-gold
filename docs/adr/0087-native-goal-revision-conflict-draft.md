# ADR 0087: Preserve native goal drafts after a revision conflict

Status: Implemented at `53a43cc`; local and exact-commit automatic evidence passed. Device and release acceptance remain separate.

## Context

The native goal save handler grouped HTTP 412 revision conflicts with HTTP 409
profile and policy conflicts. It fetched the profile and reloaded the saved goal,
replacing unsaved builder fields. A second client publishing a newer revision
could therefore make an unsuccessful Save erase the user's edits. The API maps
goal revision conflicts to 412 separately from profile conflicts. Recipes already
preserve their draft when a revision loses this race.

## Decision and acceptance

On a current 412 response, keep the complete manual, derived or reference goal
draft exactly as entered, along with separate profile drafts and the last loaded
goal/progress. Explain that edits remain local and the saved view may be stale.
Do not automatically fetch the profile, reload goals, rebase or publish again.

While this draft has a revision conflict, replace the existing Refresh action
with **Discard edits and reload saved goal**. This one explicitly named action
uses the existing loader. Successful reload installs current saved values and
retires the conflict; failed reload preserves the draft and a clearly labelled
retry. Ordinary edits retain the conflict marker. Successful New or Copy draft
replacement retires it. No extra confirmation dialog or general navigation-wide
draft manager is introduced.

Bind the marker to the private/profile context and saved goal ID/revision.
Use synchronous state identity to reject an old ambiguous Refresh callback before
the conflict label repaints. Recovery callbacks must also be current for the
builder, selected progress date, load and action generation, private lifecycle
and request controllers. Intervening goal/profile/candidate requests invalidate
retained recovery actions even if those requests fail. A fresh rendered control
remains usable when safe; expose disabled state accessibly.

A 412 is a definitive rejection: remove that pending operation only. A later
unchanged Save retains the exact body and stale If-Match revision but allocates
a new operation key. Do not silently overwrite the newer revision. Preserve
the existing exact-body/key retry after ambiguous failures such as 503, and the
existing 409 profile/policy refresh and owner-change closure behavior.

## Consequences, alternatives and review triggers

Users can inspect and retain their attempted edits after a revision conflict,
then explicitly discard them to load current saved values. This does not merge
concurrent drafts or provide offline persistence. Merely changing the error text
would leave an ambiguously labelled destructive Refresh; adding a second reload
button would duplicate that action. A conflict-specific label and guarded action
keep the recovery scope bounded.

The feature changes no web/App/API/schema/outbox contracts, nutrition policy,
reference enablement or general refresh design. A separately approved Expo
compatibility prerequisite is recorded below. No paid review, browser/service/
device/cloud or manual workflow action is included. Revisit when API conflict
meanings, goal builder identity, reference materialization or request lifecycles
change.

## Validation

Use the existing actual-screen harness and goal/reference helper suites. Record
regressions failing before the fix and passing afterward for exact draft retention,
no implicit reads, explicit reload success/failure, stale actions and 412 versus
503 retry identity. Keep 409 owner/profile coverage. Review the source and docs,
run focused tests, native types and scoped Biome check, then canonical pnpm check
and pnpm build on the final reviewed source. Record fresh/cached/skipped counts,
commit/push and all three CI/nine actual container jobs for the exact commit
outside Git. Hook-harness/export evidence does not establish concurrent React,
physical-device, assistive-technology or release acceptance.


Development evidence on September 18, 2026: the 96-case baseline passed.
The first 20 new screen cases recorded 17 failures and 75 passes on pre-fix
source; the three new 409 cases confirmed existing behavior. Two delayed-response
cases additionally verify that old 412 metadata does not enter changed contexts.
Independent source review identified a candidate-request completion repaint gap.
Two further regressions cover repeated identical candidate failures with pending
renders, stale disabled callbacks and unmount; explicit candidate-loading state
resolves the gap without changing requests or policy. Final focused validation
passed 120 cases (96 screen, 17 goal helpers, seven reference helpers), no skips;
native types and scoped Biome check passed. Source and documentation review are
recorded separately; completed final gates and exact-commit automatic outcomes
are summarized below and retained in the dated outside-Git readiness record.


## Approved Expo compatibility prerequisite

The initial canonical check stopped at Expo's updated compatibility requirements
on September 18 at 09:27 UTC; the unchanged installed graph still built at 09:28
UTC. Those results remain historical. The user explicitly approved the exact
six-version release-age exception and installation proposal, plus one new local
production audit, when resuming this slice after the overnight window.

Direct pins advance to expo 57.0.24, expo-build-properties 57.0.21 and
expo-notifications 57.0.20. Their required transitive minimums advance to
@expo/cli 57.0.26, expo-asset 57.0.18 and expo-constants 57.0.19. Only the three
direct pins, two existing native configuration version bindings, six exact age
exceptions and corresponding lockfile records/peer references change. Existing
strict peers, security overrides, build allowlist and trust policies remain.

Fresh official metadata matched the reviewed releases before installation.
Independent review confirmed exactly six package replacements across unchanged
723-package and 726-snapshot inventories, complete normalized importer/snapshot
equality and unchanged unrelated source. Strict frozen/peer verification passed;
the 120 focused cases and scoped Biome check passed again on this graph. The one
approved audit passed policy at 16:15 UTC, with four lower-severity advisories
still visible; its authorization is consumed. License checks passed for 535
production packages with 14 existing reviewed exceptions. Final canonical gates,
the isolated build from source and exact-commit automatic results subsequently
passed as recorded below. Native exports and dependency checks do not establish
device or release acceptance.

## Delivery evidence

Delivered at `53a43ccb26da865b2c337c5d334fdf8832fdd13c` on September 18, 2026.
Final canonical check passed at 16:24 UTC: 1,906 fresh tests passed, with 2,327
cached passes and 93 cached opt-in skips; type/test graphs each passed 17 tasks,
16 cached. Canonical build passed 11 tasks, ten cached, with fresh native exports.
A separate source-only export passed strict frozen/peer installation followed by
contracts and mobile builds without copied application outputs or Turbo cache.
All 946 source input bytes and modes remained unchanged.

[CI 35368561272](https://github.com/liangzixuan/cronometer-gold/actions/runs/35368561272)
and [container 35368561239](https://github.com/liangzixuan/cronometer-gold/actions/runs/35368561239)
passed all three and all nine actual jobs, respectively, on attempt one. The
final web job completed at 17:49:26 UTC; official observation at 17:52:25 UTC
retains every job outcome. Clean matching local/tracking/live heads and all
eleven reviewed file hashes were verified at 17:53:05 UTC. The delivery monitor
was paused. Signed-device, reviewer, hosted and release acceptance remain open.
