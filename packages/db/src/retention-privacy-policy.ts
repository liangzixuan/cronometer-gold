import { sql } from "kysely";

export type PrivacyExportEntity =
  | "account"
  | "activity_day"
  | "activity_entry"
  | "activity_entry_revision"
  | "activity_operation"
  | "audit_event"
  | "biometric_definition"
  | "biometric_definition_operation"
  | "biometric_definition_version"
  | "biometric_event"
  | "biometric_event_operation"
  | "biometric_event_revision"
  | "custom_food"
  | "custom_food_catalogue_food"
  | "custom_food_catalogue_barcode"
  | "custom_food_catalogue_nutrient"
  | "custom_food_catalogue_serving"
  | "custom_food_catalogue_version"
  | "custom_food_nutrient"
  | "custom_food_operation"
  | "custom_food_version"
  | "device"
  | "diary_day"
  | "diary_day_note"
  | "diary_day_note_operation"
  | "diary_day_note_revision"
  | "diary_entry"
  | "diary_entry_legacy_nutrient"
  | "diary_entry_nutrient"
  | "diary_entry_revision"
  | "diary_entry_source"
  | "diary_operation"
  | "hydration_day"
  | "hydration_entry"
  | "hydration_entry_revision"
  | "hydration_operation"
  | "nutrition_goal"
  | "nutrition_goal_operation"
  | "nutrition_goal_target"
  | "nutrition_goal_version"
  | "platform_health_import"
  | "platform_health_import_conflict"
  | "platform_health_import_revision"
  | "platform_import_batch"
  | "platform_integration"
  | "platform_integration_version"
  | "privacy_export_artifact"
  | "privacy_export_artifact_deletion"
  | "privacy_export_artifact_tombstone"
  | "privacy_export_download_audit"
  | "privacy_export_job"
  | "profile"
  | "reauthentication_proof"
  | "recipe"
  | "recipe_ingredient"
  | "recipe_nutrient"
  | "recipe_operation"
  | "recipe_source"
  | "recipe_version"
  | "reminder_consent"
  | "reminder_consent_version"
  | "reminder_delivery"
  | "reminder_schedule"
  | "reminder_schedule_version"
  | "retention_operation"
  | "security_challenge"
  | "session"
  | "user_watermark";

