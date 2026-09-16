# ADR 0076: Standalone private day notes

- Status: Source and local validation complete; desktop/390px browser proof applicable, delivery and exact-commit automatic evidence underway; external/release acceptance pending
- Date: 2026-09-15
- Planning baseline: `d498151`; exact source identity and acceptance chronology are retained in the current readiness record

## Context and acceptance boundary

At the planning baseline, a person could not record context for an empty diary day without adding a food or recipe.
Existing notes belong to immutable food/recipe entry revisions and are saved through entry
corrections. M1 explicitly leaves standalone day notes open. A day note must not invent a food,
portion, nutrient vector, meal identity, or measurement.

This decision defines one owner-private note per selected local date, available on empty and
populated days in web and native. The person explicitly saves, edits, or clears it. Saved history,
exact retries, concurrent-edit recovery, private drafts, and complete account export/erasure are
part of the first slice. Existing entry notes, diary revisions/pagination, nutrition totals,
reports, goals, hydration, activity, and the native diary outbox retain their current semantics.

Independent model review accepted this decision on 2026-09-15 at16:10UTC; the integrator
recorded implementation acceptance at16:12UTC after verifying the prerequisites below.
The integrator has now verified the pre-implementation local prerequisites: Docker 29.7.2 Linux
Desktop, healthy guarded loopback dependencies, current migrations, two real artifact-store
integration cases and the real API/worker 65-family privacy drill passed. This baseline does
not establish the proposed note behavior or the required 68-family evidence. Source, synthetic
browser, or native bundle checks cannot substitute for real integration and retention evidence.

## Text, date, and clearing semantics

- `note` is either exact owner-authored text or `null`. A text value contains 1 through 2,000
  Unicode scalar values, excludes NUL and unpaired surrogates, and is never truncated. Preserve
  whitespace, line endings, and Unicode representation; do not trim, normalize to NFC, collapse
  whitespace, or interpret markup. The empty raw client field maps to `null`; whitespace-only
  text remains text. Reuse the existing entry-note input semantics without changing them.
- The resource key is the authenticated owner plus an explicit valid `YYYY-MM-DD` date in the
  existing years 0001 through 9999 range. This is a selected calendar day, not a derived event
  timestamp. It has no `occurredAt`, local clock time, meal, quantity, or nutrition.
- Each saved revision records the canonical IANA profile time zone accepted for that write.
  That zone explains the save context; it never re-buckets the selected date. Profile changes
  neither move an old note nor rewrite its recorded zone. A later deliberate save on the same
  date records the newly accepted zone in a new revision.
- Clearing appends a revision with `note: null`. The root, its positive revision, and every
  earlier revision remain. A later save reuses that root and advances its revision; it does not
  create a fresh absence state. Clear removes current visible text only. Prior text and replay
  evidence remain in private exports until whole-account erasure.
- Reading a never-created note does not create database rows. Clearing virgin absence is a
  `422 DAY_NOTE_VALIDATION` no-intent error. Clients do not send an unchanged raw draft or an
  empty virgin draft. Every otherwise valid first-use PUT, including deliberately equal text
  sent under a new operation key, appends exactly one revision. An exact operation replay does
  not append another revision, operation record, or watermark change.

## Additive private HTTP contract

`GET /v1/diary/day-notes/:date` and `PUT /v1/diary/day-notes/:date` require the existing bearer
session and `X-Expected-Owner-User-Id`. The session alone determines authority. An initiating-owner
mismatch returns typed `409 DAY_NOTE_OWNER_CHANGED` before reading or writing. Reject unexpected
query parameters and body fields; return `Cache-Control: no-store`. Note text never appears in a
URL, query, error detail, operational log, or telemetry field.

GET returns the following closed note resource inside `{ data: DayNote }`:

```ts
interface DayNote {
  ownerUserId: string;
  localDate: string;
  id: string | null;
  revision: string;
  note: string | null;
  recordedTimeZone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
```

