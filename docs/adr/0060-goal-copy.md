# ADR 0060: Copy a saved manual goal into a new draft

Status: Source/local complete; synthetic Chrome QA passed; automatic and external acceptance separate.

## Context and decision

The user asked to continue the roadmap. Let web and native users copy a saved
manual fixed-energy goal into an editable new draft instead of re-entering every
threshold and source field. The source is the saved version, never unsaved edits.
A copied draft has a blank effective date and requires deliberate date entry and
the existing explicit Create action.

## Acceptance card

- Add Copy saved goal to new draft beside the current goal actions, identifying
  the saved version and effective date. Allow active or archived saved manual
  fixed-energy goals, including closed historical goals. Preserve New goal and
  historical revision locks. A local copy does not change saved goal/progress.
  Successful Create may close the prior active interval under existing rules.
- Establish manual eligibility from an accepted complete goal load: exact saved
  goal object plus a parsed reference response for its effective date/current
  profile with applied === null. GoalView alone cannot establish reference
  provenance. Unsupported/404, missing, stale, mismatched or failed reference
  evidence is ineligible. Preserve that load-bound eligibility independently of
  mutable candidate UI; Customize or an unsaved mode change cannot make an
  excluded saved reference/derived source copyable.
- Reuse the existing goal-to-builder converter. Preserve exact energy/rationale,
  target ID/order/name/unit/category, all threshold strings, source labels,
  versions and rationales, including whitespace and nullable/zero round trips.
  Clear goalId, revision and reference; set effectiveFrom to an empty string.
  Do not invent dates, values, advice, conversions or metadata.
- Compare raw builder state with the loaded source builder. If edited, offer
  Keep editing and Discard edits and copy saved version. Search alone is not
  dirty. Keep only closes the choice; Discard replaces from the saved source,
  never from dirty fields. Reject stale choices after any intervening builder
  replacement, even changes back to the original value before paint.
- Protect both builder and related date/candidate/message metadata from stale
  callbacks. A narrow synchronous builder ownership seam is justified so current
  raw edits are visible before all copy side effects; keep updater side effects
  outside React functional state updaters. Preserve existing functional Add
  behavior. Use a separate local confirmation/draft generation if needed.
- Bind Copy/Discard to mounted/current source, route/private owner/session/profile,
  loaded progress date and read ownership. Reject actual date A-to-B-to-A changes
  before blur, new source objects, failed loads, closure/unmount and current
  auth/load/write/profile/candidate work using existing client lifecycle policy.
  Do not introduce unrelated global identity/background behavior.
- Copy clears draft reference selection/acknowledgement and invalidates only
  candidate work associated with the old effective date. Preserve nutrient search,
  saved goal/progress, profile drafts and unrelated request generations. Copy,
  Keep and Discard make zero requests and allocate no operation.
- Preserve the existing pending mutation map, save intent key, exact body/header
  construction and accepted receipt behavior. Block active writes, not all old
  pending entries. Identical ambiguous Create body/date reuses its existing key;
  a different body/date gets a different key. Revision identity cannot be reused
  as Create. Copy is a local draft action, not a new server mutation identity.
- Scope eight paths: apps/web/src/app/goals/GoalsClient.tsx,
  apps/web/src/app/goals/GoalsClient.state.test.ts,
  apps/mobile/src/recipes/GoalsScreen.tsx,
  apps/mobile/scripts/goals-nutrient-picker.test.mjs, this ADR, ADR index,
  build plan and additive release gates. Reuse existing component test harnesses.
  API/BFF/schema/parsers/helpers/dependencies/protected queues and general New,
  navigation or save behavior remain outside this slice.
- Require focused actual-component coverage for exact transfer, clean/dirty
  Keep/Discard, no requests/operations, all provenance exclusions, historical
  sources, active requests, stale/private/profile/route/date/before-paint guards,
  blank-date validation, explicit Create without If-Match/reference selection,
  exact ambiguous retries, distinct date/body and preserved accepted receipts.
  Include existing goal/recipe/reference helper and picker regressions, affected
  types/format and independent review before frozen canonical check/build/licenses.
  Record all failures, caches and optional skips; no dependency changes planned.
- Dedicated Chrome QA uses production Next and normal BFF authentication with an
  isolated loopback synthetic backend. Include all 15 core nutrients and actual
  14 non-energy targetable definitions; validate source parsers. Verify clean copy,
  dirty Keep/Discard, exact source fields, blank/date/Create, ambiguous Create
  replay, original saved values on earlier date, keyboard/390px and expiry.
  Journal zero-request local actions separately from explicit reads and bounded
  in-memory synthetic saves. No live catalogue/backend writes are authorized.
- Stop after source/local evidence, two in-task reviews, normal commit/non-force
  push under standing authorization, exact automatic observation and readiness/
  CURRENT handoff. Keep external Claude Code, concurrent React, assistive
  technology, real persistence, physical native/protected storage, hosted and
  release acceptance separate.

## Consequences and review triggers

Copy reduces repeated data entry while requiring a reviewed destination date.
Unknown provenance withholds the shortcut; existing manual editing is unchanged.
Revisit if saved-goal provenance, nullable metadata, goal interval uniqueness,
draft ownership or mutation/retry identity changes.


## Local evidence and limits (UTC 2026-09-14T04:19:03.043501+00:00)

Focused actual-component/helper checks, affected types/format and independent
source review passed. Fresh canonical `pnpm check`, `pnpm build` and
`pnpm licenses:check` passed: 946 web tests, 1386 native tests
plus 10 native runner checks, 157 root checks,
production Next and both native exports. All task graphs used zero cached tasks.
License policy covered 535 production packages with
14 reviewed exceptions. 89 optional integration cases remained skipped.

Dedicated Chrome QA passed with production Next/BFF and a loopback synthetic fixture containing all 15 core nutrients and 14 targetable definitions. Clean copy and dirty Keep/Discard preserved exact saved fields, null/zero meaning and nutrient search. The blank destination date required explicit entry. Local-action checkpoints remained 14→14, 14→14, 16→16, 26→26, with zero request deltas.

The fixture accepted one copied Create in memory and returned 503. Copying again locally and entering the same date preserved its exact body/key; explicit retry returned 201 as a replay without If-Match. Current/progress readback showed new version 1 and the earlier saved version 3 with unchanged values. Historical revisions stayed locked while local copies were editable. The 27 upstream requests include exactly 2 synthetic goal-write attempts (1 accepted change and 1 replay); there were no live backend writes.

Keyboard, 390px layout and expiry passed. The owned Chrome tab was closed, viewport reset, both verified test processes stopped and ports 3008/4008 absent. Concurrent React, assistive technology, real persistence, physical native/protected storage, external Claude Code, hosted and release acceptance remain separate.

Exact commands, hashes, reviews and browser/request evidence are outside Git in
the dated Windows readiness record. External acceptance remains separate.
