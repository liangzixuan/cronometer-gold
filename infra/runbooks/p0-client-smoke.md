# Synthetic P0 client-smoke review package

This procedure records the same synthetic-data-only P0 workflow on a browser,
a physical iOS EAS build, and a physical Android EAS build against one exact
private HTTPS API origin. The normalizer is deliberately read-only: it does not
run a client, invoke Tailscale or EAS, or prove that an assertion happened. It
does not authenticate a capture. It only checks a reviewer-prepared package
structurally.

The resulting `nutrition-tracker-p0-client-smoke-report-v1` is an unsigned
candidate with this exact trust marker:

`unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review`

It is not release evidence by itself. An independent reviewer must reconcile
the preserved raw observations, rerun the normalizer, and sign a health-release
manifest that binds the candidate's exact SHA-256 digest.

## Exact inventory

Use exactly three distinct capture files, one for each role: `browser`, `ios`,
and `android`. Exercise these flows in this exact order on every role:

1. `unauthenticated-entry`
2. `register`
3. `sign-in`
4. `session-restore`
5. `unauthorized-session-rejection`
6. `food-search`
7. `diary-add-edit-delete`
8. `diary-repeat`
9. `recipe-create-revise-log`
10. `goal-create-revise-progress`
11. `retention-trends`
12. `custom-food-create-revise-log`
13. `biometric-create-edit-delete`
14. `reminder-create-pause-revoke`
15. `account-export-download`
16. `sign-out-private-cleanup`
17. `account-erasure`
18. `erasure-status-after-session-revocation`

Use synthetic accounts and synthetic nutrition/health values only. Never put a
name, email address, device identifier, token, cookie, export contents, health
sample, or other secret/personal identifier in these JSON files.

## Capture envelopes

Create a mode `0700` review directory. Preserve the original reviewer-observed
material outside Git, then transcribe only the minimal pass assertions below
into three distinct current-user-owned regular files at absolute normalized
paths. Each file must be mode `0600`, non-symlink, strict UTF-8 JSON, and use the
exact `nutrition-tracker-p0-client-smoke-capture-v1` envelope:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-capture-v1",
  "dataClassification": "synthetic-only",
  "client": "browser",
  "gitCommit": "<40-lowercase-hex-commit>",
  "apiOrigin": "https://<private-api-host>.<tailnet>.ts.net",
  "testedEasBuildId": null,
  "capturedAt": "<final-observation-UTC-with-milliseconds>",
  "results": [
    {
      "flowId": "unauthenticated-entry",
      "outcome": "passed",
      "observedAt": "<UTC-with-milliseconds>"
    }
  ]
}
```

Supply all 18 result objects in the exact inventory order. Observation times
must be monotonic. `capturedAt` must equal the final observation. For `ios` and
`android`, `testedEasBuildId` is the distinct physical-device EAS build UUID;
for `browser`, it is exactly `null`. All captures bind the same commit and the
exact private `.ts.net` HTTPS API origin exercised. This does not invent or bind
a browser deployment origin.

Create a fourth current-user-owned mode `0600` index with exact schema
`nutrition-tracker-p0-client-smoke-review-package-v1`:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-review-package-v1",
  "trustBoundary": "unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review",
  "dataClassification": "synthetic-only",
  "gitCommit": "<same-commit>",
  "apiOrigin": "https://<same-private-api-host>.<tailnet>.ts.net",
  "startedAt": "<UTC-with-milliseconds>",
  "executedAt": "<UTC-with-milliseconds>",
  "completedAt": "<UTC-with-milliseconds>",
  "buildIds": {
    "ios": "<physical-iOS-EAS-build-UUID>",
    "android": "<physical-Android-EAS-build-UUID>"
  },
  "captures": {
    "browser": "/absolute/review/browser.json",
    "ios": "/absolute/review/ios.json",
    "android": "/absolute/review/android.json"
  }
}
```

The session must be at most 24 hours and satisfy
`startedAt <= executedAt <= completedAt`. A copied placeholder is intentionally
invalid and cannot mint a candidate.

## Normalize and independently review

Run locally without adding the package or candidate to Git:

```sh
python3 -B infra/smoke/p0_client_smoke.py \
  --capture-index /absolute/review/index.json \
  --acknowledge-unsigned-candidate \
  > /absolute/review/p0-client-smoke-candidate.json
chmod 0600 /absolute/review/p0-client-smoke-candidate.json
```

The warning on stderr is mandatory. The normalizer hashes the exact raw bytes
for each capture and derives `sourceCaptureBundleSha256` with a fixed
domain-separated `browser`, `ios`, `android` order. Its structural `passed`
values remain unauthenticated assertions.

The independent reviewer must obtain the protected raw captures from the
review source, compare their exact bytes and SHA-256 values with the candidate,
verify the synthetic-only workflow observations and physical EAS build IDs,
and rerun the normalizer from those exact files. The reviewer then puts
`p0ClientSmoke.apiOrigin` and the exact candidate `reportSha256` into the v5
health-release manifest and signs the full canonical manifest with the trusted
Ed25519 review key. Only the repository health verifier's successful validation
of that signed manifest and candidate is authoritative release evidence.