Virgin absence has revision `"0"` and null ID, text, zone, and timestamps. A saved or cleared
resource has a UUID ID, positive decimal revision, recorded zone and timestamps; only its text
can be null. `createdAt` is the immutable first-save instant and `updatedAt` is the current
revision's server-recorded instant. Read the owner and note coherently. A read never guesses
empty state after a missing route, malformed response, private-session failure, or database error.

GET returns the strong ETag `"<revision>"`. The representation contains only note state, never
the current profile zone or other profile fields that can change independently of that revision.
The client obtains its current write zone from the existing verified session/profile. Clients
must distinguish the saved recording zone from that current zone.

PUT accepts exactly `{ note: string | null }`, requires a UUID `Idempotency-Key`, one strong
`If-Match` allowing `"0"`, and canonical `X-Expected-Profile-Time-Zone`. These guards are mandatory
on this new endpoint; there is no unguarded legacy mode. No resource ID, owner, timestamp,
revision, or zone is accepted in the body. The date is fixed by the route.

Every accepted PUT returns 200, the resulting strong revision ETag, and this closed envelope:

```ts
interface DayNoteMutation {
  data: {
    replayed: boolean;
    note: DayNote;
    receipt: {
      protocol: "diary-day-note-v1";
      operationId: string;
      ownerUserId: string;
      localDate: string;
      expectedRevision: string;
      expectedProfileTimeZone: string;
      resultRevision: string;
    };
  };
}
```

The complete result and receipt are immutable historical operation evidence. A matching success binds the
original operation ID, owner, date, expected revision/zone, exact nullable text, resulting note
identity and revision. For first application the result revision is exactly expected revision
plus one, using exact integers. Saved zone equals the accepted expected zone. An acknowledged
mutation is resolved before any follow-up read; a later read failure cannot turn it into an
unresolved write. A replay can return an older accepted revision after another client has edited
or cleared the note. Retire that exact intent, then reconcile the original date's current note
with an independent note-only GET. Never install a historical replay over a newer known head or
raw draft. Until reconciliation succeeds, distinguish an acknowledged historical save from fresh
current note state. Receipt/schema mismatch is an ambiguous result, not success.

Canonical request SHA-256 binds protocol, method, date/route, authenticated owner, expected
revision, expected zone, and exact nullable text. It does not normalize authored text. Under
the owner write lock, first validate that the account remains active, then look up an existing
owner/operation key. A matching digest replays the original result before checking the current
note revision or profile zone; a changed digest returns `409 DAY_NOTE_IDEMPOTENCY_CONFLICT`.
Consequently a successful earlier save remains replayable after later edits or profile changes.

For a new operation, verify the current profile zone and note revision before mutation.
`If-Match: "0"` succeeds only for never-created absence. Zone drift returns
`409 DAY_NOTE_TIME_ZONE_CHANGED`; an out-of-date note revision returns 412. Neither writes
history or consumes the operation key. Missing If-Match is 428; malformed identity/date/header/
schema is 400; invalid note content or virgin-null is 422. Preserve existing 401 and unavailable
service behavior. Two concurrent virgin saves cannot both create a root; two concurrent writes
to one revision cannot both succeed. Cleared positive revisions prevent create/clear ABA.

## Persistence and authority

Use one forward-only migration, provisionally `0026_standalone_private_day_notes.sql`, with
these three owner-linked entity families:

| Entity | Purpose and invariants |
| --- | --- |
| `diary_day_note` | Stable UUID root, unique `(user_id, local_date)`, immutable owner/date/creation identity, current revision ID/number and update instant. It survives clear and is independent of the food diary/day tables. |
| `diary_day_note_revision` | Append-only nullable text, recorded zone, server instant, operation kind, contiguous positive revision and predecessor. Composite owner/root foreign keys and deferred current-head validation bind each revision to its exact root; the newest revision must become its head. |
| `diary_day_note_operation` | Immutable owner/UUID key, canonical request digest, exact root identity and stored result/receipt. Composite owner/root foreign keys prevent cross-owner evidence; a matching key can never be repurposed. |

