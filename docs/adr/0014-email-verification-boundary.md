# ADR 0014: Additive email-verification boundary

## Status

Accepted for local implementation. Verification enforcement and production
delivery remain separate release decisions.

## Context

Accounts already expose an `emailVerified` state, but no operation can establish
that state. Password registration, login, sessions, export, and erasure must keep
working while verification is introduced. Local evidence uses Mailpit on an exact
loopback boundary; it is not a production mail service and must never relay.

Email links carry a bearer capability. Putting that capability in a query string
would expose it to ordinary access logs, browser history, referrers, and upstream
proxies. Persisting the raw capability would turn a database read into immediate
account-verification authority.

## Decision

The first slice is additive and non-enforcing:

- Registration does not send mail automatically. An authenticated person
  explicitly requests or resends verification.
- A request generates 32 random bytes encoded as unpadded base64url. Only its
  SHA-256 digest is persisted. Application logs, audit state, API responses, and
  exports never contain the raw token or its digest.
- One current email-verification action row exists per account. A request opens
  a bounded transaction, takes a deterministic token-hash advisory fence, and
  locks the active account before delivery. The prior action remains current
  unless exact-loopback Mailpit accepts the new message; only then does the same
  transaction replace the digest and bind the new action to the account's
  current normalized-email digest, a 24-hour expiry, and an unused state.
  Concurrent requests therefore serialize delivery and promotion in the same
  order across API processes.
- Confirmation is public but accepts only a closed JSON body. It first takes the
  same token-hash transaction fence, so a link exposed after SMTP acceptance
  waits for issuance commit or rollback. A non-locking digest lookup then
  discovers a candidate owner; the transaction locks the active, non-deleted
  account before the exact action, rechecks the token and current-email digests,
  expiry, and unused state, then atomically sets
  `email_verified_at`, consumes the action, and appends a redacted security audit
  event.
- Unknown, superseded, consumed, changed-email, and deleted-account tokens share
  one non-enumerating invalid contract. A still-identifiable expired action has a
  typed expiry response so the holder can request another message. Exact success
  is `200 {"data":{"verified":true}}`; semantic invalidity is
  `400 EMAIL_VERIFICATION_TOKEN_INVALID`; identifiable unused expiry is
  `410 EMAIL_VERIFICATION_TOKEN_EXPIRED`. Confirmation creates no session and
  grants no new capability beyond the existing verification flag.
- Verification links use `/verify-email#token=...`. An inline browser bootstrap
  captures the fragment into ephemeral page memory and replaces the history
  entry before the interactive client can navigate or submit it. A scrub failure
  aborts confirmation. The token is never placed in a query string,
  server-rendered URL, persistent browser storage, or application state.
- Native clients may request a resend, refresh status, and rely on the browser
  link. This slice adds no application deep link, background processing, or login
  gate.
- Delivery is injected behind a narrow interface. The checked-in implementation
  permits only exact `127.0.0.1` Mailpit SMTP in non-production and uses a
  credential-free local web origin. Production and every non-loopback SMTP target
  fail closed until provider, sender, domain, TLS, authentication, retry,
  suppression, abuse, and legal-copy decisions are reviewed.
- The action row is credential material: it is excluded from privacy export,
  deleted with the account, and covered by retained-entity inventory and erasure
  reconciliation tests. Audit context contains only bounded event metadata.

The request limiter is deliberately process-local: five attempts, including
failed delivery attempts, per fixed 15-minute window beginning with the first
attempt. Shared request and confirmation abuse controls are required before
public or controlled-beta exposure.

## Consequences

Local Mailpit plus focused browser/mobile tests prove generation, delivery,
fragment handling, atomic confirmation, and erasure without creating any public
mail or phone boundary.
Existing accounts remain usable whether verified or not. A compromised database
does not disclose raw outstanding verification capabilities, although an online
attacker still needs the normal API abuse controls.

SMTP acceptance and a PostgreSQL commit cannot be one atomic operation. A rare
database failure after Mailpit's post-`DATA` acceptance can therefore leave one
new unusable message, while rollback preserves the prior current credential and
the API reports unavailability. A production design still needs a reviewed
transactional outbox or provider-idempotency boundary; this local-only adapter is
not that design.

The advisory key is a deterministic signed 64-bit projection of the full token
digest. A collision only serializes unrelated requests; every authorization
decision still rechecks the complete 256-bit digest and account invariants.

This slice does not choose whether future password recovery proves email
ownership, whether recovery marks an account verified, or when unverified access
should be restricted. Those are explicit follow-on decisions.

## Alternatives considered

- **Send automatically during registration:** deferred because it couples account
  creation to an unreviewed delivery dependency and makes delivery failure affect
  an otherwise valid session.
- **Persist the raw token or encrypt it for later resend:** rejected because a
  digest is sufficient for confirmation and materially reduces credential
  exposure. Resend creates and replaces a capability.
- **Commit the replacement before delivery or deliver outside the account
  lock:** rejected because a failed send would invalidate the prior usable link,
  and concurrent requests could deliver a superseded link last. The bounded
  loopback transaction instead preserves failure and serializes accepted mail.
- **Put the token in a query parameter:** rejected because queries routinely
  reach request logs, browser history, referrers, and intermediary telemetry.
- **Enable arbitrary SMTP from environment variables:** rejected because neither
  a production provider nor its TLS, authentication, sender-domain, abuse, retry,
  suppression, and legal boundaries have been approved.
- **Require verification for login or existing features immediately:** rejected
  because recovery, support, migration, and accessibility behavior are not yet
  implemented and reviewed.
- **Add native deep links now:** deferred until signed application identifiers,
  association files, private origins, and device tests can prove the link trust
  boundary.

## Rollout order

1. Deploy the database and API contract first, with production delivery disabled.
2. Deploy tolerant web confirmation and authenticated resend/status surfaces.
3. Deploy native resend/status and browser-completion affordances.
4. Prove exact loopback Mailpit delivery and cross-client behavior locally.
5. Review shared rate limiting and a production mail provider before enabling
   delivery outside local development.
6. Decide verification enforcement only after recovery, support, accessibility,
   and migration behavior are accepted.

## Review triggers

Review this decision before changing token entropy, canonical encoding, hashing,
TTL, single-row promotion, delivery/transaction ordering, email binding, public
failure mapping, transaction locks, audit contents, fragment bootstrap,
persistent storage, resend limits, automatic registration mail, deep links,
background work, login or feature enforcement, export treatment, or any SMTP
host, relay, provider, sender, domain, TLS, authentication, retry, or suppression
behavior.
