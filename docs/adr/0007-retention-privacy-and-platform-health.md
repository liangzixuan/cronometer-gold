# ADR 0007: Retention, privacy operations, and platform-health imports

- Status: Accepted
- Date: 2026-08-16
- Owners: Product, privacy, security, domain engineering, mobile engineering

## Context

A useful nutrition diary has to remain trustworthy after the first successful
day. People need to repeat prior choices, understand longer-term patterns, move
their data elsewhere, stop reminders, disconnect platform integrations, and
erase their account. Those features touch the most sensitive records in the
product and can easily weaken the historical and missingness guarantees already
made by the diary.

HealthKit and Health Connect are on-device aggregators, not interchangeable
databases. They expose provider-specific identifiers, edits, deletions,
permissions, history windows, and change cursors. A value without that evidence
cannot be reconciled or safely de-duplicated. HealthKit also intentionally does
not reveal whether a read permission was denied or simply returned no samples.

## Decision

### Reports and repeat logging

1. Nutrition trends are computed from immutable diary revisions inside one
   coherent database snapshot. Date ranges are local-date ranges in the active
   profile time zone, are bounded, and expose quantified, trace, and unknown
   coverage. The product reports descriptive trends, not diagnosis, causation,
   or nutrient-deficiency claims.
2. Repeating a diary entry creates a new immutable entry while retaining the
   exact food, custom-food, or recipe version selected by the source entry. It
   never follows a current-version pointer. The destination local date is
   derived by the server from the requested instant and current profile zone.
3. Repeat requests use the same UUID and canonical request digest on retry.
   Deleted, revoked, or superseded catalogue rights can block a new log without
   changing the historical source entry.

### Custom foods and biometrics

1. A custom food is private and owner-scoped. Changes create immutable versions
   with explicit serving grams, canonical nutrient units, value provenance, and
   reason-counted missingness. Custom records are never labelled source-verified
   and are excluded from the public search projection.
2. Custom-food deletion archives the root and removes it from new selection. It
   does not rewrite diary or recipe snapshots. Dependency and ownership checks
   fail closed.
3. The initial biometric surface supports reviewed standard definitions and
   private custom definitions with a fixed dimension and canonical unit. Events
   are versioned, owner-scoped, and retain occurrence time, effective time zone,
   source, external identity, and import evidence.
4. Imported updates and deletions are idempotent by provider, device,
   data type, and external record identity. A conflicting revision or digest is
   surfaced for reconciliation rather than selected silently. No biometric is
   interpreted as an acute alert or clinical recommendation.

### Reminders

1. Reminders are opt-in, independently revocable, and defined by local wall time,
   IANA time zone, selected weekdays, and an explicit consent revision.
2. Notification content is a fixed generic product reminder. Food, meal, goal,
   weight, biometric, and note details never enter push payloads or lock-screen
   text.
3. Local scheduling is the initial delivery mechanism. Delivery receipts contain
   operational identifiers and status only. Denied notification permission,
   time-zone changes, pauses, and revocation cancel future schedules.

### Platform integrations and signed devices

1. The initial platform adapters import weight from Apple HealthKit and Android
   Health Connect. New data types or export directions require separate scope,
   store-declaration, claims, and privacy review.
2. Permission is requested in context and per data type. The app handles
   unavailable, limited, denied, revoked, expired-cursor, partial-page, update,
   and deletion states. Disconnect stops synchronization and exposes the
   platform settings needed to revoke operating-system permissions.
3. Health Connect keeps an independent changes token per record type and stores
   provider record IDs and revisions. On token expiry it performs a bounded
   reread and de-duplicates against retained identities. HealthKit uses anchored
   queries and retains anchors per sample type.
4. A mobile installation registers a hardware-backed public key when the
   platform can provide one. Registration proves possession against a
   single-use server challenge. Each later import requires an authenticated
   owner session, and its device signature binds the registered device,
   provider, batch identity, canonical body digest, timestamp, nonce, and
   cursor/anchor. The server verifies ownership, signature, replay window, and
   nonce before applying health values atomically. Caller-authored trust flags
   are ignored.
5. Native libraries require a development or preview build. JavaScript bundle
   export is not evidence that HealthKit capabilities, Android permissions,
   purpose strings, signing, or device keystore behavior work. Release remains
   blocked until clean signed iOS and Android builds pass the permission,
   import/update/delete, disconnect, and key-invalidation device matrix.

