# Web development against an isolated hosted API

The frontend-only profile reserves `https://dev-api.nourishing.app` and serves the
Next.js application at `https://localhost:3443`, listening on `127.0.0.1`. The
reserved API is not provisioned or qualified by this source change. An unavailable
API produces the existing unavailable states; the profile never falls back to
local services or the production API.

The existing `pnpm dev` and `pnpm dev:api` commands retain their guarded Linux
loopback stack. This profile starts only Next.js and reuses the current BFF,
authentication, contracts, parsers and domain behavior. PostgreSQL, search,
workers, artifact storage and test email belong to the separately qualified
hosted development backend.

## Prerequisites

Use the exact reviewed source and frozen workspace lock. The web workspace
depends on the built `@nutrition-tracker/contracts` package. Keep the pinned
Node/package-manager policy, peer checks, release age, package integrity and
approved build scripts. The profile checks that the installed Next version
matches its exact manifest pin.

Prepare a private development HTTPS key, server certificate and public CA file
outside source. The server certificate must cover `localhost` and the loopback
addresses used for testing. Qualify browser trust separately; never disable TLS
verification. Pass only the public CA certificate as the CA argument, not its
private key. The launcher requires three distinct bounded regular files with
absolute canonical paths and no links. File permissions and actual certificate
chain/name/expiry verification remain part of host qualification.

Do not create `.env` or `.env.*` files in `apps/web` for this profile. Next loads
these files implicitly, so the launcher rejects their presence without reading
their contents. Root `.env` is neither read nor copied. Keep the dedicated
frontend checkout free of private backend material.

## Launch

After building contracts, run the explicit command with qualified absolute paths:

```text
pnpm --filter @nutrition-tracker/contracts build
pnpm dev:hosted-web --https-key <absolute-server-key> --https-cert <absolute-server-certificate> --https-ca <absolute-public-CA>
```

The command accepts no API URL override. It supplies the reserved origin, the
exact local HTTPS web origin and `hosted-development` selector. Conflicting
inherited values are rejected. Its environment includes only selected runtime
fields and frontend settings; database, storage, search and Doppler credentials
and arbitrary public variables are not forwarded. Next telemetry is disabled.
The explicit certificate inputs avoid Next's automatic certificate tool download.

The pinned Next CLI runs in the foreground Node process with its normal console
handlers. Use normal console Ctrl+C to end a manual session. A native Windows
proof must establish owned descendant completion; sending a Unix-named signal
to a Windows process from another process is not equivalent to console Ctrl+C.
Automated sessions need a reviewed bounded process owner and cleanup verification.

## Isolation and evidence

The browser continues to call same-origin BFF routes. Session, pending erasure
and erasure status cookies keep their Secure/HttpOnly policy and use a namespace
derived from the exact development API origin. Cookies from the ordinary local
profile are not forwarded to this API, and returning to the local profile does
not reuse development cookies. All upstream requests refuse redirects, including
login, logout, public food search and post-erasure capability requests.

This profile does not attest that the reserved host contains only development
data. Before actual hosted use, verify its independent account/data/credential
boundary, private infrastructure, allowed test-email recipients, resource budget,
readiness and recovery evidence. Keep development separate from production and
retain all release gates.

Linux checks establish source behavior. Synthetic HTTPS fixtures must use test
dependency injection, remain bounded on loopback and preserve TLS verification.
They establish only the requests and failure modes actually exercised. Native
Windows installation, trusted browser journeys with Ubuntu/Docker stopped,
owned-process cleanup and hosted operation independent of the PC require their
own recorded proof. Expo native identity, persisted-state isolation, transport
and personal-device acceptance are a later workstream.

See [the development workflow](development-workflow.md) and
[the October build plan](../product/build-plan.md).
