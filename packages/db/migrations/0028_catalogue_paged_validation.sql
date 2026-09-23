-- Paged independent validation. V1 hashes and irreversible result columns are unchanged.
-- This EXPAND preparation path grants no promotion, activation or deployment authority.
create table catalogue_validation_generation_v2 (
  singleton boolean primary key default true check (singleton),
  generation bigint not null default 0 check (generation >= 0)
);
insert into catalogue_validation_generation_v2(singleton) values (true);

create function catalogue_advance_validation_generation_v2()
returns trigger language plpgsql security definer as $$
begin
  update catalogue_validation_generation_v2 set generation = generation + 1 where singleton;
  if not found then raise exception 'catalogue validation generation is absent' using errcode='55000'; end if;
  return null;
end;
$$;

-- Statement triggers include owner/local callers and maintenance TRUNCATE. The
-- generation changes in the writer's transaction, including away-and-back edits.
do $migration$
declare relation_name text;
begin
  foreach relation_name in array array[
    'nutrient','source_nutrient_map','source_nutrient_map_revision',
    'food_source','food_source_release','food','food_barcode',
    'food_version','food_nutrient_value','food_serving','food_import_batch',
    'food_import_record','food_import_parser_report','food_import_approval'
  ] loop
    execute pg_catalog.format(
      'create trigger %I after insert or update or delete or truncate on %I for each statement execute function catalogue_advance_validation_generation_v2()',
      relation_name || '_validation_generation_v2', relation_name);
  end loop;
end;
$migration$;

