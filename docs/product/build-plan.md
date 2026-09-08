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
   lower-bound nutrient progress. This implemented claim covers user-authored
   nutrient targets. M1B-R's source-verified reference-template candidate is
   source-complete across the database, API, web, and mobile and has passed the
   ordered local validation run. It remains blocked from clinical review,
   controlled-beta enablement, and commercial enablement.
6. **Retention and privacy (implemented; release-gated):** timezone-correct
   nutrient and biometric trends, exact-version repeat logging, private versioned
   custom foods, biometrics, and hydration entries, consented local reminders,
   coherent JSON/CSV export, erasure/recovery, and read-only HealthKit/Health
   Connect weight adapters are wired across database, API/worker, web, and mobile
   with package and integration evidence. The real API/worker privacy drill now
   populates and independently enumerates all 61 retained export entity families.
   It requires
   exact source-ID/count reconciliation in JSON and decompressed CSV; proves
   cross-owner survival; verifies audit and artifact-lifecycle redaction; expires
   one artifact; cancels queued reminder delivery after pause/revoke; and
   reconciles the erased owner's rows and projections. Public routes create the
   supported user workflows; narrow direct fixtures cover only route-unreachable
   compatibility/evidence tables, including catalogue/source/import, audit,
   legacy nutrient/barcode, and legacy operation rows. This closes the local
   all-retained-entity source gate, not M2. Signed physical-device, independent-
   reviewer, hosted access/restore, notification-delivery, and controlled-beta
   evidence still block release.
7. **Bounded nutrition reports (implemented; release-gated):** one coherent,
   owner-scoped snapshot now provides 7-, 14-, 30-, or custom 1–31-day reports
   across all 15 core nutrients on web and mobile. It preserves profile-local
   day boundaries, immutable diary provenance, current saved-goal versions,
   reference-target expiry, quantified zero, trace, partial, unknown, and
   completely missing days. This closes M3A's local source slice only; it does
   not claim clinical interpretation, signed-device acceptance, hosted
   availability, printable/PDF output, scheduled delivery, or full premium
   parity.

## Forward milestones

Roadmap priority is user-visible product parity and a provable release path, not
depth in any one infrastructure lane. While live catalogue, hosting, device, or
external-identity work awaits its separate approval or external evidence, the
default next work is the smallest safe user-visible source milestone. Only a
demonstrated P0/P1 correctness, privacy, security, data-loss, cross-owner, or
release-authority defect—or work required by the next beta exit gate—interrupts
that order. This is scheduling, not a waiver: every M0 and M2 acceptance gate
remains fail-closed.

M1A camera barcode capture is implemented at source level and awaits signed-device
acceptance. M1B-G's bounded configuration of the four existing diary labels and
their display order is implemented in source and has passed the ordered local
validation runbook; hosted and signed-device acceptance remain pending. M1B-R's
database, API, web, and mobile source implementation and ordered local
validation are complete. ADR 0021 pins its source-verified candidate
policy, exact adult 19–50 vector, exclusions, expiry, and rollout boundary. A
named RD or qualified clinical-science approval, legal/privacy approval,
commercial copyright approval, hosted acceptance, and signed-device,
cross-client, and accessibility acceptance still gate release. It must not be
described as clinically reviewed, government-endorsed, or commercially
available while those gates are open. M3A's bounded multi-day nutrition report
and charts are source-complete and have passed the ordered local validation
runbook. M1C's general daily-loop offline reliability is now the next safe
user-visible source priority while external M0/M2 work remains separately
gated. Production-service gaps follow. Arbitrary add/delete/hide group identities remain a future migration
milestone rather than part of M1B-G. M0's authenticated acquisition, review,
and activation lane proceeds in parallel when its separately approved external
work is available. M2 still requires both M0 and M1 acceptance.

Remaining database writer closure, runtime-identity cutover,
external-principal binding, target canaries, and CONTRACT revocation remain
mandatory before live staging, promotion, rollback, or activation. They do not
preempt safe M1 source work while the affected capabilities remain
`NOLOGIN` and unassigned unless a concrete high-severity defect is
demonstrated. Hardening without a named release gate, observed defect, owner,
and testable exit condition stays queued.

