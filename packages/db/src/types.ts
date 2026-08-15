import type { ColumnType, JSONColumnType } from "kysely";

export type JsonPrimitive = boolean | number | string | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type BigintId = ColumnType<string, bigint | number | string | undefined, never>;
export type UuidId = ColumnType<string, string | undefined, never>;
export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
export type DefaultInt8 = ColumnType<
  string,
  bigint | number | string | undefined,
  bigint | number | string
>;
export type NullableInt8 = ColumnType<
  string | null,
  bigint | number | string | null | undefined,
  bigint | number | string | null
>;
export type Numeric = ColumnType<string, number | string, number | string>;
export type DefaultNumeric = ColumnType<string, number | string | undefined, number | string>;
export type NullableNumeric = ColumnType<
  string | null,
  number | string | null,
  number | string | null
>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type CreatedTimestamp = ColumnType<Date, Date | string | undefined, never>;
export type UpdatedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type DateOnly = ColumnType<string, string, string>;
export type NullableDateOnly = ColumnType<string | null, string | null | undefined, string | null>;
export type DefaultBoolean = ColumnType<boolean, boolean | undefined, boolean>;
export type DefaultInteger = ColumnType<number, number | undefined, number>;
export type DefaultValue<Value> = ColumnType<Value, Value | undefined, Value>;
export type DefaultJson = JSONColumnType<JsonObject, JsonObject | undefined, JsonObject>;
export type ImmutableJson = JSONColumnType<JsonObject, JsonObject | undefined, never>;
export type NullableImmutableJson = JSONColumnType<
  JsonObject | null,
  JsonObject | null | undefined,
  never
>;

export type UserStatus = "active" | "disabled" | "pending_deletion";
export type SexAtBirth = "female" | "intersex" | "male" | "not_specified";
export type UnitSystem = "metric" | "us_customary";
export type FoodSourceKind = "commercial" | "government" | "open" | "partner";
export type RightsReviewStatus = "approved" | "blocked" | "pending" | "restricted";
export type SourceReleaseStatus = "failed" | "imported" | "promoted" | "quarantined";
export type FoodImportBatchStatus =
  | "completed"
  | "failed"
  | "promoting"
  | "quarantined"
  | "ready"
  | "staging";
export type FoodImportRecordStatus = "materialized" | "pending" | "quarantined" | "valid";
export type FoodImportCheckpointStage = "download" | "materialize" | "parse" | "stage" | "validate";
export type FoodSourceReleaseActivationOperation = "activate" | "deactivate" | "rollback";
export type NutrientDimension = "amount" | "energy" | "mass" | "ratio" | "volume";
export type FoodKind = "branded" | "custom" | "generic";
export type FoodVisibility = "private" | "public" | "unlisted";
export type FoodDataQuality = "curated" | "provisional" | "quarantined" | "verified";
export type BasisUnit = "g" | "ml" | "serving";
export type NutrientValueStatus = "calculated" | "estimated" | "label" | "measured" | "trace";
export type ServingUnitKind = "count" | "mass" | "volume";
export type RecipeStatus = "active" | "archived";
export type DiaryStatus = "locked" | "open";
export type DiaryEntryKind = "food" | "note" | "quick_add" | "recipe";
export type SnapshotStatus = "complete" | "partial" | "pending";
export type GoalStatus = "active" | "archived" | "draft";
export type GoalEnergyMode = "component" | "fixed" | "pal_total";
export type AuditSensitivity = "health" | "operational" | "personal" | "security";

