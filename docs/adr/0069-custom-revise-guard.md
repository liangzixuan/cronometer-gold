# ADR 0069: Protect unsaved custom-food drafts when revising

Status: Source and applicable local gates complete; exact-commit automatic, external reviewer and release acceptance remain separate.

## Context and acceptance card

Choosing Revise on a saved food immediately replaces the editor on web and native.
This discards unsaved raw fields; native also clears unappended nutrient inputs.
Copy already protects dirty work with a local Keep/Discard choice.

- User task: open a saved revision without accidentally losing current work.
  Reuse the existing confirmation for Copy and Revise, carrying the requested
  action and exact captured food/version together. Show the saved name/version,
  Keep editing and Discard draft and revise for a pending revision.
- Pristine blank and unchanged saved drafts open directly. Raw equality with the
  existing clean baseline remains authoritative; copied unsaved drafts remain
  dirty. Any nonblank native composer input also requires confirmation.
- Keep editing dismisses only the current choice, preserving exact raw fields,
  native composer scratch, baseline and operation identity. Explicit current
  Discard installs the captured saved draft with its ID/revision and clean
  baseline. Only accepted Copy advances the creation intent. No local requests
  or operation allocation; actual writes still require explicit Save.
- Reuse and retain current draft/generation, source receipt/list, private/profile,
  lifecycle and pending-save guards. Raw edit/restore, composer edit, refreshed
  source or competing Copy/Revise choices invalidate retained confirmation
  callbacks. Keep web save-time local editing and native busy/write policy.
  Preserve exact revision payload/retry and Copy/create identity. Web keeps focus
  on the safe Keep action when asking and may focus Name after accepted Revise;
  native reuses editor scrolling. Do not change independent filters/details/logs.
- Scope: web HealthClient and native RetentionScreen with their existing actual
  component suites; this ADR/index, build plan and additive release gates. No
  helper/API/parser/storage/dependency/shared-style or service contract change.
- Evidence: compact raw dirty-new/revision/copied and native composer-only cases,
  clean direct path, Keep/Discard and exact revision identity, superseded/ABA/
  source/private callbacks and existing pending-save/retry/Copy regressions.
  Affected types/format and independent review precede frozen canonical check,
  build/licenses and both native exports. Production synthetic Chrome with the
  complete core registry verifies both choices, exact fields/version, no requests,
  keyboard/narrow layout, expiry and owned cleanup before final review/delivery.
- Stop after source/local gates, final review, normal commit/non-force push,
  exact-commit automatic observation and dated readiness. Synthetic component/
  BFF/browser proof does not establish real persistence, all concurrent React
  interleavings, assistive technology, physical devices, external Claude Code,
  hosted or release acceptance. No cloud or workflow control is included.

## Decision and consequences

Generalize the current local replacement choice rather than introducing a second
confirmation state machine. The action belongs to the captured choice so a later
card or competing action cannot redirect its approval. Revisit if baseline,
source ownership, composer scratch or save/retry semantics change.

## Local evidence and limits (2026-09-14)

Web and native now ask before Revise replaces unsaved custom-food work. The
existing local choice captures Copy or Revise with the exact saved food/version.
Keep preserves raw fields and native composer scratch; current Discard installs
that revision. Clean drafts open directly, copied drafts remain dirty and only
accepted Copy advances the creation intent. Existing private/source/draft guards,
pending-save policies and exact save/retry remain intact. Focused component and
helper checks, affected types/format and independent source review passed.

Frozen canonical `pnpm check`, `pnpm build` and `pnpm licenses:check` passed:
1008 web tests, 1460 native tests plus 10 runner checks,
157 root checks, production Next and both native exports. Zero cached tasks;
535 production licenses/14 reviewed exceptions; 89 optional
integration cases remained skipped.

Production Next/BFF dedicated Chrome proof used complete core definitions and
verified the named revision choice, safe Keep focus and exact raw preservation,
current Discard installing the saved revision, clean direct access, keyboard and
narrow layout. Local choices issued no requests. Expiry and owned tab/process
cleanup passed. Native component checks and exports remain separate from device
or assistive-technology acceptance.

Exact commands, times, versions, source/build hashes, reviews and automatic state
are in Windows readiness outside Git. Synthetic hook/browser evidence does not
prove real persistence, every concurrent React interleaving, assistive technology,
native device, external Claude Code, hosted or release acceptance.
