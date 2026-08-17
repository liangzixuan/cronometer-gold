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

The four application Dockerfiles, `caddy.Dockerfile`, and `postgres.Dockerfile`
are OCI controlled-beta supply-chain inputs, not replacements for the developer
services above. The default-branch container workflow publishes each one to its
own GHCR package only after an exact ARM64 scan, provenance, runtime identity,
and behavior checks pass.

Application builds use the pinned full Node image only as a builder. Final app
stages use the signed, digest-pinned Distroless Node.js 22 Debian 13 runtime, add
only the deployment tree plus the UID/GID-1000 identity files, and contain no npm
or shell. Their empty entrypoint preserves the OCI command overrides; `/nodejs/bin`
is explicit in `PATH`. See `docs/quality/container-supply-chain.md` for the exact
index/ARM64 digests, signature identity, inventory gate, and scan boundary.

The Caddy image is a UID/GID-1000 scratch runtime. Deployment drops all
capabilities, adds only `NET_BIND_SERVICE`, mounts the reviewed Caddyfile, and
presents writable `/data` and `/config` directories owned by 1000. The
PostgreSQL image is fixed to UID/GID 70 and has no gosu binary. Deployment must
pre-own PGDATA and the `/run/postgresql` and `/tmp` tmpfs mounts as 70. See
`docs/quality/container-supply-chain.md` for the exact source, dependency, and
scan evidence.
