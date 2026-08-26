# Container supply chain

The `container supply chain` workflow produces seven repository-owned
`linux/arm64` artifacts: a dedicated patched Node runtime, four application
images, Caddy, and PostgreSQL. The Node runtime is a build input for the four
applications, not a seventh deployment image. The workflow runs on pushes to
the default branch and can also be started manually from that branch. It never
deploys infrastructure or updates a running environment.

## Publication boundary

The dedicated Node producer runs natively on GitHub's `ubuntu-24.04-arm`
runner. After that producer publishes a passing digest, each application build
receives only its digest-qualified
`ghcr.io/<owner>/<repository>-node-runtime@sha256:<digest>` output through the
required `NODE_RUNTIME_IMAGE` build argument. There is no application
Dockerfile default to fall back to. The Caddy and PostgreSQL jobs are independent
of the Node producer, so a Node source build failure does not prevent those
unrelated system-runtime checks from running.

Each producer builds an OCI image index by digest without first creating a tag.
The build explicitly requests maximum-mode SLSA v1 BuildKit provenance and a
Syft SPDX SBOM. Trivy then scans the exact digest with OS and library scanners
and fails unless both
HIGH and CRITICAL counts are zero, including vulnerabilities without a
published fix. Before scanning, a checked-in verifier requires exactly one
`linux/arm64` runtime descriptor and its exact BuildKit OCI attestation artifact,
whose subject is that runtime and which has one SPDX in-toto predicate layer and
one SLSA v1 provenance predicate layer. It also fetches the actual payloads and
requires a nonempty SPDX 2.3 document plus the nonempty BuildKit SLSA v1
`buildDefinition` and `runDetails`. Missing, duplicated, empty, differently
referenced, or differently typed attestations fail closed for both a new build
and an existing commit tag. Every
scan receives an explicit empty ignore file, so neither a repository
`.trivyignore` nor an undocumented exception can waive a finding. A scan,
inventory, vulnerability-database, or attestation-verification failure fails
the job.

The Node producer also requires a complete package inventory and exact binary
checks before publication. The four applications run their own exact-digest
Trivy inventories with `--list-all-pkgs` and require component-specific packages
and versions from checked-in manifests. These checks prevent a zero-finding
result from being accepted when the scanner did not discover the expected
runtime or application libraries.

The publication path deliberately disables reusable action, BuildKit, and Trivy
caches. The slower cold build avoids restoring executable or build-layer state
that was not produced inside the current release job.

Only a passing digest receives a tag:

```text
ghcr.io/<owner>/<repository>-<component>:sha-<full-commit-sha>
```

After the scan, the job records a GitHub artifact attestation. The publishing
step never replaces an existing commit tag and verifies that the final tag
resolves to the digest Trivy scanned. This matters because maximum-mode
provenance makes a rebuilt image index intentionally invocation-specific. On a
same-commit retry, an existing tag is reused only after its GitHub-hosted build
attestation, workflow/source identity, single `linux/arm64` runtime descriptor,
exact SPDX/SLSA BuildKit predicates, OCI labels, and current vulnerability scan
all pass. Failed first builds may leave untagged registry content for GHCR
garbage collection, but they do not create a deployable tag.

OCI deployment must consume the recorded digest, not a mutable convenience tag:

```text
ghcr.io/<owner>/<repository>-api@sha256:<digest>
```

## Repository-owned patched Node runtime

`infra/docker/node-runtime.Dockerfile` builds Node.js v22.23.2 from the official
source archive instead of copying the vulnerable executable from an existing
runtime. The source archive SHA-256 is
`bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb`.
The checked manifest and detached signature are independently pinned as
`778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39`
and
`169f1452c14cd653247408352f1534b9f31e3d13f9c6399c3977368095e11eda`.
The build imports only the repository-pinned Node release key with fingerprint
`CC68F5A3106FF448322E48ED27F5E38D5B0A215F`, verifies the detached signature
over `SHASUMS256.txt`, and then verifies the one exact manifest entry for the
source archive. Provenance labels also bind release tag object
`490a9fef8f8adcda5a95bd6f96035b05cb43fe5b`, release commit
`aa4c77582be995286fc6e00aaf530dc7ade102a9`, release-signer source commit
`43d7b8e5d41e87a3721d416f14fb86a68aeec1ce`, and the checked-in signer-material
checksum.

