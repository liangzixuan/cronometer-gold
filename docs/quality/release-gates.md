# Release Gates

No environment is promoted because a date arrived. A release needs evidence for
every applicable gate and an owner who records the decision.

Source-work priority does not change gate applicability. A gate may interrupt
the user-visible roadmap only when it names the affected release decision or
demonstrated defect, an owner, and a testable exit condition; otherwise it stays
queued without being weakened or silently reclassified.

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

## Food-data activation gate

- Source manifest has URL, release identifier, retrieval timestamp, checksum,
  rights classification, attribution, and reviewer.
- Two distinct authenticated-acquisition sidecars agree on the fresh HTTPS
  artifact and reviewed runner source, and one receipt from a separate storage
  workload records externally verified evidence of conditional no-overwrite
  creation, service SHA-256, and retention active when its receipt was recorded at
  the content-addressed object URI. The later review/authority decision independently
  revalidates current provider retention. Structural parsing produces only
  pending-review evidence; it does not authenticate claims or grant import readiness.
- The source gate uses manifest version 4 only; version 3 is rejected instead of
  being reinterpreted. Version 4 declares `releaseClass` as either
  `live-reviewed` or `fixture-nonrelease`, and every non-template manifest traverses
  the same complete canonical evidence-bundle check. The bundle binds the exact
  authenticated sidecars and retained-object receipt through their deterministic
  candidate, an externally obtained current-retention verification valid for no
  more than 24 hours, and a named staging decision that binds the
  manifest-authority subject, release class and scope, candidate digest, and
  retention-check digest. The manifest binds the final bundle digest. The gate
  rejects evidence at the exact expiry boundary and has no test, environment, or
  CLI bypass.
- The immutable staging batch persists the release class, evidence-bundle and
  decision digests, retained-object version, and retention-evidence expiry.
  Validation evidence commits to all of them, and the existing role approvals bind
  them transitively through the validation digest. `fixture-nonrelease` follows the
  identical parsing and staging gate but is permanently ineligible for approval,
  promotion, activation, and rollback-to. Existing rows migrate to
  `legacy-unbound` with null evidence rather than fabricated provenance and cannot
  be used to establish new live authority.
- Passing the source gate authenticates no identity claim, verifies no signature,
  performs no current provider query, and proves neither object existence nor
  retention. Live M0B remains blocked until a protected authenticated runner, two
  real isolated acquisitions, a distinct immutable-storage workload, a current
  provider check, and named reviews supply the evidence. A syntactically valid S3
  URI is not proof that its object or lock exists.
- Import from the pinned raw artifact is deterministic and reports accepted,
  rejected, quarantined, and missing-nutrient counts.
- Through the supported application service, a source cannot publish directly
  into the active catalogue. Staging, validation, three-role digest-bound
  approval, atomic activation, and pointer-only rollback are proven by the
  PostgreSQL integration gate, including an unchanged historical diary nutrient
  snapshot. Database constraints independently protect immutable provenance,
  release classification, canonical evidence fields, and initial workflow
  states. Validation freezes each valid food's canonical materialization
  document and SHA-256 plus the complete mapping-revision set. Promotion and
  rollback are identifier-only database functions: capability callers cannot
  supply food JSON or direct table/sequence writes, and capability promotion
  requires three distinct database-authenticated reviewer principals.
  Fixed-purpose stage/validate functions bind distinct authenticated principals,
  immutable parser evidence, a database-computed staging seal, and the exact
  validation observation. Migration 0021 independently reconstructs the exact
  100-gram nutrient result from the sealed canonical payload and reviewed mapping
  revisions, freezes record and batch semantic SHA-256 attestations, and rejects
  changed, fabricated, or omitted known/trace/unknown semantics. Text parity
  must prove NFC normalization, the exact ECMAScript whitespace trim/collapse
  set, and JavaScript UTF-16-unit length bounds. JSON numeric `100.0` is numeric
  `100`; string `"100.0"` is not exact string `"100"`. Approval, promotion, and
  non-null rollback fail closed without complete attestation;
  historical unattested releases remain inert rather than being backfilled.
  Migration 0022 also requires every capability-mediated approval or activation
  actor label to equal its authenticated PostgreSQL `session_user`; caller text
  cannot impersonate a different audit actor. Owner/local descriptive labels
  remain explicitly trusted compatibility data, not external identity proof.
  Owner compatibility remains, and the capability roles have no live login
  membership or caller cutover. Production least-privilege identities,
  external-principal binding, caller cutover, and representative-scale evidence
  remain live M0B prerequisites.