export interface AppUserTable {
  id: UuidId;
  auth_subject: string;
  email: string;
  email_verified_at: NullableTimestamp;
  status: DefaultValue<UserStatus>;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
  deletion_requested_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

export interface UserProfileTable {
  user_id: string;
  display_name: string | null;
  birth_date: NullableDateOnly;
  sex_at_birth: DefaultValue<SexAtBirth>;
  height_cm: NullableNumeric;
  baseline_weight_kg: NullableNumeric;
  activity_level_code: string | null;
  locale: DefaultValue<string>;
  time_zone: DefaultValue<string>;
  unit_system: DefaultValue<UnitSystem>;
  preferences: DefaultJson;
  onboarding_completed_at: NullableTimestamp;
  wellness_disclaimer_acknowledged_at: NullableTimestamp;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface FoodSourceTable {
  id: BigintId;
  code: string;
  display_name: string;
  kind: FoodSourceKind;
  homepage_url: string;
  access_url: string | null;
  license_expression: string;
  license_url: string;
  terms_url: string | null;
  attribution_text: string;
  attribution_required: DefaultBoolean;
  commercial_use_allowed: boolean | null;
  redistribution_allowed: boolean | null;
  database_rights_notes: string | null;
  rights_review_status: RightsReviewStatus;
  rights_reviewed_at: NullableTimestamp;
  rights_reviewed_by: string | null;
  active: DefaultBoolean;
  active_release_id: string | null;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface FoodImportBatchTable {
  id: UuidId;
  food_source_id: Int8;
  release_key: string;
  published_on: NullableDateOnly;
  acquired_at: Timestamp;
  artifact_uri: string;
  artifact_sha256: string;
  artifact_bytes: Int8;
  media_type: string;
  upstream_schema_version: string | null;
  parser_version: string;
  rights_manifest_uri: string;
  rights_manifest_sha256: string;
  status: DefaultValue<FoodImportBatchStatus>;
  staged_count: DefaultInt8;
  valid_count: DefaultInt8;
  quarantined_count: DefaultInt8;
  unresolved_error_count: DefaultInt8;
  warning_count: DefaultInt8;
  nutrient_input_count: DefaultInt8;
  nutrient_materializable_count: DefaultInt8;
  nutrient_excluded_count: DefaultInt8;
  materialized_count: DefaultInt8;
  validation_policy: DefaultJson;
  release_id: string | null;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
  validated_at: NullableTimestamp;
  completed_at: NullableTimestamp;
}

export interface FoodImportApprovalTable {
  id: BigintId;
  batch_id: string;
  approval_role: "data" | "quality" | "rights";
  validation_digest: string;
  rights_manifest_sha256: string;
  approved_at: CreatedTimestamp;
  principal_id: string;
  approval_reference: string;
  created_at: CreatedTimestamp;
}

export interface FoodImportParserReportTable {
  batch_id: string;
  report: ImmutableJson;
  report_sha256: string;
  source_record_count: Int8;
  emitted_record_count: Int8;
  excluded_record_count: Int8;
  source_nutrient_count: Int8;
  emitted_nutrient_count: Int8;
  excluded_nutrient_count: Int8;
  source_portion_count: Int8;
  emitted_portion_count: Int8;
  excluded_portion_count: Int8;
  created_at: CreatedTimestamp;
}

export interface FoodImportRecordTable {
  id: BigintId;
  batch_id: string;
  source_record_key: string;
  source_record_type: string;
  sequence_number: Int8;
  source_payload_sha256: string;
  canonical_payload_sha256: string;
  canonical_payload: ColumnType<JsonValue, JsonValue, never>;
  validation_status: DefaultValue<FoodImportRecordStatus>;
  validation_issues: JSONColumnType<JsonArray, JsonArray | undefined, JsonArray>;
  food_version_id: NullableInt8;
  created_at: CreatedTimestamp;
  validated_at: NullableTimestamp;
  materialized_at: NullableTimestamp;
}

export interface FoodImportCheckpointTable {
  batch_id: string;
  stage: FoodImportCheckpointStage;
  cursor_data: DefaultJson;
  last_sequence_number: NullableInt8;
  processed_count: DefaultInt8;
  updated_at: UpdatedTimestamp;
}

export interface FoodSourceReleaseActivationTable {
  id: BigintId;
  food_source_id: Int8;
  operation: FoodSourceReleaseActivationOperation;
  release_id: string | null;
  previous_release_id: string | null;
  import_batch_id: string | null;
  reason: string;
  performed_by: string;
  occurred_at: CreatedTimestamp;
}

export interface FoodSourceReleaseTable {
  id: UuidId;
  food_source_id: Int8;
  release_key: string;
  published_on: NullableDateOnly;
  acquired_at: Timestamp;
  artifact_uri: string;
  artifact_sha256: string;
  artifact_bytes: Int8;
  media_type: string;
  upstream_schema_version: string | null;
  parser_version: string;
  status: DefaultValue<SourceReleaseStatus>;
  record_counts: ImmutableJson;
  validation_summary: ImmutableJson;
  rights_manifest_uri: string;
  rights_manifest_sha256: string | null;
  promoted_at: NullableTimestamp;
  created_at: CreatedTimestamp;
}

export interface NutrientTable {
  id: BigintId;
  code: string;
  name: string;
  short_name: string | null;
  canonical_unit: string;
  dimension: NutrientDimension;
  parent_nutrient_id: NullableInt8;
  display_decimals: DefaultInteger;
  display_order: DefaultInteger;
  is_core: DefaultBoolean;
  is_targetable: DefaultBoolean;
  active: DefaultBoolean;
  metadata: DefaultJson;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface NutrientAliasTable {
  id: BigintId;
  nutrient_id: Int8;
  alias: string;
  locale: DefaultValue<string>;
  alias_kind: DefaultValue<string>;
  created_at: CreatedTimestamp;
}

export interface SourceNutrientMapTable {
  food_source_id: Int8;
  source_nutrient_key: string;
  nutrient_id: Int8;
  source_name: string;
  source_unit: string;
  conversion_multiplier: DefaultNumeric;
  mapping_notes: string | null;
  reviewed_at: Timestamp;
  reviewed_by: string;
  current_revision_id: string;
  created_at: CreatedTimestamp;
}

export interface SourceNutrientMapRevisionTable {
  id: UuidId;
  food_source_id: Int8;
  source_nutrient_key: string;
  nutrient_id: Int8;
  source_name: string;
  source_unit: string;
  conversion_multiplier: Numeric;
  mapping_notes: string | null;
  reviewed_at: Timestamp;
  reviewed_by: string;
  change_reason: string;
  supersedes_revision_id: string | null;
  created_at: CreatedTimestamp;
}

export interface FoodTable {
  id: BigintId;
  kind: FoodKind;
  food_source_id: NullableInt8;
  source_food_key: string | null;
  owner_user_id: string | null;
  visibility: DefaultValue<FoodVisibility>;
  current_version_id: NullableInt8;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
  archived_at: NullableTimestamp;
}

export interface FoodVersionTable {
  id: BigintId;
  food_id: Int8;
  version_number: number;
  source_release_id: string | null;
  name: string;
  normalized_name: string;
  brand_name: string | null;
  description: string | null;
  ingredients_text: string | null;
  language_tag: DefaultValue<string>;
  market_code: DefaultValue<string>;
  data_quality: DefaultValue<FoodDataQuality>;
  basis_quantity: Numeric;
  basis_unit: BasisUnit;
  source_modified_at: NullableTimestamp;
  effective_from: DefaultTimestamp;
  attributes: ImmutableJson;
  created_by_user_id: string | null;
  created_at: CreatedTimestamp;
}

export interface FoodNutrientValueTable {
  food_version_id: Int8;
  nutrient_id: Int8;
  amount: Numeric;
  unit: string;
  basis_quantity: Numeric;
  basis_unit: BasisUnit;
  source_amount: NullableNumeric;
  source_unit: string | null;
  source_basis_quantity: NullableNumeric;
  source_basis_unit: BasisUnit | null;
  value_status: NutrientValueStatus;
  derivation_code: string | null;
  confidence: NullableNumeric;
  metadata: ImmutableJson;
  created_at: CreatedTimestamp;
}

export interface FoodServingTable {
  id: BigintId;
  food_version_id: Int8;
  source_serving_key: string | null;
  label: string;
  quantity: Numeric;
  unit: string;
  unit_kind: ServingUnitKind;
  gram_weight: NullableNumeric;
  milliliter_volume: NullableNumeric;
  is_default: DefaultBoolean;
  display_order: DefaultInteger;
  metadata: ImmutableJson;
  created_at: CreatedTimestamp;
}

export interface FoodBarcodeTable {
  id: BigintId;
  gtin: string;
  market_code: DefaultValue<string>;
  food_id: Int8;
  food_version_id: NullableInt8;
  food_serving_id: NullableInt8;
  source_release_id: string | null;
  valid_from: DefaultTimestamp;
  valid_to: NullableTimestamp;
  metadata: ImmutableJson;
  created_at: CreatedTimestamp;
}

export interface RecipeTable {
  id: UuidId;
  owner_user_id: string;
  status: DefaultValue<RecipeStatus>;
  current_version_id: string | null;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
  archived_at: NullableTimestamp;
}

export interface RecipeVersionTable {
  id: UuidId;
  recipe_id: string;
  owner_user_id: string;
  version_number: number;
  name: string;
  description: string | null;
  instructions: string | null;
  serving_count: Numeric;
  total_yield_quantity: NullableNumeric;
  total_yield_unit: string | null;
  total_weight_grams: NullableNumeric;
  calculation_version: string;
  metadata: ImmutableJson;
  created_by_user_id: string;
  created_at: CreatedTimestamp;
}

export interface RecipeIngredientTable {
  id: BigintId;
  recipe_version_id: string;
  position: number;
  food_version_id: NullableInt8;
  nested_recipe_version_id: string | null;
  food_serving_id: NullableInt8;
  quantity: Numeric;
  input_unit: string;
  resolved_grams: NullableNumeric;
  yield_factor: DefaultNumeric;
  retention_factor_set: string | null;
  note: string | null;
  created_at: CreatedTimestamp;
}

export interface DiaryTable {
  id: UuidId;
  user_id: string;
  local_date: DateOnly;
  time_zone: string;
  status: DefaultValue<DiaryStatus>;
  note: string | null;
  revision: DefaultInt8;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface DiaryEntryTable {
  id: UuidId;
  diary_id: string;
  user_id: string;
  client_operation_id: string;
  entry_kind: DiaryEntryKind;
  food_version_id: NullableInt8;
  recipe_version_id: string | null;
  food_serving_id: NullableInt8;
  meal_slot: string | null;
  quantity: NullableNumeric;
  input_unit: string | null;
  resolved_grams: NullableNumeric;
  occurred_at: Timestamp;
  local_time: string;
  position: DefaultInteger;
  note: string | null;
  snapshot_status: DefaultValue<SnapshotStatus>;
  snapshot_engine_version: string | null;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
  deleted_at: NullableTimestamp;
}

export interface DiaryEntryNutrientSnapshotTable {
  diary_entry_id: string;
  nutrient_id: Int8;
  amount: Numeric;
  unit: string;
  calculation_version: string;
  provenance: ImmutableJson;
  created_at: CreatedTimestamp;
}

export interface NutritionGoalTable {
  id: UuidId;
  user_id: string;
  status: DefaultValue<GoalStatus>;
  current_version_id: string | null;
  effective_from: DateOnly;
  effective_to: NullableDateOnly;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface NutritionGoalVersionTable {
  id: UuidId;
  nutrition_goal_id: string;
  version_number: number;
  energy_mode: GoalEnergyMode;
  energy_target_kcal: NullableNumeric;
  bmr_kcal: NullableNumeric;
  bmr_equation_code: string | null;
  bmr_equation_version: string | null;
  dri_reference_group_code: string | null;
  dri_reference_version: string | null;
  activity_factor: NullableNumeric;
  exercise_budget_kcal: NullableNumeric;
  thermic_effect_kcal: NullableNumeric;
  energy_adjustment_kcal: NullableNumeric;
  assumptions: ImmutableJson;
  rationale: string | null;
  created_by_user_id: string;
  created_at: CreatedTimestamp;
}

export interface NutritionGoalTargetTable {
  nutrition_goal_version_id: string;
  nutrient_id: Int8;
  minimum_amount: NullableNumeric;
  target_amount: NullableNumeric;
  maximum_amount: NullableNumeric;
  unit: string;
  target_source: string;
  target_source_version: string | null;
  metadata: ImmutableJson;
  created_at: CreatedTimestamp;
}

export interface AuditLogTable {
  id: BigintId;
  actor_user_id: string | null;
  subject_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  sensitivity: AuditSensitivity;
  reason: string | null;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  before_state: NullableImmutableJson;
  after_state: NullableImmutableJson;
  context: ImmutableJson;
  occurred_at: CreatedTimestamp;
}

export interface OutboxEventTable {
  id: UuidId;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  deduplication_key: string | null;
  payload: DefaultJson;
  headers: DefaultJson;
  occurred_at: CreatedTimestamp;
  available_at: DefaultTimestamp;
  published_at: NullableTimestamp;
  attempt_count: DefaultInteger;
  locked_at: NullableTimestamp;
  locked_by: string | null;
  last_error: string | null;
}

export interface Database {
  app_user: AppUserTable;
  audit_log: AuditLogTable;
  diary: DiaryTable;
  diary_entry: DiaryEntryTable;
  diary_entry_nutrient_snapshot: DiaryEntryNutrientSnapshotTable;
  food: FoodTable;
  food_barcode: FoodBarcodeTable;
  food_import_batch: FoodImportBatchTable;
  food_import_approval: FoodImportApprovalTable;
  food_import_checkpoint: FoodImportCheckpointTable;
  food_import_parser_report: FoodImportParserReportTable;
  food_import_record: FoodImportRecordTable;
  food_nutrient_value: FoodNutrientValueTable;
  food_serving: FoodServingTable;
  food_source: FoodSourceTable;
  food_source_release: FoodSourceReleaseTable;
  food_source_release_activation: FoodSourceReleaseActivationTable;
  food_version: FoodVersionTable;
  nutrient: NutrientTable;
  nutrient_alias: NutrientAliasTable;
  nutrition_goal: NutritionGoalTable;
  nutrition_goal_target: NutritionGoalTargetTable;
  nutrition_goal_version: NutritionGoalVersionTable;
  outbox_event: OutboxEventTable;
  recipe: RecipeTable;
  recipe_ingredient: RecipeIngredientTable;
  recipe_version: RecipeVersionTable;
  source_nutrient_map: SourceNutrientMapTable;
  source_nutrient_map_revision: SourceNutrientMapRevisionTable;
  user_profile: UserProfileTable;
}