SQL independently checks finite dates/timestamps, note scalar/code-point bounds, valid IANA
zones, owner consistency, contiguous revisions, root identity immutability and exact head
advancement. History and operation UPDATEs are rejected. Direct history/root/operation deletion
is rejected while the owner exists; only the reviewed owner-erasure cascade removes them.
Do not permit updates to a cleared root to reset its identity or revision. Pin new trigger
functions' search paths in the actual migration schema, following the existing ledger pattern.

Writes use the existing `nutrition-tracker:diary:<owner>` advisory transaction lock, then the
active `app_user` row lock, profile read and note root lock. This already participates in
retention's `lockAllUserWriters`; do not introduce an unregistered lock namespace or reverse the
existing lock order. The root update, revision insert and operation receipt commit atomically.
Each new revision advances the existing user-data watermark. Failed writes and exact replays
do not. Food diary/day revisions and cursor identities do not change when notes change.

## Retention, export versions, and recovery

All three families enter the DB export union/specifications, reviewed per-table schema hashes,
worker export-family list, exact cascade graph and independently enumerated route-first privacy
fixture. Private exports include saved text, cleared history and operation evidence; application
logs retain only reviewed operational fields. The new family set contains 68 families, including
all 65 existing families. Do not merely increase a count or reuse a historical 65-family proof.

The logical export manifest's `formatVersion` changes from `nutrition-account-export-v1` to
`nutrition-account-export-v2` for the exact 68-family inventory. The delivery-manifest discriminator
stays `nutrition-account-export-delivery-v1`: its structure still binds the logical manifest's
SHA-256 and unchanged file descriptors. The existing `retention-export-semantic-v1` nutrition/
biometric evidence shape also stays unchanged; day notes do not alter those calculations.
Fresh worker completion carries the logical `formatVersion` as a required v2 discriminator in
`PrivacyExportReconciliationInput` and the job's stored `reconciliation` JSON.

Historical completed v1 records retain their exact manifest, reconciliation and artifact bytes,
including their own recorded family inventory; older v1 artifacts need not contain today's 65.
Read/replay parsers accept the existing legacy reconciliation shape, which has no new discriminator,
only for historical evidence; they never reinterpret it as v2 or let it authorize new completion.
Keep authorized download, expiry and erasure of old artifacts compatible. This requires neither
new job columns nor a general multi-version exporter.

New jobs and new attempts after cutover capture all 68 families. For queued or failed old jobs,
reuse the existing `withPrivacyExportSnapshot` path: replace unpublished spool rows atomically
under a new snapshot ID by taking a complete fresh account snapshot. A frozen 65-family snapshot
cannot be relabeled or padded to 68 and cannot satisfy the new inventory validation. Preserve
claim/failure cancellation of prior uploads and the `completePrivacyExportJob` fence: no new
artifact promotion while any prior-snapshot artifact remains undeleted. Registered/uploading
old artifacts must follow the existing cancellation/deletion lifecycle, never be overwritten.

Migration 0026 extends the existing `guard_privacy_export_job_completion_v3` database function.
In addition to every existing artifact-format/count/expiry check, each transition from a
non-completed state into `completed` must require `new.reconciliation.formatVersion` equal to
`nutrition-account-export-v2` and a well-formed reconciliation entity array containing exactly
the reviewed 68 distinct family names: no missing, duplicate, or extra entity. The gate explicitly
rejects missing/null reconciliation, wrong or unsupported versions and malformed arrays/items or
substituted family sets, rather than relying on a count of 68 or SQL NULL-sensitive comparisons.
Runtime completion validation enforces the same discriminator and exact set before attempting
publication. The transition gate applies even when the caller runs old compiled repository/worker
code. Existing completed
v1 rows remain readable and their ordinary artifact expiry/erasure operations remain valid;
the new requirement does not retroactively relabel or reject their historical completion or
same-status maintenance; those paths do not require v2 conversion.