- Supported materialization reads and nutrient insert/update/delete writes use
  the migration-0018 active-registry advisory protocol. Integration evidence
  must prove that multiple readers coexist,
  insert/update/delete writers wait, and a waiting reader observes the complete
  committed generation. Deployment and restore evidence must match the four
  nutrient-lock functions and seven exact bindings plus migrations 0019 through
  0022's complete 54-function/54-trigger authority surface, sixteen
  frozen authority columns, and nine authority CHECKs; a broad nutrient table lock,
  an `active`-only writer trigger, or an unexpected shared-food trigger is a
  regression.
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
runs exactly four named bounded polls. They use the
same combined search/retention worker runtime used by the worker entrypoint:
seed export, one-artifact expiry, measured export, and erasure. A static
contract rejects a hidden additional poll. The drill populates and independently
enumerates the compile-pinned set of all 65 retained export entity families,
requires nonzero source counts and exact ID/count reconciliation across the
source snapshot, JSON, and decompressed CSV, and proves cross-owner account/
session survival. Forbidden field-name assertions
and independent sentinels verify every audit row omits all redacted fields in
JSON and decompressed CSV; artifact lifecycle rows omit object locators,
encryption identifiers, and ciphertext-byte metadata. Supported user workflows
are route-first, with narrow direct compatibility/evidence fixtures only for
route-unreachable catalogue/source/import, audit, legacy nutrient/barcode, and
legacy operation rows.

Hydration setup is route-first: the authenticated fixture creates, revises, and
logically deletes entries through the private HTTP surface. The day, entry,
immutable-revision, and operation families reconcile through both artifacts and
erased-owner zero-row evidence, while an independently queried cross-owner
hydration entry and its owner session survive.

This is never a cloud, public-hosting, physical-phone, or production-data
command. The drill deletes its export artifacts and scratch database schema, but
intentionally retains the immutable encrypted erasure-ledger tombstone as local
recovery evidence. Passing it closes the local all-retained-entity source gate;
it does not prove production notification delivery, hosted access controls,
off-host restoration, signed devices, independent review, or controlled-beta
acceptance.

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
- Every profile, diary, hydration, biometric, report, and integration route
  enforces a server-side session/ownership check; unauthenticated and cross-user
  access tests fail closed.
- Hydration acceptance proves exact-integer milliliter creation, amount correction,
  and deletion,
  immutable revisions and logical tombstones, digest-bound replay, strong entry
  and day revisions, profile-time-zone race handling, explicit-`occurredAt`
  cross-day moves, and owner-isolated export/erasure. Browser and signed
  iOS/Android acceptance covers the shipped amount-correction UI; client time
  editing remains open and cannot be claimed from API coverage. The 1–20,000 mL
  per-entry, 64-active-entry, and 100,000 mL daily ceilings are operational
  abuse/overflow bounds, never targets or intake advice. Targets, reminders,
  non-water fluids, offline/background mutation, device/platform ingestion, and
  medical interpretation remain out of scope until separately reviewed.
- Authenticated web routes use a nonce- or hash-based Content Security Policy;
  the foundation shell's temporary `script-src 'unsafe-inline'` policy is not a
  sufficient XSS boundary for personal data.
