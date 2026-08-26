# Reviewer trust roots

## Signed-device reviewer trust

`health-release-reviewers.json` is the production trust root for the external
physical-device evidence gate. Its reviewer list is intentionally empty until a
genuinely independent reviewer public key is onboarded through a reviewed code
change. The release-evidence and submission gates therefore fail closed today;
the repository operator must not add their own key or invent a replacement
principal merely to clear the milestone.

The v4 evidence manifest separates binaries by role. `artifacts.physicalDevice`
contains the exact internally distributed iOS IPA and Android APK whose EAS
build IDs appear in the physical-device rows. `artifacts.production` contains
the exact store-distribution iOS IPA and Android AAB considered for release.
Every artifact records its platform, exact `physical-device` or `production`
profile, artifact type, EAS build ID, SHA-256, source commit, source-controlled
native build number or version code, and signing-identity SHA-256. All four
source commits must equal the manifest commit; the internal and production
native versions must match for each platform; and every EAS build ID, expected
digest, normalized absolute path, actual digest, and available filesystem
`dev`/`ino` identity must be pairwise distinct. Paths are checked with `lstat`,
so symbolic links are not artifacts. The reviewer signature covers the complete
artifact/device matrix and `physicalDeviceApiRelay`, which pins the exact
private `.ts.net` API origin and the SHA-256 of its independently reviewed relay
report. The signed `appVersion` must equal `app.json`, and every signed native
build version must equal the explicitly confirmed values in both `app.json` and
`release-numbering.json`; unconfirmed identifier history fails closed. Same-source production artifacts are release
provenance, not a claim that the internal binaries and store binaries are
byte-equivalent.

The portable verifier does not extract the EAS build ID, source commit, native
version, or signing certificate from IPA/APK/AAB internals. Before signing, the
independent reviewer must compare those claims with authoritative EAS build
metadata and platform signing-tool output. The reviewer must likewise prove that
both physical-device build records used the exact signed
`physicalDeviceApiRelay.apiOrigin` in the EAS `preview` environment; URL-shape
validation does not establish the value embedded in an already-built binary.
Missing that independent comparison is an operational release blocker; a
digest-shaped signing identity is not by itself proof of the signer.

Validation also requires the exact downloaded binaries and EAS build IDs to be
pinned outside the manifest:

- `NUTRITION_IOS_PHYSICAL_DEVICE_ARTIFACT_PATH` and
  `NUTRITION_IOS_PHYSICAL_DEVICE_BUILD_ID`
- `NUTRITION_ANDROID_PHYSICAL_DEVICE_ARTIFACT_PATH` and
  `NUTRITION_ANDROID_PHYSICAL_DEVICE_BUILD_ID`
- `NUTRITION_IOS_PRODUCTION_ARTIFACT_PATH` and
  `NUTRITION_IOS_PRODUCTION_BUILD_ID`
- `NUTRITION_ANDROID_PRODUCTION_ARTIFACT_PATH` and
  `NUTRITION_ANDROID_PRODUCTION_BUILD_ID`

The private API origin is independently pinned as
`NUTRITION_PHYSICAL_DEVICE_API_ORIGIN`; it must byte-match the signed canonical
`https://<machine>.<tailnet>.ts.net` origin. Supply the exact canonical relay
report through exactly one of
`NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64` or a normalized absolute
mode-`0600` `.json` path in `NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH`.
The path is opened once with no-follow/nonblocking flags, must be owned by the
current operator, and is read through a 64-KiB bound. Its signed digest and
strict v1 schema bind first-connect Shields Up, empty initial Serve/Funnel,
incoming access held until policy tests pass, revalidated identities, the one
foreground Serve session, exact TCP/443-to-`127.0.0.1:4000` graph, disabled
Funnel, one reviewed two-phone policy/configuration event, listener inventory,
both alias/build-bound probes, negative-access checks, and timed attended
teardown/disconnect. The verifier parses those claims rather than accepting an
opaque digest.

The manifest JSON itself and its exact SHA-256 are supplied as
`NUTRITION_HEALTH_RELEASE_EVIDENCE_JSON` and
`NUTRITION_HEALTH_RELEASE_EVIDENCE_SHA256`. The device operator and reviewer
must be different principals. The manifest bytes themselves must be canonical
JSON. The reviewer signs every manifest field, including the attestation key ID
and algorithm; only `reviewerAttestation.signatureBase64` is excluded from its
own signed payload. Private keys and unsigned or synthetic "passed" manifests
must never be created by ordinary CI or stored here.

Ordinary mobile configuration checks validate both reviewer trust stores even
when release numbering or deployment evidence is still blocked. Every active,
expired, or future entry must have exact fields, a canonical nonempty validity
interval, and a canonical Ed25519 SPKI public key. Key IDs and public-key
material are unique across both stores as well as within each store; rotation
requires a new ID and a new keypair. Empty stores remain structurally valid so
the intentional release blocker is distinguishable from malformed trust.

