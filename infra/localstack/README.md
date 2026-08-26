# LocalStack S3/IAM compatibility fixture

This is an opt-in, synthetic-data-only development fixture. It exercises the
repository's encrypted S3 artifact boundary against LocalStack's AWS-style S3,
IAM, and STS APIs. It is **not a hosting platform** and does not provide a
public beta, public DNS delegation, publicly trusted TLS, backups, production
durability, or evidence about a real AWS/OCI/Azure account.

The fixture is deliberately narrow:

- one container from a digest-pinned multi-architecture image, running natively
  on ARM64 or AMD64;
- S3, IAM, and STS only;
- `127.0.0.1` exposure only, with no Docker socket or persistent volume;
- two ephemeral buckets matching the export/erasure-ledger versioning topology;
- four ephemeral IAM users using the existing checked-in least-privilege S3
  policies; and
- automatic removal of only the uniquely named, labeled container it created.

The existing MinIO CI lane remains mandatory. LocalStack currently ignores
secret-access-key values, so this fixture can test access-key identity, IAM
policy decisions, request shape, conditional writes, version inventory, and
exact-version reads, but not rejection of an incorrect SigV4 secret. MinIO
continues to cover authenticated-secret behavior and the real-provider canaries
remain deployment gates.

The pinned LocalStack release also fails the actual S3 authorization path for
`s3:ListBucketVersions` when the shared restore policy carries its production
`s3:prefix` condition, even though LocalStack's IAM simulator reports that same
request as allowed. Only this synthetic emulator therefore uses
`infra/localstack/erasure-restore-policy.json`: its exact structural delta is
removal of that condition from the bucket-scoped list statement. Object and
exact-version reads remain restricted to `erasure-ledger/v1/*`, bucket listing
and cross-bucket access remain denied, and the production/MinIO policy is
unchanged. The tradeoff is that the LocalStack restore principal can enumerate
version metadata for every synthetic object in its dedicated ledger bucket;
never treat this as production IAM evidence.

The one-shot fixture and the attended persistent development profile are
separate by design. `pnpm test:localstack` always creates fresh ephemeral state
and removes it. The profile described below retains synthetic S3/IAM state so
the API and worker can use it during ordinary development; it does not weaken or
replace the isolated fixture.

## Run locally

