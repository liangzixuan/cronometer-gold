# Privacy export and account erasure

This runbook covers the production execution and evidence boundary for complete
account exports and erasure. Nutrition, hydration, and biometric values never
belong in a ticket, log, metric, email, or operator screenshot.

## Local all-entity drill

With the guarded loopback dependencies healthy and migrations current, run
`pnpm retention:privacy-drill`. The drill uses the closeable production API
application without a listener and the combined worker runtime for exactly four
named bounded polls: seed export, one-artifact expiry, measured export, and
erasure. Its static contract rejects an additional hidden poll.

The fixture populates and independently enumerates the compile-pinned set of all
61 retained export entity families. Every family must have a nonzero source
count and exact IDs/counts must reconcile across the source snapshot, JSON, and
decompressed CSV. Forbidden field-name assertions and independent sentinels
verify redaction in every exported audit row; artifact lifecycle rows must omit
object locators, encryption identifiers, and ciphertext-byte metadata.
Pause/revoke cancels a queued reminder delivery before export. The erased
owner's scoped rows and projections reconcile to zero, and an authenticated
cross-owner account and session must survive. Supported user workflows are
route-first. Narrow direct compatibility/evidence fixtures cover only route-
unreachable catalogue/source/import, audit, legacy nutrient/barcode, and legacy
operation rows.

Hydration is route-first in this drill: create, update, and logical delete use
the authenticated HTTP contract. `hydration_day`, `hydration_entry`,
`hydration_entry_revision`, and `hydration_operation` must reconcile exactly in
both artifacts, then reconcile to zero for the erased owner; an independently
queried cross-owner hydration entry and its owner session must survive.

This is local synthetic evidence, not permission to inspect a person's artifact,
expose a listener, use production data, or operate a cloud deployment. It does
not replace notification-delivery, hosted access-control, off-host restore,
signed-device, independent-reviewer, or controlled-beta evidence.

## Export release checklist

1. Confirm the request was made by an active owner session with an unexpired,
   single-purpose recent-reauthentication proof and UUID idempotency key.
2. Confirm the job captured one database snapshot watermark and is not marked
   complete until every entity count, diary total, and artifact digest
   reconciles.
3. Inspect only the manifest: schema version, snapshot time, entity counts,
   artifact byte counts, SHA-256 values, expiry, and reconciliation result. Do
   not open a user's artifact during routine support.
4. Confirm JSON and requested CSV artifacts are encrypted in the approved object
   store, private, and reachable only through the authenticated expiring download
   route. Verify `Cache-Control: no-store` and content-disposition behavior.
5. Confirm spreadsheet-leading values in CSV are neutralized and the JSON retains
   immutable IDs, versions, sources, units, time zones, trace/unknown reasons,
   tombstones, consent history, and import conflict evidence.
6. After expiry, run the artifact-retention job and verify the object, download
   authorization, and job artifact references are gone. Retain only bounded
   operational evidence allowed by the privacy schedule.

If reconciliation, upload, encryption, or deletion fails, the job remains failed
and no download is exposed. Retry with the same job identity; do not fabricate a
new completed receipt.

The worker write principal may put, authenticate-read for post-write
verification, and delete only objects under the export bucket. The API read
principal may only get an object whose random key came from an owned completed
job; neither principal may list the bucket. Export keys are write-once and the
bucket is unversioned unless the storage operator has separately proven an
all-version deletion/lifecycle policy. A delete marker over retained noncurrent
ciphertext does not satisfy expiry or erasure.

## Erasure execution checklist

1. Confirm explicit `DELETE_MY_ACCOUNT` acknowledgement, recent reauthentication,
   request digest, and idempotency evidence.
2. The worker first locks the account and changes it to `pending_deletion`, then
   revokes sessions, device keys, integration consent, reminder schedules,
   download access, and queued delivery/import work.
3. Delete user-owned data in the repository's reviewed dependency order. This
   includes diary and hydration history, biometrics, custom foods, recipes, goals,
   imports, devices, reminders, exports/artifacts, sessions, credentials,
   profile, and account identifiers. Do not bypass immutable guards from an
   application role;
   use the narrowly scoped erasure transaction.
4. Reconcile every scoped table and projection to zero rows for the erased owner.
   Rebuild or invalidate any derived index/cache that could retain a private
   custom item.
