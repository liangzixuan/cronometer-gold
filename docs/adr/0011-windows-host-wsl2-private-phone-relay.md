# ADR 0011: Define a Windows-host/WSL2 private physical-phone relay boundary

- Status: Proposed; implementation and all phone exposure remain blocked
- Date: 2026-08-27
- Scope: synthetic-data-only physical-device development on Windows 11, WSL2
  Ubuntu, and Docker Desktop

## Context

The implemented physical-device path is macOS-specific. It assumes
`/usr/sbin/lsof`, the `nutrition-tracker-mac` identity, protected device IPs in
command arguments, and one host listener table. Renaming those fields would not
account for the separate Windows, Hyper-V/WSL, Docker, firewall, forwarding,
LAN, and tailnet boundaries present on Windows.

The intended private route is:

```text
approved physical phone
  -> private authenticated Tailscale HTTPS on Windows TCP/443
  -> attended foreground Windows-host Serve
  -> Windows localhost forwarding
  -> WSL2 API on http://127.0.0.1:4000

WSL2/Docker dependencies remain loopback-only and are never relay targets.
```

Tailscale belongs on the Windows host only. The current Tailscale guidance
warns against running it simultaneously on Windows and inside WSL2. Windows and
WSL networking behavior can also differ between NAT and mirrored modes, while
Hyper-V firewall policy may add a boundary distinct from Windows Defender
Firewall. Those facts must be observed from the exact installed versions and
configuration rather than assumed from the macOS evidence model.

## Decision

Define a proposed Windows-only v2 review package and v3 normalized report. This
decision authorizes no install, join, authentication, policy, firewall,
listener, certificate, phone, EAS, or other external action. The path remains
blocked until its renderer, normalizer, validators, fixtures, negative tests,
and independent review are implemented together and pass.

The implemented contract must:

1. bind a structured `hostBoundary` with relay node `windows-host`, application
   node `wsl2-ubuntu`, container provider `docker-desktop-wsl-integration`,
   Tailscale placement `windows-host-only`, API bind `127.0.0.1:4000`, Serve
   upstream `http://127.0.0.1:4000`, and the reviewed WSL networking mode;
2. prove Tailscale is absent from WSL and that no second Docker Engine,
   `portproxy`, wildcard bind, networking-mode change, or broad firewall
   exception was introduced to make the route work;
3. keep the renderer and normalizer non-collecting: they may securely read
   reviewer-supplied files and emit canonical output, but may never invoke
   PowerShell, `wsl.exe`, Docker, Tailscale, a browser, a network probe, or an
   administrative command;
4. accept no host, phone, node, principal, DNS name, or Tailscale IP in command
   arguments; protected values exist only in current-user-controlled mode-0600
   inputs under a mode-0700 review directory;
5. derive required capture roles from the v2 phase/evidence matrix rather than
   trusting an independent numeric count;
6. capture the exact installed Tailscale client and daemon versions, help, and
   raw status first; select a tested version adapter and reject unknown versions
   or output shapes;
7. reconcile Windows listeners, Windows Defender Firewall, Hyper-V firewall,
   forwarding, WSL listeners, and every Docker-published port at preflight,
   active testing, restart, and teardown;
8. bind separate approved-phone, unapproved-tailnet-peer, and LAN probes over
   TCP/443 and the complete inventoried denied-port set;
9. bind a deliberate cold WSL/Docker restart, current migrations, exact WSL and
   Windows HTTP 200 `{"status":"ok"}` readiness, source/process continuity,
   route recovery, and repeated negative probes;
10. prove teardown leaves Serve and Funnel disabled, incoming connections
    blocked, the Windows relay node disconnected, and listener, firewall,
    forwarding, WSL, and Docker state restored to preflight;
11. require a new continuous Windows session and complete recollection for v2;
    v1 evidence is never converted, relabeled, supplemented, or mixed with v2;
    and
12. emit only an unsigned structural candidate. Normalization never
    authenticates an observation or establishes release authority.

