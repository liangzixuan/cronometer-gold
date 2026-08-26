# Mobile client

The development client chooses a platform-safe loopback API address when
`EXPO_PUBLIC_API_URL` is unset: Android Emulator uses `10.0.2.2:4000`, while iOS
Simulator uses `127.0.0.1:4000`. Do not put either loopback value in the shared
root `.env`, because an explicit value overrides that platform selection.

A physical phone cannot use either emulator address and must never connect to a
LocalStack port. For an attended local development session, keep the API and all
dependencies on Mac loopback and provide a separately authenticated, publicly
trusted HTTPS route whose only upstream is `127.0.0.1:4000`. Set that route as
`EXPO_PUBLIC_API_URL` only for the mobile development process. An Expo/Metro
tunnel serves the bundle and does not expose the API. The opt-in persistent
LocalStack profile changes only the API/worker artifact backend; it is not an
API ingress or release deployment.

A distributable build must provide a credential-free, non-loopback HTTPS origin
and use the release script:

```sh
EXPO_PUBLIC_API_URL="$DEPLOYED_API_ORIGIN" pnpm --filter @nutrition-tracker/mobile build:release
```

Set `DEPLOYED_API_ORIGIN` from the verified deployment output; do not use a
documentation or loopback hostname.

`release:check` performs the same configuration preflight without exporting the
native bundles. Local HTTP is supported only by the development runtime; a
release never falls back to loopback.

## Signed EAS releases

