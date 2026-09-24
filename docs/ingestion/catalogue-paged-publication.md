# Paged catalogue publication

Status: ADR0105 source review, offline checks and approved PostgreSQL attempt 2
passed. All 12 cases executed without failures or skips: the 251-record publication
lifecycle, authority and restore canaries, and nine endpoint fixtures. Cleanup
completed. Attempt 1's authority failure and its reviewed transaction-ownership
correction remain recorded; final delivery and automatic evidence are pending. See the
[dated result and limits](../adr/0105-catalogue-paged-publication.md#rehearsal-checkpoint-september-24-2026-utc).
This runbook does not authorize a service session, acquisition or live activation.

Publication consumes a sealed, independently validated and reconciled V2 batch
with separate data, quality and rights decisions. The quality reviewer admits a
fixed publication budget and names a distinct publisher. SQL checks the actual
restricted login. A command-line identity cannot grant authority.

## Retained commands

Every mutation uses two commands. `prepare-publication` writes a private exact
request without connecting to PostgreSQL. `submit-publication` verifies its file
hash and byte count, submits its retained SQL document, verifies the receipt,
closes the connection and writes a separate private receipt file.

```text
ingest catalogue prepare-publication <operation> <operation options> --request-out <private-json>
ingest catalogue submit-publication <operation> --request <private-json> --request-sha256 <file-sha256> --request-bytes <file-bytes> --receipt-out <private-json>
ingest catalogue read-publication <batch-uuid> --authority <publisher|rollback>
```

Request and receipt paths must be new files directly beneath
`.local-data/evidence/catalogue-validation/` in the Linux workspace. Directories
must be owned by the current user with mode 0700; files use mode 0600. Existing
files are never overwritten. File SHA-256 and byte count bind the complete
retained envelope. Its `requestSha256` binds the contained SQL document and is a
different digest. Retain both. Requests are limited to 65,536 UTF-8 bytes and
retained envelopes to 262,144 bytes at submission.

| Operation | Required operation options |
| --- | --- |
| `admit` | `--batch-id`, `--context-sha256`, `--validation-terminal-sha256`, `--report-sha256`, `--publisher-principal`, and all seven budget options below |
| `begin` | `--batch-id`, `--admission-sha256` |
| `materialize` or `verify` | `--batch-id`, `--publication-sha256`, `--page-number`, `--first-sequence`, `--previous-receipt-sha256` |
| `finish` | `--batch-id`, `--publication-sha256`, `--previous-receipt-sha256` |
| `activate` | `--batch-id`, `--publication-sha256`, `--seal-sha256`, `--expected-current-release-id`, `--reason` |
| `rollback` | `--source-code`, `--target-release-id`, `--expected-current-release-id`, `--reason`, `--request-id` |

Budget options are `--max-records`, `--max-materialization-bytes`,
`--max-intermediate-bytes`, `--max-evidence-bytes`, `--max-cutover-food-rows`,
`--max-cutover-barcode-rows` and `--max-cutover-bytes`. Each is an explicit positive
decimal integer. Page numbers and sequence offsets are zero-based decimal
integers. Use `none` explicitly for an absent expected or target release. A null
rollback target deactivates the source. The publisher and rollback operator use
their respective distinct restricted connections.

The admission's context digest is the reconciliation context. The original
validation context remains separate and continues to bind nutrition semantics.
Do not substitute either context for the other.

## Progress and recovery

1. The quality reviewer retains and submits `admit` after reviewing the complete
   batch and its resource envelope. The named publisher then retains and submits
   `begin` with the returned admission digest.
2. While the read context says `materializing`, use its `nextSequence`,
   `pageCount`, `publicationSha256` and `lastReceiptSha256` in the next retained
   `materialize` request. SQL selects at most 250 frozen records within the page
   byte cap; callers cannot supply replacement food documents.
3. When the phase becomes `verifying`, use `verifiedSequence` and
   `verifiedPageCount` for each retained `verify` request. Verification rechecks
   persisted food versions, nutrients, servings and the materialization chain.
   Finish only after verified coverage reaches the materialized record extent.
4. Retain `finish` with the final receipt digest. A sealed publication is still
   invisible. Its separate `activate` request binds the seal, expected current
   release and reviewed reason.
5. Use a new retained `rollback` request for an explicitly chosen historical
   target or deactivation. V2 transitions use this versioned consumer. The legacy
   path remains responsible for pure V1-to-V1 rollback.

After connection loss, cancellation or a missing local receipt, preserve the
request file and pins. Retry `submit-publication` with those exact bytes and a
new receipt destination. Never regenerate an uncertain request from the latest
cursor. A stored receipt describes its original operation; read the context
separately to inspect current progress. A terminal retry cannot reactivate a
release superseded by another activation.

Cancellation before mutating SQL is dispatched prevents the mutation. Once
dispatched, loss of the client result leaves an uncertain outcome, which requires
the retained request. Receipt validation runs inside the transaction; invalid
receipts roll back. Required connection cleanup precedes local receipt publication.

## Visibility and resource acceptance

Preparation creates off-current immutable versions. Public search, exact barcode
lookup, diary selection and recipe selection continue to use the active release.
The final transaction updates food pointers, archives removed foods, replaces
barcode assignments, records activation and enqueues its event atomically.
It is O(N) in affected source rows and requires measured acceptance.

Publication transactions cap lock wait at two seconds and statement duration at
thirty seconds, preserving tighter caller settings. These settings are local to
the transaction. The connection's usual fifteen-second statement timeout remains
in force when it is the tighter limit. Record failures without changing these
limits to obtain a pass.

Budget checks cover retained and materialized data plus the planned cutover.
Their conservative accounting does not replace measurements of PostgreSQL
storage, WAL, lock duration, process memory or search rebuild behavior. The
historical ADR0104 staging/validation measurements are not publication evidence.
A source change or successful PostgreSQL activation does not qualify the full
USDA catalogue or the Meilisearch index.

External changes to the pinned dependencies invalidate an unfinished publication,
including away-and-back changes. The publication tracks only its own committed
generation changes. Never reset its validation context, suppress generation
triggers, fabricate legacy completion fields or remove the public eligibility
conditions to resume it.

Authority verification compares the public eligibility view with the reviewed
source query using a temporary view in an owned savepoint. Existing transactions
must be passed as Kysely Transaction objects. The helper rolls back its scope on
success and failure, preserving caller state; standalone calls own their outer
transaction. This temporary DDL is part of the separately approved rehearsal; it does not create a persistent application object.