/** Worker streams each page to a 0600 spool; no export row set is buffered in Node. */
type PrivacyExportEntitySpec = {
  readonly entity: PrivacyExportEntity;
  readonly table: string;
  readonly from: string;
  readonly userColumn: string;
  readonly entityId: string;
  readonly revision: string;
  readonly deleted: string;
  readonly redacted?: readonly string[];
};
export const EXPORT_ENTITY_SPECS: readonly PrivacyExportEntitySpec[] = [
  exportSpec(
    "account",
    "app_user",
    "app_user t",
    "t.id",
    "t.id::text",
    "null",
    "t.deleted_at is not null",
    ["auth_subject"],
  ),
  exportSpec(
    "activity_day",
    "activity_day",
    "activity_day t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "activity_entry",
    "activity_entry",
    "activity_entry t",
    "t.user_id",
    "t.id::text",
    "t.current_revision_number::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "activity_entry_revision",
    "activity_entry_revision",
    "activity_entry_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "activity_operation",
    "activity_operation",
    "activity_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "profile",
    "user_profile",
    "user_profile t",
    "t.user_id",
    "t.user_id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "user_watermark",
    "user_data_watermark",
    "user_data_watermark t",
    "t.user_id",
    "t.user_id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "session",
    "user_session",
    "user_session t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["token_hash"],
  ),
  exportSpec(
    "diary_day",
    "diary",
    "diary t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "diary_entry",
    "diary_entry",
    "diary_entry t",
    "t.user_id",
    "t.id::text",
    "t.current_revision_number::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "diary_entry_legacy_nutrient",
    "diary_entry_nutrient_snapshot",
    "diary_entry_nutrient_snapshot t join diary_entry owner on owner.id=t.diary_entry_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_id::text,t.nutrient_id::text)",
    "owner.current_revision_number::text",
    "owner.deleted_at is not null",
  ),
  exportSpec(
    "diary_entry_revision",
    "diary_entry_revision",
    "diary_entry_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "diary_entry_nutrient",
    "diary_entry_revision_nutrient",
    "diary_entry_revision_nutrient t join diary_entry_revision owner on owner.id=t.diary_entry_revision_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_revision_id::text,t.nutrient_id::text)",
    "owner.revision_number::text",
    "owner.operation = 'delete'",
  ),
  exportSpec(
    "diary_entry_source",
    "diary_entry_revision_source",
    "diary_entry_revision_source t join diary_entry_revision owner on owner.id=t.diary_entry_revision_id",
    "owner.user_id",
    "concat_ws(':',t.diary_entry_revision_id::text,t.food_source_id::text,t.source_release_id::text)",
    "owner.revision_number::text",
    "owner.operation = 'delete'",
  ),
  exportSpec(
    "diary_day_note",
    "diary_day_note",
    "diary_day_note t",
    "t.user_id",
    "t.id::text",
    "t.current_revision_number::text",
    "t.state = 'cleared'",
  ),
  exportSpec(
    "diary_day_note_revision",
    "diary_day_note_revision",
    "diary_day_note_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'clear'",
  ),
  exportSpec(
    "diary_day_note_operation",
    "diary_day_note_operation",
    "diary_day_note_operation t",
    "t.user_id",
    "t.client_operation_id::text",
    "null",
    "false",
  ),
  exportSpec(
    "diary_operation",
    "diary_operation",
    "diary_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "hydration_day",
    "hydration_day",
    "hydration_day t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "false",
  ),
  exportSpec(
    "hydration_entry",
    "hydration_entry",
    "hydration_entry t",
    "t.user_id",
    "t.id::text",
    "t.current_revision_number::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "hydration_entry_revision",
    "hydration_entry_revision",
    "hydration_entry_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "hydration_operation",
    "hydration_operation",
    "hydration_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "recipe",
    "recipe",
    "recipe t",
    "t.owner_user_id",
    "t.id::text",
    "null",
    "t.status = 'archived'",
  ),
  exportSpec(
    "recipe_version",
    "recipe_version",
    "recipe_version t",
    "t.owner_user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_ingredient",
    "recipe_ingredient",
    "recipe_ingredient t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "t.id::text",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_nutrient",
    "recipe_version_nutrient",
    "recipe_version_nutrient t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "concat_ws(':',t.recipe_version_id::text,t.nutrient_id::text)",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_source",
    "recipe_version_source",
    "recipe_version_source t join recipe_version owner on owner.id=t.recipe_version_id",
    "owner.owner_user_id",
    "concat_ws(':',t.recipe_version_id::text,t.food_source_id::text,t.source_release_id::text)",
    "owner.version_number::text",
    "false",
  ),
  exportSpec(
    "recipe_operation",
    "recipe_operation",
    "recipe_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "nutrition_goal",
    "nutrition_goal",
    "nutrition_goal t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_version",
    "nutrition_goal_version",
    "nutrition_goal_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.goal_status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_target",
    "nutrition_goal_target",
    "nutrition_goal_target t join nutrition_goal_version owner on owner.id=t.nutrition_goal_version_id",
    "owner.user_id",
    "concat_ws(':',t.nutrition_goal_version_id::text,t.nutrient_id::text)",
    "owner.version_number::text",
    "owner.goal_status <> 'active'",
  ),
  exportSpec(
    "nutrition_goal_operation",
    "nutrition_goal_operation",
    "nutrition_goal_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food",
    "custom_food",
    "custom_food t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'archived'",
  ),
  exportSpec(
    "custom_food_version",
    "custom_food_version",
    "custom_food_version t join custom_food owner on owner.id=t.custom_food_id",
    "owner.user_id",
    "concat_ws(':',t.custom_food_id::text,t.food_version_id::text)",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_nutrient",
    "custom_food_version_nutrient",
    "custom_food_version_nutrient t join custom_food owner on owner.id=t.custom_food_id",
    "owner.user_id",
    "concat_ws(':',t.custom_food_id::text,t.food_version_id::text,t.nutrient_id::text)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food_operation",
    "custom_food_operation",
    "custom_food_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_food",
    "food",
    "food t",
    "t.owner_user_id",
    "t.id::text",
    "null",
    "t.archived_at is not null",
  ),
  exportSpec(
    "custom_food_catalogue_barcode",
    "food_barcode",
    "food_barcode t join food owner on owner.id=t.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "null",
    "owner.archived_at is not null",
  ),
  exportSpec(
    "custom_food_catalogue_version",
    "food_version",
    "food_version t join food owner on owner.id=t.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_serving",
    "food_serving",
    "food_serving t join food_version version on version.id=t.food_version_id join food owner on owner.id=version.food_id",
    "owner.owner_user_id",
    "t.id::text",
    "version.version_number::text",
    "false",
  ),
  exportSpec(
    "custom_food_catalogue_nutrient",
    "food_nutrient_value",
    "food_nutrient_value t join food_version version on version.id=t.food_version_id join food owner on owner.id=version.food_id",
    "owner.owner_user_id",
    "concat_ws(':',t.food_version_id::text,t.nutrient_id::text)",
    "version.version_number::text",
    "false",
  ),
  exportSpec(
    "biometric_definition",
    "biometric_definition",
    "biometric_definition t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'archived'",
  ),
  exportSpec(
    "biometric_definition_version",
    "biometric_definition_version",
    "biometric_definition_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "false",
  ),
  exportSpec(
    "biometric_definition_operation",
    "biometric_definition_operation",
    "biometric_definition_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "biometric_event",
    "biometric_event",
    "biometric_event t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.deleted_at is not null",
  ),
  exportSpec(
    "biometric_event_revision",
    "biometric_event_revision",
    "biometric_event_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "biometric_event_operation",
    "biometric_event_operation",
    "biometric_event_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.operation)",
    "null",
    "false",
  ),
  exportSpec(
    "reminder_consent",
    "reminder_consent",
    "reminder_consent t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_consent_version",
    "reminder_consent_version",
    "reminder_consent_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_schedule",
    "reminder_schedule",
    "reminder_schedule t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'revoked'",
  ),
  exportSpec(
    "reminder_schedule_version",
    "reminder_schedule_version",
    "reminder_schedule_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.schedule_status = 'revoked'",
  ),
  exportSpec(
    "reminder_delivery",
    "reminder_delivery_outbox",
    "reminder_delivery_outbox t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.status = 'cancelled'",
  ),
  exportSpec(
    "device",
    "device_registration",
    "device_registration t",
    "t.user_id",
    "t.id::text",
    "t.revision::text",
    "t.revoked_at is not null",
    ["public_key_spki_base64", "key_fingerprint", "proof_signature_digest"],
  ),
  exportSpec(
    "platform_integration",
    "platform_integration",
    "platform_integration t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.status = 'disconnected'",
  ),
  exportSpec(
    "platform_integration_version",
    "platform_integration_version",
    "platform_integration_version t",
    "t.user_id",
    "t.id::text",
    "t.version_number::text",
    "t.status = 'disconnected'",
  ),
  exportSpec(
    "platform_import_batch",
    "platform_import_batch",
    "platform_import_batch t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
    ["nonce_hash", "signature_digest"],
  ),
  exportSpec(
    "platform_health_import",
    "platform_health_import",
    "platform_health_import t",
    "t.user_id",
    "t.id::text",
    "t.current_revision::text",
    "t.state = 'deleted'",
  ),
  exportSpec(
    "platform_health_import_revision",
    "platform_health_import_revision",
    "platform_health_import_revision t",
    "t.user_id",
    "t.id::text",
    "t.revision_number::text",
    "t.operation = 'delete'",
  ),
  exportSpec(
    "platform_health_import_conflict",
    "platform_health_import_conflict",
    "platform_health_import_conflict t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "retention_operation",
    "retention_operation",
    "retention_operation t",
    "t.user_id",
    "concat_ws(':',t.client_operation_id::text,t.feature,t.operation)",
    "null",
    "false",
    ["result_payload"],
  ),
  exportSpec(
    "audit_event",
    "audit_log",
    "audit_log t",
    "coalesce(t.subject_user_id,t.actor_user_id)",
    "t.id::text",
    "null",
    "false",
    [
      "actor_user_id",
      "subject_user_id",
      "source_ip",
      "request_id",
      "user_agent",
      "before_state",
      "after_state",
      "context",
    ],
  ),
  exportSpec(
    "privacy_export_job",
    "privacy_export_job",
    "privacy_export_job t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "privacy_export_artifact",
    "privacy_export_artifact",
    "privacy_export_artifact t join privacy_export_job owner on owner.id=t.job_id",
    "owner.user_id",
    "t.id::text",
    "null",
    "false",
    ["object_key", "encryption_key_id", "ciphertext_bytes"],
  ),
  exportSpec(
    "privacy_export_artifact_deletion",
    "privacy_export_artifact_deletion",
    "privacy_export_artifact_deletion t join privacy_export_artifact artifact on artifact.id=t.artifact_id join privacy_export_job owner on owner.id=artifact.job_id",
    "owner.user_id",
    "t.artifact_id::text",
    "null",
    "t.status = 'completed'",
    ["deletion_evidence_digest"],
  ),
  exportSpec(
    "privacy_export_artifact_tombstone",
    "privacy_export_artifact_tombstone",
    "privacy_export_artifact_tombstone t join privacy_export_job owner on owner.id=t.job_id",
    "owner.user_id",
    "t.artifact_id::text",
    "null",
    "true",
    ["deletion_evidence_digest"],
  ),
  exportSpec(
    "privacy_export_download_audit",
    "privacy_export_download_audit",
    "privacy_export_download_audit t",
    "t.user_id",
    "t.id::text",
    "null",
    "false",
  ),
  exportSpec(
    "security_challenge",
    "security_challenge",
    "security_challenge t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["nonce_hash", "proof_signature_digest"],
  ),
  exportSpec(
    "reauthentication_proof",
    "reauthentication_proof",
    "reauthentication_proof t",
    "t.user_id",
    "t.id::text",
    "null",
    "t.revoked_at is not null",
    ["session_token_hash", "token_hash"],
  ),
];