The old completion code inserts artifact rows, promotes uploads, deletes transient spool rows,
and updates job status in one transaction. The new database gate rejects its absent v2/65-family
reconciliation and rolls that entire transaction back, preserving staged uploads and spool state.
Its failure/retry path must use the existing upload-cancellation/deletion lifecycle before a
fresh 68-family attempt can publish. A migration/readiness check at the start of a poll cannot
replace this fence: an old worker may already have captured a 65-family snapshot and be outside
that transaction when migration occurs.

Require coordinated stop and upgrade of old workers with migration and API support before note
writes become available. That cutover preserves availability; the database transition fence
provides the enforceable rejection of an old in-flight completion.
Reject unsupported inventory generations in fresh capture/completion. Tests must prove completed
v1 download unchanged; pending 65-family work becoming a new full 68-family snapshot; old-worker
completion rollback after migration; v2 missing/duplicate/extra-family rejection; and prior-upload
deletion before new publication. Do not weaken any existing receipt, artifact or restore gate.

The real privacy drill must create, revise, clear and rewrite day notes through authenticated
routes on empty and populated dates, independently query all three families, and reconcile
exact IDs/counts/text in JSON and decompressed CSV. Include a second owner's saved note and
session and prove both survive first-owner erasure. Race note writes with export/erasure fencing,
verify watermark/snapshot behavior, and prove erased-owner zero rows across all 68 families.
Preserve the existing bounded four-poll worker lifecycle and artifact cleanup rules.

Require twice-current migration and checksum-mismatch readiness evidence plus fresh/upgraded
database constraint checks. A pre-migration backup and complete forward-upgrade proof is one
recovery check. Separately, run the current-schema logical restore and erasure-ledger
reconciliation with saved and cleared day notes; the restore runbook still requires the complete
current migration ledger and checksums. Do not imply that it accepts an incomplete old ledger.
No down migration or applied migration editing is allowed. Retention policy/schema hashes must
be computed from the actual reviewed migrated schema, not guessed or loosened to pass.

## Client state and compatibility

The day-note section loads independently of food pagination, entry editors, disclosure controls,
meal collapse and queue state. It is available on an empty day and does not create an empty food
diary. Render loading, virgin absence, saved text, cleared state and unavailability truthfully.
Require explicit Save or Clear-and-save; local edits are never auto-saved. Keep unsaved text exact.

Keep at most one active note draft and one unresolved write envelope per mounted diary screen.
They belong to the initiating owner/session and original date. A deliberate date change may load
that day's saved note, but cannot silently retarget or discard an existing draft. Show the draft's
original date and a Return action; before a write is unresolved, an explicit discard can release
it. An ambiguous write offers exact retry and return to its original date, not a new operation
or implicit abandonment. It does not block unrelated food, hydration or activity workflows.

The envelope retains exact URL/body/revision/zone/key across network errors, malformed responses,
clock boundaries, date navigation and same-owner reloads. A same-owner profile-zone refresh must
not regenerate an ambiguous write; its accepted replay can still succeed. Definitive no-write
revision/zone conflicts preserve raw text and require fresh saved state plus explicit review/
rebase before a new operation. Never automatically overwrite another client's revision or resend
with a new key. Idempotency conflicts are not an invitation to silently allocate a replacement.

Current owner/session/date/load/visibility ownership must fence callbacks and stale reads before
passive effects. Old responses cannot clear a newer draft or resolve another operation. Hide
private content synchronously on private closure and clear in-memory authority on session/owner
replacement or unmount. This first online slice has no browser/native note persistence: process
termination or unmount can lose an unsaved draft or unresolved key. Explain that bounded limit;
do not claim crash-safe retries. Background handling must prevent stale private interaction
without silently replacing the exact current envelope on return.

