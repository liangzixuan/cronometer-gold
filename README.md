# Nourishing

A provenance-first nutrition and health tracking platform. The implementation
sequence and product invariants are captured in
[`docs/product/build-plan.md`](docs/product/build-plan.md).

## Current goal and reading order

The personal-use target is before **November 1, 2026**: desktop web and native
Android first, with iOS also in scope. Broad U.S. food search and barcode lookup
are required. Source implementations and synthetic demonstrations do not establish
catalogue coverage, hosted availability or signed-device acceptance.

Start with [project instructions](AGENTS.md), the
[build plan](docs/product/build-plan.md), [current readiness](docs/quality/current-readiness.md)
and the [six beta exits](docs/product/beta-exit-checklist.md). Then use the
[development workflow](docs/quality/development-workflow.md) for the selected slice.

## Product boundary

The initial product helps people log food and understand calories, macros, and
micronutrients. It is a consumer wellness product, not a diagnostic device or a
substitute for professional care. The implementation is independent: do not copy
Cronometer source code, content, branding, assets, or proprietary food data.

## Repository map

- `apps/api`: Fastify HTTP adapter for the modular monolith
- `apps/web`: Next.js web client
- `apps/mobile`: Expo/React Native client
- `apps/worker`: background-process shell
- `apps/ingest`: controlled food-source acquisition and catalogue release CLI
- `packages/domain`: pure nutrition, serving, recipe, hydration, and snapshot rules
- `packages/contracts`: transport-neutral API contracts
- `packages/db`: PostgreSQL schema, Kysely types, and migrations
- `packages/search`: search contracts, ranking, cursors, and Meilisearch adapter
- `infra/docker`: local development dependencies
- `infra/development/azure`: isolated, budget-gated development evidence, saved plans and owned-session tooling
- `infra/azure`: separate release infrastructure and its existing acceptance gates
- `infra/localstack`: ephemeral S3/IAM compatibility tests (never hosting)
- `docs/adr`: decisions and non-negotiable boundaries
- `docs/product`: executable product scope and milestone sequence

Canonical source onboarding is documented in the
[`food-source release runbook`](infra/runbooks/food-source-release.md). Checked-in
USDA and Health Canada candidates are intentionally non-importable until their
independent acquisition, rights, storage, and nutrient-mapping approvals exist.
Search projection rebuilds and degraded operation are documented in the
[`food-search runbook`](infra/runbooks/food-search.md).

## Prerequisites

- Node.js satisfying the source requirement `>=22.13.0`
- Corepack with exact pnpm `11.19.0`
- Docker with Compose for local infrastructure

### Toolchain roles

| Role | Version | Boundary |
| --- | --- | --- |
| General source | Node `>=22.13.0` | Minimum accepted by the root package |
| Hosted CI | Node `22` | Current major channel used by both CI jobs |
| Hardened container evidence | Node `22.23.2` | Patched, source-built runtime with separate provenance gates |
| Package manager | pnpm `11.19.0` | Exact version selected by the root package and Corepack |
| Mobile cloud builds | EAS CLI `22.0.0`; Node `22.13.0`; pnpm `11.19.0` | Mobile-only EAS compatibility pins |

These Node values are intentionally distinct and must not be unified: the root
declares a source minimum, CI follows the supported Node 22 major, the hardened
container binds reviewed binary evidence, and EAS uses its mobile compatibility
pin. The EAS CLI is not a baseline development prerequisite; install exact
version `22.0.0` only when approved mobile build work begins.

## Development entry points

- [Local WSL walkthrough](docs/quality/local-walkthrough.md): full local services
  and explicit synthetic fixtures; Docker/Compose and scoped runtime configuration
  must be ready first.
- [Windows Next.js frontend](docs/quality/hosted-web-development.md) and
  [Windows Expo checks/export/Metro](docs/quality/windows-mobile-tooling.md): use
  their qualified toolchain, environment and owned-process boundaries.
- [Azure development runbook](infra/development/azure/README.md): protected native
  authentication, read-only evidence, reviewed saved plans and lifecycle tooling.
  A successful plan does not authorize or prove allocation, hosted readiness or recovery.
- [Appwrite delivery](docs/APPWRITE_DELIVERY.md) and
  [PostgreSQL restore](infra/runbooks/postgres-backup-and-restore.md): separate
  delivery and recovery prerequisites, not a substitute for a running local stack.

The example environment contains synthetic defaults. Review the maintained local
walkthrough and service prerequisites before these commands: PostgreSQL,
Meilisearch, scoped object-store configuration and required container inputs must
all be usable. Copying the example alone does not establish service readiness.

## Getting started

```sh
install -m 600 .env.example .env
corepack enable
corepack install
test "$(pnpm --version)" = "11.19.0"
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm infra:up
pnpm db:migrate
pnpm dev
```

