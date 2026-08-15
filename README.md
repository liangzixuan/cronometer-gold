# Nutrition Tracker

A provenance-first nutrition and health tracking platform. The implementation
sequence and product invariants are captured in
[`docs/product/build-plan.md`](docs/product/build-plan.md).

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
- `packages/domain`: pure nutrition, serving, recipe, and snapshot rules
- `packages/contracts`: transport-neutral API contracts
- `packages/db`: PostgreSQL schema, Kysely types, and migrations
- `infra/docker`: local development dependencies
- `docs/adr`: decisions and non-negotiable boundaries
- `docs/product`: executable product scope and milestone sequence

Canonical source onboarding is documented in the
[`food-source release runbook`](infra/runbooks/food-source-release.md). Checked-in
USDA and Health Canada candidates are intentionally non-importable until their
independent acquisition, rights, storage, and nutrient-mapping approvals exist.

## Prerequisites

- Node.js 22.13 or newer
- pnpm 11.19 or newer
- Docker with Compose for local infrastructure

## Getting started

```sh
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

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
3. Food, recipe, goal, equation, and diary history is versioned. A logged entry
   stores a nutrition snapshot and does not change when a source record changes.
4. Missing nutrient data is not zero. Every published nutrient value retains its
   source, release, basis, and quality status.
5. External providers sit behind adapters. Entitlements, consent, provenance,
   and deletion state stay first-party.