The endpoint and tables are additive. Do not extend the existing food-entry union or add required
fields to old diary responses. Older clients keep their food/entry-note behavior; a new client
against an old API shows notes unavailable, never a successful empty read or save. Coordinate
migration, version-aware privacy worker/API support and note-write enablement first, then web
and native. No legacy worker may silently produce incomplete exports after note writes begin.
This defines a compatibility boundary, not authorization to deploy.

## Required evidence and explicit exclusions

- Contract and route tests cover exact raw text, Unicode/length bounds, absent/cleared snapshots,
  owner/date/schema/ETag rules, complete receipt matching and strict preconditions.
- Real DB/API integrations prove concurrent virgin saves, competing revisions, clear/rewrite
  ABA, exact and mismatched-key retries after subsequent edits/zone changes, direct-SQL history/
  head/owner constraints, private closure and erasure races. Independently assert unchanged food
  counts, totals, revisions, pagination and entry notes on both empty and populated days.
- Actual web/native component tests prove draft/date/session ownership, explicit conflict rebase,
  exact ambiguous retries and verified receipt handling while unrelated existing editors and
  queue actions remain usable. Synthetic Chrome covers the production web/BFF flow, keyboard,
  narrow layout and expiry; native source/export evidence remains narrower than device evidence.
- Integrate independent model/code review before the frozen canonical source ladder. Run the
  applicable real local database/API, migration/readiness, restore and 68-family retention drill
  and record executed counts, failures, source hashes and exact evidence. Automatic checks apply
  only to their recorded commit. No source or synthetic result closes external release gates.

No offline/outbox operation, background delivery, readable offline diary, arbitrary note-entry
kind, attachment, rich text, sharing, reminder, clinical interpretation, catalogue change,
nutrition calculation, cloud action, phone exposure, signed build or release is included.

## Accepted implementation boundary

Independent review accepted the route/receipt shapes, raw-text/date semantics,
virgin-null 422, deliberate equal-PUT revision policy, v2 completion fence and
bounded client recovery before application edits. No alternate export cutover
mechanism remains open. The implementation must still earn all required final
source, local integration and 68-family acceptance evidence; release execution
and external acceptance remain separate.

## Local validation checkpoint (2026-09-15T17:38:43.847582+00:00)

The model and application implementation have independent review. Focused native
113 and web 123 cases passed with affected types/formatting; the full real DB suite
passed 362 cases and API passed 358 with four opt-in skips. Separate execution
passed the real v2/68-family route-first privacy drill (artifact-store two plus
API/worker one), two worker ledger-restore cases and one API restore-readiness case.

Before main migration, the unmodified baseline-25 restore runner verified a
backup/restore followed by only 0026, then zero migrations on replay. Deliberate
checksum mismatch rejected readiness; restoring the exact checksum restored it.
Main then applied only 0026 and was current on the second run. Separately, the
unchanged current runner restored all 26 migrations and 93 tables twice through
owned disposable databases. Synthetic saved and cleared notes preserved exact
three-family hashes; a fresh authenticated ledger replay removed one owner across
all 68 exported families, preserved the other owner and passed fresh-epoch
readiness. Main data was unchanged by that drill; owned targets and tmpfs dumps
were removed. Local synthetic proof does not establish off-host acceptance.

Two validation-only corrections retain every production guard: paginated food
ETags are checked against their own cursor-bearing bodies; an existing catalogue
expiry fixture observes both application and database expiry after a bounded
timer. Original failures, corrected passes and independent reviews are retained.
The restore static test now pins all 26 migrations while preserving the previous
0025 checksum; the restore runner and gate were not relaxed.

