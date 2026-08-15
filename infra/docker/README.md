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

Create the local object bucket through the MinIO console or an S3 client after
first startup. Use the `S3_BUCKET` value from `.env`.

All published ports bind to loopback. The checked-in credentials are deliberately
weak and must never appear in a shared, staging, or production deployment. Pin
container images by digest in CI/production after registry and licence review.

Stop without deleting state:

```sh
docker compose --env-file .env -f infra/docker/compose.yml down
```

Deleting named volumes is destructive and intentionally omitted from normal
instructions. Follow the restore runbook before replacing database state.
