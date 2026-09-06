-- Narrow catalogue staging and validation to database-authenticated, fixed-purpose
-- functions. This remains an EXPAND migration: capability roles stay NOLOGIN and
-- unassigned, while the schema owner retains a paired-NULL local compatibility
-- path. Recovery is forward-only through a new reviewed migration or a restored
-- pre-migration backup.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-stage-validate-authority:v1')
);

do $migration$
declare
  capability_role text;
  capability_role_oid oid;
  target_schema name := current_schema();
  workflow_owner oid;
begin
  if target_schema is null then
    raise exception 'catalogue stage/validate authority requires a current schema'
      using errcode = '55000';
  end if;

  select class_row.relowner
  into workflow_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');

  if workflow_owner is null or workflow_owner is distinct from (select relowner from pg_catalog.pg_class
    where oid = pg_catalog.to_regclass(pg_catalog.format('%I.food_import_record', target_schema))) then
    raise exception 'catalogue stage/validate workflow tables are absent or have different owners'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from (
      values
        (
          'food_import_parser_report_reject_update'::text,
          'food_import_parser_report'::text,
          'reject_immutable_row_update'::text,
          'CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'::text
        ),
        (
          'food_import_checkpoint_set_updated_at',
          'food_import_checkpoint',
          'set_row_updated_at',
          'CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'
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
    where trigger_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or procedure_row.pronamespace <> namespace_row.oid
      or procedure_row.proname <> expected.function_name
      or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) <> ''
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.trigger_definition
  ) then
    raise exception 'catalogue stage/validate prerequisite trigger binding differs'
      using errcode = '55000';
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
end;
$migration$;

alter table food_import_batch
  add column staged_database_principal text,
  add column staged_database_capability_role text,
  add column staging_seal_sha256 text,
  add column staging_sealed_at timestamptz,
  add column validated_database_principal text,
  add column validated_database_capability_role text,
  add constraint food_import_batch_stage_validate_database_authority_check check (
    (
      (
        staged_database_principal is null
        and staged_database_capability_role is null
        and validated_database_principal is null
        and validated_database_capability_role is null
      )
      or (
        staged_database_principal is not null
        and pg_catalog.octet_length(staged_database_principal) between 1 and 63
        and staged_database_capability_role = 'nutrition_catalogue_stage'
        and (
          (
            validated_at is null
            and validated_database_principal is null
            and validated_database_capability_role is null
          )
          or (
            validated_at is not null
            and validated_database_principal is not null
            and pg_catalog.octet_length(validated_database_principal) between 1 and 63
            and validated_database_capability_role = 'nutrition_catalogue_validate'
            and validated_database_principal <> staged_database_principal
          )
        )
      )
    ) is true
  ),
  add constraint food_import_batch_staging_seal_check check (
    (
      (staging_seal_sha256 is null and staging_sealed_at is null)
      or (
        staging_seal_sha256 ~ '^[0-9a-f]{64}$'
        and staging_sealed_at is not null
        and staging_sealed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      )
    ) is true
    and (
      validated_at is null
      or staged_database_principal is null
      or staging_seal_sha256 is not null
    )
  );

create function guard_food_import_batch_stage_validate_authority()
returns trigger
language plpgsql
as $$
declare
  capabilities text[];
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;

  if tg_op = 'INSERT' then
    if new.staging_seal_sha256 is not null or new.staging_sealed_at is not null then
      raise exception 'new catalogue batches cannot carry a precomputed staging seal'
        using errcode = '55000';
    end if;
    if session_user::text = table_owner then
      if row(
        new.staged_database_principal,
        new.staged_database_capability_role,
        new.validated_database_principal,
        new.validated_database_capability_role
      ) is distinct from row(null, null, null, null) then
        raise exception 'schema-owner staging cannot claim database capability audit evidence'
          using errcode = '42501';
      end if;
    else
      select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
      into capabilities
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
      if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
        or capabilities[1] <> 'nutrition_catalogue_stage'
        or new.staged_database_principal is distinct from session_user::text
        or new.staged_database_capability_role is distinct from 'nutrition_catalogue_stage'
        or new.validated_database_principal is not null
        or new.validated_database_capability_role is not null then
        raise exception 'new catalogue batch authority does not match the authenticated stage capability'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if row(new.staged_database_principal, new.staged_database_capability_role)
    is distinct from row(old.staged_database_principal, old.staged_database_capability_role) then
    raise exception 'catalogue stage database authority cannot be rewritten'
      using errcode = '55000';
  end if;

  if row(new.staging_seal_sha256, new.staging_sealed_at)
    is distinct from row(old.staging_seal_sha256, old.staging_sealed_at) then
    if old.staging_seal_sha256 is not null
      or old.staging_sealed_at is not null
      or new.staging_seal_sha256 is null
      or new.staging_sealed_at is null then
      raise exception 'catalogue staging seal can only be recorded once'
        using errcode = '55000';
    end if;
    if session_user::text = table_owner then
      if new.staged_database_principal is not null
        or new.staged_database_capability_role is not null then
        raise exception 'schema-owner staging cannot seal a capability-authenticated batch'
          using errcode = '42501';
      end if;
    else
      select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
      into capabilities
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
      if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
        or capabilities[1] <> 'nutrition_catalogue_stage'
        or new.staged_database_principal is distinct from session_user::text
        or new.staged_database_capability_role is distinct from 'nutrition_catalogue_stage' then
        raise exception 'catalogue staging seal does not match the authenticated stage capability'
          using errcode = '42501';
      end if;
    end if;
  end if;

  if row(new.validated_database_principal, new.validated_database_capability_role)
    is distinct from row(old.validated_database_principal, old.validated_database_capability_role) then
    if old.validated_database_principal is not null
      or old.validated_database_capability_role is not null
      or old.validated_at is not null
      or new.validated_at is null
      or session_user::text = table_owner then
      raise exception 'catalogue validation database authority cannot be forged or rewritten'
        using errcode = '42501';
    end if;
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
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
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate'
      or new.validated_database_principal is distinct from session_user::text
      or new.validated_database_capability_role is distinct from 'nutrition_catalogue_validate'
      or new.validated_database_principal = new.staged_database_principal then
      raise exception 'catalogue validation authority does not match a distinct authenticated validator'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create function catalogue_stage_import_record_chunk(
  p_batch_id uuid,
  p_expected_next_offset bigint,
  p_records_document text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  batch_row food_import_batch%rowtype;
  canonical_document text;
  canonical_payload_value jsonb;
  canonical_sha256 text;
  capabilities text[];
  checkpoint_row food_import_checkpoint%rowtype;
  created_id bigint;
  end_offset bigint;
  existing_record food_import_record%rowtype;
  expected_previous_sequence bigint;
  inserted_count bigint := 0;
  record_count bigint;
  record_entry jsonb;
  record_ordinal bigint;
  records_document jsonb;
  replayed_count bigint := 0;
  replay_mode boolean := false;
  sequence_value bigint;
  table_owner text;
  total_canonical_payload_bytes bigint;
  total_record_count bigint;
begin
  if p_expected_next_offset is null or p_expected_next_offset < 0 then
    raise exception 'catalogue stage chunk offset must be a non-negative integer'
      using errcode = '22023';
  end if;
  if p_records_document is null
    or pg_catalog.octet_length(p_records_document) = 0
    or pg_catalog.octet_length(p_records_document) > 16777216 then
    raise exception 'catalogue stage chunk must contain between 1 and 16777216 UTF-8 bytes'
      using errcode = '22023';
  end if;
  begin
    records_document := p_records_document::jsonb;
  exception when others then
    raise exception 'catalogue stage chunk must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(records_document) <> 'object'
    or records_document -> 'schemaVersion' <> '1'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(records_document)) <> 2
    or records_document - array['schemaVersion', 'records'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(records_document -> 'records') <> 'array' then
    raise exception 'catalogue stage chunk contract differs from version 1'
      using errcode = '22023';
  end if;
  record_count := pg_catalog.jsonb_array_length(records_document -> 'records');
  if record_count not between 1 and 250 then
    raise exception 'catalogue stage chunk must contain between 1 and 250 records'
      using errcode = '22023';
  end if;
  if p_expected_next_offset > 9223372036854775807 - record_count then
    raise exception 'catalogue stage chunk offset overflows bigint'
      using errcode = '22003';
  end if;
  end_offset := p_expected_next_offset + record_count;
  if end_offset > 10000 then
    raise exception 'catalogue staging batches cannot exceed 10000 records'
      using errcode = '54000';
  end if;
  expected_previous_sequence := case
    when p_expected_next_offset = 0 then null
    else p_expected_next_offset - 1
  end;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue stage chunk function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text <> table_owner then
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage' then
      raise exception 'database principal must hold exactly the catalogue stage capability'
        using errcode = '42501';
    end if;
  end if;

  select * into batch_row
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue stage chunk references an unknown batch'
      using errcode = '23503';
  end if;
  if batch_row.status <> 'staging' or batch_row.staging_seal_sha256 is not null then
    raise exception 'catalogue batch cannot accept a record chunk after staging is sealed'
      using errcode = '23514';
  end if;
  if session_user::text = table_owner then
    if batch_row.staged_database_principal is not null
      or batch_row.staged_database_capability_role is not null then
      raise exception 'schema owner cannot append to a capability-authenticated staging attempt'
        using errcode = '42501';
    end if;
  elsif batch_row.staged_database_principal is distinct from session_user::text
    or batch_row.staged_database_capability_role is distinct from 'nutrition_catalogue_stage' then
    raise exception 'catalogue staging attempt belongs to a different database principal'
      using errcode = '42501';
  end if;

  select * into checkpoint_row
  from food_import_checkpoint
  where batch_id = p_batch_id and stage = 'stage'
  for update;
  if found then
    if checkpoint_row.processed_count = end_offset
      and checkpoint_row.last_sequence_number = end_offset - 1
      and checkpoint_row.cursor_data = pg_catalog.jsonb_build_object('nextOffset', end_offset) then
      replay_mode := true;
    elsif checkpoint_row.processed_count <> p_expected_next_offset
      or checkpoint_row.last_sequence_number is distinct from expected_previous_sequence
      or checkpoint_row.cursor_data <> pg_catalog.jsonb_build_object(
        'nextOffset', p_expected_next_offset
      ) then
      raise exception 'catalogue stage chunk does not continue the exact durable checkpoint'
        using errcode = '55000';
    end if;
  elsif p_expected_next_offset <> 0 then
    raise exception 'catalogue stage chunk cannot skip the initial checkpoint'
      using errcode = '55000';
  end if;

  for record_entry, record_ordinal in
    select element.value, element.ordinality
    from pg_catalog.jsonb_array_elements(records_document -> 'records')
      with ordinality as element(value, ordinality)
  loop
    if pg_catalog.jsonb_typeof(record_entry) <> 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(record_entry)) <> 6
      or record_entry - array[
        'sourceRecordKey', 'sourceRecordType', 'sequenceNumber',
        'sourcePayloadSha256', 'canonicalPayloadSha256', 'canonicalPayloadDocument'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(record_entry -> 'sourceRecordKey') <> 'string'
      or pg_catalog.jsonb_typeof(record_entry -> 'sourceRecordType') <> 'string'
      or pg_catalog.jsonb_typeof(record_entry -> 'sourcePayloadSha256') <> 'string'
      or pg_catalog.jsonb_typeof(record_entry -> 'canonicalPayloadSha256') <> 'string'
      or pg_catalog.jsonb_typeof(record_entry -> 'canonicalPayloadDocument') <> 'string'
      or pg_catalog.jsonb_typeof(record_entry -> 'sequenceNumber') not in ('number', 'string') then
      raise exception 'catalogue staged record contract differs from version 1'
        using errcode = '22023';
    end if;
    if pg_catalog.octet_length(record_entry ->> 'sourceRecordKey') not between 1 and 1024
      or pg_catalog.octet_length(record_entry ->> 'sourceRecordType') not between 1 and 256
      or record_entry ->> 'sourcePayloadSha256' !~ '^[0-9a-f]{64}$'
      or record_entry ->> 'canonicalPayloadSha256' !~ '^[0-9a-f]{64}$'
      or record_entry ->> 'sequenceNumber' !~ '^(0|[1-9][0-9]{0,18})$' then
      raise exception 'catalogue staged record contains an invalid or unbounded field'
        using errcode = '22023';
    end if;
    begin
      sequence_value := (record_entry ->> 'sequenceNumber')::bigint;
    exception when others then
      raise exception 'catalogue staged record sequence is outside bigint range'
        using errcode = '22003';
    end;
    if sequence_value <> p_expected_next_offset + record_ordinal - 1 then
      raise exception 'catalogue staged record sequences must be contiguous from the checkpoint'
        using errcode = '23514';
    end if;
    canonical_document := record_entry ->> 'canonicalPayloadDocument';
    if pg_catalog.octet_length(canonical_document) not between 1 and 1048576 then
      raise exception 'canonical staged record must contain between 1 and 1048576 UTF-8 bytes'
        using errcode = '22023';
    end if;
    canonical_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(canonical_document, 'UTF8')),
      'hex'
    );
    if canonical_sha256 <> record_entry ->> 'canonicalPayloadSha256' then
      raise exception 'canonical staged record digest differs for %', record_entry ->> 'sourceRecordKey'
        using errcode = '22023';
    end if;
    begin
      canonical_payload_value := canonical_document::jsonb;
    exception when others then
      raise exception 'canonical staged record document must be valid JSON'
        using errcode = '22023';
    end;
  end loop;

  for record_entry in
    select value from pg_catalog.jsonb_array_elements(records_document -> 'records')
  loop
    canonical_document := record_entry ->> 'canonicalPayloadDocument';
    canonical_payload_value := canonical_document::jsonb;
    sequence_value := (record_entry ->> 'sequenceNumber')::bigint;
    created_id := null;
    insert into food_import_record (
      batch_id, source_record_key, source_record_type, sequence_number,
      source_payload_sha256, canonical_payload_sha256, canonical_payload
    ) values (
      p_batch_id, record_entry ->> 'sourceRecordKey', record_entry ->> 'sourceRecordType',
      sequence_value, record_entry ->> 'sourcePayloadSha256',
      record_entry ->> 'canonicalPayloadSha256', canonical_payload_value
    )
    on conflict (batch_id, source_record_key) do nothing
    returning id into created_id;
    if created_id is not null then
      inserted_count := inserted_count + 1;
    else
      select * into existing_record
      from food_import_record
      where batch_id = p_batch_id
        and source_record_key = record_entry ->> 'sourceRecordKey';
      if not found or row(
        existing_record.source_record_type,
        existing_record.sequence_number,
        existing_record.source_payload_sha256,
        existing_record.canonical_payload_sha256,
        existing_record.canonical_payload
      ) is distinct from row(
        record_entry ->> 'sourceRecordType',
        sequence_value,
        record_entry ->> 'sourcePayloadSha256',
        record_entry ->> 'canonicalPayloadSha256',
        canonical_payload_value
      ) then
        raise exception 'catalogue staged record replay differs for %', record_entry ->> 'sourceRecordKey'
          using errcode = '55000';
      end if;
      replayed_count := replayed_count + 1;
    end if;
  end loop;

  select
    pg_catalog.count(*),
    coalesce(pg_catalog.sum(pg_catalog.octet_length(import_record.canonical_payload::text)), 0)
  into total_record_count, total_canonical_payload_bytes
  from food_import_record as import_record
  where import_record.batch_id = p_batch_id;
  if total_record_count <> end_offset then
    raise exception 'catalogue staged record count does not equal the durable contiguous offset'
      using errcode = '23514';
  end if;
  if total_record_count > 10000 or total_canonical_payload_bytes > 67108864 then
    raise exception 'catalogue staging batch exceeds the 10000-record or 64-MiB canonical-payload limit'
      using errcode = '54000';
  end if;

  if not replay_mode then
    insert into food_import_checkpoint (
      batch_id, stage, cursor_data, last_sequence_number, processed_count
    ) values (
      p_batch_id, 'stage', pg_catalog.jsonb_build_object('nextOffset', end_offset),
      end_offset - 1, end_offset
    )
    on conflict (batch_id, stage) do update set
      cursor_data = excluded.cursor_data,
      last_sequence_number = excluded.last_sequence_number,
      processed_count = excluded.processed_count;
    update food_import_batch
    set staged_count = total_record_count
    where id = p_batch_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'inserted', inserted_count,
    'nextOffset', end_offset,
    'replayed', replayed_count,
    'stagedCount', total_record_count,
    'wasAlreadyStaged', replay_mode
  );
