# Local development dependencies

## Start

From the repository root:

```sh
install -m 600 .env.example .env
pnpm infra:config
pnpm infra:up
pnpm db:migrate
```

The startup wrapper accepts no arguments and first requires `.env` to be an
owned, regular, single-link mode-`0600` file. It rejects every ambient Docker or
Compose override, requires Docker Desktop's Linux server through
`/var/run/docker.sock`, and binds the exact `nutrition-tracker-local` project.
Before mutation, it captures without printing the rendered five-service model
and validates its named volumes, read-only MinIO policy mount, health checks, and
loopback port mappings. It then waits for the four persistent services, runs the
MinIO bootstrap as a separate removable one-shot, and checks the effective host
ports afterward. It never deletes named volumes or prints the rendered
environment.

The checked-in values are laptop-only credentials. Bindings are limited to
`127.0.0.1`; do not expose them on a LAN or public interface.

Start the guarded development graph only after the services and migrations are
ready:

```sh
pnpm dev
```

For an API-only readiness session, use `pnpm dev:api`. Both commands open the
owner-only `.env` without following symlinks, use the Meilisearch master only in
the local bootstrap orchestrator, and pass the generated scoped search/admin
keys to Turbo. The application graph does not receive the Meilisearch master or
MinIO root credentials. A direct workspace-package launcher is not equivalent;
it must be given the scoped-key overlay explicitly.

## Verify

```sh
pnpm infra:status
curl --fail http://127.0.0.1:7700/health
curl --fail http://127.0.0.1:9000/minio/health/ready
curl --fail http://127.0.0.1:8025/livez
```

The guarded status command repeats the effective model, project, engine,
health, and loopback-port checks without changing container state or printing
interpolated values.

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
pnpm infra:down
pnpm infra:localstack:down
```

The Compose shutdown wrapper repeats the environment-file, Docker Desktop, and
fixed-project boundary and accepts no arguments. These commands preserve named
volumes. The LocalStack command removes its token-bearing container but retains
its synthetic state and generated role files. Do not add `--volumes` unless the
exact local data has been inspected and disposable loss is intended.

## Common failures

- Port conflict: change the host-side port in `.env`; keep container ports unchanged.
- Migration timeout: confirm `DATABASE_STATEMENT_TIMEOUT_MS=120000` locally, then
  inspect the blocking query rather than disabling timeouts globally.
- Search failure: the API should degrade to PostgreSQL exact/trigram search. Never
  repair search by writing derived data back into PostgreSQL food truth.
- Object-storage failure: retain the manifest and checksum; do not promote a source
  release whose raw artifact is unavailable.
