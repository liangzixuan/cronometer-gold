-- Independently attest the exact 100-gram nutrient transformation frozen by
-- catalogue validation. This is a forward-only EXPAND hardening: old evidence
-- remains representable, but no unattested batch may cross a decision boundary.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-nutrition-semantic-recheck:v1')
);

-- Close the preflight race before inspecting in-flight validation state. The
-- established workflow acquires the batch before its records, so preserve that
-- order while blocking concurrent stage/validate transitions for this transaction.
lock table food_import_batch in access exclusive mode;
lock table food_import_record in access exclusive mode;

do $migration$
declare
  capability_role text;
  capability_role_oid oid;
  function_identity text;
  function_oid oid;
  table_owner oid;
  target_schema name := pg_catalog.current_schema();
begin
  if target_schema is null then
    raise exception 'catalogue nutrition semantic migration requires a current schema'
      using errcode = '55000';
  end if;
  select class_row.relowner into table_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_batch'
    and class_row.relkind in ('r', 'p');
  if table_owner is null
    or table_owner is distinct from (
      select class_row.relowner
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row on namespace_row.oid = class_row.relnamespace
      where namespace_row.nspname = target_schema
        and class_row.relname = 'food_import_record'
        and class_row.relkind in ('r', 'p')
    )
    or table_owner is distinct from (
      select role_row.oid from pg_catalog.pg_roles as role_row
      where role_row.rolname = current_user
    ) then
    raise exception 'catalogue nutrition semantic migration must run as the workflow-table owner'
      using errcode = '42501';
  end if;

  foreach capability_role in array array[
    'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
    'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
    'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ] loop
    select role_row.oid into capability_role_oid
    from pg_catalog.pg_roles as role_row where role_row.rolname = capability_role;
    if capability_role_oid is null or exists (
      select 1 from pg_catalog.pg_roles as role_row
      where role_row.oid = capability_role_oid
        and (role_row.rolcanlogin or role_row.rolsuper or role_row.rolcreatedb
          or role_row.rolcreaterole or role_row.rolreplication or role_row.rolbypassrls)
    ) then
      raise exception 'catalogue capability role % is absent or unsafe', capability_role
        using errcode = '55000';
    end if;
  end loop;

  foreach function_identity in array array[
    'catalogue_validate_import_batch(uuid,text,text,text)',
    'catalogue_record_import_approval(uuid,text,text,text,text,text)',
    'catalogue_promote_import_batch(uuid,text,text)',
    'catalogue_rollback_source_release(text,uuid,text,text)'
  ] loop
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, function_identity)
    );
    if function_oid is null or exists (
      select 1 from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid = function_oid
        and (procedure_row.proowner <> table_owner or not procedure_row.prosecdef)
    ) then
      raise exception 'catalogue authority function % is absent or has unexpected authority',
        function_identity using errcode = '55000';
    end if;
  end loop;

  if exists (select 1 from food_import_batch where status in ('ready', 'promoting')) then
    raise exception 'catalogue nutrition semantic migration found an unattested ready or promoting batch'
      using errcode = '55000',
        hint = 'Resolve or fail the in-flight attempt; never fabricate semantic evidence.';
  end if;
end;
$migration$;

alter table food_import_record
  add column nutrition_semantic_contract_version smallint,
  add column nutrition_semantic_sha256 text,
  add constraint food_import_record_nutrition_semantic_contract_check check (
    ((nutrition_semantic_contract_version is null and nutrition_semantic_sha256 is null)
      or (nutrition_semantic_contract_version = 1
        and nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
        and validated_at is not null
        and validation_status in ('quarantined', 'valid', 'materialized'))) is true
  );

alter table food_import_batch
  add column nutrition_semantic_contract_version smallint,
  add column nutrition_semantic_sha256 text,
  add constraint food_import_batch_nutrition_semantic_contract_check check (
    ((nutrition_semantic_contract_version is null and nutrition_semantic_sha256 is null)
      or (nutrition_semantic_contract_version = 1
        and nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
        and validated_at is not null
        and status in ('quarantined', 'ready', 'promoting', 'completed'))) is true
  );

create function guard_food_import_record_nutrition_semantics()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.nutrition_semantic_contract_version is not null
      or new.nutrition_semantic_sha256 is not null then
      raise exception 'new catalogue record cannot carry precomputed nutrition semantic evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if row(new.nutrition_semantic_contract_version, new.nutrition_semantic_sha256)
    is distinct from row(old.nutrition_semantic_contract_version, old.nutrition_semantic_sha256) then
    if old.nutrition_semantic_contract_version is not null
      or old.nutrition_semantic_sha256 is not null then
      raise exception 'catalogue record nutrition semantic evidence cannot be rewritten'
        using errcode = '55000';
    end if;
    if new.nutrition_semantic_contract_version is distinct from 1
      or new.nutrition_semantic_sha256 !~ '^[0-9a-f]{64}$'
      or new.validated_at is null
      or new.validation_status not in ('quarantined', 'valid', 'materialized') then
      raise exception 'catalogue record nutrition semantic evidence is incomplete'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create function guard_food_import_batch_nutrition_semantics()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.nutrition_semantic_contract_version is not null
      or new.nutrition_semantic_sha256 is not null then
      raise exception 'new catalogue batch cannot carry precomputed nutrition semantic evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if row(new.nutrition_semantic_contract_version, new.nutrition_semantic_sha256)
    is distinct from row(old.nutrition_semantic_contract_version, old.nutrition_semantic_sha256) then
    if old.nutrition_semantic_contract_version is not null
      or old.nutrition_semantic_sha256 is not null then
      raise exception 'catalogue batch nutrition semantic evidence cannot be rewritten'
        using errcode = '55000';
    end if;
    if new.nutrition_semantic_contract_version is distinct from 1
      or new.nutrition_semantic_sha256 !~ '^[0-9a-f]{64}$'
      or new.validated_at is null
      or new.status not in ('quarantined', 'ready', 'promoting', 'completed') then
      raise exception 'catalogue batch nutrition semantic evidence is incomplete'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger food_import_record_guard_nutrition_semantics
before insert or update on food_import_record
for each row execute function guard_food_import_record_nutrition_semantics();
create trigger food_import_batch_guard_nutrition_semantics
before insert or update on food_import_batch
for each row execute function guard_food_import_batch_nutrition_semantics();

