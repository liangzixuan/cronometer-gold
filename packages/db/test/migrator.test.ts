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

  it("extends the digest-only action credential for password recovery", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0009_password_recovery.sql"),
      "utf8",
    );

    expect(migrationSql).toContain("drop constraint auth_action_token_purpose_check");
    expect(migrationSql).toContain("purpose in ('email_verification', 'password_recovery')");
    expect(migrationSql).not.toMatch(/raw_token|token_value|token_plaintext/iu);
    expect(migrationSql).not.toMatch(/create table|drop table|drop column/iu);
  });

  it("adds an owner-scoped bounded hydration ledger with immutable history", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0010_hydration_ledger.sql"),
      "utf8",
    );

    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column)\b/iu);
    for (const table of [
      "hydration_day",
      "hydration_entry",
      "hydration_entry_revision",
      "hydration_operation",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
    for (const constraint of [
      "hydration_day_user_fk",
      "hydration_entry_user_fk",
      "hydration_entry_day_owner_fk",
      "hydration_entry_revision_user_fk",
      "hydration_entry_revision_entry_owner_fk",
      "hydration_entry_revision_day_owner_fk",
      "hydration_entry_current_revision_fk",
      "hydration_operation_user_fk",
      "hydration_operation_entry_owner_fk",
    ]) {
      expect(migrationSql).toContain(`constraint ${constraint}`);
    }
    expect(migrationSql).toContain("amount_milliliters between 1 and 20000");
    expect(migrationSql).toContain("active_count > 64");
    expect(migrationSql).toContain("active_total > 100000");
    expect(migrationSql).toContain("hydration revisions must form a contiguous append-only chain");
    expect(migrationSql).toContain("latest hydration revision must become the logical entry head");
    expect(migrationSql).toContain("hydration revision local date does not match its day bucket");
    expect(migrationSql).toContain("execute function validate_iana_time_zone()");
    expect(migrationSql).toContain("deleted_at is null or isfinite(deleted_at)");
    expect(migrationSql).toContain("on delete cascade");
  });

  it("binds new catalogue attempts and releases to immutable acquisition evidence", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0011_food_import_evidence_binding.sql"),
      "utf8",
    );

    for (const field of [
      "release_class",
      "evidence_bundle_sha256",
      "evidence_bundle_uri",
      "evidence_decision_sha256",
      "evidence_object_version_id",
      "evidence_valid_until",
    ]) {
      expect(migrationSql).toContain(field);
    }
    expect(migrationSql.match(/default 'legacy-unbound'/gu)).toHaveLength(2);
    expect(migrationSql.match(/alter column release_class drop default/gu)).toHaveLength(2);
    expect(migrationSql).toContain("restore the pre-migration database backup to roll");
    expect(migrationSql).toContain("never fabricate or upgrade");
    expect(migrationSql).toContain(
      "release_class in ('live-reviewed', 'fixture-nonrelease', 'legacy-unbound')",
    );
    expect(migrationSql).toMatch(
      /unique \(\s*food_source_id,\s*release_key,\s*artifact_sha256,\s*parser_version,\s*evidence_bundle_sha256\s*\)/u,
    );
    expect(migrationSql).toContain("new catalogue provenance cannot be legacy-unbound");
    expect(migrationSql).toContain("food_import_batch_reject_new_legacy_unbound");
    expect(migrationSql).toContain("food_source_release_reject_new_legacy_unbound");
    expect(migrationSql).toContain(
      "only a promoted live-reviewed catalogue release may become active",
    );
    expect(migrationSql.match(/new\.evidence_bundle_sha256/gu)).toHaveLength(2);
    expect(migrationSql.match(/new\.evidence_valid_until/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(migrationSql).toContain("food_import_approval_guard_authority");
    expect(migrationSql).toContain("food_import_batch_fixture_authority_check");
    expect(migrationSql).toContain("food_source_release_promoted_authority_check");
    expect(migrationSql).toContain("new.evidence_valid_until <= clock_timestamp()");
    expect(migrationSql).toContain("catalogue_evidence_bundle_uri_is_valid");
    expect(migrationSql).toContain("([^/?#]+/)*sha256/");
    expect(migrationSql.match(/evidence_bundle_sha256 is not null/gu)).toHaveLength(2);
    expect(migrationSql).toContain("octet_length(evidence_object_version_id) <= 1024");
    expect(migrationSql).toContain("clock_timestamp() + interval '24 hours'");
    expect(migrationSql).toContain(
      "new catalogue evidence must be current and no more than 24 hours ahead at insertion",
    );
    expect(migrationSql).toContain("food import approval references an unknown batch");
    expect(migrationSql).toContain("active catalogue release does not belong to the food source");
    expect(migrationSql).not.toMatch(/set\s+evidence_(?:bundle|decision|object|valid)/iu);
  });

  it("fully validates only migration-grandfathered legacy promotions", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0012_food_source_release_legacy_grandfather.sql"),
      "utf8",
    );

    expect(migrationSql).toContain(
      "where release_class = 'legacy-unbound'\n  and status = 'promoted'",
    );
    expect(migrationSql).toContain("disable trigger food_source_release_guard_update");
    expect(migrationSql).toContain("enable trigger food_source_release_guard_update");
    expect(migrationSql).toContain("legacy_promotion_grandfathered_at is not null");
    expect(migrationSql).toContain("release_class = 'live-reviewed'");
    expect(migrationSql).toContain("grandfather marker is migration-owned and immutable");
    expect(migrationSql).not.toMatch(/\bnot\s+valid\b/iu);
  });

  it("hardens evidence fields and direct-insert authority state", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0013_food_release_authority_hardening.sql"),
      "utf8",
    );

    expect(migrationSql).toContain(
      "create or replace function catalogue_evidence_bundle_uri_is_valid",
    );
    expect(migrationSql).toContain("[A-Za-z0-9_-][A-Za-z0-9._~-]*");
    expect(migrationSql).toContain(
      "existing food import batch has a non-canonical evidence bundle URI",
    );
    expect(migrationSql).toContain("new food import batch must begin in staging");
    expect(migrationSql).toContain("new food source release must begin imported");
    expect(migrationSql).toContain(
      "new food source must start without an active catalogue release",
    );
    expect(migrationSql).toContain("before insert on food_source");
    expect(migrationSql).not.toMatch(/\bnot\s+valid\b/iu);
  });

  it("expands catalogue workflow authority without granting shared-table access", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0014_catalogue_workflow_authority_expand.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "a3539efa7fef4591ac3f4431e743d77e0ad12a9340c62ad4c315cf9802aa099c",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain("restore the pre-migration database backup");
    expect(migrationSql).toContain("pg_advisory_xact_lock");
    expect(migrationSql).toContain("pg_catalog.pg_auth_members");
    expect(migrationSql).toContain("membership.member = capability_role_oid");
    expect(migrationSql).toContain("membership.roleid = capability_role_oid");
    expect(migrationSql).toContain("membership.admin_option");
    expect(migrationSql).toContain("pg_catalog.pg_shdepend");
    expect(migrationSql).toContain("pg_catalog.aclexplode");
    for (const role of [
      "nutrition_catalogue_stage",
      "nutrition_catalogue_validate",
      "nutrition_catalogue_approve_data",
      "nutrition_catalogue_approve_quality",
      "nutrition_catalogue_approve_rights",
      "nutrition_catalogue_promote_activate",
      "nutrition_catalogue_rollback",
    ]) {
      expect(migrationSql).toContain(`'${role}'`);
    }
    for (const attribute of [
      "nologin",
      "nosuperuser",
      "nocreatedb",
      "nocreaterole",
      "noreplication",
      "nobypassrls",
    ]) {
      expect(migrationSql).toContain(attribute);
    }
    expect(migrationSql).toContain("add column validation_digest text");
    expect(migrationSql).toContain(
      "catalogue authority expansion found active live-reviewed batches without a frozen validation digest",
    );
    expect(migrationSql).toContain("do not fabricate a validation digest");
    expect(migrationSql).toContain("add column database_principal text");
    expect(migrationSql).toContain("add column database_capability_role text");
    expect(
      migrationSql.match(/database_capability_role is not null/gu)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(migrationSql).toContain("food_import_approval_database_principal_unique");
    expect(migrationSql).toContain("where database_principal is not null");
    expect(migrationSql).toContain("create function catalogue_record_import_approval(");
    for (const argument of [
      "p_batch_id uuid",
      "p_requested_approval_role text",
      "p_validation_digest text",
      "p_rights_digest text",
      "p_external_principal_id text",
      "p_approval_reference text",
    ]) {
      expect(migrationSql).toContain(argument);
    }
    expect(migrationSql).toContain("returns boolean");
    expect(migrationSql).toContain("security definer");
    expect(migrationSql).toContain("session_user::text");
    expect(migrationSql).toContain("must hold exactly one catalogue reviewer capability");
    expect(migrationSql).toContain("batch.validation_digest");
    expect(migrationSql).toContain("batch.rights_manifest_sha256");
    expect(migrationSql).toContain("current_schema()");
    expect(migrationSql).toContain("set search_path = pg_catalog, %I, pg_temp");
    expect(migrationSql).toContain(
      "revoke all on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) from public",
    );
    expect(migrationSql).toContain(
      "grant execute on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text)",
    );
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?food_/iu,
    );
  });

  it("hardens the catalogue EXPAND boundary with a forward correction", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0015_catalogue_authority_expand_hardening.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "cd5855e2568c0c31891b5a116f5f8e94489f4ff413b3a37bee0b07472567bbde",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain("capability_role.oid = membership.roleid");
    expect(migrationSql).not.toContain("membership.admin_option");
    expect(migrationSql).toContain("has_incoming_capability_membership");
    expect(migrationSql).toContain("has_legacy_activation_authority_rows");
    expect(migrationSql).toContain("reviewer EXECUTE remains disabled");
    expect(migrationSql).toContain("this migration never changes memberships");
    expect(migrationSql).not.toContain("has pre-existing members");
    expect(migrationSql).not.toMatch(/\bgrant\s+nutrition_catalogue_[a-z_]+\s+to\b/iu);
    expect(migrationSql).not.toMatch(/\brevoke\s+nutrition_catalogue_[a-z_]+\s+from\b/iu);
    expect(migrationSql).toContain("food_source_release_activation_expand_audit_null_check");
    expect(migrationSql).toContain(") not valid;");
    expect(migrationSql).toContain(
      "validate constraint food_source_release_activation_expand_audit_null_check",
    );
    expect(migrationSql).toContain("readiness stays blocked pending a reviewed forward repair");
    expect(migrationSql).toContain(
      "database_principal is null and database_capability_role is null",
    );
    expect(migrationSql).toContain(
      "cross join lateral pg_catalog.aclexplode(procedure_row.proacl)",
    );
    expect(migrationSql).toContain("acl.grantee <> 0");
    expect(migrationSql).toContain("expected_acl_count");
    expect(migrationSql).toContain("acl.grantor = function_owner");
    expect(migrationSql).toContain("guard_food_import_approval_authority()");
    expect(migrationSql).toContain(
      "catalogue approval guard function ACL is not the exact owner-only policy",
    );
    expect(migrationSql).toContain(
      "catalogue approval function ACL is not the exact owner-and-reviewer policy",
    );
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?food_/iu,
    );
  });
});
