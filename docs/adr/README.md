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
| [0028](./0028-print-current-nutrition-report.md) | Print the current coherent nutrition report on web | Source delivered; bounded repeat/Cancel and Ctrl+P passed September 16; external/release acceptance separate |
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
| [0039](./0039-loaded-saved-recipe-filter.md) | Filter only loaded saved-recipe names while preserving workspace state | Source complete; local validation and synthetic Chrome QA passed; automatic, independent and release acceptance pending |
| [0040](./0040-native-custom-food-nutrient-composer.md) | Add named nutrient rows to the existing native custom-food draft | Source complete; local native component validation and exports passed; automatic, independent and release acceptance pending |
| [0041](./0041-saved-custom-food-nutrient-details.md) | Inspect loaded saved custom-food nutrient snapshots without editing | Source/local complete; automatic and release acceptance separate |
| [0042](./0042-native-trend-nutrient-picker.md) | Select every loaded targetable nutrient for native Health trends | Source/local complete; automatic and release acceptance separate |
| [0043](./0043-loaded-saved-custom-food-filter.md) | Filter loaded saved custom foods by name | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0044](./0044-copy-saved-custom-food-to-new-draft.md) | Copy a saved custom food to a new draft | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0045](./0045-native-biometric-reading-units.md) | Show native biometric reading units and preserve edit metric identity | Source/local complete; automatic and release acceptance separate |
| [0046](./0046-native-goals-nutrient-picker.md) | Find and add every loaded native Goals nutrient with units | Source/local complete; automatic and release acceptance separate |
| [0047](./0047-activity-duration-presets.md) | Set Activity Add duration with 15/30/60-minute shortcuts | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0048](./0048-loaded-nested-recipe-filter.md) | Filter loaded nested-recipe ingredient choices by name | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0049](./0049-logged-diary-entry-nutrients.md) | Inspect nutrients for a logged diary portion | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0050](./0050-saved-reminder-weekdays.md) | Show saved reminder weekdays | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0051](./0051-saved-biometric-time-zones.md) | Show saved biometric dates, times and time zones | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0052](./0052-missing-biometric-metadata-labels.md) | Label missing biometric metadata on web | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0053](./0053-optional-recipe-log-time.md) | Optional local time for saved recipe logs | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0054](./0054-recipe-ingredient-food-search-pages.md) | Page reviewed foods in recipe ingredient search | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0055](./0055-biometric-history-windows.md) | Navigate earlier biometric history windows | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0056](./0056-reminder-day-presets.md) | Choose reminder day presets | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0057](./0057-diary-expand-all.md) | Expand all diary meals | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0058](./0058-biometric-history-filter.md) | Filter loaded biometric history by metric | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0059](./0059-web-goal-nutrient-search.md) | Search the web goal nutrient picker | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0060](./0060-goal-copy.md) | Copy a saved manual goal into a new draft | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0061](./0061-trend-date-presets.md) | Health trend date shortcuts | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0062](./0062-native-trend-none.md) | Nutrition-only Health trends on native | Source/local complete; automatic and release acceptance separate |
| [0063](./0063-native-trend-units.md) | Units in native Health trend metric choices | Source/local complete; automatic and release acceptance separate |
| [0064](./0064-web-trend-nutrient-search.md) | Search web Health trend nutrients | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0065](./0065-native-composer-clear.md) | Clear the native named nutrient filter | Source/local complete; automatic and release acceptance separate |
| [0066](./0066-native-composer-wrap.md) | Wrap native named nutrient choices | Source/local complete; automatic and release acceptance separate |
| [0067](./0067-web-nutrient-availability.md) | Explain unavailable web nutrient additions | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0068](./0068-web-nutrient-uniqueness.md) | Prevent duplicate web nutrient choices | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0069](./0069-custom-revise-guard.md) | Protect unsaved custom-food drafts when revising | Source/local complete; synthetic Chrome QA passed; automatic/release separate |
| [0070](./0070-native-composer-save.md) | Protect unfinished native nutrient input when saving | Source/local complete; automatic and release acceptance separate |
| [0071](./0071-native-nutrient-remove.md) | Remove named nutrient rows from native drafts | Source/local complete; automatic and release acceptance separate |
| [0072](./0072-native-nutrient-edit.md) | Edit named nutrient rows in native drafts | Source/local complete; automatic and release acceptance separate |
| [0073](./0073-native-draft-nutrient-filter.md) | Find nutrient rows in native drafts | Source/local complete; automatic and release acceptance separate |
| [0074](./0074-native-picker-availability.md) | Prevent duplicate native nutrient choices | Source/local complete; automatic and release acceptance separate |
| [0075](./0075-web-repeat-retry.md) | Preserve web Diary Repeat retries across clock changes | Source/local complete; automatic and release acceptance separate |
| [0076](./0076-standalone-private-day-notes.md) | Standalone owner-private day notes with immutable history and complete export/erasure | Source/local and exact-commit automatic evidence complete at 9344057; external/release acceptance pending |
| [0077](./0077-role-specific-p0-evidence.md) | Role-specific P0 v3 capture/review evidence and health manifest v6 | Implemented at 805b937; review follow-up delivered at 5d4c5a1; external/device/release acceptance separate |
| [0078](./0078-native-saved-day-note-preview.md) | Compact native saved day-note text with explicit full view | Implemented at b9a081c; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0079](./0079-native-recipe-draft-protection.md) | Preserve native recipe edits across replacement choices and revision conflicts | Implemented at bacc261; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0080](./0080-native-saved-entry-note-preview.md) | Compact native saved diary entry notes with explicit full view | Implemented at 28f6e4f; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0081](./0081-native-public-food-log-time.md) | Choose an optional local time for native public-food logs | Implemented at ddd19bb; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0082](./0082-native-public-food-log-date-shortcuts.md) | Choose Today or Yesterday for native public-food logs | Implemented at 2e77f20; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0083](./0083-native-recipe-log-date-shortcuts.md) | Choose Today or Yesterday for native saved-recipe logs | Implemented at af1c860; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0084](./0084-native-custom-food-log-date-shortcuts.md) | Choose Today or Yesterday for native custom-food logs | Implemented at 6ad9129; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0085](./0085-native-biometric-reading-date-shortcuts.md) | Choose Today or Yesterday for native biometric readings | Implemented at ab2c6de; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0086](./0086-native-goal-new-draft-protection.md) | Protect native goal edits before starting a blank draft | Implemented at 053afe0; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0087](./0087-native-goal-revision-conflict-draft.md) | Preserve native goal edits after a revision conflict | Implemented at 53a43cc; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0088](./0088-native-custom-food-new-draft.md) | Start a new native custom food with draft protection | Implemented at be1390e; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0089](./0089-native-custom-food-revision-conflict.md) | Explicit recovery from native custom-food revision conflicts | Implemented at 956ccf1; local and exact-commit automatic evidence passed; device/release acceptance separate |
| [0090](./0090-native-activity-edit-draft-protection.md) | Protect native activity edits during local navigation | Source complete and reviewed; final canonical/automatic evidence pending; device/release acceptance separate |

New ADRs use the next four-digit number and include context, decision,
consequences, alternatives, and review triggers.
