# Product Build Plan

This repository implements an independent consumer nutrition tracker. It does
not use Cronometer code, branding, assets, copy, or proprietary food records.

## Product promise

The first complete release lets a person track everything they eat and
accurately understand calories, macronutrients, and micronutrients. Accuracy
means preserving source provenance and missingness—not presenting absent values
as measured zeros.

## Delivery status

Here, **implemented** means the source and its local/CI evidence are complete. It
does not mean a feature has passed controlled-beta, signed-device, independent-
reviewer, or production-release acceptance.

1. **Foundation (implemented):** modular monorepo, exact nutrition math, immutable
   diary snapshots, PostgreSQL schema, API/client shells, CI, and local services.
2. **Canonical food ingestion core (implemented):** release-candidate manifests and
   real-data adapters for USDA FoodData Central and Health Canada CNF, plus
   resumable staging, validation, atomic activation, rollback, and provenance.
3. **Food search (implemented against controlled fixtures):** disposable Meilisearch projection,
   generic/branded intent, autocomplete, typo tolerance, reviewed synonyms,
   bounded recent/favorite reranking, and authoritative exact barcode lookup.
4. **Diary vertical slice (implemented):** account/profile, local-day diary, serving
   selection, add/edit/delete, meal groups, exact daily totals, retry-safe
   idempotency, and opt-in 20-entry response pages with coherent whole-day
   totals, encrypted revision-bound continuations, and legacy full-day
   compatibility. The reviewed 50-active-entry day cap remains.
5. **Recipes and goals (implemented):** yield-aware versioned recipes, immutable
   recipe diary snapshots, versioned targets, bounded energy estimates, and
   lower-bound nutrient progress.
6. **Retention and privacy (implemented; release-gated):** timezone-correct
   nutrient and biometric trends, exact-version repeat logging, private versioned
   custom foods and biometrics, consented local reminders, coherent JSON/CSV
   export, erasure/recovery, and read-only HealthKit/Health Connect weight adapters
   are wired across database, API/worker, web, and mobile with package and
   integration evidence. The real API/worker privacy drill proves account,
   profile, biometric, and custom-food composition; real custom-food creation
   and diary logging; diary-revision JSON and CSV export including a historical
   private note; and diary/custom-food erasure reconciliation. Full API/worker
   export-erasure population across every retained entity family is an explicit
   M2 controlled-beta exit gate; safe local implementation may proceed earlier.
   Signed physical-device, independent-reviewer, and controlled-beta evidence
   still block release.

## Forward milestones

M0's authenticated acquisition, review, and activation trust lane and M1's
safe local source-work lane proceed in parallel. M2 requires both M0 and M1
acceptance; progress in either lane never waives the gates in the other.

1. **M0 — live catalogue evidence and controlled activation (current blocker):**
   revalidate upstream release identity; build verified, database-free parser
   evidence; obtain two genuinely independent authenticated acquisitions,
   immutable artifacts, rights/attribution approval, and reviewed nutrient
   mappings; stage into a non-current catalogue; and complete reconciliation,
   outlier, real-scale memory, search/index, relevance, barcode, completeness,
   and rollback review. Activation is a separately approved final action and is
   never implied by successful staging or synthetic fixtures.
   The FDC Foundation database-free inspection boundary is implemented locally:
   it now requires pinned artifact and parser identities, exact inventory, and
   deterministic baseline evidence. The dated Foundation parser smoke accepted
   363 foods, so it is an evidence-pipeline pilot rather than consumer-viable
   catalogue acceptance. Before M0 closes, independent reviewers must define
   and approve numeric thresholds for food, branded-food, and GTIN counts;
   nutrient-mapping and completeness coverage; benchmark search recall and
   zero-result rate; and parser/index memory, build time, latency, and footprint.
   The staged candidate must meet those evidence-bound thresholds; this plan
   does not infer them from the 363-food pilot.

   Controlled acquisitions, rights/mapping review, trusted staging, and every
   activation review above remain open. Full FDC CSV also remains blocked on
   changed upstream bytes and a bounded archive orchestrator.