create table catalogue_validation_context_v2 (
  batch_id uuid primary key references catalogue_preparation_v2(batch_id),
  validator_principal text not null,
  staging_seal_sha256 text not null check(staging_seal_sha256 ~ '^[0-9a-f]{64}$'),
  generation bigint not null check(generation >= 0),
  context_sha256 text not null check(context_sha256 ~ '^[0-9a-f]{64}$'),
  policy_document text not null,
  policy jsonb not null check(jsonb_typeof(policy)='object'),
  baseline_release_id uuid references food_source_release(id),
  phase text not null default 'observing' check(phase in ('observing','validated','quarantined')),
  next_sequence bigint not null default 0 check(next_sequence >= 0),
  page_count bigint not null default 0 check(page_count >= 0),
  last_page_receipt_sha256 text not null,
  validation_commitment_sha256 text not null,
  semantic_commitment_sha256 text not null,
  valid_count bigint not null default 0,
  quarantined_count bigint not null default 0,
  warning_count bigint not null default 0,
  record_error_count bigint not null default 0,
  nutrient_input_count bigint not null default 0,
  nutrient_materializable_count bigint not null default 0,
  excluded_nutrient_count bigint not null default 0,
  portion_input_count bigint not null default 0,
  valid_without_nutrients_count bigint not null default 0,
  terminal_document text,
  terminal_sha256 text,
  terminal_receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check ((terminal_document is null and terminal_sha256 is null and terminal_receipt is null and phase='observing')
    or (terminal_document is not null and terminal_sha256 ~ '^[0-9a-f]{64}$'
      and terminal_receipt is not null and phase in ('validated','quarantined')))
);
create table catalogue_validation_record_v2 (
  batch_id uuid not null references catalogue_validation_context_v2(batch_id),
  sequence_number bigint not null,
  source_record_key text not null,
  canonical_payload_sha256 text not null,
  validation_status text not null check(validation_status in ('valid','quarantined')),
  source_food_key text,
  gtin14 text,
  market_code text,
  validated_food_document text,
  validated_food_sha256 text,
  validation_issues_document text not null,
  nutrient_input_count bigint not null check(nutrient_input_count >= 0),
  nutrient_materializable_count bigint not null check(nutrient_materializable_count >= 0),
  excluded_nutrient_count bigint not null check(excluded_nutrient_count >= 0),
  portion_input_count bigint not null check(portion_input_count >= 0),
  nutrition_semantic_sha256 text not null check(nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'),
  record_sha256 text not null check(record_sha256 ~ '^[0-9a-f]{64}$'),
  primary key(batch_id,sequence_number),
  foreign key(batch_id,sequence_number) references food_import_record(batch_id,sequence_number),
  check ((validation_status='valid' and source_food_key is not null
      and validated_food_document is not null and validated_food_sha256 ~ '^[0-9a-f]{64}$')
    or (validation_status='quarantined' and source_food_key is null and gtin14 is null
      and validated_food_document is null and validated_food_sha256 is null))
);
create unique index catalogue_validation_source_identity_v2
  on catalogue_validation_record_v2(batch_id,source_food_key) where validation_status='valid';
create unique index catalogue_validation_barcode_identity_v2
  on catalogue_validation_record_v2(batch_id,gtin14,market_code)
  where validation_status='valid' and gtin14 is not null;
create table catalogue_validation_page_v2 (
  batch_id uuid not null references catalogue_validation_context_v2(batch_id),
  page_number bigint not null check(page_number>=0),
  start_sequence bigint not null,
  end_sequence bigint not null,
  observation_sha256 text not null,
  request_document text not null,
  request_sha256 text not null,
  validation_commitment_sha256 text not null,
  semantic_commitment_sha256 text not null,
  receipt_sha256 text not null,
  receipt jsonb not null,
  primary key(batch_id,page_number),
  unique(batch_id,start_sequence),
  check(end_sequence>start_sequence and end_sequence-start_sequence<=250)
);
create trigger catalogue_validation_record_immutable_v2 before update or delete
  on catalogue_validation_record_v2 for each row execute function reject_immutable_row_update();
create trigger catalogue_validation_page_immutable_v2 before update or delete
  on catalogue_validation_page_v2 for each row execute function reject_immutable_row_update();

-- These guards also reject accidental direct DML through the legacy owner lane.
-- Restricted principals receive EXECUTE on entry points, never companion DML.
create function catalogue_guard_validation_context_v2()
returns trigger language plpgsql security definer as $$
declare
  actor text; preparation catalogue_preparation_v2%rowtype; batch food_import_batch%rowtype;
  source food_source%rowtype; epoch bigint; expected_context text;
  page catalogue_validation_page_v2%rowtype;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if tg_op='DELETE' then raise exception 'validation context cannot be removed' using errcode='55000'; end if;
  if new.validator_principal is distinct from actor then
    raise exception 'validation context belongs to another actual principal' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    select * into preparation from catalogue_preparation_v2 where batch_id=new.batch_id;
    select * into batch from food_import_batch where id=new.batch_id;
    select * into source from food_source where id=batch.food_source_id;
    select generation into epoch from catalogue_validation_generation_v2 where singleton for share;
    expected_context:=catalogue_frame_sha256_v2('validation-context',array[
      new.batch_id::text,new.staging_seal_sha256,preparation.admission_sha256,epoch::text,
      coalesce(source.active_release_id::text,''),actor,new.policy_document,
      substring(batch.parser_version,'[+]mapping[.]([0-9a-f]{64})$')]);
    if preparation.phase is distinct from 'sealed' or batch.status is distinct from 'staging'
      or batch.staged_database_principal is null or batch.staged_database_principal=actor
      or new.staging_seal_sha256 is distinct from preparation.staging_seal_sha256
      or new.generation is distinct from epoch or new.baseline_release_id is distinct from source.active_release_id
      or new.context_sha256 is distinct from expected_context or new.policy is distinct from new.policy_document::jsonb
      or new.phase<>'observing' or new.next_sequence<>0 or new.page_count<>0
      or new.valid_count<>0 or new.quarantined_count<>0 or new.warning_count<>0 or new.record_error_count<>0
      or new.nutrient_input_count<>0 or new.nutrient_materializable_count<>0 or new.excluded_nutrient_count<>0
      or new.portion_input_count<>0 or new.valid_without_nutrients_count<>0
      or new.terminal_document is not null or new.terminal_sha256 is not null or new.terminal_receipt is not null
      or new.last_page_receipt_sha256 is distinct from new.context_sha256
      or new.validation_commitment_sha256 is distinct from catalogue_frame_sha256_v2('validation-start',array[new.batch_id::text,new.context_sha256])
      or new.semantic_commitment_sha256 is distinct from catalogue_frame_sha256_v2('semantic-start',array[new.batch_id::text,new.context_sha256]) then
      raise exception 'validation context must begin with sealed pins and empty progress' using errcode='55000';
    end if;
    return new;
  end if;
  if row(new.batch_id,new.validator_principal,new.staging_seal_sha256,new.generation,new.context_sha256,
    new.policy_document,new.policy,new.baseline_release_id,new.created_at)
    is distinct from row(old.batch_id,old.validator_principal,old.staging_seal_sha256,old.generation,old.context_sha256,
    old.policy_document,old.policy,old.baseline_release_id,old.created_at)
    or old.phase<>'observing' and new is distinct from old then
    raise exception 'validation context or terminal evidence is immutable' using errcode='55000';
  end if;
  perform catalogue_assert_validation_context_v2(new.batch_id);
  if new.next_sequence is distinct from old.next_sequence or new.page_count is distinct from old.page_count then
    select * into page from catalogue_validation_page_v2 where batch_id=new.batch_id and page_number=old.page_count;
    if not found or new.phase<>'observing' or new.page_count<>old.page_count+1
      or page.start_sequence<>old.next_sequence or page.end_sequence<>new.next_sequence
      or new.last_page_receipt_sha256 is distinct from page.receipt_sha256
      or new.validation_commitment_sha256 is distinct from page.validation_commitment_sha256
      or new.semantic_commitment_sha256 is distinct from page.semantic_commitment_sha256 then
      raise exception 'validation progress requires the next authenticated page' using errcode='55000';
    end if;
  elsif row(new.last_page_receipt_sha256,new.validation_commitment_sha256,new.semantic_commitment_sha256,
    new.valid_count,new.quarantined_count,new.warning_count,new.record_error_count,new.nutrient_input_count,
    new.nutrient_materializable_count,new.excluded_nutrient_count,new.portion_input_count,new.valid_without_nutrients_count)
    is distinct from row(old.last_page_receipt_sha256,old.validation_commitment_sha256,old.semantic_commitment_sha256,
    old.valid_count,old.quarantined_count,old.warning_count,old.record_error_count,old.nutrient_input_count,
    old.nutrient_materializable_count,old.excluded_nutrient_count,old.portion_input_count,old.valid_without_nutrients_count) then
    raise exception 'validation counters change only with an authenticated page' using errcode='55000';
  end if;
  return new;
end;
$$;
create trigger catalogue_validation_context_immutable_v2 before insert or update or delete
  on catalogue_validation_context_v2 for each row execute function catalogue_guard_validation_context_v2();

create function catalogue_guard_validation_evidence_v2()
returns trigger language plpgsql security definer as $$
declare
  actor text; context catalogue_validation_context_v2%rowtype; staged food_import_record%rowtype;
  record catalogue_validation_record_v2%rowtype; preparation catalogue_preparation_v2%rowtype;
  semantic_commitment text; expected_validation text; expected_receipt text; next_record bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  select * into context from catalogue_validation_context_v2 where batch_id=new.batch_id;
  select * into preparation from catalogue_preparation_v2 where batch_id=new.batch_id;
  if context.phase is distinct from 'observing' or context.validator_principal is distinct from actor
    or preparation.phase is distinct from 'sealed' then
    raise exception 'validation evidence requires its actual validator and open context' using errcode='55000';
  end if;
  perform catalogue_assert_validation_context_v2(new.batch_id);
  if tg_table_name='catalogue_validation_record_v2' then
    select * into staged from food_import_record where batch_id=new.batch_id and sequence_number=new.sequence_number;
    if not found or new.sequence_number<context.next_sequence
      or new.sequence_number>=least(context.next_sequence+250,preparation.staged_count)
      or new.source_record_key is distinct from staged.source_record_key
      or new.canonical_payload_sha256 is distinct from staged.canonical_payload_sha256 then
      raise exception 'validation result is outside the authenticated source page' using errcode='55000';
    end if;
  else
    if new.page_number<>context.page_count or new.start_sequence<>context.next_sequence
      or new.end_sequence>preparation.staged_count or new.end_sequence<=new.start_sequence
      or new.end_sequence-new.start_sequence>250
      or new.request_sha256 is distinct from encode(sha256(convert_to(new.request_document,'UTF8')),'hex') then
      raise exception 'validation page does not extend its exact retained request' using errcode='55000';
    end if;
    semantic_commitment:=context.semantic_commitment_sha256;
    next_record:=new.start_sequence;
    for record in select * from catalogue_validation_record_v2 where batch_id=new.batch_id
      and sequence_number>=new.start_sequence and sequence_number<new.end_sequence order by sequence_number loop
      if record.sequence_number<>next_record then raise exception 'validation page has a result gap' using errcode='55000'; end if;
      semantic_commitment:=catalogue_frame_sha256_v2('semantic-record',array[
        semantic_commitment,record.sequence_number::text,record.source_record_key,
        record.canonical_payload_sha256,record.nutrition_semantic_sha256,record.record_sha256]);
      next_record:=next_record+1;
    end loop;
    expected_validation:=catalogue_frame_sha256_v2('validation-page',array[
      context.validation_commitment_sha256,context.context_sha256,new.page_number::text,new.start_sequence::text,
      new.end_sequence::text,new.observation_sha256,new.request_sha256]);
    expected_receipt:=catalogue_frame_sha256_v2('validation-page-receipt',array[
      new.batch_id::text,context.context_sha256,new.page_number::text,new.start_sequence::text,new.end_sequence::text,
      new.request_sha256,expected_validation,semantic_commitment]);
    if next_record<>new.end_sequence or new.semantic_commitment_sha256 is distinct from semantic_commitment
      or new.validation_commitment_sha256 is distinct from expected_validation
      or new.receipt_sha256 is distinct from expected_receipt then
      raise exception 'validation page commitment differs from its bounded result chain' using errcode='55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger catalogue_validation_record_insert_v2 before insert on catalogue_validation_record_v2
  for each row execute function catalogue_guard_validation_evidence_v2();
create trigger catalogue_validation_page_insert_v2 before insert on catalogue_validation_page_v2
  for each row execute function catalogue_guard_validation_evidence_v2();
create trigger catalogue_validation_context_truncate_v2 before truncate on catalogue_validation_context_v2
  for each statement execute function reject_immutable_row_update();
create trigger catalogue_validation_record_truncate_v2 before truncate on catalogue_validation_record_v2
  for each statement execute function reject_immutable_row_update();
create trigger catalogue_validation_page_truncate_v2 before truncate on catalogue_validation_page_v2
  for each statement execute function reject_immutable_row_update();

-- Owner maintenance may advance the fence, but cannot rewind it or erase it.
create function catalogue_guard_validation_generation_v2()
returns trigger language plpgsql as $$
begin
  if tg_op<>'UPDATE' then raise exception 'validation generation cannot be replaced or removed' using errcode='55000'; end if;
  if new.singleton is distinct from old.singleton or new.generation is distinct from old.generation+1 then
    raise exception 'validation generation can only advance by one' using errcode='55000';
  end if;
  return new;
end;
$$;
create trigger catalogue_validation_generation_monotonic_v2 before insert or update or delete
  on catalogue_validation_generation_v2 for each row execute function catalogue_guard_validation_generation_v2();
create trigger catalogue_validation_generation_truncate_v2 before truncate on catalogue_validation_generation_v2
  for each statement execute function catalogue_guard_validation_generation_v2();

-- Dependency drift invalidates this immutable context permanently. Exact retries
-- do not recapture a generation, and the admission's lineage and consumed budgets
-- cannot be reset. Operators must resolve drift through a separately designed and
-- reviewed replacement workflow; this preparation package grants no restart path.
create function catalogue_assert_validation_context_v2(p_batch_id uuid)
returns void language plpgsql security definer as $$
declare expected bigint; actual bigint;
begin
  select generation into expected from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if not found then raise exception 'V2 validation context absent' using errcode='55000'; end if;
  select generation into actual from catalogue_validation_generation_v2 where singleton for share;
  if actual is distinct from expected then
    raise exception 'V2 validation dependency generation changed' using errcode='40001';
  end if;
end;
$$;

create function catalogue_normalize_source_text_v2(p_value text)
returns text language sql immutable strict parallel safe as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(normalize(p_value,NFC),
    '[' || chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||
    chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||
    chr(8287)||chr(12288)||chr(65279)||']+', ' ', 'g'), ' ')