end;
$$;

create trigger food_import_batch_guard_stage_validate_authority
before insert or update on food_import_batch
for each row execute function guard_food_import_batch_stage_validate_authority();

create function guard_food_import_record_insert_before_staging_seal()
returns trigger
language plpgsql
as $$
declare
  sealed_at_value timestamptz;
  sealed_digest text;
begin
  select batch.staging_seal_sha256, batch.staging_sealed_at
  into sealed_digest, sealed_at_value
  from food_import_batch as batch
  where batch.id = new.batch_id
  for update;
  if not found then
    raise exception 'catalogue record references an unknown batch'
      using errcode = '23503';
  end if;
  if sealed_digest is not null or sealed_at_value is not null then
    raise exception 'catalogue records cannot be appended after the staging seal'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger food_import_record_guard_staging_seal
before insert on food_import_record
for each row execute function guard_food_import_record_insert_before_staging_seal();

create function guard_food_import_stage_checkpoint_before_staging_seal()
returns trigger
language plpgsql
as $$
declare
  checkpoint_batch_id uuid;
  sealed_at_value timestamptz;
  sealed_digest text;
begin
  if tg_op = 'INSERT' then
    if new.stage <> 'stage' then
      return new;
    end if;
    checkpoint_batch_id := new.batch_id;
  elsif tg_op = 'DELETE' then
    if old.stage <> 'stage' then
      return old;
    end if;
    checkpoint_batch_id := old.batch_id;
  else
    if old.stage <> 'stage' and new.stage <> 'stage' then
      return new;
    end if;
    if row(new.batch_id, new.stage) is distinct from row(old.batch_id, old.stage) then
      raise exception 'catalogue stage checkpoint identity cannot be rewritten'
        using errcode = '55000';
    end if;
    checkpoint_batch_id := new.batch_id;
  end if;

  select batch.staging_seal_sha256, batch.staging_sealed_at
  into sealed_digest, sealed_at_value
  from food_import_batch as batch
  where batch.id = checkpoint_batch_id
  for update;
  if not found then
    raise exception 'catalogue stage checkpoint references an unknown batch'
      using errcode = '23503';
  end if;
  if sealed_digest is not null or sealed_at_value is not null then
    raise exception 'catalogue stage checkpoint cannot change after the staging seal'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger food_import_checkpoint_guard_staging_seal
before insert or update or delete on food_import_checkpoint
for each row execute function guard_food_import_stage_checkpoint_before_staging_seal();

create function catalogue_stage_import_batch(p_stage_document text)
returns jsonb
language plpgsql
security definer
as $$
declare
  acquired_at_value timestamptz;
  artifact_bytes_value bigint;
  attempt food_import_batch%rowtype;
  capabilities text[];
  document jsonb;
  evidence_valid_until_value timestamptz;
  published_on_value date;
  source_row food_source%rowtype;
  source_id_value bigint;
  table_owner text;
  upstream_schema_version_value text;
  was_inserted boolean := false;
  next_offset bigint := 0;
begin
  if p_stage_document is null
    or pg_catalog.octet_length(p_stage_document) = 0
    or pg_catalog.octet_length(p_stage_document) > 65536 then
    raise exception 'catalogue stage document must contain between 1 and 65536 UTF-8 bytes'
      using errcode = '22023';
  end if;
  begin
    document := p_stage_document::jsonb;
  exception when others then
    raise exception 'catalogue stage document must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(document) <> 'object'
    or document -> 'schemaVersion' <> '1'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(document)) <> 19
    or document - array[
      'schemaVersion', 'sourceCode', 'releaseKey', 'publishedOn', 'acquiredAt',
      'artifactUri', 'artifactSha256', 'artifactBytes', 'mediaType',
      'upstreamSchemaVersion', 'parserVersion', 'rightsManifestUri',
      'rightsManifestSha256', 'releaseClass', 'evidenceBundleSha256',
      'evidenceBundleUri', 'evidenceDecisionSha256', 'evidenceObjectVersionId',
      'evidenceValidUntil'
    ] <> '{}'::jsonb then
    raise exception 'catalogue stage document contract differs from version 1'
      using errcode = '22023';
  end if;
  if document ->> 'sourceCode' !~ '^[A-Z][A-Z0-9_]{1,31}$'
    or pg_catalog.octet_length(document ->> 'releaseKey') not between 1 and 512
    or document ->> 'artifactSha256' !~ '^[0-9a-f]{64}$'
    or document ->> 'rightsManifestSha256' !~ '^[0-9a-f]{64}$'
    or document ->> 'evidenceBundleSha256' !~ '^[0-9a-f]{64}$'
    or document ->> 'evidenceDecisionSha256' !~ '^[0-9a-f]{64}$'
    or document ->> 'releaseClass' not in ('live-reviewed', 'fixture-nonrelease')
    or pg_catalog.octet_length(document ->> 'artifactUri') not between 1 and 2048
    or pg_catalog.octet_length(document ->> 'rightsManifestUri') not between 1 and 2048
    or pg_catalog.octet_length(document ->> 'mediaType') not between 1 and 256
    or pg_catalog.octet_length(document ->> 'parserVersion') not between 1 and 512
    or pg_catalog.octet_length(document ->> 'evidenceObjectVersionId') not between 1 and 512
    or document ->> 'artifactBytes' !~ '^[1-9][0-9]{0,18}$' then
    raise exception 'catalogue stage document contains an invalid or unbounded field'
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(document -> 'publishedOn') not in ('null', 'string')
    or pg_catalog.jsonb_typeof(document -> 'upstreamSchemaVersion') not in ('null', 'string') then
    raise exception 'catalogue stage nullable field types differ'
      using errcode = '22023';
  end if;

  begin
    artifact_bytes_value := (document ->> 'artifactBytes')::bigint;
    acquired_at_value := (document ->> 'acquiredAt')::timestamptz;
    evidence_valid_until_value := (document ->> 'evidenceValidUntil')::timestamptz;
    published_on_value := case
      when document -> 'publishedOn' = 'null'::jsonb then null
      else (document ->> 'publishedOn')::date
    end;
  exception when others then
    raise exception 'catalogue stage numeric or timestamp field is invalid'
      using errcode = '22023';
  end;
  upstream_schema_version_value := case
    when document -> 'upstreamSchemaVersion' = 'null'::jsonb then null
    else document ->> 'upstreamSchemaVersion'
  end;
  if upstream_schema_version_value is not null
    and pg_catalog.octet_length(upstream_schema_version_value) > 256 then
    raise exception 'catalogue upstream schema version is too long'
      using errcode = '22023';
  end if;
  if acquired_at_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or evidence_valid_until_value in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or evidence_valid_until_value <= pg_catalog.clock_timestamp()
    or evidence_valid_until_value > pg_catalog.clock_timestamp() + interval '24 hours' then
    raise exception 'catalogue staging requires finite current evidence valid for at most 24 hours'
      using errcode = '23514';
  end if;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue stage function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text <> table_owner then
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage' then
      raise exception 'database principal must hold exactly the catalogue stage capability'
        using errcode = '42501';
    end if;
  end if;

  select * into source_row
  from food_source
  where code = document ->> 'sourceCode';
  if not found then
    raise exception 'catalogue staging references an unknown pre-registered source'
      using errcode = '23503';
  end if;
  source_id_value := source_row.id;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-stage-attempt:v1'),
    pg_catalog.hashtext(
      source_id_value::text || ':' || (document ->> 'releaseKey') || ':' ||
      (document ->> 'artifactSha256') || ':' || (document ->> 'parserVersion')
    )
  );

  select * into attempt
  from food_import_batch
  where food_source_id = source_id_value
    and release_key = document ->> 'releaseKey'
    and artifact_sha256 = document ->> 'artifactSha256'
    and parser_version = document ->> 'parserVersion'
  for update;

  if found then
    select * into source_row from food_source where id = attempt.food_source_id for update;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
      pg_catalog.hashtext(source_row.id::text)
    );
    if session_user::text = table_owner then
      if attempt.staged_database_principal is not null
        or attempt.staged_database_capability_role is not null then
        raise exception 'schema owner cannot resume a capability-authenticated staging attempt'
          using errcode = '42501';
      end if;
    elsif attempt.staged_database_principal is distinct from session_user::text
      or attempt.staged_database_capability_role is distinct from 'nutrition_catalogue_stage' then
      raise exception 'catalogue staging attempt belongs to a different database principal'
        using errcode = '42501';
    end if;
  else
    select * into source_row
    from food_source
    where id = source_id_value
    for update;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
      pg_catalog.hashtext(source_row.id::text)
    );
    insert into food_import_batch (
      food_source_id, release_key, published_on, acquired_at, artifact_uri,
      artifact_sha256, artifact_bytes, media_type, upstream_schema_version,
      parser_version, rights_manifest_uri, rights_manifest_sha256, release_class,
      evidence_bundle_sha256, evidence_bundle_uri, evidence_decision_sha256,
      evidence_object_version_id, evidence_valid_until,
      staged_database_principal, staged_database_capability_role
    ) values (
      source_row.id, document ->> 'releaseKey', published_on_value, acquired_at_value,
      document ->> 'artifactUri', document ->> 'artifactSha256', artifact_bytes_value,
      document ->> 'mediaType', upstream_schema_version_value, document ->> 'parserVersion',
      document ->> 'rightsManifestUri', document ->> 'rightsManifestSha256',
      document ->> 'releaseClass', document ->> 'evidenceBundleSha256',
      document ->> 'evidenceBundleUri', document ->> 'evidenceDecisionSha256',
      document ->> 'evidenceObjectVersionId', evidence_valid_until_value,
      case when session_user::text = table_owner then null else session_user::text end,
      case when session_user::text = table_owner then null else 'nutrition_catalogue_stage' end
    )
    returning * into attempt;
    was_inserted := true;
  end if;

  if row(
    attempt.published_on, attempt.acquired_at, attempt.artifact_uri,
    attempt.artifact_bytes, attempt.media_type, attempt.upstream_schema_version,
    attempt.rights_manifest_uri, attempt.rights_manifest_sha256,
    attempt.release_class, attempt.evidence_bundle_sha256, attempt.evidence_bundle_uri,
    attempt.evidence_decision_sha256, attempt.evidence_object_version_id,
    attempt.evidence_valid_until
  ) is distinct from row(
    published_on_value, acquired_at_value, document ->> 'artifactUri',
    artifact_bytes_value, document ->> 'mediaType', upstream_schema_version_value,
    document ->> 'rightsManifestUri', document ->> 'rightsManifestSha256',
    document ->> 'releaseClass', document ->> 'evidenceBundleSha256',
    document ->> 'evidenceBundleUri',
    document ->> 'evidenceDecisionSha256', document ->> 'evidenceObjectVersionId',
    evidence_valid_until_value
  ) then
    raise exception 'catalogue staging replay differs from immutable batch provenance'
      using errcode = '55000';
  end if;

  select checkpoint.processed_count into next_offset
  from food_import_checkpoint as checkpoint
  where checkpoint.batch_id = attempt.id and checkpoint.stage = 'stage';
  next_offset := coalesce(next_offset, 0);
  return pg_catalog.jsonb_build_object(
    'batchId', attempt.id,
    'nextOffset', next_offset,
    'resumed', not was_inserted,
    'stagedCount', attempt.staged_count,
    'status', attempt.status
  );
