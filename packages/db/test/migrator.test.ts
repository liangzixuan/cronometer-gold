import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "../src/migrator.js";

describe("forward migration discovery", () => {
  it("loads migrations in lexical order and records a stable checksum", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "nutrition-db-migrations-"));
    await writeFile(resolve(directory, "0002_second.sql"), "select 2;\n", "utf8");
    await writeFile(resolve(directory, "0001_first.sql"), "select 1;\n", "utf8");
    await writeFile(resolve(directory, "notes.md"), "ignored", "utf8");

    const migrations = await discoverMigrations(directory);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(migrations[0]?.checksum).toBe(createHash("sha256").update("select 1;\n").digest("hex"));
  });

  it("rejects transaction control inside a migration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "nutrition-db-migrations-"));
    await writeFile(resolve(directory, "0001_invalid.sql"), "BEGIN;\nselect 1;\nCOMMIT;\n", "utf8");

    await expect(discoverMigrations(directory)).rejects.toThrow("must not manage transactions");
  });

  it("keeps the initial schema forward-only and covers the required aggregates", async () => {
    const migrationPath = resolve(
      import.meta.dirname,
      "../migrations/0001_initial_domain_schema.sql",
    );
    const migrationSql = await readFile(migrationPath, "utf8");

    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type)\b/i);
    expect(migrationSql).not.toMatch(/\btruncate\b/i);

    for (const table of [
      "app_user",
      "user_profile",
      "food_source",
      "food_source_release",
      "nutrient",
      "food",
      "food_version",
      "food_nutrient_value",
      "food_serving",
      "food_barcode",
      "recipe",
      "recipe_version",
      "recipe_ingredient",
      "diary",
      "diary_entry",
      "diary_entry_nutrient_snapshot",
      "nutrition_goal",
      "nutrition_goal_version",
      "nutrition_goal_target",
      "audit_log",
      "outbox_event",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
  });

  it("adds resumable catalogue ingestion without requiring approval before validation", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0002_catalogue_ingestion.sql"),
      "utf8",
    );

    for (const table of [
      "food_import_batch",
      "food_import_approval",
      "food_import_record",
      "food_import_checkpoint",
      "food_source_release_activation",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
    const batchDefinition = migrationSql.slice(
      migrationSql.indexOf("create table food_import_batch"),
      migrationSql.indexOf("create table food_import_approval"),
    );
    expect(batchDefinition).not.toContain("promotion_approved");
    expect(migrationSql).toContain("approval_role in ('data', 'quality', 'rights')");
    expect(migrationSql).toContain("rights_manifest_sha256");
    expect(migrationSql).toContain("create trigger food_nutrient_value_reject_delete");
    expect(migrationSql).toContain("create trigger food_serving_reject_delete");
    expect(migrationSql).toContain("create trigger diary_entry_nutrient_snapshot_guard_delete");
    expect(migrationSql).toContain(
      "status not in ('ready', 'promoting', 'completed', 'quarantined') or validated_at is not null",
    );
    expect(migrationSql).toContain(
      "old.status = 'ready' and new.status in ('failed', 'promoting')",
    );
  });

  it("adds a fail-closed promoted food-search read model and supporting indexes", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0003_promoted_food_search.sql"),
      "utf8",
    );

    expect(migrationSql).toContain("create view promoted_food_search_catalogue_v1");
    expect(migrationSql).toContain("version.id = food.current_version_id");
    expect(migrationSql).toContain("source.active_release_id = version.source_release_id");
    expect(migrationSql).toContain("record.validation_status = 'materialized'");
    expect(migrationSql).toContain("release.status = 'promoted'");
    expect(migrationSql).toContain("food_version_search_text_trgm_idx");
    expect(migrationSql).toContain("food_import_record_materialized_version_idx");
    expect(migrationSql).toContain("food_barcode_gtin14_market_current_idx");
    expect(migrationSql).toContain("dead_lettered_at");
    expect(migrationSql).toContain("food_search_rebuild_outbox_pending_idx");
  });

  it("adds opaque auth sessions and an append-only diary revision model", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0004_diary_accounts_and_revisions.sql"),
      "utf8",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    for (const table of [
      "user_password_credential",
      "user_session",
      "diary_entry_revision",
      "diary_entry_revision_nutrient",
      "diary_operation",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
    expect(migrationSql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(migrationSql).toContain("reject_immutable_row_update");
    expect(migrationSql).toContain("diary_unknown_reasons_match");
    expect(migrationSql).toContain("diary entry head must advance exactly one revision");
    expect(migrationSql).toContain("source_release_id uuid");
    expect(migrationSql).toContain(
      "case when entry.deleted_at is null then 'create' else 'delete' end",
    );
  });

  it("adds bounded email-verification credentials without persisting raw tokens", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0008_email_verification.sql"),
      "utf8",
    );

    expect(migrationSql).toContain("create table auth_action_token");
    expect(migrationSql).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(migrationSql).toContain("email_hash ~ '^[0-9a-f]{64}$'");
    expect(migrationSql).toContain("unique (user_id, purpose)");
    expect(migrationSql).toContain("purpose in ('email_verification')");
    expect(migrationSql).toContain("consumed_at is null or consumed_at < expires_at");
    expect(migrationSql).not.toMatch(/raw_token|token_value|token_plaintext/iu);
  });
});
