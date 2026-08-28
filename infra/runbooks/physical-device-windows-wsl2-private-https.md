# Windows-host/WSL2 physical-device private HTTPS

> **STOP — offline framework implemented; live use remains blocked.**
>
> Checked-in code structurally normalizes review-package v2 and accepts relay
> report v3, but the production version-adapter registry is deliberately empty.
> This document authorizes no Tailscale, firewall, listener, policy, phone,
> certificate, Docker-boundary, or EAS action. Read
> [ADR 0011](../../docs/adr/0011-windows-host-wsl2-private-phone-relay.md)
> and the [v2 design reference](../tailscale/relay-review-package-v2.md). The
> path remains blocked until exact Windows output corpora, reviewed production
> adapters/collectors, authentic evidence, and separate live-phase approvals
> exist.

This document defines the evidence that a future attended Windows workflow must
produce. It is not public hosting, a production deployment, or a substitute for
the controlled-beta HTTPS and deployment evidence gates. Use synthetic data
only.

## Authorization boundary

This checked-in path permits offline documentation, schema, fixture, test,
renderer, normalizer, and validator work only. It does not permit installing or
authenticating Tailscale, joining a
tailnet, changing policy or firewall state, enabling incoming connections,
starting Serve, requesting a certificate, connecting a phone, running a probe,
or invoking EAS.

Each future live phase needs explicit operator approval after the exact command,
version, target, expected state change, recovery path, and evidence location are
reviewed. A commit or push approval does not authorize any live phase.

## Remaining implementation before live use

The checked-in offline cutover now provides the non-collecting renderer and
normalizer, exact v2/v3 schemas, matrix-derived roles, protected-file checks,
synthetic positive/adversarial fixtures, no-execution tests, the v3-only mobile
validator cutover, and independent source review. It does not make this runbook
executable. They cannot execute PowerShell, `wsl.exe`, Docker, Tailscale,
browsers, probes, or administrative commands.

Before live use, a separately reviewed follow-up must provide:

1. tested production adapters for the exact installed Windows Tailscale client
   and daemon versions and their incoming, Serve, Funnel, status, help, and
   disconnect output;
2. independently specified collectors/parsers for Windows listeners, Defender
   and Hyper-V firewalls, forwarding/HNS, WSL listeners, and every Docker
   publish;
3. authentic mode-protected captures from one new continuous attended Windows
   session, with no Mac or synthetic observation reused; and
4. independent review of those exact adapters, collectors, captures, and the
   proposed live commands before any state or exposure changes.

The existing macOS renderer, normalizer, v1 package, v2 report, and runbook do
not satisfy these requirements.

## Intended host boundary

The sole intended route is:

```text
approved physical phone
  -> private authenticated Tailscale HTTPS on Windows TCP/443
  -> attended foreground Windows-host Serve
  -> Windows localhost forwarding
  -> WSL2 API on http://127.0.0.1:4000
```

Tailscale runs on Windows only. The application checkout and API run in the WSL
Linux filesystem. Docker Desktop supplies Linux containers through WSL
integration and its local Unix socket; no second Docker Engine runs in WSL.
The API and every dependency remain on literal IPv4 loopback. LocalStack is
never a phone endpoint or public host.

## Read-only discovery plan

After a separate approval, a future operator first records exact versions and
read-only state without installing, joining, changing, or starting anything:

- Windows version, WSL version/distribution and NAT or mirrored networking,
  localhost-forwarding behavior, Docker Desktop version/context/integration,
  Linux-container mode, and absence of a second WSL Docker Engine;
- Windows and WSL IPv4/IPv6 TCP listener inventories, owning processes, API
  PID/cwd/source HEAD, and all Docker containers, projects, networks, host-mode
  use, and published ports;
- Windows Defender Firewall profiles/effective inbound rules, Hyper-V firewall,
  `netsh interface portproxy`, HNS, and other forwarding state;
