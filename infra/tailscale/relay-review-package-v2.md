# Relay review-package v2 contract reference

> **Offline framework implemented — production adapter and live use blocked.**
>
> Checked-in code handles this schema only through an explicit tested version
> adapter; the immutable production registry is empty. This document authorizes
> no Tailscale, firewall, listener, policy, phone, certificate, or EAS action. Do
> not normalize authentic captures until exact Windows output corpora and a
> production adapter are independently reviewed, and do not run a live phase
> without its separate explicit approval.

This is the current complete transcription contract for
`nutrition-tracker-tailscale-relay-review-package-v2`. It describes a Windows
11 host running WSL2 Ubuntu and Docker Desktop with Tailscale on Windows only.
It is not an evidence collector, runnable checklist, or authority to expose a
service.

The normalizer remains structural only. It authenticates neither the raw source
nor a reviewer and emits only an unsigned
`nutrition-tracker-physical-device-relay-report-v4` candidate. The unchanged v5
health manifest may bind the exact v4 report bytes only after independent
review. A v5 manifest that binds a legacy v2 or v3 report must fail closed.

## Review-package index

The v2 index retains the exact unsigned trust-boundary marker:

```text
unsigned-structural-candidate-requires-independent-ed25519-manifest-review
```

It includes the current session times, origin, distinct iOS and Android
build IDs, and one protected path for every role in the normative matrix below.
The protected `hostBoundary` capture is the sole authoritative host-boundary
object; the index contains only its path, not a second inline copy. That capture
has this exact payload:

```json
{
  "relayNode": "windows-host",
  "applicationNode": "wsl2-ubuntu",
  "containerProvider": "docker-desktop-wsl-integration",
  "tailscalePlacement": "windows-host-only",
  "apiBind": "127.0.0.1:4000",
  "serveUpstream": "http://127.0.0.1:4000",
  "wslNetworkingMode": "<reviewed-nat-or-mirrored>"
}
```

The final schema must additionally bind exact Windows, WSL, Docker, Tailscale
client/daemon, networking, and firewall versions or configuration identities in
protected source evidence. The redacted candidate may retain only reviewed
version identifiers and hashes that reveal no protected device identity.

## Normative phase/evidence matrix

| Phase | Boundary | Required capture roles |
| --- | --- | --- |
| Session | Versions and boundary | `sessionEnvironment`, `hostBoundary` |
| Preflight | Incoming/identity | `preflightIncoming`, `preflightIdentities` |
| Preflight | Serve/Funnel | `preflightServe`, `preflightFunnel` |
| Preflight | Host/runtime | `preflightWindowsListeners`, `preflightWindowsFirewall`, `preflightHyperVFirewall`, `preflightForwarding`, `preflightWslListeners`, `preflightDockerPorts` |
| Policy | Proposal/application | `policyProposal`, `policy`, `policyTests`, `configurationEvent`, `policyGate` |
| Active | Current policy | `activePolicyState` |
| Active | Incoming/identity | `activeIncoming`, `activeIdentities` |
| Active | Serve/Funnel | `activeServe`, `activeFunnel` |
| Active | Host/runtime | `activeEnvironment`, `activeWindowsListeners`, `activeWindowsFirewall`, `activeHyperVFirewall`, `activeForwarding`, `activeWslListeners`, `activeDockerPorts` |
| Active | Reachability | `iosProbe`, `androidProbe`, `unapprovedTailnetProbe`, `lanProbe` |
| Restart | Pre-shutdown safety | `restartPreShutdownIncoming`, `restartPreShutdownServe`, `restartPreShutdownFunnel`, `coldRestartEvent` |
| Restart | Post-restart/pre-exposure | `restartPreExposureIncoming`, `restartPreExposureServe`, `restartPreExposureFunnel`, `restartPreExposureIdentities` |
| Restart | Host/runtime | `restartEnvironment`, `restartWindowsListeners`, `restartWindowsFirewall`, `restartHyperVFirewall`, `restartForwarding`, `restartWslListeners`, `restartDockerPorts` |
| Restart | Local readiness | `restartWslReadyProbe`, `restartWindowsReadyProbe` |
| Restart | Re-enabled relay | `restartPolicyState`, `restartActiveIncoming`, `restartActiveServe`, `restartActiveFunnel`, `restartActiveIdentities` |
| Restart | Reachability | `restartIosProbe`, `restartAndroidProbe`, `restartUnapprovedTailnetProbe`, `restartLanProbe` |
| Teardown | Tailscale | `teardownIncoming`, `teardownServe`, `teardownFunnel` |
| Teardown | Restoration | `teardownEnvironment`, `teardownWindowsListeners`, `teardownWindowsFirewall`, `teardownHyperVFirewall`, `teardownForwarding`, `teardownWslListeners`, `teardownDockerPorts` |
| Teardown | Current policy | `teardownPolicyState` |
| Teardown | Disconnect | `teardownDisconnect` |
| Completion | Immutable binding | `sessionLedger` |