2. **M1 — excellent basic daily loop:** activity/exercise, water, private diary
   notes, configurable groups, camera barcode scan while preserving exact GTIN
   lookup, durable offline retry/reorder, email-verification release acceptance
   and password recovery, reviewed reference targets, and production-grade
   weight sync, with cross-client end-to-end and accessibility acceptance.
   Private notes attached to food and recipe entries are implemented locally.
   Repeat preserves a note. Clearing hides it from the current display, while
   immutable prior revisions remain in private account exports until whole-
   account erasure deletes them. Structured logs redact note fields. This is the
   first entry-note sub-slice, not standalone diary notes.
   Standalone day/note-only entries remain open and require a separately reviewed
   immutable-entry model. Safe local work may extend the real API/worker privacy
   drill across every retained entity family ahead of M2.

   Bounded diary pagination is implemented locally across PostgreSQL, the private
   API, web, and mobile. New diary screens request at most 20 entries per page;
   every page repeats whole-day totals and count, encrypted continuations bind the
   owner/date/limit/day revision/effective time-zone state, and a stale day forces
   a page-one restart. Legacy date-only readers still receive the complete bounded
   day. The 50-entry write/aggregation cap remains until separate scale and client-
   virtualization evidence supports a change. This closes one M1 source slice,
   not M1, signed-device, cross-client, accessibility, controlled-beta, or release
   acceptance. A future staggered pagination deployment must remain API-first as
   specified by ADR 0012.

   A bounded native public-food quick-add outbox is implemented locally. It
   persists at most 50 owner-bound, create-only operations in device-only
   SecureStore before sending, replays one exact idempotent request at a time in
   the foreground, and blocks at a terminal FIFO head until exact retry or
   confirmed head-only discard. A paired API query marker and expected-profile-
   time-zone header fail closed on an older server and prevent a delayed first
   delivery from silently moving to a different local day. Sign-out,
   unauthorized-session, accepted-erasure, owner-mismatch, and corruption paths
   participate in the retryable private-device cleanup ledger. This closes only
   the public-food, default-serving, amount-one native create source slice.
   Signed iOS/Android crash-boundary and lifecycle evidence remains open, as do
   offline edits, deletes, repeats, recipes, custom foods, quantities, web
   persistence, background delivery, manual reorder, and cross-client
   convergence. A staggered deployment must be API-first as specified by ADR
   0013.

   Additive email verification is implemented locally across PostgreSQL, an
   authenticated request route, a public confirmation route, web, and mobile.
   Registration never sends automatically and unverified accounts keep their
   existing access. Each 24-hour capability has 256 bits of randomness and only
   its SHA-256 digest is persisted. A token-hash transaction fence and bounded
   account-first row lock preserve the prior action on pre-acceptance delivery
   failure, serialize loopback Mailpit acceptance with digest promotion, and make
   an immediate confirmation wait for issuance commit. Confirmation validates the action's
   existing normalized-email binding before consuming it, setting
   `email_verified_at`, and writing a redacted audit event. Browser links carry
   the capability only in a fragment that an early bootstrap removes before
   interactive navigation or submission; scrub failure aborts. Native clients
   use resend/status plus external-browser completion, not application deep
   links. Production provider/domain/TLS/authentication/outbox/retry/suppression
   review, shared request and confirmation abuse limiting, verification
   enforcement, signed-client, and accessibility evidence remain open.
   API-first rollout and the full boundary are specified by ADR 0014.

   SMTP acceptance and database commit are not a distributed transaction. A
   database failure after accepted local mail may leave that new message
   unusable while preserving the previous action and returning unavailability;
   this is one reason a production delivery/idempotency design remains blocked.

   Password recovery is implemented locally across the shared action table,
   public API, exact-loopback Mailpit, web, and mobile request flow. A public
   request returns one exact acknowledgement for every schema-valid
   target-dependent outcome, including missing delivery configuration and
   delivery/commit failure. Each one-hour capability is digest-only and bound
   to the active password account's current email. Account-first locking
   preserves the prior accepted action on pre-acceptance failure and serializes
   resends. Confirmation uses a fresh salt and the current bounded scrypt
   parameters, then atomically rotates the credential, verifies the bound email,
   invalidates outstanding verification, revokes every unrevoked session and
   every unconsumed reauthentication proof, and writes a redacted audit without
   creating a new session. Exact-verifier fencing prevents registration, login,
   or reauthentication work begun with the old password from minting authority
   after reset, and one exact post-lock database instant governs completion.
   The web scrubs the fragment before showing password controls, keeps it only
   in an ephemeral closure, streams hard request/response limits, and destroys
   it across page hide or back/forward-cache restoration. Mobile independently
   bounds the request response and has no native recovery link or token storage.
   Shared source/target abuse controls,
   timing-enumeration evidence, durable or provider-idempotent delivery,
   authenticated TLS/provider/sender/domain, retry/suppression/bounce operations,
   support/legal copy, signed clients, and accessibility acceptance remain open.
   ADR 0015 specifies the full boundary.

   No signed clients exist yet, so the entry-note source also proves only a
   coordinated deployment. Before a future staggered note rollout, M2 must add an
   explicit compatibility phase and capability signal: the server first accepts
   note writes while `note` output remains optional; editors stay hidden until
   they observe that capability; tolerant clients are staged; only then may
   server output become required.