- presence, exact version, daemon version, help, preferences, status, incoming,
  Serve, Funnel, and disconnect shapes for the Windows Tailscale client; and
- exact pre-existing tailnet policy, grants, ACLs, tests, node attributes,
  identities, and configuration-log support.

Stop if discovery itself would require mutation, elevation not already approved,
a protected value in a command argument, or an unsupported output adapter.

## Phase/evidence matrix

The [v2 design reference](../tailscale/relay-review-package-v2.md) contains the
normative matrix for session, preflight, policy, active, restart, teardown, and
completion.
The required role set is the union of its non-empty cells; there is no separate
numeric capture-count invariant. Every role has a distinct protected file and
participates once in the ordered source-bundle digest.

Preflight, active, restart, and teardown independently reconcile Windows and
WSL listeners, Defender and Hyper-V firewalls, forwarding, and every Docker
publish. Phase-specific files and hashes cannot be reused. Environment evidence
at session, active, restart, and teardown also repeats the proof that no
Tailscale daemon or second Docker Engine exists in WSL. The policy gate binds
the proposal, applied policy, tests, configuration event, and revalidated
identities before exposure. A final immutable session ledger, created only
after teardown, binds every preceding role/hash/timestamp without modifying the
earlier gate.

The timestamp/hash-linked sequence is fail-closed: incoming access remains
blocked from first enrollment through preflight; the exact policy is proposed,
applied, tested, and identity-revalidated; only then may attended Serve,
incoming access, and probes begin. Active incoming and Serve evidence precedes
every probe. Restart re-blocks incoming before shutdown and repeats this safe
ordering. Teardown blocks incoming first and disconnects the relay last.

## Version-driven Windows Serve and Funnel review

Do not copy macOS commands or assume a Windows socket shape. A future production
adapter must be selected from the exact captured client and daemon versions and
must derive canonical state from exact raw output. An unknown version, missing
field, ambiguous state, or unsupported shape stops the session.

Require no unrelated operating-system TCP/443 listener. Private Serve has one
reviewed root route to exact `http://127.0.0.1:4000`, no services, no background
or persistent route, and no alternate handler. Funnel is semantically disabled:
reject enabled `AllowFunnel`, a public handler/service, persistent state, or any
other enabled form. A tested adapter may accept only the version's documented
empty state or exact disabled-Serve mirror.

The complete dedicated-tailnet policy must fail closed against default allow,
overlapping additive ACLs/grants, extra aliases, missing negative tests,
SSH/Funnel node attributes, or access beyond each exact approved phone to the
exact relay host on TCP/443.

## Required positive and negative probes

Each approved iOS and Android build must independently prove the same reviewed
identity, policy/configuration event, public CA and hostname, and exact `/ready`
HTTP 200 body `{"status":"ok"}`. Only TCP/443 may be reachable. The complete
inventoried non-443 set must be blocked, including at least TCP 22, 80, 1025,
2181, 4000, 4566, 5432, 7700, 8025, 8080, 8081, 9000, 9001, and 9092. Direct
LAN, WSL, and Docker targets remain blocked, and the `.ts.net` origin is blocked
with Tailscale disabled.

A distinct unapproved tailnet peer must prove TCP/443 and every inventoried
denied port blocked. A distinct LAN peer must prove Windows TCP/443 plus every
Windows, WSL, and Docker denied target blocked over applicable IPv4 and IPv6
paths. One peer or address family cannot substitute for another.

## Cold-restart proof

A future explicitly approved attended session must record an ordered cold WSL
and Docker restart. Distinct pre-shutdown, post-restart/pre-exposure, and
re-enabled incoming/Serve/Funnel roles must bind each transition. The event
must also bind the pre-restart hashes, shutdown and restart
order, restored Docker Desktop boundary, unchanged clean source HEAD and API
process/cwd, current migrations, and new post-restart captures. Incoming access
is blocked and Serve is stopped before shutdown; both remain blocked while the
local boundary and readiness are re-proven.

