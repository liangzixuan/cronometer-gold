# ADR 0015: Password-recovery boundary

- Status: Accepted for local implementation; production delivery and abuse controls blocked
- Date: 2026-09-01

## Context

ADR 0014 deliberately left password recovery open. A recovery capability can
replace the account's password and invalidate sessions, so it has a larger
blast radius than additive email verification. The public request surface also
creates account-enumeration and mail-abuse risks. This repository currently has
only an exact-loopback Mailpit adapter; it has no approved production provider,
shared limiter, durable delivery, bounce handling, or support override.

## Decision

### Public contracts

`POST /v1/auth/password-recovery/request` accepts only `{"email":"..."}`.
Every schema-valid account-dependent outcome returns exact no-store
`202 {"data":{"status":"accepted"}}`: eligible or unknown address, inactive or
deleted account, account without a password credential, target-rate
suppression, missing delivery configuration, and per-message delivery or commit
failure. The response does not echo the address or claim mail was sent. Schema
failures may return
`400 VALIDATION_ERROR`; only a target-independent missing API service may return
generic `503`.

`POST /v1/auth/password-recovery/confirm` accepts only a canonical token and
`newPassword`. Exact success is no-store
`200 {"data":{"passwordReset":true}}`; it creates no session. A well-formed
unknown, superseded, consumed, email-stale, inactive, deleted, or otherwise
ineligible action returns `400 PASSWORD_RECOVERY_TOKEN_INVALID`. An exact,
unused, current-email-bound action whose expiry is still identifiable returns
`410 PASSWORD_RECOVERY_TOKEN_EXPIRED`. Malformed bodies remain ordinary
`400 VALIDATION_ERROR`; bounded confirmation capacity can return `429` and a
target-independent dependency failure can return `503`.

### Capability and persistence

- Generate 32 random bytes and encode canonical unpadded base64url. The token is
  exactly 43 characters and matches
  `^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`.
- Persist only SHA-256 token and normalized-current-email digests. Never persist
  or log the raw token or link.
- Use a one-hour lifetime and one current `password_recovery` action per account.
  Migration 0009 extends the existing `auth_action_token` purpose constraint;
  it does not create a second credential table.
- A process-local fixed window counts every normalized target, including unknown
  addresses. Suppression retains the exact accepted response and is never reset
  by target eligibility.

Issuance takes the token-digest transaction fence, finds only an active,
non-deleted password account, locks the account, rechecks the current-email
digest, and holds that lock across bounded loopback SMTP delivery. The new
digest is promoted only after Mailpit returns the post-DATA `250` acceptance.
Failure before acceptance rolls back and preserves the prior action. Concurrent
resends serialize delivery and promotion order. SMTP acceptance and database
commit are not a distributed transaction: a failure after acceptance can leave
one unusable message while the prior action remains. Evidence records this
ambiguity rather than claiming to solve it.

Confirmation hashes the new password with a fresh 16-byte salt and the existing
bounded scrypt parameters before taking database locks. It then takes the token
fence, discovers the candidate without locking it, locks the active account
first, and locks the exact action. It rechecks purpose, unused state,
current-email digest, expiry, and password credential. After those locks, the
database selects one exact microsecond completion instant as the greater of its
clock and the caller's validated instant. That same database value governs
expiry, consumption, verification, revocation, and audit time. In one
transaction it:

1. replaces the password verifier;
2. consumes the recovery action;
3. marks the current email verified, because possession of the digest-bound
   delivered capability proves control of that current address;
4. invalidates any outstanding email-verification action;
5. revokes every unrevoked session and every unconsumed reauthentication proof;
6. appends one `auth.password_recovery.completed` security audit event.

Registration session issuance carries its freshly created password verifier;
login session issuance and reauthentication-proof issuance carry the exact
verifier used by their password check. Their write transactions lock the active
account before the credential and reject a changed verifier as a generic
credential failure. Password work begun before recovery
therefore either commits before the reset and is revoked by it, or fails after
the reset; it cannot mint new authority from the old password afterward.

The audit has no actor and contains only the subject/entity, request ID,
verification transition, `passwordChanged: true`, and purpose. It contains no
email, token, digest, password, salt, verifier, parameters, session identifier,
source address, or user agent. Recovery does not reactivate accounts, cancel
pending erasure, change an email, auto-login, or create a support bypass.

### Browser and mobile boundary

Mail links use only `/reset-password#token=...`. A nonce-authorized
before-interactive browser bootstrap captures and removes the fragment from the
visible history entry before navigation or password controls appear. The token
lives only in an ephemeral in-memory submission closure—not a query, path,
router state, React state, DOM, storage, analytics event, log, audit, or export.
It is destroyed after success, invalidity, or expiry and retained only for a
bounded retryable unavailable result.

The same-origin web BFF enforces trusted mutation origin, a hard streamed 1 KiB
request limit, a hard streamed 4 KiB upstream-response limit, exact upstream
status/body contracts, and `no-store`. The browser independently streams at
most 4 KiB from the BFF; declared and chunked overflow are cancelled.
`pagehide` destroys the capability, and a back/forward-cache restoration stays
fail closed unless a new fragment is supplied. Successful confirmation clears
the local session cookie so the user must sign in again. Mobile independently
caps the request response at 4 KiB and exposes only the public
request/check-mail flow; the external browser owns confirmation. No application
deep link, native token storage, signing action, or background recovery is
introduced.

### Deployment and production block

Rollout order is migration, API, web, then mobile. Existing login,
registration, and unverified-account access remain unchanged. The checked-in
delivery implementation is exact `127.0.0.1:1025` Mailpit in non-production,
with a separate exact-loopback `PASSWORD_RECOVERY_PUBLIC_ORIGIN`.

The local request contract proves status/body/header anti-enumeration, not
production-grade timing indistinguishability: synchronous SMTP remains a
target-dependent timing channel. Production recovery remains blocked until
reviewers approve shared source and target abuse controls, asynchronous durable
delivery or provider idempotency without plaintext capability persistence,
timing-distribution evidence, authenticated TLS provider/sender/domain,
retry/suppression/bounce operations, monitoring, legal copy, support procedures,
and accessibility evidence.

## Consequences

- A successful reset also verifies the current email and logs out every client.
- Unknown targets receive a useful but intentionally noncommittal response.
- Local Mailpit evidence cannot authorize a public mail provider or beta host.
- Existing export exclusion and account-erasure deletion for
  `auth_action_token` and password material continue to apply.
- Password history and composition rules are not introduced; the existing
  12–128 Unicode-code-point and 512-byte boundary remains authoritative.

## Alternatives rejected

- Returning target-specific not-found, disabled, rate, or delivery errors would
  disclose account eligibility.
- Storing plaintext tokens for an outbox would expand the recovery capability's
  at-rest exposure.
- Auto-login after reset would undermine explicit all-session revocation.
- A native deep link would add an unreviewed cross-application capability
  boundary.
- Keeping recovery and verification unrelated after successful delivery would
  discard equivalent proof of current-email control.

## Review triggers

Revisit this ADR before enabling production delivery, changing token lifetime or
password policy, adding shared/provider infrastructure, allowing email changes
or support recovery, enforcing verification, introducing native deep links, or
changing recovery retention/audit policy.
