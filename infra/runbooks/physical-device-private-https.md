# Physical-device private HTTPS

> **HISTORICAL RECORD — NON-EXECUTABLE AND NON-RELEASE-COMPATIBLE.**
>
> Do not execute any command in this file on any platform. This archived Mac
> workflow assumes `/usr/sbin/lsof`, `nutrition-tracker-mac`, removed CLI
> arguments, review-package v1, and relay report v2. The current normalizer
> accepts only Windows review-package v2 and emits relay report v4; the current
> mobile verifier accepts v4 only and explicitly rejects v2 and v3. There is no
> supported conversion or compatibility mode. The checked-in
> [Windows-host/WSL2 offline framework](./physical-device-windows-wsl2-private-https.md)
> is implemented, but its production adapter registry is empty and all live
> use remains blocked pending reviewed production adapters, authentic evidence,
> and separate explicit approvals.

The remainder is preserved only as a historical design record. Imperative
language and shell blocks below are not current instructions and cannot produce
accepted release evidence.

## Historical boundary summary

The retired design kept the API and every backing dependency on Mac loopback,
limited the private phone path to TCP/443, prohibited public tunneling, and left
Name.com DNS unchanged. It also treated additive tailnet access as unsafe unless
all overlapping access was independently excluded. Enrollment, policy changes,
incoming access, certificate issuance, and reusable authentication material all
required controls outside the normalizer. These statements describe archived
constraints only and authorize no current action.

The historical threat model accounted for default allow-all tailnet policy,
additive grants, wildcard Mac listeners, and an exposure window during initial
enrollment. Incoming connections remained blocked until the reviewed policy and
device identities were established. It also recorded that issuing private-host
HTTPS certificates permanently disclosed machine and tailnet DNS names through
Certificate Transparency. Exact client invocations are intentionally absent
because the retired workflow is not executable.

## Historical local-service preparation (do not execute)

Historically, the operator started local dependencies and the API, then proved
that the API and every dependency remained on exact IPv4 loopback. The retired
commands are intentionally omitted; use the current Windows runbook only for
its blocked offline contract and not as authority for a live action.

The retired renderer required the API and backing-service ports to remain on
IPv4 loopback while TCP/443 was unused, and it inventoried other listeners so
the historical policy tests could detect overlap. Current Windows boundary
evidence is defined only by the blocked review-package-v2/report-v4 contract.

## Historical policy rendering and review (do not execute)

Historically, incoming connections stayed blocked while identities and the
complete tailnet policy were independently reviewed. Stable device addresses,
identity records, policy tests, and the absence of overlapping grants were all
part of that review. Exact client discovery and identity commands are omitted.

The retired renderer accepted protected Mac address inputs through options that
have since been removed. Current `phone_policy.py` accepts only a protected
input file for the host-neutral Windows v2 contract and has no Mac or v1
compatibility mode. Historical values cannot be translated or relabeled as a
current input.

The renderer writes JSON only to stdout and never applies the policy. Do not
redirect it into the repository. It emits an empty legacy `acls` list, one
exact-IP host alias for each supplied device, one `tcp:443` grant, no SSH or Funnel node
attributes, and positive/negative policy tests for the current listener set.

The retired proposal represented a dedicated test-tailnet policy only. The
historical review rejected default allow rules, extra grants, missing negative
tests, and any policy mutation between phone probes. It preserved the full
policy hash and configuration event outside source control. Incoming access was
enabled only after policy tests and identity review, and client-side incoming
blocking state was recorded before and after that transition. No current policy
may be generated, applied, or inferred from this summary.

## Historical Serve configuration and verification (do not execute)

The historical flow placed one attended foreground private-HTTPS relay on
TCP/443 with the sole upstream at Mac loopback port 4000. Its exact invocation
is intentionally omitted. The retired process kept the terminal attached and
prohibited a background relay that could survive interruption or client
restart.

The historical verification reconciled reviewed identities with one private
foreground HTTPS relay, no public relay state, public-CA hostname validation,
exact readiness, TCP/443-only phone reachability, blocked backing-service
ports, and denial when the phone left the tailnet. Its teardown recorded empty
relay state, restored incoming blocking, and Mac disconnection. Any listener,
policy, identity, address, or relay change invalidated the entire session.

No origin from that workflow may be placed in mobile configuration or release
evidence. The current verifier rejects its v2 report, and the exact historical
client invocations are intentionally absent.

## Historical unsigned-candidate process (obsolete; do not execute)

The retired Mac workflow used review-package v1 to produce relay report v2.
Current `infra/tailscale/relay_evidence.py` does neither: it accepts only the
protected Windows review-package v2 contract and emits only relay report v4.
It deliberately has no v1 parser, compatibility mode, or migration path, and
the mobile verifier rejects v2 and v3 before exact-key parsing. Do not invoke the
current normalizer on v1 inputs. The
[relay review-package v1 reference](../tailscale/relay-review-package-v1.md) is
retained only to explain historical artifacts; it is not an input contract for
current code.

Both the retired and current normalizers are structural only: neither collects
or authenticates evidence, controls Tailscale, applies policy, changes incoming
state, starts Serve or Funnel, or creates a signature.

Historically, an independent reviewer preserved distinct raw Shields Up,
identity/status, Serve, Funnel, policy, configuration-log, listener, and phone
probe captures in a private reviewer-controlled directory. Exact capture
commands are intentionally omitted because this v1 package is not accepted by
current tooling and cannot produce release evidence. No current capture may be
reconstructed from this description.

Do not reconstruct raw stdout, reuse another session, or convert an observed
failure into a `passed` field. The reviewer compares every structural envelope
to its exact raw source, including both build-bound phone probe exports and the
full configuration-log event, then reruns the normalizer over the settled input
bytes immediately before signing. Raw captures remain outside the repository
and are retained with the signed review package.