create function catalogue_canonical_decimal_product(p_left text, p_right text)
returns text language plpgsql immutable strict parallel safe as $$
declare
  product_value text;
begin
  if pg_catalog.octet_length(p_left) > 64
    or pg_catalog.octet_length(p_right) > 64
    or p_left !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$'
    or p_right !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' then
    raise exception 'catalogue nutrition decimal product requires unsigned decimal inputs'
      using errcode = '22023';
  end if;
  product_value := (p_left::numeric * p_right::numeric)::text;
  if pg_catalog.strpos(product_value, '.') > 0 then
    product_value := pg_catalog.rtrim(pg_catalog.rtrim(product_value, '0'), '.');
  end if;
  return case when product_value = '' then '0' else product_value end;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'catalogue nutrition decimal product is outside the exact numeric domain'
    using errcode = '22003';
end;
$$;

create function catalogue_utf16_length(p_value text)
returns bigint language sql immutable strict parallel safe as $$
  select case when p_value = '' then 0 else (
    select pg_catalog.sum(case
      when pg_catalog.ascii(code_point.value) > 65535 then 2 else 1
    end)::bigint
    from pg_catalog.unnest(
      pg_catalog.string_to_array(p_value, null)
    ) as code_point(value)
  ) end
$$;

create function catalogue_compute_record_nutrition_semantics(p_record_id bigint)
returns jsonb language plpgsql security definer as $$
declare
  accepted_nutrient_codes text[] := array[]::text[];
  amount_json_type text;
  amount_text text;
  basis_is_exact_100g boolean;
  converted_amount text;
  data_points jsonb;
  data_points_numeric numeric;
  derivation_code text;
  detection_limit jsonb;
  detection_limit_text text;
  ecmascript_whitespace_pattern text;
  expected_nutrient jsonb;
  expected_nutrients jsonb := '[]'::jsonb;
  excluded_nutrient_count bigint := 0;
  food_source_id_value bigint;
  frozen_mapping_revision_ids jsonb;
  mapped_canonical_unit text;
  mapped_conversion_multiplier text;
  mapped_nutrient_code text;
  mapped_nutrient_id bigint;
  mapped_revision_id uuid;
  mapped_source_unit text;
  nutrient_entry jsonb;
  nutrient_input jsonb;
  nutrient_input_count bigint := 0;
  nutrient_materializable_count bigint := 0;
  original_unit text;
  provenance_entry jsonb;
  record_row food_import_record%rowtype;
  source_name text;
  source_nutrient_id text;
  table_owner text;
  value_entry jsonb;
