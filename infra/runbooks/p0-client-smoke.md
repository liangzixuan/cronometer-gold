# Synthetic P0 client-smoke review package

This procedure records the same synthetic-data-only P0 workflow on a browser,
a physical iOS EAS build, and a physical Android EAS build against one exact
private HTTPS API origin. The normalizer is deliberately read-only: it does not
run a client, invoke Tailscale or EAS, or prove that an assertion happened. It
does not authenticate a capture. It only checks a reviewer-prepared package
structurally.

The resulting `nutrition-tracker-p0-client-smoke-report-v2` is an unsigned
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
9. `diary-pagination`
10. `recipe-create-revise-log`
11. `goal-create-revise-progress`
12. `retention-trends`
13. `custom-food-create-revise-log`
14. `biometric-create-edit-delete`
15. `reminder-create-pause-revoke`
16. `account-export-download`
17. `sign-out-private-cleanup`
18. `account-erasure`
19. `erasure-status-after-session-revocation`

Use synthetic accounts and synthetic nutrition/health values only. Never put a
name, email address, device identifier, token, cookie, export contents, health
sample, or other secret/personal identifier in these JSON files.

### `diary-pagination` observation boundary

For `diary-pagination`, prepare one synthetic day with more than one 20-entry
page and entries in breakfast, lunch, dinner, and snacks. On every client,
confirm that each expected immutable entry identity appears exactly once after
all pages load; the displayed loaded count reaches the repeated authoritative
`totalEntries`; and the repeated whole-day totals are identical on every page
and agree with the complete synthetic day rather than only the loaded entries.

Before all pages load, a meal group with no loaded row must not be presented as
an authoritative empty group. Mutate the day after receiving a continuation
token and confirm the client discards the partial page set and restarts from the
first page on the typed stale response. Switch dates while a request is pending
and confirm no entry, total, empty state, or mutation action from the previous
date is rendered or applied to the new date.

Exercise load-more progress, busy/error/retry state, group labels, and date
switching with keyboard plus a browser screen reader, VoiceOver on the physical
iOS build, and TalkBack on the physical Android build. Preserve the underlying
review observations outside Git. The capture envelope records only the minimal
ordered pass assertion; it does not contain diary values or accessibility
transcripts.

Version 1 had 18 flows and did not cover this boundary. Its reports, review
packages, captures, and source-bundle digest domain are historical only and are
rejected by the current normalizer and release verifier. Never append a result
to v1, relabel v1 bytes as v2, or infer a v2 pass from earlier evidence.

## Capture envelopes

Create a mode `0700` review directory. Preserve the original reviewer-observed
material outside Git, then transcribe only the minimal pass assertions below
into three distinct current-user-owned regular files at absolute normalized
paths. Each file must be mode `0600`, non-symlink, strict UTF-8 JSON, and use the
exact `nutrition-tracker-p0-client-smoke-capture-v2` envelope:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-capture-v2",
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

Supply all 19 result objects in the exact inventory order. Observation times
must be monotonic. `capturedAt` must equal the final observation. For `ios` and
`android`, `testedEasBuildId` is the distinct physical-device EAS build UUID;
for `browser`, it is exactly `null`. All captures bind the same commit and the
exact private `.ts.net` HTTPS API origin exercised. This does not invent or bind
a browser deployment origin.

Create a fourth current-user-owned mode `0600` index with exact schema
`nutrition-tracker-p0-client-smoke-review-package-v2`:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-review-package-v2",
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

The warning on stderr is mandatory. The normalizer does not execute any flow,
inspect a user interface, or interpret the protected observations. It only
validates the exact v2 envelopes and ordered structural pass assertions, hashes
the exact raw bytes for each capture, and derives `sourceCaptureBundleSha256`
with a fixed domain-separated `browser`, `ios`, `android` order. Its structural
`passed` values remain unauthenticated assertions.

The independent reviewer must obtain the protected raw captures from the
review source, compare their exact bytes and SHA-256 values with the candidate,
verify the synthetic-only workflow observations and physical EAS build IDs,
and rerun the normalizer from those exact files. The reviewer then puts
`p0ClientSmoke.apiOrigin` and the exact candidate `reportSha256` into the v5
health-release manifest and signs the full canonical manifest with the trusted
Ed25519 review key. Only the repository health verifier's successful validation
of that signed manifest and candidate is authoritative release evidence.
