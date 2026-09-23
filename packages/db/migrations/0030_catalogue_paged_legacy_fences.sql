-- Explicitly separate V1 consumers from V2 preparation. Existing function OIDs,
-- grants, owners, search paths and V1 bodies are preserved after a short entry guard.
create function catalogue_reject_legacy_batch_v2(p_batch_id uuid)
returns void language plpgsql stable security definer as $$
begin
  if exists(select 1 from catalogue_preparation_v2 where batch_id=p_batch_id) then
    raise exception 'V2 preparation requires its versioned consumer; legacy catalogue operation is unavailable'
      using errcode='55000';
  end if;
end;
$$;
create function catalogue_reject_legacy_record_v2(p_record_id bigint)
returns void language plpgsql stable security definer as $$
begin
  if exists(select 1 from food_import_record r join catalogue_preparation_v2 p on p.batch_id=r.batch_id
    where r.id=p_record_id) then
    raise exception 'V2 record cannot enter a legacy semantic consumer' using errcode='55000';
  end if;
end;
$$;
create index catalogue_legacy_release_batch_v2_idx on food_import_batch(release_id) where release_id is not null;
create function catalogue_reject_legacy_release_v2(p_release_id uuid)
returns void language plpgsql stable security definer as $$
begin
  if p_release_id is not null and exists(
    select 1 from food_import_batch b join catalogue_preparation_v2 p on p.batch_id=b.id
    where b.release_id=p_release_id
  ) then raise exception 'V2 preparation cannot be a legacy release or rollback target' using errcode='55000'; end if;
end;
$$;
create function catalogue_reject_legacy_stage_document_v2(p_document text)
returns void language plpgsql security definer as $$
declare document jsonb; source_id_value bigint;
begin
  -- Preserve the original function's malformed/oversize-input error path.
  if p_document is null or octet_length(p_document) not between 1 and 65536 then return; end if;
  begin document:=p_document::jsonb; exception when invalid_text_representation then return; end;
  if jsonb_typeof(document)<>'object' then return; end if;
  select id into source_id_value from food_source where code=document->>'sourceCode';
  if not found then return; end if;
  -- Match the legacy constructor's existing lineage lock before checking the
  -- companion. VOLATILE gives the following query a fresh snapshot after waiting.
  -- A concurrent V2 constructor therefore cannot be resumed through the V1 API.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-stage-attempt:v1'),
    pg_catalog.hashtext(source_id_value::text || ':' || (document->>'releaseKey') || ':' ||
      (document->>'artifactSha256') || ':' || (document->>'parserVersion'))
  );
  if exists(select 1 from food_import_batch b
    join food_source s on s.id=b.food_source_id
    join catalogue_preparation_v2 p on p.batch_id=b.id
    where s.code=document->>'sourceCode' and b.release_key=document->>'releaseKey'
      and b.artifact_sha256=document->>'artifactSha256' and b.parser_version=document->>'parserVersion') then
    raise exception 'V2 staging resume requires its admitted versioned interface' using errcode='55000';
  end if;
end;
$$;

create function catalogue_guard_legacy_batch_preparation_v2()
returns trigger language plpgsql as $$
begin
  if exists(select 1 from catalogue_preparation_v2 where batch_id=old.id) then
    if tg_op='DELETE' then raise exception 'V2 preparation lineage cannot be removed' using errcode='55000'; end if;
    if new.status not in ('staging','failed') or new.staging_seal_sha256 is not null or new.staging_sealed_at is not null
      or new.validated_at is not null or new.completed_at is not null or new.release_id is not null
      or new.validation_digest is not null or new.validated_food_contract_version is not null
      or new.nutrient_mapping_digest is not null or new.nutrient_mapping_revision_ids is not null
      or new.nutrition_semantic_contract_version is not null or new.nutrition_semantic_sha256 is not null
      or new.validated_database_principal is not null or new.validated_database_capability_role is not null
      or new.valid_count<>0 or new.quarantined_count<>0 or new.unresolved_error_count<>0
      or new.warning_count<>0 or new.nutrient_input_count<>0 or new.nutrient_materializable_count<>0
      or new.nutrient_excluded_count<>0 or new.materialized_count<>0 or new.validation_policy<>'{}'::jsonb then
      raise exception 'V2 preparation cannot write legacy classification, seal, approval or materialization evidence'
        using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger food_import_batch_preparation_legacy_fence_v2 before update or delete on food_import_batch
  for each row execute function catalogue_guard_legacy_batch_preparation_v2();

create function catalogue_guard_legacy_record_preparation_v2()
returns trigger language plpgsql as $$
begin
  if exists(select 1 from catalogue_preparation_v2 where batch_id=old.batch_id) then
    raise exception 'V2 source records remain immutable; validation belongs to companion evidence'
      using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger food_import_record_preparation_legacy_fence_v2 before update or delete on food_import_record
  for each row execute function catalogue_guard_legacy_record_preparation_v2();

-- An unexpected historical function body stops the migration; it is never patched
-- by signature alone. The body insertion retains every original V1 statement.
do $migration$
declare
  schema_name text:=current_schema(); workflow_owner oid; expected record; target oid;
  definition text; source text; new_source text; begin_position integer;
