# Architecture decision records

ADRs record decisions that affect data correctness, rights, privacy, or the shape
of the system. They are append-only historical documents: supersede an accepted
ADR with a new ADR instead of rewriting its decision.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](./0001-food-source-rights-and-provenance.md) | Food-source rights and provenance | Accepted with release gate |
| [0002](./0002-immutable-history-and-diary-snapshots.md) | Immutable revisions and diary snapshots | Accepted |
| [0003](./0003-modular-monolith-and-build-buy-boundaries.md) | Modular monolith and build/buy boundaries | Accepted |
| [0004](./0004-consumer-wellness-boundary.md) | Consumer-wellness product boundary | Accepted |
| [0005](./0005-authenticated-diary-and-session-boundary.md) | Authenticated diary and session boundary | Accepted |
| [0006](./0006-versioned-recipes-and-explainable-goals.md) | Versioned recipes and explainable goals | Accepted |
| [0007](./0007-retention-privacy-and-platform-health.md) | Retention, privacy operations, and platform-health imports | Accepted |
| [0008](./0008-on-demand-azure-arm-beta-pivot.md) | On-demand Azure ARM synthetic-beta pivot | Accepted for implementation |
| [0009](./0009-ephemeral-localstack-s3-iam-fixture.md) | Ephemeral LocalStack S3/IAM development fixture | Accepted for local implementation |
| [0010](./0010-persistent-localstack-development-profile.md) | Attended persistent LocalStack development profile | Accepted for local implementation |
| [0011](./0011-windows-host-wsl2-private-phone-relay.md) | Windows-host/WSL2 private physical-phone relay boundary | Proposed; implementation and phone exposure blocked |
| [0012](./0012-coherent-private-diary-pagination.md) | Coherent private diary pagination | Accepted for local implementation; release evidence blocked |

New ADRs use the next four-digit number and include context, decision,
consequences, alternatives, and review triggers.
