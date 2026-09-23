import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";

import { replayExternalErasureLedgerEntry } from "../src/retention.js";
import type { Database } from "../src/types.js";

// Fixed catalog responses for the post-0030 schema. The test exercises the public
// erasure entry point and stops after classification, before any data mutation.
// PostgreSQL integration tests remain responsible for discovering the real FKs.
const LINKED_TABLES = [
  "account_erasure_job",
  "account_erasure_receipt",
  "activity_day",
  "activity_entry",
  "activity_entry_revision",
  "activity_operation",
  "app_user",
  "audit_log",
  "auth_action_token",
  "biometric_definition",
  "biometric_definition_operation",
  "biometric_definition_version",
  "biometric_event",
  "biometric_event_operation",
  "biometric_event_revision",
  "catalogue_preparation_record_v2",
  "catalogue_validation_record_v2",
  "custom_food",
  "custom_food_operation",
  "custom_food_version",
  "custom_food_version_nutrient",
  "device_registration",
  "diary",
  "diary_day_note",
  "diary_day_note_operation",
  "diary_day_note_revision",
  "diary_entry",
  "diary_entry_nutrient_snapshot",
  "diary_entry_revision",
  "diary_entry_revision_nutrient",
  "diary_entry_revision_source",
  "diary_operation",
  "food",
  "food_barcode",
  "food_import_record",
  "food_nutrient_value",
  "food_serving",
  "food_version",
  "hydration_day",
  "hydration_entry",
  "hydration_entry_revision",
  "hydration_operation",
  "nutrition_goal",
  "nutrition_goal_operation",
  "nutrition_goal_target",
  "nutrition_goal_version",
  "platform_health_import",
  "platform_health_import_conflict",
  "platform_health_import_revision",
  "platform_import_batch",
  "platform_integration",
  "platform_integration_version",
  "privacy_export_artifact",
  "privacy_export_artifact_deletion",
  "privacy_export_artifact_tombstone",
  "privacy_export_download_audit",
  "privacy_export_entity_snapshot",
  "privacy_export_job",
  "privacy_export_record",
  "privacy_export_upload_artifact",
  "reauthentication_proof",
  "recipe",
  "recipe_ingredient",
  "recipe_operation",
  "recipe_version",
  "recipe_version_nutrient",
  "recipe_version_source",
  "reminder_consent",
  "reminder_consent_version",
  "reminder_delivery_outbox",
  "reminder_schedule",
  "reminder_schedule_version",
  "retention_operation",
  "security_challenge",
  "user_data_watermark",
  "user_password_credential",
  "user_profile",
  "user_session",
];
const RELATIONSHIPS: readonly (readonly [string, string, string, string, boolean])[] = [
  ["account_erasure_job", "app_user", "account_erasure_job_user_id_fkey", "n", false],
  [
    "account_erasure_receipt",
    "account_erasure_job",
    "account_erasure_receipt_job_id_fkey",
    "r",
    true,
  ],
  ["activity_day", "app_user", "activity_day_user_fk", "c", true],
  ["activity_entry", "activity_day", "activity_entry_day_owner_fk", "c", true],
  [
    "activity_entry_revision",
    "activity_entry",
    "activity_entry_revision_entry_owner_fk",
    "c",
    true,
  ],
  ["activity_operation", "activity_entry", "activity_operation_entry_owner_fk", "c", true],
  [
    "biometric_definition_operation",
    "biometric_definition",
    "biometric_definition_operation_definition_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "biometric_definition_version",
    "biometric_definition",
    "biometric_definition_version_definition_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "biometric_event_operation",
    "biometric_event",
    "biometric_event_operation_event_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "biometric_event_revision",
    "biometric_event",
    "biometric_event_revision_event_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "catalogue_preparation_record_v2",
    "food_import_record",
    "catalogue_preparation_record_v2_batch_id_sequence_number_fkey",
    "r",
    true,
  ],
  [
    "catalogue_validation_record_v2",
    "food_import_record",
    "catalogue_validation_record_v2_batch_id_sequence_number_fkey",
    "a",
    true,
  ],
  [
    "custom_food_operation",
    "custom_food",
    "custom_food_operation_custom_food_id_user_id_fkey",
    "c",
    true,
  ],
  ["custom_food_version", "custom_food", "custom_food_version_custom_food_id_fkey", "c", true],
  [
    "custom_food_version_nutrient",
    "custom_food_version",
    "custom_food_version_nutrient_custom_food_id_food_version_i_fkey",
    "c",
    true,
  ],
  ["diary_day_note", "app_user", "diary_day_note_user_fk", "c", true],
  [
    "diary_day_note_operation",
    "diary_day_note",
    "diary_day_note_operation_root_owner_fk",
    "c",
    true,
  ],
  [
    "diary_day_note_revision",
    "diary_day_note",
    "diary_day_note_revision_root_owner_date_fk",
    "c",
    true,
  ],
  ["diary_entry", "diary", "diary_entry_diary_id_user_id_fkey", "c", true],
  [
    "diary_entry_nutrient_snapshot",
    "diary_entry",
    "diary_entry_nutrient_snapshot_diary_entry_id_fkey",
    "c",
    true,
  ],
  ["diary_entry_revision", "diary_entry", "diary_entry_revision_diary_entry_id_fkey", "c", true],
  [
    "diary_entry_revision_nutrient",
    "diary_entry_revision",
    "diary_entry_revision_nutrient_diary_entry_revision_id_fkey",
    "c",
    true,
  ],
  [
    "diary_entry_revision_source",
    "diary_entry_revision",
    "diary_entry_revision_source_diary_entry_revision_id_fkey",
    "c",
    true,
  ],
  ["diary_operation", "diary_entry", "diary_operation_diary_entry_id_fkey", "c", true],
  ["food_barcode", "food", "food_barcode_food_id_fkey", "c", true],
  ["food_import_record", "food_version", "food_import_record_food_version_id_fkey", "r", false],
  ["food_nutrient_value", "food_version", "food_nutrient_value_food_version_id_fkey", "c", true],
  ["food_serving", "food_version", "food_serving_food_version_id_fkey", "c", true],
  ["food_version", "food", "food_version_food_id_fkey", "c", true],
  ["hydration_day", "app_user", "hydration_day_user_fk", "c", true],
  ["hydration_entry", "hydration_day", "hydration_entry_day_owner_fk", "c", true],
  [
    "hydration_entry_revision",
    "hydration_entry",
    "hydration_entry_revision_entry_owner_fk",
    "c",
    true,
  ],
  ["hydration_operation", "hydration_entry", "hydration_operation_entry_owner_fk", "c", true],
  [
    "nutrition_goal_operation",
    "nutrition_goal",
    "nutrition_goal_operation_nutrition_goal_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "nutrition_goal_target",
    "nutrition_goal_version",
    "nutrition_goal_target_nutrition_goal_version_id_fkey",
    "c",
    true,
  ],
  ["nutrition_goal_version", "nutrition_goal", "nutrition_goal_version_user_fk", "c", true],
  [
    "platform_health_import_revision",
    "platform_health_import",
    "platform_health_import_revision_import_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "platform_integration_version",
    "platform_integration",
    "platform_integration_version_integration_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "privacy_export_artifact",
    "privacy_export_job",
    "privacy_export_artifact_job_id_fkey",
    "c",
    true,
  ],
  [
    "privacy_export_artifact_deletion",
    "privacy_export_artifact",
    "privacy_export_artifact_deletion_artifact_id_fkey",
    "c",
    true,
  ],
  [
    "privacy_export_artifact_tombstone",
    "privacy_export_job",
    "privacy_export_artifact_tombstone_job_id_fkey",
    "c",
    true,
  ],
  [
    "privacy_export_download_audit",
    "privacy_export_job",
    "privacy_export_download_audit_job_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "privacy_export_entity_snapshot",
    "privacy_export_job",
    "privacy_export_entity_snapshot_job_id_fkey",
    "c",
    true,
  ],
  ["privacy_export_record", "privacy_export_job", "privacy_export_record_job_id_fkey", "c", true],
  [
    "privacy_export_upload_artifact",
    "privacy_export_job",
    "privacy_export_upload_artifact_job_id_fkey",
    "c",
    true,
  ],
  ["recipe_ingredient", "recipe_version", "recipe_ingredient_recipe_version_id_fkey", "c", true],
  ["recipe_operation", "recipe", "recipe_operation_recipe_id_user_id_fkey", "c", true],
  ["recipe_version", "recipe", "recipe_version_recipe_id_owner_user_id_fkey", "c", true],
  [
    "recipe_version_nutrient",
    "recipe_version",
    "recipe_version_nutrient_recipe_version_id_fkey",
    "c",
    true,
  ],
  [
    "recipe_version_source",
    "recipe_version",
    "recipe_version_source_recipe_version_id_fkey",
    "c",
    true,
  ],
  [
    "reminder_consent_version",
    "reminder_consent",
    "reminder_consent_version_consent_id_user_id_fkey",
    "c",
    true,
  ],
  [
    "reminder_schedule_version",
    "reminder_schedule",
    "reminder_schedule_version_schedule_id_user_id_fkey",
    "c",
    true,
  ],
  ["user_data_watermark", "app_user", "user_data_watermark_user_id_fkey", "c", true],
  ["user_password_credential", "app_user", "user_password_credential_user_id_fkey", "c", true],
  ["user_profile", "app_user", "user_profile_user_id_fkey", "c", true],
  ["user_session", "app_user", "user_session_user_id_fkey", "c", true],
];

