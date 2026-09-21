# Controlled-beta exit checklist

This is the finite execution checklist for M0, M1 and M2 in the
[build plan](build-plan.md). The user approved this priority change on September
19, 2026 after the progress audit. It changes sequencing, not release criteria or
action-specific approvals. [Release gates](../quality/release-gates.md), source
runbooks and signed-evidence contracts remain authoritative.

## Fixed beta scope

Keep the existing web and native daily loop: account/profile and recovery, search
and barcode, diary/recipes/custom foods, manual goals, hydration/activity/notes,
reports, privacy export/erasure, durable native logging, reminders and the required
weight-platform integration. Nutrition remains consumer wellness with provenance
and missingness. The current M1 device/health matrix cannot silently be reduced.

Optional reference templates stay disabled. Their additional clinical/copyright
enablement package is separate; general scientific review of shipped equations,
units and claims, and food-data/privacy legal review still apply. Premium capture,
scheduled reports, scores, fasting, sharing/coaching and commerce remain M3–M5.
A smaller web-only or no-health beta would require an explicit scope amendment
and verified disablement before its acceptance criteria could change.

## Required exits

All six rows are open at this checkpoint. A source prerequisite may complete
without closing its row. Record exact evidence and acceptance against one release
candidate; do not turn a unit test or an assigned role into a release approval.

| ID | Required exit | Engineering and evidence remaining | Responsible roles and dependencies |
| --- | --- | --- | --- |
| C1 | Catalogue can be prepared at the intended scale under the correct authority | Full-scale paged full-CSV staging/validation beyond the bounded ADR 0101 proof; remaining full-snapshot consumers and measured resource/lock budgets; authenticated external principal and runtime credential/caller cutover; independent validator; remaining shared writers, direct-DML revocation and target canaries | Source integrator and independent in-task reviewer for code; database/release operators for target proof. ADRs 0100/0101 are delivered; ADR 0102 has reviewed source and passing bounded synthetic PostgreSQL validation, with exact-commit automatic delivery pending. Full-scale paging, authority cutover and target execution still require their own reviewed proof and approved packages. |
| C2 | Consumer-usable catalogue is reviewed and ready for a separate activation decision | Exact candidate/market; two independent authenticated acquisitions; retained immutable object and current retention; rights/mapping review; approved numeric food/branded/GTIN, completeness, search and resource thresholds; non-current staging, reconciliation, index/relevance/barcode/rollback evidence and three required role approvals | User selects acquisition/storage operators and named data/rights reviewers. Requires C1 and approved acquisition/storage actions. The 363-food pilot is insufficient; activation remains separate. |
| C3 | Account verification/recovery can operate safely in the beta | Durable or provider-idempotent transactional delivery; shared source/target abuse admission and timing review; authenticated TLS provider/sender/domain; retry, bounce/suppression/support handling; accepted enforcement policy and integrated proof | Source integrator plus mail/security operators. Provider, domain, budget and actual DNS/account operations need a concrete decision package. Local Mailpit proof does not close this row. |
| C4 | Exact hosted candidate has accepted access, privacy and recovery | Approved target/budget; seven pinned application/service image digests and provenance; HTTPS/readiness/access checks; current retained-data inventory; hosted/off-host restoration, deletion-ledger replay, cross-owner checks and measured RPO/RTO; operational ownership and rollback | Deployment/security and database/privacy operators, with independent acceptance. Requires applicable C1/C3 changes and authorization for exact infrastructure/access actions. Published images alone are insufficient. |
| C5 | The daily loop works across actual clients and accessibility paths | Confirmed identifier history/build numbers; authorized signed iOS/Android artifacts and phone boundary; physical camera, protected storage/OS-kill/retry, health/reminder, cross-client and accessibility matrix; browser and assistive-technology evidence for the selected candidate | Release/device operators and independent device/accessibility reviewers. Internal signed tests may proceed once their own prerequisites pass; production signed builds additionally require deployment attestation. |
| C6 | A named release owner accepts one complete beta candidate | Evidence index binds source/automatic jobs, dataset, deployed digests, account lifecycle, access/recovery, clients and required scientific/legal/security/device/accessibility findings; unresolved failures reconciled; explicit go/no-go plus separately authorized activation/rollout | Named independent reviewers accept their actual scopes; release owner records the decision. Requires C1–C5. No synthetic identity, elapsed time or general code review substitutes. |

## Work order and ownership

