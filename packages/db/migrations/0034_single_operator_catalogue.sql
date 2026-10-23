-- The user permanently revoked mandatory human review and signatures on 2026-10-23.
-- Retain history, actor authorization, immutable inputs, validation, budgets and recovery.
-- One restricted operator may hold explicit stage, validate, publish and rollback roles.
do $migration$
declare expected record; target oid; original pg_proc%rowtype; actual pg_proc%rowtype;
  source text; updated text; definition text; workflow_owner oid;
begin
  select relowner into workflow_owner from pg_class where oid='food_import_batch'::regclass;
  if current_user::regrole::oid is distinct from workflow_owner then
    raise exception 'catalogue operator-policy migration requires workflow owner' using errcode='42501';
  end if;
  for expected in select * from (values
    ('guard_food_import_batch_stage_validate_authority','f21dfa9d5455a40ab9f50bdbace02ffc19f53ab252e0eab99a4f50769f678eda','052a0bbc5f44a90c5e439262993e085edc5e92b97df1f66b0c6b05e89083522f',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate'$patch$,$patch$not coalesce('nutrition_catalogue_validate' = any(capabilities), false)$patch$),
    ('guard_food_import_batch_stage_validate_authority','052a0bbc5f44a90c5e439262993e085edc5e92b97df1f66b0c6b05e89083522f','a7e0b21e8c4edb0e6730198c9bddcd7cb90f8919d79f8d7765920d5028414c56',2,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
        or capabilities[1] <> 'nutrition_catalogue_stage'$patch$,$patch$not coalesce('nutrition_catalogue_stage' = any(capabilities), false)$patch$),
    ('catalogue_stage_import_record_chunk','d8e8d2354606768fdcaacd280fd2255359ace98758b3d8377f90a94e802541a2','70a9be43d627d15d456a5ba7c2af3da9527d6251c70089ac89ae419b5812e0c7',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage'$patch$,$patch$not coalesce('nutrition_catalogue_stage' = any(capabilities), false)$patch$),
    ('catalogue_stage_import_batch','e35607a581873d4b7c3b092be4c60a63026b71db21e447c87c79aebb42e21445','59f39588711cb8c97d8178ad0d6992b531a12be8a9101924687e5718b282c806',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage'$patch$,$patch$not coalesce('nutrition_catalogue_stage' = any(capabilities), false)$patch$),
    ('catalogue_stage_import_parser_report','111c05a916f5fdce9be9ec6117d8220a239fff749efd628afb4164b3dc89f6a5','53771f5e5417fb1efc5fd42d2696def09a6fdb5e1540b93b80a38a42f2caeb6b',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_stage'$patch$,$patch$not coalesce('nutrition_catalogue_stage' = any(capabilities), false)$patch$),
    ('catalogue_observe_import_validation','84179971a6b8f171436efc1807e4e89c0f4b19bd3778b56bf3dea896aab009a2','09fae00ad1f2f7b8300f2374d25f5405aae0fa11a0148d920a846e3ec96d4862',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate'$patch$,$patch$not coalesce('nutrition_catalogue_validate' = any(capabilities), false)$patch$),
    ('catalogue_validate_import_batch_v1','0c14bff909d45e0fc0082962484db94af8853761d82e7654dc4494fc78f0d294','01601081024b94b7c0895e96f19563bab7b529a385e945c3c9712affe9ced8f5',1,$patch$coalesce(pg_catalog.cardinality(capabilities), 0) <> 1
      or capabilities[1] <> 'nutrition_catalogue_validate'$patch$,$patch$not coalesce('nutrition_catalogue_validate' = any(capabilities), false)$patch$),
    ('catalogue_promote_import_batch_v1','2d5733cf34f2119db2e18564469fc76adf892172a936b1bfcbd21b3899629c96','5c530927354957bb28fb7e0e233d04ce73f807e1ed0ec5f80acf6bf960f8e120',1,$patch$coalesce(pg_catalog.cardinality(catalogue_capabilities), 0) <> 1
      or catalogue_capabilities[1] <> 'nutrition_catalogue_promote_activate'$patch$,$patch$not coalesce('nutrition_catalogue_promote_activate' = any(catalogue_capabilities), false)$patch$),
    ('catalogue_rollback_source_release_v1','a2cf554f00f20d13720e268e3778eca9e26064da34291befa9b75f3dbe55b915','4bf91bf7c1952578e788ee93372f59c8cf7164f42d6e8857e98ee66e7c481550',1,$patch$coalesce(pg_catalog.cardinality(catalogue_capabilities), 0) <> 1
      or catalogue_capabilities[1] <> 'nutrition_catalogue_rollback'$patch$,$patch$not coalesce('nutrition_catalogue_rollback' = any(catalogue_capabilities), false)$patch$),
    ('catalogue_require_preparation_role_v2','7a1284c7da1e999e2ac0c72eef8171f029c88986c423f2a1edb6b300260d38a1','85ddcd4c7882280045d10830d4dc04d153f2dc0e33d80609043579e38a8eec81',1,$patch$p_role is null or pg_catalog.cardinality(capabilities) is distinct from 1
    or capabilities[1] is distinct from p_role$patch$,$patch$p_role is null or not coalesce(p_role = any(capabilities), false)$patch$),
    ('guard_food_import_batch_stage_validate_authority','a7e0b21e8c4edb0e6730198c9bddcd7cb90f8919d79f8d7765920d5028414c56','d9e807d9655adec93c649c5c9ee896de182c76a8d6ade0f7d9f01d1cf9b148bb',1,$patch$
      or new.validated_database_principal = new.staged_database_principal$patch$,$patch$$patch$),
    ('catalogue_observe_import_validation','09fae00ad1f2f7b8300f2374d25f5405aae0fa11a0148d920a846e3ec96d4862','e20221d5b0840248f0c8f97f56ff92f3d4a8a72aaddb8834a6258d92ce183aed',1,$patch$
    or batch_row.staged_database_principal = session_user::text$patch$,$patch$$patch$),
    ('catalogue_validate_import_batch_v1','01601081024b94b7c0895e96f19563bab7b529a385e945c3c9712affe9ced8f5','3bb445892918de4c43e98ba0bc8585755cf23ba99577811de217edcb5fac4769',1,$patch$
    or batch_row.staged_database_principal = session_user::text$patch$,$patch$$patch$),
    ('catalogue_guard_validation_context_v2','5b67d69a31c82a3ed6900ab465babeb55801ed06c0a581ed8a75f83deec49215','5fe9d3cc0d0a75d8b8eb7a4d529fbe725e66f1f75e6845e9fca27474d7006ed2',1,$patch$ or batch.staged_database_principal=actor$patch$,$patch$$patch$),
    ('catalogue_begin_validation_v2','c9e6e03fede89ffabf900d5237190688bdb1be0afb220a17b2d1cb89e1193a7c','1babefd82ef71842bf204754189f8a2efb045bba8da70183e0ca78c2ab2b2b1d',1,$patch$ or batch.staged_database_principal=actor$patch$,$patch$$patch$),
    ('catalogue_guard_preparation_v2','466ee7633cffcec06195d3beff8479bc221eced092665965aef7eb059c2b84a2','67d4b8df431259afd572ab0e81c39bb21a19419b48d634f37fcc652fdee11dd1',1,$patch$'nutrition_catalogue_approve_data','nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights'$patch$,$patch$'nutrition_catalogue_promote_activate','nutrition_catalogue_rollback'$patch$),
    ('catalogue_admit_preparation_v2','186afb6bae243ba6d53966399ac26218cc46458a674988fce999aef3db307c41','8b3bc96fd6408937a4a7f9a1714589643499d1faa6fb82397aa4c93456505ac5',1,$patch$'nutrition_catalogue_approve_quality'$patch$,$patch$'nutrition_catalogue_stage'$patch$),
    ('catalogue_guard_preparation_evidence_insert_v2','87129394a8edb35f750a730d56b07d40edac99492609838eb113912e0033a04b','5003aa66280b33a8d800932dac22185585e6589bbeb90307ee45e8d24f2604c9',1,$patch$'nutrition_catalogue_approve_quality'$patch$,$patch$'nutrition_catalogue_stage'$patch$),
    ('catalogue_admit_preparation_v2','8b3bc96fd6408937a4a7f9a1714589643499d1faa6fb82397aa4c93456505ac5','6101c101a83927e4e3f340fa3781c60f4579a4c01b5b6a81f7ca806d14a0ffb0',1,$patch$document ->> 'stagePrincipal' = actor or $patch$,$patch$$patch$),
    ('catalogue_admit_publication_v2','f6f98257e2605be175f65c2a63634dd1b23c9f616c479e5bd7e14f3cb3656945','95e0b9e39fc6e63c11371774648f751a34d02671162a19d5ece06ea4c8771060',1,$patch$'nutrition_catalogue_approve_quality'$patch$,$patch$'nutrition_catalogue_promote_activate'$patch$),
    ('catalogue_guard_publication_v2','649b36ed52f65e1888d1ba52dd8228f4fe671b0f4037d438891dabf89d8955e9','bc488ca759cb25f462d6736411a2d8e4421fc6f8a983bf5d1565a55ab1d39310',1,$patch$'nutrition_catalogue_approve_quality'$patch$,$patch$'nutrition_catalogue_promote_activate'$patch$),
    ('catalogue_admit_publication_v2','95e0b9e39fc6e63c11371774648f751a34d02671162a19d5ece06ea4c8771060','46d59a772f0384e1a534395e2ebdcdf93297b7bdc6d241ecb4ff9c450ca47dc8',1,$patch$ or d->>'publisherPrincipal'=actor$patch$,$patch$$patch$),
    ('catalogue_guard_publication_v2','bc488ca759cb25f462d6736411a2d8e4421fc6f8a983bf5d1565a55ab1d39310','51603fa2fe8f126b701429c8db38d9cfa775e6e81a7bf73bac924ae2163e82e7',1,$patch$ or new.publisher_principal=actor$patch$,$patch$$patch$),
    ('catalogue_admit_publication_v2','46d59a772f0384e1a534395e2ebdcdf93297b7bdc6d241ecb4ff9c450ca47dc8','b4d6679fe957735095d4ebe58c2f3748b0919a1123976f0ebbe77e3be98198bc',1,$patch$  if not exists(select 1 from catalogue_paged_approval_v2 where batch_id=batch and approval_role='quality' and database_principal=actor) then
    raise exception 'publication budget requires exact quality reviewer' using errcode='42501'; end if;
$patch$,$patch$$patch$),
    ('catalogue_assert_publication_approvals_v2','0cc9ca58fd5951e5a7891768452e8aac54eeb04658d30b906633146c1df37eb8','4a62c733ebefaae125ec6681dbe398b8073d27dd7d3965fa25fbb4a4f3fa7588',1,$patch$ or c.validator_principal=p_actor or b.staged_database_principal=p_actor
    or (select count(*) from catalogue_paged_approval_v2 where batch_id=p_batch_id)<>3
    or (select count(distinct database_principal) from catalogue_paged_approval_v2 where batch_id=p_batch_id)<>3
    or exists(select 1 from catalogue_paged_approval_v2 a where a.batch_id=p_batch_id and
      (a.context_sha256 is distinct from p_context or a.validation_terminal_sha256 is distinct from p_terminal
      or a.report_sha256 is distinct from p_report or a.rights_manifest_sha256 is distinct from b.rights_manifest_sha256
      or a.database_principal=p_actor or a.database_principal=c.validator_principal or a.database_principal=b.staged_database_principal)) then$patch$,$patch$ then$patch$),
    ('catalogue_assert_publication_approvals_v2','4a62c733ebefaae125ec6681dbe398b8073d27dd7d3965fa25fbb4a4f3fa7588','23e06a59ffa4be8f1594cb7bb743779b764489bdc3d141ec835f4bd6cea70050',1,$patch$publication requires exact terminal and three independent reviewer decisions$patch$,$patch$publication requires the exact validated terminal and completed reconciliation$patch$),
    ('catalogue_promote_import_batch_v1','5c530927354957bb28fb7e0e233d04ce73f807e1ed0ec5f80acf6bf960f8e120','95960c2b7a1a534fc006c07166638f98d5f558d0fa715662361f19bfda17b2b7',1,$patch$  select pg_catalog.count(*) into approval_count
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

$patch$,$patch$$patch$),
    ('catalogue_begin_validation_v2','1babefd82ef71842bf204754189f8a2efb045bba8da70183e0ca78c2ab2b2b1d','a7e737ca8feef3f304acafdcd020db4b18a16edeba6b430bad47f34e09e236fb',1,$patch$'requireDistinctApprovalPrincipals',$patch$,$patch$$patch$),
    ('catalogue_begin_validation_v2','a7e737ca8feef3f304acafdcd020db4b18a16edeba6b430bad47f34e09e236fb','b17f815d64e27518c38c444530d2d65eefd1a58103bfda0783345a4eb23d1056',1,$patch$
    or policy->'requireDistinctApprovalPrincipals' is distinct from 'true'::jsonb$patch$,$patch$$patch$),
    ('catalogue_begin_validation_v2','b17f815d64e27518c38c444530d2d65eefd1a58103bfda0783345a4eb23d1056','86753e48446c62db0ed07df3f6eae218e67226339304388536ba3f84a46d2448',1,$patch$from jsonb_object_keys(policy))<>6$patch$,$patch$from jsonb_object_keys(policy))<>5$patch$),
    ('catalogue_validate_import_batch_v1','3bb445892918de4c43e98ba0bc8585755cf23ba99577811de217edcb5fac4769','17fa26b04f170901e6a82d962690fe14fc0def688a88aa9c72b9a0770fe8001e',1,$patch$'requireDistinctApprovalPrincipals',$patch$,$patch$$patch$),
    ('catalogue_validate_import_batch_v1','17fa26b04f170901e6a82d962690fe14fc0def688a88aa9c72b9a0770fe8001e','3763a9e9b51d1f5eeab786f801ee778289b431214aa00963ff5ef112cd0bb841',1,$patch$
    or pg_catalog.jsonb_typeof(validation_policy_value -> 'requireDistinctApprovalPrincipals') <> 'boolean'$patch$,$patch$$patch$),
    ('catalogue_validate_import_batch_v1','3763a9e9b51d1f5eeab786f801ee778289b431214aa00963ff5ef112cd0bb841','2a063eec6e102d0f69931b6f8a26d7179071e19fdd145e9039150a6ed35e6532',1,$patch$count(*) from pg_catalog.jsonb_object_keys(validation_policy_value)) <> 6$patch$,$patch$count(*) from pg_catalog.jsonb_object_keys(validation_policy_value)) <> 5$patch$),
    ('catalogue_reconciliation_baseline_header_v2','955240cc42ddb8daa2a4420334f4517b4bbb99cd8f51233dfeb43dd3a1843a53','c1380bb8902da52a6cc090ba43984494813489529f8088886e5ddf9a6be573b3',1,$patch$    if jsonb_array_length(approvals)<>3
      or (select count(distinct approval_role) from catalogue_paged_approval_v2 where batch_id=baseline.id)<>3
      or (select count(distinct database_principal) from catalogue_paged_approval_v2 where batch_id=baseline.id)<>3
      or exists(select 1 from catalogue_paged_approval_v2 a where a.batch_id=baseline.id
        and (a.database_principal=validation.validator_principal or a.database_principal=publication.publisher_principal
          or a.database_principal=baseline.staged_database_principal or a.validation_terminal_sha256<>publication.validation_terminal_sha256
          or a.context_sha256<>reconciliation.context_sha256 or a.report_sha256<>publication.report_sha256
          or a.rights_manifest_sha256<>baseline.rights_manifest_sha256)) then
      raise exception 'V2 baseline reviewer evidence differs from completed reconciliation' using errcode='55000';
    end if;
$patch$,$patch$$patch$),
    ('catalogue_reconciliation_baseline_header_v2','c1380bb8902da52a6cc090ba43984494813489529f8088886e5ddf9a6be573b3','fff36dac9cfee472cb04468a27d0528461a679765e56f47ab06dc4cb44dd27c2',1,$patch$  if pg_catalog.jsonb_array_length(approvals)<>3 or exists(select 1 from food_import_approval a
    where a.batch_id=baseline.id and (a.validation_digest<>baseline.validation_digest
      or a.rights_manifest_sha256<>baseline.rights_manifest_sha256))
    or (select count(distinct approval_role) from food_import_approval where batch_id=baseline.id)<>3
    or (coalesce((baseline.validation_policy->>'requireDistinctApprovalPrincipals')::boolean,false)
      and (select count(distinct principal_id) from food_import_approval where batch_id=baseline.id)<>3) then
    raise exception 'baseline immutable approvals differ' using errcode='55000';
  end if;
$patch$,$patch$$patch$),
    ('catalogue_read_reconciliation_page_v2','561cf06b1a8324ba8ce552fe6c0fe75169e95311ab03401dcf6c4e063cd71cf5','f5048c85e166b3e2577238defc8acb140667dbaadd6916da4ebdf14c2236a717',1,$patch$actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_'||p_role);$patch$,$patch$actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');$patch$),
    ('guard_food_source_release_activation_authority','54f0413a565c93fc6d76846873844a03488594580250ba2bc1c9f4117d3ab68a','8bdfb048a53a741ed7967c19c65669107753d66d1e5174bde7aeff32110ea599',1,$patch$coalesce(pg_catalog.cardinality(activation_capabilities), 0) <> 1
      or activation_capabilities[1] <> expected_capability$patch$,$patch$not coalesce(expected_capability = any(activation_capabilities), false)$patch$)
  ) patches(name,before_sha,after_sha,occurrences,old_text,new_text)
  loop
    select p.* into strict original from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      join pg_language l on l.oid=p.prolang where n.nspname=current_schema() and p.proname=expected.name
        and p.proowner=workflow_owner and l.lanname='plpgsql';
    target:=original.oid; source:=original.prosrc;
    if encode(sha256(convert_to(source,'UTF8')),'hex')<>expected.before_sha
      or (length(source)-length(replace(source,expected.old_text,'')))/length(expected.old_text)<>expected.occurrences then
      raise exception 'catalogue function differs before operator-policy migration: %',expected.name using errcode='55000';
    end if;
    updated:=replace(source,expected.old_text,expected.new_text);
    if encode(sha256(convert_to(updated,'UTF8')),'hex')<>expected.after_sha then
      raise exception 'catalogue operator-policy replacement differs' using errcode='55000';
    end if;
    definition:=pg_get_functiondef(target);
    definition:=overlay(definition placing updated from strpos(definition,source) for length(source));
    execute definition;
    select * into strict actual from pg_proc where oid=target;
    if actual.prosrc is distinct from updated or row(actual.proowner,actual.proacl,actual.proconfig,actual.prosecdef,
      actual.provolatile,actual.proisstrict,actual.proparallel,actual.proleakproof)
      is distinct from row(original.proowner,original.proacl,original.proconfig,original.prosecdef,
      original.provolatile,original.proisstrict,original.proparallel,original.proleakproof) then
      raise exception 'catalogue operator-policy postflight differs' using errcode='55000';
    end if;
  end loop;