- At least 1,000 reviewed query-country relevance cases pass the agreed top-five
  threshold, with a 200-case set running on every ranking change.
- Each launch market has a stratified sample of at least 1,000 known GTINs; exact
  match is at least 85%, with the Wilson lower bound at least 82%.
- Signed native camera-barcode acceptance proves permission grant, temporary and
  permanent denial with manual fallback, unavailable/cancel/background camera
  teardown, one lookup across repeated detections, EAN-8/EAN-13/UPC-A/ITF-14
  behavior on both platforms, invalid check digit, no-match and network-error
  handling, exact parity with typed lookup, and user confirmation before the
  existing mutation. It also proves no microphone prompt, frame/image
  retention or upload, background capture, durable/on-disk barcode persistence,
  or widening of the durable quick-add envelope. Existing P0 v2 evidence cannot satisfy this
  new claim; the capture/report/reviewer contract must be versioned before
  signed-device acceptance.
- Core generic foods meet the agreed nutrient-completeness definition at least
  90% of the time.
- M1C-A's native diary-log outbox proves one 50-item encrypted, owner-bound FIFO
  across legacy version-1 quick adds and version-2 public-food, exact recipe-
  version, and exact custom-food-version creates. Evidence covers positive
  default-serving and gram quantities; lossless legacy replay; persist-before-
  send and exact idempotent replay across every slot/manifest crash boundary;
  one foreground request; a shared capacity with no eviction; mixed-kind order;
  paired selected-day time-zone preconditions on every new endpoint; exact
  kind/version/portion/meal/instant/date/zone/affected-day receipts; malformed
  success retention; terminal-head retry and confirmed discard; corruption and
  overflow failure; and retryable sign-out, unauthorized, erasure, and owner-
  mismatch cleanup with no duplicate diary entry. Browser refresh must observe
  the same confirmed entry and totals. Browser/mobile convergence in M1C-A is limited
  to public-food quantities and observing native-confirmed entries: browser recipe and
  custom-food logging remain legacy online-only, have no paired profile-time-zone
  precondition, and are outside this gate. Source evidence does not substitute for
  signed iOS/Android lifecycle, keystore, OS-kill, or accessibility acceptance.
- M1C-B source acceptance proves native journal-version-3 repeat, edit, delete,
  and complete-day within-meal reorder operations with lossless legacy replay,
  persist-before-send behavior, typed note-capacity refusal, exact dependency
  guards, current-profile-zone preconditions, authoritative persisted-day order
  digests, and subject/revision/state/day-bound receipts. Web uses the same strong
  correction and reorder protocols; browser recipe and custom-food creates now
  use the paired profile-time-zone guard. Ordered local source evidence does not
  clear signed iOS/Android lifecycle, protected-storage, OS-kill, accessibility,
  hosted, browser-persistence, background-delivery, or controlled-beta gates,
  and it does not provide an offline catalogue or readable offline diary cache.
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
- Manual-activity acceptance proves owner-private, bounded, retry-safe add,
  correction, logical deletion, local-day history, immutable export, and erasure
  across the database, private API, web, and mobile. Duration is exact whole
  minutes; absent self-reported calories remain null; names and activity values
  stay out of logs; and every response is private and no-store. A regression
  proves activity mutations do not change nutrition goals, remaining calories,
  PAL, explicit adjustments, goal progress, dietary totals, reports, or
  `exercise_budget_kcal`.
- Automatic activity-energy estimation, earned-calorie or net-energy behavior,
  platform/wearable ingestion, offline/background mutation, hosted acceptance,
  signed-device and cross-client behavior, and accessibility evidence remain
  deferred under ADR 0025.
