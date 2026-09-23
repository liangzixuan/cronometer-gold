# ADR 0104: Prepare catalogue batches in bounded pages through review

Status: Source review and required local validation passed. Exact-commit automatic
checks are pending. All six beta exits remain open.

## Context

[ADR 0103](0103-catalogue-review-handoff.md) is delivered at `007a17d`.
Its bounded staging, validation and reconciliation path retains whole-batch
limits and snapshots. Raising those limits would increase memory and transaction
cost without establishing a reviewed resource bound. The user selected U.S. first
with the full April 2026 USDA CSV release as the intended beta catalogue, then
explicitly approved this source package. That selection is an acceptance target;
the release bytes have not been acquired or qualified by this work.

## Decision

Add preparation protocol version 2 in companion tables, migrations 0027–0030.
Preserve the existing batch protocol, caps and digest meanings. A new preparation
does not populate legacy validation or activation fields. Incompatible legacy
readers, reviewers and promotion consumers reject it before whole-batch work or
mutation. Version 2 stops at review; it cannot publish or activate a catalogue.

A distinct quality reviewer records an immutable admission binding the source,
release, artifact, manifest, normalized export, parser, intended staging login and
seven explicit record/byte budgets. The staging login cannot approve its own
budget. The verified export reader checks those actual SQL admission limits
before allocating its private snapshot. It streams ordered bounded pages; SQL
retains exact payload text, receipts and accounting. A separate sealing pass
rechecks ordered records before producing terminal evidence.

The new framed SHA-256 format uses UTF-8 byte lengths, a versioned namespace and
domain-specific ordered fields. Counts are strict unsigned decimal strings.
SQL and TypeScript retain the original text rather than assuming JSONB formatting
reproduces canonical client JSON. Golden vectors cover both implementations; the
SQL vectors require the separately approved PostgreSQL rehearsal.

An actual, restricted validation login independently reads sealed pages. SQL
checks identity, per-record nutrition basis and values, counts, mappings and
barcode dependencies; TypeScript additionally validates normalized names,
portions and its food-document contract. These scopes remain distinct. A frozen
generation records mapping, canonical-nutrient, source and barcode changes,
including changes away and back. Drift permanently invalidates the context in
this version. There is no reset, budget refund or replacement-context operation.
Recovery from that condition needs a separately reviewed protocol decision.

The client retains each exact validation request and context privately before
submitting it. A journal append has bounded state; recovery streams and verifies
the complete retained chain before further mutation. Lost acknowledgement stops
the invocation. An explicit retry uses the same request and accepts only its
matching stored receipt. It never substitutes a newly computed request.

Reconciliation runs through the restricted validation capability in bounded
metadata, baseline, candidate and removal phases. Its version-3 report binds
validated terminal evidence, the prior current baseline, ordered pages, counts
and resource accounting. Existing version-1 baselines need their frozen mapping
and validated-food evidence; older unbound baselines fail closed. The report
writer retains private pages and publishes terminal evidence only after required
connection cleanup. Each actual data, quality or rights reviewer submits an
explicit decision bound to the report, context and validation terminal. Exact
decision retries preserve identity and outcome. Approval leaves activation
unchanged and does not assign an external reviewer identity.

Authority evidence and restore policy pin the new functions, body hashes,
search paths, grants, triggers, companion relations, columns, constraints and
indexes. The protocol adds 49 functions, 54 triggers and 14 companion tables.
The deployment evidence version becomes 7 and restore fingerprint version 15.
Restoration must satisfy the source-defined policy; observed database objects
cannot redefine that policy. Existing capability roles remain restricted and
unassigned outside specifically authorized synthetic fixtures or target cutover.

Legacy approval attestation pins the function body after migration 0030 adds
its version-2 rejection guard. The legacy caller must use that same body pin as
deployment and restore verification; retaining the pre-migration pin rejects
healthy version-1 approvals.

