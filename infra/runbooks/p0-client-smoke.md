# Synthetic P0 client-smoke review package

This procedure records the same synthetic-data-only P0 workflow on a browser,
a physical iOS EAS build, and a physical Android EAS build against one exact
private HTTPS API origin. The normalizer is deliberately read-only: it does not
run a client, invoke Tailscale or EAS, or prove that an assertion happened. It
does not authenticate a capture. It only checks a reviewer-prepared package
structurally.

The resulting `nutrition-tracker-p0-client-smoke-report-v3` is an unsigned
candidate with this exact trust marker:

`unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review`

It is not release evidence by itself. An independent reviewer must reconcile
the preserved raw observations, rerun the normalizer, and sign a health-release
manifest that binds the candidate's exact SHA-256 digest.

## Exact inventory

Use exactly three distinct capture files, one for each role: `browser`, `ios`,
and `android`. The browser must exercise these 21 flows in this exact order:

1. `unauthenticated-entry`
2. `register`
3. `sign-in`
4. `session-restore`
5. `unauthorized-session-rejection`
6. `food-search`
7. `diary-add-edit-delete`
8. `diary-repeat`
9. `diary-pagination`
10. `diary-group-configuration`
11. `recipe-create-revise-log`
12. `goal-create-revise-progress`
13. `retention-trends`
14. `custom-food-create-revise-log`
15. `diary-day-note`
16. `biometric-create-edit-delete`
17. `reminder-create-pause-revoke`
18. `account-export-download`
19. `sign-out-private-cleanup`
20. `account-erasure`
21. `erasure-status-after-session-revocation`

iOS and Android each insert `camera-barcode-capture` immediately after
`food-search`, for exactly 22 results per native role. No browser camera result,
optional result or `not-applicable` outcome is accepted. All 19 original IDs keep
their relative order; the added work occurs before export, cleanup and erasure.
Browser typed-barcode lookup remains within `food-search`.

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

### Added v3 observation boundaries

For native `camera-barcode-capture`, exercise permission grant, temporary and
permanent denial with manual fallback; unavailable/cancel/background teardown;
one lookup across repeated detections; EAN-8/EAN-13/UPC-A/ITF-14 behavior; invalid
check digit, no match and network errors; typed-lookup parity and explicit
confirmation before the existing mutation. Verify no microphone prompt, frame
retention/upload, background capture, on-disk barcode persistence or widening of
the durable diary envelope. Preserve physical VoiceOver/TalkBack observations.

For `diary-group-configuration`, all roles rename and reorder the four groups,
keep canonical destinations and native queued delivery unchanged, show coherent picker
and receipt labels, converge after cross-client profile refresh, reset defaults
and surface stale-profile conflicts without overwriting them. Include keyboard,
browser screen-reader, VoiceOver and TalkBack observations for the applicable role.

For `diary-day-note`, all roles exercise empty and populated day create/edit/
clear/rewrite, exact raw text and limits, explicit Save/Clear and unchanged-draft
behavior, original-date Return/Cancel and truthful loading/unavailability. Check
exact ambiguous retry across date navigation and same-owner zone refresh,
deliberate Keep/Use recovery and focus, stale/private/background fences, and
unchanged food/nutrient state. Observe the disclosure that unsaved drafts and
unresolved keys belong to the open diary only; no offline or crash-safe note
persistence is promised. Preserve each role's keyboard/assistive observations.

The later export, sign-out/private-cleanup and erasure flows must include those
synthetic notes and retained history under the 68-family contract. Raw notes,
barcodes, export contents and accessibility transcripts stay in the protected
review material, never in the minimal JSON assertion envelopes.

### Historical versions

Version 1 had 18 flows and omitted diary pagination. Version 2 had the original
19 common flows and omitted camera capture, configurable groups and standalone
day notes. Those captures, packages, reports, source-bundle digest domains and
old signed health manifests retain their historical meaning and are rejected by
the current contract. Do not append new assertions, relabel bytes, reinterpret a
signature or combine generations. Collect one complete new v3 package and obtain
independent health-manifest v6 review. [ADR 0077](../../docs/adr/0077-role-specific-p0-evidence.md)
defines the coordinated successor without changing earlier release obligations.

## Capture envelopes

Create a mode `0700` review directory. Preserve the original reviewer-observed
material outside Git, then transcribe only the minimal pass assertions below
into three distinct current-user-owned regular files at absolute normalized
paths. Each file must be mode `0600`, non-symlink, strict UTF-8 JSON, and use the
exact `nutrition-tracker-p0-client-smoke-capture-v3` envelope:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-capture-v3",
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

Supply exactly 21 browser or 22 native result objects in the role's inventory
order. Within each capture, `observedAt` values must be non-decreasing: equal
timestamps are allowed. Every observation must fall within the inclusive
`startedAt`–`executedAt` interval; an earlier-than-start, backward or
after-execution observation is rejected. `capturedAt` must equal the final
observation. For `ios` and `android`, `testedEasBuildId` is the distinct
physical-device EAS build UUID;
for `browser`, it is exactly `null`. All captures bind the same commit and the
exact private `.ts.net` HTTPS API origin exercised. This does not invent or bind
a browser deployment origin.

Create a fourth current-user-owned mode `0600` index with exact schema
`nutrition-tracker-p0-client-smoke-review-package-v3`:

```json
{
  "schemaVersion": "nutrition-tracker-p0-client-smoke-review-package-v3",
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

This describes the existing v3 timing behavior; it does not tighten the parser.
Do not infer that authentic captures are absent. Requiring strictly increasing
timestamps would need a future reviewed contract decision.

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
validates the exact v3 envelopes and ordered structural pass assertions, hashes
the exact raw bytes for each capture, and derives `sourceCaptureBundleSha256`
with the `nutrition-tracker-p0-client-smoke-source-capture-bundle-v3`
domain and fixed `browser`, `ios`, `android` order. Its structural
`passed` values remain unauthenticated assertions.

The independent reviewer must obtain the protected raw captures from the
review source, compare their exact bytes and SHA-256 values with the candidate,
verify the synthetic-only workflow observations and physical EAS build IDs,
and rerun the normalizer from those exact files. The reviewer then puts
`p0ClientSmoke.apiOrigin` and the exact candidate `reportSha256` into the v6
health-release manifest and signs the full canonical manifest with the trusted
Ed25519 review key. Only the repository health verifier's successful validation
of that signed manifest and candidate is authoritative release evidence.

## Local contract checks

Run `pnpm test:smoke:contracts` from the repository root for the Python
normalizer suite (`python3 -B -m unittest infra.smoke.tests.test_p0_client_smoke`).
The push/PR quality workflow runs the same suite. These synthetic parser checks
do not collect captures or establish device/release acceptance.
