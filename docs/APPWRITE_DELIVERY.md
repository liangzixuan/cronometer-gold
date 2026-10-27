# Appwrite deployment from GitHub

Nourishing uses Appwrite Sites for the SSR website and Azure for its backend.
The profile is `appwrite-cloud-azure-v1`. API authentication, ownership checks,
bounded traffic, private administration and actual recovery checks remain.

The user permanently removed mandatory human reviews and signatures on October
23, 2026. One authorized operator can prepare, measure and activate a candidate.
No reviewer enrollment, separate person, human signature or environment approval
is required. Existing resource, spending, credential and deployment permissions
still apply. A source push does not deploy the product.

## Prepare, measure and activate

1. Collect backend measurements and capture observations for the exact current
   source, BrowserStack session, run and attempt. Preserve raw reports and their
   actual times. Synthetic fixtures do not establish a real service result.
2. Encode the phase files below as a ZIP and supply `evidence_zip_base64`, at
   most 60,000 ASCII characters. Only inert JSON is allowed. The reader rejects
   duplicate keys, archive traversal, links and excess expansion. Keep credentials
   in the scoped secrets, outside this input.
3. Run `prepare` within the specific deployment approval. It validates actual
   backend reports and live `/ready`, checks Site configuration, uploads an
   inactive candidate, downloads its source/output and checks both identities.
4. Measure the actual candidate build, SSR runtime and private preview. Record the
   results with `deployedBy` and `recordedAt`. Keep raw archive digests and complete
   report bodies. A person does not sign these records.
5. Run `activate` with the measured qualification and candidate receipt. It checks
   current Site/deployment/source/output, backend readiness and GitHub state.
   Production also checks the actual staging deployment and distinct staging and
   production database/search/storage identities. These are service boundaries.
6. Activation is attempted once. An uncertain result permits one bounded provider
   read to reconcile it. Keep an unknown outcome explicit.
7. Before native release, record a fresh observation of the active production Site
   and deployment. Bind it to the actual clean Git HEAD or EAS commit. Keep actual
   platform signing identities, binary hashes and physical-device measurements.

Rebuild and measure each target. Source drift or a newer current CI attempt
invalidates the previous comparison. Records expire after 24 hours; backend and
runtime observations expire after one hour.

## Evidence artifact contents

| Phase | Required files |
| --- | --- |
| Staging prepare | `qualification.json` |
| Staging activate | `qualification.json`, `candidate-receipt.json` |
| Production prepare | `qualification.json`, `staging-config.json`, `staging-receipt.json` |
| Production activate | All four files |

Qualification uses `nutrition-tracker-managed-qualification-bundle-v2`, backend
admission uses `nutrition-tracker-backend-admission-v3`, and final deployment uses
`nutrition-tracker-release-deployment-v9`. Exact shapes and measured fields are
defined in `scripts/deployment/managed-evidence.mjs`. JSON must be canonical.

Clean recovery uses a separate, fenced database and a fresh target replay epoch.
The restore report records `sourceDatabaseSha256` and `sourceRestoreEpochSha256`
for the live source. They must match the admitted database identity and its live
readiness epoch. The existing `restoredDatabaseSha256` and `restoreEpochSha256`
identify the separate restored target and must differ from the source values.
Use the actual authenticated backup, restore and readiness observations. Never
copy the target epoch into live-source readiness or promote the test database to
make these fields match. All other recovery and replay checks still apply.
The artifact is at most 1 MiB and each file at most 512 KiB.

The publisher records the scan database's validated `UpdatedAt` timestamp in its
existing job log. This step emits only that timestamp. It does not publish raw
scanner metadata, vulnerability reports or package inventories. Keep the scan's
actual source, job and attempt binding; do not substitute the build time.

`/ready` checks current database readiness. Actual host, search, worker, storage,
runtime, restore and access measurements remain separate. Keep credentials and
private signed URLs out of reports and retained receipts.

The package includes a root `server.js` that runs the existing
`start-site.cjs` launcher. Appwrite's Next.js adapter uses that root entrypoint
to detect SSR and start a standalone app when no custom command is supplied.
Both paths validate the same output manifest before loading the nested server.
The bootstrap is also listed and hashed in that manifest. Keep the Site on SSR;
changing it to static cannot serve the API routes or private diary.