The preparation and validation record tables are reverse-foreign-key descendants
of `food_import_record`, so the privacy schema inventory classifies both explicitly.
They are catalogue metadata excluded from personal exports. Erasure attests their
exact parent keys and delete actions, and still rejects any catalogue ingestion
record linked to a privately owned food. Unknown user-linked tables and changed
relationships continue to block export or erasure.

## Validation and limits

The acceptance package requires focused protocol, reader, journal, command,
validation, reconciliation and authority tests; affected types and formatting;
independent state and boundary review; canonical check/build; then a separately
approved PostgreSQL session on frozen reviewed inputs. Preserve earlier failures
and label opt-in skips accurately.

Canonical JSON encoding bounds each yielded chunk to 64 KiB, including long
string values and property names. Native escaping works on slices of at most
8,192 UTF-16 code units without splitting valid surrogate pairs. Concatenated
UTF-8 bytes and existing hashes remain exact. This bounds intermediate escaping
and write chunks; it does not establish the process RSS limit.

Canonical JSON utilities also have a narrow public package entry point. The
retained-request writer and validation journal use that entry point, avoiding
the unrelated application modules loaded by the full database barrel. Existing
exports and serialization implementations remain identical. This reduces module
loading in the production helpers and the source rehearsal; it does not remove
tests, alter the resource metric or establish a PostgreSQL resource pass.

The preparation rehearsal lives in `apps/ingest/test` so it can exercise the
production journal without a database-package dependency on application code.
It retains exact page requests and their pre-submit contexts before SQL, records
accepted acknowledgements, and finalizes the journal after validator connection
cleanup. Reconciliation consumes the production reader on each attempt. The
same restricted validator is reconnected with its original statement and lock
timeouts. The manual SQL tamper, exact-retry, authority and restore checks remain
part of the rehearsal. The preparation checkpoint preserves journal creation, finalization and reading
memory. The final resource metric includes the test process through logical
restore and owned database, role and connection cleanup. It retains the earlier
peak and uses the maximum of earlier and final observations without subtraction.
The existing resource limits remain unchanged; test-runner teardown and child
process memory are outside this in-process observation.
Historical runs using custom request/receipt wrappers do not prove this path.

The approved synthetic workloads at 12,500 and 25,000 records passed through
logical restore and owned cleanup on September 23, 2026. Their original peak
measurements were 253.35546875 and 250.9609375 MiB; growth was -2.39453125 MiB,
within the unchanged 256 MiB peak and 32 MiB growth limits. Each workload executed
55 cases with zero skips, including one actual PostgreSQL case, and restored
107 tables. These measurements retain their original source identity and narrow
2.64453125 MiB minimum headroom; they are not a general resource guarantee.

Later authority checks exposed policy-ordering and test-fixture defects. Those
were corrected without changing constraint definitions or privileges. The final
authorized canary session passed both actual database cases and nine endpoint
fixtures with zero skips, including the complete tamper sequence. Original memory
proof is carried forward explicitly; only the compiled authority-policy JSON
order differs among its runtime pins. All previous failed sessions remain
recorded. Owned resources were removed and services stopped after every retained
confirmation session. The current source passed focused checks, affected types,
formatting and canonical check/build. No further service run is authorized by
this ADR or the source approval.

Synthetic records with padding do not establish full-CSV parsing, actual USDA
coverage, search quality or full-candidate performance. Prepared mapping-drift
tests do not establish executed cross-source barcode or canonical-definition
drift evidence. Full-candidate resource and lock proof, compatible publication,
authenticated external identities, credential/caller cutover, target canaries,
rights and catalogue acceptance remain required under checklist C1/C2.

## Alternatives and review triggers

Increasing version-1 caps leaves its whole-snapshot and irreversible terminal
operations in place. Reusing legacy validation columns would let incompatible
consumers misread a partial or differently hashed result. Separate state and
explicit consumer fences keep those meanings stable.

Revisit this decision for changed framing, semantic scope, admission budgets,
dependency generations, invalid-context recovery, baseline compatibility,
publication, deployed roles, privacy inventory or restore policy. No catalogue
activation or controlled-beta exit follows from source delivery alone.
