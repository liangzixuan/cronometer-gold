# ADR 0088: Start a new native custom food without losing draft work

Status: Implemented at `be1390e`; local and exact-commit automatic evidence passed. Device and release acceptance remain separate.

## Context

The native private-food editor offers Cancel edit only when revising an existing
saved food. New and copied drafts have no action to start another blank food;
the user must clear all fields and nutrient inputs by hand. Copy and Revise
already protect unsaved raw work with an inline Keep/Discard choice. Extend
that established workflow to starting a new food.

## Decision and acceptance

Expose one **New custom food** action in the editor, replacing the revision-only
Cancel edit action. A pristine blank draft or unchanged saved revision starts
directly. Raw changes, copied content and unfinished nutrient composer input
require the existing inline replacement choice. Keep editing preserves exact
fields, whitespace, composer input and pending retry identity. **Discard draft
and start new food** explicitly installs the existing blank draft and composer.

Starting a blank food creates a new local creation intent without allocating an
operation ID, fetching data or submitting a request. Only a later explicit
Create private food action can persist it. Keep preserves an ambiguous save's
exact retry; a new creation intent cannot reuse an abandoned create's identity.
This does not retract an earlier request or claim its server outcome.

Reuse the existing captured-choice and private/request guards. New does not
depend on a selected saved food or a verified saved-food list. Copy and Revise
retain their existing source/list checks. A retained action must not replace
newer work after a draft/composer edit, another choice, refresh, pending request,
private/profile change, background transition or unmount. Expose disabled state
accessibly. Preserve saved-food filters/details, logging drafts and independent
trend, biometric and reminder inputs.

## Consequences, alternatives and review triggers

The editor has a consistent way to start over from either a new or saved draft.
Replacing Cancel edit avoids two competing reset controls. A second unguarded
clear button would bypass existing draft protection; requiring manual clearing
leaves the missing workflow unresolved. No general navigation confirmation or
cross-screen draft persistence is introduced.

No web, API, schema, dependency, outbox, nutrition policy or release authority
changes. No install, audit, paid external review, service/browser/device or cloud
action is part of this slice. Revisit when custom-food identity, create replay,
composer state or private lifecycle rules change.

## Validation

Use the existing actual-screen harness and custom-food nutrient/response suites.
Record new regressions failing on pre-change source before passing fixed source:
direct/dirty/copied/composer resets, exact Keep behavior, distinct subsequent
create intent, stale/busy/private-context actions and unrelated state retention.
Review source and documentation, run native types and scoped Biome check, then
canonical pnpm check and pnpm build on the final reviewed source. Record counts,
cache reuse, opt-in skips and all three CI/nine actual container job outcomes
for the exact successor commit in the dated outside-Git readiness record.
Hook-harness/native export evidence is not concurrent React, physical-device,
assistive-technology or release acceptance.

Development evidence on September 18, 2026: the 530-case baseline passed.
Twenty-one corrected New regressions failed against original source (411 existing
screen cases were deliberately filtered). Independent source review also proved
that repeated identical validation errors could stale an otherwise enabled New
callback without a render. A dedicated failing regression preceded the narrow
state-backed generation fix. The synchronous guard still rejects stale actions;
current controls repaint even when the validation message stays identical.

Final focused validation passed 551 cases (432 screen, 100 nutrient helpers and
19 response helpers), no skips; native types and scoped Biome check passed.
Original failures, corrected test-fixture failures and source-review resolution
remain in outside-Git evidence. Canonical pnpm check passed with 1,927 fresh
passes, 2,327 cached passes and 93 cached opt-in skips; pnpm build passed with
fresh Android/iOS exports. All three [CI jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35381644649)
and nine actual [container jobs](https://github.com/liangzixuan/cronometer-gold/actions/runs/35381644375)
passed on attempt one at `be1390e9b18322a6a1b9280dee948d7834b1ea9f`.
September 18 20:24 UTC official evidence records complete results; clean equal
local/tracking/live heads and all seven reviewed file hashes were reverified
at 20:25 UTC. No installation, local audit or device action was run.
