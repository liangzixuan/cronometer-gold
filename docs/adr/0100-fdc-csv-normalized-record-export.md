# ADR 0100: Export verified full-FDC normalized records with bounded writes

Status: Implemented and independently reviewed; focused validation passed.
Final canonical and exact-commit automatic evidence pending at source freeze.

## Context

The full-FDC CSV inspector joins and normalizes accepted foods, computes their
canonical semantic digest and then discards the records. A future bounded staging
consumer needs those exact records without reconstructing the joins or retaining
a full release array. The approved [beta exit checklist](../product/beta-exit-checklist.md)
prioritizes this C1 prerequisite over further incremental client features.

## Decision

Add an optional awaited `onAcceptedRecord` callback to the parser input. Each
accepted record is provisional until the complete parse resolves: later input,
identity, conservation, digest or cleanup failure invalidates the attempt. A sink
failure is fatal even if its error resembles an ordinary row-disposition error.
It must never turn a valid record into a quarantine. Existing inspection behavior,
semantic ordering and baseline evidence remain unchanged when no sink is supplied.

The actual consumer is opt-in `fdc inspect-csv --records-out` within the private
Linux workspace evidence directory. It writes one canonical NDJSON artifact with
an identity and explicit non-authority header, accepted record lines, and final
evidence footer. Writes are awaited with a separate hard ceiling of
6,000,000,000 bytes including header and footer; there is no CLI budget override
or release-sized array. The output is a single `.ndjson` basename directly under
`.local-data/evidence/fdc-csv-records`, with no nested output directory. Export bytes do not change the existing parser's
partition/resource baseline. Record-line count and SHA-256 must exactly equal
`semanticEvidence.canonicalAcceptedRecords`; the complete-file digest is separate.

Keep provisional output in an owner-only temporary file. Publish atomically with
no overwrite only after all parser identity/cleanup checks, exact manifest baseline
comparison and exported-record reconciliation pass. Baseline proposals may still
be reported, but cannot publish a normalized export. Abort, write/budget, late
parse, digest/count or parser-cleanup failure must prevent publication. Publication
or post-link cleanup failure must never report successful completion: remove only
an exactly identified owned final artifact when safe, preserve replacement paths,
and retain any cleanup failure or uncertain outcome for inspection. A leftover
path is not an accepted export. Reject unsafe paths and symlink escapes and reuse
existing private evidence-publication conventions.

The file is local parser evidence only. It supplies no authenticated acquisition,
rights, reviewer, staging, promotion or activation authority. It opens no database
and cannot make a candidate import-ready. Live manifests and source-release gates
remain unchanged. Full-CSV database staging, authority cutover and representative
real-data memory/lock/search/rollback acceptance remain unfinished C1/C2 work.

## Consequences and alternatives

The operator can retain the exact normalized records and their evidence as one
bounded handoff. Returning an array would recreate the full-catalogue memory gap.
Publishing records before final verification would expose a misleading partial
artifact. Two separate payload/receipt files would require a new multi-file
publication protocol. A single versioned artifact keeps the evidence together.

The callback is not a transaction or release-approval API: consumers must avoid
irreversible effects for provisional records. This first consumer writes only a
private unpublished file. Future database consumption must independently validate
the complete artifact and retain all existing import/authority gates.

## Validation and limits

Independent in-task review and 85 focused cases passed: 39 parser, nine actual
CLI and 37 publisher cases. Evidence covers unchanged default inspection, exact
semantics/order/digests, multiple partitions, awaited slow sinks, fatal typed sink
errors, late parsing and final parser-cleanup failure, injected AbortSignal,
byte limits, stale baselines, no-overwrite/path guards, replacement preservation
and post-link cleanup/sync/close failures. CLI cases prove zero database openings.
Both affected type checks and six-file scoped Biome passed. Final canonical
`pnpm check`/`pnpm build` and exact-commit three CI/nine actual container jobs remain
required; the outside-Git checkpoint records their outcomes.

AbortSignal evidence is not operating-system kill recovery. The CLI entry point
has no new signal handler, and process death may leave private unpublished files.
There is no recovery/resume consumer or proof against a hostile same-user process;
a future consumer must independently validate the complete artifact.

No new dependency, schema, live acquisition, service, production audit, paid
review, device, hosting or deployment action is part of this source slice.
Synthetic bounds are not representative real-data resource measurements.