5. Persist only the random erasure receipt, completion time, aggregate result,
   backup-expiry date, and policy version. It must contain no user ID, email,
   health value, object key, provider ID, device fingerprint, or reversible hash.
6. Revoke/delete downstream provider data when the integration contract supports
   it and record the provider operation status without tokens or payloads.

An erasure is failed, not partially complete, if any live user-scoped row,
artifact, token, outbox event, or projection remains. A retry resumes through the
same job/receipt and remains idempotent.

## Dead-letter recovery

Export, erasure, staged-upload cleanup, and expired-artifact cleanup stop after
the bounded retry limit and emit a payload-free `retention.job.dead_lettered`
event. A terminal row is never made runnable by an ordinary poll. Before a
requeue, resolve the storage/database cause, confirm the target kind and random
identifier from restricted operational records, and obtain a reviewed approval
artifact. Store only the lowercase SHA-256 of that approval artifact in the
recovery record; do not put an email, account identifier, health value, object
key, ticket text, or other payload in the digest input or command output.

With production database TLS and the current restore epoch configured, use the
bounded offline command for exactly one target:

```sh
pnpm --filter @nutrition-tracker/worker retention:requeue -- \
  --kind export \
  --id 11111111-1111-4111-8111-111111111111 \
  --approval-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Replace both example values with the reviewed target and digest. The accepted
kinds are `export`, `erasure`, `staged-artifact`, and `artifact`.
The repository accepts only an actually dead-lettered target, records an
immutable recovery audit row, preserves the original erasure start timestamp so
an already-written external ledger entry remains byte-identical, and resets only
the retry/fencing state needed for the same job to resume. Verify the next
payload-free completion or dead-letter event. Never create a replacement
erasure job or overwrite/delete an erasure-ledger version to bypass a failed
recovery.

Before the destructive database transaction, the erasure worker writes and
authenticates an AES-256-GCM encrypted entry to a separate private, versioned
ledger bucket. The entry contains the exact subject only inside authenticated
ciphertext. Its object locator is `v1:<key-id>:<HMAC>` over the canonical subject
UUID under a dedicated, versioned locator-key ring. The locator is deterministic
only to holders of that ring, is unrelated to the ledger encryption keys, and is
not a replacement for the encrypted subject entry. Its writer can put and verify
but cannot list or delete. Bucket versioning preserves every attempted rewrite.
Restore tooling has a separate principal that can list versions only beneath the
ledger prefix and read an exact object version; it rejects a missing entry, a
delete marker, truncated version listing, or more than one version at the derived
key. The application database keeps the locator and acknowledgement only until
deletion commits, then scrubs them and retains a random non-identifying receipt.

## Backup tail and restore

Production policy must name the encrypted backup retention period. Do not claim
instant removal from immutable backups. Every restored database must apply the
erasure receipt/ledger before traffic, then rerun the zero-row reconciliation.
Before creating or attaching any API or worker deployment, generate a fresh
32-or-more-character `DATABASE_RESTORE_EPOCH` with a CSPRNG and store it in that
database instance's deployment configuration. Never copy the source database's
epoch into a snapshot, PITR, clone, or disaster-recovery target. Logical restores
are additionally bound to the target database name and OID; physical/PITR clones
that preserve those identifiers rely on the mandatory fresh epoch.

The PostgreSQL restore drill in `scripts/postgres-restore-drill.mjs` verifies the
database copy itself. Keep the restored application offline, run the restore-only
ledger replay command with the fresh epoch, version-list/exact-version-read
credentials, and every unexpired locator and ledger-encryption key generation:

```sh
pnpm --filter @nutrition-tracker/worker erasure:restore-replay
```

For each subject UUID present in the restored snapshot, the command derives and
probes every retained opaque locator; requires exactly one object version for at
most one derived locator; authenticates the entry; replays deletion; reconciles
the subject to zero rows; and only then writes the epoch/database attestation.
API readiness and the normal worker both require that exact attestation in
production. Only after both readiness probes succeed may traffic or polling be
enabled. Removing a locator key
before the maximum backup tail expires makes restoration unsafe. A restored API
must never become ready between database restore and ledger replay.

## Incident handling

- Freeze affected export downloads without deleting evidence needed to establish
  scope.
- Rotate object-store and signing credentials if exposure is possible.
- Never send an artifact as an email attachment or move it to a personal drive.
- Follow the reviewed incident and breach-notification process; this runbook does
  not make a legal notification decision.
