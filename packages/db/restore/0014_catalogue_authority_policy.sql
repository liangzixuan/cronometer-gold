-- Versioned post-restore policy for catalogue authority migrations 0014-0022.
--
-- Logical restores deliberately use --no-owner --no-privileges. Run this only
-- against a new isolated nutrition_restore_* database while PUBLIC CONNECT is
-- revoked. The expected object owner is supplied through the validated
-- nutrition.expected_restore_owner setting; this policy never guesses or
-- rewrites ownership.

begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:restore:catalogue-authority:v2')
);

do $policy$
declare
  acl_grantee oid;
  acl_grantee_name name;
  activation_guard_function oid;
  approval_function oid;
  approval_guard_function oid;
  capability_role text;
  capability_role_oid oid;
  expected_acl_count integer;
  expected_owner text := pg_catalog.current_setting(
    'nutrition.expected_restore_owner',
    true
  );
  expected_owner_oid oid;
  promotion_function oid;
  rollback_function oid;
  stage_validate_function oid;
  stage_validate_function_spec record;
  stage_validate_functions oid[] := array[]::oid[];
  target_schema constant name := 'public';
begin
  if pg_catalog.current_database() !~ '^nutrition_restore_[a-z0-9_]{1,45}$' then
    raise exception 'catalogue restore authority policy requires an isolated nutrition_restore_* database'
      using errcode = '22023';
  end if;

  if expected_owner is null
    or expected_owner !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'catalogue restore authority policy requires an explicit safe expected owner'
      using errcode = '22023';
  end if;

  select role_row.oid
  into expected_owner_oid
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = expected_owner;
  if expected_owner_oid is null then
    raise exception 'catalogue restore authority expected owner does not exist'
      using errcode = '42704';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_database as database_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        database_row.datacl,
        pg_catalog.acldefault('d', database_row.datdba)
      )
    ) as acl
    where database_row.datname = pg_catalog.current_database()
      and acl.grantee = 0
      and acl.privilege_type = 'CONNECT'
  ) then
    raise exception 'PUBLIC CONNECT must remain revoked while restore authority is repaired'
      using errcode = '42501';
  end if;

  foreach capability_role in array array[
    'nutrition_catalogue_stage',
    'nutrition_catalogue_validate',
    'nutrition_catalogue_approve_data',
    'nutrition_catalogue_approve_quality',
    'nutrition_catalogue_approve_rights',
    'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ] loop
    select role_row.oid
    into capability_role_oid
    from pg_catalog.pg_roles as role_row
    where role_row.rolname = capability_role;

    if capability_role_oid is null then
      raise exception 'required catalogue capability role % is absent', capability_role
        using errcode = '42704';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_roles as role_row
      where role_row.oid = capability_role_oid
        and (
          role_row.rolcanlogin
          or role_row.rolsuper
          or role_row.rolcreatedb
          or role_row.rolcreaterole
          or role_row.rolreplication
          or role_row.rolbypassrls
        )
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.member = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.roleid = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = capability_role_oid
        and dependency.deptype = 'o'
    ) then
      raise exception 'catalogue capability role % violates the attribute, membership, or ownership policy', capability_role
        using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and class_row.relowner <> expected_owner_oid
  ) then
    raise exception 'restored table, sequence, view, or foreign-table ownership differs from the explicit expected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proowner <> expected_owner_oid
  ) then
    raise exception 'restored function ownership differs from the explicit expected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_type as type_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = target_schema
      and (
        type_row.typowner <> expected_owner_oid
        or type_row.typacl is not null
      )
  ) then
    raise exception 'restored public types differ from the exact owner and empty-ACL policy'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_namespace as namespace_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = namespace_row.nspowner
    where namespace_row.nspname = target_schema
      and owner_role.rolname = 'pg_database_owner'
  ) then
    raise exception 'public schema owner must remain pg_database_owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      -- Forward migrations and this policy's output use explicit owner-only
      -- ACLs for these fixed companions. Reject every other explicit grant.
      and class_row.relacl is not null
      and not (
        class_row.relkind = 'r'
        and class_row.relname in (
          'catalogue_paged_approval_v2',
          'catalogue_preparation_admission_v2',
          'catalogue_preparation_budget_usage_v2',
          'catalogue_preparation_record_v2',
          'catalogue_preparation_seal_page_v2',
          'catalogue_preparation_stage_page_v2',
          'catalogue_preparation_v2',
          'catalogue_publication_admission_v2',
          'catalogue_publication_page_v2',
          'catalogue_publication_record_v2',
          'catalogue_publication_rollback_v2',
          'catalogue_publication_v2',
          'catalogue_reconciliation_baseline_v2',
          'catalogue_reconciliation_page_v2',
          'catalogue_reconciliation_v2',
          'catalogue_validation_context_v2',
          'catalogue_validation_generation_v2',
          'catalogue_validation_page_v2',
          'catalogue_validation_record_v2'
        )
        and class_row.relacl = pg_catalog.acldefault('r', expected_owner_oid)
      )
  ) then
    raise exception 'restored tables, sequences, or views contain unexpected explicit privileges'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute as attribute_row
    join pg_catalog.pg_class as class_row
      on class_row.oid = attribute_row.attrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped
      and attribute_row.attacl is not null
  ) then
    raise exception 'restored public columns contain unexpected explicit privileges'
      using errcode = '55000';
  end if;

  select pg_catalog.to_regprocedure(
    'public.catalogue_record_import_approval(uuid,text,text,text,text,text)'
  )
  into approval_function;
  if approval_function is null then
    raise exception 'catalogue approval authority function is absent'
      using errcode = '42883';
  end if;

  select pg_catalog.to_regprocedure(
    'public.guard_food_import_approval_authority()'
  )
  into approval_guard_function;
  if approval_guard_function is null then
    raise exception 'catalogue approval guard function is absent'
      using errcode = '42883';
  end if;

  select pg_catalog.to_regprocedure(
    'public.catalogue_promote_import_batch(uuid,text,text)'
  )
  into promotion_function;
  select pg_catalog.to_regprocedure(
    'public.catalogue_rollback_source_release(text,uuid,text,text)'
  )
  into rollback_function;
  select pg_catalog.to_regprocedure(
    'public.guard_food_source_release_activation_authority()'
  )
  into activation_guard_function;
  if promotion_function is null
    or rollback_function is null
    or activation_guard_function is null then
    raise exception 'catalogue promotion, rollback, or activation-guard authority function is absent'
      using errcode = '42883';
  end if;

  -- Pin the complete frozen-materialization, nutrition-semantic,
  -- stage/validate, and authenticated-actor CHECK boundary as
  -- known-good authority policy, not merely source/target parity.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = constraint_row.connamespace
    where namespace_row.nspname = target_schema
      and constraint_row.conname in (
        'food_import_batch_materialization_contract_check',
        'food_import_batch_nutrition_semantic_contract_check',
        'food_import_batch_promotable_contract_check',
        'food_import_batch_stage_validate_database_authority_check',
        'food_import_batch_staging_seal_check',
        'food_import_record_nutrition_semantic_contract_check',
        'food_import_record_validated_food_contract_check',
        'food_import_approval_database_authority_check',
        'food_source_release_activation_database_authority_check'
      )
  ) <> 9 or exists (
    select 1
    from (
      values
        (
          'food_import_batch'::text,
          'food_import_batch_materialization_contract_check'::text,
          $constraint$CHECK ((validated_food_contract_version IS NULL AND nutrient_mapping_digest IS NULL AND nutrient_mapping_revision_ids IS NULL OR validated_food_contract_version = 1 AND nutrient_mapping_digest ~ '^[0-9a-f]{64}$'::text AND jsonb_typeof(nutrient_mapping_revision_ids) = 'array'::text AND validated_at IS NOT NULL) IS TRUE)$constraint$::text
        ),
        (
          'food_import_batch',
          'food_import_batch_nutrition_semantic_contract_check',
          $constraint$CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (status = ANY (ARRAY['quarantined'::text, 'ready'::text, 'promoting'::text, 'completed'::text]))) IS TRUE)$constraint$
        ),
        (
          'food_import_batch',
          'food_import_batch_promotable_contract_check',
          $constraint$CHECK (((status <> ALL (ARRAY['ready'::text, 'promoting'::text])) OR validated_food_contract_version = 1 AND nutrient_mapping_digest IS NOT NULL AND nutrient_mapping_revision_ids IS NOT NULL) IS TRUE)$constraint$
        ),
        (
          'food_import_batch',
          'food_import_batch_stage_validate_database_authority_check',
          $constraint$CHECK ((staged_database_principal IS NULL AND staged_database_capability_role IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR staged_database_principal IS NOT NULL AND octet_length(staged_database_principal) >= 1 AND octet_length(staged_database_principal) <= 63 AND staged_database_capability_role = 'nutrition_catalogue_stage'::text AND (validated_at IS NULL AND validated_database_principal IS NULL AND validated_database_capability_role IS NULL OR validated_at IS NOT NULL AND validated_database_principal IS NOT NULL AND octet_length(validated_database_principal) >= 1 AND octet_length(validated_database_principal) <= 63 AND validated_database_capability_role = 'nutrition_catalogue_validate'::text AND validated_database_principal <> staged_database_principal)) IS TRUE)$constraint$
        ),
        (
          'food_import_batch',
          'food_import_batch_staging_seal_check',
          $constraint$CHECK ((staging_seal_sha256 IS NULL AND staging_sealed_at IS NULL OR staging_seal_sha256 ~ '^[0-9a-f]{64}$'::text AND staging_sealed_at IS NOT NULL AND (staging_sealed_at <> ALL (ARRAY['-infinity'::timestamp with time zone, 'infinity'::timestamp with time zone]))) IS TRUE AND (validated_at IS NULL OR staged_database_principal IS NULL OR staging_seal_sha256 IS NOT NULL))$constraint$
        ),
        (
          'food_import_record',
          'food_import_record_nutrition_semantic_contract_check',
          $constraint$CHECK ((nutrition_semantic_contract_version IS NULL AND nutrition_semantic_sha256 IS NULL OR nutrition_semantic_contract_version = 1 AND nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_at IS NOT NULL AND (validation_status = ANY (ARRAY['quarantined'::text, 'valid'::text, 'materialized'::text]))) IS TRUE)$constraint$
        ),
        (
          'food_import_record',
          'food_import_record_validated_food_contract_check',
          $constraint$CHECK ((validated_food_document IS NULL AND validated_food_sha256 IS NULL AND validated_food_contract_version IS NULL AND (validation_status = ANY (ARRAY['pending'::text, 'quarantined'::text, 'valid'::text, 'materialized'::text])) OR validated_food_document IS NOT NULL AND validated_food_sha256 ~ '^[0-9a-f]{64}$'::text AND validated_food_contract_version = 1 AND (validation_status = ANY (ARRAY['valid'::text, 'materialized'::text])) AND jsonb_typeof(validated_food_document::jsonb) = 'object'::text AND validated_food_sha256 = encode(sha256(convert_to(validated_food_document, 'UTF8'::name)), 'hex'::text)) IS TRUE)$constraint$
        ),
        (
          'food_import_approval',
          'food_import_approval_database_authority_check',
          $constraint$CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND principal_id = database_principal AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =
CASE approval_role
    WHEN 'data'::text THEN 'nutrition_catalogue_approve_data'::text
    WHEN 'quality'::text THEN 'nutrition_catalogue_approve_quality'::text
    WHEN 'rights'::text THEN 'nutrition_catalogue_approve_rights'::text
    ELSE NULL::text
END) IS TRUE)$constraint$
        ),
        (
          'food_source_release_activation',
          'food_source_release_activation_database_authority_check',
          $constraint$CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND performed_by = database_principal AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =
CASE
    WHEN import_batch_id IS NOT NULL AND operation = 'activate'::text THEN 'nutrition_catalogue_promote_activate'::text
    WHEN import_batch_id IS NULL AND (operation = ANY (ARRAY['deactivate'::text, 'rollback'::text])) THEN 'nutrition_catalogue_rollback'::text
    ELSE NULL::text
END) IS TRUE)$constraint$
        )
    ) as expected(table_name, constraint_name, definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_constraint as constraint_row
      on constraint_row.conrelid = class_row.oid
      and constraint_row.conname = expected.constraint_name
    where constraint_row.oid is null
      or constraint_row.contype <> 'c'
      or not constraint_row.convalidated
      or pg_catalog.pg_get_constraintdef(constraint_row.oid, true) <> expected.definition
  ) then
    raise exception 'catalogue frozen-materialization, nutrition-semantic, stage/validate, or authenticated-actor constraint differs from the forward 0022 policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from (
      values
        ('food_import_batch'::text, 'nutrient_mapping_digest'::text, 'text'::text, false, null::text),
        ('food_import_batch', 'nutrient_mapping_revision_ids', 'jsonb', false, null::text),
        ('food_import_batch', 'nutrition_semantic_contract_version', 'smallint', false, null::text),
        ('food_import_batch', 'nutrition_semantic_sha256', 'text', false, null::text),
        ('food_import_batch', 'validated_food_contract_version', 'smallint', false, null::text),
        ('food_import_batch', 'staged_database_principal', 'text', false, null::text),
        ('food_import_batch', 'staged_database_capability_role', 'text', false, null::text),
        ('food_import_batch', 'staging_seal_sha256', 'text', false, null::text),
        ('food_import_batch', 'staging_sealed_at', 'timestamp with time zone', false, null::text),
        ('food_import_batch', 'validated_database_principal', 'text', false, null::text),
        ('food_import_batch', 'validated_database_capability_role', 'text', false, null::text),
        ('food_import_record', 'nutrition_semantic_contract_version', 'smallint', false, null::text),
        ('food_import_record', 'nutrition_semantic_sha256', 'text', false, null::text),
        ('food_import_record', 'validated_food_contract_version', 'smallint', false, null::text),
        ('food_import_record', 'validated_food_document', 'text', false, null::text),
        ('food_import_record', 'validated_food_sha256', 'text', false, null::text)
    ) as expected(table_name, column_name, data_type, not_null, default_expression)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_attribute as attribute_row
      on attribute_row.attrelid = class_row.oid
      and attribute_row.attname = expected.column_name
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped
    left join pg_catalog.pg_attrdef as default_row
      on default_row.adrelid = attribute_row.attrelid
      and default_row.adnum = attribute_row.attnum
    where attribute_row.attnum is null
      or pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) <>
        expected.data_type
      or attribute_row.attnotnull is distinct from expected.not_null
      or pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, true)
        is distinct from expected.default_expression
  ) then
    raise exception 'catalogue frozen-materialization, nutrition-semantic, or stage/validate column identity differs from the forward 0022 policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as index_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = index_row.relnamespace
    where namespace_row.nspname = target_schema
      and index_row.relname =
        'food_source_release_activation_import_batch_unique'
      and index_row.relkind = 'i'
  ) <> 1 or exists (
    select 1
    from pg_catalog.pg_index as index_metadata
    join pg_catalog.pg_class as index_row
      on index_row.oid = index_metadata.indexrelid
    join pg_catalog.pg_class as table_row
      on table_row.oid = index_metadata.indrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = table_row.relnamespace
    join pg_catalog.pg_am as access_method
      on access_method.oid = index_row.relam
    where namespace_row.nspname = target_schema
      and index_row.relname =
        'food_source_release_activation_import_batch_unique'
      and (
        table_row.relname <> 'food_source_release_activation'
        or index_row.relowner <> expected_owner_oid
        or access_method.amname <> 'btree'
        or not index_metadata.indisunique
        or index_metadata.indisprimary
        or not index_metadata.indisvalid
        or not index_metadata.indisready
        or index_metadata.indnkeyatts <> 1
        or index_metadata.indnatts <> 1
        or pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 1, true) <>
          'import_batch_id'
        or pg_catalog.pg_get_expr(
          index_metadata.indpred,
          index_metadata.indrelid,
          true
        ) is distinct from 'import_batch_id IS NOT NULL'
        or pg_catalog.pg_get_indexdef(index_metadata.indexrelid) <>
          'CREATE UNIQUE INDEX food_source_release_activation_import_batch_unique ON public.food_source_release_activation USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL)'
      )
  ) then
    raise exception 'catalogue activation import-batch unique index differs from the forward 0019 policy'
      using errcode = '55000';
  end if;

  -- ADR0104/ADR0105 companion structure is fixed policy. Readiness does not learn it
  -- from restored state. Every new column, constraint and index must match.
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=target_schema and c.relname in ('catalogue_paged_approval_v2','catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2','catalogue_preparation_record_v2','catalogue_preparation_seal_page_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_v2','catalogue_publication_admission_v2','catalogue_publication_page_v2','catalogue_publication_record_v2','catalogue_publication_rollback_v2','catalogue_publication_v2','catalogue_reconciliation_baseline_v2','catalogue_reconciliation_page_v2','catalogue_reconciliation_v2','catalogue_validation_context_v2','catalogue_validation_generation_v2','catalogue_validation_page_v2','catalogue_validation_record_v2') and c.relkind='r') <> 19 then
    raise exception 'paged catalogue companion relation set differs' using errcode='55000';
  end if;
  if (select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname=target_schema
      and c.relname in ('catalogue_paged_approval_v2','catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2','catalogue_preparation_record_v2','catalogue_preparation_seal_page_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_v2','catalogue_publication_admission_v2','catalogue_publication_page_v2','catalogue_publication_record_v2','catalogue_publication_rollback_v2','catalogue_publication_v2','catalogue_reconciliation_baseline_v2','catalogue_reconciliation_page_v2','catalogue_reconciliation_v2','catalogue_validation_context_v2','catalogue_validation_generation_v2','catalogue_validation_page_v2','catalogue_validation_record_v2') and a.attnum>0 and not a.attisdropped) <> 253 or exists (
    select 1 from (values
      ('catalogue_paged_approval_v2', 'approval_reference', 'text', true, null),
      ('catalogue_paged_approval_v2', 'approval_role', 'text', true, null),
      ('catalogue_paged_approval_v2', 'approved_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_paged_approval_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_paged_approval_v2', 'context_sha256', 'text', true, null),
      ('catalogue_paged_approval_v2', 'database_principal', 'text', true, null),
      ('catalogue_paged_approval_v2', 'report_sha256', 'text', true, null),
      ('catalogue_paged_approval_v2', 'rights_manifest_sha256', 'text', true, null),
      ('catalogue_paged_approval_v2', 'validation_terminal_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'admission_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'admitted_by', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'artifact_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_preparation_admission_v2', 'export_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'export_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'manifest_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'max_baseline_payload_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_baseline_records', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_intermediate_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_payload_text_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_reconciliation_evidence_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_records', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'max_validation_evidence_bytes', 'bigint', true, null),
      ('catalogue_preparation_admission_v2', 'parser_version', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_preparation_admission_v2', 'release_key', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'request_document', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'request_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'source_code', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'stage_document', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'stage_document_sha256', 'text', true, null),
      ('catalogue_preparation_admission_v2', 'stage_principal', 'text', true, null),
      ('catalogue_preparation_budget_usage_v2', 'admission_sha256', 'text', true, null),
      ('catalogue_preparation_budget_usage_v2', 'intermediate_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_budget_usage_v2', 'reconciliation_evidence_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_budget_usage_v2', 'validation_evidence_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_record_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_preparation_record_v2', 'canonical_payload_document', 'text', true, null),
      ('catalogue_preparation_record_v2', 'payload_text_bytes', 'bigint', true, null),
      ('catalogue_preparation_record_v2', 'record_sha256', 'text', true, null),
      ('catalogue_preparation_record_v2', 'sequence_number', 'bigint', true, null),
      ('catalogue_preparation_seal_page_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_preparation_seal_page_v2', 'page_number', 'bigint', true, null),
      ('catalogue_preparation_seal_page_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_preparation_stage_page_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_preparation_stage_page_v2', 'first_sequence', 'bigint', true, null),
      ('catalogue_preparation_stage_page_v2', 'next_sequence', 'bigint', true, null),
      ('catalogue_preparation_stage_page_v2', 'page_number', 'bigint', true, null),
      ('catalogue_preparation_stage_page_v2', 'payload_text_bytes', 'bigint', true, null),
      ('catalogue_preparation_stage_page_v2', 'previous_receipt_sha256', 'text', false, null),
      ('catalogue_preparation_stage_page_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_preparation_stage_page_v2', 'receipt_sha256', 'text', true, null),
      ('catalogue_preparation_stage_page_v2', 'record_commitment_sha256', 'text', true, null),
      ('catalogue_preparation_stage_page_v2', 'record_count', 'bigint', true, null),
      ('catalogue_preparation_stage_page_v2', 'request_document', 'text', true, null),
      ('catalogue_preparation_stage_page_v2', 'request_sha256', 'text', true, null),
      ('catalogue_preparation_stage_page_v2', 'total_payload_text_bytes', 'bigint', true, null),
      ('catalogue_preparation_v2', 'admission_sha256', 'text', true, null),
      ('catalogue_preparation_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_preparation_v2', 'last_page_receipt_sha256', 'text', false, null),
      ('catalogue_preparation_v2', 'payload_text_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'phase', 'text', true, '''staging''::text'),
      ('catalogue_preparation_v2', 'protocol_version', 'smallint', true, '2'),
      ('catalogue_preparation_v2', 'seal_begin_receipt', 'jsonb', false, null),
      ('catalogue_preparation_v2', 'seal_page_receipt_sha256', 'text', false, null),
      ('catalogue_preparation_v2', 'seal_record_commitment_sha256', 'text', true, null),
      ('catalogue_preparation_v2', 'seal_request_document', 'text', false, null),
      ('catalogue_preparation_v2', 'seal_request_sha256', 'text', false, null),
      ('catalogue_preparation_v2', 'seal_verified_intermediate_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'seal_verified_page_count', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'seal_verified_payload_text_bytes', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'seal_verified_record_count', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'sealed_at', 'timestamp with time zone', false, null),
      ('catalogue_preparation_v2', 'stage_commitment_sha256', 'text', true, null),
      ('catalogue_preparation_v2', 'stage_page_count', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'staged_count', 'bigint', true, '0'),
      ('catalogue_preparation_v2', 'staging_seal_sha256', 'text', false, null),
      ('catalogue_preparation_v2', 'terminal_document', 'text', false, null),
      ('catalogue_preparation_v2', 'terminal_receipt', 'jsonb', false, null),
      ('catalogue_publication_admission_v2', 'admission_sha256', 'text', true, null),
      ('catalogue_publication_admission_v2', 'admitted_by', 'text', true, null),
      ('catalogue_publication_admission_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_publication_admission_v2', 'context_sha256', 'text', true, null),
      ('catalogue_publication_admission_v2', 'created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_publication_admission_v2', 'max_cutover_barcode_rows', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_cutover_bytes', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_cutover_food_rows', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_evidence_bytes', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_intermediate_bytes', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_materialization_bytes', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'max_records', 'bigint', true, null),
      ('catalogue_publication_admission_v2', 'publisher_principal', 'text', true, null),
      ('catalogue_publication_admission_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_publication_admission_v2', 'report_sha256', 'text', true, null),
      ('catalogue_publication_admission_v2', 'request_document', 'text', true, null),
      ('catalogue_publication_admission_v2', 'request_sha256', 'text', true, null),
      ('catalogue_publication_admission_v2', 'validation_terminal_sha256', 'text', true, null),
      ('catalogue_publication_page_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_publication_page_v2', 'first_sequence', 'bigint', true, null),
      ('catalogue_publication_page_v2', 'next_sequence', 'bigint', true, null),
      ('catalogue_publication_page_v2', 'page_number', 'bigint', true, null),
      ('catalogue_publication_page_v2', 'phase', 'text', true, null),
      ('catalogue_publication_page_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_publication_page_v2', 'receipt_sha256', 'text', true, null),
      ('catalogue_publication_page_v2', 'record_commitment_sha256', 'text', true, null),
      ('catalogue_publication_page_v2', 'request_document', 'text', true, null),
      ('catalogue_publication_page_v2', 'request_sha256', 'text', true, null),
      ('catalogue_publication_record_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_publication_record_v2', 'food_id', 'bigint', false, null),
      ('catalogue_publication_record_v2', 'food_version_id', 'bigint', false, null),
      ('catalogue_publication_record_v2', 'import_record_id', 'bigint', true, null),
      ('catalogue_publication_record_v2', 'materialization_bytes', 'bigint', true, null),
      ('catalogue_publication_record_v2', 'materialization_sha256', 'text', true, null),
      ('catalogue_publication_record_v2', 'sequence_number', 'bigint', true, null),
      ('catalogue_publication_record_v2', 'validated_food_sha256', 'text', false, null),
      ('catalogue_publication_rollback_v2', 'activation_id', 'bigint', true, null),
      ('catalogue_publication_rollback_v2', 'actor', 'text', true, null),
      ('catalogue_publication_rollback_v2', 'created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_publication_rollback_v2', 'previous_release_id', 'uuid', false, null),
      ('catalogue_publication_rollback_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_publication_rollback_v2', 'request_document', 'text', true, null),
      ('catalogue_publication_rollback_v2', 'request_id', 'uuid', true, null),
      ('catalogue_publication_rollback_v2', 'request_sha256', 'text', true, null),
      ('catalogue_publication_rollback_v2', 'source_id', 'bigint', true, null),
      ('catalogue_publication_rollback_v2', 'target_release_id', 'uuid', false, null),
      ('catalogue_publication_v2', 'activated_at', 'timestamp with time zone', false, null),
      ('catalogue_publication_v2', 'activation_receipt', 'jsonb', false, null),
      ('catalogue_publication_v2', 'activation_request_document', 'text', false, null),
      ('catalogue_publication_v2', 'admission_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'baseline_release_id', 'uuid', false, null),
      ('catalogue_publication_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_publication_v2', 'begin_receipt', 'jsonb', true, null),
      ('catalogue_publication_v2', 'begin_request_document', 'text', true, null),
      ('catalogue_publication_v2', 'context_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_publication_v2', 'evidence_bytes', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'finish_receipt', 'jsonb', false, null),
      ('catalogue_publication_v2', 'finish_request_document', 'text', false, null),
      ('catalogue_publication_v2', 'initial_generation', 'bigint', true, null),
      ('catalogue_publication_v2', 'intermediate_bytes', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'last_generation', 'bigint', true, null),
      ('catalogue_publication_v2', 'last_receipt_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'mapping_document', 'jsonb', true, null),
      ('catalogue_publication_v2', 'mapping_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'materialization_bytes', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'materialized_count', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'next_sequence', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'page_count', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'phase', 'text', true, null),
      ('catalogue_publication_v2', 'publication_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'publisher_principal', 'text', true, null),
      ('catalogue_publication_v2', 'record_commitment_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'release_id', 'uuid', true, null),
      ('catalogue_publication_v2', 'report_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'seal_sha256', 'text', false, null),
      ('catalogue_publication_v2', 'validation_terminal_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'verification_commitment_sha256', 'text', true, null),
      ('catalogue_publication_v2', 'verified_materialized_count', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'verified_page_count', 'bigint', true, '0'),
      ('catalogue_publication_v2', 'verified_sequence', 'bigint', true, '0'),
      ('catalogue_reconciliation_baseline_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_reconciliation_baseline_v2', 'envelope', 'jsonb', true, null),
      ('catalogue_reconciliation_baseline_v2', 'sequence_number', 'bigint', true, null),
      ('catalogue_reconciliation_baseline_v2', 'source_food_key', 'text', true, null),
      ('catalogue_reconciliation_page_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_reconciliation_page_v2', 'document', 'text', true, null),
      ('catalogue_reconciliation_page_v2', 'page_number', 'bigint', true, null),
      ('catalogue_reconciliation_page_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_reconciliation_v2', 'added_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_batch_id', 'uuid', false, null),
      ('catalogue_reconciliation_v2', 'baseline_error_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_excluded_nutrients', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_materializable_nutrients', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_nutrient_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_payload_bytes', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_portion_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_quarantined_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_records', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_release_id', 'uuid', false, null),
      ('catalogue_reconciliation_v2', 'baseline_valid_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'baseline_warning_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_reconciliation_v2', 'candidate_records', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'changed_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'context_sha256', 'text', true, null),
      ('catalogue_reconciliation_v2', 'next_sequence', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'page_commitment_sha256', 'text', true, null),
      ('catalogue_reconciliation_v2', 'page_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'phase', 'text', true, null),
      ('catalogue_reconciliation_v2', 'quarantined_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'removed_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'terminal_receipt', 'jsonb', false, null),
      ('catalogue_reconciliation_v2', 'terminal_sha256', 'text', false, null),
      ('catalogue_reconciliation_v2', 'unchanged_count', 'bigint', true, '0'),
      ('catalogue_reconciliation_v2', 'validation_terminal_sha256', 'text', true, null),
      ('catalogue_reconciliation_v2', 'validator_principal', 'text', true, null),
      ('catalogue_validation_context_v2', 'baseline_release_id', 'uuid', false, null),
      ('catalogue_validation_context_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_validation_context_v2', 'context_sha256', 'text', true, null),
      ('catalogue_validation_context_v2', 'created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
      ('catalogue_validation_context_v2', 'excluded_nutrient_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'generation', 'bigint', true, null),
      ('catalogue_validation_context_v2', 'last_page_receipt_sha256', 'text', true, null),
      ('catalogue_validation_context_v2', 'next_sequence', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'nutrient_input_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'nutrient_materializable_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'page_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'phase', 'text', true, '''observing''::text'),
      ('catalogue_validation_context_v2', 'policy', 'jsonb', true, null),
      ('catalogue_validation_context_v2', 'policy_document', 'text', true, null),
      ('catalogue_validation_context_v2', 'portion_input_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'quarantined_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'record_error_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'semantic_commitment_sha256', 'text', true, null),
      ('catalogue_validation_context_v2', 'staging_seal_sha256', 'text', true, null),
      ('catalogue_validation_context_v2', 'terminal_document', 'text', false, null),
      ('catalogue_validation_context_v2', 'terminal_receipt', 'jsonb', false, null),
      ('catalogue_validation_context_v2', 'terminal_sha256', 'text', false, null),
      ('catalogue_validation_context_v2', 'valid_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'valid_without_nutrients_count', 'bigint', true, '0'),
      ('catalogue_validation_context_v2', 'validation_commitment_sha256', 'text', true, null),
      ('catalogue_validation_context_v2', 'validator_principal', 'text', true, null),
      ('catalogue_validation_context_v2', 'warning_count', 'bigint', true, '0'),
      ('catalogue_validation_generation_v2', 'generation', 'bigint', true, '0'),
      ('catalogue_validation_generation_v2', 'singleton', 'boolean', true, 'true'),
      ('catalogue_validation_page_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_validation_page_v2', 'end_sequence', 'bigint', true, null),
      ('catalogue_validation_page_v2', 'observation_sha256', 'text', true, null),
      ('catalogue_validation_page_v2', 'page_number', 'bigint', true, null),
      ('catalogue_validation_page_v2', 'receipt', 'jsonb', true, null),
      ('catalogue_validation_page_v2', 'receipt_sha256', 'text', true, null),
      ('catalogue_validation_page_v2', 'request_document', 'text', true, null),
      ('catalogue_validation_page_v2', 'request_sha256', 'text', true, null),
      ('catalogue_validation_page_v2', 'semantic_commitment_sha256', 'text', true, null),
      ('catalogue_validation_page_v2', 'start_sequence', 'bigint', true, null),
      ('catalogue_validation_page_v2', 'validation_commitment_sha256', 'text', true, null),
      ('catalogue_validation_record_v2', 'batch_id', 'uuid', true, null),
      ('catalogue_validation_record_v2', 'canonical_payload_sha256', 'text', true, null),
      ('catalogue_validation_record_v2', 'excluded_nutrient_count', 'bigint', true, null),
      ('catalogue_validation_record_v2', 'gtin14', 'text', false, null),
      ('catalogue_validation_record_v2', 'market_code', 'text', false, null),
      ('catalogue_validation_record_v2', 'nutrient_input_count', 'bigint', true, null),
      ('catalogue_validation_record_v2', 'nutrient_materializable_count', 'bigint', true, null),
      ('catalogue_validation_record_v2', 'nutrition_semantic_sha256', 'text', true, null),
      ('catalogue_validation_record_v2', 'portion_input_count', 'bigint', true, null),
      ('catalogue_validation_record_v2', 'record_sha256', 'text', true, null),
      ('catalogue_validation_record_v2', 'sequence_number', 'bigint', true, null),
      ('catalogue_validation_record_v2', 'source_food_key', 'text', false, null),
      ('catalogue_validation_record_v2', 'source_record_key', 'text', true, null),
      ('catalogue_validation_record_v2', 'validated_food_document', 'text', false, null),
      ('catalogue_validation_record_v2', 'validated_food_sha256', 'text', false, null),
      ('catalogue_validation_record_v2', 'validation_issues_document', 'text', true, null),
      ('catalogue_validation_record_v2', 'validation_status', 'text', true, null)
    ) expected(table_name,column_name,data_type,not_null,default_expression)
    left join pg_namespace n on n.nspname=target_schema
    left join pg_class c on c.relnamespace=n.oid and c.relname=expected.table_name
    left join pg_attribute a on a.attrelid=c.oid and a.attname=expected.column_name and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where a.attname is null or format_type(a.atttypid,a.atttypmod)<>expected.data_type
      or a.attnotnull is distinct from expected.not_null
      or pg_get_expr(d.adbin,d.adrelid,true) is distinct from expected.default_expression
      or a.attidentity<>'' or a.attgenerated<>''
  ) then raise exception 'paged catalogue column schema differs' using errcode='55000'; end if;
  if (select count(*) from pg_constraint k join pg_class c on c.oid=k.conrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname=target_schema
      and c.relname in ('catalogue_paged_approval_v2','catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2','catalogue_preparation_record_v2','catalogue_preparation_seal_page_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_v2','catalogue_publication_admission_v2','catalogue_publication_page_v2','catalogue_publication_record_v2','catalogue_publication_rollback_v2','catalogue_publication_v2','catalogue_reconciliation_baseline_v2','catalogue_reconciliation_page_v2','catalogue_reconciliation_v2','catalogue_validation_context_v2','catalogue_validation_generation_v2','catalogue_validation_page_v2','catalogue_validation_record_v2')) <> 192 or exists (
    select 1 from (values
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_approval_role_check', 'c', 'CHECK ((approval_role = ANY (ARRAY[''data''::text, ''quality''::text, ''rights''::text])))'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_batch_id_database_principal_key', 'u', 'UNIQUE (batch_id, database_principal)'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_reconciliation_v2(batch_id)'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_context_sha256_check', 'c', 'CHECK ((context_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_pkey', 'p', 'PRIMARY KEY (batch_id, approval_role)'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_report_sha256_check', 'c', 'CHECK ((report_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_rights_manifest_sha256_check', 'c', 'CHECK ((rights_manifest_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_validation_terminal_sha256_check', 'c', 'CHECK ((validation_terminal_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admiss_max_reconciliation_evidence__check', 'c', 'CHECK ((max_reconciliation_evidence_bytes > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admiss_max_validation_evidence_byte_check', 'c', 'CHECK ((max_validation_evidence_bytes > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admissi_source_code_release_key_artif_key', 'u', 'UNIQUE (source_code, release_key, artifact_sha256)'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admissio_max_baseline_payload_bytes_check', 'c', 'CHECK ((max_baseline_payload_bytes >= 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_admission_sha256_check', 'c', 'CHECK ((admission_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_admitted_by_check', 'c', 'CHECK (((octet_length(admitted_by) >= 1) AND (octet_length(admitted_by) <= 63)))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_artifact_sha256_check', 'c', 'CHECK ((artifact_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_check', 'c', 'CHECK ((stage_principal <> admitted_by))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_export_bytes_check', 'c', 'CHECK ((export_bytes > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_export_sha256_check', 'c', 'CHECK ((export_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_manifest_sha256_check', 'c', 'CHECK ((manifest_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_max_baseline_records_check', 'c', 'CHECK ((max_baseline_records >= 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_max_intermediate_bytes_check', 'c', 'CHECK ((max_intermediate_bytes > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_max_payload_text_bytes_check', 'c', 'CHECK ((max_payload_text_bytes > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_max_records_check', 'c', 'CHECK ((max_records > 0))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_pkey', 'p', 'PRIMARY KEY (admission_sha256)'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_request_document_check', 'c', 'CHECK (((octet_length(request_document) >= 1) AND (octet_length(request_document) <= 131072)))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_request_sha256_check', 'c', 'CHECK ((request_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_stage_document_check', 'c', 'CHECK (((octet_length(stage_document) >= 1) AND (octet_length(stage_document) <= 65536)))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_stage_document_sha256_check', 'c', 'CHECK ((stage_document_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_stage_principal_check', 'c', 'CHECK (((octet_length(stage_principal) >= 1) AND (octet_length(stage_principal) <= 63)))'),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_reconciliation_evidence_byte_check', 'c', 'CHECK ((reconciliation_evidence_bytes >= 0))'),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_us_validation_evidence_bytes_check', 'c', 'CHECK ((validation_evidence_bytes >= 0))'),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_usage_v2_admission_sha256_fkey', 'f', 'FOREIGN KEY (admission_sha256) REFERENCES catalogue_preparation_admission_v2(admission_sha256)'),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_usage_v2_intermediate_bytes_check', 'c', 'CHECK ((intermediate_bytes >= 0))'),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_usage_v2_pkey', 'p', 'PRIMARY KEY (admission_sha256)'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_preparation_v2(batch_id) ON DELETE RESTRICT'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_batch_id_sequence_number_fkey', 'f', 'FOREIGN KEY (batch_id, sequence_number) REFERENCES food_import_record(batch_id, sequence_number) ON DELETE RESTRICT'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_payload_text_bytes_check', 'c', 'CHECK (((payload_text_bytes >= 1) AND (payload_text_bytes <= 2097152)))'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_pkey', 'p', 'PRIMARY KEY (batch_id, sequence_number)'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_record_sha256_check', 'c', 'CHECK ((record_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v_canonical_payload_document_check', 'c', 'CHECK (((octet_length(canonical_payload_document) >= 1) AND (octet_length(canonical_payload_document) <= 1048576)))'),
      ('catalogue_preparation_seal_page_v2', 'catalogue_preparation_seal_page_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_preparation_v2(batch_id) ON DELETE RESTRICT'),
      ('catalogue_preparation_seal_page_v2', 'catalogue_preparation_seal_page_v2_page_number_check', 'c', 'CHECK ((page_number >= 0))'),
      ('catalogue_preparation_seal_page_v2', 'catalogue_preparation_seal_page_v2_pkey', 'p', 'PRIMARY KEY (batch_id, page_number)'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page__previous_receipt_sha256_check', 'c', 'CHECK ((previous_receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_record_commitment_sha256_check', 'c', 'CHECK ((record_commitment_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_batch_id_first_sequence_key', 'u', 'UNIQUE (batch_id, first_sequence)'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_preparation_v2(batch_id) ON DELETE RESTRICT'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_check', 'c', 'CHECK ((total_payload_text_bytes >= payload_text_bytes))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_check1', 'c', 'CHECK ((next_sequence = (first_sequence + record_count)))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_first_sequence_check', 'c', 'CHECK ((first_sequence >= 0))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_page_number_check', 'c', 'CHECK ((page_number >= 0))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_payload_text_bytes_check', 'c', 'CHECK ((payload_text_bytes > 0))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_pkey', 'p', 'PRIMARY KEY (batch_id, page_number)'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_receipt_sha256_check', 'c', 'CHECK ((receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_record_count_check', 'c', 'CHECK (((record_count >= 1) AND (record_count <= 250)))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_request_document_check', 'c', 'CHECK (((octet_length(request_document) >= 1) AND (octet_length(request_document) <= 16777216)))'),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_request_sha256_check', 'c', 'CHECK ((request_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_admission_sha256_fkey', 'f', 'FOREIGN KEY (admission_sha256) REFERENCES catalogue_preparation_admission_v2(admission_sha256)'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_admission_sha256_key', 'u', 'UNIQUE (admission_sha256)'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES food_import_batch(id) ON DELETE RESTRICT'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_check', 'c', 'CHECK (((phase = ''staging''::text) = (seal_request_document IS NULL)))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_check1', 'c', 'CHECK (((phase = ''sealed''::text) = (staging_seal_sha256 IS NOT NULL)))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_check2', 'c', 'CHECK (((phase = ''sealed''::text) = (sealed_at IS NOT NULL)))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_check3', 'c', 'CHECK (((phase = ''sealed''::text) = (terminal_document IS NOT NULL)))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_check4', 'c', 'CHECK (((phase = ''sealed''::text) = (terminal_receipt IS NOT NULL)))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_last_page_receipt_sha256_check', 'c', 'CHECK ((last_page_receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_payload_text_bytes_check', 'c', 'CHECK ((payload_text_bytes >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_phase_check', 'c', 'CHECK ((phase = ANY (ARRAY[''staging''::text, ''sealing''::text, ''sealed''::text])))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_pkey', 'p', 'PRIMARY KEY (batch_id)'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_protocol_version_check', 'c', 'CHECK ((protocol_version = 2))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_page_receipt_sha256_check', 'c', 'CHECK ((seal_page_receipt_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_record_commitment_sha256_check', 'c', 'CHECK ((seal_record_commitment_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_request_sha256_check', 'c', 'CHECK ((seal_request_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_verified_intermediate_bytes_check', 'c', 'CHECK ((seal_verified_intermediate_bytes >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_verified_page_count_check', 'c', 'CHECK ((seal_verified_page_count >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_verified_payload_text_bytes_check', 'c', 'CHECK ((seal_verified_payload_text_bytes >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_seal_verified_record_count_check', 'c', 'CHECK ((seal_verified_record_count >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_stage_commitment_sha256_check', 'c', 'CHECK ((stage_commitment_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_stage_page_count_check', 'c', 'CHECK ((stage_page_count >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_staged_count_check', 'c', 'CHECK ((staged_count >= 0))'),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_staging_seal_sha256_check', 'c', 'CHECK ((staging_seal_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_admission_sha256_check', 'c', 'CHECK ((admission_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_admission_sha256_uq', 'u', 'UNIQUE (admission_sha256)'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_batch_id_fk', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_preparation_v2(batch_id)'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_batch_id_pk', 'p', 'PRIMARY KEY (batch_id)'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_check_1', 'c', 'CHECK ((publisher_principal <> admitted_by))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_cutover_barcode_rows_check', 'c', 'CHECK ((max_cutover_barcode_rows > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_cutover_bytes_check', 'c', 'CHECK ((max_cutover_bytes > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_cutover_food_rows_check', 'c', 'CHECK ((max_cutover_food_rows > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_evidence_bytes_check', 'c', 'CHECK ((max_evidence_bytes > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_intermediate_bytes_check', 'c', 'CHECK ((max_intermediate_bytes > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_materialization_bytes_check', 'c', 'CHECK ((max_materialization_bytes > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_max_records_check', 'c', 'CHECK ((max_records > 0))'),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_request_document_check', 'c', 'CHECK (((octet_length(request_document) >= 1) AND (octet_length(request_document) <= 65536)))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_batch_id_fk', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_publication_v2(batch_id)'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_check_3', 'c', 'CHECK (((next_sequence > first_sequence) AND ((next_sequence - first_sequence) <= 250)))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_first_sequence_check', 'c', 'CHECK ((first_sequence >= 0))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_page_number_check', 'c', 'CHECK ((page_number >= 0))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_phase_check', 'c', 'CHECK ((phase = ANY (ARRAY[''materialize''::text, ''verify''::text])))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_pk_1', 'p', 'PRIMARY KEY (batch_id, phase, page_number)'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_request_document_check', 'c', 'CHECK (((octet_length(request_document) >= 1) AND (octet_length(request_document) <= 65536)))'),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_uq_2', 'u', 'UNIQUE (batch_id, phase, first_sequence)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_batch_id_fk', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_publication_v2(batch_id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_check_3', 'c', 'CHECK ((((food_id IS NULL) = (food_version_id IS NULL)) AND ((food_id IS NULL) = (validated_food_sha256 IS NULL))))'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_fk_2', 'f', 'FOREIGN KEY (batch_id, sequence_number) REFERENCES catalogue_validation_record_v2(batch_id, sequence_number)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_food_id_fk', 'f', 'FOREIGN KEY (food_id) REFERENCES food(id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_food_version_id_fk', 'f', 'FOREIGN KEY (food_version_id) REFERENCES food_version(id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_food_version_id_uq', 'u', 'UNIQUE (food_version_id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_import_record_id_fk', 'f', 'FOREIGN KEY (import_record_id) REFERENCES food_import_record(id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_import_record_id_uq', 'u', 'UNIQUE (import_record_id)'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_materialization_bytes_check', 'c', 'CHECK ((materialization_bytes > 0))'),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_pk_1', 'p', 'PRIMARY KEY (batch_id, sequence_number)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_activation_id_fk', 'f', 'FOREIGN KEY (activation_id) REFERENCES food_source_release_activation(id)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_activation_id_uq', 'u', 'UNIQUE (activation_id)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_previous_release_id_fk', 'f', 'FOREIGN KEY (previous_release_id) REFERENCES food_source_release(id)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_request_document_check', 'c', 'CHECK (((octet_length(request_document) >= 1) AND (octet_length(request_document) <= 65536)))'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_request_id_pk', 'p', 'PRIMARY KEY (request_id)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_source_id_fk', 'f', 'FOREIGN KEY (source_id) REFERENCES food_source(id)'),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_target_release_id_fk', 'f', 'FOREIGN KEY (target_release_id) REFERENCES food_source_release(id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_admission_sha256_fk', 'f', 'FOREIGN KEY (admission_sha256) REFERENCES catalogue_publication_admission_v2(admission_sha256)'),
      ('catalogue_publication_v2', 'cat_pub_v2_baseline_release_id_fk', 'f', 'FOREIGN KEY (baseline_release_id) REFERENCES food_source_release(id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_batch_id_fk', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_publication_admission_v2(batch_id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_batch_id_pk', 'p', 'PRIMARY KEY (batch_id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_check_1', 'c', 'CHECK (((seal_sha256 IS NOT NULL) = (phase = ANY (ARRAY[''sealed''::text, ''activated''::text]))))'),
      ('catalogue_publication_v2', 'cat_pub_v2_check_2', 'c', 'CHECK (((activated_at IS NOT NULL) = (phase = ''activated''::text)))'),
      ('catalogue_publication_v2', 'cat_pub_v2_check_3', 'c', 'CHECK (((activation_receipt IS NOT NULL) = (phase = ''activated''::text)))'),
      ('catalogue_publication_v2', 'cat_pub_v2_check_4', 'c', 'CHECK (((finish_receipt IS NOT NULL) = (phase = ANY (ARRAY[''sealed''::text, ''activated''::text]))))'),
      ('catalogue_publication_v2', 'cat_pub_v2_evidence_bytes_check', 'c', 'CHECK ((evidence_bytes >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_initial_generation_check', 'c', 'CHECK ((initial_generation >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_intermediate_bytes_check', 'c', 'CHECK ((intermediate_bytes >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_last_generation_check', 'c', 'CHECK ((last_generation >= initial_generation))'),
      ('catalogue_publication_v2', 'cat_pub_v2_mapping_document_check', 'c', 'CHECK (((jsonb_typeof(mapping_document) = ''array''::text) AND (jsonb_array_length(mapping_document) <= 10000) AND (octet_length((mapping_document)::text) <= 4194304)))'),
      ('catalogue_publication_v2', 'cat_pub_v2_materialization_bytes_check', 'c', 'CHECK ((materialization_bytes >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_materialized_count_check', 'c', 'CHECK ((materialized_count >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_next_sequence_check', 'c', 'CHECK ((next_sequence >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_page_count_check', 'c', 'CHECK ((page_count >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_phase_check', 'c', 'CHECK ((phase = ANY (ARRAY[''materializing''::text, ''verifying''::text, ''sealed''::text, ''activated''::text])))'),
      ('catalogue_publication_v2', 'cat_pub_v2_publication_sha256_uq', 'u', 'UNIQUE (publication_sha256)'),
      ('catalogue_publication_v2', 'cat_pub_v2_release_id_fk', 'f', 'FOREIGN KEY (release_id) REFERENCES food_source_release(id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_release_id_uq', 'u', 'UNIQUE (release_id)'),
      ('catalogue_publication_v2', 'cat_pub_v2_verified_materialized_count_check', 'c', 'CHECK ((verified_materialized_count >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_verified_page_count_check', 'c', 'CHECK ((verified_page_count >= 0))'),
      ('catalogue_publication_v2', 'cat_pub_v2_verified_sequence_check', 'c', 'CHECK ((verified_sequence >= 0))'),
      ('catalogue_reconciliation_baseline_v2', 'catalogue_reconciliation_baseline__batch_id_source_food_key_key', 'u', 'UNIQUE (batch_id, source_food_key)'),
      ('catalogue_reconciliation_baseline_v2', 'catalogue_reconciliation_baseline_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_reconciliation_v2(batch_id)'),
      ('catalogue_reconciliation_baseline_v2', 'catalogue_reconciliation_baseline_v2_pkey', 'p', 'PRIMARY KEY (batch_id, sequence_number)'),
      ('catalogue_reconciliation_page_v2', 'catalogue_reconciliation_page_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_reconciliation_v2(batch_id)'),
      ('catalogue_reconciliation_page_v2', 'catalogue_reconciliation_page_v2_document_check', 'c', 'CHECK ((octet_length(document) <= 16777216))'),
      ('catalogue_reconciliation_page_v2', 'catalogue_reconciliation_page_v2_page_number_check', 'c', 'CHECK ((page_number > 0))'),
      ('catalogue_reconciliation_page_v2', 'catalogue_reconciliation_page_v2_pkey', 'p', 'PRIMARY KEY (batch_id, page_number)'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_baseline_batch_id_fkey', 'f', 'FOREIGN KEY (baseline_batch_id) REFERENCES food_import_batch(id)'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_baseline_release_id_fkey', 'f', 'FOREIGN KEY (baseline_release_id) REFERENCES food_source_release(id)'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_validation_context_v2(batch_id)'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_check', 'c', 'CHECK (((terminal_sha256 IS NULL) = (terminal_receipt IS NULL)))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_context_sha256_check', 'c', 'CHECK ((context_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_next_sequence_check', 'c', 'CHECK ((next_sequence >= 0))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_page_commitment_sha256_check', 'c', 'CHECK ((page_commitment_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_page_count_check', 'c', 'CHECK ((page_count >= 0))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_phase_check', 'c', 'CHECK ((phase = ANY (ARRAY[''metadata''::text, ''baseline''::text, ''candidate''::text, ''removed''::text, ''complete''::text])))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_pkey', 'p', 'PRIMARY KEY (batch_id)'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_terminal_sha256_check', 'c', 'CHECK ((terminal_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_validation_terminal_sha256_check', 'c', 'CHECK ((validation_terminal_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_baseline_release_id_fkey', 'f', 'FOREIGN KEY (baseline_release_id) REFERENCES food_source_release(id)'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_preparation_v2(batch_id)'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_check', 'c', 'CHECK ((((terminal_document IS NULL) AND (terminal_sha256 IS NULL) AND (terminal_receipt IS NULL) AND (phase = ''observing''::text)) OR ((terminal_document IS NOT NULL) AND (terminal_sha256 ~ ''^[0-9a-f]{64}$''::text) AND (terminal_receipt IS NOT NULL) AND (phase = ANY (ARRAY[''validated''::text, ''quarantined''::text])))))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_context_sha256_check', 'c', 'CHECK ((context_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_generation_check', 'c', 'CHECK ((generation >= 0))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_next_sequence_check', 'c', 'CHECK ((next_sequence >= 0))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_page_count_check', 'c', 'CHECK ((page_count >= 0))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_phase_check', 'c', 'CHECK ((phase = ANY (ARRAY[''observing''::text, ''validated''::text, ''quarantined''::text])))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_pkey', 'p', 'PRIMARY KEY (batch_id)'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_policy_check', 'c', 'CHECK ((jsonb_typeof(policy) = ''object''::text))'),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_staging_seal_sha256_check', 'c', 'CHECK ((staging_seal_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_validation_generation_v2', 'catalogue_validation_generation_v2_generation_check', 'c', 'CHECK ((generation >= 0))'),
      ('catalogue_validation_generation_v2', 'catalogue_validation_generation_v2_pkey', 'p', 'PRIMARY KEY (singleton)'),
      ('catalogue_validation_generation_v2', 'catalogue_validation_generation_v2_singleton_check', 'c', 'CHECK (singleton)'),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_validation_context_v2(batch_id)'),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_batch_id_start_sequence_key', 'u', 'UNIQUE (batch_id, start_sequence)'),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_check', 'c', 'CHECK (((end_sequence > start_sequence) AND ((end_sequence - start_sequence) <= 250)))'),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_page_number_check', 'c', 'CHECK ((page_number >= 0))'),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_pkey', 'p', 'PRIMARY KEY (batch_id, page_number)'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record__nutrient_materializable_coun_check', 'c', 'CHECK ((nutrient_materializable_count >= 0))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_batch_id_fkey', 'f', 'FOREIGN KEY (batch_id) REFERENCES catalogue_validation_context_v2(batch_id)'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_batch_id_sequence_number_fkey', 'f', 'FOREIGN KEY (batch_id, sequence_number) REFERENCES food_import_record(batch_id, sequence_number)'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_check', 'c', 'CHECK ((((validation_status = ''valid''::text) AND (source_food_key IS NOT NULL) AND (validated_food_document IS NOT NULL) AND (validated_food_sha256 ~ ''^[0-9a-f]{64}$''::text)) OR ((validation_status = ''quarantined''::text) AND (source_food_key IS NULL) AND (gtin14 IS NULL) AND (validated_food_document IS NULL) AND (validated_food_sha256 IS NULL))))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_excluded_nutrient_count_check', 'c', 'CHECK ((excluded_nutrient_count >= 0))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_nutrient_input_count_check', 'c', 'CHECK ((nutrient_input_count >= 0))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_nutrition_semantic_sha256_check', 'c', 'CHECK ((nutrition_semantic_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_pkey', 'p', 'PRIMARY KEY (batch_id, sequence_number)'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_portion_input_count_check', 'c', 'CHECK ((portion_input_count >= 0))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_record_sha256_check', 'c', 'CHECK ((record_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_validation_status_check', 'c', 'CHECK ((validation_status = ANY (ARRAY[''valid''::text, ''quarantined''::text])))')
    ) expected(table_name,constraint_name,constraint_type,definition)
    left join pg_namespace n on n.nspname=target_schema
    left join pg_class c on c.relnamespace=n.oid and c.relname=expected.table_name
    left join pg_constraint k on k.conrelid=c.oid and k.conname=expected.constraint_name
    where k.oid is null or k.contype::text<>expected.constraint_type or not k.convalidated
      or k.condeferrable or k.condeferred or pg_get_constraintdef(k.oid,false)<>expected.definition
  ) then raise exception 'paged catalogue constraint schema differs' using errcode='55000'; end if;
  if (select count(*) from pg_index i join pg_class c on c.oid=i.indrelid
      join pg_class ix on ix.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=target_schema and (c.relname in ('catalogue_paged_approval_v2','catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2','catalogue_preparation_record_v2','catalogue_preparation_seal_page_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_v2','catalogue_publication_admission_v2','catalogue_publication_page_v2','catalogue_publication_record_v2','catalogue_publication_rollback_v2','catalogue_publication_v2','catalogue_reconciliation_baseline_v2','catalogue_reconciliation_page_v2','catalogue_reconciliation_v2','catalogue_validation_context_v2','catalogue_validation_generation_v2','catalogue_validation_page_v2','catalogue_validation_record_v2') or ix.relname='catalogue_legacy_release_batch_v2_idx')) <> 35 or exists (
    select 1 from (values
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_batch_id_database_principal_key', 'CREATE UNIQUE INDEX catalogue_paged_approval_v2_batch_id_database_principal_key ON public.catalogue_paged_approval_v2 USING btree (batch_id, database_principal)', false, true),
      ('catalogue_paged_approval_v2', 'catalogue_paged_approval_v2_pkey', 'CREATE UNIQUE INDEX catalogue_paged_approval_v2_pkey ON public.catalogue_paged_approval_v2 USING btree (batch_id, approval_role)', true, true),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admissi_source_code_release_key_artif_key', 'CREATE UNIQUE INDEX catalogue_preparation_admissi_source_code_release_key_artif_key ON public.catalogue_preparation_admission_v2 USING btree (source_code, release_key, artifact_sha256)', false, true),
      ('catalogue_preparation_admission_v2', 'catalogue_preparation_admission_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_admission_v2_pkey ON public.catalogue_preparation_admission_v2 USING btree (admission_sha256)', true, true),
      ('catalogue_preparation_budget_usage_v2', 'catalogue_preparation_budget_usage_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_budget_usage_v2_pkey ON public.catalogue_preparation_budget_usage_v2 USING btree (admission_sha256)', true, true),
      ('catalogue_preparation_record_v2', 'catalogue_preparation_record_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_record_v2_pkey ON public.catalogue_preparation_record_v2 USING btree (batch_id, sequence_number)', true, true),
      ('catalogue_preparation_seal_page_v2', 'catalogue_preparation_seal_page_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_seal_page_v2_pkey ON public.catalogue_preparation_seal_page_v2 USING btree (batch_id, page_number)', true, true),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_batch_id_first_sequence_key', 'CREATE UNIQUE INDEX catalogue_preparation_stage_page_v2_batch_id_first_sequence_key ON public.catalogue_preparation_stage_page_v2 USING btree (batch_id, first_sequence)', false, true),
      ('catalogue_preparation_stage_page_v2', 'catalogue_preparation_stage_page_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_stage_page_v2_pkey ON public.catalogue_preparation_stage_page_v2 USING btree (batch_id, page_number)', true, true),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_admission_sha256_key', 'CREATE UNIQUE INDEX catalogue_preparation_v2_admission_sha256_key ON public.catalogue_preparation_v2 USING btree (admission_sha256)', false, true),
      ('catalogue_preparation_v2', 'catalogue_preparation_v2_pkey', 'CREATE UNIQUE INDEX catalogue_preparation_v2_pkey ON public.catalogue_preparation_v2 USING btree (batch_id)', true, true),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_admission_sha256_uq', 'CREATE UNIQUE INDEX cat_pub_admit_v2_admission_sha256_uq ON public.catalogue_publication_admission_v2 USING btree (admission_sha256)', false, true),
      ('catalogue_publication_admission_v2', 'cat_pub_admit_v2_batch_id_pk', 'CREATE UNIQUE INDEX cat_pub_admit_v2_batch_id_pk ON public.catalogue_publication_admission_v2 USING btree (batch_id)', true, true),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_pk_1', 'CREATE UNIQUE INDEX cat_pub_page_v2_pk_1 ON public.catalogue_publication_page_v2 USING btree (batch_id, phase, page_number)', true, true),
      ('catalogue_publication_page_v2', 'cat_pub_page_v2_uq_2', 'CREATE UNIQUE INDEX cat_pub_page_v2_uq_2 ON public.catalogue_publication_page_v2 USING btree (batch_id, phase, first_sequence)', false, true),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_food_version_id_uq', 'CREATE UNIQUE INDEX cat_pub_record_v2_food_version_id_uq ON public.catalogue_publication_record_v2 USING btree (food_version_id)', false, true),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_import_record_id_uq', 'CREATE UNIQUE INDEX cat_pub_record_v2_import_record_id_uq ON public.catalogue_publication_record_v2 USING btree (import_record_id)', false, true),
      ('catalogue_publication_record_v2', 'cat_pub_record_v2_pk_1', 'CREATE UNIQUE INDEX cat_pub_record_v2_pk_1 ON public.catalogue_publication_record_v2 USING btree (batch_id, sequence_number)', true, true),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_activation_id_uq', 'CREATE UNIQUE INDEX cat_pub_rollback_v2_activation_id_uq ON public.catalogue_publication_rollback_v2 USING btree (activation_id)', false, true),
      ('catalogue_publication_rollback_v2', 'cat_pub_rollback_v2_request_id_pk', 'CREATE UNIQUE INDEX cat_pub_rollback_v2_request_id_pk ON public.catalogue_publication_rollback_v2 USING btree (request_id)', true, true),
      ('catalogue_publication_v2', 'cat_pub_v2_batch_id_pk', 'CREATE UNIQUE INDEX cat_pub_v2_batch_id_pk ON public.catalogue_publication_v2 USING btree (batch_id)', true, true),
      ('catalogue_publication_v2', 'cat_pub_v2_publication_sha256_uq', 'CREATE UNIQUE INDEX cat_pub_v2_publication_sha256_uq ON public.catalogue_publication_v2 USING btree (publication_sha256)', false, true),
      ('catalogue_publication_v2', 'cat_pub_v2_release_id_uq', 'CREATE UNIQUE INDEX cat_pub_v2_release_id_uq ON public.catalogue_publication_v2 USING btree (release_id)', false, true),
      ('catalogue_reconciliation_baseline_v2', 'catalogue_reconciliation_baseline__batch_id_source_food_key_key', 'CREATE UNIQUE INDEX catalogue_reconciliation_baseline__batch_id_source_food_key_key ON public.catalogue_reconciliation_baseline_v2 USING btree (batch_id, source_food_key)', false, true),
      ('catalogue_reconciliation_baseline_v2', 'catalogue_reconciliation_baseline_v2_pkey', 'CREATE UNIQUE INDEX catalogue_reconciliation_baseline_v2_pkey ON public.catalogue_reconciliation_baseline_v2 USING btree (batch_id, sequence_number)', true, true),
      ('catalogue_reconciliation_page_v2', 'catalogue_reconciliation_page_v2_pkey', 'CREATE UNIQUE INDEX catalogue_reconciliation_page_v2_pkey ON public.catalogue_reconciliation_page_v2 USING btree (batch_id, page_number)', true, true),
      ('catalogue_reconciliation_v2', 'catalogue_reconciliation_v2_pkey', 'CREATE UNIQUE INDEX catalogue_reconciliation_v2_pkey ON public.catalogue_reconciliation_v2 USING btree (batch_id)', true, true),
      ('catalogue_validation_context_v2', 'catalogue_validation_context_v2_pkey', 'CREATE UNIQUE INDEX catalogue_validation_context_v2_pkey ON public.catalogue_validation_context_v2 USING btree (batch_id)', true, true),
      ('catalogue_validation_generation_v2', 'catalogue_validation_generation_v2_pkey', 'CREATE UNIQUE INDEX catalogue_validation_generation_v2_pkey ON public.catalogue_validation_generation_v2 USING btree (singleton)', true, true),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_batch_id_start_sequence_key', 'CREATE UNIQUE INDEX catalogue_validation_page_v2_batch_id_start_sequence_key ON public.catalogue_validation_page_v2 USING btree (batch_id, start_sequence)', false, true),
      ('catalogue_validation_page_v2', 'catalogue_validation_page_v2_pkey', 'CREATE UNIQUE INDEX catalogue_validation_page_v2_pkey ON public.catalogue_validation_page_v2 USING btree (batch_id, page_number)', true, true),
      ('catalogue_validation_record_v2', 'catalogue_validation_barcode_identity_v2', 'CREATE UNIQUE INDEX catalogue_validation_barcode_identity_v2 ON public.catalogue_validation_record_v2 USING btree (batch_id, gtin14, market_code) WHERE ((validation_status = ''valid''::text) AND (gtin14 IS NOT NULL))', false, true),
      ('catalogue_validation_record_v2', 'catalogue_validation_record_v2_pkey', 'CREATE UNIQUE INDEX catalogue_validation_record_v2_pkey ON public.catalogue_validation_record_v2 USING btree (batch_id, sequence_number)', true, true),
      ('catalogue_validation_record_v2', 'catalogue_validation_source_identity_v2', 'CREATE UNIQUE INDEX catalogue_validation_source_identity_v2 ON public.catalogue_validation_record_v2 USING btree (batch_id, source_food_key) WHERE (validation_status = ''valid''::text)', false, true),
      ('food_import_batch', 'catalogue_legacy_release_batch_v2_idx', 'CREATE INDEX catalogue_legacy_release_batch_v2_idx ON public.food_import_batch USING btree (release_id) WHERE (release_id IS NOT NULL)', false, false)
    ) expected(table_name,index_name,definition,is_primary,is_unique)
    left join pg_namespace n on n.nspname=target_schema
    left join pg_class c on c.relnamespace=n.oid and c.relname=expected.table_name
    left join pg_class ix on ix.relnamespace=n.oid and ix.relname=expected.index_name
    left join pg_index i on i.indexrelid=ix.oid and i.indrelid=c.oid
    where i.indexrelid is null or ix.relowner<>expected_owner_oid or not i.indisvalid or not i.indisready
      or i.indisprimary<>expected.is_primary or i.indisunique<>expected.is_unique
      or i.indnullsnotdistinct or pg_get_indexdef(i.indexrelid)<>expected.definition
  ) then raise exception 'paged catalogue index schema differs' using errcode='55000'; end if;

  -- Parse the fixed source query in this isolated restore transaction. TEMP DDL
  -- does not execute the reader query or persist an application object.
  perform set_config('search_path','pg_catalog, public, pg_temp',true);
  create temporary view catalogue_expected_publication_view_v2 as
select
  food.id as food_id,
  version.id as food_version_id,
  version.version_number,
  food.kind,
  food.source_food_key,
  version.name,
  version.normalized_name,
  version.brand_name,
  version.description,
  version.language_tag,
  version.market_code,
  version.data_quality,
  version.basis_quantity,
  version.basis_unit,
  version.source_modified_at,
  source.id as food_source_id,
  source.code as source_code,
  source.display_name as source_display_name,
  source.license_expression,
  source.attribution_required,
  source.attribution_text,
  release.id as source_release_id,
  release.release_key as source_release_key,
  release.artifact_sha256 as source_artifact_sha256
from food
join food_version as version
  on version.food_id = food.id
  and version.id = food.current_version_id
join food_source as source
  on source.id = food.food_source_id
  and source.active_release_id = version.source_release_id
join food_source_release as release
  on release.id = source.active_release_id
  and release.food_source_id = source.id
where food.kind in ('generic', 'branded')
  and food.visibility = 'public'
  and food.owner_user_id is null
  and food.archived_at is null
  and version.data_quality <> 'quarantined'
  and octet_length(version.name) <= 500
  and octet_length(version.normalized_name) <= 512
  and (
    version.brand_name is null
    or (char_length(btrim(version.brand_name)) > 0 and octet_length(version.brand_name) <= 300)
  )
  and version.source_release_id is not null
  and source.active
  and source.code ~ '^[A-Z][A-Z0-9_]{1,31}$'
  and char_length(btrim(source.display_name)) > 0
  and octet_length(source.display_name) <= 200
  and char_length(btrim(source.license_expression)) > 0
  and octet_length(source.license_expression) <= 256
  and char_length(btrim(source.attribution_text)) > 0
  and octet_length(source.attribution_text) <= 2000
  and source.commercial_use_allowed is true
  and source.redistribution_allowed is true
  and source.rights_review_status in ('approved', 'restricted')
  and source.rights_reviewed_at is not null
  and length(btrim(source.rights_reviewed_by)) > 0
  and release.status = 'promoted'
  and release.promoted_at is not null
  and release.rights_manifest_sha256 is not null
  and (exists (
    select 1
    from food_import_batch as batch
    join food_import_record as record
      on record.batch_id = batch.id
      and record.food_version_id = version.id
      and record.validation_status = 'materialized'
    where batch.food_source_id = source.id
      and batch.release_id = release.id
      and batch.status = 'completed'
      and batch.completed_at is not null
      and not exists (select 1 from catalogue_preparation_v2 preparation where preparation.batch_id=batch.id)
  ) or exists (
    select 1 from catalogue_publication_v2 publication
    join catalogue_publication_record_v2 materialized on materialized.batch_id=publication.batch_id
      and materialized.food_id=food.id and materialized.food_version_id=version.id
    join catalogue_validation_record_v2 validated on validated.batch_id=materialized.batch_id
      and validated.sequence_number=materialized.sequence_number and validated.validation_status='valid'
      and validated.validated_food_sha256=materialized.validated_food_sha256
    join catalogue_validation_context_v2 validation on validation.batch_id=publication.batch_id
      and validation.phase='validated' and validation.terminal_sha256=publication.validation_terminal_sha256
    join catalogue_reconciliation_v2 reconciliation on reconciliation.batch_id=publication.batch_id
      and reconciliation.phase='complete' and reconciliation.context_sha256=publication.context_sha256
      and reconciliation.terminal_sha256=publication.report_sha256
      and reconciliation.validation_terminal_sha256=validation.terminal_sha256
    join catalogue_preparation_v2 preparation on preparation.batch_id=publication.batch_id and preparation.phase='sealed'
    join food_import_batch batch on batch.id=publication.batch_id and batch.food_source_id=source.id
    join food_source_release_activation activation on activation.import_batch_id=publication.batch_id
      and activation.food_source_id=source.id and activation.release_id=release.id
      and activation.operation='activate'
      and activation.database_principal=publication.publisher_principal
      and activation.database_capability_role='nutrition_catalogue_promote_activate'
      and activation.id::text=publication.activation_receipt->>'activationId'
    where publication.release_id=release.id and publication.phase='activated'
      and publication.activated_at is not null and publication.seal_sha256 is not null
      and publication.finish_receipt is not null and publication.activation_receipt is not null
      and publication.next_sequence=preparation.staged_count
      and publication.verified_sequence=publication.next_sequence
      and publication.verified_page_count=publication.page_count
      and publication.materialized_count=validation.valid_count
      and publication.verified_materialized_count=publication.materialized_count
      and batch.release_class='live-reviewed' and release.release_class='live-reviewed'
      and publication.activation_receipt->>'activeReleaseId'=release.id::text
      and release.validation_summary->>'publicationProtocolVersion'='2'
      and release.validation_summary->>'publicationSha256'=publication.publication_sha256
      and release.validation_summary->>'batchId'=batch.id::text
  ));
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=target_schema and c.relname='promoted_food_search_catalogue_v1'
      and c.relkind='v' and c.relowner=expected_owner_oid and c.reloptions is null
      and pg_get_viewdef(c.oid,false)=pg_get_viewdef('pg_temp.catalogue_expected_publication_view_v2'::regclass,false)) then
    raise exception 'catalogue public eligibility view differs from source policy' using errcode='55000';
  end if;
  drop view pg_temp.catalogue_expected_publication_view_v2;

  -- Pin the complete authority function boundary through migration 0022.
  -- Exact identity, executable body, and search_path are policy, not
  -- merely source/target parity.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_nutrient_ontology_update',
        'guard_source_nutrient_map_update',
        'catalogue_admit_preparation_v2',
        'catalogue_advance_validation_generation_v2',
        'catalogue_assert_validation_context_v2',
        'catalogue_begin_preparation_seal_v2',
        'catalogue_begin_preparation_v2',
        'catalogue_begin_reconciliation_v2',
        'catalogue_begin_validation_v2',
        'catalogue_charge_preparation_budget_v2',
        'catalogue_compute_record_nutrition_semantics_v2',
        'catalogue_finish_preparation_seal_v2',
        'catalogue_finish_reconciliation_v2',
        'catalogue_finish_validation_v2',
        'catalogue_frame_sha256_v2',
        'catalogue_guard_legacy_batch_preparation_v2',
        'catalogue_guard_legacy_record_preparation_v2',
        'catalogue_guard_preparation_evidence_insert_v2',
        'catalogue_guard_preparation_source_insert_v2',
        'catalogue_guard_preparation_v2',
        'catalogue_guard_validation_context_v2',
        'catalogue_guard_validation_evidence_v2',
        'catalogue_guard_validation_generation_v2',
        'catalogue_mapping_digest_for_validation_v2',
        'catalogue_normalize_gtin_v2',
        'catalogue_normalize_source_text_v2',
        'catalogue_observe_validation_page_v2',
        'catalogue_preparation_uint_v2',
        'catalogue_prepare_reconciliation_page_v2',
        'catalogue_read_preparation_admission_v2',
        'catalogue_read_reconciliation_page_v2',
        'catalogue_reconciliation_baseline_header_v2',
        'catalogue_reconciliation_baseline_record_v2',
        'catalogue_reconciliation_detail_v2',
        'catalogue_reconciliation_input_v2',
        'catalogue_reconciliation_validation_page_v2',
        'catalogue_record_paged_approval_v2',
        'catalogue_reject_legacy_batch_v2',
        'catalogue_reject_legacy_record_v2',
        'catalogue_reject_legacy_release_v2',
        'catalogue_reject_legacy_stage_document_v2',
        'catalogue_require_preparation_role_v2',
        'catalogue_stage_preparation_page_v2',
        'catalogue_submit_validation_page_v2',
        'catalogue_utf16_sort_key_v2',
        'catalogue_verify_preparation_seal_page_v2',
        'guard_catalogue_paged_approval_v2',
        'guard_catalogue_reconciliation_evidence_v2',
        'guard_catalogue_reconciliation_state_v2',
        'catalogue_publication_request_v2',
        'catalogue_publication_receipt_v2',
        'catalogue_publication_timeouts_v2',
        'catalogue_publication_progress_v2',
        'catalogue_lock_publication_v2',
        'catalogue_assert_publication_approvals_v2',
        'catalogue_admit_publication_v2',
        'catalogue_begin_publication_v2',
        'catalogue_materialize_publication_record_v2',
        'catalogue_verify_publication_record_v2',
        'catalogue_advance_publication_page_v2',
        'catalogue_materialize_publication_page_v2',
        'catalogue_verify_publication_page_v2',
        'catalogue_finish_publication_v2',
        'catalogue_read_publication_v2',
        'catalogue_verify_legacy_publication_record_v2',
        'catalogue_publication_target_barcodes_v2',
        'catalogue_assert_publication_cutover_budget_v2',
        'catalogue_cutover_publication_v2',
        'catalogue_activate_publication_v2',
        'catalogue_rollback_publication_v2',
        'catalogue_guard_publication_v2',
        'advance_food_search_projection_revision',
        'catalogue_attest_import_nutrition_semantics',
        'catalogue_canonical_decimal_product',
        'catalogue_compute_import_staging_seal',
        'catalogue_compute_record_nutrition_semantics',
        'catalogue_evidence_bundle_uri_is_valid',
        'catalogue_observe_import_validation',
        'catalogue_promote_import_batch',
        'catalogue_promote_import_batch_v1',
        'catalogue_record_import_approval',
        'catalogue_record_import_approval_v1',
        'catalogue_rollback_source_release',
        'catalogue_rollback_source_release_v1',
        'catalogue_stage_import_batch',
        'catalogue_stage_import_parser_report',
        'catalogue_stage_import_record_chunk',
        'catalogue_utf16_length',
        'catalogue_validate_import_batch',
        'catalogue_validate_import_batch_v1',
        'enqueue_food_search_barcode_insert',
        'enqueue_food_search_barcode_update',
        'enqueue_food_search_food_eligibility_change',
        'enqueue_food_search_serving_insert',
        'enqueue_food_search_source_eligibility_change',
        'guard_active_nutrient_vector_size',
        'guard_custom_food_child_insert_v3',
        'guard_custom_food_immutable_evidence_v3',
        'guard_food_barcode_validity_update',
        'guard_food_import_approval_authority',
        'guard_food_import_batch_initial_state',
        'guard_food_import_batch_nutrition_semantics',
        'guard_food_import_batch_stage_validate_authority',
        'guard_food_import_batch_update',
        'guard_food_import_batch_validation_digest',
        'guard_food_import_record_insert_before_staging_seal',
        'guard_food_import_record_nutrition_semantics',
        'guard_food_import_record_update',
        'guard_food_import_stage_checkpoint_before_staging_seal',
        'guard_imported_food_version_child_delete',
        'guard_food_source_active_release_authority',
        'guard_food_source_initial_active_release',
        'guard_food_source_release_activation_authority',
        'guard_food_source_release_initial_state',
        'guard_food_source_release_legacy_promotion_grandfather',
        'guard_food_source_release_update',
        'guard_new_food_source_release_authority',
        'guard_source_barcode_delete',
        'lock_active_nutrient_registry_before_write',
        'lock_active_nutrient_registry_for_read',
        'reconcile_recipe_components_v2',
        'reject_immutable_row_update',
        'reject_new_legacy_unbound_catalogue_evidence',
        'set_row_updated_at',
        'validate_food_version_child_insert'
      )
  ) <> 125 or exists (
    select 1
    from (
      values
        ('guard_nutrient_ontology_update', '', '47bad1ed4fa257d351c565baf0a7acd53299dddeaa331440733a41b98bc1c9f5', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_source_nutrient_map_update', '', 'c6e8ae4ac0193362d52adf37af7adb8229b23c62777a692c89630893216d4a0c', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_admit_preparation_v2', 'p_document text', '186afb6bae243ba6d53966399ac26218cc46458a674988fce999aef3db307c41', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_advance_validation_generation_v2', '', '84e0fdf15075edda2f1a4e8bc7eee794f4c836bf10ffdcdce1a9aee235c26fff', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_assert_validation_context_v2', 'p_batch_id uuid', 'f5d3c29268bca5e17fef9a5064b6cbceaf345df77cb2baf714ac66096660e254', 'void', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_begin_preparation_seal_v2', 'p_batch_id uuid, p_document text', 'ef9b35f1ca864abed5f1a73df437f8797b6882ada3318cb7c4eb37fee86c431f', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_begin_preparation_v2', 'p_admission_sha256 text, p_stage_document text', '780c91e2ae3d06d5903da649829e35d8aea16a41ca527db811ef0f8f3b666d8a', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_begin_reconciliation_v2', 'p_batch_id uuid, p_terminal text, p_baseline uuid, p_context text', 'e3625afe37c7976f9d8696b2f8346095099e0f2cf449d0e92682779a802e3f27', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_begin_validation_v2', 'p_batch_id uuid, p_staging_seal_sha256 text, p_policy_document text', 'c9e6e03fede89ffabf900d5237190688bdb1be0afb220a17b2d1cb89e1193a7c', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_charge_preparation_budget_v2', 'p_batch_id uuid, p_intermediate_delta bigint, p_validation_delta bigint, p_reconciliation_delta bigint', '2e152411c6ceac8e55ee762ea6e6cd5cc496166b26c358a1d9aea203ebf32016', 'void', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_compute_record_nutrition_semantics_v2', 'p_record_id bigint, p_batch_id uuid', '9cef56f57959f3a2d5cc531afd881ee4d92eb40111c41e89bcfb9e6a7be47e6a', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_finish_preparation_seal_v2', 'p_batch_id uuid, p_document text', '4168a104846e8f72100b552b454b29b2fe3eaa6f9a877d1e00ce63494526d948', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_finish_reconciliation_v2', 'p_batch_id uuid, p_context text, p_pages bigint, p_commitment text', '42510f16d9fcc30581e0ea662c2b094d33f1d28d3db761a4013b99faca26cf98', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_finish_validation_v2', 'p_batch_id uuid, p_terminal_document text', '7de11e47c152e3b1b58a959a5678972cc81b893b9a995c08f090f33456fc248f', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_frame_sha256_v2', 'p_domain text, p_fields text[]', '786cd3683fdb6c9794365f6a841ee63e27b3c335b53f3b89df0070cc1f0ca6e1', 'text', 'plpgsql', 'i', false, false, 'u', false),
        ('catalogue_guard_legacy_batch_preparation_v2', '', '2323e930b55486bf9c9c7e0cf65858670cdaaa22a5ae9101755f3c3b59712e75', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_guard_legacy_record_preparation_v2', '', '068696ad0ab7a4ff6a145eb3dd95ec62832f69d3e924a9d5768b692f802aa8fc', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_guard_preparation_evidence_insert_v2', '', '87129394a8edb35f750a730d56b07d40edac99492609838eb113912e0033a04b', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_guard_preparation_source_insert_v2', '', '5132b4105d934fd88b560df535f841731c6330dc6dea2bbbec2ac6c1021ae03c', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_guard_preparation_v2', '', '466ee7633cffcec06195d3beff8479bc221eced092665965aef7eb059c2b84a2', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_guard_validation_context_v2', '', '5b67d69a31c82a3ed6900ab465babeb55801ed06c0a581ed8a75f83deec49215', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_guard_validation_evidence_v2', '', 'a47d0255bc5b9697f2e5eb7d9ac16328c042710c5dc5ce8dd465439248d511fa', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_guard_validation_generation_v2', '', '36b6eeacd97107fe02b0b9285c78b476a2bd3075282d40a17b02d61705fe1379', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('catalogue_mapping_digest_for_validation_v2', 'p_source_id bigint', '3368e302ca95d612f19a5407309917c51a2716a7c5e9a4a9066d779d21e3a13b', 'text', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_normalize_gtin_v2', 'p_value text', '81b42abfbbe76a632640bd57a9568d05226938e281bf1fead63ff76aa53a6728', 'text', 'plpgsql', 'i', false, false, 's', false),
        ('catalogue_normalize_source_text_v2', 'p_value text', 'e098cf8348b723c46e150c05a25ded716e0309c45e5d38a476d643d7bd716745', 'text', 'sql', 'i', true, false, 's', false),
        ('catalogue_observe_validation_page_v2', 'p_batch_id uuid, p_start_sequence bigint, p_maximum_records integer', '743618753ca47ccd11e6f0e6bd871704d458949711cb6102ee00c972dd534123', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_preparation_uint_v2', 'p_value jsonb', 'ed8877d47a0c6a92b0c5ebdc1d6e36086bf0287650de0cd3c335f29db75b69ae', 'bigint', 'plpgsql', 'i', false, false, 'u', false),
        ('catalogue_prepare_reconciliation_page_v2', 'p_batch_id uuid, p_context text, p_page bigint', 'ada1304ce7e766b63d829d9af0b68504e5b56ef8bc15a595e4a25cbc09da25cc', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_read_preparation_admission_v2', 'p_admission_sha256 text', 'b31733d1ed923863fc38688834f7fba65681c9e8c1576bb9c83beeccb62e529c', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_read_reconciliation_page_v2', 'p_batch_id uuid, p_report text, p_page bigint, p_role text, p_principal text', '561cf06b1a8324ba8ce552fe6c0fe75169e95311ab03401dcf6c4e063cd71cf5', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_reconciliation_baseline_header_v2', 'p_batch_id uuid', '955240cc42ddb8daa2a4420334f4517b4bbb99cd8f51233dfeb43dd3a1843a53', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_reconciliation_baseline_record_v2', 'p_record_id bigint, p_release_id uuid', 'd8032d71e259aa56ba70e4c060937e3d69b3e01ddaf151ec4a9a4e52034cccf4', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_reconciliation_detail_v2', 'p_before jsonb, p_after jsonb', '89de7f9c6dc97e4e6b89bc1f8d506803368ed1b6a63377adea0de32d015ced7d', 'jsonb', 'sql', 's', false, false, 'u', true),
        ('catalogue_reconciliation_input_v2', 'p_batch_id uuid, p_validation_terminal_sha256 text', '3d70e181d4597ae6d2be0d011bb40c6a3699af996a1ca76772f53cac46c4d278', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_reconciliation_validation_page_v2', 'p_batch_id uuid, p_terminal text, p_page bigint', '3fc76a7de548e1b944541910b7137faa2eff3b9f9635c420f82a9261e47ba6f4', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_record_paged_approval_v2', 'p_batch_id uuid, p_role text, p_principal text, p_rights text, p_validation_terminal text, p_report text, p_context text, p_reference text', 'e336a4b2e28bfb2e05942bdcf29fe9b1fa5ba0132babd9a92817cd365fa7defe', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_reject_legacy_batch_v2', 'p_batch_id uuid', '3efd4cea547f4f7fbbaaac478b80e2b6a268e32034a910bb45e955f54ff6e88a', 'void', 'plpgsql', 's', false, false, 'u', true),
        ('catalogue_reject_legacy_record_v2', 'p_record_id bigint', '304f46808cea837f3bdd1211af5edac27a9e4625cbae8ae808f2b9e7a3c8cf69', 'void', 'plpgsql', 's', false, false, 'u', true),
        ('catalogue_reject_legacy_release_v2', 'p_release_id uuid', '48e36b25e9c16f670385041811610564220bfe52f3313c142c7e25c9e5d65f3a', 'void', 'plpgsql', 's', false, false, 'u', true),
        ('catalogue_reject_legacy_stage_document_v2', 'p_document text', '943d76ce5ad93805cfc937eea2544a1a84a75d87232e7fcdc4a8af498f2fd131', 'void', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_require_preparation_role_v2', 'p_role text', '7a1284c7da1e999e2ac0c72eef8171f029c88986c423f2a1edb6b300260d38a1', 'text', 'plpgsql', 's', false, false, 'u', false),
        ('catalogue_stage_preparation_page_v2', 'p_batch_id uuid, p_document text', '1a7ccde35c3c4427b4dbdefc3a5f76cbf91a3cd0715d949f72d0674adedc5f02', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_submit_validation_page_v2', 'p_batch_id uuid, p_request_document text', '18c0861fa16d9036c60b9bcc912f4548adb85827d54066d7c018f35bc569c91d', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_utf16_sort_key_v2', 'p_value text', '04570b922d4a23ee14eddc6180f4b52b9ef66774200ddc18dd124544ee097370', 'text', 'sql', 'i', true, false, 's', false),
        ('catalogue_verify_preparation_seal_page_v2', 'p_batch_id uuid, p_page_number bigint', '50f79cfe28ac9a09d32d99cbf9fbc87f56f265db61a66b14848fd75d64fc866e', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('guard_catalogue_paged_approval_v2', '', '0d48ff1d8bb9e354c7cd0471ff4829f473498c69f8b021fbe097d0c2a323356a', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('guard_catalogue_reconciliation_evidence_v2', '', '6793ddf19e8dbdfa947dad6855c10c9249c5cea78fe876db662b3f3a20b08a9e', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('guard_catalogue_reconciliation_state_v2', '', '97bdfe125868708ce265f8ad7416b2c38c37ce3e9e714e8623cf0aeb3b55e1b2', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_publication_request_v2', 'p_document text, p_keys text[]', '35a316c13432448109697d4a59131f42316bffc0243ca863473b0716c832c2a9', 'jsonb', 'plpgsql', 'i', false, false, 'u', false),
        ('catalogue_publication_receipt_v2', 'p_core jsonb', 'a437c365feb70650d8a0148efdb09014278b1952dfde292b9c1f0c0eebc7b4db', 'jsonb', 'sql', 'i', true, false, 'u', false),
        ('catalogue_publication_timeouts_v2', '', 'cd372d03caf870d722715f04a953bdb3320b844fcc257228fa145eed7ac91810', 'void', 'plpgsql', 's', false, false, 'u', false),
        ('catalogue_publication_progress_v2', 'p_batch_id uuid', '5c8c0c2830f3874b0c801cbf8b3cf4f58b7f21f8cb51ab621da6ccae7ce89aff', 'jsonb', 'sql', 's', false, false, 'u', true),
        ('catalogue_lock_publication_v2', 'p_batch_id uuid, p_actor text, p_require_live boolean', 'ceaeb9c5c29629485e12e40f8754fb325cc6f265039e65b7529d97c55a712abd', 'void', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_assert_publication_approvals_v2', 'p_batch_id uuid, p_context text, p_terminal text, p_report text, p_actor text', '0cc9ca58fd5951e5a7891768452e8aac54eeb04658d30b906633146c1df37eb8', 'void', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_admit_publication_v2', 'p_document text', 'f6f98257e2605be175f65c2a63634dd1b23c9f616c479e5bd7e14f3cb3656945', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_begin_publication_v2', 'p_document text', '620deb405daa84cd700eb090500cbeddf36706ccf4bc7643d50b9c24024776f4', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_materialize_publication_record_v2', 'p_batch_id uuid, p_sequence bigint', 'e274f7f186ab341c94c6a81810da4a6e5353a55dd4d64dbaaa6676d71a14100c', 'bigint', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_verify_publication_record_v2', 'p_batch_id uuid, p_sequence bigint', '189de2455deb548fb923cfb5b67d0cffadbc78d16dbeaa895881f65f7c7f65a7', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_advance_publication_page_v2', 'p_document text, p_phase text', '4685582d152496335b797ddf6f0eeabfb6cf34765317a088dd971d07d7af418e', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_materialize_publication_page_v2', 'p_document text', '48f24147dd0daa3d900509cb6c4e5529c854088b4e74da971273476578738724', 'jsonb', 'sql', 'v', false, false, 'u', true),
        ('catalogue_verify_publication_page_v2', 'p_document text', '6711dbb46ed60dc4e6023c92b8ad01b637c7abd076b45adaf47df42194dcb7dd', 'jsonb', 'sql', 'v', false, false, 'u', true),
        ('catalogue_finish_publication_v2', 'p_document text', '1e5cedeff52e4026b8d23c72e410eb00ea219721edbdc32b58a19a8f5516cc7e', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_read_publication_v2', 'p_batch_id uuid', 'c0e2971e9ff47e0b44442870cbc088e99faf8311b8718b0e444d113d53b0c460', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_verify_legacy_publication_record_v2', 'p_record_id bigint, p_release_id uuid', 'b40a94a9ae384af3fb028c6c6a0d0702917aaa3b17b8e5794f7a61906f083eeb', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_publication_target_barcodes_v2', 'p_release_id uuid', '4a2c084f857f0da08922cc13fde3273877dc64af5b7c78dcd8a48e7645be1806', 'TABLE(food_id bigint, food_version_id bigint, gtin text, market_code text)', 'sql', 's', false, false, 'u', true),
        ('catalogue_assert_publication_cutover_budget_v2', 'p_source_id bigint, p_target uuid, p_budget_batch uuid, p_extra_bytes bigint', '8cef92219afffd57dcf2fc76a22109cb912c570ca48f3b8b8048715e82fd4881', 'void', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_cutover_publication_v2', 'p_source_id bigint, p_target uuid, p_operation text, p_batch uuid, p_actor text, p_reason text', '7b38fcbd65c1ad33b77f9177deea63b3e851febcaac085d38fb32ae59708f35b', 'bigint', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_activate_publication_v2', 'p_document text', 'ccb20f7259ef33f04b3d0d39a33da941576f1ccb6fd46ca0a7cef5de5f04b937', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_rollback_publication_v2', 'p_document text', '6c5320dae7452747738fc52eb6d44716c60e68740e8695d727f42465976abe71', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_guard_publication_v2', '', '649b36ed52f65e1888d1ba52dd8228f4fe671b0f4037d438891dabf89d8955e9', 'trigger', 'plpgsql', 'v', false, false, 'u', true),
        ('advance_food_search_projection_revision'::text, ''::text, 'd1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108'::text, 'void'::text, 'plpgsql'::text, 'v'::text, false, false, 'u'::text, false),
        ('catalogue_attest_import_nutrition_semantics', 'p_batch_id uuid', '3b6b5d6de655e09c4935379fbaa356429961dedb39264cb25913e16c3a2c2e59', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_canonical_decimal_product', 'p_left text, p_right text', '299a2c88226123f167fe2d7001fdaf6a2e02425007f2426c8def9d0bb83a46c0', 'text', 'plpgsql', 'i', true, false, 's', false),
        ('catalogue_compute_import_staging_seal', 'p_batch_id uuid', 'e7dbe4dc44ca8cef1183b966384000a3a252e4f92cc644091d46281e04d91822', 'text', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_compute_record_nutrition_semantics', 'p_record_id bigint', 'b0e547a757ad01f0a2c2360beea10607b5bfec9770fbbeb571598db7cf9ead69', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_evidence_bundle_uri_is_valid'::text, 'value text, digest text'::text, '5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e'::text, 'boolean'::text, 'sql'::text, 'i'::text, true, false, 'u'::text, false),
        ('catalogue_observe_import_validation', 'p_batch_id uuid', '84179971a6b8f171436efc1807e4e89c0f4b19bd3778b56bf3dea896aab009a2', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_promote_import_batch', 'p_batch_id uuid, p_external_principal_id text, p_reason text', 'feb716548ef14da6dace4c12fd18b98d462766a9a59de0d71aff1b5b9c606ae3', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_promote_import_batch_v1', 'p_batch_id uuid, p_external_principal_id text, p_reason text', '2d5733cf34f2119db2e18564469fc76adf892172a936b1bfcbd21b3899629c96', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_record_import_approval', 'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text', '9dfaa30970c3acfaaff6a1c1c4211cfd0b42c87824998841172429c4dcd5138f', 'boolean', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_record_import_approval_v1', 'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text', '57a131aea73ba58d76f8d7cd867ea2cb2485567f65dc4c28c5a9ffe8963ca198', 'boolean', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_rollback_source_release', 'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text', 'b9bda857bcce39b37ee33728198fe8d15b112792fc9c1cb33c921a6ab1113d21', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_rollback_source_release_v1', 'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text', '1427d676a8322e2a83b436c70264ff6f18ebe2f793aceb9e138b766403caa303', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_batch', 'p_stage_document text', 'e35607a581873d4b7c3b092be4c60a63026b71db21e447c87c79aebb42e21445', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_parser_report', 'p_batch_id uuid, p_parser_report_document text', '111c05a916f5fdce9be9ec6117d8220a239fff749efd628afb4164b3dc89f6a5', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_record_chunk', 'p_batch_id uuid, p_expected_next_offset bigint, p_records_document text', 'd8e8d2354606768fdcaacd280fd2255359ace98758b3d8377f90a94e802541a2', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_utf16_length', 'p_value text', '3a1759986b190b3ccac086e5da943ada91f3cc8c3a94ce6942657faae389ef39', 'bigint', 'sql', 'i', true, false, 's', false),
        ('catalogue_validate_import_batch', 'p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text', 'e57096da8349e9efa58cdcc7293b36a895731a35ce7c8ad1dc55c1f4b4db9b66', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_validate_import_batch_v1', 'p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text', '0c14bff909d45e0fc0082962484db94af8853761d82e7654dc4494fc78f0d294', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('enqueue_food_search_barcode_insert', '', '4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('enqueue_food_search_barcode_update', '', '9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('enqueue_food_search_food_eligibility_change', '', '85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('enqueue_food_search_serving_insert', '', '223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('enqueue_food_search_source_eligibility_change', '', '3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_active_nutrient_vector_size', '', '24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_custom_food_child_insert_v3', '', 'f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_custom_food_immutable_evidence_v3', '', '5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_barcode_validity_update', '', '7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_approval_authority', '', 'f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_initial_state', '', '2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_nutrition_semantics', '', '298b898cd252f08aa9a5f212e85750aeba79cc41616c71afcd3f129471a6cf5c', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_stage_validate_authority', '', 'f21dfa9d5455a40ab9f50bdbace02ffc19f53ab252e0eab99a4f50769f678eda', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_update', '', '8863eef0e6889a620deec204e249ac3d6efdc87310dcc9d25601e6d7f336101f', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_validation_digest', '', 'c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_record_insert_before_staging_seal', '', '2fc46ef24e03309e61832491438746967642911b02e97896f8a0bdf6fc5aa8bc', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_record_nutrition_semantics', '', '489c1c4b970c6ba369503854701c980ebcb1510c754050e78355fed94647e0e8', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_record_update', '', '300e6853e7a9520b477256b3b32a4381f3143512b013a4e131a4c203ce524479', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_stage_checkpoint_before_staging_seal', '', '66e2078cf57d658268f547c25df26750ebe5b7b6402de9fcecdc2249c14f28ef', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_imported_food_version_child_delete', '', '4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_active_release_authority', '', '306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_initial_active_release', '', 'e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_activation_authority', '', '54f0413a565c93fc6d76846873844a03488594580250ba2bc1c9f4117d3ab68a', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_initial_state', '', '797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_legacy_promotion_grandfather', '', '22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_update', '', '191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_new_food_source_release_authority', '', '93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_source_barcode_delete', '', 'd4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('lock_active_nutrient_registry_before_write', '', 'c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('lock_active_nutrient_registry_for_read', '', '22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5', 'void', 'sql', 'v', false, false, 'u', false),
        ('reconcile_recipe_components_v2', '', 'c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('reject_immutable_row_update', '', '631a42e27de6543bc09fd6b8d0f1b0fd336250270b47f13849a2483fd0786e6e', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('reject_new_legacy_unbound_catalogue_evidence', '', 'f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('set_row_updated_at', '', '92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('validate_food_version_child_insert', '', '5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07', 'trigger', 'plpgsql', 'v', false, false, 'u', false)
    ) as expected(
      function_name, arguments, source_sha256, result_type, language_name,
      volatility, is_strict, is_leakproof, parallel_mode, security_definer
    )
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.pronamespace = namespace_row.oid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = expected.arguments
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or namespace_row.oid is null
      or procedure_row.proowner <> expected_owner_oid
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> expected.result_type
      or language_row.lanname <> expected.language_name
      or procedure_row.provolatile::text <> expected.volatility
      or procedure_row.proisstrict is distinct from expected.is_strict
      or procedure_row.proleakproof is distinct from expected.is_leakproof
      or procedure_row.proparallel::text <> expected.parallel_mode
      or procedure_row.prosecdef is distinct from expected.security_definer
      or procedure_row.proconfig is distinct from case
        when expected.function_name in ('reject_immutable_row_update','guard_nutrient_ontology_update','guard_source_nutrient_map_update') then null::text[]
        else array['search_path=pg_catalog, public, pg_temp']::text[]
      end
  ) then
    raise exception 'catalogue authority function identity or executable semantics differ from policy'
      using errcode = '55000';
  end if;

  -- Pin every non-internal trigger attached to the reviewed authority
  -- functions, including all five food-search outbox paths, all seven active
  -- nutrient registry protocol paths, and both grandfather and legacy-evidence
  -- trigger sites.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where not trigger_row.tgisinternal
      and (
        (
          namespace_row.nspname = target_schema
          and class_row.relname in (
            'catalogue_publication_admission_v2',
            'catalogue_publication_v2',
            'catalogue_publication_record_v2',
            'catalogue_publication_page_v2',
            'catalogue_publication_rollback_v2',
            'promoted_food_search_catalogue_v1',
            'catalogue_paged_approval_v2',
            'catalogue_preparation_admission_v2',
            'catalogue_preparation_budget_usage_v2',
            'catalogue_preparation_record_v2',
            'catalogue_preparation_seal_page_v2',
            'catalogue_preparation_stage_page_v2',
            'catalogue_preparation_v2',
            'catalogue_reconciliation_baseline_v2',
            'catalogue_reconciliation_page_v2',
            'catalogue_reconciliation_v2',
            'catalogue_validation_context_v2',
            'catalogue_validation_generation_v2',
            'catalogue_validation_page_v2',
            'catalogue_validation_record_v2',
            'nutrient',
            'source_nutrient_map',
            'source_nutrient_map_revision',
            'food',
            'food_barcode',
            'food_import_approval',
            'food_import_batch',
            'food_import_checkpoint',
            'food_import_parser_report',
            'food_import_record',
            'food_nutrient_value',
            'food_search_projection_revision',
            'food_serving',
            'food_source',
            'food_source_release',
            'food_source_release_activation',
            'food_version',
            'outbox_event'
          )
        )
        or (
          namespace_row.nspname = target_schema
          and trigger_row.tgname in (
            'catalogue_publication_admission_v2_guard',
            'catalogue_publication_admission_v2_truncate',
            'catalogue_publication_v2_guard',
            'catalogue_publication_v2_truncate',
            'catalogue_publication_record_v2_guard',
            'catalogue_publication_record_v2_truncate',
            'catalogue_publication_page_v2_guard',
            'catalogue_publication_page_v2_truncate',
            'catalogue_publication_rollback_v2_guard',
            'catalogue_publication_rollback_v2_truncate',
            'catalogue_paged_approval_v2_guard',
            'catalogue_paged_approval_v2_immutable',
            'catalogue_paged_approval_v2_truncate_guard',
            'catalogue_preparation_admission_v2_immutable',
            'catalogue_preparation_admission_v2_insert',
            'catalogue_preparation_budget_guard_v2',
            'catalogue_preparation_budget_usage_v2_insert',
            'catalogue_preparation_guard_v2',
            'catalogue_preparation_record_v2_immutable',
            'catalogue_preparation_record_v2_insert',
            'catalogue_preparation_seal_page_v2_immutable',
            'catalogue_preparation_seal_page_v2_insert',
            'catalogue_preparation_stage_page_v2_immutable',
            'catalogue_preparation_stage_page_v2_insert',
            'catalogue_reconciliation_baseline_v2_guard',
            'catalogue_reconciliation_baseline_v2_immutable',
            'catalogue_reconciliation_baseline_v2_truncate_guard',
            'catalogue_reconciliation_page_v2_guard',
            'catalogue_reconciliation_page_v2_immutable',
            'catalogue_reconciliation_page_v2_truncate_guard',
            'catalogue_reconciliation_state_v2_guard',
            'catalogue_reconciliation_state_v2_truncate_guard',
            'catalogue_validation_context_immutable_v2',
            'catalogue_validation_context_truncate_v2',
            'catalogue_validation_generation_monotonic_v2',
            'catalogue_validation_generation_truncate_v2',
            'catalogue_validation_page_immutable_v2',
            'catalogue_validation_page_insert_v2',
            'catalogue_validation_page_truncate_v2',
            'catalogue_validation_record_immutable_v2',
            'catalogue_validation_record_insert_v2',
            'catalogue_validation_record_truncate_v2',
            'food_barcode_validation_generation_v2',
            'food_import_approval_validation_generation_v2',
            'food_import_batch_preparation_legacy_fence_v2',
            'food_import_batch_validation_generation_v2',
            'food_import_parser_report_validation_generation_v2',
            'food_import_record_preparation_legacy_fence_v2',
            'food_import_record_preparation_phase_v2',
            'food_import_record_validation_generation_v2',
            'food_nutrient_value_validation_generation_v2',
            'food_serving_validation_generation_v2',
            'food_source_release_validation_generation_v2',
            'food_source_validation_generation_v2',
            'food_validation_generation_v2',
            'food_version_validation_generation_v2',
            'nutrient_validation_generation_v2',
            'source_nutrient_map_revision_validation_generation_v2',
            'source_nutrient_map_validation_generation_v2',
            'food_import_approval_guard_authority',
            'food_import_batch_guard_initial_state',
            'food_import_batch_guard_nutrition_semantics',
            'food_import_batch_guard_stage_validate_authority',
            'food_import_batch_guard_update',
            'food_import_batch_guard_validation_digest',
            'food_import_batch_reject_new_legacy_unbound',
            'food_import_checkpoint_guard_staging_seal',
            'food_import_checkpoint_set_updated_at',
            'food_import_parser_report_reject_update',
            'food_import_record_guard_staging_seal',
            'food_import_record_guard_nutrition_semantics',
            'food_import_record_guard_update',
            'food_search_barcode_insert_outbox',
            'food_search_barcode_update_outbox',
            'food_search_eligibility_outbox',
            'food_search_serving_insert_outbox',
            'food_source_guard_active_release_authority',
            'food_source_guard_initial_active_release',
            'food_source_search_eligibility_outbox',
            'food_source_release_guard_initial_state',
            'food_source_release_guard_legacy_grandfather_insert',
            'food_source_release_guard_legacy_grandfather_update',
            'food_source_release_guard_new_authority',
            'food_source_release_guard_update',
            'food_source_release_reject_new_legacy_unbound',
            'nutrient_active_vector_size_guard',
            'nutrient_registry_lock_before_active_update',
            'nutrient_registry_lock_before_insert',
            'recipe_ingredient_reconcile_v2',
            'recipe_nutrient_reconcile_v2',
            'recipe_source_reconcile_v2',
            'recipe_version_components_reconcile_v2'
          )
        )
        or (
          procedure_namespace_row.nspname = target_schema
          and procedure_row.proname in (
            'catalogue_guard_publication_v2',
            'catalogue_advance_validation_generation_v2',
            'catalogue_guard_legacy_batch_preparation_v2',
            'catalogue_guard_legacy_record_preparation_v2',
            'catalogue_guard_preparation_evidence_insert_v2',
            'catalogue_guard_preparation_source_insert_v2',
            'catalogue_guard_preparation_v2',
            'catalogue_guard_validation_context_v2',
            'catalogue_guard_validation_evidence_v2',
            'catalogue_guard_validation_generation_v2',
            'guard_catalogue_paged_approval_v2',
            'guard_catalogue_reconciliation_evidence_v2',
            'guard_catalogue_reconciliation_state_v2',
            'guard_custom_food_child_insert_v3',
            'guard_custom_food_immutable_evidence_v3',
            'guard_active_nutrient_vector_size',
            'guard_food_barcode_validity_update',
            'guard_food_import_approval_authority',
            'guard_food_import_batch_initial_state',
            'guard_food_import_batch_nutrition_semantics',
            'guard_food_import_batch_stage_validate_authority',
            'guard_food_import_batch_update',
            'guard_food_import_batch_validation_digest',
            'guard_food_import_record_insert_before_staging_seal',
            'guard_food_import_record_nutrition_semantics',
            'guard_food_import_record_update',
            'guard_food_import_stage_checkpoint_before_staging_seal',
            'guard_food_source_release_activation_authority',
            'guard_imported_food_version_child_delete',
            'guard_food_source_active_release_authority',
            'guard_food_source_initial_active_release',
            'guard_food_source_release_initial_state',
            'guard_food_source_release_legacy_promotion_grandfather',
            'guard_food_source_release_update',
            'guard_new_food_source_release_authority',
            'guard_source_barcode_delete',
            'enqueue_food_search_barcode_insert',
            'enqueue_food_search_barcode_update',
            'enqueue_food_search_food_eligibility_change',
            'enqueue_food_search_serving_insert',
            'enqueue_food_search_source_eligibility_change',
            'lock_active_nutrient_registry_before_write',
            'reconcile_recipe_components_v2',
            'reject_new_legacy_unbound_catalogue_evidence'
            ,'validate_food_version_child_insert'
          )
        )
      )
  ) <> 118 or exists (
    select 1
    from (
      values
        ('nutrient_set_updated_at', 'nutrient', 'set_row_updated_at', 'CREATE TRIGGER nutrient_set_updated_at BEFORE UPDATE ON nutrient FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'),
        ('nutrient_guard_ontology_update', 'nutrient', 'guard_nutrient_ontology_update', 'CREATE TRIGGER nutrient_guard_ontology_update BEFORE UPDATE ON nutrient FOR EACH ROW EXECUTE FUNCTION guard_nutrient_ontology_update()'),
        ('source_nutrient_map_guard_update', 'source_nutrient_map', 'guard_source_nutrient_map_update', 'CREATE TRIGGER source_nutrient_map_guard_update BEFORE UPDATE ON source_nutrient_map FOR EACH ROW EXECUTE FUNCTION guard_source_nutrient_map_update()'),
        ('source_nutrient_map_reject_delete', 'source_nutrient_map', 'reject_immutable_row_update', 'CREATE TRIGGER source_nutrient_map_reject_delete BEFORE DELETE ON source_nutrient_map FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('source_nutrient_map_revision_reject_update', 'source_nutrient_map_revision', 'reject_immutable_row_update', 'CREATE TRIGGER source_nutrient_map_revision_reject_update BEFORE DELETE OR UPDATE ON source_nutrient_map_revision FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_paged_approval_v2_guard', 'catalogue_paged_approval_v2', 'guard_catalogue_paged_approval_v2', 'CREATE TRIGGER catalogue_paged_approval_v2_guard BEFORE INSERT ON catalogue_paged_approval_v2 FOR EACH ROW EXECUTE FUNCTION guard_catalogue_paged_approval_v2()'),
        ('catalogue_paged_approval_v2_immutable', 'catalogue_paged_approval_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_paged_approval_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_paged_approval_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_paged_approval_v2_truncate_guard', 'catalogue_paged_approval_v2', 'guard_catalogue_reconciliation_state_v2', 'CREATE TRIGGER catalogue_paged_approval_v2_truncate_guard BEFORE TRUNCATE ON catalogue_paged_approval_v2 FOR EACH STATEMENT EXECUTE FUNCTION guard_catalogue_reconciliation_state_v2()'),
        ('catalogue_preparation_admission_v2_immutable', 'catalogue_preparation_admission_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_preparation_admission_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_preparation_admission_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_preparation_admission_v2_insert', 'catalogue_preparation_admission_v2', 'catalogue_guard_preparation_evidence_insert_v2', 'CREATE TRIGGER catalogue_preparation_admission_v2_insert BEFORE INSERT ON catalogue_preparation_admission_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_evidence_insert_v2()'),
        ('catalogue_preparation_budget_guard_v2', 'catalogue_preparation_budget_usage_v2', 'catalogue_guard_preparation_v2', 'CREATE TRIGGER catalogue_preparation_budget_guard_v2 BEFORE DELETE OR UPDATE ON catalogue_preparation_budget_usage_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_v2()'),
        ('catalogue_preparation_budget_usage_v2_insert', 'catalogue_preparation_budget_usage_v2', 'catalogue_guard_preparation_evidence_insert_v2', 'CREATE TRIGGER catalogue_preparation_budget_usage_v2_insert BEFORE INSERT ON catalogue_preparation_budget_usage_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_evidence_insert_v2()'),
        ('catalogue_preparation_guard_v2', 'catalogue_preparation_v2', 'catalogue_guard_preparation_v2', 'CREATE TRIGGER catalogue_preparation_guard_v2 BEFORE INSERT OR DELETE OR UPDATE ON catalogue_preparation_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_v2()'),
        ('catalogue_preparation_record_v2_immutable', 'catalogue_preparation_record_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_preparation_record_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_preparation_record_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_preparation_record_v2_insert', 'catalogue_preparation_record_v2', 'catalogue_guard_preparation_evidence_insert_v2', 'CREATE TRIGGER catalogue_preparation_record_v2_insert BEFORE INSERT ON catalogue_preparation_record_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_evidence_insert_v2()'),
        ('catalogue_preparation_seal_page_v2_immutable', 'catalogue_preparation_seal_page_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_preparation_seal_page_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_preparation_seal_page_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_preparation_seal_page_v2_insert', 'catalogue_preparation_seal_page_v2', 'catalogue_guard_preparation_evidence_insert_v2', 'CREATE TRIGGER catalogue_preparation_seal_page_v2_insert BEFORE INSERT ON catalogue_preparation_seal_page_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_evidence_insert_v2()'),
        ('catalogue_preparation_stage_page_v2_immutable', 'catalogue_preparation_stage_page_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_preparation_stage_page_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_preparation_stage_page_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_preparation_stage_page_v2_insert', 'catalogue_preparation_stage_page_v2', 'catalogue_guard_preparation_evidence_insert_v2', 'CREATE TRIGGER catalogue_preparation_stage_page_v2_insert BEFORE INSERT ON catalogue_preparation_stage_page_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_evidence_insert_v2()'),
        ('catalogue_reconciliation_baseline_v2_guard', 'catalogue_reconciliation_baseline_v2', 'guard_catalogue_reconciliation_evidence_v2', 'CREATE TRIGGER catalogue_reconciliation_baseline_v2_guard BEFORE INSERT ON catalogue_reconciliation_baseline_v2 FOR EACH ROW EXECUTE FUNCTION guard_catalogue_reconciliation_evidence_v2()'),
        ('catalogue_reconciliation_baseline_v2_immutable', 'catalogue_reconciliation_baseline_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_reconciliation_baseline_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_reconciliation_baseline_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_reconciliation_baseline_v2_truncate_guard', 'catalogue_reconciliation_baseline_v2', 'guard_catalogue_reconciliation_state_v2', 'CREATE TRIGGER catalogue_reconciliation_baseline_v2_truncate_guard BEFORE TRUNCATE ON catalogue_reconciliation_baseline_v2 FOR EACH STATEMENT EXECUTE FUNCTION guard_catalogue_reconciliation_state_v2()'),
        ('catalogue_reconciliation_page_v2_guard', 'catalogue_reconciliation_page_v2', 'guard_catalogue_reconciliation_evidence_v2', 'CREATE TRIGGER catalogue_reconciliation_page_v2_guard BEFORE INSERT ON catalogue_reconciliation_page_v2 FOR EACH ROW EXECUTE FUNCTION guard_catalogue_reconciliation_evidence_v2()'),
        ('catalogue_reconciliation_page_v2_immutable', 'catalogue_reconciliation_page_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_reconciliation_page_v2_immutable BEFORE DELETE OR UPDATE ON catalogue_reconciliation_page_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_reconciliation_page_v2_truncate_guard', 'catalogue_reconciliation_page_v2', 'guard_catalogue_reconciliation_state_v2', 'CREATE TRIGGER catalogue_reconciliation_page_v2_truncate_guard BEFORE TRUNCATE ON catalogue_reconciliation_page_v2 FOR EACH STATEMENT EXECUTE FUNCTION guard_catalogue_reconciliation_state_v2()'),
        ('catalogue_reconciliation_state_v2_guard', 'catalogue_reconciliation_v2', 'guard_catalogue_reconciliation_state_v2', 'CREATE TRIGGER catalogue_reconciliation_state_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_reconciliation_v2 FOR EACH ROW EXECUTE FUNCTION guard_catalogue_reconciliation_state_v2()'),
        ('catalogue_reconciliation_state_v2_truncate_guard', 'catalogue_reconciliation_v2', 'guard_catalogue_reconciliation_state_v2', 'CREATE TRIGGER catalogue_reconciliation_state_v2_truncate_guard BEFORE TRUNCATE ON catalogue_reconciliation_v2 FOR EACH STATEMENT EXECUTE FUNCTION guard_catalogue_reconciliation_state_v2()'),
        ('catalogue_validation_context_immutable_v2', 'catalogue_validation_context_v2', 'catalogue_guard_validation_context_v2', 'CREATE TRIGGER catalogue_validation_context_immutable_v2 BEFORE INSERT OR DELETE OR UPDATE ON catalogue_validation_context_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_validation_context_v2()'),
        ('catalogue_validation_context_truncate_v2', 'catalogue_validation_context_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_validation_context_truncate_v2 BEFORE TRUNCATE ON catalogue_validation_context_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_validation_generation_monotonic_v2', 'catalogue_validation_generation_v2', 'catalogue_guard_validation_generation_v2', 'CREATE TRIGGER catalogue_validation_generation_monotonic_v2 BEFORE INSERT OR DELETE OR UPDATE ON catalogue_validation_generation_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_validation_generation_v2()'),
        ('catalogue_validation_generation_truncate_v2', 'catalogue_validation_generation_v2', 'catalogue_guard_validation_generation_v2', 'CREATE TRIGGER catalogue_validation_generation_truncate_v2 BEFORE TRUNCATE ON catalogue_validation_generation_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_validation_generation_v2()'),
        ('catalogue_validation_page_immutable_v2', 'catalogue_validation_page_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_validation_page_immutable_v2 BEFORE DELETE OR UPDATE ON catalogue_validation_page_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_validation_page_insert_v2', 'catalogue_validation_page_v2', 'catalogue_guard_validation_evidence_v2', 'CREATE TRIGGER catalogue_validation_page_insert_v2 BEFORE INSERT ON catalogue_validation_page_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_validation_evidence_v2()'),
        ('catalogue_validation_page_truncate_v2', 'catalogue_validation_page_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_validation_page_truncate_v2 BEFORE TRUNCATE ON catalogue_validation_page_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_validation_record_immutable_v2', 'catalogue_validation_record_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_validation_record_immutable_v2 BEFORE DELETE OR UPDATE ON catalogue_validation_record_v2 FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('catalogue_validation_record_insert_v2', 'catalogue_validation_record_v2', 'catalogue_guard_validation_evidence_v2', 'CREATE TRIGGER catalogue_validation_record_insert_v2 BEFORE INSERT ON catalogue_validation_record_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_validation_evidence_v2()'),
        ('catalogue_validation_record_truncate_v2', 'catalogue_validation_record_v2', 'reject_immutable_row_update', 'CREATE TRIGGER catalogue_validation_record_truncate_v2 BEFORE TRUNCATE ON catalogue_validation_record_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_barcode_validation_generation_v2', 'food_barcode', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_barcode_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_barcode FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_import_approval_validation_generation_v2', 'food_import_approval', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_import_approval_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_import_approval FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_import_batch_preparation_legacy_fence_v2', 'food_import_batch', 'catalogue_guard_legacy_batch_preparation_v2', 'CREATE TRIGGER food_import_batch_preparation_legacy_fence_v2 BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION catalogue_guard_legacy_batch_preparation_v2()'),
        ('food_import_batch_validation_generation_v2', 'food_import_batch', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_import_batch_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_import_batch FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_import_parser_report_validation_generation_v2', 'food_import_parser_report', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_import_parser_report_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_import_parser_report FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_import_record_preparation_legacy_fence_v2', 'food_import_record', 'catalogue_guard_legacy_record_preparation_v2', 'CREATE TRIGGER food_import_record_preparation_legacy_fence_v2 BEFORE DELETE OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION catalogue_guard_legacy_record_preparation_v2()'),
        ('food_import_record_preparation_phase_v2', 'food_import_record', 'catalogue_guard_preparation_source_insert_v2', 'CREATE TRIGGER food_import_record_preparation_phase_v2 BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION catalogue_guard_preparation_source_insert_v2()'),
        ('food_import_record_validation_generation_v2', 'food_import_record', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_import_record_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_import_record FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_nutrient_value_validation_generation_v2', 'food_nutrient_value', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_nutrient_value_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_nutrient_value FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_serving_validation_generation_v2', 'food_serving', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_serving_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_serving FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_source_release_validation_generation_v2', 'food_source_release', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_source_release_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_source_release FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_source_validation_generation_v2', 'food_source', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_source_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_source FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_validation_generation_v2', 'food', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('food_version_validation_generation_v2', 'food_version', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER food_version_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON food_version FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('nutrient_validation_generation_v2', 'nutrient', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER nutrient_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('source_nutrient_map_revision_validation_generation_v2', 'source_nutrient_map_revision', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER source_nutrient_map_revision_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON source_nutrient_map_revision FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('source_nutrient_map_validation_generation_v2', 'source_nutrient_map', 'catalogue_advance_validation_generation_v2', 'CREATE TRIGGER source_nutrient_map_validation_generation_v2 AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON source_nutrient_map FOR EACH STATEMENT EXECUTE FUNCTION catalogue_advance_validation_generation_v2()'),
        ('catalogue_publication_admission_v2_guard', 'catalogue_publication_admission_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_admission_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_publication_admission_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_admission_v2_truncate', 'catalogue_publication_admission_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_admission_v2_truncate BEFORE TRUNCATE ON catalogue_publication_admission_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_v2_guard', 'catalogue_publication_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_publication_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_v2_truncate', 'catalogue_publication_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_v2_truncate BEFORE TRUNCATE ON catalogue_publication_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_record_v2_guard', 'catalogue_publication_record_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_record_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_publication_record_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_record_v2_truncate', 'catalogue_publication_record_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_record_v2_truncate BEFORE TRUNCATE ON catalogue_publication_record_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_page_v2_guard', 'catalogue_publication_page_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_page_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_publication_page_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_page_v2_truncate', 'catalogue_publication_page_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_page_v2_truncate BEFORE TRUNCATE ON catalogue_publication_page_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_rollback_v2_guard', 'catalogue_publication_rollback_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_rollback_v2_guard BEFORE INSERT OR DELETE OR UPDATE ON catalogue_publication_rollback_v2 FOR EACH ROW EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('catalogue_publication_rollback_v2_truncate', 'catalogue_publication_rollback_v2', 'catalogue_guard_publication_v2', 'CREATE TRIGGER catalogue_publication_rollback_v2_truncate BEFORE TRUNCATE ON catalogue_publication_rollback_v2 FOR EACH STATEMENT EXECUTE FUNCTION catalogue_guard_publication_v2()'),
        ('custom_food_nutrient_guard_delete_v3'::text, 'food_nutrient_value'::text, 'guard_custom_food_immutable_evidence_v3'::text, 'CREATE TRIGGER custom_food_nutrient_guard_delete_v3 BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'::text),
        ('custom_food_nutrient_guard_insert_v3', 'food_nutrient_value', 'guard_custom_food_child_insert_v3', 'CREATE TRIGGER custom_food_nutrient_guard_insert_v3 BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()'),
        ('custom_food_serving_guard_delete_v3', 'food_serving', 'guard_custom_food_immutable_evidence_v3', 'CREATE TRIGGER custom_food_serving_guard_delete_v3 BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'),
        ('custom_food_serving_guard_insert_v3', 'food_serving', 'guard_custom_food_child_insert_v3', 'CREATE TRIGGER custom_food_serving_guard_insert_v3 BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()'),
        ('custom_food_version_guard_delete_v3', 'food_version', 'guard_custom_food_immutable_evidence_v3', 'CREATE TRIGGER custom_food_version_guard_delete_v3 BEFORE DELETE ON food_version FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'),
        ('food_barcode_guard_update', 'food_barcode', 'guard_food_barcode_validity_update', 'CREATE TRIGGER food_barcode_guard_update BEFORE UPDATE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_food_barcode_validity_update()'),
        ('food_barcode_reject_delete', 'food_barcode', 'guard_source_barcode_delete', 'CREATE TRIGGER food_barcode_reject_delete BEFORE DELETE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_source_barcode_delete()'),
        ('food_import_approval_reject_update', 'food_import_approval', 'reject_immutable_row_update', 'CREATE TRIGGER food_import_approval_reject_update BEFORE DELETE OR UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_import_record_reject_delete', 'food_import_record', 'reject_immutable_row_update', 'CREATE TRIGGER food_import_record_reject_delete BEFORE DELETE ON food_import_record FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_nutrient_value_reject_delete', 'food_nutrient_value', 'guard_imported_food_version_child_delete', 'CREATE TRIGGER food_nutrient_value_reject_delete BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()'),
        ('food_nutrient_value_reject_update', 'food_nutrient_value', 'reject_immutable_row_update', 'CREATE TRIGGER food_nutrient_value_reject_update BEFORE UPDATE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_nutrient_value_validate_insert', 'food_nutrient_value', 'validate_food_version_child_insert', 'CREATE TRIGGER food_nutrient_value_validate_insert BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()'),
        ('food_serving_reject_delete', 'food_serving', 'guard_imported_food_version_child_delete', 'CREATE TRIGGER food_serving_reject_delete BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()'),
        ('food_serving_reject_update', 'food_serving', 'reject_immutable_row_update', 'CREATE TRIGGER food_serving_reject_update BEFORE UPDATE ON food_serving FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_serving_validate_insert', 'food_serving', 'validate_food_version_child_insert', 'CREATE TRIGGER food_serving_validate_insert BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()'),
        ('food_set_updated_at', 'food', 'set_row_updated_at', 'CREATE TRIGGER food_set_updated_at BEFORE UPDATE ON food FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'),
        ('food_source_release_activation_guard_authority', 'food_source_release_activation', 'guard_food_source_release_activation_authority', 'CREATE TRIGGER food_source_release_activation_guard_authority BEFORE INSERT ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_activation_authority()'),
        ('food_source_release_activation_reject_update', 'food_source_release_activation', 'reject_immutable_row_update', 'CREATE TRIGGER food_source_release_activation_reject_update BEFORE DELETE OR UPDATE ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_source_release_reject_delete', 'food_source_release', 'reject_immutable_row_update', 'CREATE TRIGGER food_source_release_reject_delete BEFORE DELETE ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_source_set_updated_at', 'food_source', 'set_row_updated_at', 'CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON food_source FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'),
        ('food_version_reject_update', 'food_version', 'reject_immutable_row_update', 'CREATE TRIGGER food_version_reject_update BEFORE UPDATE ON food_version FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_import_approval_guard_authority'::text, 'food_import_approval'::text, 'guard_food_import_approval_authority'::text, 'CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()'::text),
        ('food_import_batch_guard_initial_state', 'food_import_batch', 'guard_food_import_batch_initial_state', 'CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()'),
        ('food_import_batch_guard_nutrition_semantics', 'food_import_batch', 'guard_food_import_batch_nutrition_semantics', 'CREATE TRIGGER food_import_batch_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_nutrition_semantics()'),
        ('food_import_batch_guard_stage_validate_authority', 'food_import_batch', 'guard_food_import_batch_stage_validate_authority', 'CREATE TRIGGER food_import_batch_guard_stage_validate_authority BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_stage_validate_authority()'),
        ('food_import_batch_guard_update', 'food_import_batch', 'guard_food_import_batch_update', 'CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()'),
        ('food_import_batch_guard_validation_digest', 'food_import_batch', 'guard_food_import_batch_validation_digest', 'CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()'),
        ('food_import_batch_reject_new_legacy_unbound', 'food_import_batch', 'reject_new_legacy_unbound_catalogue_evidence', 'CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()'),
        ('food_import_checkpoint_guard_staging_seal', 'food_import_checkpoint', 'guard_food_import_stage_checkpoint_before_staging_seal', 'CREATE TRIGGER food_import_checkpoint_guard_staging_seal BEFORE INSERT OR DELETE OR UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION guard_food_import_stage_checkpoint_before_staging_seal()'),
        ('food_import_checkpoint_set_updated_at', 'food_import_checkpoint', 'set_row_updated_at', 'CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'),
        ('food_import_parser_report_reject_update', 'food_import_parser_report', 'reject_immutable_row_update', 'CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'),
        ('food_import_record_guard_nutrition_semantics', 'food_import_record', 'guard_food_import_record_nutrition_semantics', 'CREATE TRIGGER food_import_record_guard_nutrition_semantics BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_nutrition_semantics()'),
        ('food_import_record_guard_staging_seal', 'food_import_record', 'guard_food_import_record_insert_before_staging_seal', 'CREATE TRIGGER food_import_record_guard_staging_seal BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_insert_before_staging_seal()'),
        ('food_import_record_guard_update', 'food_import_record', 'guard_food_import_record_update', 'CREATE TRIGGER food_import_record_guard_update BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()'),
        ('food_search_barcode_insert_outbox', 'food_barcode', 'enqueue_food_search_barcode_insert', 'CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()'),
        ('food_search_barcode_update_outbox', 'food_barcode', 'enqueue_food_search_barcode_update', 'CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()'),
        ('food_search_eligibility_outbox', 'food', 'enqueue_food_search_food_eligibility_change', 'CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()'),
        ('food_search_serving_insert_outbox', 'food_serving', 'enqueue_food_search_serving_insert', 'CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()'),
        ('food_source_guard_active_release_authority', 'food_source', 'guard_food_source_active_release_authority', 'CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()'),
        ('food_source_guard_initial_active_release', 'food_source', 'guard_food_source_initial_active_release', 'CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()'),
        ('food_source_search_eligibility_outbox', 'food_source', 'enqueue_food_search_source_eligibility_change', 'CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()'),
        ('food_source_release_guard_initial_state', 'food_source_release', 'guard_food_source_release_initial_state', 'CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()'),
        ('food_source_release_guard_legacy_grandfather_insert', 'food_source_release', 'guard_food_source_release_legacy_promotion_grandfather', 'CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()'),
        ('food_source_release_guard_legacy_grandfather_update', 'food_source_release', 'guard_food_source_release_legacy_promotion_grandfather', 'CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()'),
        ('food_source_release_guard_new_authority', 'food_source_release', 'guard_new_food_source_release_authority', 'CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()'),
        ('food_source_release_guard_update', 'food_source_release', 'guard_food_source_release_update', 'CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()'),
        ('food_source_release_reject_new_legacy_unbound', 'food_source_release', 'reject_new_legacy_unbound_catalogue_evidence', 'CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()'),
        ('nutrient_active_vector_size_guard', 'nutrient', 'guard_active_nutrient_vector_size', 'CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()'),
        ('nutrient_registry_lock_before_active_update', 'nutrient', 'lock_active_nutrient_registry_before_write', 'CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE DELETE OR UPDATE ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()'),
        ('nutrient_registry_lock_before_insert', 'nutrient', 'lock_active_nutrient_registry_before_write', 'CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()'),
        ('recipe_ingredient_reconcile_v2', 'recipe_ingredient', 'reconcile_recipe_components_v2', 'CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_nutrient_reconcile_v2', 'recipe_version_nutrient', 'reconcile_recipe_components_v2', 'CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_source_reconcile_v2', 'recipe_version_source', 'reconcile_recipe_components_v2', 'CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_version_components_reconcile_v2', 'recipe_version', 'reconcile_recipe_components_v2', 'CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()')
    ) as expected(trigger_name, table_name, function_name, definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    left join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
      and procedure_namespace_row.nspname = target_schema
    where trigger_row.oid is null
      or class_row.oid is null
      or namespace_row.oid is null
      or procedure_row.oid is null
      or procedure_namespace_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.definition
  ) then
    raise exception 'catalogue authority trigger identity, definition, or enabled state differs from policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid = approval_function
      and (
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
          'hex'
        ) <> '9dfaa30970c3acfaaff6a1c1c4211cfd0b42c87824998841172429c4dcd5138f'
        or pg_catalog.pg_get_function_result(procedure_row.oid) <> 'boolean'
        or language_row.lanname <> 'plpgsql'
        or procedure_row.provolatile <> 'v'
        or procedure_row.proisstrict
        or procedure_row.proleakproof
        or procedure_row.proparallel <> 'u'
      )
  ) then
    raise exception 'catalogue approval function executable semantics differ from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_food_import_approval_authority',
        'guard_food_import_batch_validation_digest'
      )
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'guard_food_import_approval_authority'::text,
          'f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd'::text
        ),
        (
          'guard_food_import_batch_validation_digest'::text,
          'c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7'::text
        )
    ) as expected(function_name, source_sha256)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.pronamespace = namespace_row.oid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or namespace_row.oid is null
      or procedure_row.proowner <> expected_owner_oid
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> 'trigger'
      or language_row.lanname <> 'plpgsql'
      or procedure_row.provolatile <> 'v'
      or procedure_row.proisstrict
      or procedure_row.proleakproof
      or procedure_row.proparallel <> 'u'
      or procedure_row.prosecdef
      or procedure_row.proconfig is distinct from array[
        'search_path=pg_catalog, public, pg_temp'
      ]::text[]
  ) then
    raise exception 'catalogue guard function executable semantics differ from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and not trigger_row.tgisinternal
      and procedure_row.proname in (
        'guard_food_import_approval_authority',
        'guard_food_import_batch_validation_digest'
      )
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'food_import_approval_guard_authority'::text,
          'food_import_approval'::text,
          'guard_food_import_approval_authority'::text,
          'CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()'::text
        ),
        (
          'food_import_batch_guard_validation_digest'::text,
          'food_import_batch'::text,
          'guard_food_import_batch_validation_digest'::text,
          'CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()'::text
        )
    ) as expected(trigger_name, table_name, function_name, definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
      and procedure_row.proname = expected.function_name
    left join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
      and procedure_namespace_row.nspname = target_schema
    where trigger_row.oid is null
      or class_row.oid is null
      or namespace_row.oid is null
      or procedure_row.oid is null
      or procedure_namespace_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.definition
  ) then
    raise exception 'catalogue authority trigger definition or enabled state differs from policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where procedure_row.oid = approval_function
      and (
        coalesce(grantee.rolname, 'PUBLIC') <> all (array[
          'PUBLIC',
          expected_owner,
          'nutrition_catalogue_approve_data',
          'nutrition_catalogue_approve_quality',
          'nutrition_catalogue_approve_rights'
        ])
        or acl.privilege_type <> 'EXECUTE'
        or acl.is_grantable
      )
  ) then
    raise exception 'catalogue approval function has an unexpected pre-policy privilege'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        namespace_row.nspacl,
        pg_catalog.acldefault('n', namespace_row.nspowner)
      )
    ) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where namespace_row.nspname = target_schema
      and coalesce(grantee.rolname, 'PUBLIC') <> all (array[
        'PUBLIC',
        'pg_database_owner',
        'nutrition_catalogue_stage',
        'nutrition_catalogue_validate',
        'nutrition_catalogue_approve_data',
        'nutrition_catalogue_approve_quality',
        'nutrition_catalogue_approve_rights',
        'nutrition_catalogue_promote_activate',
        'nutrition_catalogue_rollback'
      ])
  ) then
    raise exception 'public schema has an unexpected pre-policy privilege grantee'
      using errcode = '55000';
  end if;

  -- Logical restore omits ACLs. Reconstruct the nineteen migration-0020-through-0022
  -- function ACLs from the reviewed manifest, stripping named grants first.
  for stage_validate_function_spec in
    select *
    from (
      values
        ('catalogue_admit_preparation_v2(text)', 'quality'),
        ('catalogue_advance_validation_generation_v2()', 'owner'),
        ('catalogue_assert_validation_context_v2(uuid)', 'owner'),
        ('catalogue_begin_preparation_seal_v2(uuid,text)', 'stage'),
        ('catalogue_begin_preparation_v2(text,text)', 'stage'),
        ('catalogue_begin_reconciliation_v2(uuid,text,uuid,text)', 'validate'),
        ('catalogue_begin_validation_v2(uuid,text,text)', 'validate'),
        ('catalogue_charge_preparation_budget_v2(uuid,bigint,bigint,bigint)', 'owner'),
        ('catalogue_compute_record_nutrition_semantics_v2(bigint,uuid)', 'owner'),
        ('catalogue_finish_preparation_seal_v2(uuid,text)', 'stage'),
        ('catalogue_finish_reconciliation_v2(uuid,text,bigint,text)', 'validate'),
        ('catalogue_finish_validation_v2(uuid,text)', 'validate'),
        ('catalogue_frame_sha256_v2(text,text[])', 'owner'),
        ('catalogue_guard_legacy_batch_preparation_v2()', 'owner'),
        ('catalogue_guard_legacy_record_preparation_v2()', 'owner'),
        ('catalogue_guard_preparation_evidence_insert_v2()', 'owner'),
        ('catalogue_guard_preparation_source_insert_v2()', 'owner'),
        ('catalogue_guard_preparation_v2()', 'owner'),
        ('catalogue_guard_validation_context_v2()', 'owner'),
        ('catalogue_guard_validation_evidence_v2()', 'owner'),
        ('catalogue_guard_validation_generation_v2()', 'owner'),
        ('catalogue_mapping_digest_for_validation_v2(bigint)', 'owner'),
        ('catalogue_normalize_gtin_v2(text)', 'owner'),
        ('catalogue_normalize_source_text_v2(text)', 'owner'),
        ('catalogue_observe_validation_page_v2(uuid,bigint,integer)', 'validate'),
        ('catalogue_preparation_uint_v2(jsonb)', 'owner'),
        ('catalogue_prepare_reconciliation_page_v2(uuid,text,bigint)', 'validate'),
        ('catalogue_read_preparation_admission_v2(text)', 'stage'),
        ('catalogue_read_reconciliation_page_v2(uuid,text,bigint,text,text)', 'reviewers'),
        ('catalogue_reconciliation_baseline_header_v2(uuid)', 'owner'),
        ('catalogue_reconciliation_baseline_record_v2(bigint,uuid)', 'owner'),
        ('catalogue_reconciliation_detail_v2(jsonb,jsonb)', 'owner'),
        ('catalogue_reconciliation_input_v2(uuid,text)', 'validate'),
        ('catalogue_reconciliation_validation_page_v2(uuid,text,bigint)', 'validate'),
        ('catalogue_record_paged_approval_v2(uuid,text,text,text,text,text,text,text)', 'reviewers'),
        ('catalogue_reject_legacy_batch_v2(uuid)', 'owner'),
        ('catalogue_reject_legacy_record_v2(bigint)', 'owner'),
        ('catalogue_reject_legacy_release_v2(uuid)', 'owner'),
        ('catalogue_reject_legacy_stage_document_v2(text)', 'owner'),
        ('catalogue_require_preparation_role_v2(text)', 'owner'),
        ('catalogue_stage_preparation_page_v2(uuid,text)', 'stage'),
        ('catalogue_submit_validation_page_v2(uuid,text)', 'validate'),
        ('catalogue_utf16_sort_key_v2(text)', 'owner'),
        ('catalogue_verify_preparation_seal_page_v2(uuid,bigint)', 'stage'),
        ('guard_catalogue_paged_approval_v2()', 'owner'),
        ('guard_catalogue_reconciliation_evidence_v2()', 'owner'),
        ('guard_catalogue_reconciliation_state_v2()', 'owner'),
        ('catalogue_publication_request_v2(text,text[])', 'owner'),
        ('catalogue_publication_receipt_v2(jsonb)', 'owner'),
        ('catalogue_publication_timeouts_v2()', 'owner'),
        ('catalogue_publication_progress_v2(uuid)', 'owner'),
        ('catalogue_lock_publication_v2(uuid,text,boolean)', 'owner'),
        ('catalogue_assert_publication_approvals_v2(uuid,text,text,text,text)', 'owner'),
        ('catalogue_admit_publication_v2(text)', 'quality'),
        ('catalogue_begin_publication_v2(text)', 'promote'),
        ('catalogue_materialize_publication_record_v2(uuid,bigint)', 'owner'),
        ('catalogue_verify_publication_record_v2(uuid,bigint)', 'owner'),
        ('catalogue_advance_publication_page_v2(text,text)', 'owner'),
        ('catalogue_materialize_publication_page_v2(text)', 'promote'),
        ('catalogue_verify_publication_page_v2(text)', 'promote'),
        ('catalogue_finish_publication_v2(text)', 'promote'),
        ('catalogue_read_publication_v2(uuid)', 'publish-read'),
        ('catalogue_verify_legacy_publication_record_v2(bigint,uuid)', 'owner'),
        ('catalogue_publication_target_barcodes_v2(uuid)', 'owner'),
        ('catalogue_assert_publication_cutover_budget_v2(bigint,uuid,uuid,bigint)', 'owner'),
        ('catalogue_cutover_publication_v2(bigint,uuid,text,uuid,text,text)', 'owner'),
        ('catalogue_activate_publication_v2(text)', 'promote'),
        ('catalogue_rollback_publication_v2(text)', 'rollback'),
        ('catalogue_guard_publication_v2()', 'owner'),
        ('guard_food_import_batch_nutrition_semantics()'::text, 'owner'::text),
        ('guard_food_import_batch_stage_validate_authority()'::text, 'owner'::text),
        ('guard_food_import_record_nutrition_semantics()', 'owner'),
        ('guard_food_import_record_insert_before_staging_seal()', 'owner'),
        ('guard_food_import_stage_checkpoint_before_staging_seal()', 'owner'),
        ('catalogue_attest_import_nutrition_semantics(uuid)', 'owner'),
        ('catalogue_canonical_decimal_product(text,text)', 'owner'),
        ('catalogue_compute_import_staging_seal(uuid)', 'owner'),
        ('catalogue_compute_record_nutrition_semantics(bigint)', 'owner'),
        ('catalogue_promote_import_batch_v1(uuid,text,text)', 'owner'),
        ('catalogue_record_import_approval_v1(uuid,text,text,text,text,text)', 'owner'),
        ('catalogue_rollback_source_release_v1(text,uuid,text,text)', 'owner'),
        ('catalogue_stage_import_batch(text)', 'stage'),
        ('catalogue_stage_import_record_chunk(uuid,bigint,text)', 'stage'),
        ('catalogue_stage_import_parser_report(uuid,text)', 'stage'),
        ('catalogue_utf16_length(text)', 'owner'),
        ('catalogue_observe_import_validation(uuid)', 'validate'),
        ('catalogue_validate_import_batch(uuid,text,text,text)', 'validate'),
        ('catalogue_validate_import_batch_v1(uuid,text,text,text)', 'owner')
    ) as expected(function_identity, acl_kind)
  loop
    stage_validate_function := pg_catalog.to_regprocedure(
      pg_catalog.format('public.%s', stage_validate_function_spec.function_identity)
    );
    if stage_validate_function is null then
      raise exception 'catalogue stage/validate function % is absent',
        stage_validate_function_spec.function_identity using errcode = '42883';
    end if;
    stage_validate_functions := pg_catalog.array_append(
      stage_validate_functions,
      stage_validate_function
    );

    execute pg_catalog.format(
      'revoke all on function public.%s from public',
      stage_validate_function_spec.function_identity
    );
    for acl_grantee in
      select distinct function_acl.grantee
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = stage_validate_function
        and function_acl.grantee <> 0
    loop
      select role_row.rolname
      into acl_grantee_name
      from pg_catalog.pg_roles as role_row
      where role_row.oid = acl_grantee;
      if acl_grantee_name is null then
        raise exception 'catalogue stage/validate function % has an unknown ACL grantee',
          stage_validate_function_spec.function_identity using errcode = '55000';
      end if;
      execute pg_catalog.format(
        'revoke all on function public.%s from %I',
        stage_validate_function_spec.function_identity,
        acl_grantee_name
      );
    end loop;

    execute pg_catalog.format(
      'grant execute on function public.%s to %I',
      stage_validate_function_spec.function_identity,
      expected_owner
    );
    if stage_validate_function_spec.acl_kind = 'stage' then
      execute pg_catalog.format(
        'grant execute on function public.%s to nutrition_catalogue_stage',
        stage_validate_function_spec.function_identity
      );
    elsif stage_validate_function_spec.acl_kind = 'validate' then
      execute pg_catalog.format(
        'grant execute on function public.%s to nutrition_catalogue_validate',
        stage_validate_function_spec.function_identity
      );
    elsif stage_validate_function_spec.acl_kind = 'promote' then
      execute format('grant execute on function public.%s to nutrition_catalogue_promote_activate',stage_validate_function_spec.function_identity);
    elsif stage_validate_function_spec.acl_kind = 'rollback' then
      execute format('grant execute on function public.%s to nutrition_catalogue_rollback',stage_validate_function_spec.function_identity);
    elsif stage_validate_function_spec.acl_kind = 'publish-read' then
      execute format('grant execute on function public.%s to nutrition_catalogue_promote_activate,nutrition_catalogue_rollback',stage_validate_function_spec.function_identity);
    elsif stage_validate_function_spec.acl_kind = 'quality' then
      execute pg_catalog.format('grant execute on function public.%s to nutrition_catalogue_approve_quality', stage_validate_function_spec.function_identity);
    elsif stage_validate_function_spec.acl_kind = 'reviewers' then
      execute pg_catalog.format('grant execute on function public.%s to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights', stage_validate_function_spec.function_identity);
    end if;

    expected_acl_count := case
      when stage_validate_function_spec.acl_kind = 'publish-read' then 3
      when stage_validate_function_spec.acl_kind = 'owner' then 1
      when stage_validate_function_spec.acl_kind = 'reviewers' then 4
      else 2
    end;
    if (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = stage_validate_function
    ) <> expected_acl_count or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      left join pg_catalog.pg_roles as grantee_role
        on grantee_role.oid = function_acl.grantee
      where procedure_row.oid = stage_validate_function
        and (
          function_acl.grantor <> expected_owner_oid
          or function_acl.privilege_type <> 'EXECUTE'
          or function_acl.is_grantable
          or not (
            function_acl.grantee = expected_owner_oid
            or (
              stage_validate_function_spec.acl_kind = 'stage'
              and grantee_role.rolname = 'nutrition_catalogue_stage'
            )
            or (
              stage_validate_function_spec.acl_kind = 'validate'
              and grantee_role.rolname = 'nutrition_catalogue_validate'
            )
            or (stage_validate_function_spec.acl_kind = 'promote' and grantee_role.rolname = 'nutrition_catalogue_promote_activate')
            or (stage_validate_function_spec.acl_kind = 'rollback' and grantee_role.rolname = 'nutrition_catalogue_rollback')
            or (stage_validate_function_spec.acl_kind = 'publish-read' and grantee_role.rolname in ('nutrition_catalogue_promote_activate','nutrition_catalogue_rollback'))
            or (stage_validate_function_spec.acl_kind = 'quality' and grantee_role.rolname = 'nutrition_catalogue_approve_quality')
            or (stage_validate_function_spec.acl_kind = 'reviewers' and grantee_role.rolname in ('nutrition_catalogue_approve_data','nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights'))
          )
        )
    ) then
      raise exception 'catalogue stage/validate function % ACL differs from policy',
        stage_validate_function_spec.function_identity using errcode = '55000';
    end if;
  end loop;

  for stage_validate_function_spec in select unnest(array['catalogue_paged_approval_v2','catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2','catalogue_preparation_record_v2','catalogue_preparation_seal_page_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_v2','catalogue_publication_admission_v2','catalogue_publication_page_v2','catalogue_publication_record_v2','catalogue_publication_rollback_v2','catalogue_publication_v2','catalogue_reconciliation_baseline_v2','catalogue_reconciliation_page_v2','catalogue_reconciliation_v2','catalogue_validation_context_v2','catalogue_validation_generation_v2','catalogue_validation_page_v2','catalogue_validation_record_v2']) as table_name loop
    execute format('revoke all on table public.%I from public', stage_validate_function_spec.table_name);
    execute format('grant all on table public.%I to %I', stage_validate_function_spec.table_name,expected_owner);
    if exists(select 1 from pg_class c
        where c.oid=to_regclass(format('public.%I',stage_validate_function_spec.table_name))
          and c.relacl is distinct from acldefault('r',expected_owner_oid)) then
      raise exception 'paged companion table ACL repair differs' using errcode='55000';
    end if;
  end loop;

  execute 'grant usage on schema public to nutrition_catalogue_stage, nutrition_catalogue_validate';

  execute 'revoke all on function public.catalogue_record_import_approval(uuid,text,text,text,text,text) from public';
  execute 'grant execute on function public.catalogue_record_import_approval(uuid,text,text,text,text,text) to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights';
  execute 'grant usage on schema public to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights';

  execute 'revoke all on function public.catalogue_promote_import_batch(uuid,text,text) from public';
  execute 'grant execute on function public.catalogue_promote_import_batch(uuid,text,text) to nutrition_catalogue_promote_activate';
  execute 'revoke all on function public.catalogue_rollback_source_release(text,uuid,text,text) from public';
  execute 'grant execute on function public.catalogue_rollback_source_release(text,uuid,text,text) to nutrition_catalogue_rollback';
  execute 'revoke all on function public.guard_food_source_release_activation_authority() from public';
  execute 'grant usage on schema public to nutrition_catalogue_promote_activate, nutrition_catalogue_rollback';

  execute 'revoke all on function public.guard_food_import_approval_authority() from public';
  for acl_grantee in
    select distinct acl.grantee
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
      and acl.grantee <> 0
  loop
    select role_row.rolname
    into acl_grantee_name
    from pg_catalog.pg_roles as role_row
    where role_row.oid = acl_grantee;
    if acl_grantee_name is null then
      raise exception 'catalogue approval guard function has an unknown ACL grantee'
        using errcode = '55000';
    end if;
    execute pg_catalog.format(
      'revoke all on function public.guard_food_import_approval_authority() from %I',
      acl_grantee_name
    );
  end loop;
  execute pg_catalog.format(
    'grant execute on function public.guard_food_import_approval_authority() to %I',
    expected_owner
  );

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    where procedure_row.oid = approval_function
      and (
        procedure_row.proowner <> expected_owner_oid
        or not procedure_row.prosecdef
        or procedure_row.proconfig is distinct from array[
          'search_path=pg_catalog, public, pg_temp'
        ]::text[]
      )
  ) then
    raise exception 'catalogue approval function owner, SECURITY DEFINER flag, or search_path differs from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where procedure_row.oid = approval_function
      and acl.privilege_type = 'EXECUTE'
      and acl.grantor = expected_owner_oid
      and not acl.is_grantable
      and coalesce(grantee.rolname, 'PUBLIC') = any (array[
        expected_owner,
        'nutrition_catalogue_approve_data',
        'nutrition_catalogue_approve_quality',
        'nutrition_catalogue_approve_rights'
      ])
  ) <> 4 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_function
  ) <> 4 then
    raise exception 'catalogue approval function ACL is not the exact four-principal policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from (
      values
        (promotion_function, 'nutrition_catalogue_promote_activate'::text),
        (rollback_function, 'nutrition_catalogue_rollback'::text)
    ) as expected(function_oid, capability_role)
    where (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
      left join pg_catalog.pg_roles as grantee
        on grantee.oid = acl.grantee
      where procedure_row.oid = expected.function_oid
        and acl.grantor = expected_owner_oid
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
        and coalesce(grantee.rolname, 'PUBLIC') in (
          expected_owner,
          expected.capability_role
        )
    ) <> 2 or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
      where procedure_row.oid = expected.function_oid
      group by procedure_row.oid
      having pg_catalog.count(*) <> 2
    )
  ) then
    raise exception 'catalogue promotion or rollback function ACL differs from the exact two-principal policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = activation_guard_function
      and acl.grantee = expected_owner_oid
      and acl.grantor = expected_owner_oid
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = activation_guard_function
  ) <> 1 then
    raise exception 'catalogue activation guard ACL is not the exact owner-only policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
      and acl.grantee = expected_owner_oid
      and acl.grantor = expected_owner_oid
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
  ) <> 1 then
    raise exception 'catalogue approval guard function ACL is not the exact owner-only policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.oid <> approval_function
      and procedure_row.oid <> approval_guard_function
      and procedure_row.oid <> promotion_function
      and procedure_row.oid <> rollback_function
      and procedure_row.oid <> activation_guard_function
      and not (procedure_row.oid = any (stage_validate_functions))
      and procedure_row.proacl is not null
  ) then
    raise exception 'a non-authority public function has unexpected explicit privileges'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    join pg_catalog.pg_roles as grantor
      on grantor.oid = acl.grantor
    where namespace_row.nspname = target_schema
      and not acl.is_grantable
      and grantor.rolname = 'pg_database_owner'
      and (
        (coalesce(grantee.rolname, 'PUBLIC') = 'PUBLIC' and acl.privilege_type = 'USAGE')
        or (grantee.rolname = 'pg_database_owner' and acl.privilege_type in ('CREATE', 'USAGE'))
        or (
          grantee.rolname in (
            'nutrition_catalogue_approve_data',
            'nutrition_catalogue_approve_quality',
            'nutrition_catalogue_approve_rights',
            'nutrition_catalogue_stage',
            'nutrition_catalogue_validate',
            'nutrition_catalogue_promote_activate',
            'nutrition_catalogue_rollback'
          )
          and acl.privilege_type = 'USAGE'
        )
      )
  ) <> 10 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as acl
    where namespace_row.nspname = target_schema
  ) <> 10 then
    raise exception 'public schema ACL is not the exact reviewed ten-entry policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl as default_acl
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = default_acl.defaclnamespace
    where default_acl.defaclnamespace = 0
      or namespace_row.nspname = target_schema
  ) then
    raise exception 'an unversioned global or public-schema default ACL affects restored objects or capabilities'
      using errcode = '55000';
  end if;
end;
$policy$;

commit;
