# Physical-device private HTTPS

This is an attended development path for the signed `physical-device` IPA and
APK. It is not public hosting, a production deployment, or a substitute for the
controlled-beta HTTPS and deployment evidence gates.

## Non-negotiable boundaries

- Install Tailscale and join devices only after explicit operator approval.
- Never use Tailscale Funnel. Serve must remain private to the tailnet.
- Keep the API on `127.0.0.1:4000`; LocalStack, PostgreSQL, Meilisearch, MinIO,
  Mailpit, Kafka, ZooKeeper, and Metro remain loopback-only or unreachable from
  the phone.
- The phone-to-Mac grant is exactly `tcp:443`. Tailscale grants are additive, so
  a narrower grant does not override an existing broad ACL or grant.
- Name.com DNS remains unchanged. Use only the reviewed `.ts.net` name.
- Do not create, print, or store a reusable Tailscale auth key for this workflow.

A new tailnet starts with a default allow-all policy. Tailscale Serve does not
hide other host listeners from an otherwise authorized peer. On this Mac,
Kafka, ZooKeeper, Java, and macOS services may listen on wildcard ports, so the
Mac's very first connection must use the installed client's reviewed equivalent
of `tailscale up --shields-up`. Do not connect normally and enable Shields Up
later: that creates an exposure window. Immediately prove
`tailscale get --json shields-up` is true before the phone joins. If the
installed client cannot establish its first connection with Shields Up already
enabled, stop and rebind every wildcard/non-loopback listener before enrollment.

Enabling Tailscale HTTPS permanently publishes the complete machine and tailnet
DNS name in Certificate Transparency logs. Rename a sensitive machine and choose
an acceptable tailnet DNS name before the first certificate is issued.

## Prepare the local services

Start the ordinary dependencies, LocalStack profile, and API. Prove that the
phone-facing API and every application dependency still use exact IPv4
loopback:

```sh
pnpm infra:up
pnpm infra:localstack:status
curl --fail --silent --show-error http://127.0.0.1:4000/ready
```

The policy renderer fails unless TCP 4000, 4566, 5432, 7700, 9000, and 9001
are each bound only to `127.0.0.1`, and TCP/443 is unused. It also inventories
every current TCP listener so Tailscale's built-in policy tests reject any
overlapping access to those ports.

## Render and review the tailnet policy

Keep incoming connections blocked while the Mac and phone first join the
tailnet. Inspect `tailscale up --help`, `tailscale set --help`, the installed
client, and the admin console before use. Record the exact, stable Tailscale
IPv4 address for each device and verify the phone identity with `tailscale
whois` immediately before applying policy.

Render the proposal locally:

```sh
python3 -B infra/tailscale/phone_policy.py \
  --phone-ip <EXACT_IOS_PHONE_TAILSCALE_IPV4> \
  --phone-ip <EXACT_ANDROID_PHONE_TAILSCALE_IPV4> \
  --mac-ip <EXACT_MAC_TAILSCALE_IPV4>
```

For attended development with only one phone, supply `--phone-ip` once. The
signed two-platform matrix requires both exact phones in the same rendered and
reviewed policy; do not swap one phone rule for another between probes because a
policy change invalidates earlier evidence.

The renderer writes JSON only to stdout and never applies the policy. Do not
redirect it into the repository. It emits an empty legacy `acls` list, one
exact-IP host alias for each supplied device, one `tcp:443` grant, no SSH or Funnel node
attributes, and positive/negative policy tests for the current listener set.

Use the complete output as a policy only for a dedicated test tailnet whose
existing policy was independently reviewed. For an existing tailnet, export and
review the complete current policy, merge the aliases/grant/tests without
removing unrelated required access, and remove every ACL or grant that also lets
this exact phone reach this Mac. Merely appending the narrow grant to a default
allow-all or other overlapping rule is unsafe. The admin console must accept all
policy tests before incoming connections are enabled. Capture the reviewed
policy hash and configuration-log event outside source control; never automate a
tailnet-wide policy replacement from this repository. A merged existing-tailnet
policy is limited to attended development and does not qualify for a normalized
release candidate: the fail-closed normalizer requires a dedicated test tailnet
whose complete policy exactly equals the generated two-phone policy, with no
unrelated ACL or grant.

Only after the reviewed policy is saved, all built-in policy tests pass, and the
phone identity is revalidated may the operator run the installed client's
reviewed equivalent of `tailscale set --shields-up=false`. Require
`tailscale get --json shields-up` to return false before the positive Serve
probe; the client preference otherwise overrides the tailnet grant and blocks
all incoming traffic.

## Configure and verify Serve

Review `tailscale serve --help` from the installed, pinned client before use.
Require both Serve and Funnel status to be empty before proceeding. For current
clients, run attended foreground private HTTPS on the default port with the sole
upstream `http://127.0.0.1:4000`:

