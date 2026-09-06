-- Freeze the exact validated-food materialization contract and expose only
-- identifier-driven promotion and rollback workflows. Capability callers
-- receive no table, column, sequence, or generic shared-food writer access.
-- Recovery is forward-only: restore the pre-migration database backup.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-authority:v1')
);

do $migration$
declare
  target_schema name := pg_catalog.current_schema();
  table_owner oid;
begin
  select class_row.relowner
  into table_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');
  if table_owner is null then
    raise exception 'catalogue promotion authority tables are absent'
      using errcode = '42P01';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname in (
        'custom_food_version',
        'food',
        'food_barcode',
        'food_import_approval',
        'food_import_batch',
        'food_import_parser_report',
        'food_import_record',
        'food_nutrient_value',
        'food_search_projection_revision',
        'food_serving',
        'food_source',
        'food_source_release',
        'food_source_release_activation',
        'food_version',
        'nutrient',
        'outbox_event',
        'source_nutrient_map',
        'source_nutrient_map_revision'
      )
      and class_row.relkind in ('r', 'p')
      and class_row.relowner = table_owner
  ) <> 18 then
    raise exception 'catalogue promotion authority tables are absent or have an unexpected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from food_import_batch
    where status in ('ready', 'promoting')
  ) then
    raise exception 'catalogue promotion authority found a ready or promoting batch under the pre-0019 validation contract'
      using
        errcode = '55000',
        hint = 'Resolve or fail the old attempt and stage a new validation attempt; never fabricate frozen materialization evidence.';
  end if;

  if exists (
    select import_batch_id
    from food_source_release_activation
    where import_batch_id is not null
    group by import_batch_id
    having pg_catalog.count(*) <> 1
  ) then
    raise exception 'catalogue activation history contains duplicate import-batch activations'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from food_import_batch as batch
    where batch.status = 'completed'
      and (
        batch.release_id is null
        or (
          select pg_catalog.count(*)
          from food_source_release_activation as activation
          where activation.import_batch_id = batch.id
            and activation.food_source_id = batch.food_source_id
            and activation.operation = 'activate'
            and activation.release_id = batch.release_id
        ) <> 1
        or (
          select pg_catalog.count(*)
          from food_source_release_activation as activation
          where activation.import_batch_id = batch.id
        ) <> 1
      )
  ) then
    raise exception 'completed catalogue batch lacks exactly one matching activation'
      using
        errcode = '55000',
        hint = 'Preserve the historical batch and activation evidence; resolve the missing lineage before exposing completed-batch replay.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute as attribute_row
    join pg_catalog.pg_class as class_row
      on class_row.oid = attribute_row.attrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and (
        (class_row.relname = 'food_import_record' and attribute_row.attname in (
          'validated_food_document',
          'validated_food_sha256',
          'validated_food_contract_version'
        ))
        or (class_row.relname = 'food_import_batch' and attribute_row.attname in (
          'validated_food_contract_version',
          'nutrient_mapping_digest',
          'nutrient_mapping_revision_ids'
        ))
      )
      and not attribute_row.attisdropped
  ) or exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'catalogue_promote_import_batch',
        'catalogue_rollback_source_release',
        'guard_food_source_release_activation_authority'
      )
  ) then
    raise exception 'catalogue promotion authority objects already exist'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_custom_food_child_insert_v3',
        'guard_custom_food_immutable_evidence_v3',
        'guard_food_barcode_validity_update',
        'guard_imported_food_version_child_delete',
        'guard_source_barcode_delete',
        'set_row_updated_at',
        'validate_food_version_child_insert'
      )
  ) <> 7 or exists (
    select 1
    from (
      values
        (
          'guard_custom_food_child_insert_v3'::text,
          'f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88'::text
        ),
        (
          'guard_custom_food_immutable_evidence_v3',
          '5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317'
        ),
        (
          'guard_food_barcode_validity_update',
          '7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc'
        ),
        (
          'guard_imported_food_version_child_delete',
          '4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1'
        ),
        (
          'guard_source_barcode_delete',
          'd4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf'
        ),
        (
          'set_row_updated_at',
          '92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd'
        ),
        (
          'validate_food_version_child_insert',
          '5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07'
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
      or procedure_row.proowner <> table_owner
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
      or procedure_row.proacl is not null
      or procedure_row.proconfig is not null
  ) then
    raise exception 'catalogue shared-food trigger function identity or semantics differ'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_food_import_batch_update',
        'guard_food_import_batch_validation_digest',
        'guard_food_import_record_update'
      )
  ) <> 3 or exists (
    select 1
    from (
      values
        (
          'guard_food_import_batch_update'::text,
          '59dc41d73ec62b554caa721e13a2581a75327688f840cab922fddad0ca7be249'::text
        ),
        (
          'guard_food_import_batch_validation_digest',
          '511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2'
        ),
        (
          'guard_food_import_record_update',
          'b111a6db4f4bd43bf2e9183ecf0ee8b19ccda1ed3679c598ef2f73d58d9cb2d9'
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
      or procedure_row.proowner <> table_owner
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
      or procedure_row.proacl is not null
      or procedure_row.proconfig is distinct from array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]
  ) then
    raise exception 'catalogue import guard function identity or semantics differ'
      using errcode = '55000';
  end if;

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
          and trigger_row.tgname in (
            'custom_food_nutrient_guard_delete_v3',
            'custom_food_nutrient_guard_insert_v3',
            'custom_food_serving_guard_delete_v3',
            'custom_food_serving_guard_insert_v3',
            'custom_food_version_guard_delete_v3',
            'food_barcode_guard_update',
            'food_barcode_reject_delete',
            'food_import_batch_guard_update',
            'food_import_batch_guard_validation_digest',
            'food_import_record_guard_update',
            'food_nutrient_value_reject_delete',
            'food_nutrient_value_validate_insert',
            'food_serving_reject_delete',
            'food_serving_validate_insert'
          )
        )
        or (
          procedure_namespace_row.nspname = target_schema
          and procedure_row.proname in (
            'guard_custom_food_child_insert_v3',
            'guard_custom_food_immutable_evidence_v3',
            'guard_food_barcode_validity_update',
            'guard_food_import_batch_update',
            'guard_food_import_batch_validation_digest',
            'guard_food_import_record_update',
            'guard_imported_food_version_child_delete',
            'guard_source_barcode_delete',
            'validate_food_version_child_insert'
          )
          and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
        )
      )
  ) <> 14 or exists (
    select 1
    from (
      values
        ('custom_food_nutrient_guard_delete_v3'::text, 'food_nutrient_value'::text, 'guard_custom_food_immutable_evidence_v3'::text,
          'CREATE TRIGGER custom_food_nutrient_guard_delete_v3 BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'::text),
        ('custom_food_nutrient_guard_insert_v3'::text, 'food_nutrient_value'::text, 'guard_custom_food_child_insert_v3'::text,
          'CREATE TRIGGER custom_food_nutrient_guard_insert_v3 BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()'::text),
        ('custom_food_serving_guard_delete_v3', 'food_serving', 'guard_custom_food_immutable_evidence_v3',
          'CREATE TRIGGER custom_food_serving_guard_delete_v3 BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'),
        ('custom_food_serving_guard_insert_v3', 'food_serving', 'guard_custom_food_child_insert_v3',
          'CREATE TRIGGER custom_food_serving_guard_insert_v3 BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_custom_food_child_insert_v3()'),
        ('custom_food_version_guard_delete_v3', 'food_version', 'guard_custom_food_immutable_evidence_v3',
          'CREATE TRIGGER custom_food_version_guard_delete_v3 BEFORE DELETE ON food_version FOR EACH ROW EXECUTE FUNCTION guard_custom_food_immutable_evidence_v3()'),
        ('food_barcode_guard_update', 'food_barcode', 'guard_food_barcode_validity_update',
          'CREATE TRIGGER food_barcode_guard_update BEFORE UPDATE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_food_barcode_validity_update()'),
        ('food_barcode_reject_delete', 'food_barcode', 'guard_source_barcode_delete',
          'CREATE TRIGGER food_barcode_reject_delete BEFORE DELETE ON food_barcode FOR EACH ROW EXECUTE FUNCTION guard_source_barcode_delete()'),
        ('food_import_batch_guard_update', 'food_import_batch', 'guard_food_import_batch_update',
          'CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()'),
        ('food_import_batch_guard_validation_digest', 'food_import_batch', 'guard_food_import_batch_validation_digest',
          'CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()'),
        ('food_import_record_guard_update', 'food_import_record', 'guard_food_import_record_update',
          'CREATE TRIGGER food_import_record_guard_update BEFORE UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()'),
        ('food_nutrient_value_reject_delete', 'food_nutrient_value', 'guard_imported_food_version_child_delete',
          'CREATE TRIGGER food_nutrient_value_reject_delete BEFORE DELETE ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()'),
        ('food_nutrient_value_validate_insert', 'food_nutrient_value', 'validate_food_version_child_insert',
          'CREATE TRIGGER food_nutrient_value_validate_insert BEFORE INSERT ON food_nutrient_value FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()'),
        ('food_serving_reject_delete', 'food_serving', 'guard_imported_food_version_child_delete',
          'CREATE TRIGGER food_serving_reject_delete BEFORE DELETE ON food_serving FOR EACH ROW EXECUTE FUNCTION guard_imported_food_version_child_delete()'),
        ('food_serving_validate_insert', 'food_serving', 'validate_food_version_child_insert',
          'CREATE TRIGGER food_serving_validate_insert BEFORE INSERT ON food_serving FOR EACH ROW EXECUTE FUNCTION validate_food_version_child_insert()')
    ) as expected(trigger_name, table_name, function_name, trigger_definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
      and class_row.relkind in ('r', 'p')
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    left join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
    where trigger_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or procedure_namespace_row.nspname <> target_schema
      or procedure_row.proname <> expected.function_name
      or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) <> ''
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.trigger_definition
  ) then
    raise exception 'catalogue shared-food trigger identity or definition differs'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = 'food_source_release_activation'::pg_catalog.regclass
      and constraint_row.conname = 'food_source_release_activation_expand_audit_null_check'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (database_principal IS NULL AND database_capability_role IS NULL)'
  ) then
    raise exception 'catalogue activation EXPAND fence is absent or differs'
      using errcode = '55000';
  end if;
