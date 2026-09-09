import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverMigrations,
  migrationSearchPath,
  selectMigrationSchemaFromSearchPath,
} from "../src/migrator.js";

describe("migration schema selection", () => {
  it.each(["default", "database", "user", "environment variable", "override"])(
    "uses public for a non-client %s search_path source",
    (source) => {
      expect(
        selectMigrationSchemaFromSearchPath({
          setting: 'attacker_owner, "$user", public',
          source,
        }),
      ).toBe("public");
    },
  );

  it("uses the first safe application schema from an explicit client search_path", () => {
    expect(
      selectMigrationSchemaFromSearchPath({
        setting: 'pg_catalog, pg_temp, "$user", scoped_fixture, public',
        source: "client",
      }),
    ).toBe("scoped_fixture");
    expect(migrationSearchPath("scoped_fixture")).toBe(
      "scoped_fixture, public, pg_catalog, pg_temp",
    );
    expect(migrationSearchPath("public")).toBe("public, pg_catalog, pg_temp");
  });

  it.each([
    "scoped_fixture,,public",
    '"scoped_fixture", public',
    "ScopedFixture, public",
    "scoped-fixture, public",
    "pg_toast, public",
    "information_schema, public",
  ])("fails closed for an unsafe client search_path: %s", (setting) => {
    expect(() => selectMigrationSchemaFromSearchPath({ setting, source: "client" })).toThrow(
      /Client search_path contains/u,
    );
  });

  it("rejects a client search_path containing only PostgreSQL-managed entries", () => {
    expect(() =>
      selectMigrationSchemaFromSearchPath({
        setting: '"$user", pg_catalog, pg_temp',
        source: "client",
      }),
    ).toThrow("Client search_path does not select an application migration schema");
  });
});

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

  it("adds an owner-scoped bounded manual activity ledger with immutable history", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0025_manual_activity_ledger.sql"),
      "utf8",
    );
    const activityFunctionSignatures = [
      "is_canonical_activity_name_v1(text)",
      "is_bounded_activity_energy_v1(numeric)",
      "validate_activity_revision_insert()",
      "guard_activity_entry_revision_delete()",
      "validate_activity_entry_head()",
      "validate_activity_revision_becomes_head()",
      "guard_activity_entry_update()",
      "guard_activity_entry_delete()",
      "enforce_activity_day_bounds()",
      "guard_activity_day_update()",
      "guard_activity_day_delete()",
      "guard_activity_operation_delete()",
    ];

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "86619894aeb5951b39d667a7bb2c7ff0133a09c59d94bcbaa0a58221d022b40f",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column)\b/iu);
    for (const table of [
      "activity_day",
      "activity_entry",
      "activity_entry_revision",
      "activity_operation",
    ]) {
      expect(migrationSql).toContain(`create table ${table}`);
    }
    for (const constraint of [
      "activity_day_user_fk",
      "activity_entry_user_fk",
      "activity_entry_day_owner_fk",
      "activity_entry_revision_user_fk",
      "activity_entry_revision_entry_owner_fk",
      "activity_entry_revision_day_owner_fk",
      "activity_entry_current_revision_fk",
      "activity_entry_revision_supersedes_fk",
      "activity_operation_user_fk",
      "activity_operation_entry_owner_fk",
    ]) {
      expect(migrationSql).toContain(`constraint ${constraint}`);
    }
    expect(migrationSql).toContain("char_length(value) between 1 and 120");
    expect(migrationSql).toContain("octet_length(value) <= 480");
    expect(migrationSql).toContain("duration_minutes between 1 and 1440");
    expect(migrationSql).toContain("value > 0 and value <= 20000");
    expect(migrationSql).toContain("scale(value) <= 3");
    expect(migrationSql).toContain("value::text = trim_scale(value)::text");
    expect(migrationSql).toContain("activity day exceeds 64 active entries");
    expect(migrationSql).toContain("activity revisions must form a contiguous append-only chain");
    expect(migrationSql).toContain("latest activity revision must become the logical entry head");
    expect(migrationSql).toContain("activity revision local date does not match its day bucket");
    expect(migrationSql).toContain("execute function validate_iana_time_zone()");
    expect(migrationSql).toContain("deleted_at is null or isfinite(deleted_at)");
    expect(migrationSql).toContain("on delete cascade");
    expect(migrationSql).toContain("target_schema name := pg_catalog.current_schema()");
    expect(migrationSql.match(/\bcreate\s+function\b/giu)).toHaveLength(
      activityFunctionSignatures.length,
    );
    expect(migrationSql.match(/set search_path = pg_catalog, %I, pg_temp/gu)).toHaveLength(
      activityFunctionSignatures.length,
    );
    for (const functionSignature of activityFunctionSignatures) {
      expect(migrationSql).toContain(
        `alter function %I.${functionSignature} set search_path = pg_catalog, %I, pg_temp`,
      );
    }
    expect(migrationSql).not.toMatch(/nutrition_goal|energy_adjustment/iu);
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

  it("pins the food-search source eligibility call chain without granting authority", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0016_food_search_function_hardening.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "bc1b9a38fc1fa6c85662720f4b7f137d18ed61160f5ed5ad75703dedad776033",
    );
    expect(migrationSql).toContain("target_schema name := pg_catalog.current_schema()");
    expect(migrationSql).toContain(
      "alter function %I.advance_food_search_projection_revision() set search_path = pg_catalog, %I, pg_temp",
    );
    expect(migrationSql).toContain(
      "alter function %I.enqueue_food_search_source_eligibility_change() set search_path = pg_catalog, %I, pg_temp",
    );
    expect(migrationSql).toContain("procedure_namespace_row.nspname = target_schema");
    expect(migrationSql).not.toMatch(/\b(?:grant|revoke)\b/iu);
    expect(migrationSql).not.toMatch(/\bsecurity\s+definer\b/iu);
    expect(migrationSql).not.toMatch(/\balter\s+(?:role|table|sequence)\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:drop|truncate)\b/iu);
  });

  it("pins the remaining food-search projection triggers without granting authority", async () => {
    const migrationSql = await readFile(
      resolve(
        import.meta.dirname,
        "../migrations/0017_food_search_projection_trigger_hardening.sql",
      ),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "b6b4a152c931a1b0c174fcd291ec1303032e4fede63842069936a2b031fd93e4",
    );
    expect(migrationSql).toContain("target_schema name := pg_catalog.current_schema()");
    expect(migrationSql).toContain(
      "procedure_row.proname = 'advance_food_search_projection_revision'",
    );
    expect(migrationSql).toContain(
      "d1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108",
    );
    expect(migrationSql).toContain(
      "food-search projection revision helper identity or hardened semantics differ",
    );
    expect(migrationSql).toContain("or (\n          procedure_namespace_row.nspname");
    for (const functionName of [
      "enqueue_food_search_barcode_insert",
      "enqueue_food_search_barcode_update",
      "enqueue_food_search_food_eligibility_change",
      "enqueue_food_search_serving_insert",
    ]) {
      expect(migrationSql).toContain(
        `alter function %I.${functionName}() set search_path = pg_catalog, %I, pg_temp`,
      );
    }
    expect(migrationSql.match(/\balter\s+function\b/giu)).toHaveLength(4);
    expect(migrationSql).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?function\b/iu);
    expect(migrationSql).toContain("procedure_namespace_row.nspname <> target_schema");
    expect(migrationSql).not.toMatch(/\b(?:grant|revoke)\b/iu);
    expect(migrationSql).not.toMatch(/\bsecurity\s+definer\b/iu);
    expect(migrationSql).not.toMatch(/\balter\s+(?:role|table|sequence)\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:drop|truncate)\b/iu);
  });

  it("installs the active nutrient registry reader/writer lock protocol", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0018_active_nutrient_registry_lock_protocol.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "85c1cb24b22ee76f0355ef01802fe91eca52835c706510e8d3dbcc8939f20d22",
    );
    expect(migrationSql).toContain("target_schema name := pg_catalog.current_schema()");
    expect(migrationSql).toContain(
      "pg_catalog.pg_advisory_xact_lock_shared(\n    pg_catalog.hashtext('nutrition-tracker:active-nutrient-registry:v1')",
    );
    for (const [functionName, sourceSha256] of [
      [
        "guard_active_nutrient_vector_size",
        "24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda",
      ],
      [
        "lock_active_nutrient_registry_before_write",
        "c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de",
      ],
      [
        "lock_active_nutrient_registry_for_read",
        "22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5",
      ],
      [
        "reconcile_recipe_components_v2",
        "c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a",
      ],
    ] as const) {
      expect(migrationSql).toContain(functionName);
      expect(migrationSql).toContain(sourceSha256);
      expect(migrationSql).toContain(
        `alter function %I.${functionName}() set search_path = pg_catalog, %I, pg_temp`,
      );
    }
    for (const triggerName of [
      "nutrient_active_vector_size_guard",
      "nutrient_registry_lock_before_active_update",
      "nutrient_registry_lock_before_insert",
      "recipe_ingredient_reconcile_v2",
      "recipe_nutrient_reconcile_v2",
      "recipe_source_reconcile_v2",
      "recipe_version_components_reconcile_v2",
    ]) {
      expect(migrationSql).toContain(triggerName);
    }
    expect(migrationSql).toContain(
      "create or replace trigger nutrient_registry_lock_before_active_update before update or delete on %I.nutrient",
    );
    expect(migrationSql).toContain("perform lock_active_nutrient_registry_for_read();");
    expect(migrationSql.match(/\bcreate\s+function\b/giu)).toHaveLength(1);
    expect(migrationSql).not.toMatch(/\bsecurity\s+definer\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:grant|revoke)\b/iu);
    expect(migrationSql).not.toMatch(/\balter\s+(?:role|table|sequence)\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:drop|truncate)\b/iu);
  });

  it("freezes identifier-only catalogue promotion and rollback authority", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0019_catalogue_promotion_rollback_authority.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "5e8cae5872e7c8c8e92b762a907de2a78850967e857f55461d8cc10ba79469ba",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    for (const frozenColumn of [
      "validated_food_document text",
      "validated_food_sha256 text",
      "validated_food_contract_version smallint",
      "nutrient_mapping_digest text",
      "nutrient_mapping_revision_ids jsonb",
    ]) {
      expect(migrationSql).toContain(frozenColumn);
    }
    for (const functionSignature of [
      "catalogue_promote_import_batch(uuid,text,text)",
      "catalogue_rollback_source_release(text,uuid,text,text)",
      "guard_food_source_release_activation_authority()",
    ]) {
      expect(migrationSql).toContain(functionSignature);
      expect(migrationSql).toContain(`set search_path = pg_catalog, %I, pg_temp`);
    }
    expect(migrationSql.match(/\bsecurity\s+definer\b/giu)).toHaveLength(2);
    expect(migrationSql).toContain("session_user::text");
    expect(migrationSql).toContain(
      "revoke all on function %I.guard_food_source_release_activation_authority() from public",
    );
    expect(migrationSql).toContain(
      "grant execute on function %I.catalogue_promote_import_batch(uuid,text,text) to nutrition_catalogue_promote_activate",
    );
    expect(migrationSql).toContain(
      "grant execute on function %I.catalogue_rollback_source_release(text,uuid,text,text) to nutrition_catalogue_rollback",
    );
    expect(migrationSql).toContain("accepts no food JSON");
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?(?:food|outbox_event)/iu,
    );
    expect(migrationSql).not.toMatch(/\bgrant\s+nutrition_catalogue_[a-z_]+\s+to\b/iu);
  });

  it("separates catalogue staging from validation with sealed fixed-purpose authority", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0020_catalogue_stage_validate_authority.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "55c6370dee779edec8e7d2bad529b328c9d9b41fa6b7160b5584e5d52f634374",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    for (const frozenColumn of [
      "staged_database_principal text",
      "staged_database_capability_role text",
      "staging_seal_sha256 text",
      "staging_sealed_at timestamptz",
      "validated_database_principal text",
      "validated_database_capability_role text",
    ]) {
      expect(migrationSql).toContain(frozenColumn);
    }
    for (const functionSignature of [
      "catalogue_stage_import_batch(text)",
      "catalogue_stage_import_record_chunk(uuid,bigint,text)",
      "catalogue_stage_import_parser_report(uuid,text)",
      "catalogue_observe_import_validation(uuid)",
      "catalogue_validate_import_batch(uuid,text,text,text)",
      "catalogue_compute_import_staging_seal(uuid)",
      "guard_food_import_batch_stage_validate_authority()",
      "guard_food_import_record_insert_before_staging_seal()",
      "guard_food_import_stage_checkpoint_before_staging_seal()",
    ]) {
      expect(migrationSql).toContain(functionSignature);
      expect(migrationSql).toContain("set search_path = pg_catalog, %I, pg_temp");
    }
    expect(migrationSql).toContain("validated_database_principal <> staged_database_principal");
    expect(migrationSql).toContain("catalogue staging seal can only be recorded once");
    expect(migrationSql).toContain("catalogue records cannot be appended after the staging seal");
    expect(migrationSql).toContain(
      "catalogue stage checkpoint cannot change after the staging seal",
    );
    expect(migrationSql).toContain("record_count not between 1 and 250");
    expect(migrationSql).toContain("if end_offset > 10000 then");
    expect(migrationSql).toContain("total_canonical_payload_bytes > 67108864");
    expect(migrationSql).toContain("pg_catalog.pg_column_size(observation) > 134217728");
    expect(migrationSql).toContain("'observationSha256', observation_sha256");
    expect(migrationSql).toContain("'parserEvidence', parser_evidence");
    expect(migrationSql).toContain("'stageCheckpoint', stage_checkpoint");
    expect(migrationSql).toContain(
      "grant usage on schema %I to nutrition_catalogue_stage, nutrition_catalogue_validate",
    );
    expect(migrationSql).toContain("grant execute on function %I.%s to nutrition_catalogue_stage");
    expect(migrationSql).toContain(
      "grant execute on function %I.%s to nutrition_catalogue_validate",
    );
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?(?:food|outbox_event)/iu,
    );
    expect(migrationSql).not.toMatch(/\bgrant\s+nutrition_catalogue_[a-z_]+\s+to\b/iu);
  });

  it("freezes independent database nutrition semantics before catalogue decisions", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0021_catalogue_nutrition_semantic_recheck.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "b9a737f006a2d3c12efaf50de3b55578e5eb24a768dbdde97ac6ca00990a16a0",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain("lock table food_import_batch in access exclusive mode");
    expect(migrationSql).toContain("lock table food_import_record in access exclusive mode");
    expect(migrationSql).toContain(
      "catalogue nutrition semantic migration found an unattested ready or promoting batch",
    );
    for (const frozenColumn of [
      "nutrition_semantic_contract_version smallint",
      "nutrition_semantic_sha256 text",
    ]) {
      expect(migrationSql).toContain(frozenColumn);
    }
    for (const identity of [
      "food_import_batch_nutrition_semantic_contract_check",
      "food_import_record_nutrition_semantic_contract_check",
      "food_import_batch_guard_nutrition_semantics",
      "food_import_record_guard_nutrition_semantics",
      "catalogue_attest_import_nutrition_semantics(uuid)",
      "catalogue_canonical_decimal_product(text,text)",
      "catalogue_compute_record_nutrition_semantics(bigint)",
      "catalogue_utf16_length(text)",
      "catalogue_validate_import_batch_v1(uuid,text,text,text)",
      "catalogue_record_import_approval_v1(uuid,text,text,text,text,text)",
      "catalogue_promote_import_batch_v1(uuid,text,text)",
      "catalogue_rollback_source_release_v1(text,uuid,text,text)",
    ]) {
      expect(migrationSql).toContain(identity);
    }
    expect(migrationSql).toContain(
      "catalogue approval requires prior nutrition semantic attestation",
    );
    expect(migrationSql).toContain(
      "catalogue promotion requires prior nutrition semantic attestation",
    );
    expect(migrationSql).toContain(
      "catalogue rollback target lacks one completed nutrition semantic attestation",
    );
    expect(migrationSql).toContain(
      "revoke all on function %I.catalogue_attest_import_nutrition_semantics(uuid) from public",
    );
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?(?:food|outbox_event)/iu,
    );
    expect(migrationSql).not.toMatch(/\bgrant\s+nutrition_catalogue_[a-z_]+\s+to\b/iu);
  });

  it("binds capability-mediated catalogue actors to authenticated database sessions", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0022_catalogue_authenticated_actor_binding.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "72b4a284b22e7ed497c759fe087ece6a97c5d459ecbac6a79e32ba5a50cb76ca",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain(
      "lock table food_import_approval, food_source_release_activation in access exclusive mode",
    );
    expect(migrationSql).toContain(
      "catalogue authenticated actor binding found capability-mediated audit labels that differ from database principals",
    );
    expect(migrationSql).toContain(
      "Preserve and adjudicate the historical audit rows; never rewrite or infer an authenticated actor.",
    );
    for (const constraint of [
      "food_import_approval_database_authority_check",
      "food_source_release_activation_database_authority_check",
    ]) {
      expect(migrationSql).toContain(constraint);
    }
    expect(migrationSql).toContain(
      "approval.principal_id is distinct from approval.database_principal",
    );
    expect(migrationSql).toContain(
      "activation.performed_by is distinct from activation.database_principal",
    );
    expect(migrationSql).toContain("and principal_id = database_principal");
    expect(migrationSql).toContain("and performed_by = database_principal");
    expect(migrationSql.match(/\beffective_principal_id\s*:=\s*case\b/giu)).toHaveLength(3);
    expect(
      migrationSql.match(
        /when\s+session_user::text\s*=\s*table_owner\s+then\s+p_external_principal_id\s+else\s+session_user::text/giu,
      ),
    ).toHaveLength(3);
    for (const ownerFunction of [
      "catalogue_record_import_approval_v1",
      "catalogue_promote_import_batch_v1",
      "catalogue_rollback_source_release_v1",
    ]) {
      expect(migrationSql).toMatch(
        new RegExp(`${ownerFunction}\\([\\s\\S]*?effective_principal_id`, "u"),
      );
    }
    expect(migrationSql.match(/\bcreate\s+or\s+replace\s+function\b/giu)).toHaveLength(3);
    expect(migrationSql).toContain(
      "alter function %I.%s set search_path = pg_catalog, %I, pg_temp",
    );
    expect(migrationSql).not.toMatch(
      /grant\s+(?:select|insert|update|delete|all)[\s\S]*?on\s+(?:table\s+)?(?:food|outbox_event)/iu,
    );
    expect(migrationSql).not.toMatch(
      /\b(?:grant|revoke)\s+nutrition_catalogue_[a-z_]+\s+(?:to|from)\b/iu,
    );
  });

  it("admits one immutable reviewed-reference candidate with deferred vector integrity", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0023_reviewed_reference_targets.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      "d162133908e62b4df43fd67ee91f8296e69fd47099bc2f8aaab0b3c737fba93c",
    );
    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain(
      "lock table nutrition_goal_version, nutrition_goal_target, nutrient in access exclusive mode",
    );
    expect(migrationSql).toContain("nutrition_goal_version_reference_identity_v1");
    expect(migrationSql).toContain("nutrition_goal_target_reference_metadata_v1");
    expect(migrationSql.match(/\) is true\);/gu)).toHaveLength(2);
    expect(migrationSql).toContain(
      "jsonb_typeof(assumptions #> '{referenceTargetSet,ageYears}') = 'number'",
    );
    expect(migrationSql).toContain("pg_catalog.pg_input_is_valid(");
    expect(migrationSql).toContain("version_row.policy_digest is null");
    expect(migrationSql).toContain("reconcile_goal_reference_vector_v1");
    expect(migrationSql).toContain("set search_path = pg_catalog, %I, pg_temp");
    expect(migrationSql.match(/deferrable initially deferred/giu)).toHaveLength(2);
    expect(migrationSql).not.toContain("nutrition_goal_version_reject_update_v1");
    expect(migrationSql).not.toContain("nutrition_goal_target_reject_update_v1");
    expect(migrationSql).toContain("reference goal must contain the complete 12-target vector");
    expect(migrationSql).toContain("custom goal targets cannot claim reference provenance");
    for (const identity of ["male-19-50", "female-19-50"]) {
      expect(migrationSql).toContain(identity);
    }
  });

  it("adds owner-bound full-day reorder idempotency without bypassing privacy cascades", async () => {
    const migrationSql = await readFile(
      resolve(import.meta.dirname, "../migrations/0024_diary_atomic_reorder.sql"),
      "utf8",
    );

    expect(migrationSql).not.toMatch(/\bdrop\s+(table|column|type|role)\b/iu);
    expect(migrationSql).not.toMatch(/\btruncate\b/iu);
    expect(migrationSql).toContain("operation in ('create', 'update', 'delete', 'reorder')");
    expect(migrationSql).toContain("foreign key (diary_entry_id, user_id)");
    expect(migrationSql).toContain("references diary_entry(id, user_id)");
    expect(migrationSql).toContain("on delete cascade");
    expect(migrationSql).toContain("lexicographically first participating entry");
  });
});
