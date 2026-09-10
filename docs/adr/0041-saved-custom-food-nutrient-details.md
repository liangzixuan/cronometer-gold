# ADR 0041: Inspect saved custom-food nutrients without editing

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer, device and release acceptance remain separate.

## Context

Web and native saved custom-food cards already receive complete parsed nutrient
snapshots, but show only identifying metadata and edit/log/archive actions.
Inspecting nutrients currently requires entering a revision draft. The named
targetable picker is incomplete and excludes energy; saved snapshot metadata is
the authority for this read-only view.

## Acceptance card

- User task: inspect the nutrients in a loaded private food's exact saved version
  without entering or changing a draft. Add explicit Show nutrients/Hide nutrients
  controls to active and archived saved cards on web and native, default closed.
- Display: retain saved nutrient order and show every saved row (up to 256),
  snapshot name/unit and explicit per-100-g basis with saved food/version context.
  Quantified values remain exact strings, including zero and long decimals; trace
  is visibly Trace, and unknown is visibly Unknown with its explicit Not reported,
  Not analyzed, Not applicable or Withheld reason. Energy and non-targetable rows
  remain visible. Never join the picker, parse editor text, round, convert, sort,
  calculate per-serving values, infer amounts or treat missingness as zero.
- Interaction: independent disclosures per saved food/version. Opening or closing
  is local and issues no request, Save, revision or logging operation. Multiple
  cards may be open. Toggling preserves custom/composer fields, active create/revise
  and log drafts, shared messages/busy state and exact unresolved body/key identity.
  Pending writes do not themselves prevent a current read-only disclosure.
- Current data: bind visibility and retained callbacks to the current private
  owner/session/lifecycle, installed list and exact live food/version snapshot.
  Paging preserves open unchanged rows and existing ordering/dedup/cursors; newly
  loaded or replaced versions start closed. A full private-data refresh closes
  details, even for the same version, without clearing unrelated drafts. Invalidate
  old Show/Hide controls synchronously when refresh starts; old snapshots cannot
  reopen while refresh is pending. A failed refresh leaves disclosures unavailable
  until a successful current installation; retain error/Retry or Refresh guidance
  and unrelated drafts. Removed records, accepted replacement versions, scope closure/replacement, background or
  unmount close details. Old controls cannot reveal a stale version or reopen old
  private data before effects install. Use a dedicated disclosure generation;
  custom-draft/composer generations must not be changed by Show/Hide.
- Presentation: accessible expanded state, clearly associated controls/content,
  native wrapping and keyboard-operable web buttons. Long names/units and exact
  200-character decimals stay readable at a 390-pixel viewport without horizontal
  overflow. Keep details within the matching saved card and give archived records
  the same read-only access. No layout/accessibility claims from mocks alone.
- Bounded integration: add only the detail state/rendering and list/private seams
  required to reject stale disclosure controls/data. Preserve existing mutation,
  archive, diary/outbox and unrelated retention protocols. Use the existing Retry
  and lifecycle full-refresh paths; no new ready-workspace refresh action. Initialize
  only the first pristine custom draft so typed metadata or intentionally emptied
  nutrient rows survive a same-mount retry/refresh. A concrete newly exposed blocker
  must be reviewed before expanding scope.
- Affected source: web HealthClient and actual-component tests, native
  RetentionScreen and its actual-component tests; focused styles if needed;
  this ADR/index, roadmap and additive release gates. No endpoint, contract/schema,
  registry, dependency, storage, outbox, nutrition math or workflow change.
- Evidence: actual web/native component tests for all states, exact source order,
  complete/duplicate-name/energy rows, no-request toggles, draft/log/retry
  independence, paging/full-refresh/replacement and stale scope/lifecycle controls;
  affected types/format and independent review. Frozen canonical check/build/
  licenses, fresh web/native outputs, and synthetic actual web/BFF Chrome proof
  of saved values, active/archived cards, paging, dirty draft/log preservation,
  version/expiry, keyboard and 390-pixel layout. Actual-component tests prove
  same-mount full-refresh/Retry draft preservation; browser remount does not. Keep fixtures outside Git
  with normal auth/origin/parsers; no real account data or production mutation.
- Stop: reviewed source and applicable local evidence pass, normal commit and
  non-force push under standing authorization, exact automatic observations and
  compact readiness recorded. Mocks, exports and synthetic browser proof do not
  replace concurrent React, real persistence, assistive technology, physical native,
  external Claude Code, hosted, signed-device or release acceptance.

## Decision

Render disclosure content from the loaded saved snapshot, independently of editors.
Preserve the list while providing a direct inspection path with no new requests.

## Alternatives and consequences

Reusing Revise mutates editor context. Joining targetable names omits saved energy
and other supported IDs. A new detail endpoint is unnecessary for the already
loaded snapshot. Full refresh intentionally collapses details so replacement
snapshots require a fresh inspection action; ordinary paging preserves them.

## Review triggers

Revisit before editing within details, nutrient sorting/filtering, per-serving
calculations, retained disclosure preferences or a changed snapshot contract.

## Local evidence and limits (2026-09-10)

Independent in-task source review passed after removing the proposed ready-workspace
refresh action: coordinating a new full refresh with unrelated writes would exceed
this read-only slice. Existing Retry/lifecycle paths retain synchronous disclosure
invalidation and first-pristine custom-draft initialization. No new mutation or
request coordination protocol remains.

Focused web checks passed 46 tests; native checks passed 164
screen/route/helper/response tests. Affected types and formatting passed. Frozen
canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed with fresh
web/native tests, types and builds: 655 web tests,
1006 native tests plus 10 runner checks,
157 root tests, and 535 production packages with
14 reviewed license exceptions. Both native exports built.

Synthetic Chrome used the actual production web/BFF and source-parsed loopback
responses. It covered exact saved values and all missingness states, active and
archived cards, unchanged open cards through overlapping pages, no-request
disclosures, dirty custom/log fields, keyboard and 390-pixel wrapping, a fresh
saved version after remount, failed-load Retry preserving typed metadata, and
expired-session closure. The named picker was intentionally empty; saved energy
and non-targetable rows remained inspectable. No domain write occurred.

Actual-component fixtures establish retained controls, retry-body/key independence
and same-mount lifecycle refresh semantics. Browser remount is not evidence of
unsaved draft persistence. Mocks/exports and synthetic web responses do not prove
concurrent React, real persistence, assistive technology, physical native,
independent Claude Code, hosted or release acceptance. Exact raw evidence is kept
outside Git in the Windows readiness handoff.
