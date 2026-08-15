# ADR 0003: Modular monolith and build/buy boundaries

- Status: Accepted
- Date: 2026-08-15
- Owners: Engineering

## Context

The early team needs transactional correctness and rapid iteration more than
independently deployable services. User, diary, recipe, goal, and entitlement
changes frequently share one transaction. Food imports and search may eventually
have distinct scale, but that is not yet measured.

## Decision

- Ship one API deployable and one worker deployable from a TypeScript modular
  monolith. Modules communicate through typed interfaces and in-process domain
  events, not network calls.
- PostgreSQL is the system of record. Kysely and reviewed SQL expose transactions
  and data-heavy queries directly.
- A PostgreSQL transactional outbox provides at-least-once publication. Consumers
  are idempotent. A PostgreSQL-backed job runner is preferred before another queue.
- Meilisearch CE is a replaceable, rebuildable search projection only after exact
  version/licence review and relevance benchmarks. PostgreSQL exact/trigram search
  remains the degraded fallback.
- S3-compatible storage holds immutable raw food releases, export artifacts, and
  backups. Local development uses MinIO.
- Build the source/provenance model, nutrition engine, serving rules, diary,
  recipes, goals, relevance features, authorization policy, and health-data
  normalization because those are core product behavior.
- Use mature open-source database/search/chart/barcode primitives. Buy managed
  operations, email delivery, push delivery, subscription rails, and potentially
  authentication in production when contracts, privacy, and cost pass review.
- Do not create a service merely to mirror a domain noun.

## Extraction criteria

A module may become an independent service only when measurements show at least
one of the following and the team has an explicit ownership/on-call plan:

1. Food imports or index rebuilds repeatedly violate OLTP resource/SLO isolation.
2. Connector sync needs independent deployment, credential boundary, or throughput.
3. Report/export work needs isolated compute and queue retention.
4. A regulatory boundary requires separate access, keys, or audit controls.

The extraction must preserve an outbox/inbox contract and must not split a required
ACID transaction across synchronous services.

## Consequences

- The system has fewer moving parts and one place for cross-domain transactions.
- Package-boundary tests and ownership discipline are required to avoid a ball of mud.
- Workers can scale separately while sharing code and schema.
- Search and object storage can fail without becoming nutritional truth.

## Rejected alternatives

- Initial microservices add distributed failure and deployment overhead before scale.
- A document database weakens relational version, ownership, and range constraints.
- An ORM that owns schema evolution hides the bulk-import/reporting SQL we must tune.

## Review triggers

- Sustained SLO/resource evidence meets an extraction criterion.
- Team topology changes enough to support independent service ownership.
- A vendor contract creates lock-in or health-data processing concerns.
