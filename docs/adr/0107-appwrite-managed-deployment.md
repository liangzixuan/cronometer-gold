# ADR 0107: Appwrite managed web deployment and public application API

Status: policy approved by the user on September 29, 2026; implementation under
validation. No hosted deployment or formal release acceptance is claimed.

## Context

The existing Appwrite controller parsed a qualification argument but used an
unavailable verifier. Native release evidence assumed seven digest-qualified
container images, including web. Appwrite Cloud does not expose the immutable
host/image evidence that model required. Reviewer-only API ingress also prevented
normal Appwrite BFF and phone use. The user chose Appwrite Cloud, approved the
concrete managed-runtime/public application access review, and retained the
existing-credit-only spending limit.

## Decision

Adopt the named `appwrite-cloud-azure-v1` profile. Trust Appwrite to operate hidden
web infrastructure while measuring the observable build/SSR runtime and binding
actual source/output, Site, candidate and preview results to independent signed
review. Preserve exact approved Node/OpenSSL and advisory requirements; unknown
or incompatible observed runtime fails. Backend admission remains a separately
versioned six-image contract with its existing security and restore protections.
The original seven-image OCI profile is not silently converted.

Separate inactive candidate preparation from activation. Each phase rereads its
actual provider and GitHub inputs; production also rereads qualified staging and
requires isolated data/storage identities. Treat uncertain activation as an
uncertain mutation with one read-only reconciliation. Never promise the previous
deployment remains active after a remote activation may have succeeded.

Use public HTTPS application routes with existing user authorization and bounded
anonymous auth/search work. Keep administration and dependencies private. A
separate narrow readiness credential is stripped by the proxy before forwarding.
The process-wide limiter is valid only for the enforced single API instance.

Mobile release consumes the shared v8 evidence and a separately signed actual
activation observation, bound to the current source. Existing reviewer trust,
key validity, independent principals, native identifier history and device
acceptance remain required. No test key becomes a release authority.

## Consequences and alternatives

Appwrite host drift and hidden-component coverage remain explicit provider risks.
Rollback restores application output, not a pinned provider runtime. Fresh
observable runtime reports expire after one hour; review expires after 24 hours.
Unknown runtime evidence or a missing independent reviewer blocks activation.

Keeping the previous unavailable verifier would leave deployment impossible.
Moving web to a qualified container would retain a different trust model, but the
user selected Appwrite Cloud. Neither choice establishes free-plan entitlement
or pays for the backend; account allowance and spending protection must be
verified before any resource action.

Backend egress, credential rotation, allowance admission and encrypted off-host
backup/restore remain required implementations/qualifications. This decision
does not mark them passed. Staging and production resources, live observations,
formal signatures and browser/native evidence cannot be supplied by code tests.

## Review triggers

Review this decision when Appwrite changes runtime behavior, exposes verifiable
image provenance, changes free/education limits, or cannot run the approved
observable runtime. Revisit ingress admission before multiple API replicas,
additional anonymous routes, public administrative access or a changed session
transport. Any spending or deployment still follows its separate authorization.