### Export, deletion, and recovery

1. A complete account export requires recent reauthentication and is generated
   asynchronously from one coherent database snapshot. The fidelity artifact is
   canonical JSON; CSV is included for usable tabular records. Both neutralize
   spreadsheet formulas and preserve IDs, versions, units, source provenance,
   time zones, trace/unknown reasons, and tombstones.
2. Every artifact contains a versioned manifest with entity counts, snapshot
   watermark, per-file byte counts and SHA-256 digests, and reconciliation
   results for diary/report totals. A job is not ready until reconciliation
   passes. Artifacts are encrypted in approved object storage, expire quickly,
   are never logged, and downloads are audited without payload details.
3. Account erasure requires recent reauthentication and an explicit consequence
   acknowledgement. Access, sessions, reminders, devices, and integrations are
   revoked first. A controlled job then deletes user-owned health data, custom
   foods, recipes, goals, exports, outbox work, tokens, and identifiers in
   dependency order. Only a random, non-identifying receipt and aggregate
   operational result remain.
4. Erasure documents the encrypted-backup tail rather than claiming immediate
   removal from immutable backups. Before live-row deletion, a worker writes an
   authenticated, encrypted subject entry under a versioned opaque locator in a
   separate append-only ledger store. The locator is an HMAC of the canonical
   subject UUID under a dedicated rotation key and reveals no subject without
   that key. The application database keeps the locator only until the write is
   authenticated, then scrubs it during deletion; the final receipt is random
   and non-identifying. Backup retention must be bounded. Restore tooling derives
   every retained locator generation for subjects present in the restored
   snapshot, authenticates/decrypts matching entries with restore-only
   credentials, and replays them before serving traffic.
5. A logical-backup drill is successful only after restore into a new isolated
   database, exact migration-ledger verification, bounded entity-count
   reconciliation, application smoke tests, and erasure-ledger replay. Creating
   a dump is not recovery evidence.

All private routes use `Cache-Control: no-store`, server-derived ownership,
bounded payloads and ranges, and redacted structured logs. Export, erasure,
device registration, integration changes, and import batches are idempotent.

## Platform sources

- Apple, HealthKit authorization and capability requirements:
  <https://developer.apple.com/documentation/HealthKit/authorizing-access-to-health-data>
  and <https://developer.apple.com/documentation/Xcode/configuring-healthkit-access>
- Android, Health Connect synchronization and permission behavior:
  <https://developer.android.com/health-and-fitness/health-connect/sync-data>
  and <https://developer.android.com/health-and-fitness/health-connect/ui/permissions>
- Expo, development builds and notifications:
  <https://docs.expo.dev/develop/development-builds/introduction/> and
  <https://docs.expo.dev/versions/latest/sdk/notifications/>

## Consequences

- The retention milestone begins with one platform-health data type instead of a
  broad, weakly reconciled connector catalogue.
- Immutable versions and import events increase storage but make corrections,
  exports, and deletion evidence reproducible.
- Complete export and erasure are background workflows with explicit failure and
  retry states, not synchronous success screens.
- Native signing and health permissions add a signed-device release gate that
  cannot run in Expo Go or be replaced by Metro bundling.
- Trends remain intentionally descriptive until a separately reviewed analysis
  or clinical policy exists.

## Rejected alternatives

- Repeating the current food or recipe version can silently change the selected
  nutrition.
- Treating a missing HealthKit result as proof of denied permission violates the
  platform privacy model.
- Importing by timestamp alone loses provider edits and deletions and creates
  duplicates after cursor expiry.
- Health details in notification text leak on lock screens and notification
  mirrors.
- A CSV-only export loses immutable structure and missingness; an undocumented
  database dump is not a user-portable export.
- Soft-disabling an account while retaining live health tables does not satisfy
  erasure.

## Review triggers

- Additional HealthKit or Health Connect data types or any write/export scope.
- Cloud-provider or wearable OAuth integrations.
- Correlation, deficiency, acute-alert, adaptive-coaching, or therapeutic copy.
- Server push notifications, shared reminders, or notification personalization.
- Changes to export retention, backup retention, erasure receipts, or legal hold.
- Shared custom foods/biometrics or delegated/household access.
