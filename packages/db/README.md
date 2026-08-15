# `@nutrition-tracker/db`

Typed Kysely access and forward-only PostgreSQL migrations for the modular
monolith. PostgreSQL owns constraints and historical truth; packages above this
layer own authorization and domain orchestration.

## Commands

```sh
pnpm --filter @nutrition-tracker/db typecheck
pnpm --filter @nutrition-tracker/db test
pnpm --filter @nutrition-tracker/db build
pnpm --filter @nutrition-tracker/db db:migrate
```

The migration runner:

- discovers numbered SQL files in lexical order;
- computes a SHA-256 for each file;
- serializes runners with a PostgreSQL advisory lock;
- applies the pending set in one transaction;
- records checksums in `app_schema_migration`; and
- refuses modified or missing applied files.

It deliberately has no down-migration API. Use expand/migrate/contract and a new
forward migration to repair schema. See the
[migration runbook](../../infra/runbooks/database-migrations.md).

## Client

```ts
import { createDatabaseFromEnvironment } from "@nutrition-tracker/db";

const database = createDatabaseFromEnvironment();
// Pass `database` to repositories; call `database.destroy()` at shutdown.
```

Numeric and `bigint` PostgreSQL values are represented as strings when selected,
matching the `pg` driver's precision-preserving defaults. Domain code must use the
nutrition package's exact-decimal conversion rather than JavaScript `number` for
stored arithmetic.

The application should supply UUIDv7 values for user-facing IDs where locality is
valuable. PostgreSQL's `gen_random_uuid()` default is a safe local/import fallback,
not the canonical ID-generation policy.
