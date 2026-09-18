# ADR 0089: Recover explicitly from native custom-food revision conflicts

Status: Implemented at `956ccf1`; local and exact-commit automatic evidence passed. Device and release acceptance remain separate.

## Context

A native custom-food revision save rejected with HTTP 412 already preserves its
raw draft. However, the generic error asks the person to submit again for an
exact retry after deleting the pending operation ID. The next save still carries
the stale If-Match revision and cannot resolve the conflict. Recovery requires
refreshing all private data, locating the food and choosing Revise again.
This is a recovery gap, not a claim that the existing conflict erases edits.

## Decision and acceptance

For a current saved-revision 412, explain the conflict beside the editor and
retain the exact fields and nutrient composer. Retire only that rejected
operation. Do not automatically read, rebase, discard or save. Block another save
of the known-conflicted revision in both the rendered control and its callback;
local editing and guarded New, Copy and Revise choices remain available.
Ordinary draft edits and Refresh private data do not silently clear the conflict.

Offer **Discard edits and reload saved food** for the conflicted draft. This
explicit action reads that food through the existing private GET endpoint. Keep
the draft until the existing parser verifies a matching active food with a
strictly newer revision, then install its saved values. Malformed, mismatched,
older/equal, archived, network and ordinary failed responses retain the draft
and recovery action. A 401 still closes private data through the existing
unauthorized-session path. Reject a response older than a newer same-food row
already loaded. Successful recovery updates only a matching loaded row, retiring
that row's old detail disclosure while preserving other foods and list filters.
A later explicit save uses the fetched revision. New or another
explicit accepted replacement retires the obsolete conflict.

Recovery allocates no operation ID and performs no mutation. Bind the marker and
callbacks to the private/profile context, draft identity and request generation;
apply the existing abort, background and unmount guards. Retained actions or late
responses must not overwrite newer work. Expose disabled state accessibly.
Preserve unrelated logging, saved-food filters/details, trends, biometric and
reminder drafts. Existing ambiguous network/503/malformed-success retries retain
their exact body, operation ID and If-Match contract.

## Consequences, alternatives and review triggers

The person can keep and inspect attempted edits or explicitly reload current
saved values without searching the list again. There is no concurrent-edit merge,
automatic overwrite or new durable draft storage. A message-only fix leaves the
multi-step recovery; automatically refreshing or rebasing would replace work or
change save authority without the person's choice.

Only native editor behavior and its screen tests change. No API, schema, parser,
dependency, outbox, nutrition policy or release authority change is required.
No installation, local audit, paid review, service/browser/device or cloud action
is part of this slice. Revisit when revision identity, save/reload semantics,
private lifecycle or custom-food response contracts change.

## Validation

Use the existing actual-screen harness plus nutrient/response suites. First prove
new regressions against pre-change source: conflict copy/retention and blocked
stale saves, explicit successful recovery, failed/malformed/wrong-ID/stale/archived
recovery, private/request/draft stale callbacks, subsequent save revision and
unaffected ambiguous retries and independent drafts. Record original failures.
Run focused checks, native types, scoped Biome and independent source/prose review,
then canonical pnpm check and pnpm build on final reviewed source. Retain exact
three CI/nine actual container outcomes for the successor commit outside Git.
Hook-harness/export evidence is not concurrent React, physical-device,
assistive-technology or release acceptance.

Development evidence on September 18, 2026: the 551-case baseline passed.
New conflict and recovery regressions failed on pre-change source; original
failures and two corrected test-selector mistakes remain in outside-Git evidence.
Final focused validation passed 575 cases (456 actual-screen, 100 nutrient helper
and 19 response helper cases), with zero skips. Native types and scoped Biome
passed. Independent source/prose review found no open issue. Canonical pnpm check
passed with 1,951 fresh cases, 2,327 cached passes and 93 cached opt-in skips;
pnpm build passed eleven tasks with ten cached and fresh Android/iOS exports.
All three [CI jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35393690150)
and nine actual [container jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35393690051)
passed on attempt one at `956ccf145da513c2e89eacc7330d64be33cbd2da`.
The September 18 22:33 UTC official observation records all jobs; final clean,
equal local/tracking/live heads and seven reviewed file hashes were verified at
22:34 UTC. No installation, local audit or device action was run.
