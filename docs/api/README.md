# API Conventions

- External routes live below `/v1`; health and readiness probes are unversioned.
- Every request receives a server-generated request ID, returned in the response
  and attached to sanitized logs. Untrusted request-ID headers are ignored.
- Errors use one RFC 9457-style `application/problem+json` document with
  `type`, `title`, HTTP `status`, stable product `code`, safe `detail`,
  `requestId`, and optional structured `issues`.
- Diary create/update/delete endpoints require a UUID `Idempotency-Key`; an exact
  replay returns the original result and key reuse with changed input conflicts.
- A native public-food create may opt into the atomic profile-time-zone
  precondition only by sending both
  `profileTimeZonePrecondition=v1` and
  `X-Expected-Profile-Time-Zone`. Either signal alone is invalid. A first
  delivery whose canonical profile zone changed returns
  `409 DIARY_TIME_ZONE_CHANGED` without a diary write; an exact stored replay is
  returned before that comparison. Requests with neither signal preserve the
  legacy digest and behavior. The query marker makes rollout fail closed because
  pre-feature servers reject it; backend convergence precedes guarded clients.
- Recipe create/revise/log and goal create/revise endpoints use the same
  digest-bound idempotency rule. Recipe and goal revisions also require a quoted,
  strong `If-Match` root revision; a diary recipe log additionally pins the exact
  `recipeVersionId` selected by the client.
- Entry and profile edits use one quoted, strong revision `If-Match` value. Entry
  preconditions are independent of unrelated day changes.
- Timestamps are RFC 3339 UTC instants; diary grouping also stores the user's
  effective IANA time zone and local date.
- Legacy `GET /v1/diary?date=` reads remain complete and are capped at 50
  entries and 256 distinct nutrients. Diary clients opt into bounded pages with
  `limit=1..20` and an optional opaque `cursor`; a cursor without its bound
  limit is invalid. A labeled page contains at most 20 entries plus
  `page.totalEntries` and `page.nextCursor`, while `data.totals` remains the
  authoritative whole-day aggregate on every page. Pagination does not raise
  the 50-entry write or aggregation cap.
- Diary continuations use authenticated encryption and bind the owner, date,
  limit, day revision, effective profile time zone, and exact continuation
  position. Malformed, tampered, or cross-binding tokens are generic validation
  failures. A valid continuation after the day or effective time zone changes
  returns `409 DIARY_PAGE_STALE`; clients discard accumulated pages and restart
  from page one.
- Cursor pagination uses stable ordering and opaque cursors. Page-number APIs are
  reserved for bounded administrative datasets.
- ETags may cache public/versioned food records. Private diary or biometric
  responses are never shared-cacheable.
- Authorization is object-level. A valid access token does not imply permission
  to another user's food, recipe, diary, report, export, or integration.

## Email verification

`POST /v1/auth/email-verification/request` is authenticated, accepts no body,
and returns exact no-store `202 {"data":{"status":"accepted"}}` for a committed
new request and an already verified account. It never sends automatically during
registration. A five-attempt process-local fixed window bounds requests
independently of password login. The account lock serializes concurrent resends;
the previous capability is replaced only after SMTP DATA acceptance and database
commit. Configuration, pre-acceptance delivery, or transaction failure returns
`503` and preserves the previous active action. Shared limiting remains required.
A token-hash transaction fence makes a confirmation arriving after SMTP
acceptance wait until issuance commits or rolls back.

`POST /v1/auth/email-verification/confirm` is public and accepts only
`{"token":"<43-character-base64url>"}`. The token is a 256-bit bearer
capability; only its SHA-256 digest is persisted. Confirmation returns no session
and atomically consumes the action while setting the current active account's
verification timestamp. Success is exact `200 {"data":{"verified":true}}`.
A well-formed unknown, superseded, consumed, changed-email, deleted, or inactive
token returns `400 EMAIL_VERIFICATION_TOKEN_INVALID`; a still-identifiable,
unused expired token returns `410 EMAIL_VERIFICATION_TOKEN_EXPIRED`. Neither
failure distinguishes an account identity, and responses are no-store.
A structurally invalid or noncanonical body instead returns the ordinary closed-
schema `400 VALIDATION_ERROR` contract.

