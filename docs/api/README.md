# API Conventions

- External routes live below `/v1`; health and readiness probes are unversioned.
- Every request receives a server-generated request ID, returned in the response
  and attached to sanitized logs. Untrusted request-ID headers are ignored.
- Errors use one RFC 9457-style `application/problem+json` document with
  `type`, `title`, HTTP `status`, stable product `code`, safe `detail`,
  `requestId`, and optional structured `issues`.
- Diary create/update/delete endpoints require a UUID `Idempotency-Key`; an exact
  replay returns the original result and key reuse with changed input conflicts.
- Entry and profile edits use one quoted, strong revision `If-Match` value. Entry
  preconditions are independent of unrelated day changes.
- Timestamps are RFC 3339 UTC instants; diary grouping also stores the user's
  effective IANA time zone and local date.
- The beta diary-day representation is non-paginated and therefore capped at 50
  entries and 256 distinct nutrients to bound database work and client memory.
- Cursor pagination uses stable ordering and opaque cursors. Page-number APIs are
  reserved for bounded administrative datasets.
- ETags may cache public/versioned food records. Private diary or biometric
  responses are never shared-cacheable.
- Authorization is object-level. A valid access token does not imply permission
  to another user's food, recipe, diary, report, export, or integration.