interface Relationship {
  table_name: string;
  parent_table: string;
  constraint_name: string;
  delete_action: string;
  all_columns_not_null: boolean;
}
interface SchemaFixture {
  tables: string[];
  relationships: Relationship[];
  privateRecordCount: string;
}
const SCHEMA_ACCEPTED = new Error("Schema accepted; stop before erasure");
const NOT_READY = "Account-erasure schema inventory is not current";
const PAGED_TABLES = ["catalogue_preparation_record_v2", "catalogue_validation_record_v2"] as const;
function schemaFixture(): SchemaFixture {
  return {
    tables: [...LINKED_TABLES],
    relationships: RELATIONSHIPS.map(
      ([table_name, parent_table, constraint_name, delete_action, all_columns_not_null]) => ({
        table_name,
        parent_table,
        constraint_name,
        delete_action,
        all_columns_not_null,
      }),
    ),
    privateRecordCount: "0",
  };
}
function databaseFixture(schema: SchemaFixture) {
  const queries: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          queries.push(query);
          const statement = query.sql.trim().replace(/\s+/g, " ");
          let rows: unknown[];
          if (
            statement.startsWith("select pg_advisory_xact_lock(") ||
            statement.startsWith("select set_config(")
          )
            rows = [];
          else if (statement.startsWith("with recursive linked(oid)")) {
            rows = schema.tables.map((table_name) => ({ table_name }));
          } else if (statement.includes("from food_import_record record")) {
            expect(statement).toContain(
              "join food_version version on version.id=record.food_version_id",
            );
            expect(statement).toContain("join food on food.id=version.food_id");
            expect(statement).toContain("where food.owner_user_id is not null");
            rows = [{ count: schema.privateRecordCount }];
          } else if (statement.includes("from pg_constraint edge")) {
            const requested = query.parameters[0] as readonly string[];
            rows = schema.relationships.filter((row) => requested.includes(row.constraint_name));
          } else if (statement.startsWith('select "id" from "account_erasure_job"')) {
            throw SCHEMA_ACCEPTED;
          } else throw new Error(`Unexpected database statement: ${statement}`);
          return { rows: rows as R[] };
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("Unexpected stream");
        },
      };
    }
  }
  const database = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, queries };
}
async function checkSchema(schema: SchemaFixture, expected: Error | string) {
  const fixture = databaseFixture(schema);
  try {
    const result = replayExternalErasureLedgerEntry(fixture.database, {
      subjectUserId: "10000000-0000-4000-8000-000000000001",
      ledgerEntryId: "retention-schema-regression",
      ackDigest: "a".repeat(64),
      recordedAt: "2026-09-23T00:00:00Z",
    });
    if (typeof expected === "string") await expect(result).rejects.toThrow(expected);
    else await expect(result).rejects.toBe(expected);
    expect(
      fixture.queries.some((query) => /^\s*(delete|insert|update|create)\b/i.test(query.sql)),
    ).toBe(false);
    return fixture.queries;
  } finally {
    await fixture.database.destroy();
  }
}
function pagedRelationship(schema: SchemaFixture, table: string): Relationship {
  const row = schema.relationships.find((candidate) => candidate.table_name === table);
  if (!row) throw new Error(`Missing fixture relationship: ${table}`);
  return row;
}
describe("retention schema classification", () => {
  it("accepts the paged catalogue record inventory with exact RESTRICT and NO ACTION edges", async () => {
    const queries = await checkSchema(schemaFixture(), SCHEMA_ACCEPTED);
    const relationships = queries.find((query) => query.sql.includes("edge.conname=any("));
    expect(relationships?.parameters[0]).toEqual(
      expect.arrayContaining([
        "catalogue_preparation_record_v2_batch_id_sequence_number_fkey",
        "catalogue_validation_record_v2_batch_id_sequence_number_fkey",
      ]),
    );
  });
  it("rejects an unknown relation even when all reviewed tables are present", async () => {
    const schema = schemaFixture();
    schema.tables.push("unclassified_catalogue_record_child");
    await checkSchema(schema, NOT_READY);
  });
  it.each(PAGED_TABLES)("rejects missing classified relation %s", async (table) => {
    const schema = schemaFixture();
    schema.tables = schema.tables.filter((candidate) => candidate !== table);
    await checkSchema(schema, NOT_READY);
  });
  it.each(PAGED_TABLES)("rejects deletion-action drift for %s", async (table) => {
    for (const action of ["a", "r", "c", "n"]) {
      const schema = schemaFixture();
      const row = pagedRelationship(schema, table);
      if (action === row.delete_action) continue;
      row.delete_action = action;
      await checkSchema(schema, NOT_READY);
    }
  });
  it.each(PAGED_TABLES)("rejects a nullable ownership edge for %s", async (table) => {
    const schema = schemaFixture();
    pagedRelationship(schema, table).all_columns_not_null = false;
    await checkSchema(schema, NOT_READY);
  });
  it.each(PAGED_TABLES)("rejects an unrelated parent for %s", async (table) => {
    const schema = schemaFixture();
    pagedRelationship(schema, table).parent_table = "food_import_batch";
    await checkSchema(schema, NOT_READY);
  });
  it.each(PAGED_TABLES)("rejects missing reviewed foreign key for %s", async (table) => {
    const schema = schemaFixture();
    schema.relationships = schema.relationships.filter(
      (candidate) => candidate.table_name !== table,
    );
    await checkSchema(schema, NOT_READY);
  });
  it.each(["1", "2"])("rejects %s private food ingestion records", async (count) => {
    const schema = schemaFixture();
    schema.privateRecordCount = count;
    const queries = await checkSchema(schema, NOT_READY);
    expect(queries.some((query) => query.sql.includes("edge.conname=any("))).toBe(false);
  });
});
