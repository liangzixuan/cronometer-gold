# Release Gates

No environment is promoted because a date arrived. A release needs evidence for
every applicable gate and an owner who records the decision.

## Every pull request

- Formatting, lint, workspace-boundary, type, and unit checks pass.
- Every checked-in food-source candidate/example compiles under the strict
  JSON Schema gate, agrees with the ingestion runtime parser, and remains an
  intentionally non-import-ready template.
- No committed secret or unreviewed high/critical production dependency advisory.
- Production dependency licenses are on the approved permissive allowlist or
  have a version-bounded exception in `config/license-policy.json` linked to
  `THIRD_PARTY_NOTICES.md`.
- Migrations are forward-only, transactional where PostgreSQL permits it, and
  include a recovery note.
- Runtime readiness fails closed when the database migration ledger is missing a
  bundled migration or its SHA-256 disagrees; connectivity alone is not schema
  readiness.
- Logs and telemetry contain no food diary, biometric, token, or free-text note
  payload.
- Authentication action capabilities have at least 256 bits of randomness; only
  fixed-size digests are persisted, raw capabilities never enter logs, audit
  state, server-visible request-target URLs, query strings, persistent browser
  storage, or exports. A reviewed fragment-only client bootstrap is the sole
  email-verification transport exception and must scrub before interaction or
  submission. Account erasure reconciles capability deletion.

The AST workspace-boundary check is a fast convention guard, not a security
sandbox. It detects direct forbidden imports and direct environment/network
global access; review still rejects alias-based or computed attempts to bypass
package boundaries.

## Food-data release

- Source manifest has URL, release identifier, retrieval timestamp, checksum,
  rights classification, attribution, and reviewer.
- Import from the pinned raw artifact is deterministic and reports accepted,
  rejected, quarantined, and missing-nutrient counts.
- A source cannot publish directly into the active catalogue. Staging, validation,
  three-role digest-bound approval, atomic activation, and pointer-only rollback
  are proven by the PostgreSQL integration gate, including an unchanged historical
  diary nutrient snapshot.
- The product renders unknown, trace, imputed, and label-rounded values distinctly.

## Local retention privacy drill

After the guarded local dependencies are healthy and migrations are current, run:

```sh
pnpm retention:privacy-drill
```

Before parsing, the command opens `.env` without following symbolic links and
requires an owner-only, single-link regular file. Those file values take
precedence without expansion for the whole drill. A no-I/O preflight accepts
only the matching synthetic loopback PostgreSQL, MinIO, and Meilisearch Compose
targets. Each `pnpm` role child receives an exact allowlisted
environment-variable projection: build receives no service secrets, artifact
checks receive only split artifact principals, and the retention flow receives
the API read, worker write, restore-only, scoped search, scoped index-mutation,
and task-observer principals it needs. MinIO root and the Meilisearch master key
are not projected into those role children. The master key is used only by the
scoped-key bootstrap; only the distinct search, mutation, and task-observer keys
reach the retention test. Known
artifact-admin, cloud, registry, signing, and private-key environment variables
are likewise removed at the role-child launch boundary.

The trusted retention-drill `dotenv-cli` loader and orchestrator retain the
complete ambient plus `.env` environment for the duration of that local command
so they can validate the fixture and perform the in-process scoped-key
bootstrap. The drill projection guarantee begins only when that orchestrator
launches a `pnpm` role child; it is not an isolation claim about the loader or
orchestrator processes. The guarded development launcher is narrower: its
trusted process opens the owner-only `.env` with `O_NOFOLLOW`, validates and
reads that one descriptor without expansion, closes it before launch, and then
retains the parsed bootstrap authority. Its full-graph `pnpm` child receives
only the union of reviewed API, worker, web, and mobile runtime fields. The
API-only child receives exactly the API fields and scoped search key, never the
worker mutation/admin key or worker task-observer fields.

Both guarded development profiles reject non-loopback API, PostgreSQL,
Meilisearch, and object-store targets before scoped-key bootstrap. The full
graph binds Next.js to `127.0.0.1` and runs Expo with `--localhost`; it is not a
physical-phone, LAN, Tailscale, or public exposure path. The launcher and Expo
wrapper own isolated child groups and perform bounded signal forwarding and
reaping. A device-accessible mode remains a separate reviewed and explicitly
approved future path.

This environment projection is a process-launch policy, not a filesystem or
credential sandbox. Runtime support variables such as `HOME` remain available,
and every child still runs as the same operating-system user. It may therefore
read same-user file-backed credentials, CLI caches, agents, or configuration
that are reachable through the filesystem even when their environment-variable
pointers were removed. Use a dedicated clean user, container, or equivalent
filesystem isolation when evidence must prove those files were inaccessible;
this drill proves only the documented environment projection and local service
targets.

