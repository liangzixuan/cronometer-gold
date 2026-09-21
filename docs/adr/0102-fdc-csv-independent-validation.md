# ADR 0102: Prepare and submit bounded full-FDC validation as a separate login

Status: Source and bounded local proof complete; exact-commit automatic delivery
pending. Independent review, focused checks, canonical check/build and the approved
PostgreSQL rehearsal passed. C1 and release acceptance remain open.

## Context

[ADR 0101](0101-fdc-csv-capability-staging.md) is delivered at `772e10d` after
its bounded PostgreSQL rehearsal, reviewed corrections, final canonical gates
and all three CI/nine actual container jobs. It ends at an immutable parser seal.
The legacy validator uses owner-oriented table access. Checklist
[C1](../product/beta-exit-checklist.md) still needs an actual independent,
restricted-login consumer of the existing validation capability.

A database acknowledgement can be lost after validation commits. Observing the
batch again changes the observation because its status and frozen record fields
have changed. Rebuilding a request from that new observation cannot establish an
identical retry. The original PostgreSQL observation hash also covers PostgreSQL
JSONB text, not JavaScript canonical JSON; these serializers must not be confused.

## Decision

Add two commands for the bounded USDA_FDC full-CSV report kind introduced by
ADR 0101. Both require an actual non-owner, non-privileged login with exactly the
`nutrition_catalogue_validate` capability, without an effective-role change. The
database independently requires a validator distinct from the staging principal.
No actor flag, owner helper, direct DML or `SET ROLE` substitutes for that login.
This establishes the bounded database-session boundary only; authenticated
external identity, credential issuance/cutover and target authority acceptance
remain separate work.

`catalogue prepare-validation` takes a batch ID, reviewed staging-seal and
nutrient-mapping SHA-256 pins, a private output path and a complete explicit
six-field policy. The three numeric thresholds have no defaults. This consumer
requires distinct approval principals, at least one valid record and a
materialized nutrient per valid record to be explicitly true. These inputs
remain reviewed policy; the command does not derive thresholds from the data to
make a candidate pass.

Preparation calls the public observation capability, strictly checks its shape,
batch/seal/mapping/provenance/parser/count bindings and pending record state, and
uses the existing pure record validator and policy evaluator. The mapping digest
reuses the existing normalization and hashing algorithm. The request preserves
the server's opaque observation token, validator database principal, exact
canonical validation document, document byte size/hash, validation digest,
staging seal, mapping and parser-report hashes, and explicit policy. It does not
claim that recomputing a client hash verifies the server observation token.

Only after database cleanup succeeds does preparation publish the private
canonical request. It lives directly beneath
`.local-data/evidence/catalogue-validation/` in the Linux checkout, with
mode-0700 directories and a mode-0600 regular file. Publication uses a unique
temporary file, file synchronization, exclusive final linking and directory
synchronization; it never overwrites retained evidence. Output contains the
path and whole-file SHA-256/byte count, not the private record payloads. A failure
after publication may leave a complete request; preserve and inspect it instead
of replacing it automatically.

`catalogue submit-validation` requires that same file plus its exact SHA-256 and
byte-size pins and batch ID. It verifies private ownership, regular-file and
directory identities, canonical UTF-8 bytes, internal request/document bindings
and policy before opening PostgreSQL. It then verifies the actual validator
login and invokes only public `catalogue_validate_import_batch`, including the
migration-0021 independent nutrition semantic recheck. It never re-observes or
rebuilds the document. Fresh and replay receipts have distinct required fields;
both require the semantic contract version/hash and the original validation and
mapping digests. Success is reported only after required database cleanup.

After an uncertain submission, repeat the exact submit command against the
retained file. The SQL path verifies the original digest and document. Do not
prepare a replacement, change thresholds, edit the file or silently retry a
different request. A policy failure can validly produce a quarantined batch;
successful execution does not imply promotion eligibility, approval or activation.

## Limits and alternatives

No migration, capability, policy evaluator or SQL cap changes. Staging remains
10,000 records/64 MiB per batch, 250 records/16 MiB per stage request and 1 MiB
per canonical record. Observation and validation-document limits remain 128 MiB,
with the existing 120 MiB digest-document and per-record subdocument limits.
The private outer request has a 256 MiB transport ceiling because it contains
the escaped SQL document; that does not increase any SQL or staging limit.
This still holds a bounded batch in memory. It neither claims representative
full-catalogue scale nor partitions a release to bypass existing caps.

Using the old owner validator would not prove independent authority. Rebuilding
on each retry would lose the original evidence identity. Raising caps or removing
the semantic recheck is not a substitute for either missing proof. CNF, legacy
report formats, remaining shared writers, direct-DML revocation, authenticated
external identity/caller cutover and measured resource/lock budgets remain open.

Private filesystem checks do not defend against a hostile administrator or a
process controlling the same operating-system identity. Synthetic fixture roles
are not independent human reviewers or target workload identities. This package
closes only a bounded C1 source prerequisite; all six beta exits remain open.

## Proof and review triggers

Required offline proof covers strict session/observation/request/receipt
decoding, parser conservation and mappings, explicit policy, private atomic
publication, unchanged exact retry, wrong file/batch/pins, cleanup and errors.
Independent in-task review must examine the authority boundary and retry protocol.
Affected types, scoped Biome and final frozen canonical check/build remain required.

The separately approved disposable PostgreSQL rehearsal must execute the actual
ADR0101 stage command and both new commands with different expiring logins,
prove read-only preparation, denied owner/stager/wrong/multiple-capability access
and direct DML, stale/tampered request rejection, migration-0021 semantic rollback,
policy quarantine, and exact replay after a committed response is lost. Existing
approval/release/current/index/outbox state must remain unchanged. Preserve
failed attempts and opt-in skips; neither is a pass. Local service execution,
normal source delivery and target/release acceptance retain their separate gates.

On September 21, 2026 at 00:14:49-00:15:01 UTC, the approved rehearsal passed
on its first attempt: all four cases executed, including the actual restricted
PostgreSQL stage/prepare/submit/retry case. This adds one real integration case
to the 115 focused offline cases; the three fixture cases were re-executed.
Independent validation, lost-response exact replay, semantic rollback, denied
authority and policy quarantine passed with approval/activation state unchanged.
Owned container and generated credentials were removed. Docker service/socket
and containerd ended inactive/disabled, with permanent group membership unchanged.
No retry, installation, pull or live data was used. Current readiness records the
exact log and hash; earlier failed development attempts remain outside Git.

Revisit for format expansion, policy changes, new limits, paging, authority
cutover, multi-validator handoff or any change to the persisted retry contract.
