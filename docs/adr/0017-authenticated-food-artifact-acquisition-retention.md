# ADR 0017: Authenticated food-artifact acquisition and retention evidence

- Status: Accepted for source-contract implementation; live runner, immutable
  storage, and acquisition remain blocked
- Date: 2026-09-04

## Context

M0 requires two genuinely independent acquisitions of one publisher artifact.
A raw SHA-256 observation does not prove who initiated the transfer, which
reviewed runner executed it, whether a cache was shared, or whether the matching
object was retained without overwrite. Bucket versioning or an infrastructure
`prevent_destroy` setting does not prove object retention.

The ingestion CLI can stream and hash an allowlisted HTTPS artifact, but it does
not authenticate an identity token, create a remote immutable object, or verify a
storage retention rule. No approved acquisition workflow, identity broker,
dedicated food-release bucket, or second authenticated operator currently exists.

## Decision

Each qualifying transfer receives a version-1 authenticated-acquisition sidecar
created only after the approved runner verifies OIDC or workload identity. It
binds the fresh HTTPS observation to a canonical operator principal; issuer,
subject, audience, method, and verification time; distinct run ID and immutable
run reference; repository, workflow, full ref, and Git source object ID; and a
dedicated no-shared-cache context.

The two sidecars require distinct normalized principals, authenticated
issuer-subject identities, acquisition IDs, run IDs, run references, and context
IDs. They must agree exactly on tool identity, canonicalized requested/resolved
query-free HTTPS URLs, SHA-256, byte size, and reviewed runner source. The CLI
derives its tool identity from co-located package metadata and rejects
caller-authored actor or tool options.

A third, separately authenticated storage workload creates the raw object and a
version-1 retained-artifact receipt. The receipt binds its verified identity to
provider namespace, bucket, object key/version, media type, SHA-256, byte size,
and a credential-free S3 URI containing `/sha256/<digest>/`. It requires
conditional creation against an absent object, a no-overwrite result,
service-verified SHA-256, and enforced retention that was active when the receipt
was recorded. Its authenticated issuer-subject identity and normalized principal
must differ from both acquisition actors. Versioning and deletion
protection are supporting controls only. Governance retention is review evidence,
not irreversible compliance approval; provider, duration, override policy, and
any irreversible lock remain separate decisions. A later authority decision must
revalidate current retention from the provider rather than treating the recorded
status as perpetual.

The ingestion package exposes pure structural parsers and a deterministic
assembler. It performs no token, signature, network, storage, or provider-policy
verification. The approved runner and retained evidence store establish
authenticity. The assembler canonicalizes both sidecars, verifies agreement and
chronology against one receipt, and emits only frozen
`pending-review`/`not-granted` evidence. It never edits a manifest, grants import
readiness, creates a batch, stages data, approves or promotes a release, or
switches a search alias.

Any observation, identity, runner-source, storage, checksum, canonical-URL, or
chronology mismatch stops the lane. Preserve the evidence, investigate
republishing, and repeat two fresh acquisitions under a new reviewed candidate
when needed; never select one digest by hand.

This ADR authorizes source contracts and synthetic tests only. It does not choose
or provision a provider, approve cost, configure federation, create or lock a
bucket, dispatch a workflow, download a live artifact, or authorize staging or
promotion. Manifest version 3 does not yet bind the authenticated sidecars,
retained-object receipt, assembled candidate, or review decision by digest; live
non-template manifests and staging remain blocked until a reviewed schema and
runtime gate do so. Future run-ID-specific output/cache confinement remains part
of the reviewed runner design; existing CLI paths are not silently broken here.
The current block is procedural release policy, not a runtime-enforced
live-versus-synthetic distinction.

## Consequences

- Human acquisition, storage workload, artifact, and review evidence remain
  distinct and auditable.
- The provider-neutral contract can be tested without cloud or publisher bytes.
- A structural candidate cannot satisfy manifest-v3 import readiness by itself.
- Live M0 still needs named source/rights decisions, a reviewed runner, two
  isolated operators, immutable storage, and explicit acquisition approval.

## Alternatives rejected

- Two downloads under one user or shared cache are not independent.
- Caller-authored identity, tool, or verification labels do not authenticate a
  runner.
- HEAD metadata, one digest, ordinary local caches, versioning, deletion
  protection, or overwrite-capable writes do not prove the required evidence.
- Automatically copying sidecar values into a manifest would collapse evidence
  generation and release authority.

## Review triggers

Revisit this ADR before choosing identity/storage providers, changing claims or
key layout, allowing retention override, locking an irreversible rule, adding
receipt signing, changing run/path confinement, or wiring live acquisition,
manifest mutation, staging, approval, or promotion.