- Coordinated Today-overview source acceptance proves that one selected
  profile-local date drives the diary and the existing hydration and activity
  day reads on web and mobile, including date-preserving navigation into and
  back from both detail screens. It shows exact plain-water milliliters and
  entry count plus the exact additive sum of recorded activity minutes and entry
  count; overlaps remain additive and a cross-midnight activity belongs wholly
  to its stored start date. Each domain
  retains its existing immutable historical entry coordinates; the overview
  never re-buckets entries after a profile-zone change. Each domain distinguishes
  loading, confirmed empty, and error; a failed card has its own
  retry and cannot erase successfully loaded domains. Delayed responses are
  fenced by owner, session generation, profile time zone, selected date, and
  request generation, while `401` closes all private overview state. Tests cover
  local-date and daylight-saving boundaries, stale response rejection, partial
  failure, accessible labels, and the absence of cross-domain calorie
  arithmetic. This is an independently revisioned presentation overview, not a
  coherent cross-domain snapshot; it adds no backend aggregate, database
  migration, or `/v1` response change. The internal web hydration BFF requires
  a same-token expected-owner preflight before requesting the day. The slice
  adds no activity calorie total, target, advice, reminder, outbox, wearable, or
  phone-exposure behavior. Hosted, signed-device, physical cross-client, and
  accessibility evidence remain open under ADR 0026.
- Hydration time-correction source acceptance under ADR 0027 proves explicit
  current-profile local-minute editing on web/mobile; gap rejection and an explicit
  occurrence choice for repeated minutes; amount-only preservation of historical
  coordinates and seconds/milliseconds; and the optional paired timestamp-update
  guard. Legacy unguarded request digests remain unchanged, while guarded requests
  fail closed on an older API or profile-zone drift. Database tests prove no-write
  zone conflicts and exact accepted replay after drift. Clients bind retries to
  one immutable operation, reconcile stale revisions/zones, validate affected days,
  retain the selected source date, and distinguish accepted writes from failed
  refreshes. Session/owner/zone changes close stale private state. Synthetic browser
  daily-loop evidence and accessible-state regressions accompany the source gates;
  signed native, hosted, physical cross-client and assistive-technology acceptance
  remain open. No water advice, target, outbox expansion or calorie change is added.
- Goal progress proves lower-bound semantics with incomplete nutrient panels and
  never labels an unknown contribution as measured zero or exact completion.
- Multi-day nutrition-report acceptance proves a closed, owner-scoped 1–31-day
  query and one read-only repeatable-read snapshot across profile, diary,
  nutrient-registry, watermark, and goal evidence. It covers active-profile-zone
  day boundaries including daylight-saving transitions, immutable source
  coordinates, exact zero, trace, partial, wholly unknown, synthesized
  not-reported nutrients on nonempty days, null aggregates only on empty days,
  current-goal-version-at-snapshot segments and reference expiry, exact-decimal
  chart scales, all 15 core series, and summary reconciliation. Cross-owner and
  malformed persisted evidence fail closed, private dates and amounts stay out of
  logs, and every response is no-store. Browser, signed iOS/Android,
  cross-client, keyboard/screen-reader, hosted-load, and controlled-beta evidence
  remain required before release.
- M3B web print acceptance under ADR 0028 reuses the loaded report and selected
  nutrient after private session verification. Exact values, missingness, saved
  thresholds, target periods/expiry, source diary coordinates and capture metadata
  reconcile to the snapshot for all 15 nutrients. Synchronous invalidation fences
  close stale async/retained handlers and direct browser printing defaults to
  neutral guidance. Cancellation, ignored/thrown printing, effect replay and
  repeated attempts leave no authorized hidden snapshot. Inspect complete 1-, 7-
  and 31-day Letter/A4 PDFs for readable monochrome tables, repeated headers and
  no clipped evidence or app controls. Browser-owned previews and saved output
  cannot be revoked after handoff; afterprint does not prove a save. Synthetic
  browser/PDF proof does not replace independent, hosted or assistive-technology
  acceptance. No API, retained entity, storage or delivery channel is added.