The required capture-role set is the union of the non-empty matrix cells for
the declared schema version. There is no independent numeric capture-count
invariant. Every role is required exactly once, uses a distinct protected
regular file, and participates in the ordered source-bundle digest.

A schema change that adds, removes, merges, splits, or reorders a role requires
an explicit version review. No implementation may silently infer an absent
boundary from another capture. `sessionLedger` is last: it binds the exact role,
hash, schema, and timestamp of every preceding capture but never attempts a
self-hash. The ordered source bundle then binds `sessionLedger` itself.

## Protected-input invariants

The index and every capture must be distinct, current-user-owned regular files
under one current-user-owned mode-0700 review directory. That directory must be
on the WSL Linux filesystem, outside Git and OneDrive, and never below `/mnt/*`,
DrvFS, a Windows-mounted tree, or a synced path. The implementation must verify
the filesystem boundary and fail if it cannot distinguish native Linux
ownership/mode/no-follow guarantees. Each file must be mode 0600, normalized
and absolute, opened with no-follow semantics, bounded in size, and stable
across the complete read. Reject symlinks, hard-link aliases, duplicate inodes,
special files, missing or extra roles, duplicate JSON keys, noncanonical JSON,
non-finite values, changed bytes, and hash mismatches.

No host, phone, node, principal, DNS name, policy value, Tailscale IP, process
ID, process path, or firewall-rule payload may appear in a command argument,
candidate, source tree, OneDrive, ticket, or log. Protected values live only in
the reviewer-controlled captures. The renderer and normalizer may read those
files and emit canonical output; they must not invoke PowerShell, `wsl.exe`,
Docker, Tailscale, a browser, a network probe, or an administrative command.

All capture envelopes must bind the continuous session identifier, canonical
millisecond UTC time, exact raw-source hash, and the role-specific version.
Hashes and times must prove that active and restart captures were collected in
their declared phase and were not reused from preflight or another session.

## Host and runtime reconciliation

`sessionEnvironment` and `hostBoundary` must prove Windows 11, WSL2 Ubuntu,
Linux containers, Docker Desktop WSL integration over its local Unix socket,
and Tailscale on Windows only. `activeEnvironment`, `restartEnvironment`, and
`teardownEnvironment` repeat the service, process, package, socket, context, and
integration checks. Every environment phase must prove no Tailscale daemon and
no second Docker Engine exist inside WSL, including dormant or Unix-socket-only
services that a TCP listener inventory would miss.

Each phase-specific runtime set must reconcile:

- all Windows IPv4 and IPv6 TCP listeners, including the active owner and full
  source/process continuity for the API path;
- all WSL IPv4 and IPv6 TCP listeners;
- published ports and networking mode for every Docker container and project,
  not only the expected Compose services;
