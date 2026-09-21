# ADR 0101: Stage and seal a bounded full-FDC CSV export through a restricted login

Status: Delivered at `772e10d92913b41307e46ff8977834c47ddbe167` after reviewed
source and test corrections, local canonical gates and the approved bounded
PostgreSQL rehearsal. All three CI and nine actual container jobs passed at that
exact commit, observed September 20, 2026 at 23:26 UTC. C1 and release acceptance
remain open.

## Context

[ADR 0100](0100-fdc-csv-normalized-record-export.md) exports verified normalized
records without a release-sized array. The existing Foundation JSON command uses
owner-oriented helpers and does not consume that format. Checklist
[C1](../product/beta-exit-checklist.md) needs an actual restricted-capability
consumer before the remaining authority and scale work can proceed.

Migration 0020 currently caps one batch at 10,000 records and 64 MiB of PostgreSQL
canonical-payload text. It caps one request at 250 records and 16 MiB, and each
canonical payload at 1 MiB. Its chunk accounting scans accumulated records and
its seal aggregates their metadata. Therefore this package proves bounded
full-CSV-format integration, not consumer-scale full-catalogue readiness. It
neither raises those caps nor splits a release to evade them.

## Decision

Add `catalogue stage-fdc-csv` with one manifest and six mandatory options: records
path, complete-export SHA-256 and byte size, reviewed nutrient-mapping SHA-256,
authenticated release-evidence bundle, and immutable manifest object URI. Require
current import-ready manifest-v4 evidence, authenticated runner binding and the
reviewed parser build independently of the export's non-authority header. Source
and reviewed mappings must already exist; this path cannot register either. The
provided mapping digest is a reviewed input pin; matching it against the registry
remains the independent validator's responsibility. The seal retains actual
mapping revisions.

Before opening PostgreSQL, verify the entire canonical NDJSON file into a private
anonymous Linux snapshot. Check exact header/record/footer fields, manifest and
parser identities, complete baseline, conservation and ordered semantic count and
digest, whole-file SHA/bytes, canonical UTF-8 and every size/record limit. Use a
conservative PostgreSQL JSONB rendering bound, including whitespace and possible
numeric exponent expansion; compact JSON length is not that database limit.
Preflight the final escaped parser-report request as well. Invalid, truncated,
tampered, over-cap or aborted verification opens no database. Retain at most a
bounded line/page and the small list of deterministic page endpoints, not a
release-sized record array.

The actual session must be a non-owner, non-privileged login with exactly one
catalogue capability: `nutrition_catalogue_stage`. Reject effective-role changes,
owner membership, superuser/administrative flags and other catalogue capability
memberships. This command guard does not replace the broader deployment ACL and
credential-cutover evidence. Use only the existing stage-batch, record-chunk and
parser-report capability functions; no owner DML, registration, validation,
approval, promotion or activation helper is called.

Create/resume with immutable manifest, artifact, source, parser and mapping pins.
The manifest's reviewed semantic digest binds the record sequence. Reverify the
entire export on each invocation. Pages obey both the 250-record and encoded
16-MiB request caps. SQL atomically saves each chunk and checkpoint. Resume only
at a verified deterministic page boundary and replay at most the preceding page:
the existing SQL contract permits a replay whose end equals the current offset,
not arbitrary full-prefix replay. Strict receipts must reconcile offset, counts,
insert/replay disposition and hashes.

After all records are staged, record the immutable parser report and seal. A
complete checkpoint can already be sealed, so retry the seal directly without
trying to append chunks. Whole-export SHA/bytes are bound in this final report;
the existing batch schema does not bind that envelope at initial creation. The
report retains raw CSV conservation and explicitly identifies derived label
servings in its effective portion counts. Successful output says `staging` and
`validationPending: true`. Interruption during partial chunk staging leaves a
non-current, unsealed attempt. A committed seal can survive a later receipt,
abort or cleanup failure without confirmed CLI success; explicit identical retry
checks its immutable evidence. There is no automatic mutation loop.

## Consequences and alternatives

A normal operator can stage a verified small export without giving the CLI owner
credentials. Raising SQL limits without changing accumulated-row scans, aggregate
seal construction and the whole-batch validator would misrepresent scale. Those
require a separate coherent authority/validation redesign and measured resource
and lock evidence. C1 and C2 remain open. An export is never acquisition, mapping,
rights, independent-review or activation approval.

An anonymous private snapshot avoids consuming a pathname that could be replaced
after verification. Directory and descriptor checks, exact cleanup and failures
remain explicit; this does not defend against an administrator or hostile process
with the same operating-system identity. Process termination is distinct from the
injected abort and SQL-failure cases. No automatic database deletion is performed
by the command after failure.

## Required proof and review triggers

117 focused cases passed (49 reader, 37 wrapper and 31 actual-command cases),
with affected types and nine-file scoped Biome. They cover pins, canonical bytes,
size limits, late failure/no writes, restricted-principal and malformed-receipt
rejection, page boundaries, replay, abort and resource cleanup. One added
always-on offline regression verifies the synthetic export and expected baseline
proposal; earlier fixture failures remain recorded.

The separately approved September 20, 2026 rehearsal passed both the fixture
regression and the actual PostgreSQL case. The latter used the actual
inspector/exporter and stage-only login for 251 synthetic records, a page-two SQL
failure, checkpoint/resume, immutable seal retry, denied direct DML and unchanged
activation/approval/outbox state. Its owner setup and temporary roles existed only
in the disposable test cluster; owned-resource cleanup passed.

The final reviewed clean-checkout fixture correction passed canonical check/build
and was normally pushed at `772e10d`. All three actual CI35534927910 jobs and all
nine actual container35534927970 jobs passed on attempt one. Final 23:26 UTC
verification recorded clean matching local/tracking/live heads and all 18 reviewed
working-tree/committed hashes. Earlier commits' calendar-dependent test failure
and missing-parent fixture failure remain recorded, alongside their corrections.
See [current readiness](../quality/current-readiness.md) and the outside-Git
checkpoint; skipped or cached results are not new service proof. The
consumed installation/service approval covered this isolated rehearsal only. No
live archive, target cutover, production audit, signed-client or deployment
authority follows from it. Revisit this decision for new caps,
resumability/schema changes, independent validation, mapping authority or
representative-scale execution.
