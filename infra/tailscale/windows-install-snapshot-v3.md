# Windows Tailscale installation snapshot v3

> **STOP — structural validator only; production installation evidence remains
> blocked.**
>
> `windows_install_snapshot.py` is pure, offline, and non-collecting. Its
> immutable production artifact-corpus registry is empty. It cannot inspect the
> host, run an installer, authenticate Tailscale, authorize an installation, or
> clear the physical-phone gate. Function-level corpus injection accepts only
> synthetic `test-` fixtures.
>
> `windows_install_collector.ps1` is a source-only scaffold.
> Its production path fails before corpus parsing or snapshot construction and
> contains no host query, process invocation, network request, or file write.
> It has not been executed against Windows and is not a production collector.

This contract covers only a future attended installation-only transition on
the Windows host. It does not cover login, tailnet enrollment, incoming access,
Serve, Funnel, policy, firewall changes, listener exposure, phone probes,
certificates, or EAS. Operator approval is external to every snapshot and
manifest field.

## Fixed package and command boundary

The current reviewed generations are artifact corpus
`nutrition-tracker-windows-tailscale-install-artifact-corpus-v2` and collector
`nutrition-tracker-windows-tailscale-install-collector-v2`. The reviewed
package pin is Windows amd64 Tailscale `1.102.3`, MSI
SHA-256
`03ac8183c6e3ce276e9b44281ebe7e4c02aef28a971034ca170c4b665df42dce`.
That pin is necessary but not sufficient: a production artifact corpus must
also bind exactly eight ordered roles: `installer`, `client`, `gui`, `daemon`,
`driverLibrary`, `driverInf`, `driver`, and `catalog`. Every role binds one
canonical Windows path and SHA-256 digest. Authenticode evidence binds its
verification kind and status, the SHA-256 digests of the exact signer and
timestamp leaf-certificate DER bytes, and the canonical signed timestamp.
Catalog membership separately binds the explicit catalog role and SHA-1 member
digest for `driverInf` and `driver`. The INF must not claim an embedded
signature; the driver must carry both embedded-signature and catalog-membership
evidence; and the catalog must use `signed-catalog`. All remaining
non-INF/non-catalog roles, including the MSI, require
`embedded-authenticode`. Missing, extra, reordered, self-referential, or
misclassified evidence fails closed. The corpus also binds the exact service
path and argument vector. Artifact paths must remain distinct under Windows
case-insensitive path comparison.

| Role | Authenticode evidence | Catalog membership |
| --- | --- | --- |
| `installer`, `client`, `gui`, `daemon`, `driverLibrary` | `embedded-authenticode` | `null` |
| `driverInf` | `null` | `Valid`, role `catalog`, SHA-1 member digest |
| `driver` | `embedded-authenticode` | `Valid`, role `catalog`, SHA-1 member digest |
| `catalog` | `signed-catalog` | `null` |

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
`nutrition-tracker-windows-tailscale-install-snapshot-v3` has exactly:

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

The `tailscaleInstall` and `adapters` raw roles use their `raw-v2` schemas
because they must carry the complete eight-role evidence and explicit
INF/SYS/catalog adapter bindings. Raw roles whose shapes did not change remain
at `raw-v1`. Session, capture, and synthetic-raw commitment domains are `v2`;
the unchanged challenge domain remains `v1`. Inputs from earlier generations
cannot be relabeled or converted.

## Install-only safety invariants

Preinstall must prove Tailscale absent, including product registration,
service, adapter, Program Files, ProgramData, registry residuals, scheduled
tasks, firewall rules, DNS policy, routes, UI processes, and update mechanisms.

Postinstall permits only the exact corpus artifacts, one exact running
automatic Local System service, and one exact tunnel adapter in `down` state.
The adapter must bind the corpus-reviewed INF, SYS, and catalog paths and
SHA-256 digests independently; swapping any of the three fails closed.
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
`nutrition-tracker-windows-tailscale-install-corpus-manifest-v3` is a redacted
structural candidate. `productionArtifactCorpusMatched` means only that an
immutable production registry entry matched; it never means installation or
live use was authorized.

## Source-only collector scaffold