begin
  ecmascript_whitespace_pattern := '[' ||
    pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) ||
    pg_catalog.chr(12) || pg_catalog.chr(13) || pg_catalog.chr(32) ||
    pg_catalog.chr(160) || pg_catalog.chr(5760) ||
    pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) ||
    pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197) ||
    pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200) ||
    pg_catalog.chr(8201) || pg_catalog.chr(8202) ||
    pg_catalog.chr(8232) || pg_catalog.chr(8233) || pg_catalog.chr(8239) ||
    pg_catalog.chr(8287) || pg_catalog.chr(12288) || pg_catalog.chr(65279) || ']+';
  select pg_catalog.pg_get_userbyid(class_row.relowner) into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_record'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue nutrition semantic function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  select * into record_row from food_import_record where id = p_record_id;
  if not found then
    raise exception 'catalogue nutrition semantic computation references an unknown record'
      using errcode = '23503';
  end if;
  select batch.food_source_id, batch.nutrient_mapping_revision_ids
  into food_source_id_value, frozen_mapping_revision_ids
  from food_import_batch as batch where batch.id = record_row.batch_id;
  if not found then
    raise exception 'catalogue nutrition semantic computation references an unknown batch'
      using errcode = '23503';
  end if;

  basis_is_exact_100g := coalesce((
    pg_catalog.jsonb_typeof(record_row.canonical_payload) = 'object'
    and pg_catalog.jsonb_typeof(record_row.canonical_payload -> 'basis') = 'object'
    and pg_catalog.jsonb_typeof(record_row.canonical_payload #> '{basis,unit}') = 'string'
    and record_row.canonical_payload #>> '{basis,unit}' = 'g'
    and case pg_catalog.jsonb_typeof(record_row.canonical_payload #> '{basis,amount}')
      when 'number' then record_row.canonical_payload #> '{basis,amount}' = '100'::jsonb
      when 'string' then record_row.canonical_payload #>> '{basis,amount}' = '100'
      else false
    end
  ), false);
  nutrient_input := case
    when pg_catalog.jsonb_typeof(record_row.canonical_payload -> 'nutrients') = 'array'
      then record_row.canonical_payload -> 'nutrients'
    else '[]'::jsonb
  end;
  nutrient_input_count := pg_catalog.jsonb_array_length(nutrient_input);

  for nutrient_entry in
    select entry.value from pg_catalog.jsonb_array_elements(nutrient_input) as entry(value)
  loop
    if pg_catalog.jsonb_typeof(nutrient_entry) is distinct from 'object'
      or pg_catalog.jsonb_typeof(nutrient_entry -> 'sourceNutrientId') is distinct from 'string' then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    source_nutrient_id := pg_catalog.btrim(pg_catalog.regexp_replace(
      normalize(nutrient_entry ->> 'sourceNutrientId', NFC),
      ecmascript_whitespace_pattern, ' ', 'g'
    ), ' ');
    if catalogue_utf16_length(source_nutrient_id) not between 1 and 256 then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    select nutrient.canonical_unit, revision.conversion_multiplier::text,
      nutrient.code, nutrient.id, revision.id, revision.source_unit
    into mapped_canonical_unit, mapped_conversion_multiplier, mapped_nutrient_code,
      mapped_nutrient_id, mapped_revision_id, mapped_source_unit
    from source_nutrient_map_revision as revision
    join nutrient on nutrient.id = revision.nutrient_id
    where revision.food_source_id = food_source_id_value
      and revision.source_nutrient_key = source_nutrient_id
      and revision.id::text in (
        select frozen_revision.value
        from pg_catalog.jsonb_array_elements_text(
          coalesce(frozen_mapping_revision_ids, '[]'::jsonb)
        ) as frozen_revision(value)
      );
    if not found then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    if pg_catalog.jsonb_typeof(nutrient_entry -> 'originalUnit') is distinct from 'string' then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    original_unit := pg_catalog.btrim(pg_catalog.regexp_replace(
      normalize(nutrient_entry ->> 'originalUnit', NFC),
      ecmascript_whitespace_pattern, ' ', 'g'
    ), ' ');
    if catalogue_utf16_length(original_unit) not between 1 and 128
      or original_unit is distinct from mapped_source_unit then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    if mapped_nutrient_code = any(accepted_nutrient_codes) then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    value_entry := nutrient_entry -> 'value';
    if pg_catalog.jsonb_typeof(value_entry) is distinct from 'object'
      or pg_catalog.jsonb_typeof(nutrient_entry -> 'sourceName') is distinct from 'string' then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    source_name := pg_catalog.btrim(pg_catalog.regexp_replace(
      normalize(nutrient_entry ->> 'sourceName', NFC),
      ecmascript_whitespace_pattern, ' ', 'g'
    ), ' ');
    if catalogue_utf16_length(source_name) not between 1 and 2000 then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    if value_entry ->> 'state' = 'unknown' then
      continue;
    end if;

    provenance_entry := nutrient_entry -> 'provenance';
    if pg_catalog.jsonb_typeof(provenance_entry) is distinct from 'object'
      or not (provenance_entry ? 'derivationCode')
      or not (provenance_entry ? 'dataPoints') then
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    if provenance_entry -> 'derivationCode' = 'null'::jsonb then
      derivation_code := null;
    elsif pg_catalog.jsonb_typeof(provenance_entry -> 'derivationCode') = 'string' then
      derivation_code := pg_catalog.btrim(pg_catalog.regexp_replace(
        normalize(provenance_entry ->> 'derivationCode', NFC),
        ecmascript_whitespace_pattern, ' ', 'g'
      ), ' ');
      if catalogue_utf16_length(derivation_code) not between 1 and 128 then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
    else
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;

    data_points := provenance_entry -> 'dataPoints';
    if data_points = 'null'::jsonb then
      data_points_numeric := null;
    elsif pg_catalog.jsonb_typeof(data_points) = 'number'
      and pg_catalog.octet_length(data_points::text) <= 32 then
      data_points_numeric := data_points::text::numeric;
      if data_points_numeric <> pg_catalog.trunc(data_points_numeric)
        or data_points_numeric not between 0 and 2147483647 then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
    else
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;

    if value_entry ->> 'state' = 'known' then
      amount_json_type := pg_catalog.jsonb_typeof(value_entry -> 'amount');
      if amount_json_type is null or amount_json_type not in ('number', 'string') then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
      amount_text := value_entry ->> 'amount';
      if amount_json_type = 'number' then
        if pg_catalog.octet_length(amount_text) > 32
          or amount_text !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' then
          excluded_nutrient_count := excluded_nutrient_count + 1;
          continue;
        end if;
        if amount_text::numeric > 0 and amount_text::numeric < 0.000001 then
          excluded_nutrient_count := excluded_nutrient_count + 1;
          continue;
        end if;
        amount_text := catalogue_canonical_decimal_product(amount_text, '1');
      end if;
      if amount_text !~ '^(0|[1-9][0-9]*)([.]([0-9]*[1-9]))?$'
        or pg_catalog.char_length(pg_catalog.split_part(amount_text, '.', 1)) > 12
        or (pg_catalog.strpos(amount_text, '.') > 0
          and pg_catalog.char_length(pg_catalog.split_part(amount_text, '.', 2)) > 12)
        or value_entry ->> 'quality' is null
        or value_entry ->> 'quality' not in ('calculated', 'estimated', 'label', 'measured') then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
      converted_amount := catalogue_canonical_decimal_product(
        amount_text, mapped_conversion_multiplier
      );
      if converted_amount !~ '^(0|[1-9][0-9]*)([.]([0-9]*[1-9]))?$'
        or pg_catalog.char_length(pg_catalog.split_part(converted_amount, '.', 1)) > 12
        or (pg_catalog.strpos(converted_amount, '.') > 0
          and pg_catalog.char_length(pg_catalog.split_part(converted_amount, '.', 2)) > 12) then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
      expected_nutrient := pg_catalog.jsonb_build_object(
        'amount', converted_amount,
        'canonicalUnit', mapped_canonical_unit,
        'dataPoints', data_points,
        'derivationCode', derivation_code,
        'metadata', pg_catalog.jsonb_build_object(
          'dataPoints', data_points,
          'derivationCode', derivation_code,
          'mappingRevisionId', mapped_revision_id::text,
          'sourceName', source_name,
          'sourceNutrientId', source_nutrient_id,
          'sourceUnit', original_unit
        ),
        'mappingRevisionId', mapped_revision_id::text,
        'nutrientCode', mapped_nutrient_code,
        'nutrientId', mapped_nutrient_id::text,
        'sourceAmount', amount_text,
        'sourceBasisQuantity', '100',
        'sourceBasisUnit', 'g',
        'sourceName', source_name,
        'sourceNutrientId', source_nutrient_id,
        'sourceUnit', original_unit,
        'valueStatus', value_entry ->> 'quality'
      );
    elsif value_entry ->> 'state' = 'trace' then
      if not (value_entry ? 'detectionLimit') then
        excluded_nutrient_count := excluded_nutrient_count + 1;
        continue;
      end if;
      detection_limit := value_entry -> 'detectionLimit';
      if detection_limit <> 'null'::jsonb then
        amount_json_type := pg_catalog.jsonb_typeof(detection_limit);
        if amount_json_type is null or amount_json_type not in ('number', 'string') then
          excluded_nutrient_count := excluded_nutrient_count + 1;
          continue;
        end if;
        detection_limit_text := value_entry ->> 'detectionLimit';
        if amount_json_type = 'number' then
          if pg_catalog.octet_length(detection_limit_text) > 32
            or detection_limit_text !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' then
            excluded_nutrient_count := excluded_nutrient_count + 1;
            continue;
          end if;
          if detection_limit_text::numeric > 0
            and detection_limit_text::numeric < 0.000001 then
            excluded_nutrient_count := excluded_nutrient_count + 1;
            continue;
          end if;
          detection_limit_text := catalogue_canonical_decimal_product(detection_limit_text, '1');
        end if;
        if detection_limit_text !~ '^(0|[1-9][0-9]*)([.]([0-9]*[1-9]))?$'
          or detection_limit_text ~ '^0([.]0*)?$'
          or pg_catalog.char_length(pg_catalog.split_part(detection_limit_text, '.', 1)) > 12
          or (pg_catalog.strpos(detection_limit_text, '.') > 0
            and pg_catalog.char_length(pg_catalog.split_part(detection_limit_text, '.', 2)) > 12) then
          excluded_nutrient_count := excluded_nutrient_count + 1;
          continue;
        end if;
      end if;
      expected_nutrient := pg_catalog.jsonb_build_object(
        'amount', '0',
        'canonicalUnit', mapped_canonical_unit,
        'dataPoints', data_points,
        'derivationCode', derivation_code,
        'metadata', pg_catalog.jsonb_build_object(
          'dataPoints', data_points,
          'detectionLimit', detection_limit,
          'derivationCode', derivation_code,
          'mappingRevisionId', mapped_revision_id::text,
          'sourceName', source_name,
          'sourceNutrientId', source_nutrient_id,
          'sourceUnit', original_unit
        ),
        'mappingRevisionId', mapped_revision_id::text,
        'nutrientCode', mapped_nutrient_code,
        'nutrientId', mapped_nutrient_id::text,
        'sourceAmount', null,
        'sourceBasisQuantity', null,
        'sourceBasisUnit', null,
        'sourceName', source_name,
        'sourceNutrientId', source_nutrient_id,
        'sourceUnit', null,
        'valueStatus', 'trace'
      );
    else
      excluded_nutrient_count := excluded_nutrient_count + 1;
      continue;
    end if;
    accepted_nutrient_codes := pg_catalog.array_append(
      accepted_nutrient_codes, mapped_nutrient_code
    );
    expected_nutrients := expected_nutrients || pg_catalog.jsonb_build_array(expected_nutrient);
    nutrient_materializable_count := nutrient_materializable_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'basisIsExact100g', basis_is_exact_100g,
    'excludedNutrientCount', excluded_nutrient_count,
    'nutrientInputCount', nutrient_input_count,
    'nutrientMaterializableCount', nutrient_materializable_count,
    'nutrients', expected_nutrients,
    'schemaVersion', 1
  );
end;
$$;

alter function catalogue_validate_import_batch(uuid,text,text,text)
  rename to catalogue_validate_import_batch_v1;
alter function catalogue_record_import_approval(uuid,text,text,text,text,text)
  rename to catalogue_record_import_approval_v1;
alter function catalogue_promote_import_batch(uuid,text,text)
  rename to catalogue_promote_import_batch_v1;
alter function catalogue_rollback_source_release(text,uuid,text,text)
  rename to catalogue_rollback_source_release_v1;

create function catalogue_validate_import_batch(
  p_batch_id uuid,
  p_expected_staging_seal_sha256 text,
  p_expected_observation_sha256 text,
  p_validation_document text
)
returns jsonb language plpgsql security definer as $$
declare
  batch_row food_import_batch%rowtype;
  batch_semantic_document jsonb;
  batch_semantic_sha256 text;
  digest_evidence jsonb;
  digest_record jsonb;
  independently_excluded_count bigint := 0;
  independently_input_count bigint := 0;
  independently_materializable_count bigint := 0;
  parser_row food_import_parser_report%rowtype;
  record_row food_import_record%rowtype;
  record_semantics jsonb;
  record_semantic_document jsonb;
  record_semantic_rows jsonb;
  record_semantic_sha256 text;
  result jsonb;
  updated_count bigint;
  validated_food jsonb;
  validation_document jsonb;
begin
  result := catalogue_validate_import_batch_v1(
    p_batch_id, p_expected_staging_seal_sha256,
    p_expected_observation_sha256, p_validation_document
  );
  validation_document := p_validation_document::jsonb;
  digest_evidence := (validation_document ->> 'digestDocument')::jsonb;
  select * into strict batch_row
  from food_import_batch where id = p_batch_id for update;
  select * into strict parser_row
  from food_import_parser_report where batch_id = p_batch_id;

  for record_row in
    select * from food_import_record
    where batch_id = p_batch_id order by sequence_number for update
  loop
    select entry.value into strict digest_record
    from pg_catalog.jsonb_array_elements(digest_evidence -> 'records') as entry(value)
    where entry.value ->> 'sourceRecordKey' = record_row.source_record_key;
    record_semantics := catalogue_compute_record_nutrition_semantics(record_row.id);
    if record_semantics -> 'basisIsExact100g' <> 'true'::jsonb then
      raise exception 'catalogue nutrition semantic basis is not exactly 100 grams'
        using errcode = '55000';
    end if;
    if (digest_record ->> 'nutrientInputCount')::bigint <>
        (record_semantics ->> 'nutrientInputCount')::bigint
      or (digest_record ->> 'excludedNutrientCount')::bigint <>
        (record_semantics ->> 'excludedNutrientCount')::bigint
      or (digest_record ->> 'nutrientMaterializableCount')::bigint <> (case
        when digest_record ->> 'status' = 'valid'
          then (record_semantics ->> 'nutrientMaterializableCount')::bigint
        else 0
      end) then
      raise exception 'catalogue validation nutrient counts differ from independent database semantics'
        using errcode = '55000';
    end if;
    if digest_record ->> 'status' = 'valid' then
      validated_food := record_row.validated_food_document::jsonb;
      if pg_catalog.jsonb_typeof(validated_food -> 'basisQuantity') <> 'string'
        or validated_food ->> 'basisQuantity' <> '100'
        or pg_catalog.jsonb_typeof(validated_food -> 'nutrients') <> 'array'
        or validated_food -> 'nutrients' is distinct from record_semantics -> 'nutrients' then
        raise exception 'catalogue validated nutrient transformation differs from independent database semantics'
          using errcode = '55000';
      end if;
      independently_materializable_count := independently_materializable_count
        + (record_semantics ->> 'nutrientMaterializableCount')::bigint;
    end if;
    independently_input_count := independently_input_count
      + (record_semantics ->> 'nutrientInputCount')::bigint;
    independently_excluded_count := independently_excluded_count
      + (record_semantics ->> 'excludedNutrientCount')::bigint;

    record_semantic_document := pg_catalog.jsonb_build_object(
      'canonicalPayloadSha256', record_row.canonical_payload_sha256,
      'nutrition', record_semantics,
      'semanticDisposition', digest_record ->> 'status',
      'sourceRecordKey', record_row.source_record_key,
      'validatedFoodContractVersion', record_row.validated_food_contract_version,
      'validatedFoodSha256', record_row.validated_food_sha256,
      'schemaVersion', 1
    );
    record_semantic_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(record_semantic_document::text, 'UTF8')), 'hex'
    );
    if record_row.nutrition_semantic_contract_version is null
      and record_row.nutrition_semantic_sha256 is null then
      update food_import_record
      set nutrition_semantic_contract_version = 1,
          nutrition_semantic_sha256 = record_semantic_sha256
      where id = record_row.id
        and nutrition_semantic_contract_version is null
        and nutrition_semantic_sha256 is null;
      get diagnostics updated_count = row_count;
      if updated_count <> 1 then
        raise exception 'catalogue record nutrition semantic evidence changed concurrently'
          using errcode = '40001';
      end if;
    elsif record_row.nutrition_semantic_contract_version is distinct from 1
      or record_row.nutrition_semantic_sha256 is distinct from record_semantic_sha256 then
      raise exception 'catalogue nutrition semantic replay differs from frozen database evidence'
        using errcode = '55000';
    end if;
  end loop;

  if independently_input_count <> parser_row.emitted_nutrient_count
    or independently_excluded_count + parser_row.excluded_nutrient_count <>
      batch_row.nutrient_excluded_count
    or independently_materializable_count <> batch_row.nutrient_materializable_count then
    raise exception 'catalogue batch nutrient counts differ from independent database semantics'
      using errcode = '55000';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'nutritionSemanticSha256', record.nutrition_semantic_sha256,
    'sequenceNumber', record.sequence_number,
    'sourceRecordKey', record.source_record_key
  ) order by record.sequence_number), '[]'::jsonb)
  into record_semantic_rows
  from food_import_record as record where record.batch_id = p_batch_id;
  batch_semantic_document := pg_catalog.jsonb_build_object(
    'batchId', batch_row.id,
    'excludedNutrientCount', batch_row.nutrient_excluded_count,
    'nutrientInputCount', batch_row.nutrient_input_count,
    'nutrientMappingDigest', batch_row.nutrient_mapping_digest,
    'nutrientMappingRevisionIds', batch_row.nutrient_mapping_revision_ids,
    'nutrientMaterializableCount', batch_row.nutrient_materializable_count,
    'parserReportSha256', parser_row.report_sha256,
    'records', record_semantic_rows,
    'schemaVersion', 1,
    'stagingSealSha256', batch_row.staging_seal_sha256,
    'validationDigest', batch_row.validation_digest
  );
  batch_semantic_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(batch_semantic_document::text, 'UTF8')), 'hex'
  );
  if batch_row.nutrition_semantic_contract_version is null
    and batch_row.nutrition_semantic_sha256 is null then
    update food_import_batch
    set nutrition_semantic_contract_version = 1,
        nutrition_semantic_sha256 = batch_semantic_sha256
    where id = p_batch_id
      and nutrition_semantic_contract_version is null
      and nutrition_semantic_sha256 is null;
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'catalogue batch nutrition semantic evidence changed concurrently'
        using errcode = '40001';
    end if;
  elsif batch_row.nutrition_semantic_contract_version is distinct from 1
    or batch_row.nutrition_semantic_sha256 is distinct from batch_semantic_sha256 then
    raise exception 'catalogue nutrition semantic replay differs from frozen database evidence'
      using errcode = '55000';
  end if;
  return result;