end;
$$;

create function catalogue_compute_import_staging_seal(p_batch_id uuid)
returns text
language plpgsql
security definer
as $$
declare
  batch_row food_import_batch%rowtype;
  checkpoint_row food_import_checkpoint%rowtype;
  current_mapping_revision_ids jsonb;
  expected_last_sequence bigint;
  parser_evidence jsonb;
  parser_row food_import_parser_report%rowtype;
  record_count_value bigint;
  records_evidence jsonb;
  records_sha256_value text;
  seal_document jsonb;
  source_row food_source%rowtype;
  stage_checkpoint jsonb;
  total_canonical_payload_bytes bigint;
begin
  select * into batch_row
  from food_import_batch as batch
  where batch.id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue staging seal references an unknown batch'
      using errcode = '23503';
  end if;

  select * into source_row
  from food_source as source
  where source.id = batch_row.food_source_id
  for update;
  if not found then
    raise exception 'catalogue staging seal source is unavailable'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );
  perform lock_active_nutrient_registry_for_read();

  select * into parser_row
  from food_import_parser_report as parser_report
  where parser_report.batch_id = p_batch_id;
  if not found then
    raise exception 'catalogue staging seal requires immutable parser evidence'
      using errcode = '23514';
  end if;
  if pg_catalog.jsonb_typeof(parser_row.report) <> 'object'
    or parser_row.report_sha256 !~ '^[0-9a-f]{64}$'
    or parser_row.source_record_count < 0
    or parser_row.emitted_record_count < 0
    or parser_row.excluded_record_count < 0
    or parser_row.source_record_count < parser_row.emitted_record_count
    or parser_row.source_record_count < parser_row.excluded_record_count
    or parser_row.source_record_count <>
      parser_row.emitted_record_count + parser_row.excluded_record_count
    or parser_row.source_nutrient_count < 0
    or parser_row.emitted_nutrient_count < 0
    or parser_row.excluded_nutrient_count < 0
    or parser_row.source_nutrient_count < parser_row.emitted_nutrient_count
    or parser_row.source_nutrient_count < parser_row.excluded_nutrient_count
    or parser_row.source_nutrient_count <>
      parser_row.emitted_nutrient_count + parser_row.excluded_nutrient_count
    or parser_row.source_portion_count < 0
    or parser_row.emitted_portion_count < 0
    or parser_row.excluded_portion_count < 0
    or parser_row.source_portion_count < parser_row.emitted_portion_count
    or parser_row.source_portion_count < parser_row.excluded_portion_count
    or parser_row.source_portion_count <>
      parser_row.emitted_portion_count + parser_row.excluded_portion_count then
    raise exception 'catalogue staging seal parser evidence is invalid'
      using errcode = '23514';
  end if;
  parser_evidence := pg_catalog.jsonb_build_object(
    'emittedNutrientCount', parser_row.emitted_nutrient_count,
    'emittedPortionCount', parser_row.emitted_portion_count,
    'emittedRecordCount', parser_row.emitted_record_count,
    'excludedNutrientCount', parser_row.excluded_nutrient_count,
    'excludedPortionCount', parser_row.excluded_portion_count,
    'excludedRecordCount', parser_row.excluded_record_count,
    'report', parser_row.report,
    'reportSha256', parser_row.report_sha256,
    'sourceNutrientCount', parser_row.source_nutrient_count,
    'sourcePortionCount', parser_row.source_portion_count,
    'sourceRecordCount', parser_row.source_record_count
  );

  select
    pg_catalog.count(*),
    coalesce(pg_catalog.sum(pg_catalog.octet_length(import_record.canonical_payload::text)), 0),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'canonicalPayloadSha256', import_record.canonical_payload_sha256,
          'sequenceNumber', import_record.sequence_number,
          'sourcePayloadSha256', import_record.source_payload_sha256,
          'sourceRecordKey', import_record.source_record_key,
          'sourceRecordType', import_record.source_record_type
        ) order by import_record.sequence_number
      ),
      '[]'::jsonb
    )
  into record_count_value, total_canonical_payload_bytes, records_evidence
  from food_import_record as import_record
  where import_record.batch_id = p_batch_id;
  if record_count_value > 10000 or total_canonical_payload_bytes > 67108864 then
    raise exception 'catalogue staging seal exceeds the 10000-record or 64-MiB canonical-payload limit'
      using errcode = '54000';
  end if;
  if record_count_value <> batch_row.staged_count
    or record_count_value <> parser_row.emitted_record_count
    or exists (
      select 1
      from (
        select
          import_record.sequence_number,
          pg_catalog.row_number() over (order by import_record.sequence_number) - 1
            as expected_sequence_number
        from food_import_record as import_record
        where import_record.batch_id = p_batch_id
      ) as ordered_record
      where ordered_record.sequence_number <> ordered_record.expected_sequence_number
    ) then
    raise exception 'catalogue staging seal record set is incomplete or non-contiguous'
      using errcode = '23514';
  end if;
  records_sha256_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(records_evidence::text, 'UTF8')),
    'hex'
  );
  expected_last_sequence := case
    when record_count_value = 0 then null
    else record_count_value - 1
  end;

  select * into checkpoint_row
  from food_import_checkpoint as checkpoint
  where checkpoint.batch_id = p_batch_id
    and checkpoint.stage = 'stage'
  for update;
  if not found then
    if record_count_value <> 0 or parser_row.emitted_record_count <> 0 then
      raise exception 'catalogue staging seal requires the exact durable stage checkpoint'
        using errcode = '23514';
    end if;
    stage_checkpoint := pg_catalog.jsonb_build_object(
      'cursor', pg_catalog.jsonb_build_object('nextOffset', 0),
      'lastSequenceNumber', null,
      'processedCount', 0
    );
  else
    if checkpoint_row.processed_count <> record_count_value
      or checkpoint_row.last_sequence_number is distinct from expected_last_sequence
      or checkpoint_row.cursor_data is distinct from pg_catalog.jsonb_build_object(
        'nextOffset', record_count_value
      ) then
      raise exception 'catalogue staging seal checkpoint differs from the complete record set'
        using errcode = '23514';
    end if;
    stage_checkpoint := pg_catalog.jsonb_build_object(
      'cursor', checkpoint_row.cursor_data,
      'lastSequenceNumber', checkpoint_row.last_sequence_number,
      'processedCount', checkpoint_row.processed_count
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      nutrient_mapping.current_revision_id::text
      order by nutrient_mapping.current_revision_id::text collate "C"
    ),
    '[]'::jsonb
  ) into current_mapping_revision_ids
  from source_nutrient_map as nutrient_mapping
  where nutrient_mapping.food_source_id = source_row.id;

  seal_document := pg_catalog.jsonb_build_object(
    'artifactSha256', batch_row.artifact_sha256,
    'batchId', batch_row.id,
    'evidenceBundleSha256', batch_row.evidence_bundle_sha256,
    'mappingRevisionIds', current_mapping_revision_ids,
    'parserEvidence', parser_evidence,
    'parserVersion', batch_row.parser_version,
    'recordCount', record_count_value,
    'recordsSha256', records_sha256_value,
    'rightsManifestSha256', batch_row.rights_manifest_sha256,
    'schemaVersion', 1,
    'stageCheckpoint', stage_checkpoint
  );
  return pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(seal_document::text, 'UTF8')),
    'hex'
  );
end;
$$;