- M4A pasted-ingredient review under ADR 0029 preserves each original line in memory
  and requires explicit food/version and positive exact portion confirmation.
  Reopened or changed choices cannot retain an old confirmation. Transfer appends
  once to the current new-recipe draft without losing its fields or exceeding
  50 ingredients; cancel preserves that draft. Raw paste never enters notes,
  storage, telemetry or save payloads automatically. Owner/request/generation
  fences cover search, JSON parsing, transfer and parent open/save receipts, with
  session closure, disabled state, unmount and effect replay exercised. Browser
  review covers keyboard use, narrow layouts, failure/retry and final transfer.
  Existing yield, provenance, idempotency and release gates remain required.
- M4B native pasted-ingredient review under ADR 0030 preserves M4A's shared parser
  bounds and explicit quantity/confirmation semantics. Mobile owner, credential,
  API destination, request and builder generation fences reject stale async work;
  raw review clears on background/inactive, cancel, transfer, closure and unmount.
  Retryable authorization/receipt failures preserve the stable recipe save body/key.
  Source harnesses and Expo exports do not replace native keyboard/screen-reader,
  signed-device, hosted or independent release acceptance.
- Saved-recipe nutrition inspection under ADR 0031 identifies the exact saved
  version and selected per-serving/per-100 g basis. Only existing vectors are
  shown; unsaved builder edits and diary portions do not alter those values.
  Recipe/version/session transitions reset or close stale controls. Unknown,
  partial, trace and measured zero remain distinct through the existing diary
  formatter, without new calculations or mutations. Actual-component and
  synthetic browser evidence do not replace native device, assistive-technology,
  independent reviewer or hosted acceptance.
- Copying a saved recipe under ADR 0032 preserves exact pinned ingredient versions
  and quantities in an independent new draft. Dirty-editor replacement requires
  an explicit choice bound to the selected saved version and current draft;
  later edits, selection and private lifecycle changes invalidate old choices.
  Copy performs no network write, clears original root identity and saved/log
  selection, and never reuses an earlier draft's unresolved create intent.
  Existing create/ownership/provenance/rights and stable retry gates still apply.
  Source and synthetic browser checks do not establish real database persistence,
  native device, assistive-technology, hosted or independent release acceptance.
- The optional M1B-R reference-template candidate remains disabled for
  controlled-beta and commercial users until a named registered dietitian or
  qualified clinical-science owner approves its exact values, canonical units,
  RDA/AI/UL meanings, applicability boundaries, cautions, copy, and test
  evidence; legal/privacy review approves its intended use and sensitive
  profile/acknowledgement handling; and copyright review approves the commercial
  source presentation. Acceptance proves explicit profile-revision-bound group
  selection and versioned acknowledgement, server-authoritative all-or-nothing
  materialization, no client-authored fallback vector, reference-applicability
  expiry at the 51st birthday, no silent source upgrade, manual-goal
  compatibility, export and erasure, and browser plus signed iOS/Android
  preview/detail accessibility. The product must not reproduce source tables or
  branding, imply Government of Canada or NASEM endorsement, call a UL a target
  or guarantee of safety, or infer diagnosis, deficiency, toxicity, or adequacy
  from diary intake.
- Diary client acceptance exercises a synthetic multi-page day spanning
  breakfast, lunch, dinner, and snacks on browser, physical iOS, and physical
  Android. Every immutable entry appears exactly once; repeated `totalEntries`
  and whole-day totals remain authoritative across pages; a mutation between
  pages produces a typed stale restart; and a pending date switch cannot render
  or mutate the previous day. Partially loaded groups never claim a false empty
  state. Reviewer-preserved evidence covers keyboard plus a browser screen
  reader, VoiceOver, and TalkBack load-more, progress, error/retry, group, and
  date-switch behavior. The same clients must rename and reorder all four diary
  presentation groups, preserve canonical entry destinations and queued
  quick-add delivery, converge after a cross-client profile refresh, reset to
  defaults, and surface a stale profile edit without overwriting it. Existing
  P0 v2 evidence does not contain that configuration flow and cannot satisfy
  this added claim; the capture, package, normalizer, and signed release-manifest
  contracts require their next reviewed version before controlled-beta
  acceptance.
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

