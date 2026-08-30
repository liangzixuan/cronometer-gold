# Relay review-package v1 reference

> **Legacy macOS-only reference — never use on Windows or WSL2.**
>
> **HISTORICAL RECORD — NON-EXECUTABLE AND NON-RELEASE-COMPATIBLE.**
>
> Do not use this file with current tooling or execute it as a workflow. It is
> coupled to `nutrition-tracker-mac`, `/usr/sbin/lsof`, removed CLI arguments,
> the historical v1 role map, and relay report v2. The implemented offline
> Windows framework accepts review-package v2 and emits report v4, but its
> production adapter registry remains empty and live use remains blocked. The
> current mobile verifier accepts v4 only and explicitly rejects v2 and v3. Never
> rename, translate, supplement, or reuse v1 bytes as v2; there is no migration
> or compatibility path.

This is the historical transcription reference for
`nutrition-tracker-tailscale-relay-review-package-v1`. It is deliberately
Markdown, not an accepted capture or index, and it cannot produce current
release evidence. Every placeholder remains invalid. Do not populate,
normalize, sign, or submit this package.

The retired v1 normalizer checked structure only; the current normalizer does
not read this schema. The material below is preserved solely to interpret
archived evidence. It describes a v4-manifest/v2-report path that is
incompatible with the current v5-manifest/v4-report gate.

## Review-package index

The mode-`0600` index has these exact fields. Paths must be distinct,
normalized absolute paths to the 18 mode-`0600` capture files listed below.
The placeholders intentionally fail validation.

```json
{
  "schemaVersion": "nutrition-tracker-tailscale-relay-review-package-v1",
  "trustBoundary": "unsigned-structural-candidate-requires-independent-ed25519-manifest-review",
  "apiOrigin": "<canonical-private-https-origin>",
  "startedAt": "<canonical-utc-instant-with-milliseconds>",
  "executedAt": "<canonical-utc-instant-with-milliseconds>",
  "completedAt": "<canonical-utc-instant-with-milliseconds>",
  "buildIds": {
    "ios": "<lowercase-eas-build-uuid>",
    "android": "<different-lowercase-eas-build-uuid>"
  },
  "captures": {
    "preflightShields": "/INVALID/preflight-shields.json",
    "preflightServe": "/INVALID/preflight-serve.json",
    "preflightFunnel": "/INVALID/preflight-funnel.json",
    "preflightIdentities": "/INVALID/preflight-identities.json",
    "accessTimeline": "/INVALID/access-timeline.json",
    "activeShields": "/INVALID/active-shields.json",
    "activeServe": "/INVALID/active-serve.json",
    "activeFunnel": "/INVALID/active-funnel.json",
    "activeIdentities": "/INVALID/active-identities.json",
    "policy": "/INVALID/full-policy.json",
    "configurationEvent": "/INVALID/configuration-event.json",
    "listenerSnapshot": "/INVALID/listeners.lsof-fpn",
    "iosProbe": "/INVALID/ios-probe.json",
    "androidProbe": "/INVALID/android-probe.json",
    "teardownServe": "/INVALID/teardown-serve.json",
    "teardownFunnel": "/INVALID/teardown-funnel.json",
    "teardownShields": "/INVALID/teardown-shields.json",
    "teardownDisconnect": "/INVALID/teardown-identities.json"
  }
}
```

## Exact role map

Each JSON capture has exactly `schemaVersion`, `capturedAt`, and the payload
fields named below. `capturedAt` is always a canonical UTC instant with exactly
milliseconds. Preserve the corresponding raw source beside the envelope; the
normalizer does not read or authenticate that separate raw file.