begin
  select relowner into workflow_owner from pg_class where oid='food_import_batch'::regclass;
  if current_user::regrole::oid is distinct from workflow_owner then
    raise exception 'legacy preparation fencing requires workflow owner' using errcode='42501';
  end if;
  for expected in select * from (values
    ('catalogue_attest_import_nutrition_semantics(uuid)','e2c35dfabb653636a9640475227104a485a24129558b11511175831ef9bc5b8b',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_compute_import_staging_seal(uuid)','399d40c2913c2022c0a2921d5870a2d26a5dcd9949d81715882f70899db4f5f8',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_compute_record_nutrition_semantics(bigint)','41f048090dce80b794615f135f5368f7f501eaecfc3513471eb6d1f36c022783',E'  perform catalogue_reject_legacy_record_v2(p_record_id);\n'),
    ('catalogue_observe_import_validation(uuid)','0a87bc99f5df97282c48b6202799bcc75cdb914e7473c0c38e092aaf4a132acf',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_promote_import_batch(uuid,text,text)','bd8f0714717baf626507a2d40799cea75085f20e9df7295b77fb5899529f2142',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_promote_import_batch_v1(uuid,text,text)','115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_record_import_approval(uuid,text,text,text,text,text)','73314f5d97251a648093a82d8d9f6d3575a8f3b571d16349ca60a9795de04719',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_record_import_approval_v1(uuid,text,text,text,text,text)','89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_rollback_source_release(text,uuid,text,text)','a6b7cce658727edcfc889eac7272e65b094592361459130c815436c8f1cc14d7',E'  perform catalogue_reject_legacy_release_v2(p_target_release_id);\n'),
    ('catalogue_rollback_source_release_v1(text,uuid,text,text)','3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1',E'  perform catalogue_reject_legacy_release_v2(p_target_release_id);\n'),
    ('catalogue_stage_import_batch(text)','11b0a983c9cf3d4a7451978d37e5fe997a40290a10e741ba0626b89bfd2611c4',E'  perform catalogue_reject_legacy_stage_document_v2(p_stage_document);\n'),
    ('catalogue_stage_import_parser_report(uuid,text)','d89defb335e21228c38968ef69b2ed7342f5a5440762ae31f170969fbcc9c9e8',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_stage_import_record_chunk(uuid,bigint,text)','4cc2b310ba6fda051a125bb203c0cf2c6a5fbe227a55daf517a0376ab79e4c7f',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_validate_import_batch(uuid,text,text,text)','10c59084d8e5c7debb581c6e749f6779dbc3f5867fc4cb18ffc009293f9f50a5',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n'),
    ('catalogue_validate_import_batch_v1(uuid,text,text,text)','5b7ae15625fb0ae0d88a9512fe82fca69a9d0dd9e179af8bc1b2f42d1e85ac8a',E'  perform catalogue_reject_legacy_batch_v2(p_batch_id);\n')
  ) guards(identity,source_sha256,prelude)
  loop
    target:=to_regprocedure(format('%I.%s',schema_name,expected.identity));
    select p.prosrc,pg_get_functiondef(p.oid) into source,definition from pg_proc p
      join pg_language l on l.oid=p.prolang where p.oid=target and p.proowner=workflow_owner
        and p.prosecdef and l.lanname='plpgsql';
    if not found or encode(sha256(convert_to(source,'UTF8')),'hex')<>expected.source_sha256 then
      raise exception 'legacy function body differs before V2 fence: %',expected.identity using errcode='55000';
    end if;
    begin_position:=strpos(source,E'\nbegin\n');
    if begin_position=0 or strpos(source,'catalogue_reject_legacy_')<>0 or strpos(definition,source)=0 then
      raise exception 'legacy function entry differs before V2 fence: %',expected.identity using errcode='55000';
    end if;
    new_source:=overlay(source placing expected.prelude from begin_position+length(E'\nbegin\n') for 0);
    definition:=overlay(definition placing new_source from strpos(definition,source) for length(source));
    execute definition;
    if (select prosrc from pg_proc where oid=target) is distinct from new_source then
      raise exception 'legacy V2 fence postflight differs: %',expected.identity using errcode='55000';
    end if;
  end loop;
end;
$migration$;

do $migration$
declare schema_name text:=current_schema(); owner_name text; function_row record; grant_row record;
begin
  select pg_get_userbyid(relowner) into owner_name from pg_class where oid='food_import_batch'::regclass;
  for function_row in select p.oid,p.proname,pg_get_function_identity_arguments(p.oid) arguments
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=schema_name and p.proname in (
      'catalogue_reject_legacy_batch_v2','catalogue_reject_legacy_record_v2','catalogue_reject_legacy_release_v2',
      'catalogue_reject_legacy_stage_document_v2','catalogue_guard_legacy_batch_preparation_v2',
      'catalogue_guard_legacy_record_preparation_v2') loop
    execute format('alter function %I.%I(%s) set search_path=pg_catalog,%I,pg_temp',schema_name,function_row.proname,function_row.arguments,schema_name);
    execute format('alter function %I.%I(%s) owner to %I',schema_name,function_row.proname,function_row.arguments,owner_name);
    execute format('revoke all on function %I.%I(%s) from public',schema_name,function_row.proname,function_row.arguments);
    for grant_row in select distinct r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      join pg_roles r on r.oid=a.grantee where p.oid=function_row.oid and r.rolname<>owner_name loop
      execute format('revoke all on function %I.%I(%s) from %I',schema_name,function_row.proname,function_row.arguments,grant_row.rolname);
    end loop;
  end loop;
end;
$migration$;