No OCI retry automation, live acquisition/staging/activation, cloud cost or paid
fallback, Azure/OCI Terraform plan/apply, Name.com DNS change, workflow
dispatch/rerun/cancel, Tailscale join/policy/routes/Serve, firewall/listener/
phone exposure, or EAS build/signing is authorized by this sequencing decision.
Each retains its separate explicit-approval gate.

1. **M0 — parallel live-catalogue and release-authority gate (required before
   real-user beta or activation):**
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

   A bounded database-free full-FDC CSV inspector source slice is covered locally
   by synthetic archives. It meets this plan's implemented definition only when
   exact-change CI also passes. It requires exact manifest-driven inventory,
   dispositions, explicit manifest-supplied data-type/market mappings,
   required-header contracts and ordered-header evidence, disk-partitioned joins,
   row/disposition accounting, and deterministic evidence without opening
   PostgreSQL. Controlled acquisitions, real inventory/header and mapping
   review, rights review, representative-scale resource evidence, a streaming
   staging path, reconciliation, search/index evidence, and every activation
   review above remain open. Changed upstream bytes remain unpinned.

   A bounded M0B database-authority EXPAND phase defines static, non-login
   capability roles for stage, validate, three independent approval classes,
   promote-and-activate, and rollback. Fixed-purpose staging, validation,
   reviewer approval, identifier-only promotion, and rollback now sit behind
   database-authenticated `SECURITY DEFINER` boundaries. Exact stage provenance,
   parser evidence, records, mapping revisions, and validated-food documents are
   sealed or frozen before later authority acts, and database audit identity is
   derived without fabricating values for existing or owner-compatible local
   rows. Migration 0021 independently recomputes the exact 100-gram nutrient
   transformation and freezes record and batch semantic attestations before any
   decision boundary. Its text parity is explicit: NFC normalization, exact
   ECMAScript whitespace trim/collapse, and JavaScript UTF-16-unit bounds; JSON
   numeric `100.0` equals `100`, while a string must be exactly `"100"`. It does
   not close M0B. Migration 0022 additionally binds capability-mediated
   approval, promotion, and rollback audit labels to authenticated PostgreSQL
   `session_user`, while preserving the explicitly trusted owner/local path.
   External OIDC/workload-principal verification is still absent. Target
   deployment logins and
   credential/caller cutover, independently operated validator execution,
   external-principal binding, remaining shared-writer profiles, direct-DML
   revocation, representative-scale evidence, and target-environment
   verifier/canary evidence remain required before live catalogue work.
   Logical restore now reapplies the pinned migration-0014 function/trigger
   manifest plus the forward migration-0015 approval/guard ACL correction,
   migration-0016 plus migration-0017 food-search function/trigger
   policies, migration-0018's nutrient-registry lock protocol, and
   migration-0019's frozen materialization, replacement activation-authority
   constraint, and promotion/rollback boundary plus migration-0020's sealed
   stage/validate boundary, migration-0021's exact-100-gram semantic
   attestation, migration-0022's database-actor binding under an explicit owner,
   and migration-0023's reference-target identity and vector integrity boundary.
   The transactional repair policy pins 55 function identities, 56 exact trigger
   bindings, sixteen catalogue authority-evidence columns, all nine catalogue
   authority CHECKs, both reference-integrity CHECKs, and the unique
   activation-to-batch index. It compares a canonical source/target version-14
   authority fingerprint, including column
   ACL state and trigger table schemas, while `PUBLIC CONNECT` remains revoked
   and the effective login allowlist stays exact. Public-table triggers and
   every cross-schema binding of a dedicated public authority trigger function
   enter that fingerprint. It
   first requires the exact tracked filename/file-byte-SHA ledger in
   `public.app_schema_migration`, ignoring an owner-schema shadow. The EXPAND CI drill still uses
   `nutrition_local` as both executor and owner, so it does not prove separate
   runtime fencing.

   DEPLOY-0 now implements the source-only evidence slice without claiming live
   deployment. Its canonical, credential-free policy permits exactly three safe
   reviewer logins, each with its single matching approval capability and
   PostgreSQL 17 `ADMIN FALSE`, `INHERIT TRUE`, and `SET FALSE`; the other four
   capabilities remain unassigned. The strict verifier checks the exact
   `public.app_schema_migration` names and SHA-256s against the tracked migration
   files, requires `public` to be the only non-system schema, and checks exact
   database/schema and object ACLs and grantors, relation/type
   ownership, default and column ACL absence, all nine authority CHECKs, the
   sixteen authority-evidence columns, the unique activation-to-batch index, all
   54 authority functions with exact execute ACLs, unsafe authority on any
   other public routine, and the exact 54-trigger protected shared-food/outbox
   authority set with exact table and function
   schemas. Every binding of a
   dedicated public authority trigger function enters the evidence even when
   its table is outside `public`. It also checks the effective login allowlist,
   seven isolated sessions, role
   attributes, object ownership, effective
   privileges, and the complete touched membership graph. Eight zero-write
   `23503`/`42501` canaries then prove matching/mismatched reviewer behavior,
   non-reviewer denial, direct-DML denial, unchanged fingerprints, and zero row
   delta. Persisted credential-free evidence includes the canonical stable
   structure projection plus its recomputable SHA-256 and excludes volatile
   backend PIDs. The policy, evidence, canary, and CLI report use schema version
   6. The real-loopback ephemeral-database integration passes and leaves no
   database or role residue. The policy carries no credentials or private
   identity claims. Live login provisioning, membership mutation, credentials,
   external-principal binding, DEPLOY, and CONTRACT remain blocked.
