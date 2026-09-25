# Local infrastructure

This Compose project runs only local dependencies. PostgreSQL is authoritative;
Meilisearch is a disposable projection, SeaweedFS supplies the private S3 test fixture, and
Mailpit captures email without delivering it.

```sh
install -m 600 .env.example .env
pnpm infra:up
pnpm --filter @nutrition-tracker/db db:migrate
pnpm infra:status
```

`pnpm infra:up` accepts no arguments. Before contacting Docker, it requires `.env`
to be an owned, regular, single-link mode-`0600` file. It rejects every ambient
Docker or Compose override, binds the exact `nutrition-tracker-local` project,
and requires Docker Desktop's Linux server through `/var/run/docker.sock`. It
captures the rendered Compose model without printing interpolated values and
validates the exact four-service, named-volume, read-only credential-mount, health,
and loopback-port topology before starting anything. It waits at most 300
seconds for PostgreSQL, Meilisearch, object storage, and Mailpit, bootstraps
the two buckets through signed host requests, and verifies the four persistent services and
their effective published ports afterward.

`pnpm infra:status` accepts no arguments and repeats the same environment-file,
Docker Desktop, fixed-project, rendered-model, and healthy loopback-port checks
without changing container state or printing the rendered environment.

Local endpoints:

| Service | Endpoint |
| --- | --- |
| PostgreSQL | `127.0.0.1:5432` |
| Meilisearch | <http://127.0.0.1:7700/health> |
| S3 fixture | <http://127.0.0.1:9000/readyz> |
| Mailpit UI / SMTP | <http://127.0.0.1:8025> / `127.0.0.1:1025` |

The startup helper generates five separate credentials and attaches the four
policies in `infra/object-store/` plus a fixture-only admin policy. It creates
private export and erasure-ledger buckets. Export versioning is suspended so
expiry can delete the null version; ledger versioning is enabled. Restore can
list versions only under `erasure-ledger/v1/*` and read the exact version. Admin
and restore credentials never enter the API or worker environment.

Generated files live in owner-only `.local-data/object-store/`. The read-only
S3 configuration is mode `0444` inside that mode-`0700` directory so the image's
UID 1000 can read its file bind on different host UIDs. `runtime.env` is mode
`0600`; `pnpm dev` and `pnpm dev:api` validate it and apply only the existing
application environment allowlist. Repeated startup retains credentials and
rejects policy, port or bucket-versioning drift. The new `object-store-data`
volume never reuses former MinIO state.

All host ports bind to loopback. The object-store process has limits of 1 GiB,
2 CPUs and 256 PIDs. Only its S3 endpoint is published; internal services bind
to container loopback. See [fixture qualification](../object-store/README.md)
for the exact image trust gate and the limits of offline checks.

Stop through the same Docker Desktop, environment-file, and fixed-project
boundary without deleting state:

```sh
pnpm infra:down
```

The shutdown wrapper accepts no arguments and never requests volume or orphan
removal. Deleting named volumes is destructive and intentionally omitted from
normal instructions. Follow the restore runbook before replacing database state.

## Published OCI runtimes

The default-branch supply chain produces eight repository-owned ARM64 artifacts:
the dedicated `node-runtime.Dockerfile`, the four application Dockerfiles,
`caddy.Dockerfile`, `postgres.Dockerfile`, and `meilisearch.Dockerfile`. These are controlled-beta
inputs, not replacements for the developer services above. The Node runtime is
an intermediate build artifact; the other seven become deployment images.
Every artifact must pass its exact-digest scan, inventory, identity, provenance,
and behavior gates before receiving an immutable commit tag.

`node-runtime.Dockerfile` builds Node.js v22.23.2 on a native ARM runner from the
official source archive after verifying the signed Node release manifest and its
one exact archive checksum. It applies the checksum-pinned full OpenSSL commit
`08e7756c3900bcfd77a720e7b74e27d6e4ed01a9` patch whose `08e7756`
abbreviation is named by the official CVE-2026-14456 advisory. That OpenSSL
commit and patch are not signed; the official advisory and the independently
pinned patch checksum are the trust inputs. The final runtime uses signed,
index-and-ARM64-child-pinned Distroless
`base-nossl`, adds only the patched Node executable and exact C++ runtime files,
and must pass an explicit-empty-ignore, zero-HIGH/zero-CRITICAL Trivy gate plus
ELF and patch-symbol checks.

Each application Dockerfile has a required, no-default `NODE_RUNTIME_IMAGE`
build argument. The workflow injects only the passing, digest-qualified
`ghcr.io/<owner>/<repository>-node-runtime@sha256:<digest>` output. The app image
records that exact reference and inherits the Node source, signature, OpenSSL
patch, builder, C++ source, base, and ARM64 child labels enforced by OCI
admission. App stages add only the deployment tree plus UID/GID-1000 identity
files and contain no npm or shell. Their empty entrypoint preserves OCI command
overrides; `/nodejs/bin` is explicit in `PATH`. Caddy and PostgreSQL publish in
an independent service matrix with Meilisearch and do not wait for the Node
producer. That matrix does wait for the read-only signed Meilisearch upstream
input gate, runs on a native `ubuntu-24.04-arm` runner, and fails closed if the
runner is not ARM64. The native boundary is required for Meilisearch's
heed/LMDB lock initialization and does not weaken any runtime or release gate.

See `docs/quality/container-supply-chain.md` for the complete provenance pins,
inventory gates, rejected prior composition, and scan boundary.

The Caddy image is a UID/GID-1000 scratch runtime. Deployment drops all
capabilities, adds only `NET_BIND_SERVICE`, mounts the reviewed Caddyfile, and
presents writable `/data` and `/config` directories owned by 1000. The
PostgreSQL image is fixed to UID/GID 70, has no gosu binary, and upgrades its
ARM64 Alpine `libuuid` runtime package to exact 2.42.3-r1 before the strict
zero-HIGH/zero-CRITICAL scan. Deployment must
pre-own PGDATA and the `/run/postgresql` and `/tmp` tmpfs mounts as 70. See
`docs/quality/container-supply-chain.md` for the exact source, dependency, and
scan evidence. The Meilisearch derivative is fixed to UID/GID 1000 and upgrades
the upstream ARM64 image's `libcrypto3` and `libssl3` packages to exactly
3.5.8-r0 before its strict final scan; only its repository-owned GHCR digest is
deployable.