create function catalogue_stage_import_parser_report(
  p_batch_id uuid,
  p_parser_report_document text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  batch_row food_import_batch%rowtype;
  capabilities text[];
  checkpoint_count bigint;
  checkpoint_cursor jsonb;
  checkpoint_last_sequence bigint;
  count_value bigint;
  emitted_nutrient_count_value bigint;
  emitted_portion_count_value bigint;
  emitted_record_count_value bigint;
  excluded_nutrient_count_value bigint;
  excluded_portion_count_value bigint;
  excluded_record_count_value bigint;
  expected_last_sequence bigint;
  parser_document jsonb;
  parser_report jsonb;
  parser_report_sha256 text;
  seal_sha256 text;
  source_nutrient_count_value bigint;
  source_portion_count_value bigint;
  source_record_count_value bigint;
  source_row food_source%rowtype;
  stored_report food_import_parser_report%rowtype;
  table_owner text;
  was_already_sealed boolean := false;
begin
  if p_parser_report_document is null
    or pg_catalog.octet_length(p_parser_report_document) = 0
    or pg_catalog.octet_length(p_parser_report_document) > 16777216 then
    raise exception 'catalogue parser-report document must contain between 1 and 16777216 UTF-8 bytes'
      using errcode = '22023';
  end if;
  begin
    parser_document := p_parser_report_document::jsonb;
  exception when others then
    raise exception 'catalogue parser-report document must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(parser_document) <> 'object'
    or parser_document -> 'schemaVersion' <> '1'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(parser_document)) <> 12
    or parser_document - array[
      'schemaVersion', 'reportDocument', 'reportSha256',
      'sourceRecordCount', 'emittedRecordCount', 'excludedRecordCount',
      'sourceNutrientCount', 'emittedNutrientCount', 'excludedNutrientCount',
      'sourcePortionCount', 'emittedPortionCount', 'excludedPortionCount'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(parser_document -> 'reportDocument') <> 'string'
    or pg_catalog.jsonb_typeof(parser_document -> 'reportSha256') <> 'string' then
    raise exception 'catalogue parser-report contract differs from version 1'
      using errcode = '22023';
  end if;
  parser_report_sha256 := parser_document ->> 'reportSha256';
  if parser_report_sha256 !~ '^[0-9a-f]{64}$'
    or pg_catalog.octet_length(parser_document ->> 'reportDocument') not between 1 and 15728640
    or parser_report_sha256 <> pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(parser_document ->> 'reportDocument', 'UTF8')),
      'hex'
    ) then
    raise exception 'catalogue parser-report bytes or digest differ'
      using errcode = '22023';
  end if;
  begin
    parser_report := (parser_document ->> 'reportDocument')::jsonb;
  exception when others then
    raise exception 'catalogue parser report must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(parser_report) <> 'object' then
    raise exception 'catalogue parser report must be a JSON object'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(array[
      'sourceRecordCount', 'emittedRecordCount', 'excludedRecordCount',
      'sourceNutrientCount', 'emittedNutrientCount', 'excludedNutrientCount',
      'sourcePortionCount', 'emittedPortionCount', 'excludedPortionCount'
    ]) as field(name)
    where pg_catalog.jsonb_typeof(parser_document -> field.name) not in ('number', 'string')
      or parser_document ->> field.name !~ '^(0|[1-9][0-9]{0,18})$'
  ) then
    raise exception 'catalogue parser-report counts must be canonical non-negative integers'
      using errcode = '22023';
  end if;
  begin
    source_record_count_value := (parser_document ->> 'sourceRecordCount')::bigint;
    emitted_record_count_value := (parser_document ->> 'emittedRecordCount')::bigint;
    excluded_record_count_value := (parser_document ->> 'excludedRecordCount')::bigint;
    source_nutrient_count_value := (parser_document ->> 'sourceNutrientCount')::bigint;
    emitted_nutrient_count_value := (parser_document ->> 'emittedNutrientCount')::bigint;
    excluded_nutrient_count_value := (parser_document ->> 'excludedNutrientCount')::bigint;
    source_portion_count_value := (parser_document ->> 'sourcePortionCount')::bigint;
    emitted_portion_count_value := (parser_document ->> 'emittedPortionCount')::bigint;
    excluded_portion_count_value := (parser_document ->> 'excludedPortionCount')::bigint;
  exception when others then
    raise exception 'catalogue parser-report count is outside bigint range'
      using errcode = '22003';
  end;
  if source_record_count_value <> emitted_record_count_value + excluded_record_count_value
    or source_nutrient_count_value < emitted_nutrient_count_value
    or source_nutrient_count_value <> emitted_nutrient_count_value + excluded_nutrient_count_value
    or source_portion_count_value < emitted_portion_count_value
    or source_portion_count_value <> emitted_portion_count_value + excluded_portion_count_value then
    raise exception 'catalogue parser-report source counts must equal emitted plus excluded counts'
      using errcode = '23514';
  end if;
  expected_last_sequence := case
    when emitted_record_count_value = 0 then null
    else emitted_record_count_value - 1
  end;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue parser-report function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text <> table_owner then
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage' then
      raise exception 'database principal must hold exactly the catalogue stage capability'
        using errcode = '42501';
    end if;
  end if;

  select * into batch_row
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue parser report references an unknown batch'
      using errcode = '23503';
  end if;
  if batch_row.status <> 'staging' or batch_row.validated_at is not null then
    raise exception 'catalogue parser evidence can only seal a staging batch'
      using errcode = '23514';
  end if;
  if session_user::text = table_owner then
    if batch_row.staged_database_principal is not null
      or batch_row.staged_database_capability_role is not null then
      raise exception 'schema owner cannot seal a capability-authenticated staging attempt'
        using errcode = '42501';
    end if;
  elsif batch_row.staged_database_principal is distinct from session_user::text
    or batch_row.staged_database_capability_role is distinct from 'nutrition_catalogue_stage' then
    raise exception 'catalogue staging attempt belongs to a different database principal'
      using errcode = '42501';
  end if;

  select * into source_row
  from food_source
  where id = batch_row.food_source_id
  for update;
  if not found then
    raise exception 'catalogue parser report source is unavailable'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );
  perform lock_active_nutrient_registry_for_read();

  select checkpoint.processed_count, checkpoint.last_sequence_number, checkpoint.cursor_data
  into checkpoint_count, checkpoint_last_sequence, checkpoint_cursor
  from food_import_checkpoint as checkpoint
  where checkpoint.batch_id = p_batch_id and checkpoint.stage = 'stage'
  for update;
  if not found then
    if emitted_record_count_value <> 0 or batch_row.staged_count <> 0 or exists (
      select 1 from food_import_record where batch_id = p_batch_id
    ) then
      raise exception 'catalogue parser report is missing its durable stage checkpoint'
        using errcode = '23514';
    end if;
  elsif checkpoint_count <> emitted_record_count_value
    or checkpoint_last_sequence is distinct from expected_last_sequence
    or checkpoint_cursor is distinct from pg_catalog.jsonb_build_object(
      'nextOffset', emitted_record_count_value
    ) then
    raise exception 'catalogue parser report does not match the durable stage checkpoint'
      using errcode = '23514';
  end if;
  select pg_catalog.count(*) into count_value
  from food_import_record
  where batch_id = p_batch_id;
  if count_value <> emitted_record_count_value
    or batch_row.staged_count <> emitted_record_count_value
    or exists (
      select 1
      from (
        select sequence_number, pg_catalog.row_number() over (order by sequence_number) - 1 as expected
        from food_import_record
        where batch_id = p_batch_id
      ) as ordered_record
      where ordered_record.sequence_number <> ordered_record.expected
    ) then
    raise exception 'catalogue parser report does not match a complete contiguous staged record set'
      using errcode = '23514';
  end if;

  select * into stored_report
  from food_import_parser_report
  where batch_id = p_batch_id;
  if found then
    if row(
      stored_report.report, stored_report.report_sha256,
      stored_report.source_record_count, stored_report.emitted_record_count,
      stored_report.excluded_record_count, stored_report.source_nutrient_count,
      stored_report.emitted_nutrient_count, stored_report.excluded_nutrient_count,
      stored_report.source_portion_count, stored_report.emitted_portion_count,
      stored_report.excluded_portion_count
    ) is distinct from row(
      parser_report, parser_report_sha256,
      source_record_count_value, emitted_record_count_value,
      excluded_record_count_value, source_nutrient_count_value,
      emitted_nutrient_count_value, excluded_nutrient_count_value,
      source_portion_count_value, emitted_portion_count_value,
      excluded_portion_count_value
    ) then
      raise exception 'catalogue parser-report replay differs from immutable evidence'
        using errcode = '55000';
    end if;
    was_already_sealed := true;
  else
    insert into food_import_parser_report (
      batch_id, report, report_sha256,
      source_record_count, emitted_record_count, excluded_record_count,
      source_nutrient_count, emitted_nutrient_count, excluded_nutrient_count,
      source_portion_count, emitted_portion_count, excluded_portion_count
    ) values (
      p_batch_id, parser_report, parser_report_sha256,
      source_record_count_value, emitted_record_count_value, excluded_record_count_value,
      source_nutrient_count_value, emitted_nutrient_count_value, excluded_nutrient_count_value,
      source_portion_count_value, emitted_portion_count_value, excluded_portion_count_value
    );
  end if;

  seal_sha256 := catalogue_compute_import_staging_seal(p_batch_id);

  if batch_row.staging_seal_sha256 is null then
    update food_import_batch
    set staging_seal_sha256 = seal_sha256,
        staging_sealed_at = pg_catalog.clock_timestamp()
    where id = p_batch_id;
  elsif batch_row.staging_seal_sha256 <> seal_sha256
    or batch_row.staging_sealed_at is null then
    raise exception 'catalogue staging seal replay differs from immutable evidence'
      using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'parserReportSha256', parser_report_sha256,
    'stagingSealSha256', seal_sha256,
    'wasAlreadySealed', was_already_sealed
  );
end;
$$;