The flow creates the same closeable API application runtime used by the server
entrypoint without opening a listener, proves the exact readiness response, and
runs two bounded polls through the same combined search/retention worker runtime
used by the worker entrypoint. It is never a cloud, public-hosting,
physical-phone, or production-data command. The drill deletes its export
artifacts and scratch database schema, but intentionally retains the immutable
encrypted erasure-ledger tombstone as local recovery evidence.

## Controlled beta

- API, worker, migrator, web, Caddy, PostgreSQL, and the patched Meilisearch
  derivative are repository-built `linux/arm64` images from the release commit,
  pass the fail-closed HIGH/CRITICAL vulnerability gate, carry SBOM and
  provenance attestations, and are deployed by recorded digest. The signed
  upstream Meilisearch lock is non-deployable build provenance; its identity and
  signature gate must pass before the derivative service matrix starts, as described in
  [the container supply-chain runbook](./container-supply-chain.md).
- The reviewer-signed deployment record binds distinct exact canonical reports,
  not opaque result hashes. The external report proves fresh public-chain,
  hostname, certificate-lifetime, and exact `/ready` routing for the signed
  origin/commit. The access report carries the independent reviewer's signed
  assertion that the sensitive live policy contained exactly one globally
  routable unicast IPv4 `/32`, plus the canonical policy-artifact digest claimed
  unchanged across approved-readiness and blocked-unapproved-source probes. The
  redacted report stores neither source address; the verifier validates the exact
  assertion and signature but cannot derive routability from the redacted data.
- Every profile, diary, biometric, report, and integration route enforces a
  server-side session/ownership check; unauthenticated and cross-user access
  tests fail closed.
- Authenticated web routes use a nonce- or hash-based Content Security Policy;
  the foundation shell's temporary `script-src 'unsafe-inline'` policy is not a
  sufficient XSS boundary for personal data.
- At least 1,000 reviewed query-country relevance cases pass the agreed top-five
  threshold, with a 200-case set running on every ranking change.
- Each launch market has a stratified sample of at least 1,000 known GTINs; exact
  match is at least 85%, with the Wilson lower bound at least 82%.
- Core generic foods meet the agreed nutrient-completeness definition at least
  90% of the time.
- The bounded native public-food create outbox proves a 50-item encrypted,
  owner-bound FIFO; persist-before-send and exact idempotent replay across every
  slot/manifest crash boundary; one foreground request; selected-day
  time-zone preconditions; terminal-head review; corruption/overflow failure;
  and retryable sign-out, unauthorized, and erasure cleanup with no duplicate
  diary entry.
- General offline mutation retry/reorder acceptance still covers supported
  edits, deletes, repeats, recipes, custom foods, manual reorder, and cross-client
  convergence; the create-only outbox does not satisfy that broader gate.
- Email verification proves digest-only token storage, current-email binding,
  prior-link preservation on pre-acceptance delivery failure, concurrent resend
  ordering, acceptance-to-commit confirmation fencing, expiry, atomic one-time
  confirmation, redacted audit, erasure, safe browser-fragment removal, and
  cross-client status behavior. It preserves exact
  `400 EMAIL_VERIFICATION_TOKEN_INVALID` and
  `410 EMAIL_VERIFICATION_TOKEN_EXPIRED` semantics. Exact-loopback Mailpit is
  local evidence only, and SMTP-accepted/database-failed ambiguity is recorded
  rather than hidden. Controlled beta additionally requires shared request and
  public-confirmation capacity controls, an approved authenticated TLS mail
  provider and sender/domain, transactional delivery/idempotency,
  retry/suppression operations, accessibility review, and an explicit decision
  about unverified-account access.
- Password recovery proves exact status/body/header response equivalence for
  eligible and unknown targets at the real API/Mailpit boundary. Separate tests
  cover fail-closed suppression, missing-delivery configuration, and delivery
  failure; it does not claim timing indistinguishability or unproven
  inactive/deleted/post-delivery commit-failure equivalence. Separate tests also
  prove digest-only/current-email-bound storage; previous-link preservation; resend
  ordering; confirmation fencing; one-hour expiry; supersession; replay
  rejection; and exactly one concurrent winner. Success proves a fresh-salt
  password rotation using the reviewed bounded parameters, current-email
  verification, outstanding-verification invalidation, atomic revocation of all
  unrevoked sessions and unconsumed reauthentication proofs, no new session,
  old-password rejection, new-password login, and a redacted
  audit/export/erasure boundary. Registration/login session issuance and
  reauthentication-proof issuance prove exact-verifier fencing under account-
  then-credential locks. Confirmation proves one exact post-lock database
  completion instant across expiry, consumption, verification, revocation, and
  audit, including same-millisecond concurrency.
  It preserves exact `400 PASSWORD_RECOVERY_TOKEN_INVALID` and
  `410 PASSWORD_RECOVERY_TOKEN_EXPIRED`, early browser-fragment scrubbing, hard
  streamed BFF/browser/mobile byte caps with overflow cancellation,
  redirect refusal for every web recovery browser request and BFF upstream hop,
  `pagehide` disposal, fail-closed back/forward-cache restoration, and the
  web-request/mobile-check-mail cross-client boundary. Exact-loopback
  Mailpit is local evidence only. Controlled beta additionally requires shared
  source and target abuse controls, timing-enumeration review, asynchronous
  durable delivery or provider idempotency without plaintext token persistence,
  authenticated TLS provider/sender/domain, retry/suppression/bounce operations,
  monitoring, legal and support procedures, accessibility evidence, and an
  explicit verification-enforcement rollout. Native redirect behavior remains
  a signed-device transport-review blocker; raw recovery capabilities and new
  passwords never enter the mobile path.