// This closed schema fingerprint is the export column-classification allowlist. Every current
// column is either deliberately emitted or named in the entity's redacted set above. A forward
// schema change therefore fails export before a row is materialized until it is reviewed here.
export const EXPORT_TABLE_SCHEMA_SHA256: Readonly<Record<string, string>> = {
  diary_day_note: "4413023f26ad55b76f40f48c877fc1677244c8a98b314e5f048afad3e466b4f3",
  diary_day_note_operation: "216b5266fa92a64b647027cfe60439d6b05ca35755e5b56e03973802132616b4",
  diary_day_note_revision: "9ab4245bfd9e8c6faebfe4b31661b7a96accb691d863aff88f4df8855e8946ed",
  app_user: "2289e77b06addc3a6edffbac67395ea570347b4d02bf5371cba92e245e88af67",
  activity_day: "82db5d391d43d860456b55fb2afb9d77d875169703c9ea86c0cd43e3a476b317",
  activity_entry: "e3ab04fee93142d5a059d82ad1c7c7fd430c64ac7eac6f759ab69d70b07a3dbf",
  activity_entry_revision: "233fb81e4059a0dd1653a97e773fe761ad0952b441d210fd6e097f4d9aefa5b4",
  activity_operation: "6d671faa6a003871956c10ea21482a0d5e89727ffbd4a581565f703a137c04c4",
  audit_log: "b0f3e21291cb254ff5e1030da753753807b74a9287c029b3a44430f7cdf0a863",
  biometric_definition: "8c9270ac3ef872064ea2cf0faf8a6f98fead61cf47f0a62ef0c7b0579674f467",
  biometric_definition_operation:
    "c49d630acc0a25898d6888889a15d3df213464bb3707765d3d376e21f89d4f10",
  biometric_definition_version: "7753d037755ac2df263565b867a6263b0a630cac3ec0476c8bc3089ccebfe2c5",
  biometric_event: "a1bb0e5ecb718e561899eb7b6a7179280d32e82f73fcbf37ba8ead99519bbccd",
  biometric_event_operation: "6bfe8ffac06ed35a8e9ab1d5922f7366c1e8f8a68c3b6ee46495ac0705378652",
  biometric_event_revision: "e296d84c26b34f424ca280fa779c01279e3aeb37223a430d7a92efe7623a5e5a",
  custom_food: "30feab0c34b065a255a50fcf55cc8050a33f57ac40312aec0fbfa87834458801",
  custom_food_operation: "70b37ca40ca11c4cd82146375e5cf35f6b41d449f0034b439c01e8018bc450bd",
  custom_food_version: "a3695fa5f1b723773800992df57523e9adeb154162585d510a6c07f09f1b9b92",
  custom_food_version_nutrient: "bf931400f740355dfce090866a6f8689dbd21a119c130e903f1ef0e1f39ee2ca",
  device_registration: "43f41397b73aa4ced8190e4076b3db85a01134a20d0a07f6f8b0f3ea5a4a5a5e",
  diary: "06814ccd20f3a56129130e02680f19a0c9a20540041940ab3469be149c5ba5df",
  diary_entry: "ad7bdfb736d6386fe07477fba57254c86b69c7e7c36c160c94271705d594f783",
  diary_entry_nutrient_snapshot: "c2bafc54df416990f1a9dc11c9da1396627e468eb5e936ced8b55818f689f969",
  diary_entry_revision: "289417ab93c81c2e44a15c6009f34c7ff57ff791357dd42f14cbf5292652f4e4",
  diary_entry_revision_nutrient: "388c6c4eb2b9983800a29313657545386770a27c6dc9446c85522c85bc14d7f1",
  diary_entry_revision_source: "1bd5f08fd5c9eab526d5ef1c357e7001c737a136749b84db020b7ba819cfea8f",
  diary_operation: "ab5534bf4cdccd950a62b869263b9ae92eff36599f7ad87e651e2542b96a2519",
  food: "87d5d13ee059ec83262c138c10fc68e85832fdc2bd6386f60c3a92276232d62a",
  food_barcode: "64b92aed5df48b3035d2f1abeab3f25ad5c6ac74ae5282d31b2b4b7f1eae0962",
  food_nutrient_value: "205612a35d2db5dfee5f2a06a3a5431880e8334c6fcf0b22e71ae4509ace2b52",
  food_serving: "ea541ebd2e446c05867a4126f4399685d1d92302691e5c33525b8506f2799e63",
  food_version: "db0fc9994d348d810118b945b7e783af43cd783368e78a4e339dc72283809dc2",
  hydration_day: "6af1c24b8bb451a65a6c51b3aeaf41d28d2c5c75f0b5fa49465b252f595958e2",
  hydration_entry: "ba751420c30d14f063af5f0a7b24e3b029528b45065c87a476c2954b26451f54",
  hydration_entry_revision: "4938c41052b7441a72bb3fae666578731f3984f0c478b0e8892954e3a477e4d6",
  hydration_operation: "03d89ed753d04f1c3bb44b6e044583eb41123523d584ad4357de0f46bf886dad",
  nutrition_goal: "d985a98a3aae2060aa928f9605c516cd7261b6a68da0a3275448260f71819646",
  nutrition_goal_operation: "60572bb70b101b42ffde1213c5993b1bfd5ec5fd19a35c0b5989db2d9ea20ad9",
  nutrition_goal_target: "418e30c9b41e388febcf8d369e31910c7600ede3b947ad76ef71bbf0b560ce67",
  nutrition_goal_version: "9df43444af8db1a8ba973980b1b19154e3098c9a0d26db3c6118516837045c3b",
  platform_health_import: "f6d11d7b18dd4d63cf97ab5c1aafa8c5492753081442308445f920e9182be4b3",
  platform_health_import_conflict:
    "8c377087ea6f221dfd1fadd5021e1431a01ce1901792af0cecdda75c78081865",
  platform_health_import_revision:
    "fe6593f2d066eee06ba6643e5213354fb5a8cd730ee663ff46ffc0ae5827865c",
  platform_import_batch: "9d83a41347499fe0bb7994c58cab754ec3945c4145da64576f25d78d465fb0e5",
  platform_integration: "3a32873670c5de79c17580e65dec5cf96a5131a3f829a6052e8fd5cdc13a2c51",
  platform_integration_version: "b61bdc134442afa128adba6ff15cad79730361d595550081cf7e272e4b738829",
  privacy_export_artifact: "eae2b20c5e2859ae9f9afc975ffbb55b009365c414a364759a56e3538d8e4d19",
  privacy_export_artifact_deletion:
    "20dcfa98b853febb8d302c9ef1c78774513fc1f4272886c22549980d93cf28b9",
  privacy_export_artifact_tombstone:
    "695ef36bfcc732fdd4f925ed0b859bc7b8966bbc3d10e7a823ecd70d6e8e44dc",
  privacy_export_download_audit: "480233141169776277f33399f21f767946501b55a233a2437d7fb7002cabc1b7",
  privacy_export_job: "9bea83bbec14ef01bda061b9f953555c8076e58703ff6b6671f81e6af077809a",
  reauthentication_proof: "fc050bfe192672f98116e46a72870d07f73f18a10a62cf88506c70d7c25b75a8", // gitleaks:allow -- closed-schema fingerprint
  recipe: "55363e77d3ae4231ddaf207f13718bdddb0338b3b617b1fa52083f0e2bfbe77d",
  recipe_ingredient: "453bbc34ee6c08b60fa6eed9dda9d0ab075c7625994c7eb8ba98f863de983a65",
  recipe_operation: "e0e8b1c1b59fdaa4e3124de0dc0b7a05c53f8fb4e50467f524ef2913a11f473e",
  recipe_version: "a6790a343d2d1291b0dda5784d66cc9ce3bffa7a3c833e34ed88d3dd39626a84",
  recipe_version_nutrient: "9960997724392473495e475626327d6287144a4e5e78e9333dac649e7f0d0cdc",
  recipe_version_source: "8f1a37bdac653aeddf83c282ed5673885e05a1fdd94c7efe40d6a67763584dcc",
  reminder_consent: "6d57d6b2e37c4dcd806d4b28c6918622f62d429b8be425842d18ba805c4567f0",
  reminder_consent_version: "619f410220efa5d9f2f9061561123708d85730e285088325f2dd4edf3631735e",
  reminder_delivery_outbox: "ef7ad84f1bd2456a26373cc8d3c255b741c62c18f50a3862b454d9fc01481884",
  reminder_schedule: "834abc69851f8a15573b41a4cad3cae418f5ec2e2a238ff7fd0633589b2830a5",
  reminder_schedule_version: "62bad77e0d861a65f64d6627dbbbff24ca063247577a5f368d2a2580e4684d07",
  retention_operation: "5ca39f43cdc8d6280c59d46bdba3e2fe857417ec38bdb3b27eabae47633ded58",
  security_challenge: "48f0e0812859dfa1b603a26b2cb845639adf24ff2295cc8cb39d3fc5f646b421",
  user_data_watermark: "db87636afcf455e6bdda2ce6c39babc655531536ca820af95026e787fb0145f5",
  user_profile: "e8842c5c39855d0546c9571bfb589efda02013531c7ef30dd422884b9992056a",
  user_session: "2b2d5b0e243ebb9c0dc0bf3f18990f1b48d3cdf7b1fd8a5660a23cd032073fd2",
};