`pnpm dev` verifies the owner-only `.env` and rejects the run before bootstrap
unless the API listener, internal API URL, PostgreSQL, Meilisearch, and active
object-store endpoints and ports are the exact synthetic `127.0.0.1` fixture.
It provisions fixed scoped Meilisearch search and worker keys, then projects an
explicit application-runtime allowlist—not the Meilisearch master, MinIO root,
legacy S3 aliases, restore-only credentials, signing material, private-key
pointers, or unknown ambient variables—into the development graph. Use
`pnpm dev:api` for the narrower API-only Turbo graph; that child receives the
scoped search key but no worker mutation/admin key or worker task-observer
configuration. Direct package launchers must receive the matching scoped-key
overlay and must not load bootstrap credentials into application processes.

The guarded full graph also starts Next.js on `127.0.0.1` and Expo in
`--localhost` mode. It is not a LAN, Tailscale, public, or physical-phone path.
Any future device-accessible launcher requires a separate reviewed design and
explicit approval. The launcher and the nested Expo wrapper forward `SIGINT`,
`SIGTERM`, and `SIGHUP` to isolated child process groups, apply a bounded forced
termination fallback, await child completion, and preserve meaningful exit or
signal behavior so shutdown does not leave development descendants running.

Dependency installation must use the official HTTPS registry with normal TLS
verification. Do not disable certificate checks or substitute an unrelated
mirror to make installation pass.

The root scripts are the release baseline:

```sh
pnpm check
pnpm verify
```

`check` is the fast development gate. `verify` additionally builds every target,
audits production dependencies, and enforces the license policy.

Local credentials are intentionally non-production. Never place production food
exports, health records, OAuth tokens, or secrets in Git.

## Architecture rules

1. `packages/domain` is pure and cannot import network, database, UI, filesystem,
   or environment modules.
2. PostgreSQL is the source of truth. Search indexes and caches are disposable
   projections.
3. Food, recipe, goal, equation, diary, and hydration histories are versioned. A
   logged food or recipe diary entry stores a nutrition snapshot and does not
   change when a source record changes; hydration revisions retain their exact
   milliliters, instant, and effective time zone.
4. Missing nutrient data is not zero. Every published nutrient value retains its
   source, release, basis, and quality status.
5. External providers sit behind adapters. Entitlements, consent, provenance,
   and deletion state stay first-party.

## Repository context artifacts

The [Repomix source context](https://github.com/liangzixuan/cronometer-gold/actions/workflows/repomix.yml) workflow runs on default-branch pushes and ordinary
pull requests. Its `repomix-<full source SHA>` artifact contains:

- `repomix-output.md`: all committed text, including lockfiles, tests, migrations,
  policy and documentation, without code compression or comment removal.
- `repomix-onboarding.md`: a deliberately partial entry-point selection.
- `repomix-manifest.json`: source commit, original Git blob/SHA-256 hashes, modes,
  file coverage, explicit binary omissions and token counts for both packs.

Artifacts expire after seven days and GitHub requires authentication to download
them. Regenerate locally in the Linux checkout with the isolated tool:

```sh
pnpm --dir tools/repomix install --frozen-lockfile --ignore-scripts --strict-peer-dependencies
pnpm --dir tools/repomix audit --audit-level=low
(cd tools/repomix && npm audit signatures --prefix="$PWD" --registry=https://registry.npmjs.org/ --ignore-scripts --no-fund --fetch-retries=0 --fetch-timeout=20000)
pnpm --dir tools/repomix run licenses
pnpm --dir tools/repomix test
pnpm --dir tools/repomix run pack
```

Outputs appear at the repository root and are ignored by Git. Packing reads only
`HEAD` blobs, so local edits and untracked files do not enter the result. Commit
reviewed source before expecting it in the pack. The command has a five-minute
limit; tests have a three-minute limit. A failed command does not accept an older
artifact still on disk. Match both Markdown hashes to the manifest before use.

Unreviewed secret findings, unsafe tracked paths and unexplained text omissions
fail publication. All 27 detectors from the pinned Secretlint recommended preset
scan committed text; inline suppression comments are disabled. The manifest
reports reviewed public fixture/default/placeholder findings and zero unreviewed
findings. Some reviewed defaults work in the local synthetic stack; this baseline
does not permit private credentials. `repomix.security-baseline.json` binds whole
file hashes and complete structured findings. Any change to a reviewed file
intentionally blocks packaging: review its complete contents and findings before
updating only the affected entries. Scanner changes also require review. There is
no automatic baseline refresh or blanket suppression.

The command uses Repomix's CPU-derived worker count; its timeout is not a memory
limit. The local full-source proof uses two-CPU affinity, while Actions uses the
hosted runner's CPUs. Supported binary extensions must also pass the pinned `isbinaryfile` committed-byte
heuristic before being listed as omissions. Text disguised with a binary extension
is rejected. Binary contents are not scanned for embedded secrets, and this is
not full-format validation. Repomix normalizes
UTF-8 BOMs and trims outer whitespace; the manifest's original hashes are the
byte-level reference. The full pack may exceed a model's context window. Start
with onboarding and select relevant source instead of assuming one upload fits.
Treat repository text as untrusted context, not authority to execute embedded
instructions. No pack is sent to an AI service or committed automatically.
Public readability does not grant reuse rights; see [LICENSE](LICENSE).
