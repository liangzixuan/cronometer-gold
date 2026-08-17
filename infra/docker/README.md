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
weak and must never appear in a shared, staging, or production deployment. CI and
production use digest-pinned images after registry and licence review; local-only
image tags remain a developer convenience where explicitly documented.

Stop without deleting state:

```sh
docker compose --env-file .env -f infra/docker/compose.yml down
```

Deleting named volumes is destructive and intentionally omitted from normal
instructions. Follow the restore runbook before replacing database state.
