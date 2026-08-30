# Windows Tailscale installation snapshot v2

> **STOP — structural validator only; production installation evidence remains
> blocked.**
>
> `windows_install_snapshot.py` is pure, offline, and non-collecting. Its
> immutable production artifact-corpus registry is empty. It cannot inspect the
> host, run an installer, authenticate Tailscale, authorize an installation, or
> clear the physical-phone gate. Function-level corpus injection accepts only
> synthetic `test-` fixtures.

This contract covers only a future attended installation-only transition on
the Windows host. It does not cover login, tailnet enrollment, incoming access,
Serve, Funnel, policy, firewall changes, listener exposure, phone probes,
certificates, or EAS. Operator approval is external to every snapshot and
manifest field.

## Fixed package and command boundary

The current reviewed package pin is Windows amd64 Tailscale `1.102.3`, MSI
SHA-256
`03ac8183c6e3ce276e9b44281ebe7e4c02aef28a971034ca170c4b665df42dce`.
That pin is necessary but not sufficient: a production artifact corpus must
also bind the exact installer, client, daemon, driver, and catalog paths,
digests, signature status, and signer-identity digests, plus the exact service
path and argument vector. Artifact paths must also remain distinct under
Windows case-insensitive path comparison.

The only planned installation command shape is:

```text
C:\Windows\System32\msiexec.exe /i <exact-reviewed-msi-path> /qn /norestart TS_NOLAUNCH=1 TS_ALLOWINCOMINGCONNECTIONS=never TS_UNATTENDEDMODE=never TS_INSTALLUPDATES=never
```

The preinstall snapshot records that exact plan with no result. The postinstall
snapshot requires observed process exit `0`, no restart requested or initiated,
and no UI launch. The validator never executes this command. Changing the path,
argument order, property, result, or elevation claim fails closed.

## Snapshot and freshness contract

Each canonical
`nutrition-tracker-windows-tailscale-install-snapshot-v2` has exactly:

- `schemaVersion`, `phase`, and canonical millisecond UTC `capturedAt`;
- `session` and all 12 `rawSources`;
- `hostEnvironment`, `tailscaleInstall`, and `installerExecution`;
- the complete redacted `listeners` and `boundaries`; and
- `restrictedCommandsExecuted`, which must be `false`.

The caller supplies a fresh 128-bit lowercase-hex challenge out of band. Both
snapshots bind its domain-separated digest, one boot-session commitment, the
exact artifact corpus and collector source, phase sequence 1 then 2, and
monotonic time. Wall-clock and monotonic elapsed time must prove one positive
window of no more than 30 minutes. A stale, cross-boot, cross-corpus,
cross-collector, reversed, or replayed pair fails.

The 12 ordered source roles are `hostEnvironment`, `tailscaleInstall`,
`installerInvocation`, `installerResult`, `listeners`, `windowsFirewall`,
`hyperVFirewall`, `forwarding`, `hns`, `docker`, `services`, and `adapters`.
Every phase binds a fresh raw digest, exact role schema, reviewed parser-corpus
digest, and session/phase/sequence capture commitment. Those commitments are
not signatures and do not authenticate a collector; the exact collector and
protected raw-source bundle still require independent review.

## Install-only safety invariants

Preinstall must prove Tailscale absent, including product registration,
service, adapter, Program Files, ProgramData, registry residuals, scheduled
tasks, firewall rules, DNS policy, routes, UI processes, and update mechanisms.

Postinstall permits only the exact corpus artifacts, one exact running
automatic Local System service, and one exact tunnel adapter in `down` state.
It requires no login, tailnet identity, Serve, Funnel, tailnet route, tailnet
DNS, UI process, update mechanism, incoming permission, or tailnet address.

The host must remain Windows 11 with WSL2 `Ubuntu-24.04`, Docker Desktop Linux
containers through WSL integration, no Tailscale in WSL, and no second WSL
Docker Engine. The complete listener inventory binds scope, safe redacted
address class, protocol/port, owner commitment, owner class, and owner-binary
digest. Wildcard, public, Tailscale-addressed, or unreviewed listeners fail.
The host, listener, firewall, Hyper-V firewall, forwarding, HNS, Docker,
non-Tailscale service, and non-Tailscale adapter commitments must equal one
independently reviewed baseline before and after installation.

The output
`nutrition-tracker-windows-tailscale-install-corpus-manifest-v2` is a redacted
structural candidate. `productionArtifactCorpusMatched` means only that an
immutable production registry entry matched; it never means installation or
live use was authorized.

## Protected handling and remaining blockers

Any future raw bundle and snapshots belong in a current-user-owned mode-0700
directory on the WSL native Linux filesystem, outside Git and OneDrive, with
each file a distinct mode-0600 regular file. Do not place raw listener owners,
paths beyond the reviewed artifact set, registry values, identities, addresses,
or installer logs in Git, chat, shell history, `.env`, tickets, or synced paths.

Before a production corpus can be registered, all of these remain required:

1. download the exact official MSI with strict TLS and independently verify its
   published checksum and Authenticode signature;
2. derive and independently review all five artifact hashes, signers, fixed
   paths, service command, and immutable external review-source bundle;
3. implement and review the exact collector plus every parser corpus, including
   complete elevated Windows firewall/Hyper-V/HNS evidence without mutation;
4. capture and approve this machine's exact safe host, listener, and boundary
   baseline; and
5. land the production corpus in a separate reviewed change, then obtain or
   reconfirm explicit approval for the exact elevated MSI action and recovery
   command.

The step-1 offline download is corpus acquisition only and never authorizes
execution. Until steps 2 through 5 are complete, do not install on the strength
of this validator, and do not treat synthetic tests as host evidence.
