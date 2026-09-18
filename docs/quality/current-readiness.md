# Current readiness

The [ADR 0077 review follow-up](../adr/0077-role-specific-p0-evidence.md#follow-up-delivery-and-review-scope)
is delivered at `5d4c5a148b68bd9a7fb9f1f8c76b66ec9c2ecb68` on
`codex/retention-features`. Final local gates and all three CI/nine actual container
jobs passed on attempt one. September 16 23:53–23:54 UTC evidence records complete
automatic results and clean equal local/tracking/live heads. The scoped Claude
review at `805b937` is complete, its recommendations are addressed, and another
paid review is not an active milestone. No external approval of successor bytes
or release acceptance is implied.

[ADR 0078](../adr/0078-native-saved-day-note-preview.md) is delivered at
`b9a081c9b9a20a646832adb93942aeb5a4d33ada`: 39 focused cases, canonical gates
and fresh native exports passed, followed by all three CI/nine actual container
jobs on attempt one. September 17 03:36 UTC evidence confirms successful exact
results and a clean checkout with equal local/tracking/live heads.

[ADR 0079](../adr/0079-native-recipe-draft-protection.md) is delivered at
`bacc261b0b61bf61f74e7aa14daba09fa9201510`: 207 focused cases, independent
review, canonical gates and fresh native exports passed, followed by all three
CI/nine actual container jobs on attempt one. September 17 05:33 UTC evidence
records complete automatic results; successor preflight confirms clean equal
local/tracking/live heads.

[ADR 0080](../adr/0080-native-saved-entry-note-preview.md) is delivered at
`28f6e4f10fbcbbb5253fec1b069e6a132ff47773`: 120 focused cases, independent
review, canonical gates and native exports passed. All three CI/nine actual
container jobs passed on attempt one; September 17 07:25 UTC evidence records
complete outcomes and clean equal local/tracking/live heads.

[ADR 0081](../adr/0081-native-public-food-log-time.md) is delivered at
`ddd19bb83435818c2ad4e424e912238b0dd8dff5`: 119 focused cases, independent
review, canonical gates and fresh native exports passed. All three CI/nine actual
container jobs passed on attempt one; September 17 18:24 UTC evidence records
complete outcomes and clean equal local/tracking/live heads.

[ADR 0082](../adr/0082-native-public-food-log-date-shortcuts.md) is delivered at
`2e77f20e9ff1b6f8fb3cf67e8d21ce3c50d4f1cb`: 133 focused cases, independent
review, canonical gates and fresh native exports passed. All three CI/nine actual
container jobs passed on attempt one; September 17 21:15 UTC evidence records
complete outcomes and clean equal local/tracking/live heads.

[ADR 0083](../adr/0083-native-recipe-log-date-shortcuts.md) is delivered at
`af1c8603f0f7c2c6d06155f0816469dd519a8847`: 314 focused cases, independent
review, canonical gates and fresh native exports passed. All three CI/nine actual
container jobs passed on attempt one; September 18 01:05 UTC evidence records
complete outcomes and clean equal local/tracking/live heads.

[ADR 0084](../adr/0084-native-custom-food-log-date-shortcuts.md) is delivered at
`6ad91298556b5679c937ad594dfd88b628efbad3`: 592 focused cases, independent
review, canonical gates and fresh native exports passed. All three CI/nine actual
container jobs passed on attempt one; September 18 02:52 UTC evidence records
complete outcomes and clean equal local/tracking/live heads.

Active work is [ADR 0085](../adr/0085-native-biometric-reading-date-shortcuts.md):
Today/Yesterday for native biometric Log/Edit reading, preserving required time
and exact saved timestamp semantics. All 441 focused cases, native types/format
and independent source/documentation review passed. Final canonical and exact-
commit automatic evidence remains to be recorded in dated Windows readiness;
component proof is not device acceptance. The approved Expo `.20`
installation/audit belong to the completed follow-up; audit authorization is
consumed. Historical failures and service/browser evidence retain their dates.

Use the [build plan](../product/build-plan.md) for priorities and the
[release gates](release-gates.md) for authoritative acceptance. The
[historical roadmap](../product/build-plan-history-2026-09-15.md) retains earlier
delivery evidence unchanged; it does not describe current pending source work.

## Current proof and limits

| Dimension | Evidence at this snapshot |
| --- | --- |
| Delivered day-note source | Standalone private day notes and the browser-discovered readiness/focus fixes are source-complete and independently reviewed. Final canonical, dependency and local acceptance gates now pass. Desktop and measured 390px browser proofs remain applicable after the reviewed mobile-only dependency update. The feature is committed/pushed as `9344057`, and all required automatic jobs passed. ADR 0077 changes review evidence contracts only; its source proof remains separate. |
| ADR 0077 source/local gates | Five implementation/test files and twelve docs passed independent review. Focused Python 13/13 and JavaScript 33/33 passed with zero skips. Canonical `pnpm check` passed September 16 at 01:59:42–02:00:09 UTC; type/test graphs each passed 17 tasks, 16 cached. `pnpm build` passed at 02:00:26–02:00:44 with 11 successful tasks, ten cached. Mobile checks and bundles ran fresh; cached results do not rerun service/browser evidence. Dependencies are unchanged; no installation or new local production audit was run. Commit `805b937` subsequently passed all required automatic jobs; later source does not inherit that status. |
| Completed review follow-up | `5d4c5a1` passed focused Python 16/16 and JavaScript 40/40; canonical check recorded 1,721 fresh/2,327 cached passes and 93 cached opt-in skips, and build passed 11 tasks (ten cached). Its [CI 35157033874](https://github.com/liangzixuan/cronometer-gold/actions/runs/35157033874) and [container 35157033863](https://github.com/liangzixuan/cronometer-gold/actions/runs/35157033863) passed all 3/9 actual jobs on attempt one. The new Python step executed successfully. The supplied Claude report remains a completed, scoped review of `805b937`; follow-up in-task review is separate. |
| Focused clients and backend | The new post-commit focus fix passed 130 web focused cases, zero skips, affected types/formatting and independent review. Both Keep/Use focus regressions failed on original source before passing fixed; stale queued focus is rejected after date/private/draft/background changes. The unchanged native readiness fix retains its earlier 114-case proof. The earlier 21 backend cases include real note and retention DB cases. These are component/source tests, not physical-device evidence. |
| Real database/API | Earlier dated runs: full DB suite 362 passed, none skipped; full API suite 358 passed and four opt-in cases skipped. The real 68-family privacy drill passed two artifact-store cases and one route-first API/worker case; restore integrations separately passed two worker cases and one API case. Post-install review verified unchanged server implementation, tests, resolved runtime graphs and 411 non-policy restore inputs. These runs remain source-applicable; final canonical validation did not freshly execute them. Mailpit opt-ins were not rerun. |
| Migration/recovery | Main applied only migration 0026, then applied zero on replay. Before upgrade, a baseline-25 logical restore passed forward upgrade, twice-current and checksum-rejection/recovery checks. Current-26 logical restores checked all 93 tables and exact note-family contents; authenticated deletion-ledger replay erased one synthetic owner across 68 families, preserved the other owner and passed fresh-epoch readiness. Owned targets and temporary dumps were removed. |
| Corrected validation failures | A paginated-food ETag equality assertion incorrectly ignored randomized cursors; each response now verifies its own exact body hash, while food/cursor invariants remain. An existing catalogue-expiry test now observes both clocks before its unchanged rejection assertions. Independent review and the affected reruns passed; original failures remain recorded. |
| Approved dependency prerequisite | After the earlier six approved Expo updates, the user explicitly approved the exact `expo-build-properties@57.0.19` release-age exception/install and one additional production audit. The four-file resolver result exactly matched the reviewed proposal and passed strict frozen/strict-peer install. Independent review found only the expected mobile edge/version replacement across 12 importers, 723 packages and 726 snapshots; 929 other source inputs were unchanged before final prose edits. No broader exception or unrelated graph change was introduced. The historical 20:14 compatibility failure remains recorded. |
| Final canonical gates | `pnpm check` passed at 22:28:23–22:28:47 UTC: 1,713 fresh passes (157 root, 1,546 mobile Vitest and ten wrapper cases), plus 2,327 cached passes and 93 cached opt-in skips; no fresh cases were skipped. Type/test graphs each reused 16 of 17 tasks, freshly executing mobile. The 1,094 web cases were cached from the prior fresh focus-fix run. `pnpm build` passed at 22:29:11–22:29:27 with 11 successful tasks, ten cached and native fresh. Cached or skipped integration results are not new service runs. |
| License/audit and isolated build | License policy passed at 22:30:35–22:30:36 UTC for 535 production packages with 14 existing reviewed exceptions. The one newly approved audit ran at 22:30:18–22:30:19 and passed with zero reviewed advisories/exceptions and four lower-severity advisories visible; that authorization is consumed. The earlier audit remains historical. A separate 22:30:43–22:31:02 source-only native build verified 933 inputs/modes and freshly built contracts plus iOS/Android bundles without copied application output or Turbo. Installation reused 651 store packages, downloaded zero and added 654, with a three-minute policy-cache result. This is fresh application-output proof, not a fresh dependency download or physical-device acceptance. |
| Browser/device | Chrome verified empty/populated create/edit/clear/rewrite and the corrected draft Return/Cancel flow. Later Brave checks on that readiness build passed both conflict choices without implicit writes, explicit keyboard save, revoked-session closure, owner isolation, the 2,001-scalar limit and date navigation. After rebuild, fresh Brave checks verified enabled-textarea focus for Keep, Use saved note and ordinary Cancel, exact raw/saved text, explicit save to revision 9 and no implicit write at revision 10; the populated day stayed at note revision 4 with unchanged pinned food and nutrients. Earlier checks apply to unchanged handlers; focus checks are fresh. A later measured 390×844 viewport (client/scroll width 375) passed saved-note, 2,001-scalar validation and conflict layouts without document overflow, plus keyboard Cancel/Use focus and no implicit write at revision 11. Earlier no-effect viewport attempts remain recorded; the delayed change has no established cause. Reset to desktop was verified and extra owned tabs closed. The owned preview was stopped at 22:25 UTC before dependency installation. Post-install source/graph review carries forward these dated browser observations; no new browser run is claimed. DOM/UI evidence does not establish HTTP status, SQL history, physical-device or screen-reader acceptance. |
| Delivered day-note automatic evidence | [CI 35032737042](https://github.com/liangzixuan/cronometer-gold/actions/runs/35032737042) passed all three jobs for `9344057`. [Container workflow 35032737075](https://github.com/liangzixuan/cronometer-gold/actions/runs/35032737075) passed all nine actual jobs on attempt one, independently bound and recorded at 2026-09-16 01:38:39 UTC. These results cover that commit, not later source. |
| Delivered ADR 0077 automatic evidence | [CI 35046719322](https://github.com/liangzixuan/cronometer-gold/actions/runs/35046719322) and [container run 35046719379](https://github.com/liangzixuan/cronometer-gold/actions/runs/35046719379) passed all three/nine actual jobs for `805b937` on attempt one, with no required skips. Delivery closed September 16 at 03:33:22 UTC; the fresh 06:17:15 observation confirmed the same completed runs. It is not a new execution or approval of follow-up changes. |
| ADR 0028 local print follow-up | Actual Brave repeated preview/Cancel and direct Ctrl+P passed by September 16 04:07:47 UTC. Both report cancellations cleared authorization and the printable article while preserving the report and enabled Print action; direct Ctrl+P showed neutral guidance only and canceled cleanly. The existing production build was content-bound to unchanged relevant source at `805b937`, not rebuilt there. No saved/physical output or new all-layout, API/database, device or screen-reader proof is claimed. [Dated scope](../adr/0028-print-current-nutrition-report.md#native-browser-follow-up--2026-09-16-utc). |

The [supply-chain policy](container-supply-chain.md#required-github-configuration)
still requires all nine actual jobs for the exact release commit, plus the required
image digests, provenance and reviewer decisions. No workflow controls, cloud/EAS,
phone exposure or deployment action was taken. Local synthetic recovery does not
establish hosted or off-host recovery acceptance.

Docker Desktop was recovered by preserving and recreating only stale IPC
directories. The real guarded loopback dependencies supported these integrations;
no factory reset, volume deletion or credential change occurred. The browser-crash
mitigation remains in effect: use the supported
user-selected Brave session and avoid embedded/in-app tabs. The reviewed local
preview was restarted at September 15 22:47 UTC and last checked healthy at
23:10:44 UTC; those are dated observations, not a current device-acceptance claim.

## Actionable acceptance gaps

Owner roles below identify responsibility, not newly assigned people or approval.
Unassigned operators/reviewers remain unresolved; apply existing action-specific
authorizations within their original scope.

| Lane | Owner and next evidence | Exit |
| --- | --- | --- |
| Automatic delivery evidence | Delivery owner re-reads the exact commit's CI and actual container jobs. | Both applicable workflows complete successfully with required jobs executed; release artifact/digest/provenance requirements remain separate. [Supply chain](container-supply-chain.md#required-github-configuration). |
| Native biometric reading date shortcuts | Implementation owner and independent in-task reviewer validate profile-local choice at activation, required time, metric/edit identity, timestamp precision, preserved drafts and existing reading guards. | Focused native checks, canonical gates and exact-commit automatic jobs; physical-device and assistive evidence remain separate. [ADR 0085](../adr/0085-native-biometric-reading-date-shortcuts.md). |
| Signed device and accessibility | Release owner confirms identifier history and numbering; device operators and reviewers prepare approved Windows relay/capture prerequisites and the physical iOS/Android matrix. | Exact signed artifacts, protected-storage/OS-kill, notification, cross-client and accessibility evidence with required attestations. Exports do not substitute. [Windows boundary](../../infra/runbooks/physical-device-windows-wsl2-private-https.md), [release matrix](../../infra/runbooks/platform-health-release.md). |
| Hosted beta and mail/privacy operations | Deployment/security, database/privacy and mail owners review target/budget, seven-image deployment, TLS/access/readiness, off-host restore and production delivery operations. | Hosted restore/erasure replay and access evidence, approved provider/sender and abuse/retry/suppression operations, independent review and rollout decisions. [Release](../../infra/runbooks/platform-health-release.md), [restore](../../infra/runbooks/postgres-backup-and-restore.md), [mail/privacy gates](release-gates.md). |
| Live catalogue and database authority | Acquisition/storage operators, data-quality/rights reviewers and database authority owner provide authenticated dual acquisition, immutable retention, manifest-v4 review bundle, mapping/scale evidence and caller cutover. | Approved numeric catalogue/search/resource thresholds, three distinct role approvals and separate activation decision. The 363-food pilot and synthetic fixtures are insufficient. [Source runbook](../../infra/runbooks/food-source-release.md), [catalogue boundary](../product/build-plan.md#parallel-release-acceptance-target--live-catalogue-evidence). |
| Scientific/legal and optional references | Named scientific, legal/privacy and copyright reviewers review applicable equations, units, claims, rights and the selected reference policy. | Required approvals, applicability/copy/acknowledgement and hosted/device acceptance before optional template enablement. Manual goals remain usable. [ADR 0021](../adr/0021-source-verified-adult-dri-reference-targets.md), [reference gates](release-gates.md). |

Checked-in configuration still leaves both the
[health reviewer list](../../apps/mobile/config/health-release-reviewers.json) and
[deployment reviewer list](../../apps/mobile/config/release-deployment-reviewers.json)
empty. [Numbering](../../apps/mobile/config/release-numbering.json) has
`identifierHistoryConfirmed: false` and null native build numbers;
[deployment](../../apps/mobile/config/release-deployment.json) has confirmation
false and null origin, images and reviewer attestation. The selected platform is
an unconfirmed configuration value, not an observed deployment. These facts do
not prove that external resources or signed builds do not exist.

Hydration client time editing is source/local complete under
[ADR 0027](../adr/0027-hydration-time-corrections.md); signed-device acceptance is
still open. The source already implements nonce-based web CSP. Neither should
be reintroduced as missing source work from an older summary.

## Active milestone and successor

Complete [ADR 0085](../adr/0085-native-biometric-reading-date-shortcuts.md) with native
behavioral proof, independent in-task review, canonical validation and the new
commit's automatic results. ADRs 0077 through 0084 are delivered baselines, not
pending source tasks. Record the successor
in the dated Windows readiness record and reconcile it with the next coherent
source change; avoid a status-only commit/build cycle.

The scoped external report is complete at `805b937`. Another paid review needs
explicit scope/spending approval. Audit authorization is consumed. Source,
synthetic and automatic evidence do not close device/accessibility, hosted,
catalogue, signing, scientific/legal or release acceptance.
