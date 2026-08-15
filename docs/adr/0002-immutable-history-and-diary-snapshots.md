# ADR 0002: Immutable revisions and diary snapshots

- Status: Accepted
- Date: 2026-08-15
- Owners: Domain and data engineering

## Context

Foods, serving measures, recipes, equations, nutrient targets, and source records
change. If a diary reads the latest mutable record, yesterday's totals can change
without user action. That breaks trust, exports, debugging, scientific review, and
support. At the same time, privacy deletion must remain possible.

## Decision

1. `food`, `recipe`, and `nutrition_goal` are stable roots. Material changes create
   a new numbered version; the root's current-version pointer changes atomically.
2. Food nutrient values and servings belong to an exact food version. Recipe
   ingredients point to exact food/recipe versions. Goal nutrient targets belong
   to an exact goal version.
3. Logging resolves quantity, serving conversion, nutrient amounts, source-release
   references, and calculation-engine version in one transaction. The resolved
   nutrient vector is copied into `diary_entry_nutrient_snapshot`.
4. Source corrections affect future selections. Recalculation of history is an
   explicit user operation that creates a replacement/audit event; it never edits
   a snapshot silently.
5. Version and snapshot rows reject in-place updates. Controlled deletion remains
   technically possible for privacy and retention workflows; database roles and
   application authorization restrict it in production.
6. Numeric storage uses exact decimal values and explicit units/bases. An absent
   nutrient row is unknown, while a stored zero is known zero.
7. Writes use client operation IDs and database transactions so retries are
   idempotent. Domain mutations and their outbox events commit together.

## Consequences

- Diary rendering remains stable when an upstream release or personal recipe changes.
- Storage grows with versions and snapshots; retention and partitioning will be
  measured before optimization.
- “Current” joins are explicit and cannot be used for historical calculation.
- Support can reconstruct a result from the snapshot, provenance, and engine version.
- Erasure requires a deliberate dependency-ordered job rather than ad hoc deletes.

## Rejected alternatives

- Mutable nutrient rows plus timestamps cannot reproduce values after corrections.
- Recomputing every report from current foods is simpler but silently rewrites history.
- JSON-only snapshots without canonical nutrient IDs make aggregation and migration
  harder; the relational snapshot table keeps both queryability and provenance JSON.

## Review triggers

- Snapshot volume threatens the database SLO or retention budget.
- A regulatory or clinical use requires stronger record retention/signing.
- Collaborative recipes introduce branching or merge semantics.
- The product adds user-visible historical recalculation.