## Recipe draft ingredient ordering (ADR 0033)

- Adjacent moves preserve each ingredient identity, immutable public/private food
  or nested-recipe pin, exact portion, note and attribution, including duplicates.
- Boundary moves are disabled; retained controls cannot edit another draft/order
  or cross owner/session/lifecycle/busy boundaries. Reordering invalidates pending
  copy-discard choices and participates in dirty detection.
- Moves make no write. Only explicit Create/Publish persists contiguous positions
  using existing revision and retry guards; saved nutrition/logging/history stay
  independent. Synthetic browser or component proof cannot replace real
  persistence, physical device, accessibility, independent or release acceptance.

## Adjacent nutrition report periods (ADR 0034)

- Previous/next navigation preserves the loaded period's inclusive 1–31-day
  count, validates existing service calendar bounds and handles leap/month/year/
  DST boundaries with date-only arithmetic. It retains the selected nutrient.
- Unapplied date edits disable navigation without discarding values. Only a
  coherent loaded snapshot/current session can move; stale, loading, closed and
  duplicate controls cannot commit another period or revive private output.
- One move requests one report for its chosen range through existing guarded
  readers. Old visible/print evidence is invalidated immediately; failed-read
  retry stays on the chosen range. Missingness, exact amounts, goal/timezone/
  owner evidence and independent/device/release gates remain unchanged.

## Report source diary navigation (ADR 0035)

- Daily report actions use deduplicated contributing source diary dates, keeping
  the report date and timezone semantics visible. Missing days open the report
  date without becoming measured zero. Explain that the current diary may differ
  from the captured report snapshot.
- Only current loaded/applied report evidence can navigate. Dirty dates and
  stale, duplicate, loading, closed, owner/session/profile/range or native
  lifecycle actions cannot navigate or reopen private output.
- Use existing diary routes with the explicit date and native refresh behavior.
  Navigation invalidates web print preparation; printable evidence/layout remains
  unchanged. No domain writes or added report/diary contracts are introduced.
  Synthetic/component proof does not replace real persistence, physical native,
  accessibility, independent reviewer or release acceptance.

## Collapsible diary meal groups (ADR 0036)

- Default-expanded controls use stable meal identities within the selected
  private day; labels/order do not remap choices, and date/session changes reset
  them. Same-day coherent page loading preserves presentation choices.
- Headings, Add food, whole-day totals/counts, pagination/retry and queue status
  stay reachable. Hidden entries remain in the authoritative view model. Empty
  and not-yet-loaded meals retain their existing meaning; no inferred meal count
  or new subtotal is introduced.
- Active editors and pending operations stay visible. Retained stale controls
  cannot change another date/session or bypass busy/private/lifecycle guards.
  Collapse adds no requests, writes, persistence, outbox or nutrition calculation.
- Actual-component web/native tests, independent in-task review, canonical local
  gates and exports, and synthetic Chrome keyboard/narrow/paging/editor/date QA
  establish only their bounded source behavior. Physical native, assistive
  technology, real persistence, independent Claude Code and release gates remain.

## Reuse activity details (ADR 0037)

- Reuse copies only parsed name, whole-minute duration and nullable self-reported
  energy to the current Add draft. Preserve null and exact positive decimal digits; zero remains invalid. Preserve
  selected day/time and untouched-default instant semantics; original entry identity,
  time and history totals remain unchanged until explicit validated Add.
- Exact dirty-draft replacement choices invalidate on intervening edits, date,
  source, request, private-scope or lifecycle changes. Busy and row-edit states
  reject reuse; retained controls cannot bypass synchronous draft/scope fences.