The review-package index uses schema
`nutrition-tracker-tailscale-relay-review-package-v1`, contains the exact
`trustBoundary` value
`unsigned-structural-candidate-requires-independent-ed25519-manifest-review`,
and contains no reviewer identity or `reviewedAt` claim. Its remaining exact
fields are `apiOrigin`, `startedAt`, `executedAt`, `completedAt`, `buildIds`
(`ios` and `android`), and `captures`. The independent reviewer supplies
`reviewedBy` and `reviewedAt` only in the later signed health manifest. The
`captures` map contains these exact absolute paths:

- `preflightShields`, `preflightServe`, `preflightFunnel`, and
  `preflightIdentities`;
- `accessTimeline`, `activeShields`, `activeServe`, `activeFunnel`, and
  `activeIdentities`;
- `policy`, `configurationEvent`, and the raw bounded `listenerSnapshot` from
  the already reviewed `lsof -Fpn` inventory;
- `iosProbe` and `androidProbe`; and
- `teardownServe`, `teardownFunnel`, `teardownShields`, and
  `teardownDisconnect`.

The index and every input must be a distinct current-user-owned regular file,
mode `0600`, within its byte bound, and readable with no-follow semantics. All
paths are absolute and normalized. A symlink, duplicate inode, special file,
duplicate JSON key, floating/non-finite number, changed file, missing field, or
extra field is rejected. JSON observation envelopes use the exact
`nutrition-tracker-tailscale-<kind>-capture-v1` schema declared by the
normalizer. Preserve sensitive Tailscale IPs, node IDs, and principals only in
these protected inputs. The identity envelopes bind the exact Mac, iOS, and
Android alias/node/principal/IP/private-DNS tuples at preflight, active testing,
and disconnect; the API origin must equal the reviewed Mac DNS identity. The
full `policy` capture is the complete reviewed policy JSON,
not a selected rule: the normalizer reconstructs the two-phone policy from the
identity and listener captures and rejects a default allow, extra ACL/grant,
missing negative test, or any overlap. The access timeline binds the policy
and configuration-event byte hashes and structurally requires Shields Up to
remain enabled until policy tests and identity revalidation completed.

Serve/Funnel observation envelopes must preserve exact empty-object `{}` values
for persistent `TCP`, `Web`, `Services`, and `AllowFunnel`; arrays are rejected.
The active Serve foreground list
must contain exactly one `foreground` HTTPS/443 root handler to
`http://127.0.0.1:4000`, with `allowFunnel: false` and no services; the active
Funnel observation may repeat that graph or have an empty foreground list.
Preflight and teardown foreground lists must be empty. The two build-bound phone probes
must bind their distinct EAS build IDs and exact identities to the
same policy/configuration event, public-CA hostname success, `/ready` HTTP 200,
only open TCP/443, every inventoried denied port blocked, and HTTPS blocked with
Tailscale disabled.

The obsolete v2 candidate included the exact unsigned trust-boundary marker and
`sourceCaptureBundleSha256`, plus the index's exact `executedAt`. Its digest
domain-separates
`nutrition-tracker-tailscale-relay-source-capture-bundle-v1` and hashes, in the
exact role order listed above, each role name plus the SHA-256 of its complete
input bytes. It therefore binds all 18 normalized inputs, including both probe
captures, without copying sensitive source content into the candidate.

The obsolete v1-to-v2 invocation is intentionally omitted. Current
`relay_evidence.py --capture-index` requires a protected Windows v2 index and
rejects v1. Do not adapt, relabel, or supplement a Mac v1 package to make it
parse as v2. Historically, the resulting candidate had to be current-user-owned
mode `0600`. Never point the
index at source-control files, and never use a capture from another attended
session. The resulting candidate remains outside the repository and records the
exact `.ts.net` origin and session start/execution/completion times. Preflight fields
and source-capture digests structurally record first-connect Shields Up, initially empty
Serve/Funnel, incoming access held until policy tests passed, and revalidated
Mac/iPhone/Android identities. The active fields bind the foreground Serve
graph, disabled Funnel, exact two-phone aliases, one full-policy/configuration
event digest shared by both build probes, complete non-443 listener inventory,
CA and `/ready` success, TCP/443-only results, blocked ports, and off-tailnet
denial. Teardown fields and source digests structurally record empty Serve/Funnel, restored
Shields Up, and Mac disconnect. The verifier requires
`startedAt <= executedAt < completedAt < reviewedAt`, requires a current v4
candidate's `executedAt` to equal the independently signed manifest's
`executedAt` exactly, and allows a session no longer than 24 hours. It rejects
the historical v2 candidate before parsing its exact keys.

Keep the candidate owned by the current operator and mode `0600` in ignored
`.local-data/release`, or supply its exact bytes later as secret base64. Do not
include raw status/configuration output,
Tailscale IPs, node IDs, user identities, auth keys, tokens, health payloads, or
device identifiers in the normalized candidate; retain any sensitive source
captures only in the independently controlled review location. The candidate
alone is rejected as release authority. Only after the independent reviewer
checks every exact source byte may they sign the complete v5 health manifest;
that trusted Ed25519 signature binds the candidate's exact SHA-256 digest,
trust-boundary marker, and all-18 source bundle digest.

Do not supply a historical Mac v2 candidate through the current relay-report
path or base64 environment inputs. Those gate inputs are reserved for a
compatible Windows v4 report whose exact bytes match the signed
`physicalDeviceApiRelay.reportSha256`; live production evidence remains blocked
as stated in the Windows runbook.