create function catalogue_observe_import_validation(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  batch_row food_import_batch%rowtype;
  capabilities text[];
  computed_staging_seal text;
  forbidden_gtins jsonb;
  mapping_rows jsonb;
  observation jsonb;
  observation_sha256 text;
  parser_row food_import_parser_report%rowtype;
  record_rows jsonb;
  source_row food_source%rowtype;
  stage_checkpoint jsonb;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue validation observation function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text <> table_owner then
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate' then
      raise exception 'database principal must hold exactly the catalogue validate capability'
        using errcode = '42501';
    end if;
  end if;

  select * into batch_row
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue validation observation references an unknown batch'
      using errcode = '23503';
  end if;
  if batch_row.staging_seal_sha256 is null or batch_row.staging_sealed_at is null then
    raise exception 'catalogue validation requires an immutable stage-owned parser seal'
      using errcode = '23514';
  end if;
  if session_user::text = table_owner then
    if batch_row.staged_database_principal is not null
      or batch_row.staged_database_capability_role is not null
      or batch_row.validated_database_principal is not null
      or batch_row.validated_database_capability_role is not null then
      raise exception 'schema-owner validation cannot cross a capability-authenticated lineage'
        using errcode = '42501';
    end if;
  elsif batch_row.staged_database_principal is null
    or batch_row.staged_database_capability_role is distinct from 'nutrition_catalogue_stage'
    or batch_row.staged_database_principal = session_user::text
    or (
      batch_row.validated_database_principal is not null
      and batch_row.validated_database_principal is distinct from session_user::text
    )
    or (
      batch_row.validated_database_capability_role is not null
      and batch_row.validated_database_capability_role is distinct from 'nutrition_catalogue_validate'
    ) then
    raise exception 'catalogue validation requires a distinct authenticated validator on one capability lineage'
      using errcode = '42501';
  end if;

  select * into source_row
  from food_source
  where id = batch_row.food_source_id
  for update;
  if not found then
    raise exception 'catalogue validation source is unavailable'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );
  perform lock_active_nutrient_registry_for_read();

  select * into parser_row
  from food_import_parser_report
  where batch_id = p_batch_id;
  if not found then
    raise exception 'catalogue validation cannot observe an unsealed parser report'
      using errcode = '23514';
  end if;
  computed_staging_seal := catalogue_compute_import_staging_seal(p_batch_id);
  if computed_staging_seal is distinct from batch_row.staging_seal_sha256 then
    raise exception 'catalogue staging evidence or nutrient mappings changed after sealing'
      using errcode = '55000';
  end if;
  select pg_catalog.jsonb_build_object(
    'cursor', checkpoint.cursor_data,
    'lastSequenceNumber', checkpoint.last_sequence_number,
    'processedCount', checkpoint.processed_count
  ) into stage_checkpoint
  from food_import_checkpoint as checkpoint
  where checkpoint.batch_id = p_batch_id and checkpoint.stage = 'stage';
  if stage_checkpoint is null then
    if batch_row.staged_count <> 0
      or parser_row.emitted_record_count <> 0
      or exists (select 1 from food_import_record where batch_id = p_batch_id) then
      raise exception 'catalogue validation cannot observe a missing stage checkpoint'
        using errcode = '23514';
    end if;
    stage_checkpoint := pg_catalog.jsonb_build_object(
      'cursor', pg_catalog.jsonb_build_object('nextOffset', 0),
      'lastSequenceNumber', null,
      'processedCount', 0
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'canonicalUnit', nutrient.canonical_unit,
        'conversionMultiplier', revision.conversion_multiplier::text,
        'nutrientCode', nutrient.code,
        'nutrientDimension', nutrient.dimension,
        'nutrientId', nutrient.id::text,
        'nutrientName', nutrient.name,
        'revisionId', revision.id::text,
        'sourceNutrientKey', mapping.source_nutrient_key,
        'sourceUnit', revision.source_unit
      ) order by mapping.source_nutrient_key collate "C"
    ),
    '[]'::jsonb
  ) into mapping_rows
  from source_nutrient_map as mapping
  join source_nutrient_map_revision as revision
    on revision.id = mapping.current_revision_id
  join nutrient
    on nutrient.id = revision.nutrient_id
  where mapping.food_source_id = source_row.id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'canonicalPayload', record.canonical_payload,
        'canonicalPayloadSha256', record.canonical_payload_sha256,
        'sequenceNumber', record.sequence_number,
        'sourcePayloadSha256', record.source_payload_sha256,
        'sourceRecordKey', record.source_record_key,
        'sourceRecordType', record.source_record_type,
        'validatedFoodContractVersion', record.validated_food_contract_version,
        'validatedFoodDocument', record.validated_food_document,
        'validatedFoodSha256', record.validated_food_sha256,
        'validatedAt', record.validated_at,
        'validationIssues', record.validation_issues,
        'validationStatus', record.validation_status
      ) order by record.sequence_number
    ),
    '[]'::jsonb
  ) into record_rows
  from food_import_record as record
  where record.batch_id = p_batch_id;

  with candidate as (
    select distinct
      pg_catalog.lpad(pg_catalog.btrim(record.canonical_payload #>> '{identity,gtin}'), 14, '0') as gtin14,
      pg_catalog.btrim(record.canonical_payload #>> '{source,marketCode}') as market_code
    from food_import_record as record
    where record.batch_id = p_batch_id
      and pg_catalog.btrim(record.canonical_payload #>> '{identity,gtin}')
        ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'
      and pg_catalog.btrim(record.canonical_payload #>> '{source,marketCode}')
        ~ '^[A-Z0-9]{2,3}$'
  )
  select coalesce(
    pg_catalog.jsonb_agg(identity order by identity collate "C"),
    '[]'::jsonb
  ) into forbidden_gtins
  from (
    select distinct candidate.gtin14 || ':' || candidate.market_code as identity
    from candidate
    join food_barcode as barcode
      on pg_catalog.lpad(barcode.gtin, 14, '0') = candidate.gtin14
     and barcode.market_code = candidate.market_code
     and barcode.valid_to is null
    join food
      on food.id = barcode.food_id
    where food.food_source_id is not null
      and food.food_source_id <> source_row.id
  ) as conflict;

  observation := pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object(
      'acquiredAt', batch_row.acquired_at,
      'artifactBytes', batch_row.artifact_bytes,
      'artifactSha256', batch_row.artifact_sha256,
      'artifactUri', batch_row.artifact_uri,
      'evidenceBundleSha256', batch_row.evidence_bundle_sha256,
      'evidenceBundleUri', batch_row.evidence_bundle_uri,
      'evidenceDecisionSha256', batch_row.evidence_decision_sha256,
      'evidenceObjectVersionId', batch_row.evidence_object_version_id,
      'evidenceValidUntil', batch_row.evidence_valid_until,
      'id', batch_row.id,
      'mediaType', batch_row.media_type,
      'parserVersion', batch_row.parser_version,
      'publishedOn', batch_row.published_on,
      'releaseClass', batch_row.release_class,
      'releaseKey', batch_row.release_key,
      'rightsManifestSha256', batch_row.rights_manifest_sha256,
      'rightsManifestUri', batch_row.rights_manifest_uri,
      'stagedCount', batch_row.staged_count,
      'stagedDatabasePrincipal', batch_row.staged_database_principal,
      'stagingSealSha256', batch_row.staging_seal_sha256,
      'stagingSealedAt', batch_row.staging_sealed_at,
      'status', batch_row.status,
      'upstreamSchemaVersion', batch_row.upstream_schema_version
    ),
    'forbiddenGtins', forbidden_gtins,
    'nutrientMappings', mapping_rows,
    'parserReport', pg_catalog.jsonb_build_object(
      'emittedNutrientCount', parser_row.emitted_nutrient_count,
      'emittedPortionCount', parser_row.emitted_portion_count,
      'emittedRecordCount', parser_row.emitted_record_count,
      'excludedNutrientCount', parser_row.excluded_nutrient_count,
      'excludedPortionCount', parser_row.excluded_portion_count,
      'excludedRecordCount', parser_row.excluded_record_count,
      'report', parser_row.report,
      'reportSha256', parser_row.report_sha256,
      'sourceNutrientCount', parser_row.source_nutrient_count,
      'sourcePortionCount', parser_row.source_portion_count,
      'sourceRecordCount', parser_row.source_record_count
    ),
    'records', record_rows,
    'schemaVersion', 1,
    'sourceCode', source_row.code,
    'stageCheckpoint', stage_checkpoint
  );
  if pg_catalog.pg_column_size(observation) > 134217728 then
    raise exception 'catalogue validation observation exceeds the 128-MiB response limit'
      using errcode = '54000';
  end if;
  observation_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(observation::text, 'UTF8')),
    'hex'
  );
  return pg_catalog.jsonb_build_object(
    'observation', observation,
    'observationSha256', observation_sha256,
    'schemaVersion', 1
  );
end;
$$;

create function catalogue_validate_import_batch(
  p_batch_id uuid,
  p_expected_staging_seal_sha256 text,
  p_expected_observation_sha256 text,
  p_validation_document text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  batch_row food_import_batch%rowtype;
  capabilities text[];
  classified_count bigint := 0;
  digest_document text;
  digest_evidence jsonb;
  digest_record jsonb;
  digest_record_ordinal bigint;
  emitted_nutrient_total bigint := 0;
  excluded_nutrient_total bigint := 0;
  excluded_nutrient_fraction numeric;
  issue_error_count bigint;
  issue_warning_count bigint;
  issues_document text;
  issues_value jsonb;
  computed_mapping_revision_ids jsonb;
  computed_staging_seal text;
  maximum_excluded_nutrient_fraction numeric;
  maximum_quarantine_fraction numeric;
  maximum_quarantined_records bigint;
  materializable_nutrient_total bigint := 0;
  observation_result jsonb;
  parser_row food_import_parser_report%rowtype;
  validation_policy_value jsonb;
  portion_input_total bigint := 0;
  computed_quarantined_count bigint := 0;
  quarantine_fraction numeric;
  record_error_total bigint := 0;
  result_record jsonb;
  result_record_count bigint;
  result_record_distinct_count bigint;
  staged_record food_import_record%rowtype;
  table_owner text;
  computed_unresolved_error_count bigint := 0;
  updated_count bigint;
  computed_valid_count bigint := 0;
  validated_at_value timestamptz;
  validated_food_document_value text;
  validated_food_sha256_value text;
  validation_digest_value text;
  validation_document jsonb;
  computed_warning_count bigint := 0;
begin
  if p_expected_staging_seal_sha256 !~ '^[0-9a-f]{64}$'
    or p_expected_observation_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'catalogue validation requires canonical expected SHA-256 digests'
      using errcode = '22023';
  end if;
  if p_validation_document is null
    or pg_catalog.octet_length(p_validation_document) = 0
    or pg_catalog.octet_length(p_validation_document) > 134217728 then
    raise exception 'catalogue validation document must contain between 1 and 134217728 UTF-8 bytes'
      using errcode = '22023';
  end if;
  begin
    validation_document := p_validation_document::jsonb;
  exception when others then
    raise exception 'catalogue validation document must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(validation_document) <> 'object'
    or validation_document -> 'schemaVersion' <> '1'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(validation_document)) <> 3
    or validation_document - array['schemaVersion', 'digestDocument', 'records'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(validation_document -> 'digestDocument') <> 'string'
    or pg_catalog.jsonb_typeof(validation_document -> 'records') <> 'array' then
    raise exception 'catalogue validation document contract differs from version 1'
      using errcode = '22023';
  end if;
  digest_document := validation_document ->> 'digestDocument';
  if pg_catalog.octet_length(digest_document) not between 1 and 125829120 then
    raise exception 'catalogue validation digest document is empty or too large'
      using errcode = '22023';
  end if;
  validation_digest_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(digest_document, 'UTF8')),
    'hex'
  );
  begin
    digest_evidence := digest_document::jsonb;
  exception when others then
    raise exception 'catalogue validation digest document must be valid JSON'
      using errcode = '22023';
  end;
  if pg_catalog.jsonb_typeof(digest_evidence) <> 'object'
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(digest_evidence)) <> 17
    or digest_evidence - array[
      'artifactSha256', 'batchId', 'evidenceBundleSha256', 'evidenceBundleUri',
      'evidenceDecisionSha256', 'evidenceObjectVersionId', 'evidenceValidUntil',
      'nutrientMappingDigest', 'nutrientMappingRevisionIds', 'observationSha256', 'policy',
      'parserEvidence', 'parserReportSha256', 'records', 'releaseClass',
      'rightsManifestSha256', 'validatedFoodContractVersion'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(digest_evidence -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(digest_evidence -> 'observationSha256') <> 'string'
    or pg_catalog.jsonb_typeof(digest_evidence -> 'policy') <> 'object'
    or pg_catalog.jsonb_typeof(digest_evidence -> 'parserEvidence') <> 'object'
    or pg_catalog.jsonb_typeof(digest_evidence -> 'nutrientMappingRevisionIds') <> 'array' then
    raise exception 'catalogue validation digest evidence contract differs'
      using errcode = '22023';
  end if;
  if digest_evidence ->> 'observationSha256' !~ '^[0-9a-f]{64}$'
    or digest_evidence ->> 'observationSha256' is distinct from p_expected_observation_sha256 then
    raise exception 'catalogue validation observation digest is not bound to the validation evidence'
      using errcode = '23514';
  end if;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue validation function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  if session_user::text <> table_owner then
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate' then
      raise exception 'database principal must hold exactly the catalogue validate capability'
        using errcode = '42501';
    end if;
  end if;

  select * into batch_row
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'catalogue validation references an unknown batch'
      using errcode = '23503';
  end if;
  if batch_row.staging_seal_sha256 is distinct from p_expected_staging_seal_sha256
    or batch_row.staging_sealed_at is null then
    raise exception 'catalogue validation staging seal differs'
      using errcode = '55000';
  end if;
  if session_user::text = table_owner then
    if batch_row.staged_database_principal is not null
      or batch_row.staged_database_capability_role is not null
      or batch_row.validated_database_principal is not null
      or batch_row.validated_database_capability_role is not null then
      raise exception 'schema-owner validation cannot cross a capability-authenticated lineage'
        using errcode = '42501';
    end if;
  elsif batch_row.staged_database_principal is null
    or batch_row.staged_database_capability_role is distinct from 'nutrition_catalogue_stage'
    or batch_row.staged_database_principal = session_user::text
    or (
      batch_row.validated_database_principal is not null
      and batch_row.validated_database_principal is distinct from session_user::text
    )
    or (
      batch_row.validated_database_capability_role is not null
      and batch_row.validated_database_capability_role is distinct from 'nutrition_catalogue_validate'
    ) then
    raise exception 'catalogue validation requires a distinct authenticated validator on one capability lineage'
      using errcode = '42501';
  end if;

  select * into parser_row
  from food_import_parser_report
  where batch_id = p_batch_id;
  if not found then
    raise exception 'catalogue validation requires a stage-owned parser report'
      using errcode = '23514';
  end if;
  computed_staging_seal := catalogue_compute_import_staging_seal(p_batch_id);
  if computed_staging_seal is distinct from batch_row.staging_seal_sha256 then
    raise exception 'catalogue staging evidence or nutrient mappings changed after sealing'
      using errcode = '55000';
  end if;

  if batch_row.validated_at is not null then
    if batch_row.validation_digest is distinct from validation_digest_value
      or digest_evidence ->> 'parserReportSha256' is distinct from parser_row.report_sha256 then
      raise exception 'catalogue validation replay differs from immutable validation evidence'
        using errcode = '55000';
    end if;

    select pg_catalog.count(*), pg_catalog.count(distinct result.value ->> 'sourceRecordKey')
    into result_record_count, result_record_distinct_count
    from pg_catalog.jsonb_array_elements(validation_document -> 'records') as result(value);
    if result_record_count <> result_record_distinct_count
      or result_record_count <> pg_catalog.jsonb_array_length(digest_evidence -> 'records')
      or result_record_count <> batch_row.staged_count
      or result_record_count <> parser_row.emitted_record_count then
      raise exception 'catalogue validation replay does not exactly cover the frozen record set'
        using errcode = '55000';
    end if;

    for digest_record, digest_record_ordinal in
      select entry.value, entry.ordinality
      from pg_catalog.jsonb_array_elements(digest_evidence -> 'records')
        with ordinality as entry(value, ordinality)
    loop
      if pg_catalog.jsonb_typeof(digest_record) <> 'object'
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(digest_record)) <> 10
        or digest_record - array[
          'canonicalPayloadSha256', 'excludedNutrientCount', 'issues',
          'nutrientInputCount', 'nutrientMaterializableCount', 'portionInputCount',
          'sourceRecordKey', 'status', 'validatedFoodContractVersion',
          'validatedFoodSha256'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(digest_record -> 'sourceRecordKey') <> 'string'
        or digest_record ->> 'canonicalPayloadSha256' !~ '^[0-9a-f]{64}$'
        or digest_record ->> 'status' not in ('quarantined', 'valid')
        or pg_catalog.jsonb_typeof(digest_record -> 'issues') <> 'array'
        or exists (
          select 1
          from pg_catalog.unnest(array[
            'excludedNutrientCount', 'nutrientInputCount',
            'nutrientMaterializableCount', 'portionInputCount'
          ]) as field(name)
          where pg_catalog.jsonb_typeof(digest_record -> field.name) not in ('number', 'string')
            or digest_record ->> field.name !~ '^(0|[1-9][0-9]{0,18})$'
        ) then
        raise exception 'catalogue validation replay record digest contract differs'
          using errcode = '22023';
      end if;

      select * into staged_record
      from food_import_record as import_record
      where import_record.batch_id = p_batch_id
        and import_record.source_record_key = digest_record ->> 'sourceRecordKey'
      for update;
      if not found
        or staged_record.sequence_number <> digest_record_ordinal - 1
        or staged_record.canonical_payload_sha256 is distinct from
          digest_record ->> 'canonicalPayloadSha256'
        or staged_record.validated_at is null then
        raise exception 'catalogue validation replay record differs from frozen database evidence'
          using errcode = '55000';
      end if;

      select result.value into result_record
      from pg_catalog.jsonb_array_elements(validation_document -> 'records') as result(value)
      where result.value ->> 'sourceRecordKey' = staged_record.source_record_key;
      if result_record is null
        or pg_catalog.jsonb_typeof(result_record) <> 'object'
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(result_record)) <> 3
        or result_record - array[
          'sourceRecordKey', 'validationIssuesDocument', 'validatedFoodDocument'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(result_record -> 'sourceRecordKey') <> 'string'
        or result_record ->> 'sourceRecordKey' is distinct from staged_record.source_record_key
        or pg_catalog.jsonb_typeof(result_record -> 'validationIssuesDocument') <> 'string'
        or pg_catalog.jsonb_typeof(result_record -> 'validatedFoodDocument') not in ('null', 'string') then
        raise exception 'catalogue validation replay result document differs from version 1'
          using errcode = '22023';
      end if;

      issues_document := result_record ->> 'validationIssuesDocument';
      if pg_catalog.octet_length(issues_document) > 1048576 then
        raise exception 'catalogue validation replay issue document is too large'
          using errcode = '22023';
      end if;
      begin
        issues_value := issues_document::jsonb;
      exception when others then
        raise exception 'catalogue validation replay issues must be valid JSON'
          using errcode = '22023';
      end;
      if pg_catalog.jsonb_typeof(issues_value) <> 'array'
        or issues_value is distinct from digest_record -> 'issues'
        or issues_value is distinct from staged_record.validation_issues then
        raise exception 'catalogue validation replay issues differ from frozen database evidence'
          using errcode = '55000';
      end if;

      if digest_record ->> 'status' = 'valid' then
        if digest_record -> 'validatedFoodContractVersion' <> '1'::jsonb
          or digest_record ->> 'validatedFoodSha256' !~ '^[0-9a-f]{64}$'
          or pg_catalog.jsonb_typeof(result_record -> 'validatedFoodDocument') <> 'string'
          or staged_record.validation_status not in ('valid', 'materialized')
          or staged_record.validated_food_contract_version is distinct from 1
          or staged_record.validated_food_sha256 is distinct from
            digest_record ->> 'validatedFoodSha256'
          or staged_record.validated_food_document is null then
          raise exception 'catalogue validation replay valid-record evidence differs'
            using errcode = '55000';
        end if;
        validated_food_document_value := result_record ->> 'validatedFoodDocument';
        if pg_catalog.octet_length(validated_food_document_value) not between 1 and 2097152
          or validated_food_document_value is distinct from staged_record.validated_food_document then
          raise exception 'catalogue validation replay frozen food bytes differ'
            using errcode = '55000';
        end if;
        begin
          if pg_catalog.jsonb_typeof(validated_food_document_value::jsonb) <> 'object' then
            raise exception 'catalogue validation replay frozen food must be a JSON object'
              using errcode = '22023';
          end if;
        exception when others then
          raise exception 'catalogue validation replay frozen food must be valid JSON'
            using errcode = '22023';
        end;
        validated_food_sha256_value := pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(validated_food_document_value, 'UTF8')),
          'hex'
        );
        if validated_food_sha256_value is distinct from staged_record.validated_food_sha256
          or validated_food_sha256_value is distinct from digest_record ->> 'validatedFoodSha256' then
          raise exception 'catalogue validation replay frozen food digest differs'
            using errcode = '55000';
        end if;
      else
        if digest_record -> 'validatedFoodContractVersion' <> 'null'::jsonb
          or digest_record -> 'validatedFoodSha256' <> 'null'::jsonb
          or result_record -> 'validatedFoodDocument' <> 'null'::jsonb
          or staged_record.validation_status <> 'quarantined'
          or staged_record.validated_food_contract_version is not null
          or staged_record.validated_food_sha256 is not null
          or staged_record.validated_food_document is not null then
          raise exception 'catalogue validation replay quarantined-record evidence differs'
            using errcode = '55000';
        end if;
      end if;
      classified_count := classified_count + 1;
    end loop;
    if classified_count <> batch_row.staged_count then
      raise exception 'catalogue validation replay frozen record count changed'
        using errcode = '55000';
    end if;

    return pg_catalog.jsonb_build_object(
      'nutrientMappingDigest', batch_row.nutrient_mapping_digest,
      'promotionEligible', batch_row.unresolved_error_count = 0,
      'quarantinedCount', batch_row.quarantined_count,
      'stagedCount', batch_row.staged_count,
      'validCount', batch_row.valid_count,
      'validationDigest', batch_row.validation_digest,
      'warningCount', batch_row.warning_count,
      'wasAlreadyValidated', true
    );
  end if;
  if batch_row.status <> 'staging' then
    raise exception 'catalogue validation can only classify a staging batch'
      using errcode = '23514';
  end if;

  observation_result := catalogue_observe_import_validation(p_batch_id);
  if observation_result ->> 'observationSha256' is distinct from p_expected_observation_sha256 then
    raise exception 'catalogue validation observation changed before finalization'
      using errcode = '40001';
  end if;

  begin
    if digest_evidence ->> 'batchId' is distinct from p_batch_id::text
      or digest_evidence ->> 'artifactSha256' is distinct from batch_row.artifact_sha256
      or digest_evidence ->> 'evidenceBundleSha256' is distinct from batch_row.evidence_bundle_sha256
      or digest_evidence ->> 'evidenceBundleUri' is distinct from batch_row.evidence_bundle_uri
      or digest_evidence ->> 'evidenceDecisionSha256' is distinct from batch_row.evidence_decision_sha256
      or digest_evidence ->> 'evidenceObjectVersionId' is distinct from batch_row.evidence_object_version_id
      or (digest_evidence ->> 'evidenceValidUntil')::timestamptz is distinct from batch_row.evidence_valid_until
      or digest_evidence ->> 'releaseClass' is distinct from batch_row.release_class
      or digest_evidence ->> 'rightsManifestSha256' is distinct from batch_row.rights_manifest_sha256
      or digest_evidence ->> 'parserReportSha256' is distinct from parser_row.report_sha256
      or digest_evidence -> 'validatedFoodContractVersion' <> '1'::jsonb
      or digest_evidence ->> 'nutrientMappingDigest' !~ '^[0-9a-f]{64}$'
      or pg_catalog.substring(batch_row.parser_version, '[+]mapping[.]([0-9a-f]{64})$')
        is distinct from digest_evidence ->> 'nutrientMappingDigest' then
      raise exception 'catalogue validation digest evidence differs from sealed batch provenance'
        using errcode = '23514';
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'catalogue validation evidence expiry is invalid'
      using errcode = '22023';
  end;

  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(digest_evidence -> 'parserEvidence')) <> 9
    or (digest_evidence -> 'parserEvidence') - array[
      'emittedNutrientCount', 'emittedPortionCount', 'emittedRecordCount',
      'excludedNutrientCount', 'excludedPortionCount', 'excludedRecordCount',
      'sourceNutrientCount', 'sourcePortionCount', 'sourceRecordCount'
    ] <> '{}'::jsonb
    or digest_evidence -> 'parserEvidence' is distinct from pg_catalog.jsonb_build_object(
      'emittedNutrientCount', parser_row.emitted_nutrient_count,
      'emittedPortionCount', parser_row.emitted_portion_count,
      'emittedRecordCount', parser_row.emitted_record_count,
      'excludedNutrientCount', parser_row.excluded_nutrient_count,
      'excludedPortionCount', parser_row.excluded_portion_count,
      'excludedRecordCount', parser_row.excluded_record_count,
      'sourceNutrientCount', parser_row.source_nutrient_count,
      'sourcePortionCount', parser_row.source_portion_count,
      'sourceRecordCount', parser_row.source_record_count
    ) then
    raise exception 'catalogue validation parser evidence differs from the stage-owned seal'
      using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(mapping.value ->> 'revisionId' order by mapping.value ->> 'revisionId' collate "C"),
    '[]'::jsonb
  ) into computed_mapping_revision_ids
  from pg_catalog.jsonb_array_elements(
    observation_result #> '{observation,nutrientMappings}'
  ) as mapping(value);
  if digest_evidence -> 'nutrientMappingRevisionIds' is distinct from computed_mapping_revision_ids
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        digest_evidence -> 'nutrientMappingRevisionIds'
      ) with ordinality as revision(value, position)
      where revision.value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or exists (
           select 1
           from pg_catalog.jsonb_array_elements_text(
             digest_evidence -> 'nutrientMappingRevisionIds'
           ) with ordinality as prior(value, position)
           where prior.position < revision.position and prior.value >= revision.value collate "C"
         )
    ) then
    raise exception 'catalogue validation nutrient-mapping revisions differ from the locked registry'
      using errcode = '55000';
  end if;

  validation_policy_value := digest_evidence -> 'policy';
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(validation_policy_value)) <> 6
    or validation_policy_value - array[
      'maximumExcludedNutrientFraction', 'maximumQuarantineFraction',
      'maximumQuarantinedRecords', 'requireDistinctApprovalPrincipals',
      'requireAtLeastOneValidRecord', 'requireMaterializedNutrientPerValidRecord'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'maximumExcludedNutrientFraction') <> 'number'
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'maximumQuarantineFraction') <> 'number'
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'maximumQuarantinedRecords') not in ('number', 'string')
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'requireDistinctApprovalPrincipals') <> 'boolean'
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'requireAtLeastOneValidRecord') <> 'boolean'
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'requireMaterializedNutrientPerValidRecord') <> 'boolean'
    or validation_policy_value ->> 'maximumQuarantinedRecords' !~ '^(0|[1-9][0-9]{0,18})$' then
    raise exception 'catalogue validation policy contract differs'
      using errcode = '22023';
  end if;
  begin
    maximum_excluded_nutrient_fraction := (validation_policy_value ->> 'maximumExcludedNutrientFraction')::numeric;
    maximum_quarantine_fraction := (validation_policy_value ->> 'maximumQuarantineFraction')::numeric;
    maximum_quarantined_records := (validation_policy_value ->> 'maximumQuarantinedRecords')::bigint;
  exception when others then
    raise exception 'catalogue validation policy number is invalid or out of range'
      using errcode = '22023';
  end;
  if maximum_excluded_nutrient_fraction not between 0 and 1
    or maximum_quarantine_fraction not between 0 and 1 then
    raise exception 'catalogue validation policy fractions must be between zero and one'
      using errcode = '22023';
  end if;

  select pg_catalog.count(*), pg_catalog.count(distinct result.value ->> 'sourceRecordKey')
  into result_record_count, result_record_distinct_count
  from pg_catalog.jsonb_array_elements(validation_document -> 'records') as result(value);
  if result_record_count <> result_record_distinct_count
    or result_record_count <> pg_catalog.jsonb_array_length(digest_evidence -> 'records')
    or result_record_count <> batch_row.staged_count
    or result_record_count <> parser_row.emitted_record_count then
    raise exception 'catalogue validation record set does not exactly cover the sealed batch'
      using errcode = '23514';
  end if;

  validated_at_value := pg_catalog.clock_timestamp();
  for digest_record, digest_record_ordinal in
    select entry.value, entry.ordinality
    from pg_catalog.jsonb_array_elements(digest_evidence -> 'records')
      with ordinality as entry(value, ordinality)
  loop
    if pg_catalog.jsonb_typeof(digest_record) <> 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(digest_record)) <> 10
      or digest_record - array[
        'canonicalPayloadSha256', 'excludedNutrientCount', 'issues',
        'nutrientInputCount', 'nutrientMaterializableCount', 'portionInputCount',
        'sourceRecordKey', 'status', 'validatedFoodContractVersion',
        'validatedFoodSha256'
      ] <> '{}'::jsonb
      or digest_record ->> 'canonicalPayloadSha256' !~ '^[0-9a-f]{64}$'
      or pg_catalog.jsonb_typeof(digest_record -> 'sourceRecordKey') <> 'string'
      or digest_record ->> 'status' not in ('quarantined', 'valid')
      or pg_catalog.jsonb_typeof(digest_record -> 'issues') <> 'array'
      or exists (
        select 1
        from pg_catalog.unnest(array[
          'excludedNutrientCount', 'nutrientInputCount',
          'nutrientMaterializableCount', 'portionInputCount'
        ]) as field(name)
        where pg_catalog.jsonb_typeof(digest_record -> field.name) not in ('number', 'string')
          or digest_record ->> field.name !~ '^(0|[1-9][0-9]{0,18})$'
      ) then
      raise exception 'catalogue validation record digest contract differs'
        using errcode = '22023';
    end if;
    select * into staged_record
    from food_import_record
    where batch_id = p_batch_id
      and source_record_key = digest_record ->> 'sourceRecordKey'
    for update;
    if not found
      or staged_record.sequence_number <> digest_record_ordinal - 1
      or staged_record.validation_status <> 'pending'
      or staged_record.canonical_payload_sha256 is distinct from digest_record ->> 'canonicalPayloadSha256' then
      raise exception 'catalogue validation record differs from the sealed staged row'
        using errcode = '55000';
    end if;
    select result.value into result_record
    from pg_catalog.jsonb_array_elements(validation_document -> 'records') as result(value)
    where result.value ->> 'sourceRecordKey' = staged_record.source_record_key;
    if result_record is null
      or pg_catalog.jsonb_typeof(result_record) <> 'object'
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(result_record)) <> 3
      or result_record - array[
        'sourceRecordKey', 'validationIssuesDocument', 'validatedFoodDocument'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(result_record -> 'sourceRecordKey') <> 'string'
      or pg_catalog.jsonb_typeof(result_record -> 'validationIssuesDocument') <> 'string'
      or pg_catalog.jsonb_typeof(result_record -> 'validatedFoodDocument') not in ('null', 'string') then
      raise exception 'catalogue validation result document differs from version 1'
        using errcode = '22023';
    end if;
    issues_document := result_record ->> 'validationIssuesDocument';
    if pg_catalog.octet_length(issues_document) > 1048576 then
      raise exception 'catalogue validation issue document is too large'
        using errcode = '22023';
    end if;
    begin
      issues_value := issues_document::jsonb;
    exception when others then
      raise exception 'catalogue validation issues must be valid JSON'
        using errcode = '22023';
    end;
    if pg_catalog.jsonb_typeof(issues_value) <> 'array'
      or issues_value is distinct from digest_record -> 'issues' then
      raise exception 'catalogue validation issues differ from digest evidence'
        using errcode = '23514';
    end if;

    select
      pg_catalog.count(*) filter (where issue.value ->> 'severity' = 'error'),
      pg_catalog.count(*) filter (where issue.value ->> 'severity' = 'warning')
    into issue_error_count, issue_warning_count
    from pg_catalog.jsonb_array_elements(issues_value) as issue(value);
    record_error_total := record_error_total + issue_error_count;
    computed_warning_count := computed_warning_count + issue_warning_count;
    emitted_nutrient_total := emitted_nutrient_total + (digest_record ->> 'nutrientInputCount')::bigint;
    materializable_nutrient_total := materializable_nutrient_total
      + (digest_record ->> 'nutrientMaterializableCount')::bigint;
    excluded_nutrient_total := excluded_nutrient_total
      + (digest_record ->> 'excludedNutrientCount')::bigint;
    portion_input_total := portion_input_total + (digest_record ->> 'portionInputCount')::bigint;

    if digest_record ->> 'status' = 'valid' then
      if digest_record -> 'validatedFoodContractVersion' <> '1'::jsonb
        or digest_record ->> 'validatedFoodSha256' !~ '^[0-9a-f]{64}$'
        or pg_catalog.jsonb_typeof(result_record -> 'validatedFoodDocument') <> 'string' then
        raise exception 'valid catalogue record lacks contract-version-1 frozen food evidence'
          using errcode = '23514';
      end if;
      validated_food_document_value := result_record ->> 'validatedFoodDocument';
      if pg_catalog.octet_length(validated_food_document_value) not between 1 and 2097152 then
        raise exception 'validated food document is empty or too large'
          using errcode = '22023';
      end if;
      begin
        if pg_catalog.jsonb_typeof(validated_food_document_value::jsonb) <> 'object' then
          raise exception 'validated food document must be a JSON object'
            using errcode = '22023';
        end if;
      exception when invalid_text_representation then
        raise exception 'validated food document must be valid JSON'
          using errcode = '22023';
      end;
      validated_food_sha256_value := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(validated_food_document_value, 'UTF8')),
        'hex'
      );
      if validated_food_sha256_value is distinct from digest_record ->> 'validatedFoodSha256' then
        raise exception 'validated food document digest differs'
          using errcode = '23514';
      end if;
      computed_valid_count := computed_valid_count + 1;
    else
      if digest_record -> 'validatedFoodContractVersion' <> 'null'::jsonb
        or digest_record -> 'validatedFoodSha256' <> 'null'::jsonb
        or result_record -> 'validatedFoodDocument' <> 'null'::jsonb then
        raise exception 'quarantined catalogue record cannot carry frozen food evidence'
          using errcode = '23514';
      end if;
      validated_food_document_value := null;
      validated_food_sha256_value := null;
      computed_quarantined_count := computed_quarantined_count + 1;
    end if;

    update food_import_record
    set validation_status = digest_record ->> 'status',
        validation_issues = issues_value,
        validated_at = validated_at_value,
        validated_food_document = validated_food_document_value,
        validated_food_sha256 = validated_food_sha256_value,
        validated_food_contract_version = case
          when digest_record ->> 'status' = 'valid' then 1
          else null
        end
    where id = staged_record.id and validation_status = 'pending';
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'catalogue staged record changed during validation'
        using errcode = '40001';
    end if;
    classified_count := classified_count + 1;
  end loop;

  if classified_count <> batch_row.staged_count
    or emitted_nutrient_total <> parser_row.emitted_nutrient_count
    or portion_input_total <> parser_row.emitted_portion_count then
    raise exception 'catalogue validation classification counts differ from parser evidence'
      using errcode = '23514';
  end if;
  computed_quarantined_count := computed_quarantined_count + parser_row.excluded_record_count;
  excluded_nutrient_total := excluded_nutrient_total + parser_row.excluded_nutrient_count;
  quarantine_fraction := case
    when parser_row.source_record_count = 0 then 1
    else computed_quarantined_count::numeric / parser_row.source_record_count::numeric
  end;
  excluded_nutrient_fraction := case
    when parser_row.source_nutrient_count = 0 then 1
    else excluded_nutrient_total::numeric / parser_row.source_nutrient_count::numeric
  end;
  if (validation_policy_value ->> 'requireAtLeastOneValidRecord')::boolean
    and computed_valid_count = 0 then
    computed_unresolved_error_count := computed_unresolved_error_count + 1;
  end if;
  if computed_quarantined_count > maximum_quarantined_records then
    computed_unresolved_error_count := computed_unresolved_error_count + 1;
  end if;
  if quarantine_fraction > maximum_quarantine_fraction then
    computed_unresolved_error_count := computed_unresolved_error_count + 1;
  end if;
  if excluded_nutrient_fraction > maximum_excluded_nutrient_fraction then
    computed_unresolved_error_count := computed_unresolved_error_count + 1;
  end if;
  if (validation_policy_value ->> 'requireMaterializedNutrientPerValidRecord')::boolean and exists (
    select 1
    from pg_catalog.jsonb_array_elements(digest_evidence -> 'records') as record(value)
    where record.value ->> 'status' = 'valid'
      and (record.value ->> 'nutrientMaterializableCount')::bigint = 0
  ) then
    computed_unresolved_error_count := computed_unresolved_error_count + 1;
  end if;

  update food_import_batch
  set quarantined_count = computed_quarantined_count,
      nutrient_excluded_count = excluded_nutrient_total,
      nutrient_input_count = parser_row.source_nutrient_count,
      nutrient_materializable_count = materializable_nutrient_total,
      status = case when computed_unresolved_error_count = 0 then 'ready' else 'quarantined' end,
      unresolved_error_count = computed_unresolved_error_count,
      valid_count = computed_valid_count,
      validated_at = validated_at_value,
      validation_digest = validation_digest_value,
      validated_food_contract_version = 1,
      nutrient_mapping_digest = digest_evidence ->> 'nutrientMappingDigest',
      nutrient_mapping_revision_ids = computed_mapping_revision_ids,
      validation_policy = validation_policy_value,
      warning_count = computed_warning_count,
      validated_database_principal = case
        when session_user::text = table_owner then null
        else session_user::text
      end,
      validated_database_capability_role = case
        when session_user::text = table_owner then null
        else 'nutrition_catalogue_validate'
      end
  where id = p_batch_id;

  return pg_catalog.jsonb_build_object(
    'excludedNutrientCount', excluded_nutrient_total,
    'nutrientInputCount', parser_row.source_nutrient_count,
    'nutrientMaterializableCount', materializable_nutrient_total,
    'nutrientMappingDigest', digest_evidence ->> 'nutrientMappingDigest',
    'promotionEligible', computed_unresolved_error_count = 0,
    'quarantinedCount', computed_quarantined_count,
    'recordErrorCount', record_error_total,
    'stagedCount', batch_row.staged_count,
    'unresolvedErrorCount', computed_unresolved_error_count,
    'validCount', computed_valid_count,
    'validationDigest', validation_digest_value,
    'warningCount', computed_warning_count,
    'wasAlreadyValidated', false
  );
