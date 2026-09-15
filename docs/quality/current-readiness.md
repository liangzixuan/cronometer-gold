# Current readiness

Snapshot observed **2026-09-15T07:19:36.320201+00:00** against
`abdcd8391a03d8a03bc5f3f185e4a1a642425c18` on `codex/retention-features`.
This is a dated evidence record, not a live monitor or release approval. Revalidate
the exact checkout and workflow states when continuing; a later documentation
commit has separate automatic results in the dated Windows handoff.

Use the [build plan](../product/build-plan.md) for priorities and the
[release gates](release-gates.md) for authoritative acceptance. Older observations
are preserved in the [historical roadmap](../product/build-plan-history-2026-09-15.md)
and individual ADRs; they are not active implementation work.

## Current proof and limits

| Dimension | Evidence at this snapshot |
| --- | --- |
| Source identity | Local, tracking and live remote matched the full SHA above; working tree was clean before this documentation change. |
| Latest functional local validation | ADR 0075 ran fresh check/build/licenses on its frozen source at 2026-09-15 06:49–06:50 UTC: 1,019 web, 1,519 native plus 10 runner and 157 root checks; production Next and both native exports passed, zero cached tasks. License policy passed 535 packages with 14 reviewed exceptions. 89 optional integration cases were skipped. |
| Browser evidence | ADR 0075's corrected production Next/BFF synthetic Chrome journey preserved one accepted Repeat across a real minute boundary, then created a distinct deliberate operation; expiry and owned cleanup passed. The first fixture ETag mismatch and its correction remain in the handoff. This is bounded synthetic evidence. |
| CI | [Run 34940122506](https://github.com/liangzixuan/cronometer-gold/actions/runs/34940122506) completed successfully; provider update 2026-09-15T07:13:17Z. |
| Container workflow | [Run 34940122492](https://github.com/liangzixuan/cronometer-gold/actions/runs/34940122492) remains in progress. Five jobs were returned: upstream input validation, PostgreSQL, Caddy and Meilisearch succeeded; the Node runtime producer is running. The four dependent application jobs are not yet present in this observation. |
| This reconciliation | Documentation only. Validate diff/references/anchors, exact history preservation, unchanged application bytes and independent review. Do not represent inherited tests or builds as newly run for these prose changes. |

The [supply-chain policy](container-supply-chain.md#required-github-configuration)
requires nine real jobs for the exact default-branch release commit: the Node
producer, four applications, three service images and upstream input validation.
Missing or skipped jobs do not pass that gate. Successful workflow status alone
does not establish the required image digests, provenance, reviewer decisions or
deployment acceptance. No workflow dispatch, rerun or cancellation occurred.

The latest functional proof is recorded outside Git in
`WINDOWS-READINESS-2026-09-15-WEB-REPEAT-RETRY.md`; the current documentation
proof is in `WINDOWS-READINESS-2026-09-15-READINESS-RECONCILIATION.md` in the Windows
handoff. Runtime logs and machine-local paths remain there. This slice runs no
service/browser or application gate and makes no current Docker-engine, database,
restore, hosted or physical-device health claim.

## Actionable acceptance gaps

Owner roles below identify responsibility, not newly assigned people or approval.
Unassigned operators/reviewers remain unresolved; apply existing action-specific
authorizations within their original scope.

| Lane | Owner and next evidence | Exit |
| --- | --- | --- |
| Automatic delivery evidence | Delivery owner re-reads the exact commit's CI and actual container jobs. | Both applicable workflows complete successfully with required jobs executed; release artifact/digest/provenance requirements remain separate. [Supply chain](container-supply-chain.md#required-github-configuration). |
| Web printing | Browser QA operator/user performs repeat printing and direct Ctrl+P on a pinned build. | Observe cleanup of authorized hidden snapshots and neutral direct-print guidance. Six Letter/A4 PDFs and preview/Cancel remain dated evidence; the two checks are still unconfirmed. [ADR 0028](../adr/0028-print-current-nutrition-report.md#evidence-update--2026-09-09). |
| External code review | External Claude Code reviewer reviews the identified commit/diff; implementation owner resolves findings. | Retained report and decision tied to that source. In-task agent reviews and release attestations are different evidence. [Review boundary](../adr/0028-print-current-nutrition-report.md). |
| Native evidence contracts | Native evidence maintainer and independent reviewer version the capture/package/normalizer/source-bundle/manifest coverage for camera barcode and configurable groups. | Existing P0 v2's 19 flows cannot authenticate these additions; reviewed contracts must cover them before acceptance collection. [P0 limitation](../../infra/runbooks/p0-client-smoke.md), [native gates](release-gates.md). |
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

## Next product milestone

**Standalone private day notes** is the next bounded M1 candidate. Current
[web](../../apps/web/src/app/dashboard/DiaryClient.tsx) and
[native](../../apps/mobile/src/diary/DiaryScreen.tsx) editors require an existing
food/recipe entry to save a note; an empty day has no standalone note. The
[build-plan candidate](../product/build-plan.md#next-bounded-candidate-standalone-private-day-notes)
sets model review, immutable history, exact retry/conflict, privacy and real local
validation prerequisites before implementation. Implementation owner: Codex in the
current task; independent model/code reviewer required. No successor source or
model change is included in this reconciliation.

Native Repeat already retries its saved durable envelope, so another clock-change
fix there is not justified by the inspected source. Do not add speculative
hardening or reopen finished source slices merely to fill the queue.