```sh
tailscale serve --https=443 http://127.0.0.1:4000
```

Keep that terminal attached throughout testing. Do not use `--bg`; background
Serve survives an interrupted shell and can resume after client restarts.

Before building, independently require all of the following:

1. `tailscale status --json` is running and binds the reviewed Mac and phone
   identities to the exact policy IPs.
2. In `tailscale serve status --json`, the persistent top-level `TCP`, `Web`,
   `Services`, and `AllowFunnel` fields are absent or empty. `Foreground` has
   exactly one session, and that session contains only HTTPS TCP/443, one root
   handler, and the exact `http://127.0.0.1:4000` proxy. Its `AllowFunnel` and
   `Services` fields are also absent or empty.
3. `tailscale funnel status --json` may report the same foreground Serve graph;
   it must have no enabled `AllowFunnel` entry at either the top level or inside
   the sole foreground session. Do not treat non-empty JSON alone as evidence
   that Funnel is enabled.
4. The phone validates the public CA and hostname and receives exact HTTP 200
   readiness through `https://<reviewed-machine>.<reviewed-tailnet>.ts.net/ready`.
5. From the phone or another exact authorized peer, every inventoried non-443
   TCP port is unreachable. Explicitly include 22, 80, 4000, 4566, 5432, 7700,
   8025, 8080, 8081, 9000, 9001, and 9092. With Tailscale disabled on the phone,
   the HTTPS origin must also be unreachable.

Only after those checks pass may the exact canonical HTTPS origin be stored as
the plaintext project-level `EXPO_PUBLIC_API_URL` in the EAS `preview`
environment. Never place it in source, and never expose a backing-service port.

After attended testing, stop the exact foreground Serve with Ctrl-C and prove
both Serve and Funnel status are empty. Do not run a broad reset that could
erase unrelated pre-existing configuration; non-empty initial state was already
a stop condition. Restore Shields Up with the installed client's reviewed
command, require `tailscale get --json shields-up` to return true, and then
disconnect the Mac. A new listener, policy change, device re-enrollment, IP
change, or Serve change invalidates the evidence and requires the checks again.

## Prepare an unsigned review candidate

`infra/tailscale/relay_evidence.py` is a read-only structural normalizer, not an
evidence collector, authenticator, or release authority. Its `passed` and
`blocked` values mean only that the supplied review-package fields are
internally consistent. They are not authenticated observations. The normalizer
never invokes Tailscale, installs or authenticates a client, applies policy,
toggles Shields Up, starts/stops Serve or Funnel, or creates a signature.
Use the complete [relay review-package v1 reference](../tailscale/relay-review-package-v1.md)
for every exact role, envelope field, raw source, and reconciliation step; do
not infer a schema from the tests.

Before normalization, an independent trusted reviewer must preserve the exact command
stdout and physical-device probe exports in a reviewer-controlled mode-`0700`
directory with `umask 077`. Capture the relevant state with the already
installed, reviewed client; these commands are run manually by the reviewer,
never by the normalizer:

```sh
tailscale get --json shields-up > preflight-shields.raw.json
tailscale status --json > preflight-status.raw.json
tailscale serve status --json > preflight-serve.raw.json
tailscale funnel status --json > preflight-funnel.raw.json
# Repeat status, Shields Up, Serve, and Funnel captures during active testing
# and teardown, using distinct files. Preserve the full reviewed policy,
# configuration-log event, lsof -Fpn inventory, and both device probe exports.
```

Do not reconstruct raw stdout, reuse another session, or convert an observed
failure into a `passed` field. The reviewer compares every structural envelope
to its exact raw source, including both build-bound phone probe exports and the
full configuration-log event, then reruns the normalizer over the settled input
bytes immediately before signing. Raw captures remain outside the repository
and are retained with the signed review package.

The review-package index uses schema
`nutrition-tracker-tailscale-relay-review-package-v1`, contains the exact
`trustBoundary` value
`unsigned-structural-candidate-requires-independent-ed25519-manifest-review`,
and contains no reviewer identity or `reviewedAt` claim. Its remaining exact
fields are `apiOrigin`, `startedAt`, `executedAt`, `completedAt`, `buildIds`
(`ios` and `android`), and `captures`. The independent reviewer supplies
`reviewedBy` and `reviewedAt` only in the later signed health manifest. The
`captures` map contains these exact absolute paths:

- `preflightShields`, `preflightServe`, `preflightFunnel`, and
  `preflightIdentities`;
- `accessTimeline`, `activeShields`, `activeServe`, `activeFunnel`, and
  `activeIdentities`;
- `policy`, `configurationEvent`, and the raw bounded `listenerSnapshot` from
  the already reviewed `lsof -Fpn` inventory;
- `iosProbe` and `androidProbe`; and
- `teardownServe`, `teardownFunnel`, `teardownShields`, and
  `teardownDisconnect`.

