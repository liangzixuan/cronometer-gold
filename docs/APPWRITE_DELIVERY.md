# Appwrite deployment from GitHub

Nourishing uses Appwrite Cloud for the SSR web app and a separately qualified
Azure backend. The approved profile is `appwrite-cloud-azure-v1`. Public HTTPS
application routes retain API authentication, ownership checks and bounded
anonymous auth/search traffic. Administration and database/search/storage
services remain restricted.

This implements candidate preparation and activation. It does not provision the
backend, Sites, DNS, credentials or reviewer trust. The real trust store remains
empty until named independent reviewers and their public keys are reviewed.
Backend egress, credential rotation, credit/allowance admission and encrypted
off-host backup/restore still require implementation and actual evidence; their
preflight blocks remain. Do not replace those observations with synthetic test
fixtures or fields that merely claim success.

## Managed-runtime decision

[ADR 0107](adr/0107-appwrite-managed-deployment.md) records the web-only provider
trust decision approved on September 29, 2026. Appwrite's hidden host/image
components are not independently scanned or digest-qualified. The release still
binds exact source and downloaded output, the actual build and SSR Node/OpenSSL,
libc/native inventory, independent review and private preview behavior. A generic
`node-22` selection is insufficient. Runtime changes after observation remain a
provider-managed risk; reports expire and must be measured again.

All six backend images retain their digest, source, runtime, native inventory,
scan, signature and provenance requirements. There is no fabricated `web` image
in that backend set. The OCI profile retains its separate seven-image contract.

## Prepare, review, activate

The manual `appwrite-site-release` workflow uses the exact committed default
branch revision. Pushes do not deploy. `operation` is `prepare` or `activate`;
`target` is `staging` or `production`. Production additionally requires explicit
promotion and actual configured environment approval/branch protection.

1. Obtain independently signed backend admission and a completed capture review
   for the exact current BrowserStack source/session/run/attempt. Keep the raw
   browser runner summary unchanged: its `pending-first-run-review` marker alone
   never authorizes deployment.
2. Provide a same-revision review artifact, identified by `review_artifact_id`.
   An authorized reviewer-controlled GitHub workflow must have uploaded it using
   `actions/upload-artifact`; creating that artifact is an external review step.
   This release workflow does not create reviewer signatures or publish its own
   acceptance input. The archive is limited to 1 MiB, each file to 512 KiB, and
   exact inert JSON filenames below. Digest, source repository/revision, expired
   state, duplicate names/keys, traversal, symlinks and expansion are checked.
3. Run `prepare`. The controller reads current GitHub prerequisites, validates
   the signed backend report and probes live `/ready` before any upload. It
   verifies Site configuration, uploads an inactive candidate, waits within its
   fixed budget, downloads actual source/output and checks both identities.
   The retained receipt has `operation=prepare` and `status=candidate-prepared`.
   It cannot authorize activation or a mobile release.
4. Review the actual candidate's build, SSR and private preview measurements and
   sign final v8 evidence. Preserve both raw source/output archive digests and
   the complete report bodies whose canonical hashes were signed.
5. Run `activate` with that final review and the candidate receipt. The controller
   rereads Site, candidate, source/output, live backend and current GitHub state.
   Production independently reads the current staging Site/deployment/source/
   output, verifies its signed evidence and distinct database/search/storage
   identities. A historical staging receipt alone cannot pass.
6. Activation is attempted once. An uncertain provider result permits one
   bounded read to reconcile the active identity. It does not trigger another
   mutation, automatic rollback, or a claim that the old deployment stayed active.
   The receipt distinguishes confirmed activation from an unknown outcome.
7. Before native release, a reviewer separately signs a fresh observation of the
   actually active production Site and deployment. Mobile validation consumes
   the same v8 qualification plus that activation attestation and binds it to the
   actual clean Git HEAD or EAS commit. Candidate evidence cannot satisfy it.

The source is rebuilt for each environment. Production output must be reviewed
for production; it is not assumed byte-identical to staging. Source drift or a
new current CI attempt invalidates the previous comparison.

### Review artifact contents

| Phase | Required files |
| --- | --- |
| Staging prepare | `qualification.json` |
| Staging activate | `qualification.json`, `candidate-receipt.json` |
| Production prepare | `qualification.json`, `staging-config.json`, `staging-receipt.json` |
| Production activate | All four files |

`qualification.json` uses `nutrition-tracker-managed-qualification-bundle-v1`:
backend admission and five actual report bodies, signed capture review, optional
final deployment and three runtime reports, plus a non-recursive staging bundle
for production. Backend admission is `nutrition-tracker-backend-admission-v1`;
final web/backend evidence is `nutrition-tracker-release-deployment-v8`.
Exact shapes and required measurements are defined in
`scripts/deployment/managed-evidence.mjs`. Report JSON must be canonical. Reviewed
records expire after 24 hours and runtime/backend observations after one hour.
Signatures use active checked-in Ed25519 reviewer keys, distinct from the
operator. CLI flags cannot supply a replacement trust store.

`/ready` is a bounded live database-readiness probe. It does not identify a VM,
prove search/worker/storage health or replace signed host/runtime observations.
Those are separate report bodies. Credentials and signed private URLs do not
belong in evidence or retained receipts.

## Configuration

The fixed endpoint is `https://nyc.cloud.appwrite.io/v1`, project
`6abac02e002f10c31ac2`. Each GitHub environment (`appwrite-staging` and
`appwrite-production`) needs its own reviewed Site and exact target values.

| Environment value | Meaning |
| --- | --- |
| Secret `APPWRITE_DEPLOY_KEY` | Existing target API key with reviewed Sites scopes; production also needs read access to staging |
| Secret `APPWRITE_BACKEND_READINESS_TOKEN` | Target-specific 64-hex readiness credential, unless the runner has an actually admitted reviewer /32 |
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