2. **M1 — user-visible daily loop (current source priority):** activity/exercise,
   private diary notes, configurable groups, durable offline retry/reorder,
   email-verification release acceptance
   and password recovery, a source-verified reference-target candidate, and
   production-grade weight sync, with cross-client end-to-end and accessibility
   acceptance.
   M1A implements camera barcode capture only as an ephemeral input adapter to the
   existing authoritative exact lookup. Permission starts only from an explicit
   Scan action; frames stay on-device and are not retained; repeated detections
   are consumed once; only EAN-8, EAN-13, UPC-A, and ITF-14 decimal payloads
   reach the existing GTIN/check-digit path; and the person must still confirm
   the existing add action. Manual entry remains available for denial, cancel,
   invalid, no-match, and network-error states. The durable quick-add envelope
   is unchanged and still contains no barcode. Local source acceptance covers
   classification/deduplication tests, native permission policy, dependency
   checks, typecheck, lint, and mobile export. Signed iOS/Android camera,
   lifecycle, and accessibility evidence remains an M2 gate and authorizes no
   phone exposure or EAS action.
   M1B-G implements owner-specific names and display order for exactly the four
   stable `breakfast`, `lunch`, `dinner`, and `snacks` identities across the
   private API, web, and mobile. It does not rewrite diary history, cursors,
   idempotency inputs, or queued quick-add envelopes. Source implementation and
   ordered local validation are complete while hosted validation and signed
   cross-client evidence remain pending, so it does not yet meet this plan's full
   **implemented** definition. M1B-R's database, API, web, and mobile source
   implementation and ordered local validation are complete. Its
   `us-ca-dri-adults-19-50` version-1 policy is source-verified and bounded to an
   explicitly selected, profile-matched `male-19-50` or `female-19-50` group,
   nonpregnant/nonlactating scope, server materialization, versioned
   acknowledgement, and exclusive reference applicability/current-read expiry
   on the 51st birthday. That policy is not clinical approval: a named RD or
   qualified clinical-science approval, legal/privacy approval, commercial
   copyright approval, hosted acceptance, and signed-device, cross-client, and
   accessibility reviews still block controlled beta and commercial enablement.
   Creating, deleting, hiding, archiving, or restoring arbitrary groups remains
   future work requiring durable identity and history semantics.
   Plain-water hydration is implemented locally across PostgreSQL, the private
   API, web, and mobile as an owner-scoped exact-integer milliliter ledger.
   Server-derived profile-local coordinates, strong entry/day revisions,
   digest-bound idempotency, logical deletion, and immutable revision history
   keep create, amount correction, and delete replay-safe and timezone-explainable.
   Its 1–20,000 mL per-entry, 64-active-entry, and 100,000 mL daily limits are
   operational abuse and overflow bounds, not intake guidance. Its four private
   entity families are route-first in the 61-family export/erasure drill. This
   closes only the online hydration CRUD source slice. Client time editing,
   targets, reminders, non-water fluids, offline/background mutation,
   device/platform ingestion, and signed-device, cross-client, and accessibility
   evidence remain open. The private API already supports explicit `occurredAt`
   changes without claiming a client time editor.

   Activity/exercise remains deferred until the product and scientific review
   settles PAL and ordinary-exercise double-counting policy. Hydration work does
   not imply an exercise-energy adjustment.

   Private notes attached to food and recipe entries are implemented locally.
   Repeat preserves a note. Clearing hides it from the current display, while
   immutable prior revisions remain in private account exports until whole-
   account erasure deletes them. Structured logs redact note fields. This is the
   first entry-note sub-slice, not standalone diary notes.
   Standalone day/note-only entries remain open and require a separately reviewed
   immutable-entry model. The real API/worker privacy drill now covers every
   retained entity family, but that local evidence does not close M1 or M2.

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

   M1C is the next source slice: extend durable, bounded, owner-fenced offline
   operation beyond the existing native public-food quick-add envelope to the
   normal daily loop—edits, deletes, repeats, recipes, custom foods, quantities,
   and deliberate reordering. Acceptance requires crash/restart-safe FIFO
   semantics, explicit terminal-conflict recovery, profile/time-zone drift
   handling, and cross-client convergence evidence. It does not authorize
   background delivery, phone exposure, signed builds, or controlled beta.