end;
$$;

do $migration$
declare
  acl_grantee oid;
  acl_grantee_name name;
  function_oid oid;
  function_spec record;
  stage_role oid;
  table_owner oid;
  table_owner_name name;
  target_schema name := pg_catalog.current_schema();
  target_schema_oid oid;
  validate_role oid;
begin
  select namespace_row.oid, class_row.relowner, owner_role.rolname
  into target_schema_oid, table_owner, table_owner_name
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  join pg_catalog.pg_roles as owner_role
    on owner_role.oid = class_row.relowner
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');
  select role_row.oid into stage_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_stage';
  select role_row.oid into validate_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_validate';
  if target_schema_oid is null
    or table_owner is null
    or table_owner_name is null
    or stage_role is null
    or validate_role is null
    or table_owner is distinct from (
      select role_row.oid
      from pg_catalog.pg_roles as role_row
      where role_row.rolname = current_user
    ) then
    raise exception 'catalogue stage/validate hardening must run as the workflow owner'
      using errcode = '42501';
  end if;

  for function_spec in
    select *
    from (
      values
        ('guard_food_import_batch_stage_validate_authority()'::text, 'owner'::text),
        ('guard_food_import_record_insert_before_staging_seal()', 'owner'),
        ('guard_food_import_stage_checkpoint_before_staging_seal()', 'owner'),
        ('catalogue_compute_import_staging_seal(uuid)', 'owner'),
        ('catalogue_stage_import_batch(text)', 'stage'),
        ('catalogue_stage_import_record_chunk(uuid,bigint,text)', 'stage'),
        ('catalogue_stage_import_parser_report(uuid,text)', 'stage'),
        ('catalogue_observe_import_validation(uuid)', 'validate'),
        ('catalogue_validate_import_batch(uuid,text,text,text)', 'validate')
    ) as expected(function_identity, acl_kind)
  loop
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, function_spec.function_identity)
    );
    if function_oid is null then
      raise exception 'catalogue stage/validate function % is absent', function_spec.function_identity
        using errcode = '42883';
    end if;

    execute pg_catalog.format(
      'alter function %I.%s set search_path = pg_catalog, %I, pg_temp',
      target_schema,
      function_spec.function_identity,
      target_schema
    );
    execute pg_catalog.format(
      'alter function %I.%s owner to %I',
      target_schema,
      function_spec.function_identity,
      table_owner_name
    );
    execute pg_catalog.format(
      'revoke all on function %I.%s from public',
      target_schema,
      function_spec.function_identity
    );

    for acl_grantee in
      select distinct function_acl.grantee
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = function_oid
        and function_acl.grantee <> 0
    loop
      select role_row.rolname into acl_grantee_name
      from pg_catalog.pg_roles as role_row
      where role_row.oid = acl_grantee;
      if acl_grantee_name is null then
        raise exception 'catalogue stage/validate function % has an unknown ACL grantee',
          function_spec.function_identity using errcode = '55000';
      end if;
      execute pg_catalog.format(
        'revoke all on function %I.%s from %I',
        target_schema,
        function_spec.function_identity,
        acl_grantee_name
      );
    end loop;

    execute pg_catalog.format(
      'grant execute on function %I.%s to %I',
      target_schema,
      function_spec.function_identity,
      table_owner_name
    );
    if function_spec.acl_kind = 'stage' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_stage',
        target_schema,
        function_spec.function_identity
      );
    elsif function_spec.acl_kind = 'validate' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_validate',
        target_schema,
        function_spec.function_identity
      );
    end if;
  end loop;

  execute pg_catalog.format(
    'grant usage on schema %I to nutrition_catalogue_stage, nutrition_catalogue_validate',
    target_schema
  );
