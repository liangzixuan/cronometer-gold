-- Versioned post-restore policy for catalogue authority migrations 0014-0021.
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
      and class_row.relacl is not null
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
  -- stage/validate, and activation
  -- CHECK boundary as
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
        'food_source_release_activation_database_authority_check'
      )
  ) <> 8 or exists (
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
          'food_source_release_activation',
          'food_source_release_activation_database_authority_check',
          $constraint$CHECK ((database_principal IS NULL AND database_capability_role IS NULL OR database_principal IS NOT NULL AND database_capability_role IS NOT NULL AND octet_length(database_principal) >= 1 AND octet_length(database_principal) <= 63 AND database_capability_role =
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
    raise exception 'catalogue frozen-materialization, nutrition-semantic, stage/validate, or activation constraint differs from the forward 0021 policy'
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
    raise exception 'catalogue frozen-materialization, nutrition-semantic, or stage/validate column identity differs from the forward 0021 policy'
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

  -- Pin the complete authority function boundary through migration 0021.
  -- Exact identity, executable body, and search_path are policy, not
  -- merely source/target parity.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
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
  ) <> 54 or exists (
    select 1
    from (
      values
        ('advance_food_search_projection_revision'::text, ''::text, 'd1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108'::text, 'void'::text, 'plpgsql'::text, 'v'::text, false, false, 'u'::text, false),
        ('catalogue_attest_import_nutrition_semantics', 'p_batch_id uuid', 'e2c35dfabb653636a9640475227104a485a24129558b11511175831ef9bc5b8b', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_canonical_decimal_product', 'p_left text, p_right text', '299a2c88226123f167fe2d7001fdaf6a2e02425007f2426c8def9d0bb83a46c0', 'text', 'plpgsql', 'i', true, false, 's', false),
        ('catalogue_compute_import_staging_seal', 'p_batch_id uuid', '399d40c2913c2022c0a2921d5870a2d26a5dcd9949d81715882f70899db4f5f8', 'text', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_compute_record_nutrition_semantics', 'p_record_id bigint', '41f048090dce80b794615f135f5368f7f501eaecfc3513471eb6d1f36c022783', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_evidence_bundle_uri_is_valid'::text, 'value text, digest text'::text, '5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e'::text, 'boolean'::text, 'sql'::text, 'i'::text, true, false, 'u'::text, false),
        ('catalogue_observe_import_validation', 'p_batch_id uuid', '0a87bc99f5df97282c48b6202799bcc75cdb914e7473c0c38e092aaf4a132acf', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_promote_import_batch', 'p_batch_id uuid, p_external_principal_id text, p_reason text', '309861b6850a99bb565466981602ee19054b9c2500dfee21bf27edc6be382111', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_promote_import_batch_v1', 'p_batch_id uuid, p_external_principal_id text, p_reason text', '115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_record_import_approval', 'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text', 'abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41', 'boolean', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_record_import_approval_v1', 'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text', '89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac', 'boolean', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_rollback_source_release', 'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text', '56e9fa2cce7f532c1f405658ff9f07908394d0fb9734b70d0bdb92a12292068a', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_rollback_source_release_v1', 'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text', '3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_batch', 'p_stage_document text', '11b0a983c9cf3d4a7451978d37e5fe997a40290a10e741ba0626b89bfd2611c4', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_parser_report', 'p_batch_id uuid, p_parser_report_document text', 'd89defb335e21228c38968ef69b2ed7342f5a5440762ae31f170969fbcc9c9e8', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_stage_import_record_chunk', 'p_batch_id uuid, p_expected_next_offset bigint, p_records_document text', '4cc2b310ba6fda051a125bb203c0cf2c6a5fbe227a55daf517a0376ab79e4c7f', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_utf16_length', 'p_value text', '3a1759986b190b3ccac086e5da943ada91f3cc8c3a94ce6942657faae389ef39', 'bigint', 'sql', 'i', true, false, 's', false),
        ('catalogue_validate_import_batch', 'p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text', '10c59084d8e5c7debb581c6e749f6779dbc3f5867fc4cb18ffc009293f9f50a5', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
        ('catalogue_validate_import_batch_v1', 'p_batch_id uuid, p_expected_staging_seal_sha256 text, p_expected_observation_sha256 text, p_validation_document text', '5b7ae15625fb0ae0d88a9512fe82fca69a9d0dd9e179af8bc1b2f42d1e85ac8a', 'jsonb', 'plpgsql', 'v', false, false, 'u', true),
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
        ('guard_food_source_release_activation_authority', '', 'd46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
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
        when expected.function_name = 'reject_immutable_row_update' then null::text[]
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
  ) <> 54 or exists (
    select 1
    from (
      values
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
        ) <> 'abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41'
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

  -- Logical restore omits ACLs. Reconstruct the nineteen migration-0020/0021
  -- function ACLs from the reviewed manifest, stripping named grants first.
  for stage_validate_function_spec in
    select *
    from (
      values
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
    end if;

    expected_acl_count := case
      when stage_validate_function_spec.acl_kind = 'owner' then 1
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
          )
        )
    ) then
      raise exception 'catalogue stage/validate function % ACL differs from policy',
        stage_validate_function_spec.function_identity using errcode = '55000';
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
