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
v4 deployment attestation. It must never reuse a health-evidence key merely for
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
exact bounded report bytes. A digest string without those bytes, an unsigned
record, a self-review, or an untrusted signer cannot confirm deployment.

Initial onboarding and rotation use the same Ed25519 SPKI, bounded validity, and
reviewed-source-control rules as the health trust root, but require an
independent deployment-review role and distinct key material. Store no private
key or report in this directory. Reports may contain sensitive network-access
evidence even after redaction, so keep local/EAS files mode `0600`, place GitHub inline base64 only
in Actions secrets, and never print report bytes.