Final canonical validation remains blocked on a reviewed dependency prerequisite:
the online Expo gate requires expo 57.0.23, expo-build-properties 57.0.18 and
expo-notifications 57.0.19, which also require @expo/cli 57.0.25,
babel-preset-expo 57.0.12 and @expo/router-server 57.0.10. The six exact release-age
exceptions/install and a fresh local production-audit disclosure await user
approval; no dependency edit, install or audit has begun. Prior ADR 0057 approval
was limited to its earlier exact list. Final check/build/licenses/audit, production
web/BFF Chrome QA, commit/push and exact automatic outcomes remain outstanding.
Standing ordinary commit/push authorization continues to apply after validation.

## Post-approval checkpoint (2026-09-15T19:40:24.504032+00:00)

The earlier 17:38 UTC checkpoint remains the historical record of the pending
prerequisite. The user subsequently approved the six exact releases listed above,
their release-age exceptions/install and one local production-audit disclosure.
The exact four dependency/config files passed independent review, strict
frozen/strict-peer install and 19 workflow/Expo wrapper tests. Separate native/EAS
configuration checks also passed. No broader exception was introduced.

Final `pnpm check` passed at 19:27:39–19:28:24 UTC: 3,708 freshly executed passes
including 157 root checks and the native runner, plus 324 passes from cached logs.
The 89 optional cases skipped by the current run and four cached skips remain
explicit; the type graph
reused eight of 17 tasks and the test graph ten of 17. Final `pnpm build` passed
at 19:29:15–19:29:35 UTC with 11 successful tasks, six cached. License policy passed
for 535 production packages with 14 reviewed exceptions. The single approved audit
ran at 19:30:18–19:30:19 UTC and passed policy with zero reviewed advisories; four
lower-severity advisories remain visible. This is not a zero-advisory claim.

A separate source-only native export verified 933 files/modes and freshly built
contracts and both iOS/Android bundles without copied application outputs or
Turbo cache. It reused the normal pnpm dependency store and its 12-minute-old
policy-verification result. Independent source/dependency comparison established
that the earlier real DB/API/privacy/restore runs remain applicable to unchanged
server implementation and test inputs; the final canonical run did not re-execute
those opt-in integrations. No cached or skipped result is described as a fresh run.

On 2026-09-15, the real API and production standalone web were started on owned
loopback listeners on 4000/3008. Readiness at 19:37:18 UTC verified 200, the exact API body
`{"status":"ok"}` and no-store. Dedicated Chrome opened, but the first account
entry is blocked by a password-manager prompt pending user dismissal. No
registration, empty/populated note journey or browser conflict/owner-boundary
result is claimed. Browser QA, commit/push and exact-commit automatic outcomes
remain pending; the feature is not yet delivered. These local results do not
close hosted, signed-device, external-reviewer or release acceptance.

## Browser correction and partial QA checkpoint (2026-09-15T20:29:27.611811+00:00)

The earlier checkpoints remain unchanged historical observations. Actual Chrome
QA exposed a date-navigation race: a note read started while the parent route was
not current, its result was correctly rejected, but route readiness did not
retrigger the read. Return and Cancel could therefore leave the editor disabled.
Web now includes the rendered readiness boolean in its read effect; the analogous
native read identity includes date readiness. Existing private, request, draft,
mutation and receipt guards remain unchanged. Both regressions failed on their
original components before the minimal fixes. Independent reviews passed;
focused suites passed 124 web and 114 native cases with zero skips and affected
types/formatting.

The corrected tree's full `pnpm check` failed at 20:14:37–20:14:49 UTC after 157
root checks passed: online Expo compatibility now expects
`expo-build-properties ~57.0.19`, while the approved pin remains 57.0.18. It did not
reach workspace types/tests. The exact new exception/install and fresh audit
proposal awaits approval; no .19 change has been made. Separately invoked types
and tests passed at 20:16 UTC: 2,644 fresh test passes, including the native runner,
plus 1,233 passes and 93 optional skips from cached logs. Type/test graphs each
reused 15 of 17 tasks. Build passed at 20:17 UTC, reusing nine of 11 tasks, and a
new source-only native export freshly produced both platform bundles at
20:18–20:19 UTC. These successes do not convert the failed full check to a pass.
The earlier real DB/API/privacy/restore evidence remains applicable to reverified,
unchanged server inputs. The prior single approved audit and its four visible
lower-severity advisories are unchanged; no second audit has run.