- Accepted reuse starts fresh create intent; unchanged retries retain body/key.
  Old receipts cannot clear another draft or scope. Keep accepted-write/read-failure,
  owner/timezone, update/delete and energy-policy gates intact.
- Actual-component tests, independent review, canonical local gates/exports and
  synthetic Chrome create/readback/lost-receipt/replacement/narrow/keyboard proof
  establish only bounded source behavior. Physical native, real persistence,
  assistive technology, independent Claude Code and release gates remain separate.


## Hydration amount presets (ADR 0038)

- Presets replace only the existing Add amount draft with exactly 250 or 500 mL.
  Manual amounts, selected date/time and untouched-default instant/fold remain.
  Choosing/rechoosing a preset sends no request and changes no ledger total;
  explicit Add is required. No recommendation or retained preference is implied.
- New and participating Add/date/retry controls reject stale, busy, pending,
  reconciliatory, private-scope, route and lifecycle states synchronously. Current
  same-value choices remain usable; an old receipt cannot clear another draft.
- Frozen pending body/key, accepted-write/read-failure cleanup, correction/time
  validation, owner/revision checks and existing native retry behavior remain.
  Presets do not introduce fresh operation intent or bypass a pending write.
- Actual-component/correction tests, independent in-task review, canonical local
  gates/exports and synthetic Chrome keyboard/narrow/create/readback/retry/date/
  expiry proof establish bounded source behavior only. Physical native, real
  persistence, assistive technology, independent Claude Code and release gates
  remain separate.


## Loaded saved-recipe name filter (ADR 0039)

- Derive only top-level saved rows using trimmed case-insensitive literal name
  matching. Preserve backing order, distinct IDs and nested-recipe choices.
  Matched/loaded counts and Load more remain visible at zero matches. Unverified
  initial state, page failure, empty terminal pages and complete empty libraries
  retain truthful meanings; no implied search over unloaded records.
- Filter/Clear are independent local actions: no request, write, selection,
  builder/copy/import/nutrition/log mutation or operation identity change. Preserve
  same-scope paging/retry/action context, and selected details outside the matches.
- Own synchronous filter guards reject stale value/Clear/private/route/lifecycle
  callbacks without advancing unrelated generations. Hide/clear replaced private
  state; same-value edits remain usable and pending operation recovery stays intact.
- Actual-component tests, independent in-task review, canonical local gates and
  exports, and synthetic Chrome paging/draft/keyboard/narrow/privacy proof cover
  bounded source behavior only. Real persistence, physical native, assistive
  technology, independent Claude Code and release gates remain separate.


## ADR 0040 native custom-food named nutrient composer

- Keep canonical nutrient text as the lossless manual/existing-row path; targetable
  picker availability must not discard energy or any non-targetable nutrient ID.
- Named append preserves exact decimals, zero/trace/unknown semantics, existing
  bytes/order and parser limits; invalid/duplicate/over-capacity Add is nonmutating.
  No implicit save, numeric conversion, guessed nutrient identity or measured zero.
- Prove actual native composer/custom-editor no-request state, explicit create/
  revision and exact retry body/key, unchanged other retention drafts, current/
  stale/private/foreground callbacks and late custom-save receipt ownership.
- Independent review, affected types/format, canonical check/build/licenses and
  fresh native exports are required. Platform mocks/exports are not rendered-device
  layout, assistive technology, real persistence, hosted or signed-device acceptance.
- No endpoint/schema/dependency/outbox/storage/math or web implementation change;
  existing vulnerability, provenance, reviewer and release-authority gates remain.


## ADR 0041 saved custom-food nutrient details

- Read only the loaded saved snapshot, including energy/non-targetable rows;
  preserve source order, names/units, exact values and zero/trace/unknown reasons.
  Explicit per-100-g and version context; no picker join, rounding or calculation.