$$;
create function catalogue_normalize_gtin_v2(p_value text)
returns text language plpgsql immutable parallel safe as $$
declare value text; total integer:=0; position integer;
begin
  value:=catalogue_normalize_source_text_v2(p_value);
  if value is null or value !~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$' then return null; end if;
  for position in 1..length(value)-1 loop
    total:=total+substring(value,position,1)::integer *
      case when (length(value)-position)%2=1 then 3 else 1 end;
  end loop;
  if (10-total%10)%10<>right(value,1)::integer then return null; end if;
  return lpad(value,14,'0');
end;
$$;


-- V1 mapping digest compatibility is bounded separately from catalogue records.
-- Sorting uses UTF-16 code units to match JavaScript relational string ordering.
create function catalogue_utf16_sort_key_v2(p_value text)
returns text language sql immutable strict parallel safe as $$
  select coalesce(string_agg(case when ascii(character)>65535
    then lpad(to_hex(55296+(ascii(character)-65536)/1024),4,'0')
      ||lpad(to_hex(56320+(ascii(character)-65536)%1024),4,'0')
    else lpad(to_hex(ascii(character)),4,'0') end,'' order by ordinal),'')
  from unnest(string_to_array(p_value,null)) with ordinality characters(character,ordinal)
$$;
create function catalogue_mapping_digest_for_validation_v2(p_source_id bigint)
returns text language plpgsql security definer as $$
declare rows_count bigint; document_bytes bigint; mapping_document text;
begin
  select count(*) into rows_count from (
    select 1 from source_nutrient_map where food_source_id=p_source_id limit 10001
  ) bounded;
  if rows_count>10000 then raise exception 'V2 mapping registry exceeds 10000-entry context bound' using errcode='54000'; end if;
  with entries as (
    select m.source_nutrient_key,jsonb_build_object(
      'canonicalUnit',n.canonical_unit,
      'conversionMultiplier',catalogue_canonical_decimal_product(r.conversion_multiplier::text,'1'),
      'nutrientCode',n.code,'nutrientDimension',n.dimension,'nutrientId',n.id::text,'nutrientName',n.name,
      'revisionId',r.id::text,'sourceNutrientKey',m.source_nutrient_key,'sourceUnit',r.source_unit) value
    from source_nutrient_map m join source_nutrient_map_revision r on r.id=m.current_revision_id
    join nutrient n on n.id=r.nutrient_id where m.food_source_id=p_source_id
  )
  select coalesce(sum(octet_length(value::text)),0) into document_bytes from entries;
  if document_bytes>4194304 then raise exception 'V2 complete mapping context exceeds 4 MiB' using errcode='54000'; end if;
  with entries as (
    select m.source_nutrient_key,jsonb_build_object(
      'canonicalUnit',n.canonical_unit,
      'conversionMultiplier',catalogue_canonical_decimal_product(r.conversion_multiplier::text,'1'),
      'nutrientCode',n.code,'nutrientDimension',n.dimension,'nutrientId',n.id::text,'nutrientName',n.name,
      'revisionId',r.id::text,'sourceNutrientKey',m.source_nutrient_key,'sourceUnit',r.source_unit) value
    from source_nutrient_map m join source_nutrient_map_revision r on r.id=m.current_revision_id
    join nutrient n on n.id=r.nutrient_id where m.food_source_id=p_source_id
  ), canonical_entries as (
    select source_nutrient_key,'{'||(
      select string_agg(to_jsonb(k)::text||':'||to_jsonb(v)::text,',' order by k collate "C")
      from jsonb_each_text(value) fields(k,v)
    )||'}' document from entries
  )
  select '['||coalesce(string_agg(document,',' order by catalogue_utf16_sort_key_v2(source_nutrient_key) collate "C"),'')||']'
    into mapping_document from canonical_entries;
  return encode(sha256(convert_to(mapping_document,'UTF8')),'hex');
end;
$$;