Browser links use `/verify-email#token=...`. The fragment is removed from browser
history by an early bootstrap before interactive navigation and before the
same-origin BFF submits it; scrub failure aborts submission. The token never
appears in an HTTP request target, query string, server-rendered URL, persistent
browser storage, ordinary request log, audit row, or privacy export. Native
clients refresh verification status after external-browser completion; there is
no native deep-link contract in this slice.

The source delivery adapter permits only exact `127.0.0.1` Mailpit SMTP in
non-production. Production delivery is unavailable until a provider, sender,
domain, TLS/authentication, shared request/confirmation abuse controls,
transactional delivery/idempotency, retry/suppression, and legal-copy review is
accepted. Verification remains additive and non-enforcing; password recovery is
independent until a recovery action succeeds.

## Password recovery

`POST /v1/auth/password-recovery/request` is public and accepts only
`{"email":"..."}`. Every schema-valid target-dependent result returns exact
no-store `202 {"data":{"status":"accepted"}}`, including an unknown, inactive,
deleted, ineligible, rate-suppressed, delivery-unconfigured, or
delivery/commit-failed target. The response does not echo the address or claim
mail was sent. The process-local five-attempt
fixed window counts known and unknown normalized addresses alike; public
production use still requires shared source and target controls.

An eligible request creates a one-hour, 256-bit capability bound to the active
password account's current normalized-email digest. Only token and email
SHA-256 digests are stored. The account lock spans bounded Mailpit delivery and
promotes a replacement only after SMTP acceptance, preserving the prior action
on pre-acceptance failure and serializing concurrent resends. The existing
post-acceptance/database-commit ambiguity remains explicit.

`POST /v1/auth/password-recovery/confirm` accepts only
`{"token":"<43-character-base64url>","newPassword":"..."}`. Exact success is
`200 {"data":{"passwordReset":true}}` and creates no session. One atomic
transaction rotates the password with a fresh salt/current bounded scrypt
parameters, consumes the action, verifies the bound current email, invalidates
its outstanding verification action, revokes every unrevoked session and every
unconsumed reauthentication proof, and appends a redacted audit. The database
selects one exact post-lock microsecond completion instant for expiry and every
successful transition. Registration session writes carry the freshly created
verifier; login session and reauthentication-proof writes carry the verifier
they checked. All lock the account then require that exact value, so work begun
with the old password cannot mint authority after the reset. Invalid/replayed/
superseded/stale/inactive actions return
`400 PASSWORD_RECOVERY_TOKEN_INVALID`; an identifiable unused expiry returns
`410 PASSWORD_RECOVERY_TOKEN_EXPIRED`.

Browser links use `/reset-password#token=...`; a nonce-authorized early
bootstrap scrubs the fragment before exposing controls and keeps the capability
only in an ephemeral submission closure. The same-origin BFF streams at most 1
KiB of request and 4 KiB of upstream response; the browser independently
streams at most 4 KiB from the BFF, and overflow is cancelled. `pagehide`
destroys the capability and back/forward-cache restoration stays fail closed
without a new fragment. Successful confirmation clears the local session
cookie. Mobile independently caps the request response at 4 KiB, requests mail
only, and finishes in the external browser; it has no recovery deep link or
token storage. Exact-loopback Mailpit proves the local path, not production
timing resistance or delivery readiness. The full boundary and production
blockers are in ADR 0015.

## Hydration

The hydration surface is authenticated and owner-scoped. Every response is
private and sends `Cache-Control: no-store`.