- Show/Hide issues no request or mutation and preserves editor/composer/log drafts,
  shared state and unresolved operations. Bind disclosure to current private scope
  and exact loaded snapshot; preserve unchanged rows on paging and collapse on
  full refresh, version replacement or private/lifecycle closure.
- Require actual web/native behavior/type tests and independent review, fresh
  outputs and canonical gates, plus synthetic web/BFF Chrome keyboard/390-pixel/
  exact-state/paging/draft/expiry proof. Keep real persistence, physical native,
  assistive technology, external Claude Code, hosted and release gates separate.


## ADR 0042 native Health trend nutrient selection

- Every installed targetable ID up to 256 is reachable by local name filtering;
  retain source order, names/units, selected identity and truthful availability.
  Filter/Clear are no-request and independent of selection, dates and results.
- Different selections cannot relabel prior results. Bind explicit paired trend
  reads and response IDs/units/range/time zone to current private scope, installed
  metadata, input generation and foreground lifecycle; obsolete callbacks, reads,
  JSON, unauthorized responses and finally blocks cannot affect later work.
- Preserve exact existing nutrition/missingness labels, unrelated drafts,
  saved-food disclosures, operations/body/key and shared mutation protocols.
  Empty verified nutrients retain valid biometric-only loading; failed/replaced
  metadata cannot masquerade as current choices.
- Require actual native component regressions, affected types/format, independent
  review, canonical check/build/licenses and fresh native exports. Mocks/exports
  are not concurrent React, physical device, assistive technology, real service,
  external Claude Code, hosted or release acceptance.


## ADR 0043 loaded saved custom-food filtering

- Web/native local name Filter/Clear issue no request or mutation, preserve raw
  bounded text and source order/distinct IDs, and retain independent drafts,
  selected logging/version context, disclosure state and pending operation keys.
- Matched/loaded feedback distinguishes unverified/loading/unavailable, verified
  empty and no matches. Keep explicit paging/retry at zero matches; preserve
  dedup/accumulated rows on overlap/terminal pages. Active-only API listing is
  not archived-library browsing or remote search.
- Independent filter callbacks obey current private/profile/lifecycle scope and
  their own value generation; old callbacks cannot overwrite later queries.
  Same-private refresh/paging/accepted writes retain query without changing
  existing disclosure reset or mutation acceptance/recovery rules.
- Require focused actual-component/types/format and independent review, frozen
  canonical check/build/licenses, fresh client outputs and synthetic dedicated-
  Chrome production Next/BFF no-request/details/draft/paging/keyboard/narrow/
  expiry proof. Keep real service, physical native, concurrent React, assistive
  technology, external reviewer, hosted and release acceptance separate.


## ADR 0044 saved custom-food copying

- Copy is local and source/version identified; exact fields, IDs, all nutrient
  states and decimal strings survive into a new draft with no saved ID/revision.
  Preserve source records/history and require explicit Create.
- Raw unsaved drafts and native composer scratch require an exact source/draft/
  scope-bound inline replacement choice. Keep editing is lossless; stale choice
  or field callbacks cannot modify a later draft or copy another source.
- Accepted Copy has a distinct creation intent. Preserve exact retry identity
  within each intent and keep cancelled choices/local UI actions from rotating
  it. Live custom-write ownership prevents overlapping copy/save even when shared
  busy changes; stale receipt/JSON/401/finally cannot affect newer work. Preserve
  valid accepted-write handling independently of full-list/read freshness.
- Keep loaded list/filter/disclosures, pinned logging and unrelated workflows
  independent. No endpoint/schema/storage/outbox or nutrition calculation changes.
- Require actual-component/types/format and independent review, frozen canonical
  gates/fresh client outputs and synthetic Chrome Next/BFF exact copy/Create/
  lost-receipt/retry/original-unchanged/keyboard/narrow/expiry proof. Keep real
  persistence, physical native, concurrent React, assistive technology, external
  reviewer, hosted and release acceptance separate.