3. **M2 — controlled beta:** reviewed hosting and digest-pinned seven-image
   deployment; HTTPS, access-control, and off-host restore evidence; full API/worker
   export-erasure population across every retained entity family; a reviewed
   Windows-host/WSL private-phone boundary; a signed iOS/Android device matrix; and
   independent security, browser/device, accessibility, scientific, and legal
   review. Cloud, DNS, Terraform, Tailscale, firewall, and EAS actions keep their
   separate approval gates.
4. **M3 — premium analysis and planning:** arbitrary-range reports and custom
   charts, printable/PDF output, scheduled repeats, macro scheduling, fasting,
   and nutrition scores/balance meters.
5. **M4 — premium capture and discovery:** recipe URL/text import, food and
   nutrient suggestions, photo/voice input, private sharing, and coaching, only
   after their privacy and claims boundaries are reviewed.
6. **M5 — commercial launch:** first-party entitlements, plans/trials, web and
   app-store billing, support, monitoring, and SLOs only after M1 and M2 pass.

## Non-negotiable engineering rules

- PostgreSQL is authoritative; search and cache are rebuildable projections.
- Food-source terms are reviewed before ingestion. Every release has a manifest,
  checksum, license record, and reproducible import run.
- Nutrient arithmetic uses exact decimals and distinguishes known zero, trace,
  and unknown values.
- Logged nutrition is snapshotted and cannot be rewritten by later catalogue,
  serving, goal, or recipe changes.
- Private health data is least-privilege, encrypted in transit and at rest,
  excluded from telemetry, exportable, and deletable.
- Begin as a modular monolith. Extract ingestion/search workers only when load or
  operational isolation justifies it.

## Canonical-ingestion boundary

The release pipeline, real FDC/CNF parsers, immutable database workflow, approval
gates, atomic promotion, idempotent replay, and forward rollback are implemented
and tested. A live FDC release has intentionally not been promoted: the checked-in
candidate remains non-importable until two independently authenticated operators
agree on the streamed artifact, rights review is recorded, immutable object
storage is provisioned, and the complete nutrient map is reviewed. Current-vs-
candidate database reconciliation now atomically emits canonical, digest-bound,
read-only evidence into a private, symlink-free repo-local `.local-data` evidence
tree only after database cleanup, without granting approval or promotion
eligibility. Separate retained full-registry mapping review, high-impact nutrient
outlier review, and search/index evidence remain pre-activation work. The CNF
path now includes database-free `cnf inspect` evidence and trusted-runner
`catalogue stage-cnf`: it enforces the exact full archive inventory around the
nine-CSV, five-adapter/four-reference-only contract, strict table and
conservation baselines before database access, checkpointed idempotent staging,
immutable parser-report verification, frozen replay, and database cleanup before
final output. Successful parses retain only the nine selected CSVs for review;
failure cleanup is bound to the captured identity of each extracted file. This
implementation is proven with synthetic fixtures, not a live CNF acquisition.
Dual fresh acquisitions, exact guide-member names and real-release baselines,
rights/attribution review, immutable storage, reviewed mappings, representative
parser-scale evidence, reconciliation/outlier review, and search/index evidence
still block activation but not the completed ingestion-core milestone. Promoted
releases freeze the complete active
mapping-revision set for exact historical revalidation, and canonical report
hashing/writing is incremental. The database observer and document builder still
retain full validated snapshots and the result object, so representative
full-FDC peak-memory evidence remains a live-release blocker. Tests use
synthetic approvals only to verify the transaction and historical-snapshot
invariants; they are not production attestations.

## Food-search boundary

The search index is generated from one coherent promoted-catalogue snapshot,
versioned, count-verified, and atomically swapped. PostgreSQL remains authoritative
for source rights and barcode identity. Projection revisions, fail-closed API
checks, `no-store` responses, and a bounded PostgreSQL fallback prevent an old or
unpublished index from extending a rights change. The public document excludes
user and health data and carries reviewed attribution through API, web, and mobile
surfaces. Search relevance and the PostgreSQL-to-Meilisearch publication path are
covered by real-service integration tests.

## Diary boundary