create function catalogue_begin_validation_v2(p_batch_id uuid,p_staging_seal_sha256 text,p_policy_document text)
returns jsonb language plpgsql security definer as $$
declare
  actor text; preparation catalogue_preparation_v2%rowtype; batch food_import_batch%rowtype;
  existing catalogue_validation_context_v2%rowtype; source food_source%rowtype; admission catalogue_preparation_admission_v2%rowtype; parser food_import_parser_report%rowtype;
  policy jsonb; epoch bigint; context_hash text; initial_validation text; initial_semantics text; mapping_digest text;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if p_policy_document is null or octet_length(p_policy_document) not between 1 and 4096
    or p_staging_seal_sha256 is null or p_staging_seal_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid V2 validation context request' using errcode='22023';
  end if;
  policy:=p_policy_document::jsonb;
  if jsonb_typeof(policy) is distinct from 'object'
    or policy-array['maximumExcludedNutrientFraction','maximumQuarantineFraction','maximumQuarantinedRecords',
      'requireAtLeastOneValidRecord','requireDistinctApprovalPrincipals','requireMaterializedNutrientPerValidRecord']<>'{}'::jsonb
    or (select count(*) from jsonb_object_keys(policy))<>6
    or jsonb_typeof(policy->'maximumExcludedNutrientFraction') is distinct from 'number'
    or jsonb_typeof(policy->'maximumQuarantineFraction') is distinct from 'number'
    or jsonb_typeof(policy->'maximumQuarantinedRecords') is distinct from 'number'
    or (policy->>'maximumExcludedNutrientFraction')::numeric not between 0 and 1
    or (policy->>'maximumQuarantineFraction')::numeric not between 0 and 1
    or policy->>'maximumQuarantinedRecords' !~ '^(0|[1-9][0-9]*)$'
    or (policy->>'maximumQuarantinedRecords')::numeric>9007199254740991
    or policy->'requireAtLeastOneValidRecord' is distinct from 'true'::jsonb
    or policy->'requireDistinctApprovalPrincipals' is distinct from 'true'::jsonb
    or policy->'requireMaterializedNutrientPerValidRecord' is distinct from 'true'::jsonb then
    raise exception 'V2 validation requires the complete strict policy' using errcode='22023';
  end if;
  select * into batch from food_import_batch where id=p_batch_id for update;
  select * into preparation from catalogue_preparation_v2 where batch_id=p_batch_id;
  if not found or preparation.phase<>'sealed' or preparation.staging_seal_sha256 is distinct from p_staging_seal_sha256
    or batch.status<>'staging' or batch.validated_at is not null
    or batch.staged_database_principal is null or batch.staged_database_principal=actor then
    raise exception 'V2 validation requires a sealed batch and distinct actual validator' using errcode='55000';
  end if;
  select * into existing from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if found then
    if existing.validator_principal<>actor or existing.policy_document<>p_policy_document
      or existing.staging_seal_sha256<>p_staging_seal_sha256 then
      raise exception 'V2 validation context replay differs' using errcode='55000';
    end if;
    perform catalogue_assert_validation_context_v2(p_batch_id);
  else
    -- No source or registry locks are acquired after the generation fence.
    select generation into epoch from catalogue_validation_generation_v2 where singleton for share;
    select * into source from food_source where id=batch.food_source_id;
    if not found or source.code<>'USDA_FDC' then raise exception 'V2 validator supports USDA_FDC only' using errcode='22023'; end if;
    mapping_digest:=catalogue_mapping_digest_for_validation_v2(batch.food_source_id);
    if substring(batch.parser_version,'[+]mapping[.]([0-9a-f]{64})$') is distinct from mapping_digest then
      raise exception 'V2 mapping registry differs from sealed parser identity' using errcode='55000';
    end if;
    select * into admission from catalogue_preparation_admission_v2 where admission_sha256=preparation.admission_sha256;
    select * into parser from food_import_parser_report where batch_id=p_batch_id;
    if not found or parser.report->'schemaVersion' is distinct from '2'::jsonb
      or parser.report->>'reportKind' is distinct from 'usda-fdc-full-csv-capability-stage-v2'
      or parser.report->>'preparationAdmissionSha256' is distinct from admission.admission_sha256
      or parser.report->>'sourceCode' is distinct from 'USDA_FDC'
      or parser.report->>'releaseKey' is distinct from batch.release_key
      or parser.report->>'artifactSha256' is distinct from batch.artifact_sha256
      or parser.report->>'nutrientMappingDigest' is distinct from mapping_digest
      or parser.report#>>'{recordsExport,sha256}' is distinct from admission.export_sha256
      or parser.report#>>'{recordsExport,byteSize}' is distinct from admission.export_bytes::text
      or parser.report#>>'{recordsExport,recordCount}' is distinct from preparation.staged_count::text
      or (parser.report->>'parserVersion')||'+build.'||(parser.report->>'parserBuildSha256')||'+mapping.'||mapping_digest
        is distinct from batch.parser_version then
      raise exception 'V2 parser report identities differ from sealed admission and mappings' using errcode='55000';
    end if;
    context_hash:=catalogue_frame_sha256_v2('validation-context',array[
      p_batch_id::text,p_staging_seal_sha256,preparation.admission_sha256,epoch::text,
      coalesce(source.active_release_id::text,''),actor,p_policy_document,mapping_digest]);
    initial_validation:=catalogue_frame_sha256_v2('validation-start',array[p_batch_id::text,context_hash]);
    initial_semantics:=catalogue_frame_sha256_v2('semantic-start',array[p_batch_id::text,context_hash]);
    perform catalogue_charge_preparation_budget_v2(p_batch_id,32768+octet_length(p_policy_document)*4,32768,0);
    insert into catalogue_validation_context_v2(batch_id,validator_principal,staging_seal_sha256,
      generation,context_sha256,policy_document,policy,baseline_release_id,
      last_page_receipt_sha256,validation_commitment_sha256,semantic_commitment_sha256)
    values(p_batch_id,actor,p_staging_seal_sha256,epoch,context_hash,p_policy_document,policy,source.active_release_id,
      context_hash,initial_validation,initial_semantics);
    select * into existing from catalogue_validation_context_v2 where batch_id=p_batch_id;
  end if;
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256=preparation.admission_sha256;
  return jsonb_build_object('schemaVersion',2,'kind','catalogue-validation-context-v2',
    'admissionSha256',admission.admission_sha256,'maximumValidationEvidenceBytes',admission.max_validation_evidence_bytes::text,
    'batchId',p_batch_id,'contextSha256',existing.context_sha256,'validatorDatabasePrincipal',actor,
    'stagingSealSha256',existing.staging_seal_sha256,'generation',existing.generation::text,
    'baselineReleaseId',existing.baseline_release_id,'policyDocument',existing.policy_document,
    'phase',existing.phase,'nextSequence',existing.next_sequence::text,'pageCount',existing.page_count::text,
    'stagedCount',preparation.staged_count::text,'lastPageReceiptSha256',existing.last_page_receipt_sha256,
    'validationCommitmentSha256',existing.validation_commitment_sha256,
    'semanticCommitmentSha256',existing.semantic_commitment_sha256);
end;
$$;