| Capture role | Exact schema or raw format | Exact payload fields | Raw source and reviewer reconciliation |
| --- | --- | --- | --- |
| `preflightShields` | `nutrition-tracker-tailscale-preflight-shields-capture-v1` | `shieldsUp`, `firstConnection` | Compare `shieldsUp` with the pinned client's Shields Up output. Set `firstConnection` only after independently verifying the Mac's initial enrollment was performed with incoming connections blocked. Both must be `true`. |
| `preflightServe` | `nutrition-tracker-tailscale-serve-capture-v1` | `persistent`, `foreground` | Transcribe the preflight Serve status. Persistent maps and `foreground` must be empty. |
| `preflightFunnel` | `nutrition-tracker-tailscale-funnel-capture-v1` | `persistent`, `foreground` | Transcribe the preflight Funnel status. Persistent maps and `foreground` must be empty. |
| `preflightIdentities` | `nutrition-tracker-tailscale-identities-capture-v1` | `devices` | Reconcile the full status/whois output to the exact Mac, iOS phone, and Android phone records. All three must be connected. |
| `accessTimeline` | `nutrition-tracker-tailscale-access-timeline-capture-v1` | `policyAppliedAt`, `policyTestsPassedAt`, `identitiesRevalidatedAt`, `incomingEnabledAt`, `shieldsUpBeforePolicy`, `policyTestsResult`, `unapprovedPeerHttps443`, `policySha256`, `configurationLogEventSha256`, `activeShieldsSha256`, `activeIdentityStatusSha256`, `listenerSnapshotSha256`, `listenerCapturedAt`, `iosProbeSha256`, `androidProbeSha256` | Build from the reviewer event ledger, policy-test result, blocked unapproved-peer probe, and exact hashes of the named files. `capturedAt` equals `incomingEnabledAt`. |
| `activeShields` | `nutrition-tracker-tailscale-active-shields-capture-v1` | `shieldsUp` | Compare with the active Shields Up output after policy tests and identity review. It must be `false`. |
| `activeServe` | `nutrition-tracker-tailscale-serve-capture-v1` | `persistent`, `foreground` | Transcribe active Serve status. Persistent maps stay empty and `foreground` is the one exact private HTTPS route. |
| `activeFunnel` | `nutrition-tracker-tailscale-funnel-capture-v1` | `persistent`, `foreground` | Transcribe active Funnel status. Persistent maps stay empty; `foreground` is empty or repeats the exact private Serve route. |
| `activeIdentities` | `nutrition-tracker-tailscale-identities-capture-v1` | `devices` | Reconcile status/whois again. All three records must exactly match preflight and remain connected. |
| `policy` | Complete policy JSON, without an envelope | Exact full policy object | Export the complete dedicated-tailnet policy. Do not extract only the grant. It must exactly equal the renderer's two-phone policy for the captured listener set. |
| `configurationEvent` | `nutrition-tracker-tailscale-configuration-event-capture-v1` | `eventId`, `eventType`, `outcome`, `policySha256` | Reconcile the full configuration-log entry. Use `eventType` `policy-update`, `outcome` `applied`, its event time as `capturedAt`, and the exact policy-file hash. |
| `listenerSnapshot` | Raw UTF-8 `lsof -Fpn` bytes, without an envelope | Not applicable | Preserve the reviewed preflight TCP-listener command stdout verbatim. It must contain the required loopback services and no TCP/443 listener. |
| `iosProbe` | `nutrition-tracker-tailscale-ios-probe-capture-v1` | `platform`, `phoneAlias`, `testedEasBuildId`, `nodeId`, `tailscaleIpv4`, `apiOrigin`, `publicCaAndHostname`, `readyHttpStatus`, `openTcpPorts`, `blockedTcpPorts`, `tailscaleDisabledHttps`, `policySha256`, `configurationLogEventSha256` | Reconcile the physical iOS export to phone 1 and the exact signed IPA build. Preserve the raw export and network-probe output. |
| `androidProbe` | `nutrition-tracker-tailscale-android-probe-capture-v1` | Same exact fields as `iosProbe` | Reconcile the physical Android export to phone 2 and the exact signed APK build. Preserve the raw export and network-probe output. |
| `teardownServe` | `nutrition-tracker-tailscale-serve-capture-v1` | `persistent`, `foreground` | Transcribe post-Ctrl-C Serve status. Persistent maps and `foreground` must be empty. |
| `teardownFunnel` | `nutrition-tracker-tailscale-funnel-capture-v1` | `persistent`, `foreground` | Transcribe teardown Funnel status. Persistent maps and `foreground` must be empty. |
| `teardownShields` | `nutrition-tracker-tailscale-teardown-shields-capture-v1` | `shieldsUp` | Compare with teardown Shields Up output. It must be restored to `true`. |
| `teardownDisconnect` | `nutrition-tracker-tailscale-identities-capture-v1` | `devices` | Reconcile final status/whois. Device identity data must match the session and the Mac must be disconnected. |

## Shared exact shapes

Every Serve/Funnel `persistent` object is exactly:

```json
{"TCP":{},"Web":{},"Services":{},"AllowFunnel":{}}
```

An active private foreground list is exactly one object with these fields and
values; preflight and teardown use `[]`:

```json
[{"mode":"foreground","httpsPort":443,"handlerPath":"/","upstream":"http://127.0.0.1:4000","allowFunnel":false,"services":[]}]
```

Each `devices` object has exactly the aliases `nutrition-tracker-mac`,
`nutrition-tracker-phone-1`, and `nutrition-tracker-phone-2`. Every alias value
has exactly these fields:

```json
{"alias":"<exact-alias>","nodeId":"<bounded-node-id>","userPrincipal":"<bounded-principal>","tailscaleIpv4":"<canonical-100.64.0.0/10-address>","dnsName":"<private-name.tailnet.ts.net>","connected":"<boolean>"}
```

Probe results use `platform` `ios`/`android`, the platform's distinct reviewed
phone alias, exact EAS build ID, identity, origin, and shared policy/event
hashes. A passing structural candidate requires `publicCaAndHostname` `passed`,
`readyHttpStatus` `200`, `openTcpPorts` `[443]`, the complete sorted denied-port
inventory, and `tailscaleDisabledHttps` `blocked`. These words are reviewer
attestations, not facts derived by the normalizer.

## Reviewer completion

Historically, a reviewer checked raw-to-envelope mapping and compared a
canonical v2 candidate before signing a v4 health manifest. That path is
retired. The current v5 verifier rejects v2, the current normalizer rejects v1,
and this reference cannot create release evidence. Do not run current tools
against these bytes or relabel them as a newer schema.