The write-capable private loop now uses normalized password accounts, bounded
scrypt work, revocable opaque sessions, server-side ownership checks, strong
entry revision preconditions, and UUID/digest-bound diary idempotency. Web bearer
tokens remain in a host-only Secure/HttpOnly/SameSite cookie behind origin checks
and a nonce CSP; native tokens use platform secure storage. Every food entry pins
its food version, source release, reviewed attribution, effective IANA time zone,
serving resolution, nutrition-engine version, and immutable reason-counted
nutrient vector. Day reads are coherent snapshots, cross-day moves advance both
day revisions, and trace, quantified zero, partial coverage, and unknown remain
distinct through the clients.

The checked-in food-release candidates are still deliberately non-promotable,
so diary integration evidence uses a synthetic promoted catalogue fixture rather
than claiming a live USDA or CNF release. Production password-recovery
acceptance, general cross-restart offline mutation/reorder support, and signed-
device preview testing remain controlled-beta gates rather than hidden claims
of this milestone. The bounded native public-food quick-add path is the sole
durable
exception: it stores a closed create-only envelope, never a bearer token, search
query, private note, arbitrary request, or response body. It preserves exact
FIFO replay across restarts but does not claim general offline synchronization.
Account
export and deletion are implemented and locally drilled under the retention and
privacy milestone; they are not production evidence. Diary screens now opt into
20-entry pages while legacy date-only readers retain a complete-day response.
Every page is derived with the authoritative whole-day totals inside one
repeatable-read snapshot; encrypted continuations reject a changed day or
effective profile time zone instead of merging revisions. Pagination bounds each
transfer but does not make writes, aggregation, export, erasure, or accumulated
client memory unbounded. A local day therefore remains capped at 50 food and
recipe entries and 256 nutrients until separately reviewed scale and
virtualization evidence justifies a change.

## Recipes-and-goals boundary

An authenticated person can create and revise a private recipe from immutable
food or nested-recipe versions, provide measured or estimated final yield, and
log either grams or a defined serving. Recipe versions retain the exact resolved
ingredients, calculation and identity-retention assumptions, reason-counted
nutrient coverage, warnings, and transitive source attribution. Cycles, excessive
depth or closure, cross-owner dependencies, ambiguous servings, and stale
revisions fail closed. A diary log pins the selected recipe version and remains
unchanged by later recipe edits.

Daily goals are immutable revisions with explicit effective dates. Energy can be
a user-supplied fixed value or a visibly estimated Mifflin–St Jeor result for the
reviewed adult/profile boundary, multiplied by an explicitly selected PAL. The
snapshot retains every input and source and does not add ordinary exercise a
second time. Nutrient targets are user-supplied and source-labelled; this
milestone does not silently invent DRI defaults. Progress is derived from one
coherent diary/goal snapshot and labels trace, partial, or unknown intake as a
known lower bound rather than exact completion. Web and native clients preserve
idempotent retry bodies and exact recipe versions.

Migration `0005` deliberately refuses experimental legacy recipe or goal roots
that lack the immutable evidence required by these contracts. They require a
reviewed export/remediation and API-based recreation; the migration does not
fabricate nutrition, yield, source, or equation history. Whole-account erasure
is implemented and locally drilled under the retention milestone. Automatic
reference targets, retention-factor datasets, therapeutic goals, and signed-device
validation remain controlled-beta work and are not claimed here.

## Current acceptance target — live catalogue evidence

M0 is complete only when an exact publisher artifact is independently acquired
by two authenticated principals, content-addressed and immutably retained,
rights/attribution-reviewed, parsed by a reviewed digest-pinned build, mapped
through reviewed nutrient revisions, and staged without changing the current
catalogue. Reconciliation, high-impact outliers, representative scale and peak
memory, complete mapping transitions, search relevance and zero-result rate,
barcode integrity, index count/build/latency/footprint, and forward rollback must
all produce digest-bound review evidence. Three distinct role approvals and an
explicit activation decision are still required before promotion and alias
switching. See [release gates](../quality/release-gates.md) and the
[food-source runbook](../../infra/runbooks/food-source-release.md).

The scoped retention source/package evidence and real API/worker drill now covers
account/profile/biometric/custom-food composition, real custom-food diary logging,
diary-revision JSON and CSV export including a historical private note, and
diary/custom-food erasure reconciliation. It does not complete the M2
all-retained-entity vertical gate or satisfy notification, signed-device,
independent-reviewer, physical-phone, hosted-beta, or public release acceptance.
Those boundaries remain fail-closed under M2.
