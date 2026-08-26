# Local development dependencies

## Start

From the repository root:

```sh
cp .env.example .env
docker compose --env-file .env -f infra/docker/compose.yml config --quiet
docker compose --env-file .env -f infra/docker/compose.yml up -d --wait
pnpm --filter @nutrition-tracker/db db:migrate
```

The checked-in values are laptop-only credentials. Bindings are limited to
`127.0.0.1`; do not expose them on a LAN or public interface.

## Verify

```sh
docker compose --env-file .env -f infra/docker/compose.yml ps
docker compose --env-file .env -f infra/docker/compose.yml exec postgres \
  pg_isready -U nutrition_local -d nutrition_tracker
curl --fail http://127.0.0.1:7700/health
curl --fail http://127.0.0.1:9000/minio/health/live
curl --fail http://127.0.0.1:8025/livez
```

The one-shot `minio-bootstrap` service creates two private retention buckets,
enables versioning only on the append-only erasure ledger, and installs separate
export-writer, export-reader, ledger-writer, and restore-reader policies. It has
no application runtime role after a successful exit. The export bucket remains
unversioned because its random keys are write-once and expiry must remove the
sole ciphertext rather than leave a recoverable noncurrent version. The
erasure-ledger writer cannot list or delete ledger entries, and restore-read
credentials are not passed to either the API or worker.

Create the legacy bucket named by `S3_BUCKET` in the MinIO console only when a
food-import rehearsal needs it. Mailpit captures local email at
<http://127.0.0.1:8025>.

## Opt-in persistent LocalStack retention profile

MinIO remains the default dependency and mandatory authenticated-secret test
lane. To make the host API and worker use persistent LocalStack S3/IAM state for
an attended synthetic-data session, start the guarded profile after the normal
dependencies:

```sh
pnpm infra:localstack:up
pnpm infra:localstack:status
pnpm dev:localstack
```

`infra:localstack:up` prompts non-echoingly for a Developer Auth Token when it is
not already exported. It never accepts the token as an argument or writes it.
The generated mode-`0600` profile and runtime overrides below
`.local-data/localstack` retain the selected loopback port and point only the
API/worker retention adapters at LocalStack; PostgreSQL, Meilisearch, MinIO, and
Mailpit remain unchanged. Later commands reuse the retained port and reject a
conflicting explicit value. `infra:localstack:status` verifies state without
provisioning or rewriting it. See
[`infra/localstack/README.md`](../localstack/README.md) for bootstrap, drift, and
physical-phone boundaries.

Run the live persistent-state compatibility check while the service is running:

```sh
pnpm test:localstack:dev
```

## Stop

```sh
docker compose --env-file .env -f infra/docker/compose.yml down
pnpm infra:localstack:down
```

These commands preserve named volumes. The LocalStack command removes its
token-bearing container but retains its synthetic state and generated role
files. Do not add `--volumes` unless the exact local data has been inspected and
disposable loss is intended.

## Common failures

- Port conflict: change the host-side port in `.env`; keep container ports unchanged.
- Migration timeout: confirm `DATABASE_STATEMENT_TIMEOUT_MS=120000` locally, then
  inspect the blocking query rather than disabling timeouts globally.
- Search failure: the API should degrade to PostgreSQL exact/trigram search. Never
  repair search by writing derived data back into PostgreSQL food truth.
- Object-storage failure: retain the manifest and checksum; do not promote a source
  release whose raw artifact is unavailable.