`GET /v1/hydration?date=YYYY-MM-DD` returns `200 {"data": HydrationDay}` with
ordered active entries, their exact integer milliliters, an exact
`totalMilliliters`, and a strong
`"h-<43-character-SHA-256-base64url>"` ETag over the exact canonical
`HydrationDayResponse`. The day `revision` remains a synchronization token; it is
not reconstructed as the HTTP ETag. A date with no persisted hydration returns
an empty revision-zero day rather than an invented entry or target. The day-level
`timeZone` is the profile's current canonical IANA zone; every immutable entry
separately retains the zone used to derive that
revision's `localDate` and `localTime` from its finite RFC 3339 `occurredAt`.
Clients never submit local coordinates.

`POST /v1/hydration/entries` requires a UUID `Idempotency-Key` and exactly
`{"amountMilliliters": integer, "occurredAt": RFC3339}`. A first application
returns 201 and an exact replay returns 200 with `data.replayed: true`; both carry
the recorded response entry revision's strong ETag. A create may use the profile-time-zone
race guard only by pairing `profileTimeZonePrecondition=v1` with
`X-Expected-Profile-Time-Zone`. Either signal alone is invalid. An exact replay
wins before the current-zone comparison; a new request after the zone changed
returns `409 HYDRATION_TIME_ZONE_CHANGED` without a write.

`PATCH /v1/hydration/entries/:entryId` requires a UUID `Idempotency-Key`, the
current strong entry revision in `If-Match`, and a nonempty closed-schema subset
of `amountMilliliters` and `occurredAt`. An amount-only correction preserves the
stored instant, local coordinates, and effective time zone. A change to
`occurredAt` derives new coordinates with the current profile zone and may
atomically move the entry between profile-local days. The response is 200 with
the new entry ETag. Current web and mobile clients expose only amount correction;
time editing remains open client work even though the private API supports it.

`DELETE /v1/hydration/entries/:entryId` requires the same headers, accepts no
body, creates an immutable logical-delete revision, and returns 200 with
`data.entry: null` and no ETag. Every mutation returns one or two
`data.affectedDays` revision tokens and records a digest-bound result so reuse of
an operation UUID with different method, target, precondition, or body conflicts.

Amounts are exact integers from 1 through 20,000 mL. A profile-local day permits
at most 64 active entries and 100,000 total mL. These are query, overflow, and
abuse bounds—not intake targets, recommendations, or warnings. Hydration never
changes food, nutrient, energy, recipe, diary, or goal calculations, and this
contract has no reminder, offline/background queue, or device-ingestion path.

A missing or malformed idempotency key, malformed `If-Match`, malformed body, or
unpaired time-zone guard is 400. A missing `If-Match` is 428, an owned-entry miss
is 404, idempotency or guarded-time-zone conflict is 409, a stale revision is
412, and an entry/day operational-bound violation is 422. Authentication and
service-readiness errors retain the shared 401 and 503 contracts.

## Recipes and goals

The authenticated recipe surface is `GET|POST /v1/recipes`,
`GET /v1/recipes/:recipeId`, `POST /v1/recipes/:recipeId/revisions`, and
`POST /v1/recipes/:recipeId/log`. Recipe lists use a bounded opaque cursor. A
recipe revision resolves every ingredient to an immutable food or nested-recipe
version, records final yield and the identity-retention assumption, and returns
reason-counted nutrient coverage plus transitive source attribution.

The authenticated goal surface is `GET /v1/goals/current?date=`,
`POST /v1/goals`, `POST /v1/goals/:goalId/revisions`, and
`GET /v1/goals/progress?date=`. `GET /v1/nutrients/targetable` exposes only the
active, explicitly targetable non-energy ontology. Goal revisions preserve their
root effective interval. Progress returns exact amounts only for complete,
trace-free evidence; otherwise each amount and percentage is labeled as a known
lower bound. Derived energy snapshots retain the reviewed equation, profile
inputs, explicit PAL category/factor, source URLs, and general-wellness notice.

All recipe, goal, targetable-nutrient, and diary responses are private and send
`Cache-Control: no-store`. Legacy diary ETags retain the day revision; paged
diary ETags hash the exact response representation because authenticated cursor
nonces make separately generated page bodies byte-distinct.