## Configuration

The fixed endpoint is `https://nyc.cloud.appwrite.io/v1`, project
`6abac02e002f10c31ac2`. Each GitHub environment (`appwrite-staging` and
`appwrite-production`) needs its own configured Site and exact target values.

| Environment value | Meaning |
| --- | --- |
| Secret `APPWRITE_DEPLOY_KEY` | Existing target API key with configured Sites scopes; production also needs read access to staging |
| Secret `APPWRITE_BACKEND_READINESS_TOKEN` | Target-specific 64-hex readiness credential, unless the runner has an actually admitted operator /32 |
| Secret `APPWRITE_STAGING_READINESS_TOKEN` | Separate staging readiness credential for production's staging comparison; no fallback to the production credential |
| `APPWRITE_SITE_ID` / `APPWRITE_OTHER_SITE_ID` | Distinct reviewed target/other Site IDs |
| `WEB_PUBLIC_ORIGIN` / `API_INTERNAL_URL` | Exact target HTTPS origins |
| `APPWRITE_BUILD_SPECIFICATION` / `APPWRITE_RUNTIME_SPECIFICATION` | Reviewed provider specifications within verified available allowance |

No token grants general backend access: the readiness credential permits only
`GET /ready` and is removed before forwarding. Native application calls use user
authentication. The BFF remains responsible for its existing same-origin session
and request protections.

The Azure API instance is deliberately a singleton while using bounded
process-wide anonymous admission. Scaling requires a reviewed shared limiter;
do not increase replicas without that design and acceptance. Public exposure
still requires actual route/authentication, cross-account, forwarding-spoof,
quota, egress and restore validation on the deployed target.

On September 29 both deployment key *names* existed, but the Appwrite project had
no Sites and the environments lacked required variables/protection. No key value
was read. These are dated setup observations; read current provider state before
execution. Existing credits and verified free allowances are the spending limit.
Do not remove Azure spending protection, upgrade plans or infer allowance from
published prices or a historical credit amount.

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

## Local implementation checks

`node --test scripts/appwrite.test.mjs` runs the real archive/controller/GitHub/
qualification/packaging tests and TypeScript checks. It also runs the bounded
artifact-reader process/archive regressions. Tests use ephemeral fixture keys,
mocked provider responses and no live release. They cannot establish actual
managed runtime, capture, backend, native or release acceptance.

Normal `pnpm check`, build, advisory/license and release gates remain required.
The September 29 Expo compatibility/release-age admission block is not bypassed
by focused checks. Do not install an unadmitted lock or call an old delivery
helper to publish this candidate.

Use GitHub, Appwrite and Azure CLI/API for supported administration. An actual
visual/capture requirement can still require the approved Brave session. Neither
CLI availability nor this implementation authorizes resource creation, workflow
dispatch, cloud spending or release.

Official references: [Next.js on Appwrite Sites](https://appwrite.io/docs/products/sites/quick-start/nextjs),
[Sites deployment lifecycle](https://appwrite.io/docs/products/sites/deployments),
[Node SDK Sites API](https://appwrite.io/docs/references/cloud/server-nodejs/sites),
[GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts).

### Provider output formats

The deployment download API returns source as gzip tar and output as binary data.
Appwrite can package SSR output as an EROFS filesystem image. The release reader
uses Ubuntu 24.04 `erofs-utils` 1.7.1-1build2 and `bubblewrap` 0.9.0-1ubuntu0.3.
CI installs these tools in the quality and Site release jobs. Local Linux release
tests need the same packages and working unprivileged user namespaces.

The EROFS decoder runs without sudo, network access, credentials or writable host
paths. It writes only to a size-limited private temporary filesystem and does not
run any downloaded code. The existing path, mode, byte, file-count, symlink,
manifest, source, build observation and provider identity checks then apply to
all decoded entries. The output identity retains the digest of the original
provider image. Only an empty regular `.extracted` marker with mode 0644 is
accepted in addition to the existing bounded `.open-runtimes` metadata.

An inactive candidate that builds successfully still needs complete output,
process runtime and preview acceptance before activation.
