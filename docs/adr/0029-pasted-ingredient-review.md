# ADR 0029: Review a pasted ingredient list on web

- Status: Accepted; local validation passed; automatic and release evidence pending
- Date: 2026-09-09
- Scope: M4A new-recipe ingredient review using existing recipe contracts

## Context

The recipe builder already supports descriptions, instructions, exact food and
nested-recipe revisions, and measured or estimated final yield. People starting
from an ingredient list need a structured review step before adding ingredients.
A pasted line does not prove a food identity, gram weight or nutrient amount.

## Decision

Add a memory-only review panel to the web new-recipe builder. Accept at most 50
nonblank lines, 500 characters per original line and 25,050 characters in total.
Preserve original text, order and duplicates; ignore whitespace-only separators.
Reject excess input without truncating it or silently excluding ingredient lines.
Treat every line as untrusted text, never as HTML, code, an instruction or a URL
fetch request.

Each line starts unresolved. The user explicitly submits a separate food-search
query, chooses a pinned food version with visible source attribution, and enters
a positive exact decimal in grams or an available gram-resolved serving. Quantity
starts blank. Do not infer 100 grams, one serving, conversions, food identity or
nutrition from pasted text. Changing a reviewed choice invalidates its previous
confirmation. Existing recipe quantity contracts remain authoritative.

Require every retained line to be confirmed, then provide one explicit transfer
action. Revalidate the current account and append the confirmed ingredients to
the latest new-recipe draft. Check the combined 50-ingredient cap again at that
boundary. Preserve the existing name, instructions, description, ingredients,
yield and serving fields. Canceling review changes none of those fields. Saving
continues through the existing recipe API with its required final yield, exact
portion strings, immutable source versions and retry/receipt semantics.

Keep pasted text separate from ingredient notes and save payloads. Do not retain
it in browser storage, URLs, logs or a new server entity. Only the explicitly
submitted search query reaches the existing search route. Clear temporary review
state on successful transfer, cancel, session/owner closure and unmount. Raw text
is ordinary escaped UI content; the application does not make rights or accuracy
claims about material a user pastes.

Bind each search and transfer to the current review, line/query, owner and enabled
state. Abort and invalidate pending work on relevant changes; check again after
every asynchronous boundary, including JSON parsing. Stale responses, retained
handlers and StrictMode effect replay must not revive private state or append
twice. Fence parent recipe open/save responses by owner, request and builder
generation so they cannot overwrite a newer draft. Revalidate ownership around
save requests and private receipt installation. Aborting a request is not proof
that the server did not write; existing idempotency remains required.

## Acceptance

- Parse empty, mixed newline, whitespace, duplicate, exact-bound and excessive
  lists; preserve each retained original without normalization or truncation.
- Require an explicit valid amount; exercise exact decimal boundaries and foods
  with absent, zero or unusable serving gram weights. Keep source and version IDs.
- Confirm all lines once, append without losing prior fields/ingredients, and
  reject capacity changes or a replaced builder. Cancel never edits the draft.
- Deferred fetch/JSON tests cover query/line/choice changes, owner switches,
  disabled state, session closure, unmount, effect replay and repeated transfer.
  Parent tests cover stale open/save receipts and exact existing save payloads.
- Review the actual browser flow with synthetic data, including narrow layout,
  keyboard use, a failed search, retry and final draft transfer. Source checks,
  build and applicable exact-commit automatic evidence remain required.

## Local validation checkpoint

Implementation checkpoint `88930fe` preserves the final reviewed ingredient flow.
Canonical checks passed with 437 web tests and 157 root policy tests; the package
test graph completed 17/17 tasks (16 cached), and the production build completed
11/11 tasks (10 cached). Applicable license policy passed. Synthetic production
Next/BFF browser evidence covers exact original lines, explicit quantities,
cancel, search failure/retry, narrow layout, keyboard confirmation, final draft
transfer and session-expiry cleanup. It does not establish real API/database or
hosted acceptance. Final save payload/replay behavior is covered by component
tests; the synthetic browser fixture intentionally does not implement recipe POST.

The application bytes are pinned by the local final-validation manifest. This
status update changes explanatory prose only. Exact-commit automatic checks and
independent Claude Code/release review remain pending; do not call the feature
implemented under the build plan's definition before those applicable checks pass.

## Boundaries and consequences

This is explicit ingredient review, not automatic recipe interpretation. URL
import, automatic food creation, nutrition inference, AI services, private
sharing, new retained data and mobile UI are outside this slice. No API, schema,
dependency or source-rights gate is changed. Existing hosted, catalogue,
assistive-technology, physical-client, independent Claude Code and release gates
remain open where applicable. Synthetic browser/component proof does not replace
them. M3B's separate print acceptance remains recorded rather than waived by this
source sequencing.
