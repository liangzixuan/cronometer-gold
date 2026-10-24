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
actual source/output, Site, candidate and preview results to automated
measurements. Preserve exact approved Node/OpenSSL and advisory requirements; unknown
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

Mobile release consumes the shared v8 evidence and an actual activation
observation bound to the current source. Native identifier history, device
acceptance and device/platform/software signatures remain required. Human
signatures and separate people do not block release. No test key becomes a
device/platform/software release authority.

## Finite hosted staging dependency policy

The user's direct approval permits the existing hosted staging trial to retain
failed standalone dependency checks. Admission applies from
2026-10-22T00:37:43Z until 2026-10-23T18:37:37Z, exclusive. It covers only the
production-dependency advisory and object-store vulnerability jobs in `ci.yml`,
and the PostgreSQL/Meilisearch fixture vulnerability jobs in `browserstack-web.yml`.
Each job and its exact scan step must complete. Their actual failed results remain
in the evidence; missing, skipped or failed setup steps are not accepted.

Production retains successful-check requirements. Functional/build checks,
secret/history scans, licenses, source identity, image integrity/provenance,
browser acceptance, backup/recovery and cleanup remain required.
The existing one-trial spending, duration and resource limits still apply. This
policy neither starts the trial nor grants a production release.

## Approved hosted delivery interval

NOURISHING-HOSTED-DELIVERY-01597185-20261024 was approved through the
established Oracle-to-Gmail route in the reply received at
2026-10-24T18:15:50Z. Its separate staging interval ends at
2026-10-27T23:30:00Z, exclusive. It retains only the two completed failed
`ci.yml` jobs, `production dependency advisories` and
`object-store vulnerabilities`, and their exact scan steps. Actual failed
outcomes remain unchanged. Missing or skipped scans, failed setup and all other
failed jobs remain inadmissible. Production remains strict.

Both earlier intervals are expired history. This interval grants no extension
of their consumed approvals. The new delivery run retains its own resource,
credit, custody, start, powered-time, recovery and cleanup bounds; the admission
end is not permission to run the host until that date.

## Consequences and alternatives

Appwrite host drift and hidden-component coverage remain explicit provider risks.
Rollback restores application output, not a pinned provider runtime. Fresh
observable runtime reports expire after one hour; backend admission records
expire after 24 hours. Unknown runtime evidence blocks activation.

Keeping the previous unavailable verifier would leave deployment impossible.
Moving web to a qualified container would retain a different trust model, but the
user selected Appwrite Cloud. Neither choice establishes free-plan entitlement
or pays for the backend; account allowance and spending protection must be
verified before any resource action.

Backend egress, credential rotation, allowance admission and encrypted off-host
backup/restore remain required implementations/qualifications. This decision
does not mark them passed. Staging and production resources, live observations,
device/platform/software signatures and browser/native evidence cannot be
supplied by code tests.

## Historical reviewer key record

The user permanently revoked mandatory third-person review, separate people and
human signatures on October 23, 2026. The earlier reviewer-key policy is history
and imposes no current approval or signing requirement. Do not request Kendall's
review or reuse this policy as a release gate. Existing keys and actual review
artifacts remain preserved as history; no unperformed review is marked complete.

The prior policy recorded Kendall Buckner's public Ed25519 key
`kendall-staging-20261022`, starting at `2026-10-22T15:31:12.000Z`, with
`validUntil: null`. These historical dates grant no current deployment, spending,
credential or reviewer-contact authority. Device/platform/software signatures
and automatic tool approval remain in force.

## Review triggers

Review this decision when Appwrite changes runtime behavior, exposes verifiable
image provenance, changes free/education limits, or cannot run the approved
observable runtime. Revisit ingress admission before multiple API replicas,
additional anonymous routes, public administrative access or a changed session
transport. Any spending or deployment still follows its separate authorization.
