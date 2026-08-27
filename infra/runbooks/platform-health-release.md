# Platform-health and reminder release

The initial platform scope is read-only body weight from Apple HealthKit and
Android Health Connect plus generic local reminders. Passing JavaScript tests or
Metro export is not native release evidence.

## Configuration gate

- Production compilation first requires a reviewer-signed v7 deployment
  attestation binding the exact digest-qualified `api`, `web`, `worker`,
  `migrator`, `caddy`, `postgres`, and `meilisearch` GHCR images, plus the exact
  canonical external-HTTPS and reviewer-access report bytes. Their strict schemas
  cross-bind the signed origin and commit to fresh public-TLS `/ready` success,
  an independently reviewed policy-artifact digest,
  a redacted assertion of one global-unicast IPv4 `/32`, approved-source
  readiness, and blocked unapproved-source connectivity without storing source
  addresses. The verifier checks that exact signed assertion; it cannot derive
  routability or the live policy's contents from the redacted report. Distinct
  signed deployment-operator and reviewer principals and an active independent
  key from the separate deployment trust store remain mandatory.
  That store is intentionally empty today, so production EAS compilation and
  submission remain blocked. Never substitute an operator-owned key, an unsigned
  digest list, or synthetic report bytes.

### Reviewer-access evidence collection

The independent deployment reviewer performs this sequence before signing:

1. In a private record, name and directly fetch the sensitive effective
   Caddy/provider access-policy artifact through a read-only source. Include every
   enforcement layer that can allow the app, keep the artifact mode `0600`, and
   never place it or its source address in the repository or redacted report.
2. Obtain the expected reviewer source independently, normalize it to canonical
   dotted-decimal IPv4, and inspect the full artifact. Require exactly one
   app-allow source equal to that globally routable unicast IPv4 with prefix
   length `32`; reject every extra, broader, IPv6, wildcard, proxy, private,
   reserved, documentation, link-local, or multicast app-allow source.
3. Reject duplicate-key or non-JSON exports. Serialize the named artifact to
   UTF-8 `canonicalJson` with Unicode code-point object-key order, preserved array
   order, no whitespace, and no trailing newline. Before the probes, compute
   lowercase SHA-256 over those exact canonical bytes for `accessPolicySha256`.
   Do not accept a screenshot, summary, or operator-supplied digest.
4. Run approved `GET /ready` and unapproved blocked-connectivity probes. Then
   immediately re-fetch the same named live artifact from the same source,
   re-inspect and re-canonicalize it identically, and require the same SHA-256.
   Any fetch, parse, inspection, or digest mismatch stops the release.
5. Only then set the exact redacted `accessPolicyShape`, set
   `policyUnchangedDuringProbes` to `passed`, hash the canonical reviewer-access
   report into `reviewerAccessEvidenceSha256`, and sign the v7 deployment record.
   Retain the actual address and sensitive artifact only in the private review
   record; never copy them to the report, signed deployment, CI/EAS inputs, logs,
   or repository.

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
- Every signed internal IPA/APK precompile requires confirmed identifier history
  and exact source-controlled iOS/Android native versions. Its dedicated gate
  deliberately does not require or claim the production deployment attestation;
  ordinary configuration checks remain available while numbering is unresolved.

## Signed-device matrix

Run on one supported physical iPhone and one supported physical Android device
using the exact clean `physical-device` EAS IPA and APK signed by the release
owner. Record each exact EAS build ID before installing it:

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

The signed manifest must mark all 26 checked keys in
`apps/mobile/scripts/check-health-release.mjs` as passed for both device rows and
must include the measured 10,000-revision/100-signed-record protected-journal
round trip. Do not infer these measurements from unit tests. The device row's
`testedEasBuildId` must equal the corresponding internal IPA/APK artifact ID.
The signed v5 `physicalDeviceApiRelay` must also pin the exact reviewed `.ts.net`
origin and canonical relay-report SHA-256. The report must bind both of those
same EAS build IDs to successful public-CA `/ready` probes and prove the exact
first-connect Shields-Up boundary, initially empty Serve/Funnel, identity
revalidation, foreground TCP/443 loopback proxy, disabled Funnel, one tested
non-overlapping two-phone policy shared by both aliases, denied listener
inventory/unapproved peer/off-tailnet access, and timed clean teardown/disconnect.
An HTTPS-shaped URL alone is not evidence. The same v5 manifest must bind the
exact synthetic-only P0 client-smoke candidate for browser, physical iOS, and
physical Android as described in [the P0 smoke runbook](./p0-client-smoke.md).
The signed `p0ClientSmoke.apiOrigin` must equal the relay origin and its
`reportSha256` must bind the candidate's exact bytes. Supply exactly one of
`NUTRITION_P0_CLIENT_SMOKE_REPORT_PATH` or
`NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64`; the path must satisfy the documented
absolute mode-`0600` no-follow contract. The candidate alone is not authenticated
release evidence.

## Artifact binding and promotion

Build the production iOS IPA and Android AAB from the same clean Git commit and
the same source-controlled native build number/version code as the tested
internal artifacts. The independently reviewed v5 manifest binds four distinct
EAS builds: internal iOS IPA, internal Android APK, production iOS IPA, and
production Android AAB. Each entry includes its exact role/profile/type, EAS ID,
source commit, native version, signing-identity fingerprint, and file SHA-256.
The release verifier independently hashes four explicit absolute paths and
checks four separately supplied build-ID pins. The four expected and actual
digests, normalized paths, and available filesystem identities must be pairwise
distinct; symbolic links are rejected.

Archive hashing does not itself extract EAS provenance, native versions, or
platform signing certificates. Before signing, the independent reviewer must
compare those manifest claims with authoritative EAS metadata and platform
signing-tool output. If that comparison is absent, keep the release blocked.

The physical matrix proves the internal IPA/APK rows only. It does not claim the
production IPA/AAB are byte-equivalent. Smoke the production builds through
TestFlight and a Play internal-testing track before wider beta distribution.
Only after the external reviewer signs the manifest should the release operator
run `pnpm release:health-evidence`, followed by the fail-closed
`pnpm release:submit --platform <ios|android> --id <exact-production-eas-id>`
wrapper. A direct `eas submit` bypasses the reviewed release procedure and is
not permitted.

The checked-in reviewer trust list is intentionally empty at present, so these
verification and submission commands must remain blocked. Onboard a genuinely
independent reviewer's Ed25519 public key through reviewed source control before
collecting or accepting a release attestation. The repository/device operator's
own key is not an independent review and must not be trusted for this gate.

## Blocking rule

The milestone is not cleared for a signed beta when either physical-device row
or any of the four exact artifact bindings is missing, a capability/declaration
differs from the checked configuration, a health value appears in notification
or telemetry output, or update/delete/disconnect/key-revocation behavior is not
proven. An empty reviewer trust list or an operator-owned reviewer key is also a
release blocker. File the result as a release blocker; never replace it with a
simulator, mocked-adapter pass, self-review, or same-commit assumption.