Require exact WSL and Windows HTTP 200 `{"status":"ok"}` readiness, recovered
private HTTPS, both approved-phone results, and repeated unapproved-tailnet and
LAN denials. Reject reused pre-restart bytes, a different source/process,
non-current migrations, missing negative probes, or ambiguous recovery.

## Teardown and restoration proof

Teardown first blocks incoming access, then proves Serve and Funnel semantically
disabled, restores host state, and disconnects the Windows relay last. It must
prove no stale route or proxy and compare preflight and teardown Windows/WSL
listeners, Defender and Hyper-V firewalls, forwarding/HNS, Docker state, and
environment/service/process/socket absence checks. Any difference blocks
completion unless an exact enumerated restoration rule was independently
reviewed and proves equivalent safe state.

Do not use a broad reset that could erase unrelated policy or machine state.
Stop on a failed or ambiguous teardown and keep the protected evidence for
review.

## Evidence handling

Raw identities, IPs, DNS names, policy, node IDs, principals, process details,
firewall rules, and probe exports remain in a reviewer-controlled mode-0700
directory on the WSL Linux filesystem, outside Git and OneDrive. Never use
`/mnt/*`, DrvFS, another Windows-mounted tree, or a synced path. Store each
capture as a distinct current-user-owned mode-0600 regular file and reject a
filesystem whose Linux ownership/mode/no-follow guarantees cannot be proven.
Never store captures in `.env`, logs, tickets, chat, shell arguments, or command
history. Never copy Mac captures into the Windows session.

The normalizer emits only canonical redacted report v3 bytes and a
fixed unsigned warning. The candidate is not authenticated evidence. A complete
new Windows session is required; v1 inputs or v2 reports cannot be converted,
renamed, supplemented, or partially reused.

## Explicit stop rules

- Stop before installing, joining, authenticating, reauthenticating, or
  renaming any Tailscale node.
- Stop before applying or changing any tailnet ACL, grant, test, node
  attribute, or policy.
- Stop before enabling incoming connections or starting Serve.
- Never enable or invoke Funnel.
- Stop before any Defender Firewall, Hyper-V firewall, `netsh portproxy`, WSL
  networking, `.wslconfig`, listener, bind, Docker publish, or routing change.
- Never run Tailscale inside WSL when it runs on Windows.
- Never bind the API or dependencies to wildcard, LAN, WSL-address, or
  Tailscale-address interfaces.
- Stop on pre-existing Serve/Funnel state, TCP/443 use, broad or overlapping
  policy, unknown client version/schema, missing capture, identity drift,
  unexpected listener/firewall/forwarding change, probe ambiguity, or teardown
  mismatch.
- Stop before requesting a `.ts.net` certificate unless its Certificate
  Transparency names were explicitly approved.
- Keep Name.com DNS unchanged.
- Stop before connecting a phone or running probes without explicit approval.
- Stop before EAS configuration, build, signing, credentials, device
  registration, or quota use.
- Never use real health or nutrition data.
- Never place protected captures in Git, OneDrive, `.env`, logs, tickets, chat,
  or command arguments.
- LocalStack is never a phone endpoint or public host.

## Completion criteria

This runbook remains non-executable until all boxes can be checked by a separate
reviewed change and approved attended session:

- [x] The atomic renderer/normalizer/verifier implementation and adversarial
  tests are present in this change and independently reviewed.
- [ ] Exact Windows, WSL, Docker, Tailscale, networking, firewall, and
  forwarding versions/shapes are supported by tested adapters.
- [ ] Separate approval was obtained for every live mutation and probe phase.
- [ ] All matrix captures, cold-restart checks, positive/negative probes, and
  redaction/source-bundle checks passed in one continuous synthetic-data session.
- [ ] Teardown and complete state restoration were independently proven.
- [ ] A trusted reviewer signed the exact candidate only after inspecting every
  protected source byte.

Until then, phone exposure remains blocked.