- Windows Defender Firewall profiles and effective inbound rules;
- Hyper-V firewall state applicable to WSL; and
- `netsh interface portproxy`, HNS forwarding, WSL NAT or mirrored mode,
  localhost forwarding, and other effective forwarding state.

The API remains bound to exact IPv4 loopback `127.0.0.1:4000`. Dependency ports
remain IPv4-loopback-only. Reject wildcard, LAN, Tailscale-address, WSL-address,
host-network, unexpected published-port, or extra IPv6 bindings. The denied-port
set is the sorted union of the complete listener inventory and at least TCP
22, 80, 1025, 2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001,
9092. Only private Tailscale HTTPS TCP/443 may be phone-reachable.

Each approved phone's rendered TCP policy test must deny exactly the complete
sorted non-443 boundary inventory above. A missing custom listener or any extra
deny destination is policy drift and blocks normalization.

## Version-adapter and output-corpus binding

Report v4 adds an exact cross-language adapter and corpus commitment. The
adapter platform is `windows-host`, and the corpus schema is exactly
`nutrition-tracker-tailscale-windows-output-corpus-v1`. A production adapter
has kind `production` and a non-`test-` ID. An injected structural-test adapter
has kind `test` and an ID beginning with `test-`. The immutable production
registry remains empty; producer-normalization test injection cannot register or
exercise a production adapter.

The canonical corpus manifest has exactly these fields:

- `schemaVersion`, `adapterId`, `adapterKind`, and `platform`;
- `roleSamples`;
- `windowsVersion`, `wslVersion`, `ubuntuVersion`,
  `dockerDesktopVersion`, and `dockerEngineVersion`;
- `tailscaleClientVersion` and `tailscaleDaemonVersion`; and
- `clientHelpSha256` and `daemonHelpSha256`.

`roleSamples` currently contains 72 entries in the order derived from the
normative matrix, exactly one for every required capture role; the matrix, not
the numeric count, remains authoritative. Each entry has exactly
`role`, `sourceSha256`, and `normalizedSha256`. The adapter corpus retains the
exact protected raw-source bytes and an immutable expected normalized result
for each role. During adapter validation, every role normalizer must reproduce
that expected result from those bytes. The normalized-result commitment uses
schema `nutrition-tracker-tailscale-normalized-corpus-result-v1` and binds
exactly the role, session ID, canonical capture time, source digest, raw-output
digest, and normalized-observation digest. A missing, reordered, unparsable,
mutated, or non-reproducible sample fails closed.

The report's `versionAdapter` exposes the corpus schema and digest plus the
adapter ID/kind/platform, all seven exact environment and Tailscale versions,
and both help digests. The mobile v4 consumer compares every one of those
fields with one exact registry entry; matching an adapter ID or Tailscale
version alone is insufficient. It also rejects test-kind adapters on the signed
release path even if a caller injects an otherwise matching test registry.
Report v2 and v3 inputs are legacy and rejected before exact v4 parsing.

The corpus still does not authenticate a live observation or reviewer. A
future production registration must additionally review the exact Windows
PowerShell build/culture and every collector/parser source that forms the
protected output; those facts are not silently inferred from the current
report fields.

## Serve, Funnel, incoming, policy, and identity

Before production-adapter implementation, capture the exact installed Windows Tailscale
client and daemon versions plus raw help and status output. A tested adapter
must derive canonical incoming, Serve, and Funnel observations from that exact
version. Unknown versions, unsupported fields, ambiguous state, or data loss
fail closed.

Do not assume an operating-system TCP/443 listener count or owner for Windows
Serve. Require zero unrelated TCP/443 listeners and cryptographically link the
version-adapted Serve state to successful and denied probes. Funnel must be
semantically disabled: reject enabled `AllowFunnel`, any public handler,
service, persistent configuration, or other enabled Funnel state. If a reviewed
version emits empty Funnel state, require empty; if it mirrors a disabled Serve
graph, accept only that documented, tested shape.

