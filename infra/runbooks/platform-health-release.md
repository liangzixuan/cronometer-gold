# Platform-health and reminder release

The initial platform scope is read-only body weight from Apple HealthKit and
Android Health Connect plus generic local reminders. Passing JavaScript tests or
Metro export is not native release evidence.

## Configuration gate

- iOS has the HealthKit capability and a specific `NSHealthShareUsageDescription`.
  No write purpose string or data type is declared while the product is read-only.
- Android declares only `READ_WEIGHT`, the required Health Connect availability
  query/rationale entry points, and notification permission. The Play Console
  Health Apps declaration and privacy policy name the same narrow purpose.
- Reminder title/body are fixed generic product copy. User labels, food, meal,
  goal, weight, biometric, note, and date values are absent from notification
  requests, operating-system schedules, logs, and receipts.
- The production API origin is explicit HTTPS, backup is disabled, transport
  security remains strict, and health/device payload logging is denied.

## Signed-device matrix

Run on one supported physical iPhone and one supported physical Android device
using clean preview binaries signed by the release owner:

1. Create the device key in the platform keystore and register only its public
   key after signing the server challenge. Verify a copied or expired challenge,
   altered public key, and second use are rejected.
2. Request weight permission in context. Verify allow, cancel/deny, limited
   history where available, and unavailable-platform states without guessing a
   permission result from an empty read.
3. Import one weight; verify canonical kilograms, source record ID/revision,
   occurrence time, time zone, device key, cursor/anchor, and digest are retained.
4. Resend the exact signed batch and confirm replay with no duplicate. Change the
   body, timestamp, nonce, device, or signature and confirm rejection.
5. Edit and delete the platform record. Confirm the same logical event is revised
   or tombstoned and trends update without silently keeping both values.
6. Expire/invalidate a change cursor or anchor. Confirm bounded reread and
   de-duplication rather than data loss or duplicate events.
7. Disconnect. Confirm sync pauses, consent is revoked, device keys/import
   challenges cannot be reused, and the UI links to operating-system access
   controls. Existing imported records follow the user's explicit retain/delete
   choice and remain attributable until deleted.
8. Add, pause, edit across a daylight-saving transition, and revoke a reminder.
   Confirm one generic local notification at the intended wall time and no future
   delivery after revocation or permission loss.
9. Delete the account and confirm local notification schedules, secure device
   material, server device keys, import records, and consents are removed.

Record only build identifiers, OS/device model, permission outcome category,
batch/receipt IDs, pass/fail, and timestamps. Do not record health values,
provider record IDs, signatures, public keys, tokens, or screenshots containing
personal data.

## Blocking rule

The milestone is not cleared for a signed beta when either physical-device row is
missing, a capability/declaration differs from the checked configuration, a
health value appears in notification or telemetry output, or update/delete/
disconnect/key-revocation behavior is not proven. File the result as a release
blocker; never replace it with a simulator or mocked-adapter pass.
