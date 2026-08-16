# ADR 0005: Authenticated diary and session boundary

- Status: Accepted
- Date: 2026-08-15
- Owners: Application, data, and security engineering

## Context

A food diary contains sensitive health-adjacent data. The first write-capable
vertical slice therefore needs a real identity boundary, object ownership,
retry-safe mutations, stable local-day behavior, and reproducible nutrition. A
client-generated identifier alone is neither authentication nor authorization.
Likewise, editing one mutable diary row would silently destroy the facts from
which an earlier total was calculated.

## Decision

1. The initial first-party identity adapter supports normalized email/password
   accounts and revocable opaque sessions. Password derivation uses a versioned,
   bounded scrypt profile with an independent random salt. The database stores
   the derived value and parameters, never the password.
2. A session token contains at least 256 bits of cryptographic randomness. Only
   its SHA-256 digest is stored. Logout revokes the server-side row. Expiry,
   disabled-account state, and pending deletion are checked on every private
   request.
3. Browser code never reads the bearer token. A same-origin web adapter stores it
   in a Secure, HttpOnly, SameSite cookie and applies an origin check to cookie-
   authenticated mutations. Native clients store it in the platform secure
   credential store. Tokens, passwords, diary payloads, and free-text notes are
   excluded from logs and analytics.
4. Every profile and diary query starts with the authenticated user ID and
   enforces ownership in PostgreSQL. A guessed object ID never grants access;
   cross-user and absent objects share the same public not-found behavior.
5. `diary_entry` is a user-owned logical identity. Create, content edit, meal/time
   move, and deletion append immutable numbered revisions and advance one current
   pointer. Deletion is a tombstone revision; earlier nutrient snapshots remain
   intact until a controlled privacy-erasure workflow removes the account.
6. Every retryable diary mutation has a caller-generated operation ID. PostgreSQL binds
   `(user, operation ID)` to a canonical request digest and immutable result. An
   exact replay returns the original result; reuse with different input is a
   conflict. Entry edits and deletes additionally compare the current entry
   revision, while unrelated changes elsewhere in the day do not cause a false
   conflict.
7. The stored profile IANA time zone and the supplied RFC 3339 instant determine
   local date and time. The caller cannot assign an entry to an arbitrary diary
   date. Moving an instant across a local-day boundary advances both affected day
   revisions atomically.
8. Logging resolves the selected serving to grams, scales the exact immutable food
   version, and stores a relational nutrient aggregate vector with engine version
   and source provenance in the same transaction. Missing nutrients are explicit
   unknown contributions; trace and quantified zero remain distinct. Reports sum
   current non-tombstone snapshots and expose coverage, never a fabricated zero.
9. Private responses are `Cache-Control: no-store`. Authentication failures are
   generic, password work is concurrency-bounded, and mutation schemas are closed
   and size-bounded.

## Consequences

- Food-source changes affect future logging but cannot rewrite an existing diary
  revision.
- Session and revision rows add storage and write amplification in exchange for
  revocation, supportability, auditability, and retry-safe diary mutations.
- Password recovery, email verification delivery, social login, passkeys, and
  enterprise identity remain separate capabilities. A managed identity provider
  can replace the adapter without changing user ownership or diary semantics.
- Changing a profile time zone affects the derivation of future mutations. It
  does not silently regroup historical revisions.
- Durable offline queues and cross-restart mutation replay remain a later client
  synchronization capability; this slice preserves one operation ID across
  in-session network retries.

## Rejected alternatives

- A caller-supplied user header or development token is not authentication.
- Long-lived self-contained bearer tokens cannot be revoked promptly without a
  second server-side state mechanism.
- Browser local storage exposes bearer tokens to any successful script injection.
- Updating nutrient snapshots in place destroys historical reproducibility.
- Trusting a client-provided diary date fails around travel, midnight, and daylight
  saving transitions.

## Review triggers

- A production identity vendor, passkeys, federated login, or account linking is
  selected.
- Shared households, coaches, or delegated access require an explicit grant model.
- Offline edits evolve from retry safety into multi-device conflict resolution.
- Retention, legal hold, or clinical workflows alter the privacy-erasure boundary.