Serve, Funnel, incoming-connection, and Windows socket semantics must be driven
by the reviewed client version. The implementation must not assume that
Windows exposes one operating-system TCP/443 listener, nor equate non-empty or
empty Funnel JSON with enabled or disabled state without a tested adapter.

## Threat model

The contract must fail closed against:

- a default allow-all or overlapping additive tailnet ACL or grant;
- any unapproved tailnet peer reaching TCP/443 or an inventoried denied port;
- Funnel, a persistent/background Serve route, or another public ingress;
- LAN reachability to Windows, WSL, Docker, the API, or a dependency;
- IPv4/IPv6, Windows/WSL, NAT/mirrored-mode, or listener-inventory blind spots;
- wildcard binds, `portproxy`, HNS forwarding, or broad Defender/Hyper-V
  firewall exceptions;
- Tailscale running on both Windows and WSL, or a second Docker Engine in WSL;
- WSL/Docker cold-restart forwarding or process drift;
- identity, IP, DNS-name, enrollment, source-revision, or device-attribution
  drift;
- LocalStack, PostgreSQL, Meilisearch, MinIO, Mailpit, Metro, SSH, or another
  listener becoming reachable;
- protected IPs, node IDs, principals, policy, credentials, or raw captures
  leaking through arguments, history, logs, source control, OneDrive, or
  tickets;
- forged, replayed, mixed-session, mutated, stale, or time-of-check/time-of-use
  evidence;
- treating renderer or normalizer output as an authenticated observation;
- client-version output drift being misread as disabled Funnel or correct
  Serve state;
- incomplete teardown or failure to restore listener, firewall, forwarding,
  WSL, and Docker state;
- Certificate Transparency disclosure of machine or tailnet names; and
- treating private-device success as public deployment, store, or production
  evidence.

## Consequences

The Windows evidence surface is intentionally larger than the macOS surface.
Sensitive raw captures remain outside Git and OneDrive, while a canonical
candidate contains only hashes and redacted conclusions. A full cold restart
and physical probes are expensive, attended steps and cannot be inferred from
static tests. The existing macOS implementation stays intact until an atomic
producer/verifier cutover explicitly retires it.

The route exposes only the API through private HTTPS. LocalStack and every
application dependency remain loopback-only, and neither private relay success
nor LocalStack success can satisfy public deployment or signed-release gates.

## Alternatives considered

- **Reuse or rename v1:** rejected because it omits Windows/WSL/Docker and
  firewall/forwarding boundaries and would mislabel historical Mac evidence.
- **Run Tailscale inside WSL:** rejected because the reviewed topology places
  one relay identity on Windows and avoids simultaneous Windows/WSL clients.
- **Bind the API or dependencies to `0.0.0.0`:** rejected because it exposes
  services outside the sole private HTTPS route.
- **Use `netsh portproxy` or a LAN reverse proxy:** rejected because it adds an
  avoidable forwarding or LAN exposure boundary.
- **Use Funnel:** rejected because public ingress is outside this development
  path.
- **Use a fixed capture count or fixed client JSON shape:** rejected because
  security invariants, phases, and the installed version determine the exact
  evidence set.

## Review triggers

Review this decision before implementing the renderer or normalizer; changing
the host OS, WSL distribution or networking mode, Docker provider, Tailscale
placement/version/output adapter, Serve/Funnel behavior, firewall or forwarding
model, role matrix, protected ports, API bind/upstream, identity model, outer
manifest, or teardown requirements; enabling any listener or phone access; or
using anything other than synthetic development data.

Current references, revalidated when this ADR was proposed:

- <https://tailscale.com/docs/install/windows/wsl2>
- <https://tailscale.com/docs/reference/examples/serve>
- <https://tailscale.com/docs/reference/tailscale-cli/funnel>
- <https://tailscale.com/docs/features/client/manage-preferences>
- <https://learn.microsoft.com/en-us/windows/wsl/networking>
- <https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall>