The checked-in PowerShell scaffold freezes the collector schema, ordered raw
roles, domain-separated commitments, canonical synthetic snapshot shape, exact
MSI record, redaction surface, and production fail-closed gate. Only an explicit
`-SyntheticFixture` parameter can reach construction. That path accepts a
bounded, canonical JSON envelope from standard input containing only a
challenge and a `test-` artifact corpus; neither value is accepted on the
command line. The embedded collector source identity is the SHA-256 of the
exact LF source after replacing the single embedded identity digest with 64 zero
bytes. Static Python tests bind the test corpus to that identity, separately pin
the complete collector source and security-surface hashes, reject added
output/host-command surfaces, and validate the corresponding Python fixtures
without running PowerShell.

This remains reviewable synthetic-contract evidence, not Windows-host
evidence. The explicit proof below executes only the `-SyntheticFixture`
PowerShell path; it does not execute a Windows-host or production collector
path, capture any protected raw source, or register a production corpus or
parser. Future production work must replace the fail-closed branch in a
separately reviewed change, authenticate its exact source and parser bundle,
and retain the output and no-mutation boundaries.

The explicit cross-language producer proof is
`tests/windows_install_collector_producer_check.py`. Generic unit-test
discovery never invokes it. It builds the exact canonical `test-` envelope in
memory, invokes two fresh `-SyntheticFixture` processes per phase without a
shell or temporary file, requires byte-for-byte equality with independently
constructed Python snapshots, and then validates the pair. It also proves
fail-closed behavior for a canonical invalid challenge, a canonical committed
corpus with an array-shaped `corpusKind`, and an in-memory
131,073-ASCII-character input. Failure checks reject every eight-byte fragment
derived from string values in the canonical invalid envelope and every raw
eight-byte sliding window in the oversized input, except overlaps already
present in the exact reviewed collector source, fixed generic failure marker,
or resolved script path. The child environment removes all inherited
`COREHOST_*`, `DOTNET_*`, `DYLD_*`, `LD_*`, and PowerShell
module/policy/cache runtime-injection variables, and the compact result
identifies the resolved absolute PowerShell executable by SHA-256 and
classifies its runtime. The executable is rehashed after the proof processes
before that identity is emitted.

Run the proof only with PowerShell 7.4 or newer and a policy that accepts the
exact reviewed script. Never use an execution-policy bypass; if signature
policy rejects the source, stop and use a signed source or a separately
approved native WSL PowerShell runtime. A `native-linux` result proves the
cross-language synthetic contract, not Windows-host execution-policy or
signature-policy compatibility. The hosted quality job invokes the same
module explicitly and fails if its native PowerShell boundary is unavailable.

From the repository root, invoke the proof explicitly as a module:

```text
python3 -B -m infra.tailscale.tests.windows_install_collector_producer_check
```

## Protected handling and remaining blockers

Any future raw bundle and snapshots belong in a current-user-owned mode-0700
directory on the WSL native Linux filesystem, outside Git and OneDrive, with
each file a distinct mode-0600 regular file. Do not place raw listener owners,
paths beyond the reviewed artifact set, registry values, identities, addresses,
or installer logs in Git, chat, shell history, `.env`, tickets, or synced paths.

Before a production corpus can be registered, all of these remain required:

1. retain the exact official MSI and extracted artifacts in protected local
   evidence, with strict-TLS provenance, hashes, Authenticode, kernel-policy,
   timestamp, and explicit catalog-membership checks independently reviewed;
2. capture and independently review all eight artifacts at their exact
   postinstall Windows paths, the service command, and the immutable external
   review-source bundle; host-assigned INF/catalog paths must never be guessed;
3. extend and review the source-only scaffold into the exact production
   collector plus every parser corpus, including complete elevated Windows
   firewall/Hyper-V/HNS evidence without mutation;
4. capture and approve this machine's exact safe host, listener, and boundary
   baseline; and
5. land the production corpus in a separate reviewed change, then obtain or
   reconfirm explicit approval for the exact elevated MSI action and recovery
   command.

The completed offline acquisition and verification is corpus research only and
never authorizes execution. Until steps 2 through 5 are complete, do not
install on the strength of this validator, and do not treat synthetic tests as
host evidence.