3. **M2 — controlled beta:** source-only hosting and signed-build preparation may
   proceed in parallel, but real execution still requires reviewed hosting and
   digest-pinned seven-image
   deployment; HTTPS, access-control, and off-host restore evidence; controlled-
   beta review of the locally complete 61-family API/worker export-erasure flow;
   a reviewed Windows-host/WSL private-phone boundary; a signed iOS/Android device
   matrix; and independent security, browser/device, accessibility, scientific,
   and legal review. Cloud, DNS, Terraform, Tailscale, firewall, and EAS actions
   keep their separate approval gates.
4. **M3 — premium analysis and planning:** M3A's bounded multi-day nutrition
   report and charts are source-complete with ordered local evidence. This first
   slice uses authoritative,
   immutable diary and goal evidence to present a bounded profile-local date
   range, calories, macronutrients, micronutrients, target comparisons, and
   explicit known/trace/unknown or missing coverage across web and mobile. It
   must preserve timezone and target-version boundaries and provide selectable
   nutrient charts without medical interpretation. Hosted and signed-device
   acceptance remain open. Printable/PDF output,
   scheduled reports, nutrition scores/balance meters, macro scheduling,
   fasting, sharing, and production or signed-device acceptance remain later
   work. This source sequencing does not waive M0, M1, or M2 release gates.
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

The release pipeline, real FDC/CNF parsers, supported-service database workflow,
approval gates, atomic promotion, idempotent replay, and forward rollback are
implemented and tested. Database constraints independently preserve immutable
provenance, evidence classification, canonical evidence fields, and initial
workflow states. The bounded M0B EXPAND change adds seven static `NOLOGIN`
capability roles and places the three reviewer approval classes behind one narrow
database-authenticated `SECURITY DEFINER` function. Database-derived approval
audit fields remain null for historical and owner-compatible local calls rather
than claiming an identity that was not authenticated.