end;
$migration$;

alter table food_import_record
  add column validated_food_document text,
  add column validated_food_sha256 text,
  add column validated_food_contract_version smallint,
  add constraint food_import_record_validated_food_contract_check check (
    (
      (
        validated_food_document is null
        and validated_food_sha256 is null
        and validated_food_contract_version is null
        and validation_status in ('pending', 'quarantined', 'valid', 'materialized')
      )
      or (
        validated_food_document is not null
        and validated_food_sha256 ~ '^[0-9a-f]{64}$'
        and validated_food_contract_version = 1
        and validation_status in ('valid', 'materialized')
        and pg_catalog.jsonb_typeof(validated_food_document::jsonb) = 'object'
        and validated_food_sha256 = pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(validated_food_document, 'UTF8')),
          'hex'
        )
      )
    ) is true
  );

alter table food_import_batch
  add column validated_food_contract_version smallint,
  add column nutrient_mapping_digest text,
  add column nutrient_mapping_revision_ids jsonb,
  add constraint food_import_batch_materialization_contract_check check (
    (
      (
        validated_food_contract_version is null
        and nutrient_mapping_digest is null
        and nutrient_mapping_revision_ids is null
      )
      or (
        validated_food_contract_version = 1
        and nutrient_mapping_digest ~ '^[0-9a-f]{64}$'
        and pg_catalog.jsonb_typeof(nutrient_mapping_revision_ids) = 'array'
        and validated_at is not null
      )
    ) is true
  ),
  add constraint food_import_batch_promotable_contract_check check (
    (
      status not in ('ready', 'promoting')
      or (
        validated_food_contract_version = 1
        and nutrient_mapping_digest is not null
        and nutrient_mapping_revision_ids is not null
      )
    ) is true
  );

create or replace function guard_food_import_record_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.validation_status <> 'pending'
      or new.validated_at is not null
      or new.materialized_at is not null
      or new.food_version_id is not null
      or new.validated_food_document is not null
      or new.validated_food_sha256 is not null
      or new.validated_food_contract_version is not null
      or new.validation_issues <> '[]'::jsonb then
      raise exception 'new food import record must begin pending without validation or materialization evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if row(
    new.id,
    new.batch_id,
    new.source_record_key,
    new.source_record_type,
    new.sequence_number,
    new.source_payload_sha256,
    new.canonical_payload_sha256,
    new.canonical_payload,
    new.created_at
  ) is distinct from row(
    old.id,
    old.batch_id,
    old.source_record_key,
    old.source_record_type,
    old.sequence_number,
    old.source_payload_sha256,
    old.canonical_payload_sha256,
    old.canonical_payload,
    old.created_at
  ) then
    raise exception 'food import record provenance cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.validation_status <> new.validation_status and not (
    (old.validation_status = 'pending' and new.validation_status in ('quarantined', 'valid'))
    or (old.validation_status = 'valid' and new.validation_status = 'materialized')
  ) then
    raise exception 'invalid food import record status transition from % to %',
      old.validation_status, new.validation_status using errcode = '23514';
  end if;

  if old.validation_status <> 'pending'
    and row(
      new.validation_issues,
      new.validated_at,
      new.validated_food_document,
      new.validated_food_sha256,
      new.validated_food_contract_version
    ) is distinct from row(
      old.validation_issues,
      old.validated_at,
      old.validated_food_document,
      old.validated_food_sha256,
      old.validated_food_contract_version
    ) then
    raise exception 'validated import record evidence cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.validation_status = 'pending' and new.validation_status = 'pending'
    and row(
      new.validated_at,
      new.validated_food_document,
      new.validated_food_sha256,
      new.validated_food_contract_version,
      new.food_version_id,
      new.materialized_at
    ) is distinct from row(null, null, null, null, null, null) then
    raise exception 'pending import record cannot carry frozen validation or materialization evidence'
      using errcode = '23514';
  end if;

  if old.validation_status = 'pending' and new.validation_status = 'valid'
    and (
      new.validated_at is null
      or new.validated_food_document is null
      or new.validated_food_sha256 is null
      or new.validated_food_contract_version <> 1
    ) then
    raise exception 'valid import record requires the complete frozen materialization contract'
      using errcode = '23514';
  end if;

  if old.validation_status = 'pending' and new.validation_status = 'quarantined'
    and (
      new.validated_at is null
      or new.validated_food_document is not null
      or new.validated_food_sha256 is not null
      or new.validated_food_contract_version is not null
    ) then
    raise exception 'quarantined import record cannot carry a materialization document'
      using errcode = '23514';
  end if;

  if old.validation_status = 'valid' and new.validation_status = 'materialized' then
    if old.validated_food_document is null
      or old.validated_food_sha256 is null
      or old.validated_food_contract_version <> 1
      or new.food_version_id is null
      or new.materialized_at is null then
      raise exception 'materialized import record requires frozen food evidence and a linked version'
        using errcode = '23514';
    end if;
  elsif row(new.food_version_id, new.materialized_at)
    is distinct from row(old.food_version_id, old.materialized_at) then
    raise exception 'food import materialization link may only be set once during valid-to-materialized transition'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger food_import_record_guard_update on food_import_record;
create trigger food_import_record_guard_update
before insert or update on food_import_record
for each row execute function guard_food_import_record_update();

create or replace function guard_food_import_batch_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.id,
    new.food_source_id,
    new.release_key,
    new.published_on,
    new.acquired_at,
    new.artifact_uri,
    new.artifact_sha256,
    new.artifact_bytes,
    new.media_type,
    new.upstream_schema_version,
    new.parser_version,
    new.rights_manifest_uri,
    new.rights_manifest_sha256,
    new.release_class,
    new.evidence_bundle_sha256,
    new.evidence_bundle_uri,
    new.evidence_decision_sha256,
    new.evidence_object_version_id,
    new.evidence_valid_until,
    new.created_at
  ) is distinct from row(
    old.id,
    old.food_source_id,
    old.release_key,
    old.published_on,
    old.acquired_at,
    old.artifact_uri,
    old.artifact_sha256,
    old.artifact_bytes,
    old.media_type,
    old.upstream_schema_version,
    old.parser_version,
    old.rights_manifest_uri,
    old.rights_manifest_sha256,
    old.release_class,
    old.evidence_bundle_sha256,
    old.evidence_bundle_uri,
    old.evidence_decision_sha256,
    old.evidence_object_version_id,
    old.evidence_valid_until,
    old.created_at
  ) then
    raise exception 'food import batch provenance cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.status <> new.status and not (
    (old.status = 'staging' and new.status in ('failed', 'quarantined', 'ready'))
    or (old.status = 'ready' and new.status in ('failed', 'promoting'))
    or (old.status = 'promoting' and new.status = 'completed')
  ) then
    raise exception 'invalid food import batch status transition from % to %', old.status, new.status
      using errcode = '23514';
  end if;

  if old.status <> new.status
    and new.status in ('promoting', 'completed')
    and (
      new.release_class <> 'live-reviewed'
      or new.evidence_valid_until is null
      or new.evidence_valid_until <= pg_catalog.clock_timestamp()
    ) then
    raise exception 'only current live-reviewed evidence may enter batch status %', new.status
      using errcode = '23514';
  end if;

  if old.validated_at is not null and row(
    new.staged_count,
    new.valid_count,
    new.quarantined_count,
    new.unresolved_error_count,
    new.warning_count,
    new.nutrient_input_count,
    new.nutrient_materializable_count,
    new.nutrient_excluded_count,
    new.validation_policy,
    new.validation_digest,
    new.validated_food_contract_version,
    new.nutrient_mapping_digest,
    new.nutrient_mapping_revision_ids,
    new.validated_at
  ) is distinct from row(
    old.staged_count,
    old.valid_count,
    old.quarantined_count,
    old.unresolved_error_count,
    old.warning_count,
    old.nutrient_input_count,
    old.nutrient_materializable_count,
    old.nutrient_excluded_count,
    old.validation_policy,
    old.validation_digest,
    old.validated_food_contract_version,
    old.nutrient_mapping_digest,
    old.nutrient_mapping_revision_ids,
    old.validated_at
  ) then
    raise exception 'validated food import batch summary cannot be rewritten'
      using errcode = '55000';
  end if;

  new.updated_at = pg_catalog.clock_timestamp();
  return new;