The complete tailnet policy, proposal, policy tests, and configuration event
must be captured and hash-linked. Reject default allow, overlapping ACLs or
grants, extra relay/phone aliases, missing negative tests, SSH/Funnel node
attributes, or access beyond each exact approved phone to the exact relay host
on TCP/443. Identities must be revalidated across preflight, active, restart,
and teardown without exposing their protected values in the candidate.

The policy-phase `policyGate` must hash-link the proposal, applied policy,
configuration event, `policyTests`, and revalidated identities and validate
their canonical timestamps before incoming access can be enabled. Incoming
access is blocked from first enrollment through preflight. The proposal hash is
reviewed, the exact policy is applied, policy tests pass, and identities are
revalidated before incoming access or Serve probes can begin. Active incoming
and Serve state must both be captured before any approved or denied probe. No
interval may exist in which incoming access is enabled under default,
overlapping, untested, or identity-stale policy.

The version adapter must independently normalize the exact current policy
revision and complete policy snapshot in `activePolicyState`,
`restartPolicyState`, and `teardownPolicyState`. Every snapshot hash-links the
applied policy and configuration event and must equal both their exact policy
bytes and revision without drift. `policyGate` hash-links the active snapshot
before incoming access, `coldRestartEvent` hash-links the restart snapshot
after boundary/readiness recovery and before re-enablement, and the final
ledger binds the teardown snapshot after restoration and before disconnect.

The completion-phase `sessionLedger` is created only after teardown. It
hash-links and time-orders every preceding phase capture, including all active
and restart probes, without changing the earlier `policyGate`. Reject a missing,
reordered, future-dated, cross-session, duplicate, or otherwise inconsistent
entry.

Before cold restart, incoming access is blocked and Serve is stopped. It stays
blocked while WSL, Docker, migrations, listeners, firewalls, forwarding, and
local readiness are re-proven. Only the same reviewed policy, identities, and
version adapter may re-establish attended Serve and incoming access for the
distinct restart probes. Teardown blocks incoming first, disables Serve and
Funnel, proves restoration, and disconnects the Windows relay last. The v4
candidate exposes the host-neutral result `incomingAccessHeldUntilPolicyTests`.

## Reachability contracts

Each approved physical phone must bind its distinct reviewed build and identity
to public-CA and hostname success, exact `/ready` HTTP 200 with body
`{"status":"ok"}`, only TCP/443 reachable, every inventoried non-443 port
blocked, direct Windows/WSL/Docker targets blocked, and the `.ts.net` origin
blocked with Tailscale disabled.

The distinct unapproved-tailnet-peer capture must prove TCP/443 and every
inventoried denied port blocked. The distinct LAN capture must prove Windows
TCP/443 and every Windows, WSL, and Docker denied target blocked over each
applicable IPv4 and IPv6 path. A LAN probe cannot substitute for an unapproved
tailnet peer, or vice versa.

## Cold restart

The ordered restart event must bind clean source HEAD, the expected API
process/cwd, pre-restart capture hashes, deliberate WSL and Docker shutdown,
their restart order, exact Docker boundary, current migrations, and post-restart
captures. `restartPreShutdown*` proves incoming blocked and Serve/Funnel stopped
before shutdown. `restartPreExposure*` proves they remain blocked/stopped after
restart while identities are revalidated. `restartActive*` then binds the sole
reviewed re-enabled route. Distinct `restartWslReadyProbe` and
`restartWindowsReadyProbe` roles bind exact HTTP 200 `{"status":"ok"}`
readiness. Distinct `restartIosProbe` and `restartAndroidProbe` roles bind
restored private relay readiness; unapproved-tailnet and LAN probes repeat in
their own roles.

Post-restart observations use distinct current files. Reusing a pre-restart
hash, accepting non-current migrations, changing source/process identity, or
omitting a positive or negative result fails closed.

## Teardown and restoration

