# ADR 0077: Role-specific P0 review evidence for camera, groups and day notes

- Status: Source complete and local verified; exact-commit automatic and external acceptance pending
- Date: 2026-09-16 UTC
- Planning baseline: `93440578072202710f94f10e6c0dc15bf5a17660`

## Context

The baseline completed ADR 0076 source delivery, including all three CI and nine
actual container jobs. Its P0 v2 evidence contract still has a closed inventory
of 19 common flows. It cannot authenticate the native camera, configurable diary
groups or standalone day-note observations added by ADRs 0019, 0020 and 0076.
Adding assertions to an old capture or reinterpreting its signature would change
the meaning of historical evidence.

The existing Python normalizer emits an unsigned structural candidate. The
JavaScript verifier separately checks that candidate, its exact source-bundle
digest and its binding in an independently signed health manifest. Neither
program runs a client or establishes that an operator's assertions happened.

## Decision and coordinated version boundary

Advance these exact schema domains together:

| Contract | Current successor |
| --- | --- |
| Capture | `nutrition-tracker-p0-client-smoke-capture-v3` |
| Review-package index | `nutrition-tracker-p0-client-smoke-review-package-v3` |
| Unsigned report | `nutrition-tracker-p0-client-smoke-report-v3` |
| Source-capture digest domain | `nutrition-tracker-p0-client-smoke-source-capture-bundle-v3` |
| Signed outer manifest | `nutrition-tracker-health-release-evidence-v6` |

Current parsers require these versions. Historical captures, reports, digest
domains and signed manifests cannot be relabelled, supplemented or automatically
upgraded. New acceptance requires a complete new v3 capture package and independent
v6 review. Preserve historical evidence and its original meaning outside this
current parser contract.

The P0 envelope fields and minimal `flowId`, `outcome`, `observedAt` result shape
remain unchanged. The only accepted outcome is `passed`; there is no optional
flow or `not-applicable` result. Python and JavaScript use closed per-client
inventories, with exact role keys `browser`, `ios`, `android`.

## Ordered inventory

Preserve all 19 original IDs in their original relative order. The common
browser inventory has 21 flows:

1. `unauthenticated-entry`
2. `register`
3. `sign-in`
4. `session-restore`
5. `unauthorized-session-rejection`
6. `food-search`
7. `diary-add-edit-delete`
8. `diary-repeat`
9. `diary-pagination`
10. `diary-group-configuration`
11. `recipe-create-revise-log`
12. `goal-create-revise-progress`
13. `retention-trends`
14. `custom-food-create-revise-log`
15. `diary-day-note`
16. `biometric-create-edit-delete`
17. `reminder-create-pause-revoke`
18. `account-export-download`
19. `sign-out-private-cleanup`
20. `account-erasure`
21. `erasure-status-after-session-revocation`

iOS and Android each insert `camera-barcode-capture` immediately after
`food-search`, producing 22 flows. Browser `food-search` retains typed-barcode
lookup observations; a browser camera result is invalid. New authenticated
flows precede export, private cleanup and erasure. Do not append work after
account erasure or manufacture a browser camera pass.

## Observations and preserved obligations

- Native camera evidence covers actual permission grant, temporary/permanent
  denial with manual fallback, unavailable/cancel/background teardown, repeated
  detection suppression, EAN-8/EAN-13/UPC-A/ITF-14 behavior, invalid check digit,
  no match and network errors, parity with typed lookup and explicit confirmation
  before mutation. It also covers absence of microphone access, frame retention
  or upload, background capture, on-disk barcode storage and outbox widening.
  Preserve the physical VoiceOver/TalkBack obligations in ADR 0019.
- All clients rename/reorder the four presentation groups, preserve canonical
  meal destinations and native queued delivery, converge on profile refresh, reset
  defaults and reject stale edits without overwriting another client's change.
  Labels, pickers, receipts and accessibility observations must remain coherent.
- All clients create, edit, clear and rewrite notes on empty and populated days.
  Observe exact raw text and limits, explicit save/clear and unchanged-draft
  behavior, original-date Return/Cancel, unavailable/loading states, exact
  ambiguous retries across date and same-owner zone refresh, deliberate Keep/Use
  conflict recovery, keyboard/accessibility focus, stale/private/background
  fences and unchanged food/nutrient behavior. Explain the online-only draft and
  unresolved-key lifetime; no crash-safe or offline-note claim is added.
- The existing later export, sign-out cleanup and erasure observations include
  these synthetic notes and their retained history under the 68-family contract.
  Raw notes, exports, barcodes, device identifiers and health values do not enter
  the normalized capture or report; protected observations remain outside Git.

All earlier P0 and independent release obligations remain required. A new flow
ID is a bounded reviewed assertion, not a replacement for the detailed runbooks
or evidence that the normalizer can itself observe behavior.

## Unchanged trust and execution boundaries

Keep the unsigned trust marker, synthetic-only classification, raw-byte capture
hashes, domain-separated role order, exact private origin/commit/build IDs,
monotonic UTC timing, session bounds, strict JSON and protected no-follow file
reads. Keep independent Ed25519 review, reviewer trust/rotation, exact artifact
and deployment bindings and all health device checks unchanged. Relay review
package/source-bundle v2 and relay report v4 remain their existing contracts;
only their current outer health-manifest reference advances to v6.

This source change authorizes no device run, authentic capture, reviewer key,
signing, EAS quota, cloud or network exposure, catalogue action, deployment or
release. Synthetic test fixtures establish parser behavior only. Checked-in
empty reviewer lists and unconfirmed identifiers remain blocking controls.

## Validation, consequences and alternatives

Independent model review accepted the exact role inventories and coordinated
versions before implementation. Validate Python and JavaScript independently,
then exercise actual Python-to-JavaScript canonical-byte compatibility. Reject
each missing new flow, wrong-role camera results, duplicates/order changes,
old/mixed schemas, a relabelled 19-flow report, old digest domains and old signed
manifests. Pin the original 19-ID subsequence independently in tests. Preserve
negative trust, file, timing and identity coverage. Fix synthetic fixture times
with real instant arithmetic so 22 observations cannot create invalid minutes.

The rejected alternatives are appending to v2, accepting an N/A browser camera
pass, and a permissive multi-version parser. They either reinterpret old
evidence or make required coverage ambiguous. The cost of the strict successor
is complete recollection and independent signing for current acceptance.

Re-review this decision when adding a flow, changing client applicability,
altering observation semantics or privacy payloads, adding historical-version
acceptance, or changing any capture, digest, signature or artifact binding.

## Source and local validation — 2026-09-16 UTC

Independent review accepted all five implementation/test files and twelve
documentation files, with its three documentation findings resolved. Fresh focused
Python tests passed 13/13 and JavaScript tests passed 33/33, including actual
normalizer-to-verifier canonical-byte compatibility. No focused tests were skipped.
The first Python run's pending runbook-reference failure remains recorded; the
complete rerun passed after documentation updates without Python source changes.

Canonical `pnpm check` passed at 01:59:42–02:00:09 UTC. Type/test task graphs each
passed 17 tasks, with 16 cached and mobile freshly executed. `pnpm build` passed
at 02:00:26–02:00:44 with 11 tasks, ten cached and native bundles freshly emitted.
Cached results are not new service or browser observations. Dependency files are
unchanged; no new installation or local production audit was run. Documentation
completion prose received a subsequent bounded consistency and reference review.

This completes source and local validation only. Exact-commit automatic CI and
all nine actual container jobs must still be observed after commit/push. External
Claude review, protected physical-device observations, independent signed review,
hosted acceptance and release approval remain separate.
