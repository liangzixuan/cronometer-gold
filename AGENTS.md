# Project instructions

Read `docs/product/build-plan.md` and `docs/quality/development-workflow.md` before
continuing a milestone. Keep applicable review, validation and release gates.
Work in the WSL Linux-filesystem checkout and preserve unrelated user changes.

## Standing commit and push authorization

The user authorizes normal commits and non-force pushes for this project's
authorized work without further confirmation. Review the diff, pass applicable
checks, commit explicit files and push to the project's existing remote and
working branch. Do not ask for separate approval of individual commits or pushes.
Record local, tracking and live-remote state and exact automatic workflow results.

This authorization does not permit force-pushes, destructive history changes,
manual workflow dispatch/rerun/cancel, deployment, cloud spending, DNS,
firewall/tailnet changes, phone exposure, EAS/signing or live catalogue actions.
Those actions retain their existing approval and release requirements. Never
commit secrets or machine-local data, or weaken a gate to make validation pass.

## Proportionate review and paid external review

Routine source work uses applicable checks, independent in-task review and CI.
The completed Claude review at `805b937` remains evidence only for its recorded
scope; it does not require a paid review of every successor or remediation.
Obtain explicit user approval of scope and spending limit before initiating or
asking the user to run another paid external review. Batch such reviews around
a meaningful milestone or specific unresolved risk. Keep in-task review
proportionate too: it consumes Codex usage. Avoid redundant passes, unnecessary
review packets and status-only commit/build cycles. Preserve all formal reviewer,
signed-evidence, device and release acceptance gates.