On the fixed production web/BFF and actual API, Chrome verified create/edit/clear/
rewrite revisions 1–4 for an empty day and a populated day. The empty-day sample
retained 34 Unicode scalars including spaces, LF, a combining accent and emoji;
no food was added. An unsaved draft survived date-away display and Return exactly,
and the editor was enabled. Cancel on the destination restored its existing
revision-4 note and enabled editing. The populated day kept one pinned-version-1
serving logged at 15:01, 25 g protein with complete quantified coverage, and the
other 14 core nutrients unknown throughout. These are UI observations, not an
independent SQL-history proof or a browser CRLF claim.

Two-tab conflict choices, session revocation, owner isolation, 390px layout,
keyboard controls and the 2,001-scalar limit remain unverified in the browser.
Extension UI blocked the second Chrome tab; the user-authorized Brave fallback
was unavailable to the tool. No embedded browser, accepted security prompt or
security-setting change was used. The fixed runtime passed owned loopback
4000/3008 readiness at 20:24:24 UTC with exact API body and no-store, and was left
available for user preview. Remaining QA, the full gate and exact-commit delivery
are pending; hosted, signed-device, external-reviewer and release acceptance
remain separate.

## Brave and focus-fix checkpoint (2026-09-15T22:15:46.200075+00:00)

Brave became available after the earlier checkpoint. On the readiness-fixed build,
two-tab checks verified conflict review, Keep preserving raw text and Use adopting
saved text without implicit writes, followed by explicit keyboard Save. Revoked-
session closure, owner replacement/isolation, the 2,001-scalar alert/disabled Save,
Cancel and date navigation also passed. Revocation is not elapsed-token-expiry
proof. These observations remain tied to that build's unchanged handlers.

Those checks exposed a focus defect: Keep tried to focus a still-disabled textarea
before its enabling DOM commit, and Use did not transfer focus. The reviewed fix
queues a one-shot focus request for the exact accepted state/props/lifecycle and
consumes it after commit only while the private view and enabled input remain
current. Both original focus regressions failed, then passed fixed; focused web
proof now passes 130 cases with types/formatting. The unchanged native source
retains its earlier 114-case proof. No request, receipt or save/retry semantics
changed.

After that freeze, separate root typecheck/test/build commands passed at
22:05–22:06 UTC. Type/test graphs each reused 16 of 17 tasks, with 1,094 web tests
freshly passing; build reused ten of 11 tasks. Prior applicable server integrations
and the unchanged native export remain dated evidence. The full canonical check
is still blocked by the online Expo requirement for build-properties 57.0.19.
Its exact exception/install and one fresh audit proposal remains unapproved;
no .19 dependency change or second audit has occurred.

Both Brave tabs then reloaded the rebuilt production web/BFF against the actual
API. Enter on Keep focused the enabled textarea and retained exact spaces/LF raw
text without writing; explicit keyboard Save advanced the saved note to revision
9. Keyboard Use adopted revision 10, focused the enabled textarea and disabled
unchanged Save without writing. Ordinary Cancel likewise focused the editor and
kept revision 10. The populated day retained note revision 4, one pinned-version-1
serving, 25 g complete protein and 14 unknown core nutrients. These are desktop
DOM/UI observations, not HTTP-status, SQL-history, screen-reader or physical-device
proof.