The index and every input must be a distinct current-user-owned regular file,
mode `0600`, within its byte bound, and readable with no-follow semantics. All
paths are absolute and normalized. A symlink, duplicate inode, special file,
duplicate JSON key, floating/non-finite number, changed file, missing field, or
extra field is rejected. JSON observation envelopes use the exact
`nutrition-tracker-tailscale-<kind>-capture-v1` schema declared by the
normalizer. Preserve sensitive Tailscale IPs, node IDs, and principals only in
these protected inputs. The identity envelopes bind the exact Mac, iOS, and
Android alias/node/principal/IP/private-DNS tuples at preflight, active testing,
and disconnect; the API origin must equal the reviewed Mac DNS identity. The
full `policy` capture is the complete reviewed policy JSON,
not a selected rule: the normalizer reconstructs the two-phone policy from the
identity and listener captures and rejects a default allow, extra ACL/grant,
missing negative test, or any overlap. The access timeline binds the policy
and configuration-event byte hashes and structurally requires Shields Up to
remain enabled until policy tests and identity revalidation completed.

Serve/Funnel observation envelopes must preserve exact empty-object `{}` values
for persistent `TCP`, `Web`, `Services`, and `AllowFunnel`; arrays are rejected.
The active Serve foreground list
must contain exactly one `foreground` HTTPS/443 root handler to
`http://127.0.0.1:4000`, with `allowFunnel: false` and no services; the active
Funnel observation may repeat that graph or have an empty foreground list.
Preflight and teardown foreground lists must be empty. The two build-bound phone probes
must bind their distinct EAS build IDs and exact identities to the
same policy/configuration event, public-CA hostname success, `/ready` HTTP 200,
only open TCP/443, every inventoried denied port blocked, and HTTPS blocked with
Tailscale disabled.

The v2 candidate includes the exact unsigned trust-boundary marker and
`sourceCaptureBundleSha256`, plus the index's exact `executedAt`. That digest
domain-separates
`nutrition-tracker-tailscale-relay-source-capture-bundle-v1` and hashes, in the
exact role order listed above, each role name plus the SHA-256 of its complete
input bytes. It therefore binds all 18 normalized inputs, including both probe
captures, without copying sensitive source content into the candidate.

From the repository root, emit the canonical redacted unsigned structural candidate into
an ignored, private location. The command writes only canonical
`nutrition-tracker-physical-device-relay-report-v2` bytes to stdout and a fixed
unsigned-candidate warning to stderr; rejection never writes partial candidate
bytes:

```sh
(umask 077; python3 -B infra/tailscale/relay_evidence.py \
  --capture-index /absolute/review/capture-index.json \
  --acknowledge-unsigned-candidate \
  > /absolute/ignored/.local-data/release/physical-device-relay-report.json)
```

Confirm the resulting candidate is current-user-owned mode `0600`. Never point the
index at source-control files, and never use a capture from another attended
session. The resulting candidate remains outside the repository and records the
exact `.ts.net` origin and session start/execution/completion times. Preflight fields
and source-capture digests structurally record first-connect Shields Up, initially empty
Serve/Funnel, incoming access held until policy tests passed, and revalidated
Mac/iPhone/Android identities. The active fields bind the foreground Serve
graph, disabled Funnel, exact two-phone aliases, one full-policy/configuration
event digest shared by both build probes, complete non-443 listener inventory,
CA and `/ready` success, TCP/443-only results, blocked ports, and off-tailnet
denial. Teardown fields and source digests structurally record empty Serve/Funnel, restored
Shields Up, and Mac disconnect. The verifier requires
`startedAt <= executedAt <= completedAt <= reviewedAt`, requires candidate
`executedAt` to equal the independently signed manifest's `executedAt` exactly,
and allows a session no longer than 24 hours.

Keep the candidate owned by the current operator and mode `0600` in ignored
`.local-data/release`, or supply its exact bytes later as secret base64. Do not
include raw status/configuration output,
Tailscale IPs, node IDs, user identities, auth keys, tokens, health payloads, or
device identifiers in the normalized candidate; retain any sensitive source
captures only in the independently controlled review location. The candidate
alone is rejected as release authority. Only after the independent reviewer
checks every exact source byte may they sign the complete v4 health manifest;
that trusted Ed25519 signature binds the candidate's exact SHA-256 digest,
trust-boundary marker, and all-18 source bundle digest.

At release verification, set
`NUTRITION_PHYSICAL_DEVICE_API_ORIGIN` to the exact origin and provide exactly one
of `NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_PATH` or
`NUTRITION_PHYSICAL_DEVICE_RELAY_REPORT_BASE64`. The signed
`physicalDeviceApiRelay.reportSha256` must match the exact report bytes. Never
reuse the production `EXPO_PUBLIC_API_URL` as this pin: the production and
private-device builds intentionally use different origins.