end;
$$;

create function catalogue_record_import_approval(
  p_batch_id uuid,
  p_requested_approval_role text,
  p_validation_digest text,
  p_rights_digest text,
  p_external_principal_id text,
  p_approval_reference text
)
returns boolean language plpgsql security definer as $$
begin
  if exists (select 1 from food_import_batch where id = p_batch_id) then
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = p_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue approval requires prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(p_batch_id);
  end if;
  return catalogue_record_import_approval_v1(
    p_batch_id, p_requested_approval_role, p_validation_digest, p_rights_digest,
    p_external_principal_id, p_approval_reference
  );
end;
$$;

create function catalogue_promote_import_batch(
  p_batch_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb language plpgsql security definer as $$
begin
  if exists (select 1 from food_import_batch where id = p_batch_id) then
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = p_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue promotion requires prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(p_batch_id);
  end if;
  return catalogue_promote_import_batch_v1(p_batch_id, p_external_principal_id, p_reason);
end;
$$;

create function catalogue_rollback_source_release(
  p_source_code text,
  p_target_release_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb language plpgsql security definer as $$
declare
  attested_origin_count bigint;
  origin_batch_id uuid;
begin
  if p_target_release_id is not null and exists (
    select 1 from food_source_release as release
    join food_source as source on source.id = release.food_source_id
    where release.id = p_target_release_id and source.code = p_source_code
  ) then
    select pg_catalog.count(*), pg_catalog.min(batch.id::text)::uuid
    into attested_origin_count, origin_batch_id
    from food_source_release as release
    join food_source as source on source.id = release.food_source_id
    join food_source_release_activation as activation
      on activation.release_id = release.id
      and activation.food_source_id = release.food_source_id
      and activation.operation = 'activate'
      and activation.import_batch_id is not null
    join food_import_batch as batch
      on batch.id = activation.import_batch_id
      and batch.food_source_id = release.food_source_id
      and batch.release_id = release.id
    where release.id = p_target_release_id
      and source.code = p_source_code
      and batch.status = 'completed';
    if attested_origin_count <> 1 then
      raise exception 'catalogue rollback target lacks one completed nutrition semantic attestation'
        using errcode = '55000';
    end if;
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = origin_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue rollback target lacks prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(origin_batch_id);
  end if;
  return catalogue_rollback_source_release_v1(
    p_source_code, p_target_release_id, p_external_principal_id, p_reason
  );
end;
$$;

do $migration$
declare
  acl_grantee oid;
  acl_grantee_name name;
  function_oid oid;
  function_spec record;
  table_owner_name name;
  target_schema name := pg_catalog.current_schema();
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)::name into table_owner_name
  from pg_catalog.pg_class as class_row
  where class_row.oid = pg_catalog.to_regclass(
    pg_catalog.format('%I.food_import_batch', target_schema)
  );
  for function_spec in select * from (values
    ('guard_food_import_record_nutrition_semantics()'::text, 'owner'::text),
    ('guard_food_import_batch_nutrition_semantics()', 'owner'),
    ('catalogue_canonical_decimal_product(text,text)', 'owner'),
    ('catalogue_utf16_length(text)', 'owner'),
    ('catalogue_compute_record_nutrition_semantics(bigint)', 'owner'),
    ('catalogue_validate_import_batch_v1(uuid,text,text,text)', 'owner'),
    ('catalogue_record_import_approval_v1(uuid,text,text,text,text,text)', 'owner'),
    ('catalogue_promote_import_batch_v1(uuid,text,text)', 'owner'),
    ('catalogue_rollback_source_release_v1(text,uuid,text,text)', 'owner'),
    ('catalogue_validate_import_batch(uuid,text,text,text)', 'validate'),
    ('catalogue_record_import_approval(uuid,text,text,text,text,text)', 'approve'),
    ('catalogue_promote_import_batch(uuid,text,text)', 'promote'),
    ('catalogue_rollback_source_release(text,uuid,text,text)', 'rollback')
  ) as expected(function_identity, acl_kind)
  loop
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, function_spec.function_identity)
    );
    if function_oid is null then
      raise exception 'catalogue nutrition semantic function % is absent',
        function_spec.function_identity using errcode = '42883';
    end if;
    execute pg_catalog.format(
      'alter function %I.%s set search_path = pg_catalog, %I, pg_temp',
      target_schema, function_spec.function_identity, target_schema
    );
    execute pg_catalog.format(
      'alter function %I.%s owner to %I',
      target_schema, function_spec.function_identity, table_owner_name
    );
    execute pg_catalog.format(
      'revoke all on function %I.%s from public',
      target_schema, function_spec.function_identity
    );
    for acl_grantee in
      select distinct function_acl.grantee
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
      where procedure_row.oid = function_oid and function_acl.grantee <> 0
    loop
      select role_row.rolname into acl_grantee_name
      from pg_catalog.pg_roles as role_row where role_row.oid = acl_grantee;
      if acl_grantee_name is not null then
        execute pg_catalog.format(
          'revoke all on function %I.%s from %I',
          target_schema, function_spec.function_identity, acl_grantee_name
        );
      end if;
    end loop;
    execute pg_catalog.format(
      'grant execute on function %I.%s to %I',
      target_schema, function_spec.function_identity, table_owner_name
    );
    if function_spec.acl_kind = 'validate' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_validate',
        target_schema, function_spec.function_identity
      );
    elsif function_spec.acl_kind = 'approve' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights',
        target_schema, function_spec.function_identity
      );
    elsif function_spec.acl_kind = 'promote' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_promote_activate',
        target_schema, function_spec.function_identity
      );
    elsif function_spec.acl_kind = 'rollback' then
      execute pg_catalog.format(
        'grant execute on function %I.%s to nutrition_catalogue_rollback',
        target_schema, function_spec.function_identity
      );
    end if;
  end loop;
