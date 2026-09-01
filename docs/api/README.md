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
not implemented in this slice.

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
