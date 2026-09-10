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
| [0013](./0013-durable-native-public-food-quick-add-outbox.md) | Durable native public-food quick-add outbox | Accepted for local implementation; signed-device evidence blocked |
| [0014](./0014-email-verification-boundary.md) | Additive email-verification boundary | Accepted for local implementation; production delivery and enforcement blocked; password recovery continued by ADR 0015 |
| [0015](./0015-password-recovery-boundary.md) | Password-recovery boundary | Accepted for local implementation; production delivery and abuse controls blocked |
| [0016](./0016-hydration-ledger-boundary.md) | Private hydration-ledger boundary | Accepted for local implementation; targets, offline mutation, and device evidence blocked |
| [0017](./0017-authenticated-food-artifact-acquisition-retention.md) | Authenticated food-artifact acquisition and retention evidence | Source/local manifest-v4 gate implemented; live runner, immutable storage, acquisition, provider verification, and named review blocked |
| [0018](./0018-catalogue-database-authority-boundary.md) | Catalogue database-authority boundary | Accepted for bounded EXPAND implementation; deploy and CONTRACT phases blocked |
| [0019](./0019-first-release-parity-and-camera-barcode-capture.md) | First-release parity sequencing and camera barcode capture | Source implementation complete; signed-device and live-catalogue evidence blocked |
| [0020](./0020-configurable-diary-presentation-groups.md) | Owner-configurable labels and display order for stable diary meal slots | Accepted for local implementation; signed-device evidence blocked |
| [0021](./0021-source-verified-adult-dri-reference-targets.md) | Source-verified adult U.S.–Canada DRI reference-target candidate | Accepted for local source implementation; clinical, legal/privacy, copyright, and commercial-enablement reviews blocked |
| [0022](./0022-bounded-multi-day-nutrition-reports.md) | Bounded owner-private multi-day nutrition reports | Accepted for local implementation; hosted, signed-device, cross-client, and accessibility evidence blocked |
| [0023](./0023-general-native-diary-operation-outbox.md) | Generalized native diary logging outbox | Accepted for local implementation; signed-device and general offline-sync evidence blocked |
| [0024](./0024-durable-diary-corrections-and-atomic-ordering.md) | Durable diary corrections and atomic within-meal day ordering | Accepted for local implementation; signed-device and general offline-sync evidence blocked |
| [0025](./0025-manual-activity-ledger-boundary.md) | Private manual-activity ledger boundary | Accepted for local implementation; automatic energy adjustment, offline mutation, platform import, and device evidence blocked |
| [0026](./0026-coordinated-today-overview.md) | Coordinated profile-local Today overview | Accepted for local implementation; hosted, signed-device, physical cross-client, and assistive-technology evidence blocked |
| [0027](./0027-hydration-time-corrections.md) | Explicit profile-local hydration time corrections | Accepted for local implementation; hosted and physical-client acceptance pending |
| [0028](./0028-print-current-nutrition-report.md) | Print the current coherent nutrition report on web | Source checkpoint; preview/Cancel verified; repeat/direct print, automatic evidence and independent review pending |
| [0029](./0029-pasted-ingredient-review.md) | Explicit review of pasted ingredient lines in the web new-recipe builder | Accepted; local validation passed; automatic and release evidence pending |
| [0030](./0030-mobile-pasted-ingredient-review.md) | Explicit native review of pasted ingredient lines using shared parsing and existing recipe contracts | Accepted for bounded source implementation; validation and release evidence pending |
| [0031](./0031-recipe-nutrition-basis-and-coverage.md) | Explicit saved-recipe nutrition basis and coverage on web and mobile | Source complete; local validation passed; automatic and release evidence pending |
| [0032](./0032-copy-saved-recipe-to-new-draft.md) | Copy an exact saved recipe into an independent new private draft | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0033](./0033-reorder-recipe-draft-ingredients.md) | Reorder exact ingredients locally before explicit recipe create/revision | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0034](./0034-adjacent-nutrition-report-periods.md) | Navigate adjacent equal-length report periods through existing snapshot readers | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0035](./0035-report-source-diary-navigation.md) | Open contributing source diary dates from report evidence | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0036](./0036-collapsible-diary-meal-groups.md) | Collapse diary meal content with private in-memory presentation state | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0037](./0037-reuse-activity-details.md) | Reuse exact saved activity details in a new reviewed Add draft | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0038](./0038-hydration-amount-presets.md) | Choose an exact amount in the existing hydration Add draft | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |

New ADRs use the next four-digit number and include context, decision,
consequences, alternatives, and review triggers.