end;
$migration$;

comment on column food_import_record.nutrition_semantic_contract_version is
  'Version of the independent database nutrition transformation attestation; NULL predates or has not completed 0021 validation.';
comment on column food_import_record.nutrition_semantic_sha256 is
  'SHA-256 of database-derived exact 100-gram nutrient semantics and the frozen validation disposition.';
comment on column food_import_batch.nutrition_semantic_contract_version is
  'Version of the batch-wide independent database nutrition semantic attestation.';
comment on column food_import_batch.nutrition_semantic_sha256 is
  'SHA-256 binding record semantics, mapping revisions, parser evidence, staging seal, and validation digest.';
comment on function catalogue_compute_record_nutrition_semantics(bigint) is
  'Independently derive exact contract-v1 100-gram nutrients from sealed canonical payload and frozen reviewed mapping revisions.';
comment on function catalogue_utf16_length(text) is
  'Count JavaScript-compatible UTF-16 code units for bounded canonical nutrition text.';
comment on function catalogue_validate_import_batch(uuid,text,text,text) is
  'Validate through the prior authority path, independently recheck exact 100-gram nutrient semantics, and freeze immutable attestations.';
comment on function catalogue_record_import_approval(uuid,text,text,text,text,text) is
  'Record a reviewer decision only for a batch with complete nutrition semantic attestation.';