// Tables transitively owned by app_user must be either exported above or deliberately excluded
// here. This is separate from the per-table column fingerprint: a new user-linked table therefore
// fails closed even when nobody remembered to add it to EXPORT_ENTITY_SPECS.
export const USER_LINKED_EXPORT_EXCLUSIONS = new Set([
  "account_erasure_job", // pseudonymous lifecycle/status capability; never in account export
  "account_erasure_receipt", // deliberately non-identifying post-erasure evidence
  "auth_action_token", // single-use credential and current-email digests
  "catalogue_preparation_record_v2", // public-source payload evidence; inherits food_import_record exclusion
  "catalogue_validation_record_v2", // public-source validation evidence; inherits food_import_record exclusion
  "catalogue_publication_record_v2", // public-source materialization evidence; direct private links checked below
  "food_import_record", // public-source ingestion evidence; custom foods cannot reference it
  "privacy_export_entity_snapshot", // transient DB spool manifest
  "privacy_export_record", // transient canonical DB spool rows
  "privacy_export_upload_artifact", // transient object-key/upload fencing evidence
  "user_password_credential", // password verifier material
]);

export type ErasureTableSpec =
  | {
      readonly table: string;
      readonly strategy: "delete";
      readonly subjectRows: (userId: string) => ReturnType<typeof sql>;
    }
  | {
      readonly table: string;
      readonly strategy: "cascade";
      readonly parentTable: string;
      readonly constraintName: string;
    }
  | {
      readonly table: string;
      readonly strategy: "empty" | "retain";
      readonly parentTable: string;
      readonly constraintName: string;
      readonly deleteAction: "a" | "n" | "r";
      readonly allColumnsNotNull: boolean;
    }
  | {
      readonly table: string;
      readonly strategy: "subject";
    };