create function catalogue_observe_validation_page_v2(p_batch_id uuid,p_start_sequence bigint,p_maximum_records integer default 250)
returns jsonb language plpgsql security definer as $$
declare
  actor text; context catalogue_validation_context_v2%rowtype; batch food_import_batch%rowtype;
  records jsonb; mappings jsonb; forbidden jsonb; page_document text; page_sha text;
  row_count bigint; payload_bytes bigint; mapping_count bigint; selected_end bigint; source_code text;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if p_maximum_records is null or p_maximum_records not between 1 and 250 then
    raise exception 'V2 observation record limit must be 1 through 250' using errcode='22023';
  end if;
  select * into batch from food_import_batch where id=p_batch_id for update;
  select * into context from catalogue_validation_context_v2 where batch_id=p_batch_id for update;
  if not found or context.validator_principal<>actor or context.phase<>'observing'
    or context.next_sequence is distinct from p_start_sequence then
    raise exception 'V2 observation cursor or validator differs' using errcode='55000';
  end if;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select code into source_code from food_source where id=batch.food_source_id;
  -- Byte-limited keyset selection. The window sees at most 250 immutable rows.
  with candidates as (
    select r.sequence_number, v.payload_text_bytes,
      sum(v.payload_text_bytes) over(order by r.sequence_number) as running_bytes
    from (select * from food_import_record where batch_id=p_batch_id
      and sequence_number>=p_start_sequence order by sequence_number limit p_maximum_records) r
    join catalogue_preparation_record_v2 v using(batch_id,sequence_number)
  )
  select count(*),coalesce(sum(payload_text_bytes),0),max(sequence_number)+1
    into row_count,payload_bytes,selected_end from candidates where running_bytes<=4194304;
  if row_count=0 or selected_end-p_start_sequence<>row_count then
    raise exception 'V2 observation has no complete contiguous page' using errcode='55000';
  end if;
  select jsonb_agg(jsonb_build_object('sequenceNumber',r.sequence_number::text,
    'sourceRecordKey',r.source_record_key,'sourceRecordType',r.source_record_type,
    'sourcePayloadSha256',r.source_payload_sha256,'canonicalPayloadSha256',r.canonical_payload_sha256,
    'canonicalPayloadDocument',v.canonical_payload_document) order by r.sequence_number)
    into records from food_import_record r join catalogue_preparation_record_v2 v using(batch_id,sequence_number)
    where r.batch_id=p_batch_id and r.sequence_number>=p_start_sequence and r.sequence_number<selected_end;
  with keys as (
    select distinct catalogue_normalize_source_text_v2(n.value->>'sourceNutrientId') as key
    from food_import_record r cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.canonical_payload->'nutrients')='array'
        then r.canonical_payload->'nutrients' else '[]'::jsonb end) n(value)
    where r.batch_id=p_batch_id and r.sequence_number>=p_start_sequence and r.sequence_number<selected_end
  ), selected as (
    select m.source_nutrient_key,revision.id,revision.source_unit,revision.conversion_multiplier,
      n.id nutrient_id,n.code,n.name,n.dimension,n.canonical_unit
    from keys join source_nutrient_map m on m.food_source_id=batch.food_source_id and m.source_nutrient_key=keys.key
    join source_nutrient_map_revision revision on revision.id=m.current_revision_id
    join nutrient n on n.id=revision.nutrient_id order by m.source_nutrient_key collate "C" limit 10001
  )
  select count(*),coalesce(jsonb_agg(jsonb_build_object('sourceNutrientId',source_nutrient_key,
    'mappingRevisionId',id::text,'sourceUnit',source_unit,'conversionMultiplier',conversion_multiplier::text,
    'nutrientId',nutrient_id::text,'nutrientCode',code,'canonicalUnit',canonical_unit,
    'nutrientName',name,'nutrientDimension',dimension) order by source_nutrient_key collate "C"),'[]'::jsonb)
  into mapping_count,mappings from selected;
  if mapping_count>10000 or octet_length(mappings::text)>4194304 then
    raise exception 'V2 page mapping evidence exceeds bound' using errcode='54000';
  end if;
  with identities as (
    select distinct catalogue_normalize_gtin_v2(r.canonical_payload#>>'{identity,gtin}') gtin,
      catalogue_normalize_source_text_v2(r.canonical_payload#>>'{source,marketCode}') market
    from food_import_record r where r.batch_id=p_batch_id
      and r.sequence_number>=p_start_sequence and r.sequence_number<selected_end
  )
  select coalesce(jsonb_agg(identity order by identity collate "C"),'[]'::jsonb) into forbidden from (
    select distinct i.gtin||':'||i.market identity from identities i
    join food_barcode b on lpad(b.gtin,14,'0')=i.gtin and b.market_code=i.market and b.valid_to is null
    join food f on f.id=b.food_id where f.food_source_id is not null and f.food_source_id<>batch.food_source_id
  ) conflicts;
  page_document:=jsonb_build_object('schemaVersion',2,'kind','catalogue-validation-observation-v2',
    'batchId',p_batch_id,'contextSha256',context.context_sha256,'pageNumber',context.page_count::text,
    'startSequence',p_start_sequence::text,'endSequence',selected_end::text,'maximumRecords',p_maximum_records::text,
    'previousReceiptSha256',context.last_page_receipt_sha256,'sourceCode',source_code,
    'releaseKey',batch.release_key,'records',records,'nutrientMappings',mappings,'forbiddenGtins',forbidden)::text;
  if octet_length(page_document)>16777216 then raise exception 'V2 observation exceeds 16 MiB' using errcode='54000'; end if;
  page_sha:=catalogue_frame_sha256_v2('validation-observation',array[page_document]);
  return jsonb_build_object('schemaVersion',2,'observationDocument',page_document,'observationSha256',page_sha);
end;
$$;

-- Nutrient/basis semantics only. Identity/barcode checks are separate below.
create function catalogue_compute_record_nutrition_semantics_v2(p_record_id bigint, p_batch_id uuid)
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
  select * into record_row from food_import_record where id = p_record_id and batch_id = p_batch_id;
  if not found then
    raise exception 'catalogue nutrition semantic computation references an unknown record'
      using errcode = '23503';
  end if;
  select batch.food_source_id
  into food_source_id_value
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
    join source_nutrient_map as mapping on mapping.current_revision_id = revision.id
      and mapping.food_source_id = revision.food_source_id
      and mapping.source_nutrient_key = revision.source_nutrient_key
    where revision.food_source_id = food_source_id_value
      and revision.source_nutrient_key = source_nutrient_id;
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


create function catalogue_submit_validation_page_v2(p_batch_id uuid,p_request_document text)
returns jsonb language plpgsql security definer as $$
#variable_conflict use_variable
declare
  actor text; context catalogue_validation_context_v2%rowtype; batch food_import_batch%rowtype;
  prior catalogue_validation_page_v2%rowtype; request jsonb; observed jsonb;
  request_sha text; item jsonb; item_ordinal bigint; staged food_import_record%rowtype;
  food jsonb; issues jsonb; semantics jsonb; semantic_sha text; food_sha text;
  record_sha text; status text; source_key text; gtin text; market text;
  page_no bigint; first_sequence bigint; end_sequence bigint; processed bigint:=0;
  warning_count bigint:=0; error_count bigint:=0; valid_count bigint:=0; quarantined_count bigint:=0;
  inputs bigint:=0; materializable bigint:=0; excluded bigint:=0; portions bigint:=0; empty_valid bigint:=0;
  item_warnings bigint; item_errors bigint; item_materializable bigint;
  validation_commitment text; semantic_commitment text; receipt_sha text; receipt jsonb;
  reserved_bytes bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if p_request_document is null or octet_length(p_request_document) not between 1 and 16777216 then
    raise exception 'V2 validation request exceeds page bound' using errcode='54000';
  end if;
  request:=p_request_document::jsonb;
  if jsonb_typeof(request) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(request))<>13
    or request-array['schemaVersion','kind','batchId','contextSha256','validatorDatabasePrincipal',
      'pageNumber','startSequence','endSequence','previousReceiptSha256','observationDocument',
      'observationSha256','records','sqlSemanticScope']<>'{}'::jsonb
    or request->'schemaVersion' is distinct from '2'::jsonb
    or request->>'kind' is distinct from 'catalogue-validation-request-page-v2'
    or request->>'sqlSemanticScope' is distinct from 'nutrition-basis-counts-source-identity-barcode-v2'
    or request->>'batchId' is distinct from p_batch_id::text
    or request->>'validatorDatabasePrincipal' is distinct from actor
    or jsonb_typeof(request->'records') is distinct from 'array'
    or request->>'pageNumber' !~ '^(0|[1-9][0-9]*)$'
    or request->>'startSequence' !~ '^(0|[1-9][0-9]*)$'
    or request->>'endSequence' !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'V2 validation request contract differs' using errcode='22023';
  end if;
  page_no:=catalogue_preparation_uint_v2(request->'pageNumber');
  first_sequence:=catalogue_preparation_uint_v2(request->'startSequence');
  end_sequence:=catalogue_preparation_uint_v2(request->'endSequence');
  if end_sequence-first_sequence not between 1 and 250
    or jsonb_array_length(request->'records')<>end_sequence-first_sequence then
    raise exception 'V2 validation page sequence/count differs' using errcode='22023';
  end if;
  request_sha:=encode(sha256(convert_to(p_request_document,'UTF8')),'hex');
  select * into batch from food_import_batch where id=p_batch_id for update;
  select * into context from catalogue_validation_context_v2 where batch_id=p_batch_id for update;
  if not found or context.validator_principal<>actor
    or request->>'contextSha256' is distinct from context.context_sha256 then
    raise exception 'V2 validation request context or principal differs' using errcode='55000';
  end if;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into prior from catalogue_validation_page_v2 where batch_id=p_batch_id and page_number=page_no;
  if found then
    if prior.request_sha256<>request_sha or prior.request_document<>p_request_document then
      raise exception 'V2 validation page replay differs from retained exact request' using errcode='55000';
    end if;
    return prior.receipt;
  end if;
  if context.phase<>'observing' or page_no<>context.page_count or first_sequence<>context.next_sequence
    or request->>'previousReceiptSha256' is distinct from context.last_page_receipt_sha256 then
    raise exception 'V2 validation page skipped, overlapped, reordered or continued terminal state' using errcode='55000';
  end if;
  observed:=catalogue_observe_validation_page_v2(p_batch_id,first_sequence,
    ((request->>'observationDocument')::jsonb->>'maximumRecords')::integer);
  if request->>'observationDocument' is distinct from observed->>'observationDocument'
    or request->>'observationSha256' is distinct from observed->>'observationSha256'
    or ((observed->>'observationDocument')::jsonb->>'endSequence')::bigint<>end_sequence then
    raise exception 'V2 validation request observation differs' using errcode='40001';
  end if;
  -- Conservative reservation covers the retained request, result text/JSON,
  -- heap/index/toast overhead and page metadata before any page result is inserted.
  reserved_bytes:=octet_length(p_request_document)::bigint*3+8192*(end_sequence-first_sequence)+32768;
  perform catalogue_charge_preparation_budget_v2(p_batch_id,reserved_bytes,2*octet_length(p_request_document)::bigint+32768,0);
  semantic_commitment:=context.semantic_commitment_sha256;
  for item,item_ordinal in
    select entry.value,entry.ordinality from jsonb_array_elements(request->'records') with ordinality entry(value,ordinality)
  loop
    if jsonb_typeof(item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(item))<>11
      or item-array['sequenceNumber','sourceRecordKey','canonicalPayloadSha256','status',
        'validatedFoodDocument','validatedFoodSha256','validationIssuesDocument',
        'nutrientInputCount','nutrientMaterializableCount','excludedNutrientCount','portionInputCount']<>'{}'::jsonb
      or item->>'sequenceNumber' is distinct from (first_sequence+item_ordinal-1)::text
      or item->>'status' is null or item->>'status' not in ('valid','quarantined')
      or jsonb_typeof(item->'validationIssuesDocument') is distinct from 'string'
      or octet_length(item->>'validationIssuesDocument')>1048576 then
      raise exception 'V2 validation result row contract differs' using errcode='22023';
    end if;
    if exists(select 1 from unnest(array['nutrientInputCount','nutrientMaterializableCount','excludedNutrientCount','portionInputCount']) k
      where jsonb_typeof(item->k) is distinct from 'string' or item->>k !~ '^(0|[1-9][0-9]*)$'
        or length(item->>k)>16) then
      raise exception 'V2 validation result counts must be bounded decimal strings' using errcode='22023';
    end if;
    select * into staged from food_import_record where batch_id=p_batch_id
      and sequence_number=first_sequence+item_ordinal-1;
    if not found or staged.validation_status<>'pending'
      or item->>'sourceRecordKey' is distinct from staged.source_record_key
      or item->>'canonicalPayloadSha256' is distinct from staged.canonical_payload_sha256 then
      raise exception 'V2 validation result staged identity differs' using errcode='55000';
    end if;
    issues:=(item->>'validationIssuesDocument')::jsonb;
    if jsonb_typeof(issues) is distinct from 'array' or exists(
      select 1 from jsonb_array_elements(issues) issue where
        jsonb_typeof(issue) is distinct from 'object'
        or issue-array['code','disposition','message','path','severity']<>'{}'::jsonb
        or (select count(*) from jsonb_object_keys(issue))<>5
        or issue->>'severity' is null or issue->>'severity' not in ('warning','error')
        or issue->>'disposition' is null
        or issue->>'disposition' not in ('exclude_barcode','exclude_nutrient','exclude_record','exclude_serving')
        or jsonb_typeof(issue->'code') is distinct from 'string'
        or jsonb_typeof(issue->'message') is distinct from 'string'
        or jsonb_typeof(issue->'path') is distinct from 'string'
    ) then raise exception 'V2 validation issues differ' using errcode='22023'; end if;
    select count(*) filter(where value->>'severity'='warning'),count(*) filter(where value->>'severity'='error')
      into item_warnings,item_errors from jsonb_array_elements(issues);
    status:=item->>'status';
    if (status='valid' and item_errors<>0) or (status='quarantined' and item_errors=0) then
      raise exception 'V2 validation status disagrees with issues' using errcode='23514';
    end if;
    semantics:=catalogue_compute_record_nutrition_semantics_v2(staged.id,p_batch_id);
    item_materializable:=case when status='valid' then (semantics->>'nutrientMaterializableCount')::bigint else 0 end;
    if (item->>'nutrientInputCount')::bigint<>(semantics->>'nutrientInputCount')::bigint
      or (item->>'excludedNutrientCount')::bigint<>(semantics->>'excludedNutrientCount')::bigint
      or (item->>'nutrientMaterializableCount')::bigint<>item_materializable
      or (item->>'portionInputCount')::bigint<>(case when jsonb_typeof(staged.canonical_payload->'servings')='array'
        then jsonb_array_length(staged.canonical_payload->'servings') else 0 end) then
      raise exception 'V2 client counts differ from independent SQL semantics' using errcode='55000';
    end if;
    source_key:=null; gtin:=null; market:=null; food_sha:=null;
    if status='valid' then
      if jsonb_typeof(item->'validatedFoodDocument') is distinct from 'string'
        or octet_length(item->>'validatedFoodDocument') not between 1 and 2097152
        or item->>'validatedFoodSha256' is null or item->>'validatedFoodSha256' !~ '^[0-9a-f]{64}$' then
        raise exception 'V2 valid food document missing or oversized' using errcode='22023';
      end if;
      food:=(item->>'validatedFoodDocument')::jsonb;
      food_sha:=encode(sha256(convert_to(item->>'validatedFoodDocument','UTF8')),'hex');
      source_key:=catalogue_normalize_source_text_v2(staged.canonical_payload#>>'{source,sourceRecordId}');
      market:=catalogue_normalize_source_text_v2(staged.canonical_payload#>>'{source,marketCode}');
      gtin:=catalogue_normalize_gtin_v2(staged.canonical_payload#>>'{identity,gtin}');
      if gtin is not null and exists(
        select 1 from food_barcode b join food f on f.id=b.food_id
        where lpad(b.gtin,14,'0')=gtin and b.market_code=market and b.valid_to is null
          and f.food_source_id is not null and f.food_source_id<>batch.food_source_id
      ) then gtin:=null; end if;
      if jsonb_typeof(food) is distinct from 'object'
        or food_sha is distinct from item->>'validatedFoodSha256'
        or semantics->'basisIsExact100g' is distinct from 'true'::jsonb
        or food->>'basisQuantity' is distinct from '100'
        or food->'nutrients' is distinct from semantics->'nutrients'
        or jsonb_typeof(staged.canonical_payload#>'{source,sourceRecordId}') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload#>'{source,marketCode}') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload#>'{source,sourceCode}') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload#>'{source,releaseKey}') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload#>'{source,sourceDataType}') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload->'idempotencyKey') is distinct from 'string'
        or jsonb_typeof(staged.canonical_payload->'sourcePayloadHash') is distinct from 'string'
        or source_key is null or source_key !~ '^[1-9][0-9]*$'
        or catalogue_utf16_length(source_key)>256
        or food->>'sourceFoodKey' is distinct from source_key
        or market is null or market !~ '^[A-Z0-9]{2,3}$'
        or food->>'marketCode' is distinct from market
        or food->>'gtin' is distinct from gtin
        or catalogue_normalize_source_text_v2(staged.canonical_payload#>>'{source,releaseKey}') is distinct from batch.release_key
        or catalogue_normalize_source_text_v2(staged.canonical_payload#>>'{source,sourceCode}') is distinct from 'USDA_FDC'
        or catalogue_normalize_source_text_v2(staged.canonical_payload#>>'{source,sourceDataType}') is distinct from staged.source_record_type
        or staged.canonical_payload->>'sourcePayloadHash' is distinct from staged.source_payload_sha256
        or catalogue_normalize_source_text_v2(staged.canonical_payload->>'idempotencyKey') is distinct from staged.source_record_key then
        raise exception 'V2 SQL nutrition, source identity or barcode semantics disagree' using errcode='55000';
      end if;
      valid_count:=valid_count+1;
      if item_materializable=0 then empty_valid:=empty_valid+1; end if;
    else
      if item->'validatedFoodDocument' is distinct from 'null'::jsonb
        or item->'validatedFoodSha256' is distinct from 'null'::jsonb then
        raise exception 'V2 quarantined row cannot carry food evidence' using errcode='23514';
      end if;
      quarantined_count:=quarantined_count+1;
    end if;
    semantic_sha:=catalogue_frame_sha256_v2('nutrition-semantic',array[
      context.context_sha256,staged.sequence_number::text,staged.canonical_payload_sha256,status,
      semantics::text,coalesce(food_sha,'')]);
    record_sha:=catalogue_frame_sha256_v2('validation-record',array[
      staged.sequence_number::text,staged.source_record_key,staged.canonical_payload_sha256,status,
      coalesce(item->>'validatedFoodDocument',''),item->>'validationIssuesDocument',
      item->>'nutrientInputCount',item->>'nutrientMaterializableCount',item->>'excludedNutrientCount',item->>'portionInputCount']);
    insert into catalogue_validation_record_v2(batch_id,sequence_number,source_record_key,canonical_payload_sha256,
      validation_status,source_food_key,gtin14,market_code,validated_food_document,validated_food_sha256,
      validation_issues_document,nutrient_input_count,nutrient_materializable_count,excluded_nutrient_count,
      portion_input_count,nutrition_semantic_sha256,record_sha256)
    values(p_batch_id,staged.sequence_number,staged.source_record_key,staged.canonical_payload_sha256,
      status,source_key,gtin,market,item->>'validatedFoodDocument',food_sha,item->>'validationIssuesDocument',
      (item->>'nutrientInputCount')::bigint,item_materializable,(item->>'excludedNutrientCount')::bigint,
      (item->>'portionInputCount')::bigint,semantic_sha,record_sha);
    -- Unique partial indexes reject distant-page source and candidate GTIN collisions.
    semantic_commitment:=catalogue_frame_sha256_v2('semantic-record',array[
      semantic_commitment,staged.sequence_number::text,staged.source_record_key,
      staged.canonical_payload_sha256,semantic_sha,record_sha]);
    inputs:=inputs+(item->>'nutrientInputCount')::bigint;
    excluded:=excluded+(item->>'excludedNutrientCount')::bigint;
    portions:=portions+(item->>'portionInputCount')::bigint;
    materializable:=materializable+item_materializable;
    warning_count:=warning_count+item_warnings; error_count:=error_count+item_errors;
    processed:=processed+1;
  end loop;
  if processed<>end_sequence-first_sequence then raise exception 'V2 incomplete result page' using errcode='55000'; end if;
  validation_commitment:=catalogue_frame_sha256_v2('validation-page',array[
    context.validation_commitment_sha256,context.context_sha256,page_no::text,first_sequence::text,
    end_sequence::text,request->>'observationSha256',request_sha]);
  receipt_sha:=catalogue_frame_sha256_v2('validation-page-receipt',array[
    p_batch_id::text,context.context_sha256,page_no::text,first_sequence::text,end_sequence::text,
    request_sha,validation_commitment,semantic_commitment]);
  receipt:=jsonb_build_object('schemaVersion',2,'kind','catalogue-validation-page-receipt-v2',
    'batchId',p_batch_id,'contextSha256',context.context_sha256,'pageNumber',page_no::text,
    'startSequence',first_sequence::text,'endSequence',end_sequence::text,'requestSha256',request_sha,
    'validationCommitmentSha256',validation_commitment,'semanticCommitmentSha256',semantic_commitment,
    'receiptSha256',receipt_sha);
  insert into catalogue_validation_page_v2 values(p_batch_id,page_no,first_sequence,end_sequence,
    request->>'observationSha256',p_request_document,request_sha,validation_commitment,semantic_commitment,receipt_sha,receipt);
  update catalogue_validation_context_v2 set next_sequence=end_sequence,page_count=page_count+1,
    last_page_receipt_sha256=receipt_sha,validation_commitment_sha256=validation_commitment,
    semantic_commitment_sha256=semantic_commitment,valid_count=catalogue_validation_context_v2.valid_count+valid_count,
    quarantined_count=catalogue_validation_context_v2.quarantined_count+quarantined_count,
    warning_count=catalogue_validation_context_v2.warning_count+warning_count,
    record_error_count=record_error_count+error_count,nutrient_input_count=nutrient_input_count+inputs,
    nutrient_materializable_count=nutrient_materializable_count+materializable,
    excluded_nutrient_count=excluded_nutrient_count+excluded,portion_input_count=portion_input_count+portions,
    valid_without_nutrients_count=valid_without_nutrients_count+empty_valid
    where batch_id=p_batch_id;
  return receipt;
end;
$$;

create function catalogue_finish_validation_v2(p_batch_id uuid,p_terminal_document text)
returns jsonb language plpgsql security definer as $$
declare
  actor text; context catalogue_validation_context_v2%rowtype;
  preparation catalogue_preparation_v2%rowtype; parser food_import_parser_report%rowtype;
  request jsonb; request_sha text; summary_document text; terminal_sha text; receipt jsonb;
  quarantined_total bigint; excluded_total bigint; unresolved bigint:=0;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if p_terminal_document is null or octet_length(p_terminal_document) not between 1 and 8192 then
    raise exception 'V2 validation terminal request exceeds bound' using errcode='54000';
  end if;
  request:=p_terminal_document::jsonb;
  if jsonb_typeof(request) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(request))<>9
    or request-array['schemaVersion','kind','batchId','contextSha256','pageCount','recordCount',
      'lastPageReceiptSha256','validationCommitmentSha256','semanticCommitmentSha256']<>'{}'::jsonb
    or request->'schemaVersion' is distinct from '2'::jsonb
    or request->>'kind' is distinct from 'catalogue-validation-terminal-request-v2'
    or jsonb_typeof(request->'pageCount') is distinct from 'string'
    or jsonb_typeof(request->'recordCount') is distinct from 'string'
    or request->>'batchId' is distinct from p_batch_id::text then
    raise exception 'V2 validation terminal request contract differs' using errcode='22023';
  end if;
  perform 1 from food_import_batch where id=p_batch_id for update;
  select * into context from catalogue_validation_context_v2 where batch_id=p_batch_id for update;
  if not found or context.validator_principal<>actor then
    raise exception 'V2 validation terminal principal differs' using errcode='42501';
  end if;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  if context.phase<>'observing' then
    if context.terminal_document is distinct from p_terminal_document then
      raise exception 'V2 validation terminal exact replay differs' using errcode='55000';
    end if;
    return context.terminal_receipt;
  end if;
  select * into preparation from catalogue_preparation_v2 where batch_id=p_batch_id;
  select * into parser from food_import_parser_report where batch_id=p_batch_id;
  if not found or preparation.phase<>'sealed'
    or request->>'contextSha256' is distinct from context.context_sha256
    or request->>'pageCount' is distinct from context.page_count::text
    or request->>'recordCount' is distinct from context.next_sequence::text
    or request->>'lastPageReceiptSha256' is distinct from context.last_page_receipt_sha256
    or request->>'validationCommitmentSha256' is distinct from context.validation_commitment_sha256
    or request->>'semanticCommitmentSha256' is distinct from context.semantic_commitment_sha256
    or context.next_sequence<>preparation.staged_count
    or context.next_sequence<>parser.emitted_record_count
    or context.next_sequence<>context.valid_count+context.quarantined_count
    or context.nutrient_input_count<>parser.emitted_nutrient_count
    or context.portion_input_count<>parser.emitted_portion_count then
    raise exception 'V2 validation terminal coverage, counts or commitment differs' using errcode='55000';
  end if;
  quarantined_total:=context.quarantined_count+parser.excluded_record_count;
  excluded_total:=context.excluded_nutrient_count+parser.excluded_nutrient_count;
  if context.valid_count=0 then unresolved:=unresolved+1; end if;
  if quarantined_total>(context.policy->>'maximumQuarantinedRecords')::bigint then unresolved:=unresolved+1; end if;
  if (case when parser.source_record_count=0 then 1 else quarantined_total::numeric/parser.source_record_count end)
    >(context.policy->>'maximumQuarantineFraction')::numeric then unresolved:=unresolved+1; end if;
  if (case when parser.source_nutrient_count=0 then 1 else excluded_total::numeric/parser.source_nutrient_count end)
    >(context.policy->>'maximumExcludedNutrientFraction')::numeric then unresolved:=unresolved+1; end if;
  if context.valid_without_nutrients_count>0 then unresolved:=unresolved+1; end if;
  request_sha:=encode(sha256(convert_to(p_terminal_document,'UTF8')),'hex');
  summary_document:=jsonb_build_object('schemaVersion',2,'kind','catalogue-validation-summary-v2',
    'batchId',p_batch_id,'contextSha256',context.context_sha256,
    'sqlSemanticScope','nutrition-basis-counts-source-identity-barcode-v2',
    'pageCount',context.page_count::text,'stagedCount',context.next_sequence::text,
    'validCount',context.valid_count::text,'quarantinedCount',quarantined_total::text,
    'warningCount',context.warning_count::text,'recordErrorCount',context.record_error_count::text,
    'nutrientInputCount',parser.source_nutrient_count::text,
    'nutrientMaterializableCount',context.nutrient_materializable_count::text,
    'excludedNutrientCount',excluded_total::text,'portionInputCount',parser.source_portion_count::text,
    'unresolvedErrorCount',unresolved::text,'policyEligible',unresolved=0,'promotionEligible',false,
    'validationCommitmentSha256',context.validation_commitment_sha256,
    'semanticCommitmentSha256',context.semantic_commitment_sha256,
    'lastPageReceiptSha256',context.last_page_receipt_sha256,'terminalRequestSha256',request_sha)::text;
  terminal_sha:=catalogue_frame_sha256_v2('validation-terminal',array[p_terminal_document,summary_document]);
  receipt:=jsonb_build_object('schemaVersion',2,'kind','catalogue-validation-terminal-receipt-v2',
    'batchId',p_batch_id,'contextSha256',context.context_sha256,'terminalRequestSha256',request_sha,
    'summaryDocument',summary_document,'terminalSha256',terminal_sha);
  perform catalogue_charge_preparation_budget_v2(p_batch_id,65536,2*(octet_length(p_terminal_document)+octet_length(summary_document))+32768,0);
  update catalogue_validation_context_v2 set phase=case when unresolved=0 then 'validated' else 'quarantined' end,
    terminal_document=p_terminal_document,terminal_sha256=terminal_sha,terminal_receipt=receipt where batch_id=p_batch_id;
  return receipt;
end;
$$;

-- Functions are pinned to the migration schema and owned by the existing workflow
-- owner. Default privileges cannot accidentally expose companion state or helpers.
do $migration$
declare
  schema_name text:=current_schema(); owner_name text; function_row record; relation_row record; grant_row record;
begin
  select pg_get_userbyid(relowner) into owner_name from pg_class where oid='food_import_batch'::regclass;
  if owner_name is distinct from current_user::text then raise exception 'V2 validation migration requires workflow owner' using errcode='42501'; end if;
  for relation_row in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=schema_name and c.relname in ('catalogue_validation_generation_v2','catalogue_validation_context_v2',
      'catalogue_validation_record_v2','catalogue_validation_page_v2') loop
    execute format('revoke all on table %I.%I from public',schema_name,relation_row.relname);
    for grant_row in select distinct r.rolname from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      join pg_roles r on r.oid=a.grantee where c.oid=relation_row.oid and r.rolname<>owner_name loop
      execute format('revoke all on table %I.%I from %I',schema_name,relation_row.relname,grant_row.rolname);
    end loop;
  end loop;
  for function_row in select p.oid,p.proname,pg_get_function_identity_arguments(p.oid) arguments
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=schema_name and p.proname in (
      'catalogue_advance_validation_generation_v2','catalogue_guard_validation_context_v2',
      'catalogue_guard_validation_evidence_v2','catalogue_guard_validation_generation_v2',
      'catalogue_utf16_sort_key_v2','catalogue_mapping_digest_for_validation_v2',
      'catalogue_assert_validation_context_v2','catalogue_normalize_source_text_v2','catalogue_normalize_gtin_v2',
      'catalogue_begin_validation_v2','catalogue_observe_validation_page_v2',
      'catalogue_compute_record_nutrition_semantics_v2','catalogue_submit_validation_page_v2',
      'catalogue_finish_validation_v2') loop
    execute format('alter function %I.%I(%s) set search_path=pg_catalog,%I,pg_temp',schema_name,function_row.proname,function_row.arguments,schema_name);
    execute format('alter function %I.%I(%s) owner to %I',schema_name,function_row.proname,function_row.arguments,owner_name);
    execute format('revoke all on function %I.%I(%s) from public',schema_name,function_row.proname,function_row.arguments);
    for grant_row in select distinct r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      join pg_roles r on r.oid=a.grantee where p.oid=function_row.oid and r.rolname<>owner_name loop
      execute format('revoke all on function %I.%I(%s) from %I',schema_name,function_row.proname,function_row.arguments,grant_row.rolname);
    end loop;
    if function_row.proname in ('catalogue_begin_validation_v2','catalogue_observe_validation_page_v2',
      'catalogue_submit_validation_page_v2','catalogue_finish_validation_v2') then
      execute format('grant execute on function %I.%I(%s) to nutrition_catalogue_validate',schema_name,function_row.proname,function_row.arguments);
    end if;
  end loop;
end;
$migration$;