Node v22.23.2 vendors OpenSSL 3.5.7. The OpenSSL security advisory dated
2026-08-13 identifies abbreviated commit `08e7756` as the 3.5-branch fix for
CVE-2026-14456. The patch resolves that abbreviation to full commit
`08e7756c3900bcfd77a720e7b74e27d6e4ed01a9`. The commit itself and its GitHub
`.patch` are **not signed**; the authority is the official advisory naming the
abbreviation. The downloaded full-commit patch is therefore independently
pinned by SHA-256
`3b4f3ff1e9d26ca3dd75f6d98cc5d30c7dbfc03892e4bc0037a7e14bec8c5087`.
The build checks the patch's commit header and seven-path diff, applies the six
code/template paths present in Node's vendored OpenSSL tree, and adds the
corresponding `SSL_VALUE_QUIC_MAX_PENDING_CONNS` macro to all three generated
ARM64 headers (`asm`, `asm_avx2`, and `no-asm`). Forward and reverse patch checks
must both pass.

The source build uses the pinned Python 3.12.14 Bookworm builder index
`sha256:80f5d259a5969c86f6c92145d572de4a68c68e0edd28d4367dec0fb411b42af3`
and its unique ARM64 child
`sha256:b6e215e1d3d8787fe1e0f1507c7d2418b16fe19acef77cf971b2d965570ced41`.
CI resolves that index-to-child relationship before building. The final
filesystem starts from the signed Distroless Debian 13 `base-nossl` `nonroot`
index
`sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f`
and ARM64 child
`sha256:ab7e729cfe775ce5f251b2d28b45e88b70e0582cdbadd1aa1f99a41601f11f3b`.
It copies only the exact `libgcc_s`/`libstdc++` runtime files and package metadata
from the signed Distroless Node index
`sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167`
and ARM64 child
`sha256:806e2fa26e3cec196e986cb206f44f07070d211c028389c79091fd440cb75882`.
CI verifies both Distroless indexes with Cosign identity
`keyless@distroless.iam.gserviceaccount.com`, issuer
`https://accounts.google.com`, and their unique ARM64 child digests.

OpenSSL remains statically embedded in the newly built Node executable; removing
a dynamically installed `libssl3t64` package alone would not remediate it. CI
therefore checks the exact Node/OpenSSL versions, the absence of dynamic
`libssl`/`libcrypto` dependencies, the complete five-entry ELF `NEEDED`
allowlist and ARM64 interpreter, and both internal max-pending-channel symbols
introduced by the patch. The official prebuilt Node ARM64 executable has seven
`NEEDED` entries, but it is an audit reference rather than the deployed binary.
The pinned Debian bookworm source builder uses glibc 2.34 or newer, where
`libdl` and `libpthread` functionality is folded into `libc`; the freshly linked
binary therefore omits separate `libdl` and `libpthread` dependencies. In this
exact Node source configuration,
`process.config.variables.openssl_quic` and `node_shared_openssl` are both
`false`, and the public experimental QUIC flag/module is absent. Those values
are asserted as observed source-build properties; they are not treated as proof
that the vulnerable internal OpenSSL code was absent. The symbol and patch
checks provide that evidence.

The producer must then pass the zero-HIGH/zero-CRITICAL no-ignore Trivy gate,
runtime/package inventory, CA and timezone behavior, no-shell check, SBOM,
provenance attestation, immutable commit-tag verification, and digest output.
Until those checks pass in GitHub Actions, the design is not release approval.

## Repository-owned application runtimes

The API, worker, migrator, and web builds retain the exact
`node:22-bookworm-slim` index digest only as a build stage. npm and the
checksum-pinned pnpm archive install dependencies and compile artifacts there;
that stage is not copied into a published runtime. Vulnerabilities in builder
operating-system packages or build-only npm tooling remain relevant to build
provenance and dependency maintenance, but they do not describe the final image
that Trivy admits for deployment.