Activate the GitHub Education LocalStack Student benefit and obtain a Developer
Auth Token from the [LocalStack Auth Tokens page](https://app.localstack.cloud/workspace/auth-tokens).
Inject it from a secret manager or a non-echoing shell prompt; never put it in
`.env`, a command-line argument, source control, or a test log.

For zsh/bash, a non-echoing one-session flow is:

```sh
read -r -s LOCALSTACK_AUTH_TOKEN
export LOCALSTACK_AUTH_TOKEN
pnpm test:localstack
unset LOCALSTACK_AUTH_TOKEN
```

`LOCALSTACK_GATEWAY_PORT` may select another local port when 4566 is occupied.
The runner accepts only a decimal port and always constructs the endpoint from
literal `127.0.0.1`. It discovers only the selected local Unix-socket Docker
engine and refuses remote/TCP contexts. Every child process receives an
environment with ambient `AWS_*`, `LOCALSTACK_*`, and proxy variables removed.
The application test also uses fresh empty AWS config/credentials files and
disables EC2 metadata credential discovery.

The runner creates a mode-0700 temporary Docker configuration containing no
credential helper. This avoids calls to `docker-credential-osxkeychain` and its
repeated macOS Keychain prompts. The project Docker configuration is untouched.
While the fixture runs, trusted users of the same Docker engine can inspect its
ephemeral container metadata, including the token environment variable. The
runner stops the full application-test process group on timeout, reconciles an
ambiguous container launch for a bounded 20-second window, and treats inability
to verify container removal as a test failure. TERM and HUP become catchable
cancellation so the exact labeled container is reconciled with cleanup signals
masked before the process exits.

## Persistent API and worker development

Signing in to the LocalStack website links the account entitlement but does not
authenticate the container. Create a Developer Auth Token on the Auth Tokens
page. Do not paste it into chat, `.env`, a command argument, source control, or a
log.

Start the ordinary PostgreSQL, Meilisearch, MinIO, and Mailpit dependencies
first. Then start the separate persistent LocalStack project:

```sh
pnpm infra:up
pnpm db:migrate
pnpm infra:localstack:up
```

When `LOCALSTACK_AUTH_TOKEN` is absent, `infra:localstack:up` prompts for it with
terminal echo disabled. A noninteractive invocation fails closed instead of
reading from stdin or accepting a token argument. If a secret manager already
exports the token, the wrapper accepts that variable for `up`; unset it in the
parent shell immediately afterward. In either flow, the wrapper never writes
the token. Trusted users of the same Docker engine can still inspect it in the
running container metadata, so stop the profile when the attended session ends.

The wrapper requires `docker` and the `docker-compose` executable on `PATH`. It
links that verified local Compose executable into the same temporary,
credential-helper-free Docker configuration used for the exact digest pull.
It uses only a local Unix-socket Docker engine, validates the loopback port,
starts only S3/IAM/STS, and provisions the same two buckets and four IAM roles
as the one-shot fixture. The canonical checkout path supplies a stable hash
suffix for both the Compose project and retained named volume, so two checkouts
cannot attach to or mutate the same synthetic state. Existing containers must
also carry this checkout's exact Compose working-directory and configuration-
file labels before any mutation. A failed or ambiguous start removes only the
verified exact container ID and proves checkout-scoped absence so a token-
bearing container is not silently left behind. TERM and HUP use the same
catchable, signal-masked cleanup path. Its generated files are:

- `.local-data/localstack/profile.env`: the retained loopback gateway port;
- `.local-data/localstack/runtime.env`: API export-reader and worker export/
  ledger-writer coordinates;
- `.local-data/localstack/restore.env`: the offline restore-reader coordinates.

The directory is mode `0700`; all three files are mode `0600` and already excluded by
`.gitignore`. They contain synthetic LocalStack access material, not the
Developer Auth Token or root credentials. `dev:localstack` loads only
`runtime.env`, after first rejecting any `AWS_*`, `LOCALSTACK_*`, or proxy
control assignment in the root `.env`. It also strips those variables from the
ambient environment before starting the repository development tasks:

```sh
pnpm dev:localstack
```

The application override sets both retention stores to `s3`, keeps export
version deletion on `suspended_null`, and points the host API/worker at literal
`http://127.0.0.1:4566`. `LOCALSTACK_GATEWAY_PORT` may select another validated
loopback port on the first start; `profile.env` retains that choice for later
`status`, `verify`, `run`, and `down` commands. An explicitly supplied different
port fails closed instead of silently targeting or recreating the retained
profile. The hand-written artifact client already uses path-style requests, so
`S3_FORCE_PATH_STYLE` is neither read nor needed.

Check state or rerun the encrypted compatibility suite without restarting:

```sh
pnpm infra:localstack:status
pnpm test:localstack:dev
```

`infra:localstack:status` is read-only: a running profile is reported verified
only after its retained port, files, buckets, version history, users, keys, and
policies match exactly. It reports an absent container separately; an exited
token-bearing container is an error with the exact
`pnpm infra:localstack:down` remediation. Status never provisions or rewrites
state.

Normal shutdown removes the token-bearing container and retains the dedicated
named volume plus generated role files:

```sh
pnpm infra:localstack:down
```

There is intentionally no volume-reset command. Unexpected buckets, users,
access keys, policy or version drift, missing one-time credential material,
symlinks, or unsafe file modes stop the wrapper for inspection. Never repair
that failure by deleting an uninspected volume.

### Physical-phone boundary

LocalStack is never a phone endpoint. Keep `API_HOST=127.0.0.1` and every
dependency port on loopback. A physical phone must use a separately reviewed,
authenticated, publicly trusted HTTPS route whose only upstream is
`127.0.0.1:4000`, then set that development origin in `EXPO_PUBLIC_API_URL` for
the mobile development process. Do not route port 4566, PostgreSQL,
Meilisearch, MinIO, or Mailpit. An Expo/Metro tunnel distributes the JavaScript
bundle; it does not expose the API.

A local HTTPS relay is not a confirmed release deployment. Signed builds must
still use the real, checked-in deployment origin and pass the mobile release
preflight.

## CI status

Static fail-closed contracts run in normal CI. The live LocalStack job is not
enabled yet: LocalStack requires a separate **CI Auth Token**, and a personal
Developer Auth Token must never be copied into GitHub Actions. A future CI job
may store that token as protected secret `LOCALSTACK_CI_AUTH_TOKEN`, but must map
it to runtime variable `LOCALSTACK_AUTH_TOKEN`, must not expose it to fork pull
requests, and must keep the current MinIO and real-provider lanes.

## Upgrade and review

The image is pinned to the multi-architecture index digest for
`localstack/localstack:2026.7.5`. An upgrade requires checking the Docker Hub
manifest-list digest, ARM64 child image, LocalStack license behavior, IAM hard
enforcement, S3 versioning/conditional-write behavior, and all static/live
tests. Do not replace the pin with `latest`, `stable`, or `dev`.

The test also round-trips a one-day lifecycle rule for synthetic export objects;
it does not wait for emulator lifecycle execution. Explicit application deletion
remains the authoritative expiry test.

The compatibility XML parser accepts both AWS's double-quoted uppercase UTF-8
declaration and LocalStack's single-quoted lowercase `utf-8` declaration, while
still requiring XML 1.0, matched quote delimiters, UTF-8, a single root,
non-truncated history, exact keys, and unambiguous live versions.

LocalStack license activation still communicates with LocalStack's service.
Student-plan telemetry defaults on. `DISABLE_EVENTS=1` disables client event
publishing, while LocalStack still records license activation timestamps and
licensing credentials server-side. Never use real nutrition records, health
data, production secrets, or Cloud Pods in this fixture.

Official references:

- [LocalStack plans and Student entitlements](https://docs.localstack.cloud/aws/licensing/)
- [Developer and CI Auth Tokens](https://docs.localstack.cloud/aws/getting-started/auth-token/)
- [LocalStack CI integration](https://docs.localstack.cloud/aws/getting-started/ci-cd/)
- [IAM policy enforcement](https://docs.localstack.cloud/aws/developer-tools/security-testing/iam-policy-enforcement/)
- [LocalStack credentials limitations](https://docs.localstack.cloud/aws/connecting/credentials/)
- [S3 behavior](https://docs.localstack.cloud/aws/services/s3/)
- [ARM64 support](https://docs.localstack.cloud/aws/customization/advanced/arm64-support/)
- [Usage tracking and `DISABLE_EVENTS`](https://docs.localstack.cloud/aws/customization/advanced/usage-tracking/)
