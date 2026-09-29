# Appwrite deployment from GitHub

The `appwrite-site-release` workflow prepares an exact source revision for
Appwrite Sites and separates staging from production. It uses the
`appwrite-staging` and `appwrite-production` GitHub environments. Each environment
holds its own `APPWRITE_DEPLOY_KEY`; keys stay out of the checkout, source archive,
application bundle and retained receipts.

This integration does not yet admit a hosted release. The deployment CLI rejects
managed Appwrite runtime qualification before creating a transport or changing
cloud state. The repository's qualified container evidence does not establish the
identity or security of Appwrite's managed Node runtime. An applicable verifier,
a qualified reachable backend and target configuration are still required.
Supplying a JSON field that says a runtime is accepted cannot satisfy this gate.

## Release flow

1. A maintainer selects the exact revision on `codex/retention-features` using
   the manual workflow. A push does not deploy.
2. Admission checks the actual latest GitHub attempts at that revision. All
   required CI, container and BrowserStack jobs and required steps must have
   passed. Browser evidence must bind its source, session, terminal result and
   owned cleanup. A green workflow headline alone is insufficient.
3. The source packer reads committed Git blobs and modes, includes the exact
   lockfile, and writes a deterministic source archive with a generated source
   manifest. Untracked files and machine-local data are excluded.
4. The deployment controller checks distinct Site identities, configuration,
   origins, qualifications and the current active deployment. Its upload is
   inactive. Readiness, source/output identity and runtime/backend acceptance
   precede activation.
5. Production also requires successful staging for the same source archive and
   an actual approval under the configured production environment policy.
   Appwrite builds each target separately, so matching source archives do not
   mean the built outputs are identical.
6. The controller verifies the active identity again before activation and
   confirms the result afterward. It retains the previous identity for a
   separately authorized rollback. It does not retry an uncertain mutation.

The offline tests exercise these transitions with controlled responses. They do
not establish a real provider deployment, managed runtime qualification, native
installation or production acceptance.

## Configuration to complete

The project endpoint is `https://nyc.cloud.appwrite.io/v1`, project
`6abac02e002f10c31ac2`. Use distinct staging and production Sites. The release
controller does not create Sites, select a paid plan, configure DNS or deploy the
API/database/search/worker stack.

| Environment value | Meaning |
| --- | --- |
| Secret `APPWRITE_DEPLOY_KEY` | Project API key with the reviewed Sites read/write scopes |
| `APPWRITE_SITE_ID` | This environment's reviewed Site |
| `APPWRITE_OTHER_SITE_ID` | The other environment's Site, used to reject target swaps |
| `WEB_PUBLIC_ORIGIN` | Exact HTTPS web origin for this target |
| `API_INTERNAL_URL` | Qualified, reachable HTTPS backend origin |
| `APPWRITE_BUILD_SPECIFICATION` | Reviewed build resource specification |
| `APPWRITE_RUNTIME_SPECIFICATION` | Reviewed runtime resource specification |

Production requires configured reviewers and an exact allowed deployment branch,
plus a corresponding real approval for the release. The environment name itself
does not grant approval. Preserve the separate privacy, restore, provenance,
vulnerability, identity and release requirements in
[release gates](quality/release-gates.md).

On September 29, 2026, both GitHub environments and their secret names were
verified. Neither environment had variables, branch restrictions or required
reviewers, and the Appwrite project had no Sites. These dated observations are
setup evidence, not current-state assertions for a later run. Re-read the actual
configuration before execution. The deployment keys' values were not inspected.

## Next.js packaging

Nourishing requires server-side rendering and its authenticated BFF. Appwrite's
Next.js SSR runtime builds the committed source with the pinned package manager
and frozen lockfile. The application dependency closure must be built in order.
The packer consumes the resulting standalone tree:

```sh
node scripts/appwrite/pack-site.mjs --source-root . --output appwrite-output
```

The output contains `payload/` with the complete standalone dependencies,
`payload/apps/web/server.js`, static assets and tracked public assets.
`start-site.cjs` and `output-manifest.json` are at the output root.
Configure the output directory as `appwrite-output` and start command as
`node start-site.cjs`. The launcher validates the provider's port, sets
`HOSTNAME=0.0.0.0`, and retains the provider's `NODE_OPTIONS`.

The output manifest records the source revision, source manifest hash, actual
Next build ID and hashes of packaged files and internal links. The packer rejects
private files, escapes, collisions, missing assets and unexpected source changes.
These checks establish package structure and identity. They do not qualify the
provider's Node/OpenSSL/native binaries or prove application behavior on the host.

Do not upload a standalone bundle built for a different OS/libc as a substitute
for the provider build. Do not use a static export or replace PostgreSQL with
TablesDB to make this workflow run.

## Local validation and administration

The normal `pnpm check` discovers `scripts/appwrite.test.mjs`, which runs the
actual archive, GitHub admission, deployment-controller and packaging cases,
rejects skipped nested suites and typechecks the TypeScript tools.

For focused development:

```sh
node --test scripts/appwrite.test.mjs
```

Use the locally authenticated Appwrite CLI for reviewed administration and
read-only inventory. CI uses the pinned official Node SDK for exact archive and
deployment control. Neither path requires copying a deployment key into a local
file. Do not dispatch a release while its admission prerequisites are missing.

Official references: [Next.js on Appwrite Sites](https://appwrite.io/docs/products/sites/quick-start/nextjs),
[Sites deployment lifecycle](https://appwrite.io/docs/products/sites/deployments),
[Node SDK Sites API](https://appwrite.io/docs/references/cloud/server-nodejs/sites).