comment on function catalogue_promote_import_batch(uuid,text,text) is
  'Promote or replay only a batch with complete nutrition semantic attestation.';
comment on function catalogue_rollback_source_release(text,uuid,text,text) is
  'Reactivate only a release whose single completed origin has complete nutrition semantic attestation.';

create function catalogue_attest_import_nutrition_semantics(p_batch_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  batch_row food_import_batch%rowtype;
  batch_semantic_document jsonb;
  batch_semantic_sha256 text;
  freeze_semantics boolean;
  independently_excluded_count bigint := 0;
  independently_input_count bigint := 0;
  independently_materializable_count bigint := 0;
  parser_row food_import_parser_report%rowtype;
  record_count bigint := 0;
  record_row food_import_record%rowtype;
  record_semantics jsonb;
  record_semantic_document jsonb;
  record_semantic_rows jsonb;
  record_semantic_sha256 text;
  semantic_disposition text;
  source_row food_source%rowtype;
  table_owner text;
  updated_count bigint;
  validated_food jsonb;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner) into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if current_user::text <> table_owner then
    raise exception 'catalogue nutrition attestation function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  select * into batch_row from food_import_batch
  where id = p_batch_id for update;
  if not found then
    raise exception 'catalogue nutrition semantic attestation references an unknown batch'
      using errcode = '23503';
  end if;
  if batch_row.validated_at is null
    or batch_row.status is null
    or batch_row.status not in ('quarantined', 'ready', 'promoting', 'completed')
    or batch_row.validated_food_contract_version is distinct from 1
    or coalesce(batch_row.nutrient_mapping_digest ~ '^[0-9a-f]{64}$', false) is not true
    or pg_catalog.jsonb_typeof(batch_row.nutrient_mapping_revision_ids)
      is distinct from 'array' then
    raise exception 'catalogue nutrition semantic attestation requires complete frozen validation evidence'
      using errcode = '55000';
  end if;
  freeze_semantics := batch_row.nutrition_semantic_contract_version is null
    and batch_row.nutrition_semantic_sha256 is null;
  if freeze_semantics and batch_row.status not in ('quarantined', 'ready') then
    raise exception 'catalogue nutrition semantic attestation cannot backfill a completed or promoting batch'
      using errcode = '55000';
  elsif not freeze_semantics and (
    batch_row.nutrition_semantic_contract_version is distinct from 1
    or coalesce(batch_row.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$', false)
      is not true
  ) then
    raise exception 'catalogue nutrition semantic verification requires prior batch attestation'
      using errcode = '55000';
  end if;
  select * into source_row from food_source
  where id = batch_row.food_source_id for update;
  if not found then
    raise exception 'catalogue nutrition semantic attestation source is unavailable'
      using errcode = '23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-source:v1'),
    pg_catalog.hashtext(source_row.id::text)
  );
  perform lock_active_nutrient_registry_for_read();
  select * into parser_row from food_import_parser_report where batch_id = p_batch_id;
  if not found then
    raise exception 'catalogue nutrition semantic attestation requires parser evidence'
      using errcode = '23514';
  end if;

  for record_row in
    select * from food_import_record
    where batch_id = p_batch_id order by sequence_number for update
  loop
    record_count := record_count + 1;
    if record_row.validation_status not in ('quarantined', 'valid', 'materialized')
      or record_row.validated_at is null then
      raise exception 'catalogue nutrition semantic attestation found an unclassified record'
        using errcode = '55000';
    end if;
    if freeze_semantics then
      if record_row.nutrition_semantic_contract_version is not null
        or record_row.nutrition_semantic_sha256 is not null then
        raise exception 'catalogue nutrition semantic first freeze found prior record attestation'
          using errcode = '55000';
      end if;
    elsif record_row.nutrition_semantic_contract_version is distinct from 1
      or coalesce(record_row.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$', false)
        is not true then
      raise exception 'catalogue nutrition semantic verification requires prior record attestation'
        using errcode = '55000';
    end if;
    record_semantics := catalogue_compute_record_nutrition_semantics(record_row.id);
    semantic_disposition := case
      when record_row.validation_status in ('valid', 'materialized') then 'valid'
      else 'quarantined'
    end;
    if semantic_disposition = 'valid' then
      if record_semantics -> 'basisIsExact100g' <> 'true'::jsonb then
        raise exception 'catalogue nutrition semantic basis is not exactly 100 grams'
          using errcode = '55000';
      end if;
      if record_row.validated_food_document is null
        or record_row.validated_food_contract_version is distinct from 1
        or coalesce(record_row.validated_food_sha256 ~ '^[0-9a-f]{64}$', false)
          is not true then
        raise exception 'catalogue nutrition semantic attestation lacks frozen food evidence'
          using errcode = '55000';
      end if;
      validated_food := record_row.validated_food_document::jsonb;
      if pg_catalog.jsonb_typeof(validated_food -> 'basisQuantity') is distinct from 'string'
        or validated_food ->> 'basisQuantity' is distinct from '100'
        or pg_catalog.jsonb_typeof(validated_food -> 'nutrients') is distinct from 'array'
        or validated_food -> 'nutrients' is distinct from record_semantics -> 'nutrients' then
        raise exception 'catalogue validated nutrient transformation differs from independent database semantics'
          using errcode = '55000';
      end if;
      independently_materializable_count := independently_materializable_count
        + (record_semantics ->> 'nutrientMaterializableCount')::bigint;
    elsif record_row.validated_food_document is not null
      or record_row.validated_food_contract_version is not null
      or record_row.validated_food_sha256 is not null then
      raise exception 'quarantined catalogue record cannot carry nutrition materialization evidence'
        using errcode = '55000';
    end if;
    independently_input_count := independently_input_count
      + (record_semantics ->> 'nutrientInputCount')::bigint;
    independently_excluded_count := independently_excluded_count
      + (record_semantics ->> 'excludedNutrientCount')::bigint;

    record_semantic_document := pg_catalog.jsonb_build_object(
      'canonicalPayloadSha256', record_row.canonical_payload_sha256,
      'nutrition', record_semantics,
      'semanticDisposition', semantic_disposition,
      'sourceRecordKey', record_row.source_record_key,
      'validatedFoodContractVersion', record_row.validated_food_contract_version,
      'validatedFoodSha256', record_row.validated_food_sha256,
      'schemaVersion', 1
    );
    record_semantic_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(record_semantic_document::text, 'UTF8')), 'hex'
    );
    if freeze_semantics then
      update food_import_record
      set nutrition_semantic_contract_version = 1,
          nutrition_semantic_sha256 = record_semantic_sha256
      where id = record_row.id
        and nutrition_semantic_contract_version is null
        and nutrition_semantic_sha256 is null;
      get diagnostics updated_count = row_count;
      if updated_count <> 1 then
        raise exception 'catalogue record nutrition semantic evidence changed concurrently'
          using errcode = '40001';
      end if;
    elsif record_row.nutrition_semantic_contract_version is distinct from 1
      or record_row.nutrition_semantic_sha256 is distinct from record_semantic_sha256 then
      raise exception 'catalogue nutrition semantic replay differs from frozen database evidence'
        using errcode = '55000';
    end if;
  end loop;

  if record_count <> batch_row.staged_count
    or record_count <> parser_row.emitted_record_count
    or independently_input_count <> parser_row.emitted_nutrient_count
    or batch_row.nutrient_input_count <> parser_row.source_nutrient_count
    or independently_excluded_count + parser_row.excluded_nutrient_count <>
      batch_row.nutrient_excluded_count
    or independently_materializable_count <> batch_row.nutrient_materializable_count then
    raise exception 'catalogue batch nutrient counts differ from independent database semantics'
      using errcode = '55000';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'nutritionSemanticSha256', record.nutrition_semantic_sha256,
    'sequenceNumber', record.sequence_number,
    'sourceRecordKey', record.source_record_key
  ) order by record.sequence_number), '[]'::jsonb)
  into record_semantic_rows
  from food_import_record as record where record.batch_id = p_batch_id;
  batch_semantic_document := pg_catalog.jsonb_build_object(
    'batchId', batch_row.id,
    'excludedNutrientCount', batch_row.nutrient_excluded_count,
    'nutrientInputCount', batch_row.nutrient_input_count,
    'nutrientMappingDigest', batch_row.nutrient_mapping_digest,
    'nutrientMappingRevisionIds', batch_row.nutrient_mapping_revision_ids,
    'nutrientMaterializableCount', batch_row.nutrient_materializable_count,
    'parserReportSha256', parser_row.report_sha256,
    'records', record_semantic_rows,
    'schemaVersion', 1,
    'stagingSealSha256', batch_row.staging_seal_sha256,
    'validationDigest', batch_row.validation_digest
  );
  batch_semantic_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(batch_semantic_document::text, 'UTF8')), 'hex'
  );
  if freeze_semantics then
    update food_import_batch
    set nutrition_semantic_contract_version = 1,
        nutrition_semantic_sha256 = batch_semantic_sha256
    where id = p_batch_id
      and nutrition_semantic_contract_version is null
      and nutrition_semantic_sha256 is null;
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'catalogue batch nutrition semantic evidence changed concurrently'
        using errcode = '40001';
    end if;
  elsif batch_row.nutrition_semantic_contract_version is distinct from 1
    or batch_row.nutrition_semantic_sha256 is distinct from batch_semantic_sha256 then
    raise exception 'catalogue nutrition semantic replay differs from frozen database evidence'
      using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object(
    'excludedNutrientCount', batch_row.nutrient_excluded_count,
    'nutrientInputCount', batch_row.nutrient_input_count,
    'nutrientMaterializableCount', batch_row.nutrient_materializable_count,
    'nutritionSemanticContractVersion', 1,
    'nutritionSemanticSha256', batch_semantic_sha256
  );