Migration 0015 hardens that EXPAND state forward-only: database-audit fields on
new or changed activation and rollback rows remain constrained to paired `NULL`
values until their reviewed wrappers exist, and the approval function is first
reduced to owner-only execution after the stricter activation constraint is
installed as `NOT VALID`.
With no capability-role members or legacy paired non-NULL activation-authority
evidence, it grants the exact three reviewer roles. Constraint validation is an
independent gate: it succeeds whenever no legacy paired non-NULL
activation-authority evidence exists, even if a capability membership keeps the
reviewer ACL owner-only. Legacy evidence leaves the constraint unvalidated. Any
unsafe membership or legacy evidence blocks complete readiness through its
corresponding ACL, membership, or constraint evidence, avoiding rollback into
the exposed 0014 policy; a later reviewed forward policy is required for repair
and enablement.

Migration 0016 then hardens the existing `food_source` eligibility-to-search
call chain without broadening authority. It fails closed over the exact two
application-schema `SECURITY INVOKER` function identities, bodies, owners,
default ACLs, executable metadata, unconfigured pre-state, and exact enabled
trigger binding before pinning both search paths to `pg_catalog`, the captured
application schema, and `pg_temp`. It changes no function body, owner, ACL, or
invoker status and grants no privilege. At the 0016 boundary,
`enqueue_food_search_food_eligibility_change`,
`enqueue_food_search_serving_insert`, `enqueue_food_search_barcode_insert`, and
`enqueue_food_search_barcode_update` still resolved their own unqualified
relations and revision-function call through the ambient caller path and
required the subsequent 0017 review.

Migration 0017 completes that bounded namespace hardening for those four
remaining food, serving, and barcode outbox paths. It fails closed over each
exact application-schema `SECURITY INVOKER` function and exact ordinary enabled
statement-trigger binding before pinning only the four function-local search
paths. It changes no function body, owner, ACL, invoker status, table, or trigger
and grants no privilege. This removes the known ambient/temp-schema redirection
path, but it does not make runtime privilege separation safe.

Migration 0018 establishes one active-nutrient-registry advisory reader/writer
protocol across diary, recipe, goal, custom-food, mapping, and catalogue
materialization paths. Its fail-closed preflight attests the exact writer and
recipe-reconciliation functions and seven trigger bindings; it then adds a
default-ACL `SECURITY INVOKER` reader helper, replaces the final runtime nutrient
table lock, pins all four search paths, and expands writer-trigger coverage to
every nutrient update and delete. No runtime identity or elevated execution
authority is added.

This closes the application-path lock prerequisite, not arbitrary owner SQL.
Direct recipe DML, nutrient `TRUNCATE`, and nutrient DDL remain unsupported
during runtime; maintenance must quiesce callers and acquire the exclusive
registry advisory key before taking table locks. Fixed-purpose writers must
discover and order source locks before the registry lock rather than adding
generic recipe statement triggers.

Migration 0019 implements the first fixed-purpose shared-table workflow slice.
Validation freezes a canonical version-1 materialization document and SHA-256
per valid food plus the complete active mapping-revision set. Identifier-only
promotion and rollback functions materialize or repoint only that evidence,
derive database audit identity, require three authenticated reviewer identities
for capability-mediated promotion, and preserve lock ordering. Their capability
roles remain unassigned, and no live catalogue, login, credential, or caller is
created.

Migration 0020 implements the fixed-purpose stage/validate slice. Stage-only
functions create or resume one bounded attempt, append contiguous chunks of at
most 250 records with an atomic checkpoint, and persist parser evidence. The
complete batch is capped at 10,000 records and 64 MiB of stored canonical JSON.
A database-computed one-time seal binds provenance, the full parser evidence,
the exact stage checkpoint, the ordered record set, and active mapping revisions;
guards prevent post-seal records,
checkpoint changes, or audit/seal rewrites. A different validate-only database
login may observe and finalize only that exact sealed input; observation output
and the validation request are each capped at 128 MiB. The roles receive
only schema `USAGE` and their exact function `EXECUTE`, with no direct relation
privilege. Owner/local null-lineage compatibility remains and both capabilities
remain unassigned.

Migration 0021 independently recomputes the exact 100-gram nutrient
transformation from the sealed canonical payload and reviewed mapping revisions,
then compares it with the validator's frozen food document. It freezes
contract-version-1 record and batch semantic SHA-256 attestations. Approval,
promotion, and rollback to a non-null release fail closed unless the complete
attestation is present; a null rollback target may still deactivate. The
migration refuses pre-existing `ready` or `promoting` rows instead of backfilling
evidence. Historical unattested completed releases remain representable and may
retain an existing active pointer, but cannot be newly approved, promoted,
claimed as attested, or selected for rollback. Direct schema-owner SQL remains
trusted, and the migration assigns no live identity or caller.