end;
$$;

create or replace function guard_food_import_batch_validation_digest()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.validation_digest is not null
      or new.validated_at is not null
      or new.validated_food_contract_version is not null
      or new.nutrient_mapping_digest is not null
      or new.nutrient_mapping_revision_ids is not null then
      raise exception 'new food import batch cannot begin with validation evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.validated_at is null and new.validated_at is not null
    and (
      new.status not in ('quarantined', 'ready')
      or new.validation_digest is null
      or new.validated_food_contract_version <> 1
      or new.nutrient_mapping_digest is null
      or new.nutrient_mapping_revision_ids is null
    ) then
    raise exception 'food import batch validation must freeze its complete materialization contract'
      using errcode = '23514';
  end if;

  if old.status is distinct from new.status
    and new.status in ('completed', 'promoting', 'quarantined', 'ready')
    and (
      new.validation_digest is null
      or new.validated_food_contract_version <> 1
      or new.nutrient_mapping_digest is null
      or new.nutrient_mapping_revision_ids is null
    ) then
    raise exception 'food import batch status % requires frozen validation and materialization evidence', new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

alter table food_source_release_activation
  drop constraint food_source_release_activation_expand_audit_null_check,
  drop constraint food_source_release_activation_database_authority_check,
  add constraint food_source_release_activation_database_authority_check check (
    (
      (database_principal is null and database_capability_role is null)
      or (
        database_principal is not null
        and database_capability_role is not null
        and pg_catalog.octet_length(database_principal) between 1 and 63
        and database_capability_role = case
          when import_batch_id is not null and operation = 'activate'
            then 'nutrition_catalogue_promote_activate'
          when import_batch_id is null and operation in ('deactivate', 'rollback')
            then 'nutrition_catalogue_rollback'
        end
      )
    ) is true
  );

create unique index food_source_release_activation_import_batch_unique
  on food_source_release_activation (import_batch_id)
  where import_batch_id is not null;

create function guard_food_source_release_activation_authority()
returns trigger
language plpgsql
as $$
declare
  activation_capabilities text[];
  batch food_import_batch%rowtype;
  expected_capability text;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_source_release_activation'::pg_catalog.regclass;

  if current_user::text <> table_owner then
    raise exception 'direct non-owner catalogue activation insert is forbidden'
      using errcode = '42501';
  end if;

  if new.import_batch_id is not null then
    if new.operation <> 'activate' then
      raise exception 'batch-linked activation must use the activate operation'
        using errcode = '23514';
    end if;
    select * into batch
    from food_import_batch
    where id = new.import_batch_id
    for share;
    if not found
      or batch.status <> 'promoting'
      or batch.food_source_id <> new.food_source_id
      or batch.release_id is distinct from new.release_id then
      raise exception 'batch-linked activation does not match the locked promoting batch'
        using errcode = '23514';
    end if;
    expected_capability := 'nutrition_catalogue_promote_activate';
  else
    if new.operation not in ('deactivate', 'rollback') then
      raise exception 'batchless catalogue activation must be rollback or deactivate'
        using errcode = '23514';
    end if;
    expected_capability := 'nutrition_catalogue_rollback';
  end if;

  if session_user::text = table_owner then
    if new.database_principal is not null or new.database_capability_role is not null then
      raise exception 'owner/local activation cannot claim database capability audit identity'
        using errcode = '42501';
    end if;
  else
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into activation_capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage',
      'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights',
      'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(activation_capabilities), 0) <> 1
      or activation_capabilities[1] <> expected_capability
      or new.database_principal is distinct from session_user::text
      or new.database_capability_role is distinct from expected_capability then
      raise exception 'catalogue activation authority does not match the authenticated capability'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger food_source_release_activation_guard_authority
before insert on food_source_release_activation
for each row execute function guard_food_source_release_activation_authority();