1. ADR 0100 is delivered at `ece0bbe`: bounded verified normalized-record export,
   with local and all required automatic jobs passed.
   [ADR 0101](../adr/0101-fdc-csv-capability-staging.md) is delivered at `772e10d`:
   capped restricted-login staging/parser seal, approved PostgreSQL proof and all
   final local/automatic gates passed. Continue
   [ADR 0102](../adr/0102-fdc-csv-independent-validation.md), an independent
   bounded validator with retained exact prepare/submit requests. Existing SQL
   caps, whole-batch observation and authority cutover still prevent full-scale
   readiness; none of these source prerequisites closes C1/C2.
2. Finish the rest of C1 and C3 as coherent engineering packages. Before edits,
   identify required integration/service evidence and prepare any missing exact
   action approval. Do not choose easy UI work simply because an external gate is
   awaiting a decision; prepare that gate's reviewable package first.
3. Prepare the four external packages below while source work advances. Assign
   real operators/reviewers before their execution; these role names do not assign
   the user or Codex to an independent approval role.
4. Run approved C2/C4/C5 operations in dependency order, retaining failed as well
   as successful evidence. Reuse unchanged applicable local proof; do not reuse
   freshness-sensitive provider or device evidence beyond its scope.
5. Assemble C6 and make the final explicit release decision. Remaining premium
   work does not enter this queue until the beta exit work is complete or the user
   explicitly reprioritizes it.

One source package remains active at a time under the
[development workflow](../quality/development-workflow.md). The integrator owns
final review, focused checks, affected types/formatting, required canonical gates,
explicit-file normal commits/non-force pushes and exact-commit automatic evidence.
No successor starts while required automatic jobs remain unaccepted. Source,
local, automatic and release statuses must stay separate. A completed ADR is not
a completed row unless every row criterion has been met.

## Concrete external decision packages

| Package | Must be reviewable before asking for execution | Decision boundary |
| --- | --- | --- |
| Catalogue | Exact source/version/market and upstream identity; two distinct acquisition contexts/identities; separate immutable-storage workload and retention; parser/mapping inputs; measurable acceptance thresholds; database cutover/canaries; costs, commands, evidence locations and rollback | User chooses operators/reviewers and approves exact acquisition/storage/target actions and budget. Named reviews and the later activation decision remain separate. |
| Hosting/access/recovery | One target-specific seven-image deployment; resource and cost envelope; exact infrastructure/DNS/access changes; secret ownership; backup retention and off-host restore/erasure procedure; RPO/RTO targets, rollback and acceptance owners | User authorizes target, budget and listed operations; independent security/privacy evidence follows. Existing platform configuration does not prove deployment. |
| Account mail | Provider/sender/domain choice with current primary-source information; delivery and idempotency design; shared admission/trusted-source policy; credentials/TLS/DNS actions; retries, bounces/suppression, monitoring/support, cost and validation | User selects provider/domain/budget and approves concrete account/DNS actions. Production enablement waits for accepted operational and abuse evidence. |
| Signed clients | Verified identifier history; proposed native numbers; exact signed-build inputs/quota; approved phone relay/trust boundary; available physical devices and owners; required matrix and independently controlled reviewer keys | Release owner confirms identifiers; user approves exact EAS/signing and phone/network actions. Operators and reviewers supply actual device evidence. |

Final independent acceptance uses the C6 index, not another generic paid review.
The paid review at `805b937` is complete for its recorded scope. New paid review,
installation, production audit, manual workflow actions, live data, services,
hosting, DNS/network, signing/device and quota retain applicable specific approval
requirements. Approval of this checklist alone does not execute those actions.

Use [current readiness](../quality/current-readiness.md) for dated source proof
and the outside-Git CURRENT/readiness checkpoint for interrupted work and exact
job observations. Do not duplicate raw evidence or infer an ongoing automation
window from this checklist.

## Authoritative execution references

- [Food-source release and activation](../../infra/runbooks/food-source-release.md)
- [Migration and authority deployment](../../infra/runbooks/database-migrations.md)
- [Recovery and deletion replay](../../infra/runbooks/postgres-backup-and-restore.md)
- [Privacy operations](../../infra/runbooks/privacy-export-and-erasure.md)
- [Windows physical-phone boundary](../../infra/runbooks/physical-device-windows-wsl2-private-https.md)
- [Signed-client and deployment acceptance](../../infra/runbooks/platform-health-release.md)
- [Email verification](../adr/0014-email-verification-boundary.md) and
  [password recovery](../adr/0015-password-recovery-boundary.md)