Initial onboarding and later key rotation are reviewed code changes. Confirm the
reviewer is independent of the device operator and repository release operator,
then add their Ed25519 SPKI public key with a non-overlapping key ID and bounded
validity interval. Obtain independent approval, and remove an old key only after
every manifest signed during its validity window has expired. Never store a
private key, test result, health sample, device identifier, cursor, token, or
signature fixture in this folder. The v4 release manifest is signed outside
ordinary CI and pins the physical IPA, physical APK, production IPA, and
production AAB digests and EAS build IDs to one Git commit, one reviewed private
API origin, and one exact relay-report digest. v3 manifests fail closed and must
be recollected and re-signed; relay state is never inferred during migration.

## Deployment reviewer trust

`release-deployment-reviewers.json` is a separate trust root for the external
v6 deployment attestation. It must never reuse a health-evidence key merely for
convenience. Its reviewer list is intentionally empty, so `release:check`, EAS
production compilation, and reviewed submission remain blocked until a genuinely
independent deployment reviewer is onboarded through a reviewed code change.
Do not add a repository, deployment, or device operator's key and do not invent a
replacement identity.

The deployment reviewer signs canonical JSON containing the complete confirmed
platform, API origin, release commit, six digest-qualified service images,
deployment-operator principal (`deployedBy`), exact external-HTTPS and
reviewer-access report SHA-256 values, reviewer principal, review time, reviewer
key ID, and algorithm; only `signatureBase64` is outside its own signed payload.
`deployedBy` and `reviewedBy` must be different principals under a
case-insensitive comparison. The verifier additionally reads and hashes the
exact bounded report bytes, then requires their canonical structured schemas to
cross-bind the origin, commit, fresh TLS/readiness result, access-policy digest,
and probe results. The reviewer-access v2 report carries the independent
reviewer's redacted assertion of `IPv4`, one network,
`globally-routable-unicast`, and prefix length `32`, plus their assertion that the
sensitive policy artifact was unchanged during the probes. It contains no source
address or CIDR. The release verifier checks the exact assertion, canonical
report bytes, digest binding, and deployment signature; it cannot derive the
address's routability or inspect the live policy from redacted data. Version-5
deployment records, reviewer-access v1 reports, and opaque result-only reports
fail closed. A digest string without valid report bytes, an unsigned record, a
self-review, or an untrusted signer cannot confirm deployment.

### Reviewer-access collection and signing contract

The independent deployment reviewer must collect the v2 assertion from the live
system; a deployment operator's summary is not sufficient:

1. In a private review record, name the exact effective Caddy/provider
   access-policy artifact and its read-only export source, then fetch it directly.
   If multiple enforcement layers can allow the app, include every named layer in
   that artifact. Keep the artifact mode `0600` outside the repository and report.
2. Obtain the expected reviewer source independently and normalize it to canonical
   dotted-decimal IPv4. Inspect the complete artifact and confirm that the only
   app-allow source is that address with prefix length `32`, that it is globally
   routable unicast, and that no second, broader, IPv6, wildcard, proxy, private,
   reserved, documentation, link-local, or multicast app-allow source exists.
3. Parse the named JSON artifact with duplicate keys rejected and serialize it as
   UTF-8 `canonicalJson` (Unicode code-point object-key order, array order
   preserved, no whitespace or trailing newline). A screenshot, hand-written
   summary, non-JSON export, or hash supplied by the operator is not acceptable.
   Compute lowercase SHA-256 over those exact bytes before either probe and use it
   as `accessPolicySha256`.
4. Run the approved-source `GET /ready` check and the unapproved-source blocked-
   connectivity check. Immediately re-fetch the same named live artifact through
   the same read-only source, parse and canonicalize it identically, and compute
   SHA-256 again. Any retrieval, parsing, inspection, or digest mismatch fails the
   review.
5. Only after the two digests match may the reviewer set the exact redacted
   `accessPolicyShape`, set `policyUnchangedDuringProbes` to `passed`, finalize the
   canonical reviewer-access report, bind its exact SHA-256 in
   `reviewerAccessEvidenceSha256`, and sign the v6 deployment record. The actual
   source address and sensitive policy artifact remain only in the private review
   record, never in the report, deployment record, repository, CI output, or EAS
   input.

Initial onboarding and rotation use the same Ed25519 SPKI, bounded validity, and
reviewed-source-control rules as the health trust root, but require an
independent deployment-review role and distinct key material. Store no private
key or report in this directory. Reports may contain sensitive network-access
evidence even after redaction, so keep local/EAS files mode `0600`; path input is
accepted only through one owner-checked, no-follow bounded descriptor read.
Place GitHub inline base64 only in Actions secrets, and never print report bytes.