Each application Dockerfile requires the dedicated Node runtime by immutable
digest and adds only the built application tree and minimal UID/GID 1000 `node`
passwd/group/home records. It does not independently select or reconstruct Node,
OpenSSL, the C++ libraries, or the Distroless base. The final application label
records the exact injected Node-runtime GHCR digest; inherited labels retain all
source, signature, patch, builder, C++ source, base, and ARM64 child provenance.
OCI admission rejects a tag, another repository, a missing digest, or any
changed inherited provenance label.

The applications explicitly keep an empty entrypoint so OCI command overrides
retain their existing semantics and expose `/nodejs/bin` through `PATH`. They
contain neither npm nor a shell. CI checks exact provenance labels, command, and
health metadata, then runs each final image with a read-only root, no
capabilities, and only a UID-owned `/tmp` tmpfs. The runtime check covers UID/GID
and `os.userInfo()`, CA bundle readability, Chicago winter/summer timezone
transitions, application entrypoint syntax/imports, absence of npm and
`/bin/sh`, and actual Next standalone startup.

The OCI controlled-beta deployment continues to run all four applications as
`1000:1000`, with read-only roots and reviewed writable tmpfs/bind mounts. This
contract is synthetic-reviewer-only and does not make the environment suitable
for real health data.

## Repository-owned system runtimes

`infra/docker/postgres.Dockerfile` derives from the exact PostgreSQL 17.11 on
Alpine 3.24 index
`sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
The expected ARM64 child is
`sha256:dfc2780980fe6ca2d158bfe4342660db5e4c6431fb969088e543430d09f8d0f2`.
The parent review found 22 HIGH/CRITICAL records, all Go standard-library
records attached to `/usr/local/bin/gosu`; its Alpine packages had none. The
derivative deletes gosu and fixes the final user to `70:70`, which makes the
official entrypoint's root-only privilege-switch branch unreachable while
retaining its initialization, init-script, existing-cluster, TLS, stop-signal,
and health semantics. The OCI controlled-beta runtime must present PGDATA and the
`/var/run/postgresql` and `/tmp` tmpfs mounts pre-owned by `70:70`.

`infra/docker/caddy.Dockerfile` builds Caddy v2.11.4 from commit
`e2eee6a7fce366321294c9c2a79f3146891dcbdf`. CI checks that annotated tag
object `8ec11a4b7e39a5fd00da2fc5cb9b543e31fd7926` resolves to that commit and
verifies its SSH signature against the repository-pinned Ed25519 signer. The
source archive is checksum-pinned. Go 1.26.6 is pinned by image index digest,
and the scratch runtime receives only the static Caddy binary, the exact Alpine
`ca-certificates-bundle` 20260611-r0 payload, the exact `tzdata` 2026c-r0
payload, and minimal user/directory files. The build explicitly advances the
three vulnerable release dependencies to `golang.org/x/net` v0.56.0,
`golang.org/x/text` v0.39.0, and `google.golang.org/grpc` v1.82.1; final image
labels disclose that patched graph, and the build asserts all three binary
module versions. Caddy runs as `1000:1000`. The OCI controlled-beta runtime must
drop all capabilities, add only `NET_BIND_SERVICE`, and present writable `/data`
and `/config` mounts owned by `1000:1000`.

The 2026-08-18 `base-nossl` composition experiment is explicitly rejected as
remediation evidence. It removed the dynamically installed `libssl3t64` package,
so Trivy no longer reported that package's CVE-2026-14456 record, but it copied
the original Node executable with its unpatched statically embedded OpenSSL
3.5.7. Debian/Trivy classified that package record as HIGH and fix-deferred,
while the upstream OpenSSL advisory classifies the underlying issue as Low; the
strict repository gate remains zero HIGH/CRITICAL and does not use either
classification as a waiver. A zero scanner result caused only by hiding the
package record is not a release gate. The dedicated source-built runtime and its
binary/symbol checks replace that design; only its GitHub-produced digest can
satisfy the current policy.

The 2026-08-17 system-runtime reproduction used the same policy with database
update `2026-08-17T06:55:37Z`:

| Candidate | Exact local image ID | Critical | High |
| --- | --- | ---: | ---: |
| repository PostgreSQL 17.11 | `sha256:ff1588d49ac2dc64d7cfd3a8f3d9c80934676cf3bb71608a0e04a0668a631029` | 0 | 0 |
| repository Caddy v2.11.4 plus reviewed dependency patches | `sha256:9891b652cf8f41aec8b2ce9a83c080eff8562df7dbe5d720dc80a91459de155a` | 0 | 0 |

The system-runtime local IDs are reproducibility evidence, not deployment
references or approval. BuildKit provenance makes the GitHub-built index digest
distinct. A commit is eligible only when the workflow builds the exact source
commit, the current Trivy database still reports zero HIGH/CRITICAL findings,
the runtime identity and behavior checks pass, GitHub records matching
provenance, and the immutable GHCR commit tag resolves to that scanned digest.

Local runtime checks also passed the repository's exact OCI Caddyfile with its
automatic-HTTPS routes and internal certificate, a UID-1000 bind to port 80
with only `NET_BIND_SERVICE`, and PostgreSQL first initialization plus init SQL,
TLS-required SQL, image health, and an existing-cluster restart as UID 70.

## External runtime image boundary

Meilisearch is the only upstream runtime reference in
`infra/oci/external-images.lock.json`. Its entry locks both the upstream
multi-platform index digest and the expected `linux/arm64` child digest. CI
resolves that exact index, verifies the child configuration and keyless Cosign
signature, scans the current digest with the same strict Trivy policy, and
requires the reviewed approval bit. Unknown-platform descriptors are accepted
only for attestations that refer back to a real runtime descriptor in the same
index. The lock validator accepts only the reviewed Meilisearch repository and
tag identity with a verified Sigstore keyless signature from the GitHub Actions
OIDC issuer. The pinned Cosign 3.1.3 verifier explicitly requires the Sigstore
v0.3 new-bundle path used by the image's OCI 1.1 DSSE
`https://sigstore.dev/cosign/sign/v1` referrers and checks that the signed
in-toto subject is the exact locked index digest; an unsigned-container review
cannot satisfy this gate.

