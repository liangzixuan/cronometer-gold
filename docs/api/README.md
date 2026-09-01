# API Conventions

- External routes live below `/v1`; health and readiness probes are unversioned.
- Every request receives a server-generated request ID, returned in the response
  and attached to sanitized logs. Untrusted request-ID headers are ignored.
- Errors use one RFC 9457-style `application/problem+json` document with
  `type`, `title`, HTTP `status`, stable product `code`, safe `detail`,
  `requestId`, and optional structured `issues`.
- Diary create/update/delete endpoints require a UUID `Idempotency-Key`; an exact
  replay returns the original result and key reuse with changed input conflicts.
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