- Recipe revisions preserve exact food/nested-recipe dependencies, reject cycles
  and depth overflow, and retain source attribution plus trace/unknown coverage
  through an exact diary log.
- Recipe and goal retries reuse the same operation ID and canonical request;
  ambiguous responses, concurrent revisions, and profile changes cannot create a
  duplicate or silently select a newer version.
- Derived energy targets reproduce the reviewed Mifflin–St Jeor and PAL golden
  cases, fail closed outside the supported adult/profile boundary, identify
  every input and source, and never add ordinary exercise twice.
- Goal progress proves lower-bound semantics with incomplete nutrient panels and
  never labels an unknown contribution as measured zero or exact completion.
- Diary client acceptance exercises a synthetic multi-page day spanning
  breakfast, lunch, dinner, and snacks on browser, physical iOS, and physical
  Android. Every immutable entry appears exactly once; repeated `totalEntries`
  and whole-day totals remain authoritative across pages; a mutation between
  pages produces a typed stale restart; and a pending date switch cannot render
  or mutate the previous day. Partially loaded groups never claim a false empty
  state. Reviewer-preserved evidence covers keyboard plus a browser screen
  reader, VoiceOver, and TalkBack load-more, progress, error/retry, group, and
  date-switch behavior.
- Export, account deletion, backup restore, and search reindex drills pass.
- Signed internal Android APK and iOS IPA binaries compile from one clean commit
  and pass the physical-device matrix. A reviewer-signed manifest separately
  binds the exact production Android AAB and iOS IPA from that commit by EAS
  build ID, native version, signing identity, and SHA-256; same-source binaries
  are not presumed byte-equivalent. All four paths, actual digests, and available
  filesystem identities are distinct, with symbolic links rejected. The
  manifest app version and both platforms' native build versions exactly match
  the source-controlled app config and confirmed release-numbering record;
  unconfirmed package-identifier history cannot clear signed-device evidence.
  The
  independent reviewer compares claimed build/signing metadata with EAS and
  platform-tool output because archive hashing alone does not extract it; a
  Metro export is not native evidence.
- Every signed EAS binary is produced by the pinned Expo project on the EAS
  cloud runner. Post-install checks reject absent or malformed build IDs,
  platforms, profiles, and commit hashes before invoking a release script; a
  local EAS build cannot substitute for this provenance.
- The signed physical-device manifest pins the exact private `.ts.net` API
  origin and exact canonical relay-report bytes. That report proves incoming
  access remained disabled until the reviewed policy and identity gates passed,
  empty initial Serve/Funnel, foreground Serve on HTTPS/443 to
  `127.0.0.1:4000`, Funnel disabled, one tested two-phone policy with no
  overlapping grant, both alias/EAS-build-bound `/ready` probes, all inventoried
  non-443 listeners blocked, separate unapproved-tailnet and LAN-boundary denial,
  and timed clean teardown/disconnect. A generic public HTTPS URL or opaque
  report hash does not clear this gate.
- Browser and installed-device smoke tests render, navigate, and exercise the
  authenticated and unauthenticated states of every P0 client flow with
  synthetic data, including the v2 `diary-pagination` flow. The canonical
  unsigned candidate must bind the exact commit,
  private API origin, physical iOS/Android EAS build IDs, timing, ordered flow
  results, and protected source-capture hashes. It clears the gate only when an
  independent reviewer reconciles the raw captures, reruns the normalizer, and
  signs the candidate's exact digest in the v5 health manifest.
- Store identifiers, icons, splash assets, signing ownership, and disclosure
  contact are approved before the first TestFlight/Play upload.
- VoiceOver, TalkBack, keyboard, reduced-motion, and contrast reviews cover every
  P0 flow.
- A dietitian/scientific reviewer signs the equation, DRI, unit, and claims set;
  counsel signs the selected food-data and privacy model.