Migration 0022 prevents capability callers from choosing the actor label stored
for approval, promotion, or rollback. Non-owner wrappers derive that label from
authenticated PostgreSQL `session_user`, and both authority CHECKs require it to
match `database_principal`; migration preflight refuses conflicting historical
rows instead of rewriting them. Owner/local calls retain their supplied label
with paired-null database authority. This closes spoofable database audit text,
not external identity verification, live role assignment, or caller cutover.

These limits are safety ceilings rather than
representative full-catalogue scale proof; a bounded paged production protocol
and measured resource/lock budgets remain open.

This is not production role/function isolation. Owner/local compatibility still
leaves a principal with table DML inside the trusted boundary; no live runtime
login or externally verified workload principal is bound to stage, validate,
promotion, or rollback
capabilities; and deployment cutover, independent validator execution,
direct-DML revocation, ordinary-deploy fingerprinting, and role canaries remain
open. The isolated logical-restore drill now pins and reapplies the
migration-0014 function/trigger manifest and migration-0015 approval/guard ACL
correction plus migration-0016's two search-path pins and exact
source-eligibility trigger and migration-0017's four search-path pins and exact
food/serving/barcode trigger bindings plus migration-0018's four nutrient-lock
functions and seven trigger bindings plus migration-0019's frozen-evidence
boundary and migration-0020's six audit/seal columns, two checks, five workflow
functions, owner-only helper, and three guards, migration-0021's four
semantic-attestation columns, two checks, independent semantic functions and
two guards, plus migration-0022's two actor-binding checks and three public
wrapper bodies, plus migration-0023's two reference-integrity checks, reference
reconciliation function, and two deferred triggers: the complete
55-function/56-trigger combined catalogue/reference boundary under the
version-14 fingerprint,
rejecting owner, constraint, ACL, or fingerprint drift before replay or API
probing. A live FDC release has intentionally not
been promoted: the checked-in candidate remains non-importable until two
independently authenticated operators
agree on the streamed artifact, rights review is recorded, immutable object
storage is provisioned, and the complete nutrient map is reviewed. Current-vs-
candidate database reconciliation now atomically emits canonical, digest-bound,
read-only evidence into a private, symlink-free repo-local `.local-data` evidence
tree only after database cleanup, without granting approval or promotion
eligibility. Separate retained full-registry mapping review, high-impact nutrient
outlier review, and search/index evidence remain pre-activation work. The FDC
full-CSV path now has a database-free, bounded, manifest-driven inspector with
seven relational adapter roles, explicit reference/guide dispositions,
explicit manifest-supplied raw-value mappings, disk-partitioned joins,
row/disposition accounting, and deterministic baseline evidence. It is
synthetic-fixture proof only: real dual acquisition,
archive inventory/headers/mappings, scale evidence, and database staging remain
open. The CNF
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
second time. The existing goal path remains user-supplied and source-labelled;
it does not silently invent DRI defaults. ADR 0021 separately defines an
explicit, previewed, server-materialized M1B-R candidate whose immutable source,
group, applicability, acknowledgement, and expiry must remain visible. Progress
is derived from one coherent diary/goal snapshot and labels trace, partial, or
unknown intake as a known lower bound rather than exact completion. Web and
native clients preserve idempotent retry bodies and exact recipe versions.

Migration `0005` deliberately refuses experimental legacy recipe or goal roots
that lack the immutable evidence required by these contracts. They require a
reviewed export/remediation and API-based recreation; the migration does not
fabricate nutrition, yield, source, or equation history. Whole-account erasure
is implemented and locally drilled under the retention milestone. M1B-R policy
is source-verified candidate evidence only; it remains blocked from clinical and
commercial claims until ADR 0021's reviews pass. Inferred or automatic reference
targets, retention-factor datasets, therapeutic goals, and signed-device
validation remain controlled-beta work and are not claimed here.

