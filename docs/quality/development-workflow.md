# Development and continuation workflow

This workflow implements the sequencing in [the build plan](../product/build-plan.md).
The [release gates](release-gates.md), source runbooks, and CI remain authoritative.
Scheduling a check later never changes its assertions or acceptance criteria.

## One active product slice

Before editing, write a short acceptance card: the user's task, observable result,
affected clients/contracts, exclusions, required evidence, and stop condition.
Keep one product slice active. Give independent agents disjoint files or read-only
reviews; one integrator owns the final diff, shared-service tests, and delivery.
Review state transitions and integration seams before expensive final validation.
Demonstrated P0/P1 defects that invalidate the active slice or its required release
gate interrupt the queue; smaller defects in the active slice belong in that slice.
Pre-existing gated production work stays in its release lane while its affected
capabilities remain unavailable. Unrelated hardening needs a named defect or
release gate to enter the active queue.

## Continue from source, not a bootstrap transcript

1. Inspect the Linux-filesystem checkout, branch, local/tracking/live-remote SHAs,
   working tree, applicable instructions, and current tool/runtime prerequisites.
   Preserve dirty work and reconcile unpushed commits before starting a successor.
2. Read the current build plan, the active slice's ADR, and the latest small
   session checkpoint. Historical logs explain decisions; they do not establish
   current runtime health, remote state, or freshly completed checks. Carry forward
   verified applicable standing user approvals without expanding their scope.
3. Recover the interrupted step. Do not reclone a healthy checkout, reinstall an
   unchanged toolchain, reset history, regenerate credentials, or recreate local
   data merely because a new conversation began.

Keep a compact current pointer outside Git, with one dated readiness record per
slice or continuation. Record the full source SHA, dirty diff digest and untracked
files, evidence paths, unresolved failures, current service state, and exact next
action. Do not duplicate the evidence into multiple rolling roadmap overlays.

## Validation stages

| Stage | Work | Exit condition |
| --- | --- | --- |
| Preflight | Source identity, versions, required tools and Docker/Compose availability | Prerequisites are usable; failures are classified before running the suite |
| Development | Focused behavioral regressions, affected types and formatting | Each fix has relevant passing evidence, and independent review is integrated |
| Final source | Canonical `pnpm check`, `pnpm build`, and applicable dependency/license/static checks | Required commands pass on the final source; cache reuse and opt-in skips are explicit |
| Local services | Required migration, API, restore, scoped search and privacy runbook steps | Executed integration counts and exact readiness/loopback evidence are recorded |
| Delivery | Review final diff, staged contents, modes, secrets, approved commit/push; inspect automatic checks | Local/tracking/live-remote relationship and each workflow's observed state are recorded |

`pnpm check` includes Compose policy tests: prove the genuine Docker and Compose
CLI versions first. These tests parse configuration without contacting a daemon;
a stopped engine alone does not require a disruptive restart. If WSL integration
is unavailable, an already installed, integrity-verified Linux CLI may be staged
in an ignored owner-private directory with per-command PATH/plugin configuration
and a nonexistent local daemon socket. Record provenance and versions, use the
unchanged tests, and leave system/user configuration alone. Do not simulate CLI
output, skip assertions or treat this as working service integration. Service
checks still require the actual local engine and their guarded lifecycle.

Use existing guarded lifecycle, restore, scoped-key and privacy commands. Run
tests sharing a database, index, or fixture serially. Keep the root test graph's
reviewed concurrency of two. Do not run another root check/build while client
agents are still changing the tree or building overlapping outputs.

A synthetic browser journey needs a complete local core nutrient registry from
checked-in definitions, even when its private food quantifies only one nutrient.
An incomplete registry must keep reports unavailable; do not relax report integrity
or replace missing nutrient amounts with zero. Record local fixture initialization
separately from application changes and live catalogue acquisition.

For a web presentation slice, an isolated loopback synthetic upstream can exercise
the actual web client and BFF when the engine is unavailable. Keep normal auth,
origin, parser and session-cookie guards; label every fixture route and failure
mode in the evidence. This proves that bounded browser flow only. It cannot
replace a required real API/database, cross-owner, restore or privacy integration
run, nor make earlier backend evidence fresh.

During development, rerun the affected checks after a fix. At the final checkpoint,
run the required applicable ladder once after integration and review. A later edit
invalidates evidence for its dependencies; repeat those checks and any required
final gate. Do not label an inherited run as fresh or a cached result as newly
executed. If scope is unclear, use the broader required gate.

| Changed input | Evidence to reconsider |
| --- | --- |
| Dependency manifest, lockfile, toolchain, install configuration | Strict frozen install, dependency checks, audit/license and affected builds/tests |
| Client state, BFF, identity or navigation | Client behavior/type/build checks and relevant cross-owner, stale-response and integration paths |
| API, schema, database authority, retained data or privacy | Database/API integrations, migration/readiness, restore, export/erasure and relevant clients |
| Runtime, Compose, infrastructure, deployment policy | Boundary/static contracts, affected service/restore evidence and supply-chain gates |
| Roadmap or explanatory prose only | Diff, references and consistency with actual source and release rules |

This table helps select development checks; it does not exempt a release from any
required gate. Freshness-sensitive external evidence still needs revalidation.
The local production audit retains its action-specific authorization boundary.
Automatic hosted audit evidence is recorded separately.

## Reliable command and evidence capture

Run application commands in the Linux checkout. Prefer direct WSL arguments for
simple operations, or one reviewed Bash script for a multi-step sequence. Avoid
rebuilding nested PowerShell/Bash/Node quoting for every integration run. Reuse
the tracked runners before inventing another wrapper.

Write logs only into a fresh ignored directory created with `umask 077`. For each
command record UTC start/end, exact non-secret argv, exit status, source identity,
log path, executed/passed/skipped test counts, and whether the result was cached.
Record an end time on failure too. Do not log raw environments, secret command
arguments, private fixture payloads, or credential files. Harness and transport
failures remain in the record even when a corrected invocation later passes.

Before staging, check the final diff and preserve unrelated changes. Commit only
explicit paths. Existing approval for normal branch commits/pushes never implies
force-push, workflow dispatch/rerun/cancel, deployment, cloud spending, DNS,
firewall/tailnet changes, phone exposure, EAS/signing, or live catalogue actions.

## Completion vocabulary

Keep the build plan's existing **implemented** definition: source plus required
local and applicable exact-commit automatic evidence. **Source/local complete**
remains narrower when automatic evidence is pending. The labels below make each
dimension explicit; they do not redefine those existing terms.

- **Source complete:** implementation and review are finished.
- **Local verified:** the named required local gates passed on the recorded tree.
- **Automatic checks pending/passed/failed:** exact commit and separate observed
  CI/supply-chain states; an earlier green commit does not transfer this status.
- **Release accepted:** every applicable hosted, data, device, reviewer, and
  release gate is satisfied and its decision is explicitly approved.

Report the user's new capability first, then validation and material limitations.
Do not describe unit tests, source bundles or synthetic data as physical-device,
live-catalogue, or production acceptance.