function eraseBy(
  table: string,
  subjectRows: (userId: string) => ReturnType<typeof sql>,
): ErasureTableSpec {
  return { strategy: "delete", subjectRows, table };
}

function eraseByCascade(
  table: string,
  parentTable: string,
  constraintName: string,
): ErasureTableSpec {
  return { constraintName, parentTable, strategy: "cascade", table };
}

// One reviewed registry owns every transitive app_user-linked table. Explicit-delete entries
// carry the actual SQL used by eraseOwnedRows; cascade entries name one exact non-null FK path
// whose parent must itself be deleted. A nullable or merely unrelated CASCADE is never sufficient.
export const ERASURE_TABLE_SPECS: readonly ErasureTableSpec[] = [
  eraseBy("audit_log", (userId) => sql`actor_user_id=${userId} or subject_user_id=${userId}`),
  eraseBy("privacy_export_job", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_delivery_outbox", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_import_batch", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_health_import_conflict", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_health_import", (userId) => sql`user_id=${userId}`),
  eraseBy("platform_integration", (userId) => sql`user_id=${userId}`),
  eraseBy("biometric_event", (userId) => sql`user_id=${userId}`),
  eraseBy("biometric_definition", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_schedule", (userId) => sql`user_id=${userId}`),
  eraseBy("reminder_consent", (userId) => sql`user_id=${userId}`),
  eraseBy("security_challenge", (userId) => sql`user_id=${userId}`),
  eraseBy("reauthentication_proof", (userId) => sql`user_id=${userId}`),
  eraseBy("auth_action_token", (userId) => sql`user_id=${userId}`),
  eraseBy("device_registration", (userId) => sql`user_id=${userId}`),
  eraseBy("diary", (userId) => sql`user_id=${userId}`),
  eraseBy("recipe", (userId) => sql`owner_user_id=${userId}`),
  eraseBy("nutrition_goal", (userId) => sql`user_id=${userId}`),
  eraseBy("custom_food", (userId) => sql`user_id=${userId}`),
  eraseBy("food", (userId) => sql`owner_user_id=${userId}`),
  eraseBy("retention_operation", (userId) => sql`user_id=${userId}`),
  { strategy: "subject", table: "app_user" },
  {
    allColumnsNotNull: false,
    constraintName: "account_erasure_job_user_id_fkey",
    deleteAction: "n",
    parentTable: "app_user",
    strategy: "retain",
    table: "account_erasure_job",
  },
  {
    allColumnsNotNull: true,
    constraintName: "account_erasure_receipt_job_id_fkey",
    deleteAction: "r",
    parentTable: "account_erasure_job",
    strategy: "retain",
    table: "account_erasure_receipt",
  },
  {
    allColumnsNotNull: false,
    constraintName: "food_import_record_food_version_id_fkey",
    deleteAction: "r",
    parentTable: "food_version",
    strategy: "empty",
    table: "food_import_record",
  },
  // These non-null descendants cannot contain private records when the shared
  // food_import_record ownership check passes. Preserve their catalogue evidence.
  {
    allColumnsNotNull: true,
    constraintName: "catalogue_preparation_record_v2_batch_id_sequence_number_fkey",
    deleteAction: "r",
    parentTable: "food_import_record",
    strategy: "empty",
    table: "catalogue_preparation_record_v2",
  },
  {
    allColumnsNotNull: true,
    constraintName: "catalogue_validation_record_v2_batch_id_sequence_number_fkey",
    deleteAction: "a",
    parentTable: "food_import_record",
    strategy: "empty",
    table: "catalogue_validation_record_v2",
  },
  {
    allColumnsNotNull: true,
    constraintName: "cat_pub_record_v2_import_record_id_fk",
    deleteAction: "a",
    parentTable: "food_import_record",
    strategy: "empty",
    table: "catalogue_publication_record_v2",
  },
  eraseByCascade("activity_day", "app_user", "activity_day_user_fk"),
  eraseByCascade("activity_entry", "activity_day", "activity_entry_day_owner_fk"),
  eraseByCascade(
    "activity_entry_revision",
    "activity_entry",
    "activity_entry_revision_entry_owner_fk",
  ),
  eraseByCascade("activity_operation", "activity_entry", "activity_operation_entry_owner_fk"),
  eraseByCascade(
    "biometric_definition_operation",
    "biometric_definition",
    "biometric_definition_operation_definition_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_definition_version",
    "biometric_definition",
    "biometric_definition_version_definition_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_event_operation",
    "biometric_event",
    "biometric_event_operation_event_id_user_id_fkey",
  ),
  eraseByCascade(
    "biometric_event_revision",
    "biometric_event",
    "biometric_event_revision_event_id_user_id_fkey",
  ),
  eraseByCascade(
    "custom_food_operation",
    "custom_food",
    "custom_food_operation_custom_food_id_user_id_fkey",
  ),
  eraseByCascade("custom_food_version", "custom_food", "custom_food_version_custom_food_id_fkey"),
  eraseByCascade(
    "custom_food_version_nutrient",
    "custom_food_version",
    "custom_food_version_nutrient_custom_food_id_food_version_i_fkey",
  ),
  eraseByCascade("diary_day_note", "app_user", "diary_day_note_user_fk"),
  eraseByCascade(
    "diary_day_note_revision",
    "diary_day_note",
    "diary_day_note_revision_root_owner_date_fk",
  ),
  eraseByCascade(
    "diary_day_note_operation",
    "diary_day_note",
    "diary_day_note_operation_root_owner_fk",
  ),
  eraseByCascade("diary_entry", "diary", "diary_entry_diary_id_user_id_fkey"),
  eraseByCascade(
    "diary_entry_nutrient_snapshot",
    "diary_entry",
    "diary_entry_nutrient_snapshot_diary_entry_id_fkey",
  ),
  eraseByCascade("diary_entry_revision", "diary_entry", "diary_entry_revision_diary_entry_id_fkey"),
  eraseByCascade(
    "diary_entry_revision_nutrient",
    "diary_entry_revision",
    "diary_entry_revision_nutrient_diary_entry_revision_id_fkey",
  ),
  eraseByCascade(
    "diary_entry_revision_source",
    "diary_entry_revision",
    "diary_entry_revision_source_diary_entry_revision_id_fkey",
  ),
  eraseByCascade("diary_operation", "diary_entry", "diary_operation_diary_entry_id_fkey"),
  eraseByCascade("hydration_day", "app_user", "hydration_day_user_fk"),
  eraseByCascade("hydration_entry", "hydration_day", "hydration_entry_day_owner_fk"),
  eraseByCascade(
    "hydration_entry_revision",
    "hydration_entry",
    "hydration_entry_revision_entry_owner_fk",
  ),
  eraseByCascade("hydration_operation", "hydration_entry", "hydration_operation_entry_owner_fk"),
  eraseByCascade("food_barcode", "food", "food_barcode_food_id_fkey"),
  eraseByCascade("food_nutrient_value", "food_version", "food_nutrient_value_food_version_id_fkey"),
  eraseByCascade("food_serving", "food_version", "food_serving_food_version_id_fkey"),
  eraseByCascade("food_version", "food", "food_version_food_id_fkey"),
  eraseByCascade(
    "nutrition_goal_operation",
    "nutrition_goal",
    "nutrition_goal_operation_nutrition_goal_id_user_id_fkey",
  ),
  eraseByCascade(
    "nutrition_goal_target",
    "nutrition_goal_version",
    "nutrition_goal_target_nutrition_goal_version_id_fkey",
  ),
  eraseByCascade("nutrition_goal_version", "nutrition_goal", "nutrition_goal_version_user_fk"),
  eraseByCascade(
    "platform_health_import_revision",
    "platform_health_import",
    "platform_health_import_revision_import_id_user_id_fkey",
  ),
  eraseByCascade(
    "platform_integration_version",
    "platform_integration",
    "platform_integration_version_integration_id_user_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact",
    "privacy_export_job",
    "privacy_export_artifact_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact_deletion",
    "privacy_export_artifact",
    "privacy_export_artifact_deletion_artifact_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_artifact_tombstone",
    "privacy_export_job",
    "privacy_export_artifact_tombstone_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_download_audit",
    "privacy_export_job",
    "privacy_export_download_audit_job_id_user_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_entity_snapshot",
    "privacy_export_job",
    "privacy_export_entity_snapshot_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_record",
    "privacy_export_job",
    "privacy_export_record_job_id_fkey",
  ),
  eraseByCascade(
    "privacy_export_upload_artifact",
    "privacy_export_job",
    "privacy_export_upload_artifact_job_id_fkey",
  ),
  eraseByCascade("recipe_ingredient", "recipe_version", "recipe_ingredient_recipe_version_id_fkey"),
  eraseByCascade("recipe_operation", "recipe", "recipe_operation_recipe_id_user_id_fkey"),
  eraseByCascade("recipe_version", "recipe", "recipe_version_recipe_id_owner_user_id_fkey"),
  eraseByCascade(
    "recipe_version_nutrient",
    "recipe_version",
    "recipe_version_nutrient_recipe_version_id_fkey",
  ),
  eraseByCascade(
    "recipe_version_source",
    "recipe_version",
    "recipe_version_source_recipe_version_id_fkey",
  ),
  eraseByCascade(
    "reminder_consent_version",
    "reminder_consent",
    "reminder_consent_version_consent_id_user_id_fkey",
  ),
  eraseByCascade(
    "reminder_schedule_version",
    "reminder_schedule",
    "reminder_schedule_version_schedule_id_user_id_fkey",
  ),
  eraseByCascade("user_data_watermark", "app_user", "user_data_watermark_user_id_fkey"),
  eraseByCascade("user_password_credential", "app_user", "user_password_credential_user_id_fkey"),
  eraseByCascade("user_profile", "app_user", "user_profile_user_id_fkey"),
  eraseByCascade("user_session", "app_user", "user_session_user_id_fkey"),
];

function exportSpec(
  entity: PrivacyExportEntity,
  table: string,
  from: string,
  userColumn: string,
  entityId: string,
  revision: string,
  deleted: string,
  redacted?: readonly string[],
): PrivacyExportEntitySpec {
  return redacted
    ? { deleted, entity, entityId, from, redacted, revision, table, userColumn }
    : { deleted, entity, entityId, from, revision, table, userColumn };
}