end;
$$;

create or replace function catalogue_validate_import_batch(
  p_batch_id uuid,
  p_expected_staging_seal_sha256 text,
  p_expected_observation_sha256 text,
  p_validation_document text
)
returns jsonb language plpgsql security definer as $$
declare
  attestation jsonb;
  digest_evidence jsonb;
  digest_record jsonb;
  record_row food_import_record%rowtype;
  record_semantics jsonb;
  result jsonb;
  validation_document jsonb;
begin
  result := catalogue_validate_import_batch_v1(
    p_batch_id, p_expected_staging_seal_sha256,
    p_expected_observation_sha256, p_validation_document
  );
  validation_document := p_validation_document::jsonb;
  digest_evidence := (validation_document ->> 'digestDocument')::jsonb;
  for record_row in
    select * from food_import_record
    where batch_id = p_batch_id order by sequence_number
  loop
    select entry.value into strict digest_record
    from pg_catalog.jsonb_array_elements(digest_evidence -> 'records') as entry(value)
    where entry.value ->> 'sourceRecordKey' = record_row.source_record_key;
    record_semantics := catalogue_compute_record_nutrition_semantics(record_row.id);
    if (digest_record ->> 'nutrientInputCount')::bigint <>
        (record_semantics ->> 'nutrientInputCount')::bigint
      or (digest_record ->> 'excludedNutrientCount')::bigint <>
        (record_semantics ->> 'excludedNutrientCount')::bigint
      or (digest_record ->> 'nutrientMaterializableCount')::bigint <> (case
        when digest_record ->> 'status' = 'valid'
          then (record_semantics ->> 'nutrientMaterializableCount')::bigint
        else 0
      end) then
      raise exception 'catalogue validation nutrient counts differ from independent database semantics'
        using errcode = '55000';
    end if;
  end loop;
  attestation := catalogue_attest_import_nutrition_semantics(p_batch_id);
  return result || attestation;
