# Container supply chain

The `container supply chain` workflow builds the API, worker, migrator, web,
Caddy, and PostgreSQL runtime images for `linux/arm64`. It runs on pushes to the
default branch and can also be started manually from that branch. It never
deploys infrastructure or updates a running environment.

## Publication boundary

Each matrix job builds an OCI image index by digest without creating a tag. The
build includes maximum-mode BuildKit provenance and a Syft SPDX SBOM. Trivy then
scans the exact digest and fails on any HIGH or CRITICAL operating-system or
application-library vulnerability, including vulnerabilities without a published
fix. The job supplies an explicit empty ignore file, so a repository-level Trivy
ignore file cannot silently waive findings. A scan or vulnerability-database
failure fails the job.

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
OCI labels, and current vulnerability scan all pass. Failed first builds may
leave untagged registry content for GHCR garbage collection, but they do not
create a deployable tag.

OCI deployment must consume the recorded digest, not a mutable convenience tag:

```text
ghcr.io/<owner>/<repository>-api@sha256:<digest>
```

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

The 2026-08-17 local reproduction used Trivy v0.74.0 with database update
`2026-08-17T06:55:37Z`, `linux/arm64`, OS and library scanners, an explicit
empty ignore file, HIGH/CRITICAL severities, and unfixed findings included:

| Candidate | Exact local image ID | Critical | High |
| --- | --- | ---: | ---: |
| repository PostgreSQL 17.11 | `sha256:ff1588d49ac2dc64d7cfd3a8f3d9c80934676cf3bb71608a0e04a0668a631029` | 0 | 0 |
| repository Caddy v2.11.4 plus reviewed dependency patches | `sha256:9891b652cf8f41aec8b2ce9a83c080eff8562df7dbe5d720dc80a91459de155a` | 0 | 0 |

These local IDs are reproducibility evidence, not deployment references or
approval. BuildKit provenance makes the GitHub-built index digest distinct. A
commit is eligible only when the workflow builds the exact source commit, the
current Trivy database still reports zero HIGH/CRITICAL findings, the runtime
identity and behavior checks pass, GitHub records matching provenance, and the
immutable GHCR commit tag resolves to that scanned digest.

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
index.

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
- Protect the default branch and require all six repository-image checks and the
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

Then record all six repository component digests plus the locked Meilisearch
digest in the release evidence, and configure OCI to pull only those
digest-qualified references. Promotion or rollback is a separate, explicitly
authorized operation.