Later measurements confirmed a 390×844 viewport with client and document scroll
width both 375. Saved-note, length-error and conflict controls fitted without
document overflow; the textarea scrolled internally. Narrow keyboard Cancel and
Use restored the correct saved text and focused the enabled editor; the other tab
still showed revision 11, proving no observed implicit write. Earlier viewport
set/reset attempts had no visible effect; the eventual change has no established
cause, so those historical observations remain unchanged. Desktop reset was then
verified, extra owned tabs closed and one populated-day preview left running on
loopback 4000/3008. Exact Expo prerequisite approval is the remaining local
blocker. The full gate, commit/push and exact-commit automatic evidence remain
open; no release or delivery approval is implied.

## Final local validation and delivery checkpoint (2026-09-15T22:39:22.693148+00:00)

The preceding checkpoints remain unchanged historical observations. The user
explicitly approved the exact `expo-build-properties@57.0.19` release-age
exception, installation and one additional production audit. The installed
four-file result exactly matched the reviewed proposal; strict frozen/strict-peer
install and independent dependency review passed. No broader exception was
introduced. The earlier online compatibility failure is retained, followed by
a successful final canonical run on the approved dependency state.

`pnpm check` passed at 22:28:23–22:28:47 UTC with 1,713 fresh passes: 157 root,
1,546 mobile Vitest and ten wrapper cases. Cached logs account for 2,327 passes
and 93 opt-in skips; no freshly executed case was skipped. Type/test graphs
each reused 16 of 17 tasks, with mobile fresh; the 1,094 web cases were cached
from the earlier fresh focus-fix run. `pnpm build` passed at 22:29:11–22:29:27
with 11 successful tasks, ten cached and native fresh. License policy passed
for 535 production packages and 14 existing reviewed exceptions. The one newly
authorized audit ran at 22:30:18–22:30:19, passed with zero reviewed advisories
or audit exceptions, and retained four lower-severity advisories. This consumes
that additional audit authorization; it is not a zero-advisory claim.

A separate source-only native build at 22:30:43–22:31:02 verified 933 inputs
and modes and freshly built contracts and both platform bundles without
copied application output or Turbo. Its strict install reused 651 store
packages, downloaded zero and added 654; policy verification reused a
three-minute cache. Independent review verified the exact artifacts and source
inputs before these explanatory docs changed. This proves clean application
output, not a clean dependency store, signed build or physical-device behavior.

Post-install applicability review found only the approved mobile edge/version
change across 12 importers, 723 packages and 726 snapshots, with 929 other source
inputs and 411 non-policy restore inputs unchanged. The dated real database/API,
68-family privacy/restore and desktop/390px browser proofs therefore remain
applicable within their original boundaries; they were not freshly rerun. The
owned preview was stopped at 22:25 UTC before installation. No new runtime
health or browser observation is inferred from the dependency checks.

Source and local validation are complete. Delivery is underway under existing
normal commit/non-force push authorization; no feature commit or push has
occurred at this checkpoint, and the new commit's CI and actual container jobs
remain pending. The previous baseline's automatic results do not cover this
tree. External Claude Code review, hosted, signed-device/accessibility and
release acceptance remain separate. The next bounded source candidate starts
with native evidence-contract model review after exact-commit delivery proof.


## Delivery closure — 2026-09-16 UTC

The prior source/local snapshot above is preserved as history. The reviewed 51
paths were committed and pushed as `93440578072202710f94f10e6c0dc15bf5a17660`.
[CI 35032737042](https://github.com/liangzixuan/cronometer-gold/actions/runs/35032737042)
passed its three jobs; [container run 35032737075](https://github.com/liangzixuan/cronometer-gold/actions/runs/35032737075)
passed all nine actual jobs on attempt one. Exact responses, source closure and
independent review were bound in the private delivery record at
2026-09-16T01:38:39Z with clean equal local/tracking/live heads. This closes source
delivery, not hosted, physical-device, external Claude or release acceptance.
[ADR 0077](0077-role-specific-p0-evidence.md) is the bounded successor for the
versioned native acceptance-evidence gap; it does not alter this note decision.