create function catalogue_promote_import_batch(
  p_batch_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  affected_count bigint;
  activation_id bigint;
  active_mapping_revision_ids jsonb;
  approval_count bigint;
  catalogue_capabilities text[];
  database_capability text;
  database_principal_name text;
  expected_barcode_count bigint;
  food_document jsonb;
  food_row food%rowtype;
  food_version_row food_version%rowtype;
  inserted_barcode_count bigint;
  mapped_canonical_unit text;
  mapped_nutrient_code text;
  mapped_nutrient_id bigint;
  mapped_source_name text;
  mapped_source_unit text;
  materialized_record_count bigint := 0;
  next_version_number integer;
  nutrient_document jsonb;
  parser_report food_import_parser_report%rowtype;
  previous_release_id uuid;
  record_count bigint;
  record_error_count bigint;
  valid_record_count bigint;
  quarantined_record_count bigint;
  record_row food_import_record%rowtype;
  record_counts_document jsonb;
  release_row food_source_release%rowtype;
  serving_document jsonb;
  source_row food_source%rowtype;
  table_owner text;
  validation_summary_document jsonb;
  workflow_batch food_import_batch%rowtype;
begin
  if p_external_principal_id is null
    or p_external_principal_id <> pg_catalog.btrim(p_external_principal_id)
    or p_external_principal_id <> pg_catalog.lower(p_external_principal_id)
    or p_external_principal_id !~ '^[a-z][-a-z0-9._:@/]{2,255}$' then
    raise exception 'external principal id is invalid'
      using errcode = '22023';
  end if;
  if p_reason is null
    or pg_catalog.length(pg_catalog.btrim(p_reason)) = 0
    or pg_catalog.octet_length(p_reason) > 2048 then
    raise exception 'promotion reason is required and must contain at most 2048 bytes'
      using errcode = '22023';
  end if;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue promotion function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text = table_owner then
    database_capability := null;
    database_principal_name := null;
  else
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into catalogue_capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage',
      'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights',
      'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(catalogue_capabilities), 0) <> 1
      or catalogue_capabilities[1] <> 'nutrition_catalogue_promote_activate' then
      raise exception 'database principal must hold exactly the catalogue promote/activate capability'
        using errcode = '42501';
    end if;
    database_capability := 'nutrition_catalogue_promote_activate';
    database_principal_name := session_user::text;
  end if;

  select * into workflow_batch
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue promotion references an unknown batch'
      using errcode = '23503';
  end if;
  if workflow_batch.release_class <> 'live-reviewed'
    or workflow_batch.evidence_bundle_sha256 is null
    or workflow_batch.evidence_bundle_uri is null
    or workflow_batch.evidence_decision_sha256 is null
    or workflow_batch.evidence_object_version_id is null
    or workflow_batch.evidence_valid_until is null then
    raise exception 'catalogue promotion requires bound live-reviewed evidence'
      using errcode = '23514';
  end if;

  select * into source_row
  from food_source
  where id = workflow_batch.food_source_id
  for update;
  if not found then
    raise exception 'catalogue promotion source is unavailable'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );
  perform lock_active_nutrient_registry_for_read();

  if workflow_batch.status = 'completed' then
    if workflow_batch.release_id is null then
      raise exception 'completed catalogue batch is missing its release'
        using errcode = '55000';
    end if;
    select activation.previous_release_id
    into strict previous_release_id
    from food_source_release_activation as activation
    where activation.import_batch_id = workflow_batch.id;
    return pg_catalog.jsonb_build_object(
      'activatedReleaseId', workflow_batch.release_id,
      'materializedCount', workflow_batch.materialized_count,
      'previousReleaseId', previous_release_id,
      'wasAlreadyCompleted', true
    );
  end if;

  if workflow_batch.evidence_valid_until <= pg_catalog.clock_timestamp() then
    raise exception 'catalogue promotion requires current live-reviewed evidence'
      using errcode = '23514';
  end if;
  if not source_row.active
    or source_row.commercial_use_allowed is distinct from true
    or source_row.rights_review_status not in ('approved', 'restricted')
    or source_row.rights_reviewed_at is null
    or source_row.rights_reviewed_by is null then
    raise exception 'catalogue source is not eligible for activation'
      using errcode = '23514';
  end if;
  if workflow_batch.status <> 'ready'
    or workflow_batch.unresolved_error_count <> 0
    or workflow_batch.release_id is not null
    or workflow_batch.completed_at is not null
    or workflow_batch.materialized_count <> 0
    or workflow_batch.validation_digest is null
    or workflow_batch.validated_food_contract_version <> 1
    or workflow_batch.nutrient_mapping_digest is null
    or workflow_batch.nutrient_mapping_revision_ids is null then
    raise exception 'catalogue batch is not promotion-ready under materialization contract version 1'
      using errcode = '55000';
  end if;
  if pg_catalog.substring(
    workflow_batch.parser_version, '[+]mapping[.]([0-9a-f]{64})$'
  ) is distinct from workflow_batch.nutrient_mapping_digest then
    raise exception 'catalogue parser version does not bind the frozen nutrient mapping digest'
      using errcode = '23514';
  end if;

  select * into parser_report
  from food_import_parser_report
  where batch_id = workflow_batch.id;
  if not found
    or parser_report.emitted_record_count <> workflow_batch.staged_count
    or parser_report.source_record_count < parser_report.emitted_record_count
    or parser_report.source_nutrient_count <> workflow_batch.nutrient_input_count then
    raise exception 'catalogue parser evidence does not match the frozen batch summary'
      using errcode = '23514';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where validation_status = 'valid'),
    pg_catalog.count(*) filter (where validation_status = 'quarantined')
  into record_count, valid_record_count, quarantined_record_count
  from food_import_record
  where batch_id = workflow_batch.id;
  if record_count <> workflow_batch.staged_count
    or valid_record_count <> workflow_batch.valid_count
    or quarantined_record_count + parser_report.excluded_record_count <>
      workflow_batch.quarantined_count then
    raise exception 'catalogue record classifications do not match the frozen batch summary'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from food_import_record as record
    where record.batch_id = workflow_batch.id
      and record.validation_status = 'valid'
      and (
        record.validated_food_document is null
        or record.validated_food_sha256 is null
        or record.validated_food_contract_version <> 1
        or record.validated_food_sha256 <> pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(record.validated_food_document, 'UTF8')),
          'hex'
        )
      )
  ) then
    raise exception 'catalogue valid record lacks exact frozen materialization evidence'
      using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      mapping.current_revision_id::text
      order by mapping.current_revision_id::text collate "C"
    ),
    '[]'::jsonb
  )
  into active_mapping_revision_ids
  from source_nutrient_map as mapping
  where mapping.food_source_id = source_row.id;
  if active_mapping_revision_ids is distinct from workflow_batch.nutrient_mapping_revision_ids then
    raise exception 'active nutrient mappings changed after catalogue validation'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*) into approval_count
  from food_import_approval as approval
  where approval.batch_id = workflow_batch.id
    and approval.validation_digest = workflow_batch.validation_digest
    and approval.rights_manifest_sha256 = workflow_batch.rights_manifest_sha256
    and approval.approval_role in ('data', 'quality', 'rights');
  if approval_count <> 3 or exists (
    select 1
    from pg_catalog.unnest(array['data', 'quality', 'rights']) as required(role_name)
    where not exists (
      select 1
      from food_import_approval as approval
      where approval.batch_id = workflow_batch.id
        and approval.approval_role = required.role_name
        and approval.validation_digest = workflow_batch.validation_digest
        and approval.rights_manifest_sha256 = workflow_batch.rights_manifest_sha256
    )
  ) then
    raise exception 'current data, quality, and rights approvals are required for promotion'
      using errcode = '23514';
  end if;
  if coalesce((workflow_batch.validation_policy ->>
      'requireDistinctApprovalPrincipals')::boolean, true)
    and (
      select pg_catalog.count(distinct approval.principal_id)
      from food_import_approval as approval
      where approval.batch_id = workflow_batch.id
    ) <> 3 then
    raise exception 'promotion policy requires distinct approval principals'
      using errcode = '23514';
  end if;
  if database_capability is not null and exists (
    select 1
    from food_import_approval as approval
    where approval.batch_id = workflow_batch.id
      and (
        approval.database_principal is null
        or approval.database_capability_role is distinct from case approval.approval_role
          when 'data' then 'nutrition_catalogue_approve_data'
          when 'quality' then 'nutrition_catalogue_approve_quality'
          when 'rights' then 'nutrition_catalogue_approve_rights'
        end
      )
  ) then
    raise exception 'capability promotion requires database-authenticated reviewer approvals'
      using errcode = '42501';
  end if;
  if database_capability is not null and (
    select pg_catalog.count(distinct approval.database_principal)
    from food_import_approval as approval
    where approval.batch_id = workflow_batch.id
  ) <> 3 then
    raise exception 'capability promotion requires three distinct database reviewer principals'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*) into record_error_count
  from food_import_record as record
  cross join lateral pg_catalog.jsonb_array_elements(record.validation_issues) as issue(value)
  where record.batch_id = workflow_batch.id
    and issue.value ->> 'severity' = 'error';
  record_counts_document := pg_catalog.jsonb_build_object(
    'materializable', workflow_batch.valid_count,
    'nutrientInput', workflow_batch.nutrient_input_count,
    'nutrientMaterializable', workflow_batch.nutrient_materializable_count,
    'nutrientExcluded', workflow_batch.nutrient_excluded_count,
    'parserExcludedRecords', parser_report.excluded_record_count,
    'quarantined', workflow_batch.quarantined_count,
    'sourcePortions', parser_report.source_portion_count,
    'sourceRecords', workflow_batch.staged_count + parser_report.excluded_record_count,
    'staged', workflow_batch.staged_count
  );
  validation_summary_document := pg_catalog.jsonb_build_object(
    'recordErrors', record_error_count,
    'excludedNutrientFraction', case
      when workflow_batch.nutrient_input_count = 0 then 1::double precision
      else workflow_batch.nutrient_excluded_count::double precision /
        workflow_batch.nutrient_input_count::double precision
    end,
    'nutrientMappingDigest', workflow_batch.nutrient_mapping_digest,
    'nutrientMappingRevisionIds', workflow_batch.nutrient_mapping_revision_ids,
    'parserExcludedNutrients', parser_report.excluded_nutrient_count,
    'parserExcludedPortions', parser_report.excluded_portion_count,
    'parserReportSha256', parser_report.report_sha256,
    'unresolvedErrors', workflow_batch.unresolved_error_count,
    'validatedFoodContractVersion', workflow_batch.validated_food_contract_version,
    'validationDigest', workflow_batch.validation_digest,
    'warnings', workflow_batch.warning_count
  );

  insert into food_source_release (
    food_source_id, release_key, published_on, acquired_at, artifact_uri,
    artifact_sha256, artifact_bytes, media_type, upstream_schema_version,
    parser_version, status, record_counts, validation_summary,
    rights_manifest_uri, rights_manifest_sha256, release_class,
    evidence_bundle_sha256, evidence_bundle_uri, evidence_decision_sha256,
    evidence_object_version_id, evidence_valid_until
  ) values (
    workflow_batch.food_source_id, workflow_batch.release_key,
    workflow_batch.published_on, workflow_batch.acquired_at,
    workflow_batch.artifact_uri, workflow_batch.artifact_sha256,
    workflow_batch.artifact_bytes, workflow_batch.media_type,
    workflow_batch.upstream_schema_version, workflow_batch.parser_version,
    'imported', record_counts_document, validation_summary_document,
    workflow_batch.rights_manifest_uri, workflow_batch.rights_manifest_sha256,
    workflow_batch.release_class, workflow_batch.evidence_bundle_sha256,
    workflow_batch.evidence_bundle_uri, workflow_batch.evidence_decision_sha256,
    workflow_batch.evidence_object_version_id, workflow_batch.evidence_valid_until
  )
  on conflict (food_source_id, release_key, artifact_sha256) do nothing
  returning * into release_row;
  if not found then
    select * into strict release_row
    from food_source_release
    where food_source_id = workflow_batch.food_source_id
      and release_key = workflow_batch.release_key
      and artifact_sha256 = workflow_batch.artifact_sha256;
  end if;
  if release_row.parser_version is distinct from workflow_batch.parser_version
    or release_row.rights_manifest_uri is distinct from workflow_batch.rights_manifest_uri
    or release_row.rights_manifest_sha256 is distinct from workflow_batch.rights_manifest_sha256
    or release_row.release_class is distinct from workflow_batch.release_class
    or release_row.evidence_bundle_sha256 is distinct from workflow_batch.evidence_bundle_sha256
    or release_row.evidence_bundle_uri is distinct from workflow_batch.evidence_bundle_uri
    or release_row.evidence_decision_sha256 is distinct from workflow_batch.evidence_decision_sha256
    or release_row.evidence_object_version_id is distinct from workflow_batch.evidence_object_version_id
    or release_row.evidence_valid_until is distinct from workflow_batch.evidence_valid_until
    or release_row.record_counts is distinct from record_counts_document
    or release_row.validation_summary is distinct from validation_summary_document
    or release_row.status not in ('imported', 'promoted') then
    raise exception 'existing source release provenance differs from the approved batch'
      using errcode = '23514';
  end if;

  update food_import_batch
  set release_id = release_row.id, status = 'promoting'
  where id = workflow_batch.id;

  for record_row in
    select *
    from food_import_record
    where batch_id = workflow_batch.id
      and validation_status = 'valid'
    order by sequence_number
    for update
  loop
    if record_row.validated_food_document is null
      or record_row.validated_food_sha256 is null
      or record_row.validated_food_contract_version <> 1
      or record_row.validated_food_sha256 <> pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(record_row.validated_food_document, 'UTF8')),
        'hex'
      ) then
      raise exception 'catalogue record % has invalid frozen materialization evidence',
        record_row.source_record_key using errcode = '23514';
    end if;
    food_document := record_row.validated_food_document::jsonb;
    if pg_catalog.jsonb_typeof(food_document) <> 'object'
      or not food_document ?& array[
        'attributes', 'basisQuantity', 'brandName', 'description', 'gtin', 'kind',
        'languageTag', 'marketCode', 'name', 'normalizedName', 'nutrients',
        'servings', 'sourceDataType', 'sourceFoodKey', 'sourceModifiedAt'
      ]
      or food_document - array[
        'attributes', 'basisQuantity', 'brandName', 'description', 'gtin', 'kind',
        'languageTag', 'marketCode', 'name', 'normalizedName', 'nutrients',
        'servings', 'sourceDataType', 'sourceFoodKey', 'sourceModifiedAt'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(food_document -> 'attributes') <> 'object'
      or pg_catalog.jsonb_typeof(food_document -> 'nutrients') <> 'array'
      or pg_catalog.jsonb_typeof(food_document -> 'servings') <> 'array'
      or food_document ->> 'kind' not in ('branded', 'generic')
      or pg_catalog.length(pg_catalog.btrim(food_document ->> 'sourceFoodKey')) = 0
      or food_document ->> 'sourceDataType' is distinct from record_row.source_record_type
      or food_document -> 'attributes' ->> 'idempotencyKey'
        is distinct from record_row.source_record_key
      or food_document -> 'attributes' ->> 'sourcePayloadSha256'
        is distinct from record_row.source_payload_sha256
      or food_document -> 'attributes' ->> 'unlistedNutrientPolicy'
        is distinct from 'unknown_not_reported'
      or pg_catalog.length(pg_catalog.btrim(food_document ->> 'name')) = 0
      or pg_catalog.length(pg_catalog.btrim(food_document ->> 'normalizedName')) = 0
      or pg_catalog.length(food_document ->> 'languageTag') not between 2 and 35
      or food_document ->> 'marketCode' !~ '^[A-Z0-9]{2,3}$'
      or (
        pg_catalog.jsonb_typeof(food_document -> 'gtin') <> 'null'
        and food_document ->> 'gtin' !~ '^[0-9]{14}$'
      ) then
      raise exception 'catalogue record % frozen materialization document has an unsupported shape',
        record_row.source_record_key using errcode = '23514';
    end if;

    insert into food (food_source_id, kind, owner_user_id, source_food_key, visibility)
    values (
      source_row.id,
      food_document ->> 'kind',
      null,
      food_document ->> 'sourceFoodKey',
      'public'
    )
    on conflict (food_source_id, source_food_key)
      where food_source_id is not null
      do nothing;
    select * into strict food_row
    from food
    where food_source_id = source_row.id
      and source_food_key = food_document ->> 'sourceFoodKey'
    for update;
    if food_row.kind is distinct from food_document ->> 'kind'
      or food_row.owner_user_id is not null
      or food_row.visibility <> 'public' then
      raise exception 'source food identity conflicts with the approved public catalogue document'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from food_version
      where food_id = food_row.id
        and source_release_id = release_row.id
    ) then
      raise exception 'source food version existed before its batch materialization transition'
        using errcode = '55000';
    end if;
    select (coalesce(pg_catalog.max(version_number), 0) + 1)::integer
    into next_version_number
    from food_version
    where food_id = food_row.id;
    insert into food_version (
      attributes, basis_quantity, basis_unit, brand_name, created_by_user_id,
      data_quality, description, food_id, ingredients_text, language_tag,
      market_code, name, normalized_name, source_modified_at,
      source_release_id, version_number
    ) values (
      (food_document -> 'attributes') || pg_catalog.jsonb_build_object(
        'canonicalPayloadSha256', record_row.canonical_payload_sha256,
        'importBatchId', workflow_batch.id,
        'validatedFoodContractVersion', record_row.validated_food_contract_version,
        'validatedFoodSha256', record_row.validated_food_sha256
      ),
      (food_document ->> 'basisQuantity')::numeric,
      'g',
      case when pg_catalog.jsonb_typeof(food_document -> 'brandName') = 'null'
        then null else food_document ->> 'brandName' end,
      null,
      'provisional',
      case when pg_catalog.jsonb_typeof(food_document -> 'description') = 'null'
        then null else food_document ->> 'description' end,
      food_row.id,
      null,
      food_document ->> 'languageTag',
      food_document ->> 'marketCode',
      food_document ->> 'name',
      food_document ->> 'normalizedName',
      case when pg_catalog.jsonb_typeof(food_document -> 'sourceModifiedAt') = 'null'
        then null else (food_document ->> 'sourceModifiedAt')::timestamptz end,
      release_row.id,
      next_version_number
    ) returning * into strict food_version_row;

    for nutrient_document in
      select nutrient.value
      from pg_catalog.jsonb_array_elements(food_document -> 'nutrients') as nutrient(value)
    loop
      if pg_catalog.jsonb_typeof(nutrient_document) <> 'object'
        or not nutrient_document ?& array[
          'amount', 'canonicalUnit', 'dataPoints', 'derivationCode', 'metadata',
          'mappingRevisionId', 'nutrientCode', 'nutrientId', 'sourceAmount',
          'sourceBasisQuantity', 'sourceBasisUnit', 'sourceName',
          'sourceNutrientId', 'sourceUnit', 'valueStatus'
        ]
        or nutrient_document - array[
          'amount', 'canonicalUnit', 'dataPoints', 'derivationCode', 'metadata',
          'mappingRevisionId', 'nutrientCode', 'nutrientId', 'sourceAmount',
          'sourceBasisQuantity', 'sourceBasisUnit', 'sourceName',
          'sourceNutrientId', 'sourceUnit', 'valueStatus'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(nutrient_document -> 'metadata') <> 'object'
        or nutrient_document ->> 'nutrientId' !~ '^[1-9][0-9]*$' then
        raise exception 'catalogue nutrient materialization document has an unsupported shape'
          using errcode = '23514';
      end if;
      select
        revision.nutrient_id,
        canonical_nutrient.code,
        canonical_nutrient.canonical_unit,
        revision.source_name,
        revision.source_unit
      into
        mapped_nutrient_id,
        mapped_nutrient_code,
        mapped_canonical_unit,
        mapped_source_name,
        mapped_source_unit
      from source_nutrient_map as mapping
      join source_nutrient_map_revision as revision
        on revision.id = mapping.current_revision_id
       and revision.food_source_id = mapping.food_source_id
       and revision.source_nutrient_key = mapping.source_nutrient_key
      join nutrient as canonical_nutrient
        on canonical_nutrient.id = revision.nutrient_id
      where mapping.food_source_id = source_row.id
        and mapping.source_nutrient_key = nutrient_document ->> 'sourceNutrientId'
        and mapping.current_revision_id = (nutrient_document ->> 'mappingRevisionId')::uuid;
      if not found
        or mapped_nutrient_id <> (nutrient_document ->> 'nutrientId')::bigint
        or mapped_nutrient_code is distinct from nutrient_document ->> 'nutrientCode'
        or mapped_canonical_unit is distinct from nutrient_document ->> 'canonicalUnit'
        or mapped_source_name is distinct from nutrient_document ->> 'sourceName'
        or nutrient_document -> 'metadata' ->> 'mappingRevisionId'
          is distinct from nutrient_document ->> 'mappingRevisionId'
        or nutrient_document -> 'metadata' ->> 'sourceNutrientId'
          is distinct from nutrient_document ->> 'sourceNutrientId'
        or nutrient_document -> 'metadata' ->> 'sourceName'
          is distinct from mapped_source_name
        or nutrient_document -> 'metadata' ->> 'sourceUnit'
          is distinct from mapped_source_unit then
        raise exception 'catalogue nutrient document no longer matches the active reviewed mapping'
          using errcode = '55000';
      end if;

      insert into food_nutrient_value (
        amount, basis_quantity, basis_unit, confidence, derivation_code,
        food_version_id, metadata, nutrient_id, source_amount,
        source_basis_quantity, source_basis_unit, source_unit, unit, value_status
      ) values (
        (nutrient_document ->> 'amount')::numeric,
        (food_document ->> 'basisQuantity')::numeric,
        'g',
        null,
        case when pg_catalog.jsonb_typeof(nutrient_document -> 'derivationCode') = 'null'
          then null else nutrient_document ->> 'derivationCode' end,
        food_version_row.id,
        nutrient_document -> 'metadata',
        mapped_nutrient_id,
        case when pg_catalog.jsonb_typeof(nutrient_document -> 'sourceAmount') = 'null'
          then null else (nutrient_document ->> 'sourceAmount')::numeric end,
        case when pg_catalog.jsonb_typeof(nutrient_document -> 'sourceBasisQuantity') = 'null'
          then null else (nutrient_document ->> 'sourceBasisQuantity')::numeric end,
        case when pg_catalog.jsonb_typeof(nutrient_document -> 'sourceBasisUnit') = 'null'
          then null else nutrient_document ->> 'sourceBasisUnit' end,
        case when pg_catalog.jsonb_typeof(nutrient_document -> 'sourceUnit') = 'null'
          then null else nutrient_document ->> 'sourceUnit' end,
        mapped_canonical_unit,
        nutrient_document ->> 'valueStatus'
      );
    end loop;

    for serving_document in
      select serving.value
      from pg_catalog.jsonb_array_elements(food_document -> 'servings') as serving(value)
    loop
      if pg_catalog.jsonb_typeof(serving_document) <> 'object'
        or not serving_document ?& array[
          'displayOrder', 'gramWeight', 'isDefault', 'label', 'metadata',
          'quantity', 'sourceServingKey', 'unit', 'unitKind'
        ]
        or serving_document - array[
          'displayOrder', 'gramWeight', 'isDefault', 'label', 'metadata',
          'quantity', 'sourceServingKey', 'unit', 'unitKind'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(serving_document -> 'metadata') <> 'object' then
        raise exception 'catalogue serving materialization document has an unsupported shape'
          using errcode = '23514';
      end if;
      insert into food_serving (
        display_order, food_version_id, gram_weight, is_default, label,
        metadata, milliliter_volume, quantity, source_serving_key, unit, unit_kind
      ) values (
        (serving_document ->> 'displayOrder')::integer,
        food_version_row.id,
        (serving_document ->> 'gramWeight')::numeric,
        (serving_document ->> 'isDefault')::boolean,
        serving_document ->> 'label',
        serving_document -> 'metadata',
        null,
        (serving_document ->> 'quantity')::numeric,
        serving_document ->> 'sourceServingKey',
        serving_document ->> 'unit',
        serving_document ->> 'unitKind'
      );
    end loop;

    update food_import_record
    set
      food_version_id = food_version_row.id,
      materialized_at = pg_catalog.clock_timestamp(),
      validation_status = 'materialized'
    where id = record_row.id
      and validation_status = 'valid';
    get diagnostics affected_count = row_count;
    if affected_count <> 1 then
      raise exception 'catalogue record status changed during materialization'
        using errcode = '40001';
    end if;
    materialized_record_count := materialized_record_count + 1;
  end loop;
  if materialized_record_count <> workflow_batch.valid_count then
    raise exception 'catalogue materialized record count changed during promotion'
      using errcode = '40001';
  end if;

  if workflow_batch.evidence_valid_until <= pg_catalog.clock_timestamp() then
    raise exception 'catalogue evidence expired during promotion'
      using errcode = '23514';
  end if;
  if release_row.status = 'imported' then
    update food_source_release
    set promoted_at = pg_catalog.clock_timestamp(), status = 'promoted'
    where id = release_row.id
      and status = 'imported';
    get diagnostics affected_count = row_count;
    if affected_count <> 1 then
      raise exception 'catalogue release status changed during promotion'
        using errcode = '40001';
    end if;
  end if;

  previous_release_id := source_row.active_release_id;
  update food
  set current_version_id = null, archived_at = pg_catalog.clock_timestamp()
  where food_source_id = source_row.id;
  update food as target
  set current_version_id = version.id, archived_at = null
  from food_version as version
  where target.food_source_id = source_row.id
    and version.food_id = target.id
    and version.source_release_id = release_row.id;

  if exists (
    select 1
    from food_import_record as record
    cross join lateral (select record.validated_food_document::jsonb as document) as frozen
    join food_barcode as barcode
      on pg_catalog.lpad(barcode.gtin, 14, '0') = frozen.document ->> 'gtin'
     and barcode.market_code = frozen.document ->> 'marketCode'
     and barcode.valid_to is null
    join food as barcode_food
      on barcode_food.id = barcode.food_id
    where record.batch_id = workflow_batch.id
      and record.validation_status = 'materialized'
      and pg_catalog.jsonb_typeof(frozen.document -> 'gtin') <> 'null'
      and barcode_food.food_source_id is distinct from source_row.id
  ) then
    raise exception 'a catalogue barcode became unavailable after validation'
      using errcode = '23505';
  end if;
  update food_barcode as barcode
  set valid_to = pg_catalog.clock_timestamp()
  from food as source_food
  where source_food.id = barcode.food_id
    and source_food.food_source_id = source_row.id
    and barcode.valid_to is null;

  select pg_catalog.count(*) into expected_barcode_count
  from food_import_record as record
  cross join lateral (select record.validated_food_document::jsonb as document) as frozen
  where record.batch_id = workflow_batch.id
    and record.validation_status = 'materialized'
    and pg_catalog.jsonb_typeof(frozen.document -> 'gtin') <> 'null';
  insert into food_barcode (
    food_id, food_serving_id, food_version_id, gtin, market_code,
    metadata, source_release_id
  )
  select
    source_food.id,
    null,
    record.food_version_id,
    frozen.document ->> 'gtin',
    frozen.document ->> 'marketCode',
    pg_catalog.jsonb_build_object('activation', 'promotion'),
    release_row.id
  from food_import_record as record
  cross join lateral (select record.validated_food_document::jsonb as document) as frozen
  join food as source_food
    on source_food.food_source_id = source_row.id
   and source_food.source_food_key = frozen.document ->> 'sourceFoodKey'
  where record.batch_id = workflow_batch.id
    and record.validation_status = 'materialized'
    and pg_catalog.jsonb_typeof(frozen.document -> 'gtin') <> 'null';
  get diagnostics inserted_barcode_count = row_count;
  if inserted_barcode_count <> expected_barcode_count then
    raise exception 'catalogue barcode materialization count differs from frozen evidence'
      using errcode = '55000';
  end if;

  update food_source
  set active_release_id = release_row.id
  where id = source_row.id;

  insert into food_source_release_activation (
    food_source_id, import_batch_id, operation, performed_by,
    previous_release_id, reason, release_id,
    database_principal, database_capability_role
  ) values (
    source_row.id, workflow_batch.id, 'activate', p_external_principal_id,
    previous_release_id, p_reason, release_row.id,
    database_principal_name, database_capability
  ) returning id into strict activation_id;
  insert into outbox_event (
    aggregate_id, aggregate_type, attempt_count, available_at,
    deduplication_key, event_version, event_type, headers, last_error,
    locked_at, locked_by, payload, published_at
  ) values (
    source_row.id::text,
    'food_source',
    0,
    pg_catalog.clock_timestamp(),
    'catalogue-activation:' || activation_id::text,
    1,
    'catalogue.source_release_activated',
    '{}'::jsonb,
    null,
    null,
    null,
    pg_catalog.jsonb_build_object(
      'activationId', activation_id::text,
      'previousReleaseId', previous_release_id,
      'releaseId', release_row.id,
      'sourceId', source_row.id::text
    ),
    null
  );

  update food_import_batch
  set
    completed_at = pg_catalog.clock_timestamp(),
    materialized_count = materialized_record_count,
    status = 'completed'
  where id = workflow_batch.id
    and status = 'promoting';
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception 'catalogue batch status changed before completion'
      using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'activatedReleaseId', release_row.id,
    'materializedCount', materialized_record_count,
    'previousReleaseId', previous_release_id,
    'wasAlreadyCompleted', false
  );
end;
$$;

create function catalogue_rollback_source_release(
  p_source_code text,
  p_target_release_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  activation_id bigint;
  active_release_id uuid;
  catalogue_capabilities text[];
  database_capability text;
  database_principal_name text;
  previous_release_id uuid;
  source_row food_source%rowtype;
  table_owner text;
  target_release food_source_release%rowtype;
begin
  if p_source_code is null or pg_catalog.length(pg_catalog.btrim(p_source_code)) = 0 then
    raise exception 'source code is required'
      using errcode = '22023';
  end if;
  if p_external_principal_id is null
    or p_external_principal_id <> pg_catalog.btrim(p_external_principal_id)
    or p_external_principal_id <> pg_catalog.lower(p_external_principal_id)
    or p_external_principal_id !~ '^[a-z][-a-z0-9._:@/]{2,255}$' then
    raise exception 'external principal id is invalid'
      using errcode = '22023';
  end if;
  if p_reason is null
    or pg_catalog.length(pg_catalog.btrim(p_reason)) = 0
    or pg_catalog.octet_length(p_reason) > 2048 then
    raise exception 'rollback reason is required and must contain at most 2048 bytes'
      using errcode = '22023';
  end if;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_source_release_activation'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue rollback function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text = table_owner then
    database_capability := null;
    database_principal_name := null;
  else
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into catalogue_capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage',
      'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights',
      'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(catalogue_capabilities), 0) <> 1
      or catalogue_capabilities[1] <> 'nutrition_catalogue_rollback' then
      raise exception 'database principal must hold exactly the catalogue rollback capability'
        using errcode = '42501';
    end if;
    database_capability := 'nutrition_catalogue_rollback';
    database_principal_name := session_user::text;
  end if;

  select * into source_row
  from food_source
  where code = p_source_code
  for update;
  if not found then
    raise exception 'catalogue rollback references an unknown source'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );

  if p_target_release_id is not null then
    if not source_row.active
      or source_row.commercial_use_allowed is distinct from true
      or source_row.rights_review_status not in ('approved', 'restricted')
      or source_row.rights_reviewed_at is null
      or source_row.rights_reviewed_by is null then
      raise exception 'catalogue source is not eligible for activation'
        using errcode = '23514';
    end if;
    select * into target_release
    from food_source_release
    where id = p_target_release_id
      and food_source_id = source_row.id;
    if not found then
      raise exception 'target release does not belong to the catalogue source'
        using errcode = '23503';
    end if;
    if target_release.status <> 'promoted'
      or target_release.release_class <> 'live-reviewed' then
      raise exception 'rollback target must be a previously promoted live-reviewed release'
        using errcode = '23514';
    end if;
  end if;

  previous_release_id := source_row.active_release_id;
  if previous_release_id is not distinct from p_target_release_id then
    return pg_catalog.jsonb_build_object(
      'activeReleaseId', p_target_release_id,
      'changed', false,
      'previousReleaseId', previous_release_id
    );
  end if;

  if p_target_release_id is not null and exists (
    select 1
    from food_barcode as desired
    join food as desired_food on desired_food.id = desired.food_id
    join food_barcode as active
      on pg_catalog.lpad(active.gtin, 14, '0') = pg_catalog.lpad(desired.gtin, 14, '0')
     and active.market_code = desired.market_code
     and active.valid_to is null
    join food as active_food on active_food.id = active.food_id
    where desired_food.food_source_id = source_row.id
      and desired.source_release_id = p_target_release_id
      and active_food.food_source_id is distinct from source_row.id
  ) then
    raise exception 'a target-release barcode is active for another catalogue source'
      using errcode = '23505';
  end if;

  update food
  set current_version_id = null, archived_at = pg_catalog.clock_timestamp()
  where food_source_id = source_row.id;
  if p_target_release_id is not null then
    update food as target
    set current_version_id = version.id, archived_at = null
    from food_version as version
    where target.food_source_id = source_row.id
      and version.food_id = target.id
      and version.source_release_id = p_target_release_id;
  end if;

  update food_barcode as barcode
  set valid_to = pg_catalog.clock_timestamp()
  from food as source_food
  where source_food.id = barcode.food_id
    and source_food.food_source_id = source_row.id
    and barcode.valid_to is null;
  if p_target_release_id is not null then
    insert into food_barcode (
      gtin, market_code, food_id, food_version_id, food_serving_id,
      source_release_id, valid_from, metadata
    )
    select distinct on (
      pg_catalog.lpad(barcode.gtin, 14, '0'), barcode.market_code
    )
      pg_catalog.lpad(barcode.gtin, 14, '0'),
      barcode.market_code,
      barcode.food_id,
      barcode.food_version_id,
      barcode.food_serving_id,
      barcode.source_release_id,
      pg_catalog.clock_timestamp(),
      pg_catalog.jsonb_build_object(
        'activation', 'rollback',
        'priorBarcodeId', barcode.id
      )
    from food_barcode as barcode
    join food as source_food on source_food.id = barcode.food_id
    where source_food.food_source_id = source_row.id
      and barcode.source_release_id = p_target_release_id
    order by
      pg_catalog.lpad(barcode.gtin, 14, '0'),
      barcode.market_code,
      barcode.created_at desc,
      barcode.id desc;
  end if;

  update food_source
  set active_release_id = p_target_release_id
  where id = source_row.id;
  active_release_id := p_target_release_id;

  insert into food_source_release_activation (
    food_source_id, import_batch_id, operation, performed_by,
    previous_release_id, reason, release_id,
    database_principal, database_capability_role
  ) values (
    source_row.id,
    null,
    case when p_target_release_id is null then 'deactivate' else 'rollback' end,
    p_external_principal_id,
    previous_release_id,
    p_reason,
    p_target_release_id,
    database_principal_name,
    database_capability
  ) returning id into strict activation_id;
  insert into outbox_event (
    aggregate_id, aggregate_type, attempt_count, available_at,
    deduplication_key, event_version, event_type, headers, last_error,
    locked_at, locked_by, payload, published_at
  ) values (
    source_row.id::text,
    'food_source',
    0,
    pg_catalog.clock_timestamp(),
    'catalogue-activation:' || activation_id::text,
    1,
    'catalogue.source_release_activated',
    '{}'::jsonb,
    null,
    null,
    null,
    pg_catalog.jsonb_build_object(
      'activationId', activation_id::text,
      'previousReleaseId', previous_release_id,
      'releaseId', p_target_release_id,
      'sourceId', source_row.id::text
    ),
    null
  );

  return pg_catalog.jsonb_build_object(
    'activeReleaseId', active_release_id,
    'changed', true,
    'previousReleaseId', previous_release_id
  );
end;
$$;

do $migration$
declare
  capability_role text;
  capability_role_oid oid;
  target_schema name := pg_catalog.current_schema();
  table_owner name;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)::name
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;

  foreach capability_role in array array[
    'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ] loop
    select role_row.oid into capability_role_oid
    from pg_catalog.pg_roles as role_row
    where role_row.rolname = capability_role;
    if capability_role_oid is null or exists (
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
      where membership.roleid = capability_role_oid
         or membership.member = capability_role_oid
    ) then
      raise exception 'catalogue capability role % is absent, unsafe, or already assigned', capability_role
        using errcode = '55000';
    end if;
  end loop;

  execute pg_catalog.format(
    'alter function %I.validate_food_version_child_insert() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_custom_food_child_insert_v3() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_food_barcode_validity_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_imported_food_version_child_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_source_barcode_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_custom_food_immutable_evidence_v3() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.set_row_updated_at() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_food_import_record_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_food_import_batch_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_food_import_batch_validation_digest() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_food_source_release_activation_authority() set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_promote_import_batch(uuid,text,text) set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_rollback_source_release(text,uuid,text,text) set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );

  execute pg_catalog.format(
    'alter function %I.guard_food_source_release_activation_authority() owner to %I',
    target_schema, table_owner
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_promote_import_batch(uuid,text,text) owner to %I',
    target_schema, table_owner
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_rollback_source_release(text,uuid,text,text) owner to %I',
    target_schema, table_owner
  );

  execute pg_catalog.format(
    'revoke all on function %I.guard_food_source_release_activation_authority() from public',
    target_schema
  );
  execute pg_catalog.format(
    'revoke all on function %I.catalogue_promote_import_batch(uuid,text,text) from public',
    target_schema
  );
  execute pg_catalog.format(
    'revoke all on function %I.catalogue_rollback_source_release(text,uuid,text,text) from public',
    target_schema
  );
  execute pg_catalog.format(
    'grant execute on function %I.catalogue_promote_import_batch(uuid,text,text) to nutrition_catalogue_promote_activate',
    target_schema
  );
  execute pg_catalog.format(
    'grant execute on function %I.catalogue_rollback_source_release(text,uuid,text,text) to nutrition_catalogue_rollback',
    target_schema
  );
  execute pg_catalog.format(
    'grant usage on schema %I to nutrition_catalogue_promote_activate, nutrition_catalogue_rollback',
    target_schema
  );
end;
$migration$;

do $migration$
declare
  promote_role oid;
  rollback_role oid;
  target_schema name := pg_catalog.current_schema();
  target_schema_oid oid;
  table_owner oid;
begin
  select namespace_row.oid, class_row.relowner
  into target_schema_oid, table_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');

  select role_row.oid into promote_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_promote_activate';
  select role_row.oid into rollback_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_rollback';

  if table_owner is null
    or promote_role is null
    or rollback_role is null
    or target_schema_oid is null then
    raise exception 'catalogue promotion authority postflight identities are absent'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'catalogue_promote_import_batch',
        'catalogue_rollback_source_release',
        'guard_custom_food_child_insert_v3',
        'guard_custom_food_immutable_evidence_v3',
        'guard_food_barcode_validity_update',
        'guard_food_import_batch_update',
        'guard_food_import_batch_validation_digest',
        'guard_food_import_record_update',
        'guard_food_source_release_activation_authority',
        'guard_imported_food_version_child_delete',
        'guard_source_barcode_delete',
        'set_row_updated_at',
        'validate_food_version_child_insert'
      )
  ) <> 13 or exists (
    select 1
    from (
      values
        (
          'catalogue_promote_import_batch'::text,
          'p_batch_id uuid, p_external_principal_id text, p_reason text'::text,
          '115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17'::text,
          'jsonb'::text,
          true,
          'promote'::text
        ),
        (
          'catalogue_rollback_source_release',
          'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text',
          '3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1',
          'jsonb',
          true,
          'rollback'
        ),
        (
          'guard_custom_food_child_insert_v3',
          '',
          'f2fc5d7cc06759696b2656f921d57502326ab4efbd6fe1b1554143b117152d88',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_custom_food_immutable_evidence_v3',
          '',
          '5e450518bc31811221ad64826f6879b177ecec760d88abd0353b14c4aebe3317',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_food_barcode_validity_update',
          '',
          '7b97f95dd7388565424bd3713081711106a5e3d0c206310a8d405b8772208ecc',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_food_import_batch_update',
          '',
          '8863eef0e6889a620deec204e249ac3d6efdc87310dcc9d25601e6d7f336101f',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_food_import_batch_validation_digest',
          '',
          'c94c16cef462dfaca5c58908c2784e6d86b9f415c1c081f7b6c8a5ca434bddd7',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_food_import_record_update',
          '',
          '300e6853e7a9520b477256b3b32a4381f3143512b013a4e131a4c203ce524479',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_food_source_release_activation_authority',
          '',
          'd46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028',
          'trigger',
          false,
          'owner'
        ),
        (
          'guard_imported_food_version_child_delete',
          '',
          '4e36d3ee5cbd53dc6c98d9f457adbb5ee8cb6cbf8fc6b3e45d3133b4305e7cc1',
          'trigger',
          false,
          'default'
        ),
        (
          'guard_source_barcode_delete',
          '',
          'd4bea8e773166f82f291f1d89b20a7cfb52e2d8416ba80bb455642058d23e3cf',
          'trigger',
          false,
          'default'
        ),
        (
          'set_row_updated_at',
          '',
          '92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd',
          'trigger',
          false,
          'default'
        ),
        (
          'validate_food_version_child_insert',
          '',
          '5362678168ed713e602e0fd87bc8b13dccd7817db1cf3d3470f09dcbe37e5f07',
          'trigger',
          false,
          'default'
        )
    ) as expected(
      function_name,
      identity_arguments,
      source_sha256,
      result_type,
      security_definer,
      acl_kind
    )
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.pronamespace = namespace_row.oid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) =
        expected.identity_arguments
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or procedure_row.proowner <> table_owner
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> expected.result_type
      or language_row.lanname <> 'plpgsql'
      or procedure_row.prokind <> 'f'
      or procedure_row.provolatile <> 'v'
      or procedure_row.proisstrict
      or procedure_row.proleakproof
      or procedure_row.proparallel <> 'u'
      or procedure_row.proretset
      or procedure_row.pronargdefaults <> 0
      or procedure_row.prosecdef <> expected.security_definer
      or procedure_row.proconfig is distinct from array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]
      or (expected.acl_kind = 'default' and procedure_row.proacl is not null)
      or (
        expected.acl_kind <> 'default'
        and (
          (
            select pg_catalog.count(*)
            from pg_catalog.aclexplode(procedure_row.proacl) as function_acl
          ) <> case when expected.acl_kind = 'owner' then 1 else 2 end
          or exists (
            select 1
            from pg_catalog.aclexplode(procedure_row.proacl) as function_acl
            where function_acl.grantor <> table_owner
              or function_acl.privilege_type <> 'EXECUTE'
              or function_acl.is_grantable
              or not (
                function_acl.grantee = table_owner
                or (
                  expected.acl_kind = 'promote'
                  and function_acl.grantee = promote_role
                )
                or (
                  expected.acl_kind = 'rollback'
                  and function_acl.grantee = rollback_role
                )
              )
          )
        )
      )
  ) then
    raise exception 'catalogue promotion authority function postflight attestation failed'
      using errcode = '55000';
  end if;

  if not pg_catalog.has_schema_privilege(promote_role, target_schema_oid, 'USAGE')
    or not pg_catalog.has_schema_privilege(rollback_role, target_schema_oid, 'USAGE') then
    raise exception 'catalogue capability schema usage postflight attestation failed'
      using errcode = '55000';
  end if;

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
          and trigger_row.tgname in (
            'food_import_record_guard_update',
            'food_source_release_activation_guard_authority'
          )
        )
        or (
          procedure_namespace_row.nspname = target_schema
          and procedure_row.proname in (
            'guard_food_import_record_update',
            'guard_food_source_release_activation_authority'
          )
          and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
        )
      )
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'food_import_record_guard_update'::text,
          'food_import_record'::text,
          'guard_food_import_record_update'::text,
          'CREATE TRIGGER food_import_record_guard_update BEFORE INSERT OR UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()'::text
        ),
        (
          'food_source_release_activation_guard_authority',
          'food_source_release_activation',
          'guard_food_source_release_activation_authority',
          'CREATE TRIGGER food_source_release_activation_guard_authority BEFORE INSERT ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_activation_authority()'
        )
    ) as expected(trigger_name, table_name, function_name, trigger_definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
      and class_row.relkind in ('r', 'p')
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    left join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
    where trigger_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or procedure_namespace_row.nspname <> target_schema
      or procedure_row.proname <> expected.function_name
      or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) <> ''
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.trigger_definition
  ) then
    raise exception 'catalogue promotion authority trigger postflight attestation failed'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
        pg_catalog.to_regclass(pg_catalog.format('%I.food_source_release_activation', target_schema))
      and constraint_row.conname =
        'food_source_release_activation_database_authority_check'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
          'UTF8'
        )),
        'hex'
      ) = '1d4b38bbafde924301d075d8534c238fd1aea517305f880348d33e3b24691bb8'
  ) <> 1 then
    raise exception 'catalogue activation authority constraint postflight attestation failed'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_index as index_row
    join pg_catalog.pg_class as index_class
      on index_class.oid = index_row.indexrelid
    join pg_catalog.pg_namespace as index_namespace
      on index_namespace.oid = index_class.relnamespace
    join pg_catalog.pg_am as access_method
      on access_method.oid = index_class.relam
    where index_namespace.nspname = target_schema
      and index_class.relname =
        'food_source_release_activation_import_batch_unique'
      and index_class.relowner = table_owner
      and index_row.indrelid =
        pg_catalog.to_regclass(pg_catalog.format('%I.food_source_release_activation', target_schema))
      and index_row.indisunique
      and not index_row.indisprimary
      and index_row.indisvalid
      and index_row.indisready
      and index_row.indnatts = 1
      and index_row.indnkeyatts = 1
      and access_method.amname = 'btree'
      and pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) =
        'import_batch_id'
      and pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid,
        true
      ) = 'import_batch_id IS NOT NULL'
  ) <> 1 then
    raise exception 'catalogue activation import-batch index postflight attestation failed'
      using errcode = '55000';
  end if;
end;
$migration$;

comment on column food_import_record.validated_food_document is
  'Canonical UTF-8 ValidatedCatalogueFood bytes frozen in the same transition as validation.';
comment on column food_import_record.validated_food_sha256 is
  'SHA-256 of validated_food_document; included in the immutable batch validation digest.';
comment on column food_import_record.validated_food_contract_version is
  'Exact materialization-document contract. Version 1 is required for new valid records.';
comment on column food_import_batch.validated_food_contract_version is
  'Frozen validated-food contract version shared by every record in this validation attempt.';
comment on column food_import_batch.nutrient_mapping_digest is
  'Frozen digest of the exact reviewed nutrient registry used during validation.';
comment on column food_import_batch.nutrient_mapping_revision_ids is
  'Frozen sorted active mapping-revision set used for database-side promotion revalidation.';
comment on function catalogue_promote_import_batch(uuid,text,text) is
  'Identifier-only atomic public-catalogue materialization and activation; accepts no food JSON.';
comment on function catalogue_rollback_source_release(text,uuid,text,text) is
  'Identifier-only atomic source-scoped catalogue rollback or deactivation.';