end;
$migration$;

alter table catalogue_preparation_admission_v2 drop constraint catalogue_preparation_admission_v2_check;
alter table catalogue_publication_admission_v2 drop constraint cat_pub_admit_v2_check_1;
alter table food_import_batch drop constraint food_import_batch_stage_validate_database_authority_check;
alter table food_import_batch add constraint food_import_batch_stage_validate_database_authority_check check (
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
          )
        )
      )
    ) is true
  );

revoke execute on function catalogue_admit_preparation_v2(text) from nutrition_catalogue_approve_quality;
grant execute on function catalogue_admit_preparation_v2(text) to nutrition_catalogue_stage;
revoke execute on function catalogue_admit_publication_v2(text) from nutrition_catalogue_approve_quality;
grant execute on function catalogue_admit_publication_v2(text) to nutrition_catalogue_promote_activate;
revoke execute on function catalogue_read_reconciliation_page_v2(uuid,text,bigint,text,text)
  from nutrition_catalogue_approve_data,nutrition_catalogue_approve_quality,nutrition_catalogue_approve_rights;
grant execute on function catalogue_read_reconciliation_page_v2(uuid,text,bigint,text,text) to nutrition_catalogue_validate;
revoke execute on function catalogue_record_import_approval(uuid,text,text,text,text,text),
  catalogue_record_import_approval_v1(uuid,text,text,text,text,text),
  catalogue_record_paged_approval_v2(uuid,text,text,text,text,text,text,text)
  from nutrition_catalogue_approve_data,nutrition_catalogue_approve_quality,nutrition_catalogue_approve_rights;