Caddy and PostgreSQL deployment references now point to the repository-owned
GHCR digests described above. OCI Object Storage replaces the MinIO OCI runtime;
MinIO remains only a local/CI compatibility fixture. No external-image
approval or successful container scan authorizes real health data. The current
single-node, non-HA environment remains limited to synthetic reviewer data.

## Required GitHub configuration

- Enable GitHub Actions and GitHub Packages for the repository.
- Permit the workflow's explicitly requested `packages: write`, `id-token: write`,
  and `attestations: write` job-token permissions. No personal access token is
  used to publish.
- If an identically named GHCR package already exists without repository linkage,
  grant this repository write access under the package's **Manage Actions access**
  settings. A package created by this workflow should inherit its repository link
  from the OCI source label.
- If the repository or organization restricts Actions, allow the exact pinned
  revisions named in `.github/workflows/container-supply-chain.yml`, including
  the transitive actions pinned by Trivy and GitHub's attestation action.
- Protect the default branch and require all seven repository-artifact checks
  (the Node producer, four applications, Caddy, and PostgreSQL) plus the
  Meilisearch external-image check before treating a commit as releasable.

GHCR package visibility and pull authentication are deployment prerequisites.
Packages are private by default even when the source repository is public. Either
leave them private and give the OCI host a narrowly scoped, read-only package
credential, or explicitly make them public if anonymous pulls are acceptable.
Never copy the workflow's job token to OCI; it is short-lived and scoped to the
GitHub runner.

## Verification and deployment handoff

Copy the image reference and digest from the workflow summary. Before deployment,
verify the GitHub provenance from an authenticated GitHub CLI session:

```sh
gh attestation verify \
  'oci://ghcr.io/<owner>/<repository>-api:sha-<full-commit-sha>' \
  --repo '<owner>/<repository>'
```

Then record the dedicated Node-runtime digest, all six deployment component
digests, and the locked Meilisearch digest in the release evidence. Configure
OCI to pull only the six deployment components and Meilisearch by immutable
digest; the Node-runtime artifact remains transitive build evidence and is not a
Compose service. Promotion or rollback is a separate, explicitly authorized
operation.
