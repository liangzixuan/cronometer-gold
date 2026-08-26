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
  --phone-ip <EXACT_PHONE_TAILSCALE_IPV4> \
  --mac-ip <EXACT_MAC_TAILSCALE_IPV4>
```

The renderer writes JSON only to stdout and never applies the policy. Do not
redirect it into the repository. It emits an empty legacy `acls` list, one
exact-IP host alias for each device, one `tcp:443` grant, no SSH or Funnel node
attributes, and positive/negative policy tests for the current listener set.

Use the complete output as a policy only for a dedicated test tailnet whose
existing policy was independently reviewed. For an existing tailnet, export and
review the complete current policy, merge the aliases/grant/tests without
removing unrelated required access, and remove every ACL or grant that also lets
this exact phone reach this Mac. Merely appending the narrow grant to a default
allow-all or other overlapping rule is unsafe. The admin console must accept all
policy tests before incoming connections are enabled. Capture the reviewed
policy hash and configuration-log event outside source control; never automate a
tailnet-wide policy replacement from this repository.

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