Teardown must prove version-adapted Serve and Funnel disabled, incoming
connections blocked, the Windows relay node disconnected, and no stale proxy or
public route. Preflight and teardown listener, Defender firewall, Hyper-V
firewall, forwarding, WSL, and Docker canonical states must match exactly unless
a separately enumerated, independently reviewed restoration rule proves a
specific equivalent state.

Any missing capture, unexpected listener, policy drift, identity drift,
firewall/forwarding difference, persistent Serve/Funnel state, probe ambiguity,
or teardown mismatch blocks the candidate.

## Bundle, candidate, and migration

The implemented source bundle domain-separates
`nutrition-tracker-tailscale-relay-source-capture-bundle-v2` and hash, in matrix
order, every role name plus the SHA-256 of its complete bytes, with the final
`sessionLedger` binding all preceding entries. The v4 candidate
includes the exact unsigned trust-boundary marker, bundle digest, session
times, exact distinct iOS/Android build IDs, hashes of the active and restart
phone-probe roles, host-topology conclusions, separate listener/firewall/
forwarding hashes, restart result, host-neutral result names, and redacted
conclusions only. The v4 consumer must compare both build IDs with the exact
already verified signed artifact records; a missing, swapped, or mismatched
build or probe binding fails closed.

The host-neutral result names are `incomingAccessHeldUntilPolicyTests`,
`relayHostIdentityRevalidated`, `testedPhonesToRelayHostTcp443Only`, and
`relayHostDisconnected`. Protected raw
identities, IPs, DNS names, policy payloads, process details, and firewall rules
never enter the candidate. The canonical private origin is represented only by
`apiOriginCommitmentSha256`. Compute it as
`SHA256(UTF8(domain + LF + canonicalOrigin + LF))`, where `domain` is exactly
`nutrition-tracker-physical-device-api-origin-v1` and `LF` is the single byte
`0x0a`, not the two bytes backslash-plus-`n`. The exact preimage form is:

```text
nutrition-tracker-physical-device-api-origin-v1\n<canonical-api-origin>\n
```

The fixed test vector for canonical origin `https://relay.example.ts.net` is
`324c46636c4c63c6dd63502c753892fcc8cdbce343fd0d760fa29417397ee19e`.

The v4 consumer must recompute that commitment from the already validated,
signed v5 `physicalDeviceApiRelay.apiOrigin` and require an exact match. The
protected capture index and every approved-phone readiness probe bind that same
origin before redaction. An origin mismatch must fail even when the report
digest and every other structural field are valid.

The retired historical macOS generation used review package
`nutrition-tracker-tailscale-relay-review-package-v1`, source bundle
`nutrition-tracker-tailscale-relay-source-capture-bundle-v1`, and normalized
report `nutrition-tracker-physical-device-relay-report-v2`. That path is not
implemented by current tooling and is rejected by the v4-only verifier. The
implemented offline Windows generation is review package v2, source bundle v2,
and normalized report v4. Historical Mac material cannot be upgraded,
relabeled, supplemented, or partially reused; adoption requires a new
continuous Windows session and complete recollection of every matrix role.

The atomic validator cutover deliberately makes health manifest
`nutrition-tracker-health-release-evidence-v5` accept report v4 and reject its
formerly accepted reports v2 and v3. The outer schema stays v5 because its signed
`physicalDeviceApiRelay` wire shape remains the same origin and exact report
digest; inner report parsing is already fail-closed. Tests must prove v5 plus
v4 acceptance, v5 plus v2/v3 rejection, and rejection when the signed origin does
not match `apiOriginCommitmentSha256`. The empty checked-in health-reviewer
store keeps this compatibility cutover blocked from live release use until a
real reviewer is separately approved.

The offline implementation is structural only. Its immutable production adapter
registry remains empty; no exact Windows output corpus, authentic capture, or
reviewer signature is checked in. It cannot clear a live release gate or the
Windows physical-phone blocker.