The app is linked to the personal EAS project
[`@zixuanliang/nutrition-tracker`](https://expo.dev/accounts/zixuanliang/projects/nutrition-tracker).
Run EAS commands from this directory. `eas.json` pins EAS CLI 22.0.0, Node
22.13.0, pnpm 11.19.0, source-controlled app versions, and the production store
outputs: an iOS device IPA and an Android app bundle.

The production profile deliberately contains no API placeholder. The deployment
policy pins the reviewed target platform (`azure` during the current pivot, or
`oci` for the retained legacy path). The version-6 checked-in
`config/release-deployment.json` file is permanently an unconfirmed template:
`deploymentConfirmed` remains `false` and every evidence field remains `null`.
Do not put a commit hash in that tracked file. A Git commit includes the file's
contents, so a file containing its own final commit hash would be an impossible
self-reference rather than release evidence.

After the real origin passes its release checks, create a canonical external
deployment-evidence JSON record that binds all of the following:

- the canonical HTTPS API origin and target platform;
- the exact clean Git commit deployed by the six services;
- digest-qualified `ghcr.io/liangzixuan/cronometer-gold-{api,web,worker,migrator,caddy,postgres}`
  image references with no tag fallback; and
- distinct SHA-256 digests for redacted external-HTTPS and reviewer-access
  evidence reports, the deployment-operator principal, the independent reviewer
  principal, and canonical UTC review time.

The canonical `nutrition-tracker-release-external-https-report-v1` report binds
the exact origin and service commit, a fresh observation, successful public
chain and hostname validation, the leaf-certificate digest and sufficient
expiry, and exact `GET /ready` HTTP 200 `{ "status": "ok" }` routing. The
canonical `nutrition-tracker-release-reviewer-access-report-v2` binds that same
origin and commit to one fresh, unchanged access-policy digest, the approved
source's successful readiness response, and blocked connectivity from an
unapproved source. Its exact `accessPolicyShape` is
`{"addressFamily":"IPv4","allowedNetworkCount":1,"networkScope":"globally-routable-unicast","prefixLength":32}`:
it records the independent reviewer's attestation of one public unicast IPv4
`/32` without storing the address or CIDR. The release verifier enforces that
exact signed declaration but cannot derive address classification or live-policy
contents from redacted data. Any other scope, address-family, prefix, or network
count declaration fails closed. Keep those redacted reports with the release
evidence; never put tokens, health values, reviewer identifiers, source addresses,
network CIDRs, or credentials in them. The external record uses the same schema
as the policy, sets `deploymentConfirmed` to `true`, and includes
distinct `deployedBy` and `reviewedBy` principals plus an Ed25519
`reviewerAttestation`. Their comparison is case-insensitive. The signature
covers canonical JSON for every deployment field, including both principals, the
reviewer key ID, and algorithm; only
`signatureBase64` is excluded from its own signed payload. Its key must be active
in the separate `config/release-deployment-reviewers.json` trust store and its
principal must equal `reviewedBy`.

That trust store is intentionally empty today. Production release checks remain
blocked until a genuinely independent deployment reviewer public key is
onboarded through reviewed source control. Never add the repository or deployment
operator's key and never invent a principal to clear the gate.

The signed record must use the exact checked field order, compact encoding, and
an optional single trailing newline. Supply it at release time through exactly
one of these inputs:

```sh
NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_JSON='<canonical-one-line-json>'
# or
NUTRITION_RELEASE_DEPLOYMENT_EVIDENCE_PATH="$PWD/.local-data/release/deployment-evidence.json"
```

Supply each exact redacted report independently through either one normalized,
absolute, mode-`0600` JSON file path or one canonical padded base64 byte string;
never set both forms for one report:

```sh
NUTRITION_RELEASE_EXTERNAL_HTTPS_REPORT_PATH="$PWD/.local-data/release/external-https.json"
NUTRITION_RELEASE_REVIEWER_ACCESS_REPORT_PATH="$PWD/.local-data/release/reviewer-access.json"
# CI-only alternatives use the corresponding *_REPORT_BASE64 variables.
```

The verifier opens each path once with no-follow/nonblocking flags and accepts
only current-operator-owned mode-`0600` regular files (maximum 64 KiB). It
rejects shared paths, shared filesystem identities, or metadata changes across
the bounded descriptor read. It then hashes the exact bytes, compares both
SHA-256 values to the signed record, and parses the strict canonical schemas
above. It never prints report content. In GitHub Actions the two inline base64
values are secrets, not
repository variables. In EAS, prefer protected file-secret variables whose
values are the two report paths. The signed deployment JSON may be a non-secret
variable only after confirming it contains no sensitive report content.

`.local-data` is ignored; keep the file mode `0600`. In EAS, use a protected
environment value or file variable rather than committing the record. A release
check rejects absent or dual inputs, noncanonical JSON, an untrusted or invalid
reviewer signature, missing or mismatched report bytes, evidence older than 24
hours, a dirty local tree, a deployed commit other than the actual local Git
`HEAD` or EAS Build's exact `EAS_BUILD_GIT_COMMIT_HASH`, an arbitrary image
repository, or a missing service digest. EAS archives do not contain `.git`, so
the remote post-install check deliberately uses that EAS-provided source commit
and never weakens the local clean-tree check. Only a valid external attestation
and its exact report bytes can request confirmation; a checked-in boolean or
digest-shaped string can never approve release. Version-5 deployment records,
version-1 reviewer-access reports, and opaque passed-report payloads fail closed;
collect both structured reports again and re-sign rather than inferring missing
claims.

Then create a **plaintext**, project-level
`EXPO_PUBLIC_API_URL` variable in the EAS `production` environment with that
exact value. The value is public client configuration, not a secret. A mandatory
profile-aware EAS post-install hook runs the unchanged `release:check` for the
production profile; an absent, unsafe, or mismatched origin therefore stops a
production job before native compilation. Missing and unknown profile names are
also rejected rather than receiving a permissive default.

CI reads the same public origin and nonsensitive signed deployment JSON from
GitHub repository variables; report base64 bytes come only from GitHub Actions
secrets. While identifier history is unconfirmed, CI invokes the exact numbering
check in machine mode. If numbering is confirmed first, it invokes the exact
deployment check. An expected blocker is accepted only as its dedicated exit
status plus one exact machine-readable stdout line and empty stderr; a human
message containing the blocker alongside another failure cannot pass.
Only after numbering, an independently trusted v6 attestation, and both exact
reports are present does the CI step require the real origin, verify it equals
the externally reviewed origin, and run the full release preflight and export;
it has no placeholder or bypass origin.

Before starting a paid or quota-consuming build, validate the linked profile:

```sh
eas config --platform ios --profile production
eas config --platform android --profile production
```

Do not run `eas build` until the package identifiers and existing Apple/Google
signing history have been confirmed. `config/release-numbering.json` records
that decision and remains false with null build numbers by default. The release
check requires the confirmation to be true and requires explicit
`ios.buildNumber` and `android.versionCode` values in `app.json` that exactly
match the record; implicit toolchain defaults cannot reach a signed build. The
`physical-device` post-install route enforces that numbering-only release gate
through the exact checked-in `physical-device:check` command without claiming
that the private relay is the production deployment. Ordinary `config:check`
remains usable while numbering is intentionally unconfirmed. The checked-in
health-reviewer trust list is intentionally empty until a genuinely independent
reviewer key is onboarded. Signed evidence and submission remain blocked until
then; a reviewer key is never an app-signing credential. Ordinary configuration
checks still validate every active or inactive trust entry and reject key-ID or
public-key reuse within or across the separate health and deployment reviewer
stores.

## Signed physical-device development

The `physical-device` profile is a standalone, production-like internal build
for testing the real HealthKit, Health Connect, and local-notification
integrations. It inherits the production signing source, pinned toolchain, and
local versioning, but produces an internally distributed iOS device IPA or a
directly installable Android APK. It is intentionally not an Expo development
client, so it does not depend on a Metro server after installation and includes
the same compiled HealthKit, Health Connect, and local-notification integrations
as production.
The repository-wide `requireCommit` setting also makes EAS reject an
uncommitted worktree for this profile.

Do not put the phone-facing API URL in `eas.json`, `.env`, or a build command.
Create a **plaintext**, project-level `EXPO_PUBLIC_API_URL` variable in the EAS
`preview` environment. `EXPO_PUBLIC_` values are public app configuration,
never secrets. For Mac-hosted development, use a stable Tailscale HTTPS name on
the default TLS port and keep the phone on the same tailnet. Terminate HTTPS at
that single API ingress and forward it to the Mac-loopback API. LocalStack,
Postgres, and Meilisearch must remain private server-side dependencies; never
expose their hostnames or ports to the phone or an internet tunnel. The
post-install gate rejects missing values, HTTP, loopback/IP/local targets,
credentials, paths, non-default ports, and hostnames that identify those
backing services.

Before joining the phone, follow the
[physical-device private-HTTPS runbook](../../infra/runbooks/physical-device-private-https.md).
Tailscale's initial allow-all policy is not an application firewall: apply and
test the exact phone-to-Mac `tcp:443` grant first, and audit every overlapping
ACL/grant. The checked-in renderer only proposes a deny-by-default policy for
human review; it never installs a client or mutates a tailnet.

Inspect the resolved profiles before consuming build quota:

```sh
eas config --platform ios --profile physical-device
eas config --platform android --profile physical-device
```

For iOS, the normal internal-distribution path uses ad hoc provisioning. This
profile does not request enterprise provisioning. A paid Apple Developer
Program membership is required, and each phone UDID must be registered
**before** the build and included in that build's provisioning profile:

```sh
eas device:create
eas device:list
eas build --platform ios --profile physical-device
```

Adding a phone later requires a new build or re-sign with a refreshed ad hoc
provisioning profile; a previously generated IPA does not gain the new UDID.
For non-interactive builds that reuse EAS-managed credentials, use EAS's
`--refresh-ad-hoc-provisioning-profile` option after registering the device.
Internal-build download URLs are unauthenticated by default, so require Expo
account authentication for internal distributions in the project settings and
share them only with approved testers.

For Android, the profile explicitly generates a signed APK, which can be
downloaded and installed directly after the tester approves installation from
that source:

```sh
eas build --platform android --profile physical-device
```

The APK is for internal device development only. Production remains a Play
Store AAB, which is not directly installable, and final release evidence must
still bind the exact production-signed store artifact. The internal
gate runs the confirmed-numbering, checked-in EAS, and generated-native
configuration checks plus the strict private-device HTTPS-origin check. It does
not claim that a private development API is the confirmed production deployment.
Selecting `production` still routes to the exact deployment, identifier-history,
version-number, native-health, and transport release gate; the internal profile
cannot weaken or replace that path.

## Reviewed artifact evidence and submission

The external v5 evidence manifest has four separate binary roles. The device
matrix is attached to the exact `physical-device` IPA and APK installed on the
iPhone and Android phone. The same reviewer-signed manifest separately binds the
exact production IPA and AAB, including their EAS build IDs, source commit,
native build numbers, signing-identity fingerprints, and SHA-256 digests. The
four builds must come from one clean commit and share the source-controlled
native version for each platform. The signed app version must exactly match
`app.json`; both platforms' signed native versions must match the explicitly
confirmed values in `app.json` and `config/release-numbering.json`. Unconfirmed
package-identifier history blocks this evidence verifier as well as the earlier
release preflight. Their expected digests, normalized absolute
paths, actual digests, and available filesystem identities must also be
pairwise distinct, and symbolic links are rejected. It also signs the exact
private `.ts.net` origin plus the digest of the canonical relay report that
proves first-connect containment, foreground Serve, no Funnel, exact loopback
upstream, one two-phone tailnet policy, both alias/build-bound readiness probes,
negative reachability, and timed teardown/disconnect.
It also binds the exact canonical synthetic-only P0 smoke candidate covering
the ordered browser, physical iOS, and physical Android flow inventory against
that same API origin. The candidate's `passed` assertions are not authenticated
until the independent reviewer reconciles the protected raw captures, reruns
the normalizer, and signs the complete manifest.
A matching commit does not
assert that an internal binary and a store binary are byte-equivalent.

The portable verifier deliberately does not guess EAS provenance or extract
platform signing certificates from the downloaded archives. Before signing the
manifest, the independent reviewer must compare the claimed EAS IDs, source
commits, native versions, and signing-identity fingerprints with authoritative
EAS metadata and platform signing tools. They must also compare the signed
private origin with the exact EAS `preview` environment recorded for both
physical-device builds; the verifier cannot extract that build-time value from
the archives. Until that comparison exists, release
remains operationally blocked even if every value has the right shape.

Ordinary `production` EAS compilation intentionally runs `release:check`, not
`release:health-evidence`: the latter cannot exist until the four binaries have
been produced, installed where applicable, tested, downloaded, and independently
reviewed. Before either profile runs its post-install gate, the hook requires
Expo's cloud-build markers and exact pinned project ID, canonical build ID,
platform, profile, and full Git commit; local EAS builds cannot satisfy this
release context. After those steps, supply the v5 manifest, exact relay and P0
smoke reports/origin pins, and all four absolute artifact paths/build-ID pins listed in
`config/README.md`, then verify it:

Follow [the P0 client-smoke runbook](../../infra/runbooks/p0-client-smoke.md).
The signed `p0ClientSmoke.apiOrigin` must equal the relay origin and its
`reportSha256` must bind the exact candidate bytes. Supply those bytes through
exactly one of `NUTRITION_P0_CLIENT_SMOKE_REPORT_PATH` or
`NUTRITION_P0_CLIENT_SMOKE_REPORT_BASE64`; the path form must be an absolute,
normalized, current-user-owned mode-`0600` regular file opened without following
symlinks.

```sh
pnpm release:health-evidence
```

Do not run a direct `eas submit` for a reviewed release. The checked-in wrapper
accepts only one exact production EAS build ID, reruns the deployment/numbering/
native release preflight, reruns the four-artifact evidence verifier, and invokes
EAS only if both pass:

```sh
pnpm release:submit --platform ios --id "$NUTRITION_IOS_PRODUCTION_BUILD_ID"
pnpm release:submit --platform android --id "$NUTRITION_ANDROID_PRODUCTION_BUILD_ID"
```

The wrapper strips the evidence variables before launching EAS. Keep the
downloaded IPA/APK/IPA/AAB and signed manifest outside the repository. TestFlight
and a Play internal-testing track are still required to smoke the store-delivered
production builds; the internal matrix alone is not evidence of store packaging
or store re-signing behavior.