end;
$$;

do $migration$
declare
  acl_grantee oid;
  acl_grantee_name name;
  function_oid oid;
  table_owner_name name;
  target_schema name := pg_catalog.current_schema();
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)::name into table_owner_name
  from pg_catalog.pg_class as class_row
  where class_row.oid = pg_catalog.to_regclass(
    pg_catalog.format('%I.food_import_batch', target_schema)
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_attest_import_nutrition_semantics(uuid) set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_validate_import_batch(uuid,text,text,text) set search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_attest_import_nutrition_semantics(uuid) owner to %I',
    target_schema, table_owner_name
  );
  function_oid := pg_catalog.to_regprocedure(
    pg_catalog.format(
      '%I.catalogue_attest_import_nutrition_semantics(uuid)',
      target_schema
    )
  );
  execute pg_catalog.format(
    'revoke all on function %I.catalogue_attest_import_nutrition_semantics(uuid) from public',
    target_schema
  );
  for acl_grantee in
    select distinct function_acl.grantee
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
    where procedure_row.oid = function_oid and function_acl.grantee <> 0
  loop
    select role_row.rolname into acl_grantee_name
    from pg_catalog.pg_roles as role_row where role_row.oid = acl_grantee;
    if acl_grantee_name is not null then
      execute pg_catalog.format(
        'revoke all on function %I.catalogue_attest_import_nutrition_semantics(uuid) from %I',
        target_schema, acl_grantee_name
      );
    end if;
  end loop;
  execute pg_catalog.format(
    'grant execute on function %I.catalogue_attest_import_nutrition_semantics(uuid) to %I',
    target_schema, table_owner_name
  );
end;
$migration$;

comment on function catalogue_attest_import_nutrition_semantics(uuid) is
  'Owner-only database-row verifier/freezer shared by fixed-purpose validation and compatible local validation; it accepts no caller-supplied semantic result.';
comment on function catalogue_validate_import_batch(uuid,text,text,text) is
  'Validate through prior authority, compare wire counts, then use the shared database-row verifier to freeze exact 100-gram nutrition semantics.';