end;
$migration$;

comment on column food_import_batch.staged_database_principal is
  'Authenticated database login that created the capability-mediated staging attempt; NULL is owner/local compatibility.';
comment on column food_import_batch.staged_database_capability_role is
  'Fixed stage capability used by the authenticated database principal; NULL is owner/local compatibility.';
comment on column food_import_batch.staging_seal_sha256 is
  'Database-computed digest binding the stage-owned parser report, contiguous record set, provenance, and mapping revisions.';
comment on column food_import_batch.staging_sealed_at is
  'One-time database timestamp after which staged records and the stage checkpoint are immutable.';
comment on column food_import_batch.validated_database_principal is
  'Distinct authenticated database login that finalized capability-mediated validation; NULL is owner/local compatibility.';
comment on column food_import_batch.validated_database_capability_role is
  'Fixed validate capability used by the authenticated database principal; NULL is owner/local compatibility.';
comment on function catalogue_stage_import_batch(text) is
  'Create or exactly resume one bounded catalogue staging attempt under database-authenticated stage authority.';
comment on function catalogue_stage_import_record_chunk(uuid,bigint,text) is
  'Atomically append or replay one contiguous maximum-250-record chunk and its stage checkpoint.';
comment on function catalogue_stage_import_parser_report(uuid,text) is
  'Persist immutable parser evidence and a database-computed stage seal under the original stager identity.';