## Parallel release acceptance target — live catalogue evidence

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

The source now has a provider-neutral version-1 acquisition identity and
retention-evidence contract. It structurally binds each fresh observation to an
externally verified runner/source identity, requires a separate authenticated
storage workload with conditional-create, service-checksum, and retention
evidence active at receipt recording, and deterministically assembles two matches
only as frozen
`pending-review`/`not-granted` evidence. `artifact observe` also rejects unknown
or caller-authored identity/tool options and derives its tool identity from the
co-located package metadata. This is synthetic source readiness, not live
evidence: no approved runner or immutable food-release store exists, and no
current USDA artifact has been acquired.

The source/local M0A gate now uses manifest version 4 only and rejects version 3
rather than changing version 3 in place. Version 4 has exactly two release classes:
`live-reviewed` and `fixture-nonrelease`. Every non-template manifest, including a
fixture, traverses the same fail-closed runtime path with a complete canonical
authenticated-release evidence bundle. That bundle contains the deterministic
two-acquisition candidate, an externally obtained current-retention verification
whose validity window is no longer than 24 hours, and a named decision binding the
canonical manifest-authority subject, release class and scope, candidate digest,
and current-retention digest. The manifest binds the resulting complete-bundle
digest.

The staging database persists the release class, bundle and decision digests,
retained-object version, and retention-evidence expiry as immutable provenance.
Validation evidence includes those values, so later role approvals bind them
transitively through the validation digest. A persisted `fixture-nonrelease` batch
may exercise parsing, staging, validation, and deterministic replay, but runtime and
database transitions prevent it from being approved, promoted, activated, or used
as a rollback target. There is no test-mode, environment-variable, or CLI flag that
bypasses the bundle gate. The migration preserves pre-gate history as
`legacy-unbound`; it does not invent provenance for existing rows or allow that
history to become new live authority.

This closes the manifest-v4 source-code enforcement gap, not live M0B. The parser checks
structure, canonical digests, cross-object identity, and chronology, but it does
not authenticate OIDC or workload identity, verify signatures, query provider
state, or prove object existence or retention. No protected live runner, real dual
acquisition, distinct immutable-storage workload, current provider query, or named
review has been performed. The M0B database-authority EXPAND phase narrows
staging, validation, reviewer approval, promotion, and rollback through static
capability roles and database-authenticated functions. It deliberately retains
owner/local compatibility, and no workflow transition has a deployed identity
or independently proven validator runtime.
Every live staging, approval, promotion, activation, and rollback remains blocked
until deploy and CONTRACT cutover close direct DML, readiness proves the exact
owners and ACLs with role canaries, and the external controls provide trustworthy
evidence and receive explicit authorization.

The initial full-CSV inspector implements a database-free candidate contract and
synthetic-fixture evidence for bounded parsing and joins. It has not inspected
the current USDA archive and therefore does not close the live source gate.
Exact inventory, headers, raw values, type/market semantics, real-scale
footprint/runtime, thresholds, staging, reconciliation, search, rights,
approvals, and activation all remain open.

The real API/worker privacy drill now populates and independently enumerates all
61 retained export entity families. Exact IDs and counts reconcile across the
source snapshot, JSON, and decompressed CSV; forbidden field-name checks and
independent sentinels prove audit-field redaction; artifact lifecycle rows omit
object locators, encryption identifiers, and ciphertext-byte metadata; the
erased owner's rows and projections reconcile while a cross-owner account and
session survive. Hydration create, update, and logical delete are seeded through
authenticated routes; its day, entry, immutable-revision, and operation families
participate in exact export and erased-owner zero-row reconciliation while an
independently queried cross-owner hydration entry survives. Narrow direct
fixtures cover route-unreachable compatibility/
evidence tables,
including catalogue/source/import, audit, legacy nutrient/barcode, and legacy
operation rows. This completes the local all-retained-entity source gate, but not
M2: production notification, signed-device, independent-reviewer, physical-phone,
hosted access/restore, and public-release acceptance remain fail-closed.
