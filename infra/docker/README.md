# Local infrastructure

This Compose project runs only local dependencies. PostgreSQL is authoritative;
Meilisearch is a disposable projection, MinIO holds raw import/test artifacts, and
Mailpit captures email without delivering it.

```sh
cp .env.example .env
docker compose --env-file .env -f infra/docker/compose.yml up -d --wait
pnpm --filter @nutrition-tracker/db db:migrate
docker compose --env-file .env -f infra/docker/compose.yml ps
```

Local endpoints:

| Service | Endpoint |
| --- | --- |
| PostgreSQL | `127.0.0.1:5432` |
| Meilisearch | <http://127.0.0.1:7700/health> |
| MinIO API / console | <http://127.0.0.1:9000> / <http://127.0.0.1:9001> |
| Mailpit UI / SMTP | <http://127.0.0.1:8025> / `127.0.0.1:1025` |

The one-shot `minio-bootstrap` service creates the private export and erasure
ledger buckets and four separate least-privilege users. The export bucket is
unversioned so expiry removes the only ciphertext; the append-only erasure
ledger is versioned. Application principals cannot list either bucket and the
API has read-only export access. The offline restore principal can list versions
only under the ledger prefix and read an exact version so ambiguity fails closed;
those credentials are never passed to the API or worker. Create the legacy
`S3_BUCKET` manually only when a food-import rehearsal needs it.

All published ports bind to loopback. The checked-in credentials are deliberately
weak and must never appear in a shared or OCI controlled-beta deployment. CI and
the controlled-beta environment use digest-pinned images after registry and
licence review; local-only image tags remain a developer convenience where
explicitly documented.

Stop without deleting state:

```sh
docker compose --env-file .env -f infra/docker/compose.yml down
```

Deleting named volumes is destructive and intentionally omitted from normal
instructions. Follow the restore runbook before replacing database state.

## Published OCI runtimes

The default-branch supply chain produces seven repository-owned ARM64 artifacts:
the dedicated `node-runtime.Dockerfile`, the four application Dockerfiles,
`caddy.Dockerfile`, and `postgres.Dockerfile`. These are OCI controlled-beta
inputs, not replacements for the developer services above. The Node runtime is
an intermediate build artifact; only the other six become deployment images.
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
independent jobs and do not wait for the Node producer.

See `docs/quality/container-supply-chain.md` for the complete provenance pins,
inventory gates, rejected prior composition, and scan boundary.

The Caddy image is a UID/GID-1000 scratch runtime. Deployment drops all
capabilities, adds only `NET_BIND_SERVICE`, mounts the reviewed Caddyfile, and
presents writable `/data` and `/config` directories owned by 1000. The
PostgreSQL image is fixed to UID/GID 70 and has no gosu binary. Deployment must
pre-own PGDATA and the `/run/postgresql` and `/tmp` tmpfs mounts as 70. See
`docs/quality/container-supply-chain.md` for the exact source, dependency, and
scan evidence.