comment on function catalogue_observe_import_validation(uuid) is
  'Return a digest-bound locked validation observation to a distinct database-authenticated validator.';
comment on function catalogue_validate_import_batch(uuid,text,text,text) is
  'Atomically classify the exact sealed record set and freeze validation evidence under a distinct validator identity.';

do $migration$
declare
  capability_role oid;
  expected_acl_count integer;
  function_oid oid;
  function_spec record;
  schema_owner oid;
  stage_role oid;
  table_owner oid;
  target_schema name := pg_catalog.current_schema();
  target_schema_oid oid;
  validate_role oid;
begin
  select namespace_row.oid, namespace_row.nspowner, class_row.relowner
  into target_schema_oid, schema_owner, table_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');
  select role_row.oid into stage_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_stage';
  select role_row.oid into validate_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = 'nutrition_catalogue_validate';
  if target_schema_oid is null
    or schema_owner is null
    or table_owner is null
    or stage_role is null
    or validate_role is null then
    raise exception 'catalogue stage/validate postflight identities are absent'
      using errcode = '55000';
  end if;

  for function_spec in
    select *
    from (
      values
        ('guard_food_import_batch_stage_validate_authority()'::text, 'trigger'::text, false, 'owner'::text),
        ('guard_food_import_record_insert_before_staging_seal()', 'trigger', false, 'owner'),
        ('guard_food_import_stage_checkpoint_before_staging_seal()', 'trigger', false, 'owner'),
        ('catalogue_compute_import_staging_seal(uuid)', 'text', true, 'owner'),
        ('catalogue_stage_import_batch(text)', 'jsonb', true, 'stage'),
        ('catalogue_stage_import_record_chunk(uuid,bigint,text)', 'jsonb', true, 'stage'),
        ('catalogue_stage_import_parser_report(uuid,text)', 'jsonb', true, 'stage'),
        ('catalogue_observe_import_validation(uuid)', 'jsonb', true, 'validate'),
        ('catalogue_validate_import_batch(uuid,text,text,text)', 'jsonb', true, 'validate')
    ) as expected(function_identity, result_type, security_definer, acl_kind)
  loop
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, function_spec.function_identity)
    );
    if function_oid is null or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_language as language_row
        on language_row.oid = procedure_row.prolang
      where procedure_row.oid = function_oid
        and (
          procedure_row.proowner <> table_owner
          or pg_catalog.pg_get_function_result(procedure_row.oid) <> function_spec.result_type
          or language_row.lanname <> 'plpgsql'
          or procedure_row.prokind <> 'f'
          or procedure_row.provolatile <> 'v'
          or procedure_row.proisstrict
          or procedure_row.proleakproof
          or procedure_row.proparallel <> 'u'
          or procedure_row.proretset
          or procedure_row.pronargdefaults <> 0
          or procedure_row.prosecdef <> function_spec.security_definer
          or procedure_row.proconfig is distinct from array[
            pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
          ]
        )
    ) then
      raise exception 'catalogue stage/validate function % failed structural attestation',
        function_spec.function_identity using errcode = '55000';
    end if;

    expected_acl_count := case when function_spec.acl_kind = 'owner' then 1 else 2 end;
    if (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = function_oid
    ) <> expected_acl_count or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = function_oid
        and (
          function_acl.grantor <> table_owner
          or function_acl.privilege_type <> 'EXECUTE'
          or function_acl.is_grantable
          or not (
            function_acl.grantee = table_owner
            or (function_spec.acl_kind = 'stage' and function_acl.grantee = stage_role)
            or (function_spec.acl_kind = 'validate' and function_acl.grantee = validate_role)
          )
        )
    ) then
      raise exception 'catalogue stage/validate function % failed exact ACL attestation',
        function_spec.function_identity using errcode = '55000';
    end if;
  end loop;

  foreach capability_role in array array[stage_role, validate_role] loop
    if (
      select pg_catalog.count(*)
      from pg_catalog.pg_namespace as namespace_row
      cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as schema_acl
      where namespace_row.oid = target_schema_oid
        and schema_acl.grantee = capability_role
    ) <> 1 or not exists (
      select 1
      from pg_catalog.pg_namespace as namespace_row
      cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as schema_acl
      where namespace_row.oid = target_schema_oid
        and schema_acl.grantee = capability_role
        and schema_acl.grantor = schema_owner
        and schema_acl.privilege_type = 'USAGE'
        and not schema_acl.is_grantable
    ) then
      raise exception 'catalogue stage/validate schema usage failed exact ACL attestation'
        using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    cross join lateral pg_catalog.aclexplode(class_row.relacl) as object_acl
    where namespace_row.oid = target_schema_oid
      and object_acl.grantee in (stage_role, validate_role)
  ) or exists (
    select 1
    from pg_catalog.pg_attribute as attribute_row
    join pg_catalog.pg_class as class_row
      on class_row.oid = attribute_row.attrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute_row.attacl) as column_acl
    where namespace_row.oid = target_schema_oid
      and not attribute_row.attisdropped
      and column_acl.grantee in (stage_role, validate_role)
  ) then
    raise exception 'catalogue stage/validate roles received forbidden table, column, or sequence privileges'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    where membership.roleid in (stage_role, validate_role)
       or membership.member in (stage_role, validate_role)
  ) then
    raise exception 'catalogue stage/validate roles cannot participate in role memberships'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_attribute as attribute_row
    where attribute_row.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('%I.food_import_batch', target_schema)
      )
      and not attribute_row.attisdropped
      and attribute_row.attname in (
        'staged_database_principal', 'staged_database_capability_role',
        'staging_seal_sha256', 'staging_sealed_at',
        'validated_database_principal', 'validated_database_capability_role'
      )
  ) <> 6 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = pg_catalog.to_regclass(
        pg_catalog.format('%I.food_import_batch', target_schema)
      )
      and constraint_row.conname in (
        'food_import_batch_stage_validate_database_authority_check',
        'food_import_batch_staging_seal_check'
      )
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
  ) <> 2 then
    raise exception 'catalogue stage/validate columns or constraints failed postflight attestation'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from (
      values
        (
          'food_import_batch_guard_stage_validate_authority'::text,
          'food_import_batch'::text,
          'guard_food_import_batch_stage_validate_authority'::text,
          'CREATE TRIGGER food_import_batch_guard_stage_validate_authority BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_stage_validate_authority()'::text
        ),
        (
          'food_import_record_guard_staging_seal',
          'food_import_record',
          'guard_food_import_record_insert_before_staging_seal',
          'CREATE TRIGGER food_import_record_guard_staging_seal BEFORE INSERT ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_insert_before_staging_seal()'
        ),
        (
          'food_import_checkpoint_guard_staging_seal',
          'food_import_checkpoint',
          'guard_food_import_stage_checkpoint_before_staging_seal',
          'CREATE TRIGGER food_import_checkpoint_guard_staging_seal BEFORE INSERT OR DELETE OR UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION guard_food_import_stage_checkpoint_before_staging_seal()'
        ),
        (
          'food_import_parser_report_reject_update',
          'food_import_parser_report',
          'reject_immutable_row_update',
          'CREATE TRIGGER food_import_parser_report_reject_update BEFORE DELETE OR UPDATE ON food_import_parser_report FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()'
        ),
        (
          'food_import_checkpoint_set_updated_at',
          'food_import_checkpoint',
          'set_row_updated_at',
          'CREATE TRIGGER food_import_checkpoint_set_updated_at BEFORE UPDATE ON food_import_checkpoint FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()'
        )
    ) as expected(trigger_name, table_name, function_name, trigger_definition)
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = target_schema_oid
      and class_row.relname = expected.table_name
      and class_row.relkind in ('r', 'p')
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    where trigger_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or procedure_row.pronamespace <> target_schema_oid
      or procedure_row.proname <> expected.function_name
      or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) <> ''
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.trigger_definition
  ) then
    raise exception 'catalogue stage/validate trigger postflight attestation failed'
      using errcode = '55000';
  end if;
end;
$migration$;
