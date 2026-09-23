-- Paged preparation evidence and reviewer decisions. No release or activation.
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('catalogue-preparation-v2'));

create table catalogue_reconciliation_v2 (
  batch_id uuid primary key references catalogue_validation_context_v2(batch_id),
  context_sha256 text not null check(context_sha256 ~ '^[0-9a-f]{64}$'),
  validation_terminal_sha256 text not null check(validation_terminal_sha256 ~ '^[0-9a-f]{64}$'),
  validator_principal text not null,
  baseline_batch_id uuid references food_import_batch(id),
  baseline_release_id uuid references food_source_release(id),
  phase text not null check(phase in ('metadata','baseline','candidate','removed','complete')),
  next_sequence bigint not null default 0 check(next_sequence >= 0),
  page_count bigint not null default 0 check(page_count >= 0),
  page_commitment_sha256 text not null check(page_commitment_sha256 ~ '^[0-9a-f]{64}$'),
  baseline_records bigint not null default 0,
  baseline_payload_bytes bigint not null default 0,
  baseline_valid_count bigint not null default 0,
  baseline_quarantined_count bigint not null default 0,
  baseline_nutrient_count bigint not null default 0,
  baseline_portion_count bigint not null default 0,
  baseline_materializable_nutrients bigint not null default 0,
  baseline_excluded_nutrients bigint not null default 0,
  baseline_warning_count bigint not null default 0,
  baseline_error_count bigint not null default 0,
  candidate_records bigint not null default 0,
  added_count bigint not null default 0,
  changed_count bigint not null default 0,
  unchanged_count bigint not null default 0,
  removed_count bigint not null default 0,
  quarantined_count bigint not null default 0,
  terminal_sha256 text check(terminal_sha256 ~ '^[0-9a-f]{64}$'),
  terminal_receipt jsonb,
  check((terminal_sha256 is null) = (terminal_receipt is null))
);
create table catalogue_reconciliation_baseline_v2 (
  batch_id uuid not null references catalogue_reconciliation_v2(batch_id),
  sequence_number bigint not null,
  source_food_key text not null,
  envelope jsonb not null,
  primary key(batch_id,sequence_number), unique(batch_id,source_food_key)
);
create table catalogue_reconciliation_page_v2 (
  batch_id uuid not null references catalogue_reconciliation_v2(batch_id),
  page_number bigint not null check(page_number > 0),
  document text not null check(pg_catalog.octet_length(document) <= 16777216),
  receipt jsonb not null,
  primary key(batch_id,page_number)
);
create table catalogue_paged_approval_v2 (
  batch_id uuid not null references catalogue_reconciliation_v2(batch_id),
  approval_role text not null check(approval_role in ('data','quality','rights')),
  database_principal text not null,
  rights_manifest_sha256 text not null check(rights_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  validation_terminal_sha256 text not null check(validation_terminal_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null check(context_sha256 ~ '^[0-9a-f]{64}$'),
  report_sha256 text not null check(report_sha256 ~ '^[0-9a-f]{64}$'),
  approval_reference text not null,
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(batch_id,approval_role), unique(batch_id,database_principal)
);
create trigger catalogue_reconciliation_baseline_v2_immutable before update or delete
 on catalogue_reconciliation_baseline_v2 for each row execute function reject_immutable_row_update();
create trigger catalogue_reconciliation_page_v2_immutable before update or delete
 on catalogue_reconciliation_page_v2 for each row execute function reject_immutable_row_update();
create trigger catalogue_paged_approval_v2_immutable before update or delete
 on catalogue_paged_approval_v2 for each row execute function reject_immutable_row_update();

create function guard_catalogue_reconciliation_state_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor text; expected jsonb;
begin
  if tg_op in ('DELETE','TRUNCATE') then raise exception 'reconciliation preparation cannot be deleted or truncated' using errcode='55000'; end if;
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  if new.validator_principal is distinct from actor then raise exception 'reconciliation belongs to another validator' using errcode='42501'; end if;
  perform catalogue_assert_validation_context_v2(new.batch_id);
  if tg_op='INSERT' then
    expected:=catalogue_reconciliation_input_v2(new.batch_id,new.validation_terminal_sha256);
    if new.context_sha256 is distinct from expected->>'contextSha256' or new.phase<>'metadata'
      or new.page_count<>0 or new.next_sequence<>0 or new.baseline_records<>0 or new.candidate_records<>0
      or new.terminal_sha256 is not null or new.terminal_receipt is not null
      or new.page_commitment_sha256<>catalogue_frame_sha256_v2('reconciliation-start',array[new.batch_id::text,new.context_sha256]) then
      raise exception 'reconciliation initial state differs from authenticated context' using errcode='55000'; end if;
  else
    if row(new.batch_id,new.context_sha256,new.validation_terminal_sha256,new.validator_principal,new.baseline_batch_id,new.baseline_release_id)
      is distinct from row(old.batch_id,old.context_sha256,old.validation_terminal_sha256,old.validator_principal,old.baseline_batch_id,old.baseline_release_id)
      or old.terminal_sha256 is not null or new.page_count<old.page_count or new.page_count>old.page_count+1
      or new.baseline_records<old.baseline_records or new.candidate_records<old.candidate_records
      or new.baseline_payload_bytes<old.baseline_payload_bytes then
      raise exception 'reconciliation immutable identity or monotonic state differs' using errcode='55000'; end if;
    if new.terminal_sha256 is not null and (old.phase<>'complete' or new.phase<>'complete'
      or new.page_count<>old.page_count or new.page_commitment_sha256<>old.page_commitment_sha256) then
      raise exception 'reconciliation terminal requires the completed page chain' using errcode='55000'; end if;
  end if;
  return new;
end;
$$;

create function guard_catalogue_reconciliation_evidence_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor text; state catalogue_reconciliation_v2%rowtype;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  perform catalogue_assert_validation_context_v2(new.batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=new.batch_id;
  if state.validator_principal<>actor or state.terminal_sha256 is not null or state.phase='complete' then
    raise exception 'reconciliation evidence requires its active independent validator' using errcode='42501'; end if;
  if tg_table_name='catalogue_reconciliation_baseline_v2' then
    if state.phase<>'baseline' then raise exception 'baseline evidence is outside its phase' using errcode='55000'; end if;
  elsif new.page_number<>state.page_count+1 or new.receipt->>'contextSha256' is distinct from state.context_sha256
    or new.receipt->>'previousCommitmentSha256' is distinct from state.page_commitment_sha256
    or new.receipt->>'document' is distinct from new.document
    or new.receipt->>'documentSha256' is distinct from encode(sha256(convert_to(new.document,'UTF8')),'hex') then
    raise exception 'reconciliation page evidence differs from its active chain' using errcode='55000';
  end if;
  return new;
end;
$$;

create function guard_catalogue_paged_approval_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor text; state catalogue_reconciliation_v2%rowtype;
begin
  if new.approval_role not in ('data','quality','rights') then raise exception 'unsupported reviewer role' using errcode='22023'; end if;
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_'||new.approval_role);
  perform catalogue_assert_validation_context_v2(new.batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=new.batch_id;
  if new.database_principal is distinct from actor or actor=state.validator_principal
    or state.phase<>'complete' or new.report_sha256 is distinct from state.terminal_sha256
    or new.context_sha256 is distinct from state.context_sha256
    or new.validation_terminal_sha256 is distinct from state.validation_terminal_sha256
    or new.rights_manifest_sha256 is distinct from (select rights_manifest_sha256 from food_import_batch where id=new.batch_id) then
    raise exception 'reviewer evidence differs from authenticated report' using errcode='42501'; end if;
  return new;
end;
$$;

create trigger catalogue_reconciliation_state_v2_guard before insert or update or delete on catalogue_reconciliation_v2
 for each row execute function guard_catalogue_reconciliation_state_v2();
create trigger catalogue_reconciliation_baseline_v2_guard before insert on catalogue_reconciliation_baseline_v2
 for each row execute function guard_catalogue_reconciliation_evidence_v2();
create trigger catalogue_reconciliation_page_v2_guard before insert on catalogue_reconciliation_page_v2
 for each row execute function guard_catalogue_reconciliation_evidence_v2();
create trigger catalogue_paged_approval_v2_guard before insert on catalogue_paged_approval_v2
 for each row execute function guard_catalogue_paged_approval_v2();
create trigger catalogue_reconciliation_state_v2_truncate_guard before truncate on catalogue_reconciliation_v2
 for each statement execute function guard_catalogue_reconciliation_state_v2();
create trigger catalogue_reconciliation_baseline_v2_truncate_guard before truncate on catalogue_reconciliation_baseline_v2
 for each statement execute function guard_catalogue_reconciliation_state_v2();
create trigger catalogue_reconciliation_page_v2_truncate_guard before truncate on catalogue_reconciliation_page_v2
 for each statement execute function guard_catalogue_reconciliation_state_v2();
create trigger catalogue_paged_approval_v2_truncate_guard before truncate on catalogue_paged_approval_v2
 for each statement execute function guard_catalogue_reconciliation_state_v2();

-- Header is bounded separately from record pages. Historical pre-contract releases
-- are deliberately ineligible; the unchanged V1 reconciliation remains available.
create function catalogue_reconciliation_baseline_header_v2(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  context_row catalogue_validation_context_v2%rowtype;
  candidate food_import_batch%rowtype;
  baseline food_import_batch%rowtype;
  release_row food_source_release%rowtype;
  parser food_import_parser_report%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  mappings jsonb;
  approvals jsonb;
  result jsonb;
begin
  select * into strict context_row from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if context_row.baseline_release_id is null then return null; end if;
  select * into strict candidate from food_import_batch where id=p_batch_id;
  select * into strict release_row from food_source_release where id=context_row.baseline_release_id;
  select * into strict baseline from food_import_batch where release_id=release_row.id;
  select a.* into strict admission from catalogue_preparation_admission_v2 a
    join catalogue_preparation_v2 p on p.admission_sha256=a.admission_sha256 where p.batch_id=p_batch_id;
  if baseline.food_source_id <> candidate.food_source_id or release_row.food_source_id <> candidate.food_source_id
    or release_row.status <> 'promoted' or release_row.promoted_at is null
    or baseline.status <> 'completed' or baseline.validated_at is null or baseline.completed_at is null
    or baseline.unresolved_error_count <> 0 or baseline.materialized_count <> baseline.valid_count
    or baseline.validated_food_contract_version is distinct from 1
    or baseline.nutrition_semantic_contract_version is distinct from 1
    or baseline.nutrient_mapping_digest is null or baseline.nutrient_mapping_revision_ids is null
    or baseline.staged_count > admission.max_baseline_records
    or release_row.validation_summary->>'validationDigest' is distinct from baseline.validation_digest then
    raise exception 'V2 reconciliation requires an eligible completed V1 frozen-food baseline within admission' using errcode='55000';
  end if;
  if row(release_row.release_key,release_row.published_on,release_row.acquired_at,release_row.artifact_uri,
    release_row.artifact_sha256,release_row.artifact_bytes,release_row.media_type,release_row.upstream_schema_version,
    release_row.parser_version,release_row.rights_manifest_uri,release_row.rights_manifest_sha256,
    release_row.release_class,release_row.evidence_bundle_sha256,release_row.evidence_bundle_uri,
    release_row.evidence_decision_sha256,release_row.evidence_object_version_id,release_row.evidence_valid_until)
    is distinct from row(baseline.release_key,baseline.published_on,baseline.acquired_at,baseline.artifact_uri,
    baseline.artifact_sha256,baseline.artifact_bytes,baseline.media_type,baseline.upstream_schema_version,
    baseline.parser_version,baseline.rights_manifest_uri,baseline.rights_manifest_sha256,
    baseline.release_class,baseline.evidence_bundle_sha256,baseline.evidence_bundle_uri,
    baseline.evidence_decision_sha256,baseline.evidence_object_version_id,baseline.evidence_valid_until) then
    raise exception 'baseline release provenance differs from completed batch' using errcode='55000';
  end if;
  if pg_catalog.jsonb_array_length(baseline.nutrient_mapping_revision_ids) > 4096 then
    raise exception 'baseline historical mapping registry exceeds bounded header limit' using errcode='54000';
  end if;
  select * into strict parser from food_import_parser_report where batch_id=baseline.id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'canonicalUnit',n.canonical_unit,'conversionMultiplier',r.conversion_multiplier::text,
    'nutrientCode',n.code,'nutrientDimension',n.dimension,'nutrientId',n.id::text,
    'nutrientName',n.name,'revisionId',r.id::text,'sourceNutrientKey',r.source_nutrient_key,
    'sourceUnit',r.source_unit
  ) order by r.source_nutrient_key collate "C"),'[]'::jsonb) into mappings
    from source_nutrient_map_revision r join nutrient n on n.id=r.nutrient_id
    where r.food_source_id=baseline.food_source_id and r.id::text in
      (select pg_catalog.jsonb_array_elements_text(baseline.nutrient_mapping_revision_ids));
  if pg_catalog.jsonb_array_length(mappings) <> pg_catalog.jsonb_array_length(baseline.nutrient_mapping_revision_ids) then
    raise exception 'baseline historical mapping revisions are missing' using errcode='55000';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by a.approval_role),'[]'::jsonb)
    into approvals from food_import_approval a where a.batch_id=baseline.id;
  if pg_catalog.jsonb_array_length(approvals)<>3 or exists(select 1 from food_import_approval a
    where a.batch_id=baseline.id and (a.validation_digest<>baseline.validation_digest
      or a.rights_manifest_sha256<>baseline.rights_manifest_sha256))
    or (select count(distinct approval_role) from food_import_approval where batch_id=baseline.id)<>3
    or (coalesce((baseline.validation_policy->>'requireDistinctApprovalPrincipals')::boolean,false)
      and (select count(distinct principal_id) from food_import_approval where batch_id=baseline.id)<>3) then
    raise exception 'baseline immutable approvals differ' using errcode='55000';
  end if;
  result := pg_catalog.jsonb_build_object('batch',pg_catalog.to_jsonb(baseline),
    'release',pg_catalog.to_jsonb(release_row),'parser',pg_catalog.to_jsonb(parser),
    'mappings',mappings,'approvals',approvals,'sourceCode','USDA_FDC');
  if pg_catalog.octet_length(result::text) > 16777216 then
    raise exception 'baseline header exceeds bounded evidence limit' using errcode='54000';
  end if;
  return result;
end;
$$;

create function catalogue_reconciliation_input_v2(p_batch_id uuid,p_validation_terminal_sha256 text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  actor text;
  context_row catalogue_validation_context_v2%rowtype;
  baseline jsonb;
  context_hash text;
  rights_digest text;
  admission_digest text;
  maximum_evidence_bytes bigint;
begin
  actor := catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  perform catalogue_assert_validation_context_v2(p_batch_id);
  if (select count(*) from (select id from nutrient limit 4097) n)>4096 then
    raise exception 'canonical nutrient registry exceeds bounded report matrix limit' using errcode='54000';
  end if;
  select * into strict context_row from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if context_row.validator_principal <> actor or context_row.phase <> 'validated'
    or context_row.terminal_sha256 is distinct from p_validation_terminal_sha256 then
    raise exception 'reconciliation requires the original independent validator and successful pinned terminal' using errcode='42501';
  end if;
  baseline := catalogue_reconciliation_baseline_header_v2(p_batch_id);
  select rights_manifest_sha256 into strict rights_digest from food_import_batch where id=p_batch_id;
  select admission_sha256 into strict admission_digest from catalogue_preparation_v2 where batch_id=p_batch_id;
  select max_reconciliation_evidence_bytes into strict maximum_evidence_bytes
    from catalogue_preparation_admission_v2 where admission_sha256=admission_digest;
  context_hash := catalogue_frame_sha256_v2('reconciliation-context',array[p_batch_id::text,
    context_row.context_sha256,p_validation_terminal_sha256,coalesce(context_row.baseline_release_id::text,''),
    coalesce(baseline#>>'{batch,id}',''),coalesce(baseline#>>'{batch,validation_digest}',''),
    coalesce(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(baseline::text,'UTF8')),'hex'),''),
    rights_digest,admission_digest]);
  return pg_catalog.jsonb_build_object('batchId',p_batch_id::text,'databasePrincipal',actor,
    'baselineReleaseId',context_row.baseline_release_id,'validationTerminalSha256',p_validation_terminal_sha256,
    'validationPageCount',context_row.page_count::text,'validationContextSha256',context_row.context_sha256,
    'validationCommitmentSha256',context_row.validation_commitment_sha256,'contextSha256',context_hash,
    'baselineEvidence',baseline,'maximumReconciliationEvidenceBytes',maximum_evidence_bytes::text);
end;
$$;

create function catalogue_reconciliation_validation_page_v2(p_batch_id uuid,p_terminal text,p_page bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  actor text;
  context_row catalogue_validation_context_v2%rowtype;
  page_row catalogue_validation_page_v2%rowtype;
begin
  actor := catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into strict context_row from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if context_row.validator_principal <> actor or context_row.phase <> 'validated'
    or context_row.terminal_sha256 is distinct from p_terminal then
    raise exception 'retained validation evidence requires its pinned independent validator' using errcode='42501';
  end if;
  select * into strict page_row from catalogue_validation_page_v2 where batch_id=p_batch_id and page_number=p_page;
  return pg_catalog.jsonb_build_object('pageNumber',p_page::text,'requestDocument',page_row.request_document,
    'requestSha256',page_row.request_sha256,'receiptSha256',page_row.receipt_sha256,
    'contextSha256',context_row.context_sha256,'startSequence',page_row.start_sequence::text,
    'endSequence',page_row.end_sequence::text,'observationSha256',page_row.observation_sha256,
    'validationCommitmentSha256',page_row.validation_commitment_sha256,
    'semanticCommitmentSha256',page_row.semantic_commitment_sha256);
end;
$$;

create function catalogue_begin_reconciliation_v2(p_batch_id uuid,p_terminal text,p_baseline uuid,p_context text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  evidence jsonb;
  existing catalogue_reconciliation_v2%rowtype;
begin
  perform 1 from food_import_batch where id=p_batch_id for update;
  evidence := catalogue_reconciliation_input_v2(p_batch_id,p_terminal);
  if evidence->>'contextSha256' is distinct from p_context
    or (evidence->>'baselineReleaseId')::uuid is distinct from p_baseline then
    raise exception 'reconciliation context or baseline differs from explicit pins' using errcode='40001';
  end if;
  select * into existing from catalogue_reconciliation_v2 where batch_id=p_batch_id;
  if found then
    if existing.context_sha256 <> p_context or existing.validation_terminal_sha256 <> p_terminal then
      raise exception 'reconciliation replay differs from its immutable context' using errcode='55000';
    end if;
    return evidence;
  end if;
  perform catalogue_charge_preparation_budget_v2(p_batch_id,8192,0,0);
  insert into catalogue_reconciliation_v2(batch_id,context_sha256,validation_terminal_sha256,
    validator_principal,baseline_batch_id,baseline_release_id,phase,page_commitment_sha256)
  values(p_batch_id,p_context,p_terminal,evidence->>'databasePrincipal',
    (evidence#>>'{baselineEvidence,batch,id}')::uuid,p_baseline,'metadata',
    catalogue_frame_sha256_v2('reconciliation-start',array[p_batch_id::text,p_context]));
  return evidence;
end;
$$;

-- Compare every materialized component to the immutable original frozen document.
-- Source canonical JSON and the complete legacy transformation are independently
-- rechecked by the TS page consumer; SQL rechecks its existing nutrient semantics.
create function catalogue_reconciliation_baseline_record_v2(p_record_id bigint,p_release_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  record_row food_import_record%rowtype;
  batch_row food_import_batch%rowtype;
  food_row food%rowtype;
  version_row food_version%rowtype;
  food_document jsonb;
  nutrient_document jsonb;
  serving_document jsonb;
  expected_attributes jsonb;
  barcode_count bigint;
  semantics jsonb;
  semantic_document jsonb;
begin
  select * into strict record_row from food_import_record where id=p_record_id;
  select * into strict batch_row from food_import_batch where id=record_row.batch_id;
  if batch_row.release_id is distinct from p_release_id or record_row.validated_at is distinct from batch_row.validated_at
    or record_row.validation_status not in ('materialized','quarantined')
    or record_row.nutrition_semantic_contract_version is distinct from 1 then
    raise exception 'baseline record workflow or semantic pins drifted' using errcode='55000';
  end if;
  semantics := catalogue_compute_record_nutrition_semantics(record_row.id);
  semantic_document := pg_catalog.jsonb_build_object('canonicalPayloadSha256',record_row.canonical_payload_sha256,
    'nutrition',semantics,'semanticDisposition',case when record_row.validation_status='materialized' then 'valid' else 'quarantined' end,
    'sourceRecordKey',record_row.source_record_key,'validatedFoodContractVersion',record_row.validated_food_contract_version,
    'validatedFoodSha256',record_row.validated_food_sha256,'schemaVersion',1);
  if record_row.nutrition_semantic_sha256 is distinct from pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(semantic_document::text,'UTF8')),'hex') then
    raise exception 'baseline nutrition semantic commitment differs' using errcode='55000';
  end if;
  if record_row.validation_status='materialized' then
    if record_row.validated_food_contract_version is distinct from 1 or record_row.validated_food_document is null
      or record_row.validated_food_sha256 is distinct from pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(record_row.validated_food_document,'UTF8')),'hex') then
      raise exception 'baseline frozen materialization evidence differs' using errcode='55000';
    end if;
    food_document := record_row.validated_food_document::jsonb;
    if semantics->'basisIsExact100g' is distinct from 'true'::jsonb
      or food_document->>'basisQuantity' is distinct from '100'
      or food_document->'nutrients' is distinct from semantics->'nutrients' then
      raise exception 'baseline frozen nutrients differ from independent SQL semantics' using errcode='55000';
    end if;
    select * into strict version_row from food_version where id=record_row.food_version_id;
    select * into strict food_row from food where id=version_row.food_id;
    expected_attributes := (food_document->'attributes') || pg_catalog.jsonb_build_object(
      'canonicalPayloadSha256',record_row.canonical_payload_sha256,'importBatchId',batch_row.id,
      'validatedFoodContractVersion',1,'validatedFoodSha256',record_row.validated_food_sha256);
    if food_row.food_source_id <> batch_row.food_source_id or food_row.source_food_key is distinct from food_document->>'sourceFoodKey'
      or food_row.kind is distinct from food_document->>'kind' or food_row.owner_user_id is not null
      or food_row.visibility <> 'public' or food_row.current_version_id is distinct from version_row.id or food_row.archived_at is not null
      or version_row.source_release_id is distinct from p_release_id or version_row.name is distinct from food_document->>'name'
      or version_row.normalized_name is distinct from food_document->>'normalizedName'
      or version_row.brand_name is distinct from food_document->>'brandName'
      or version_row.description is distinct from food_document->>'description'
      or version_row.language_tag is distinct from food_document->>'languageTag'
      or version_row.market_code is distinct from food_document->>'marketCode'
      or version_row.basis_unit <> 'g' or version_row.basis_quantity is distinct from (food_document->>'basisQuantity')::numeric
      or version_row.source_modified_at is distinct from (food_document->>'sourceModifiedAt')::timestamptz
      or version_row.data_quality <> 'provisional' or version_row.ingredients_text is not null
      or version_row.created_by_user_id is not null or version_row.attributes is distinct from expected_attributes then
      raise exception 'baseline materialized food differs from immutable provenance' using errcode='55000';
    end if;
    if (select count(*) from food_nutrient_value where food_version_id=version_row.id)
      <> pg_catalog.jsonb_array_length(food_document->'nutrients') then
      raise exception 'baseline materialized nutrient cardinality drifted' using errcode='55000';
    end if;
    for nutrient_document in select value from pg_catalog.jsonb_array_elements(food_document->'nutrients') loop
      if not exists(select 1 from food_nutrient_value v join nutrient n on n.id=v.nutrient_id
        where v.food_version_id=version_row.id and v.nutrient_id=(nutrient_document->>'nutrientId')::bigint
          and v.amount=(nutrient_document->>'amount')::numeric and v.unit=nutrient_document->>'canonicalUnit'
          and n.code=nutrient_document->>'nutrientCode' and n.canonical_unit=v.unit
          and v.basis_quantity=version_row.basis_quantity and v.basis_unit='g' and v.confidence is null
          and v.derivation_code is not distinct from nutrient_document->>'derivationCode'
          and v.source_amount is not distinct from (nutrient_document->>'sourceAmount')::numeric
          and v.source_basis_quantity is not distinct from (nutrient_document->>'sourceBasisQuantity')::numeric
          and v.source_basis_unit is not distinct from nutrient_document->>'sourceBasisUnit'
          and v.source_unit is not distinct from nutrient_document->>'sourceUnit'
          and v.value_status=nutrient_document->>'valueStatus' and v.metadata=nutrient_document->'metadata') then
        raise exception 'baseline materialized nutrient differs from frozen meaning' using errcode='55000';
      end if;
    end loop;
    if (select count(*) from food_serving where food_version_id=version_row.id)
      <> pg_catalog.jsonb_array_length(food_document->'servings') then
      raise exception 'baseline materialized serving cardinality drifted' using errcode='55000';
    end if;
    for serving_document in select value from pg_catalog.jsonb_array_elements(food_document->'servings') loop
      if not exists(select 1 from food_serving s where s.food_version_id=version_row.id
        and s.source_serving_key=serving_document->>'sourceServingKey' and s.label=serving_document->>'label'
        and s.quantity=(serving_document->>'quantity')::numeric and s.unit=serving_document->>'unit'
        and s.unit_kind=serving_document->>'unitKind' and s.gram_weight=(serving_document->>'gramWeight')::numeric
        and s.milliliter_volume is null and s.is_default=(serving_document->>'isDefault')::boolean
        and s.display_order=(serving_document->>'displayOrder')::integer and s.metadata=serving_document->'metadata') then
        raise exception 'baseline materialized serving differs from frozen meaning' using errcode='55000';
      end if;
    end loop;
    select count(*) into barcode_count from food_barcode where food_version_id=version_row.id and valid_to is null;
    if barcode_count <> (case when food_document->>'gtin' is null then 0 else 1 end)
      or exists(select 1 from food_barcode b where b.food_version_id=version_row.id and b.valid_to is null
        and (b.gtin is distinct from food_document->>'gtin' or b.market_code is distinct from food_document->>'marketCode'
          or b.source_release_id is distinct from p_release_id)) then
      raise exception 'baseline live barcode assignment differs from frozen meaning' using errcode='55000';
    end if;
  elsif record_row.food_version_id is not null or record_row.validated_food_document is not null then
    raise exception 'quarantined baseline record has materialized food' using errcode='55000';
  end if;
  return pg_catalog.jsonb_build_object('sequenceNumber',record_row.sequence_number::text,
    'sourceRecordKey',record_row.source_record_key,'sourceRecordType',record_row.source_record_type,
    'sourcePayloadSha256',record_row.source_payload_sha256,'canonicalPayloadSha256',record_row.canonical_payload_sha256,
    'canonicalPayload',record_row.canonical_payload,'validationStatus',record_row.validation_status,
    'validationIssues',record_row.validation_issues,'validatedFoodDocument',record_row.validated_food_document,
    'validatedFoodSha256',record_row.validated_food_sha256);
end;
$$;

-- Full component and missingness detail is derived from both complete documents.
-- Mapping rows are historical immutable revisions, never a current-map substitution.
create function catalogue_reconciliation_detail_v2(p_before jsonb,p_after jsonb)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with old_nutrients as (select value from pg_catalog.jsonb_array_elements(coalesce(p_before->'nutrients','[]'::jsonb))),
  new_nutrients as (select value from pg_catalog.jsonb_array_elements(coalesce(p_after->'nutrients','[]'::jsonb))),
  nutrients as (
    select n.code,a.value old_value,b.value new_value from nutrient n
    left join old_nutrients a on a.value->>'nutrientCode'=n.code
    left join new_nutrients b on b.value->>'nutrientCode'=n.code
  ), old_servings as (select value from pg_catalog.jsonb_array_elements(coalesce(p_before->'servings','[]'::jsonb))),
  new_servings as (select value from pg_catalog.jsonb_array_elements(coalesce(p_after->'servings','[]'::jsonb))),
  servings as (
    select coalesce(a.value->>'sourceServingKey',b.value->>'sourceServingKey') key,a.value old_value,b.value new_value
    from old_servings a full join new_servings b on a.value->>'sourceServingKey'=b.value->>'sourceServingKey'
  ), mapping_ids as (
    select (value->>'mappingRevisionId')::uuid id from old_nutrients union
    select (value->>'mappingRevisionId')::uuid from new_nutrients
  )
  select pg_catalog.jsonb_build_object(
    'nutrientStates',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'nutrientCode',code,'before',old_value,'after',new_value,
      'beforeState',case when old_value is null then 'missing' when old_value->>'valueStatus'='trace' then 'trace'
        when (old_value->>'amount')::numeric=0 then 'zero' else 'positive' end,
      'afterState',case when new_value is null then 'missing' when new_value->>'valueStatus'='trace' then 'trace'
        when (new_value->>'amount')::numeric=0 then 'zero' else 'positive' end,
      'changed',old_value is distinct from new_value) order by code collate "C") from nutrients),'[]'::jsonb),
    'servings',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'sourceServingKey',key,'before',old_value,'after',new_value,'changed',old_value is distinct from new_value)
      order by key collate "C") from servings),'[]'::jsonb),
    'mappings',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object(
      'nutrientCode',n.code,'canonicalUnit',n.canonical_unit) order by r.source_nutrient_key collate "C",r.id)
      from source_nutrient_map_revision r join nutrient n on n.id=r.nutrient_id where r.id in(select id from mapping_ids)),'[]'::jsonb),
    'barcode',pg_catalog.jsonb_build_object('before',case when p_before is null then null else
      pg_catalog.jsonb_build_object('gtin',p_before->'gtin','marketCode',p_before->'marketCode') end,
      'after',case when p_after is null then null else pg_catalog.jsonb_build_object('gtin',p_after->'gtin','marketCode',p_after->'marketCode') end),
    'foodFields',pg_catalog.jsonb_build_object('before',p_before-array['nutrients','servings'],
      'after',p_after-array['nutrients','servings']))
$$;

create function catalogue_prepare_reconciliation_page_v2(p_batch_id uuid,p_context text,p_page bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  actor text;
  state catalogue_reconciliation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  baseline_batch food_import_batch%rowtype;
  validation_context catalogue_validation_context_v2%rowtype;
  parser_row food_import_parser_report%rowtype;
  source_row food_import_record%rowtype;
  candidate catalogue_validation_record_v2%rowtype;
  baseline_row catalogue_reconciliation_baseline_v2%rowtype;
  existing catalogue_reconciliation_page_v2%rowtype;
  records jsonb := '[]'::jsonb;
  item jsonb;
  before_envelope jsonb;
  after_envelope jsonb;
  food_document jsonb;
  change_kind text;
  stream_name text;
  start_sequence bigint;
  end_sequence bigint;
  next_phase text;
  following_sequence bigint;
  page_bytes bigint := 1024;
  intermediate_bytes bigint := 0;
  consumed bigint := 0;
  document text;
  document_sha text;
  commitment text;
  receipt jsonb;
  semantic_counts jsonb;
  complete boolean := false;
begin
  actor := catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  perform 1 from food_import_batch where id=p_batch_id for update;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=p_batch_id for update;
  if state.validator_principal <> actor or state.context_sha256 <> p_context then
    raise exception 'reconciliation page requires its exact validator and context' using errcode='42501';
  end if;
  select * into existing from catalogue_reconciliation_page_v2 where batch_id=p_batch_id and page_number=p_page;
  if found then return existing.receipt; end if;
  if p_page is null or p_page <> state.page_count+1 or state.phase='complete' then
    raise exception 'reconciliation page must be the next deterministic page' using errcode='55000';
  end if;
  select a.* into strict admission from catalogue_preparation_admission_v2 a
    join catalogue_preparation_v2 p on p.admission_sha256=a.admission_sha256 where p.batch_id=p_batch_id;
  select * into strict validation_context from catalogue_validation_context_v2 where batch_id=p_batch_id;
  stream_name := state.phase; start_sequence := state.next_sequence; end_sequence := start_sequence;
  next_phase := stream_name; following_sequence := start_sequence;
  if stream_name='metadata' then
    item:=pg_catalog.jsonb_build_object('inputEvidence',catalogue_reconciliation_input_v2(p_batch_id,state.validation_terminal_sha256),
      'candidateBatch',(select pg_catalog.to_jsonb(b) from food_import_batch b where b.id=p_batch_id),
      'candidateParser',(select pg_catalog.to_jsonb(p) from food_import_parser_report p where p.batch_id=p_batch_id),
      'validationPolicy',validation_context.policy,'scope','database-catalogue-only',
      'separateEvidenceRequired',pg_catalog.jsonb_build_array('high-impact-nutrient-outlier-review',
        'full-nutrient-mapping-registry-review','representative-search-relevance','zero-result-rate',
        'index-document-count','index-build-time','index-p95-latency','index-memory-footprint','index-disk-footprint'));
    if pg_catalog.octet_length(item::text)>16776000 then raise exception 'report metadata exceeds bounded page' using errcode='54000'; end if;
    records:=pg_catalog.jsonb_build_array(item); next_phase:='baseline'; following_sequence:=0;
  elsif stream_name='baseline' then
    if state.baseline_batch_id is not null then
      select * into strict baseline_batch from food_import_batch where id=state.baseline_batch_id;
      for source_row in select * from food_import_record where batch_id=state.baseline_batch_id
        and sequence_number >= start_sequence order by sequence_number limit 250 loop
        before_envelope := catalogue_reconciliation_baseline_record_v2(source_row.id,state.baseline_release_id);
        item := pg_catalog.jsonb_build_object('change','baseline','sourceRecordKey',source_row.source_record_key,
          'before',before_envelope,'after',null,'detail',catalogue_reconciliation_detail_v2(source_row.validated_food_document::jsonb,null));
        if page_bytes + pg_catalog.octet_length(item::text) > 16776000 then
          if consumed=0 then raise exception 'one baseline report record exceeds page budget' using errcode='54000'; end if;
          exit;
        end if;
        if source_row.sequence_number <> end_sequence then raise exception 'baseline sequence has a gap' using errcode='55000'; end if;
        state.baseline_records := state.baseline_records+1;
        semantic_counts:=catalogue_compute_record_nutrition_semantics(source_row.id);
        state.baseline_nutrient_count:=state.baseline_nutrient_count+(semantic_counts->>'nutrientInputCount')::bigint;
        state.baseline_portion_count:=state.baseline_portion_count+case when pg_catalog.jsonb_typeof(source_row.canonical_payload->'servings')='array'
          then pg_catalog.jsonb_array_length(source_row.canonical_payload->'servings') else 0 end;
        state.baseline_excluded_nutrients:=state.baseline_excluded_nutrients+(semantic_counts->>'excludedNutrientCount')::bigint;
        state.baseline_warning_count:=state.baseline_warning_count+(select count(*) from pg_catalog.jsonb_array_elements(source_row.validation_issues) i where i->>'severity'='warning');
        state.baseline_error_count:=state.baseline_error_count+(select count(*) from pg_catalog.jsonb_array_elements(source_row.validation_issues) i where i->>'severity'='error');
        state.baseline_payload_bytes := state.baseline_payload_bytes+pg_catalog.octet_length(source_row.canonical_payload::text);
        if state.baseline_records > admission.max_baseline_records or state.baseline_payload_bytes > admission.max_baseline_payload_bytes then
          raise exception 'baseline exceeds immutable reconciliation admission' using errcode='54000';
        end if;
        if source_row.validation_status='materialized' then
          state.baseline_valid_count:=state.baseline_valid_count+1;
          state.baseline_materializable_nutrients:=state.baseline_materializable_nutrients+(semantic_counts->>'nutrientMaterializableCount')::bigint;
          food_document := source_row.validated_food_document::jsonb;
          insert into catalogue_reconciliation_baseline_v2(batch_id,sequence_number,source_food_key,envelope)
            values(p_batch_id,source_row.sequence_number,food_document->>'sourceFoodKey',before_envelope);
          intermediate_bytes := intermediate_bytes + pg_catalog.octet_length(before_envelope::text)*2 + 8192;
        else state.baseline_quarantined_count:=state.baseline_quarantined_count+1; end if;
        records := records || pg_catalog.jsonb_build_array(item);
        page_bytes := page_bytes+pg_catalog.octet_length(item::text)+2;
        consumed := consumed+1; end_sequence := source_row.sequence_number+1;
      end loop;
    end if;
    if state.baseline_batch_id is null or end_sequence=baseline_batch.staged_count then
      if state.baseline_batch_id is not null then
        if exists(select 1 from food_import_record where batch_id=state.baseline_batch_id and sequence_number>=end_sequence) then
          raise exception 'baseline has records beyond its frozen count' using errcode='55000';
        end if;
        select * into strict parser_row from food_import_parser_report where batch_id=state.baseline_batch_id;
        if state.baseline_records<>baseline_batch.staged_count or state.baseline_records<>parser_row.emitted_record_count
          or state.baseline_valid_count<>baseline_batch.valid_count
          or state.baseline_quarantined_count+parser_row.excluded_record_count<>baseline_batch.quarantined_count
          or state.baseline_nutrient_count<>parser_row.emitted_nutrient_count
          or state.baseline_portion_count<>parser_row.emitted_portion_count
          or state.baseline_materializable_nutrients<>baseline_batch.nutrient_materializable_count
          or state.baseline_excluded_nutrients+parser_row.excluded_nutrient_count<>baseline_batch.nutrient_excluded_count
          or state.baseline_warning_count<>baseline_batch.warning_count
          or state.baseline_error_count<>(select (validation_summary->>'recordErrors')::bigint from food_source_release where id=state.baseline_release_id) then
          raise exception 'baseline complete page counts differ from frozen evidence' using errcode='55000';
        end if;
      end if;
      next_phase := 'candidate'; following_sequence := 0;
    else following_sequence := end_sequence; end if;
  elsif stream_name='candidate' then
    for candidate in select * from catalogue_validation_record_v2 where batch_id=p_batch_id
      and sequence_number >= start_sequence order by sequence_number limit 250 loop
      before_envelope := null;
      if candidate.source_food_key is not null then
        select envelope into before_envelope from catalogue_reconciliation_baseline_v2
          where batch_id=p_batch_id and source_food_key=candidate.source_food_key;
      end if;
      after_envelope := pg_catalog.jsonb_build_object('sequenceNumber',candidate.sequence_number::text,
        'sourceRecordKey',candidate.source_record_key,'sourceFoodKey',candidate.source_food_key,
        'canonicalPayloadSha256',candidate.canonical_payload_sha256,'validationStatus',candidate.validation_status,
        'validationIssuesDocument',candidate.validation_issues_document,
        'validatedFoodDocument',candidate.validated_food_document,'validatedFoodSha256',candidate.validated_food_sha256,
        'nutritionSemanticSha256',candidate.nutrition_semantic_sha256,'recordSha256',candidate.record_sha256);
      change_kind := case when candidate.validation_status='quarantined' then 'quarantined'
        when before_envelope is null then 'added'
        when ((before_envelope->>'validatedFoodDocument')::jsonb-'attributes')=(candidate.validated_food_document::jsonb-'attributes')
          and (before_envelope->>'validatedFoodDocument')::jsonb#>'{attributes,descriptionFr}'
            is not distinct from candidate.validated_food_document::jsonb#>'{attributes,descriptionFr}'
          and before_envelope->>'sourcePayloadSha256'=candidate.validated_food_document::jsonb#>>'{attributes,sourcePayloadSha256}'
          then 'unchanged' else 'changed' end;
      item := pg_catalog.jsonb_build_object('change',change_kind,'sourceRecordKey',candidate.source_record_key,
        'before',before_envelope,'after',after_envelope,'detail',catalogue_reconciliation_detail_v2(
          (before_envelope->>'validatedFoodDocument')::jsonb,candidate.validated_food_document::jsonb));
      if page_bytes + pg_catalog.octet_length(item::text) > 16776000 then
        if consumed=0 then raise exception 'one candidate report record exceeds page budget' using errcode='54000'; end if;
        exit;
      end if;
      if candidate.sequence_number <> end_sequence then raise exception 'candidate sequence has a gap' using errcode='55000'; end if;
      records := records || pg_catalog.jsonb_build_array(item);
      page_bytes := page_bytes+pg_catalog.octet_length(item::text)+2;
      consumed := consumed+1; end_sequence := candidate.sequence_number+1;
      state.candidate_records := state.candidate_records+1;
      if change_kind='quarantined' then state.quarantined_count:=state.quarantined_count+1;
      elsif change_kind='added' then state.added_count:=state.added_count+1;
      elsif change_kind='changed' then state.changed_count:=state.changed_count+1;
      else state.unchanged_count:=state.unchanged_count+1; end if;
    end loop;
    if end_sequence=validation_context.valid_count+validation_context.quarantined_count then
      next_phase := 'removed'; following_sequence := 0;
    else following_sequence := end_sequence; end if;
  else
    -- Walk the baseline index, including matched rows, so work remains bounded
    -- even when no removals exist. Empty detail pages still bind that interval.
    for baseline_row in select * from catalogue_reconciliation_baseline_v2 where batch_id=p_batch_id
      and sequence_number >= start_sequence order by sequence_number limit 250 loop
      if not exists(select 1 from catalogue_validation_record_v2 where batch_id=p_batch_id
        and source_food_key=baseline_row.source_food_key and validation_status='valid') then
        item := pg_catalog.jsonb_build_object('change','removed','sourceRecordKey',baseline_row.envelope->>'sourceRecordKey',
          'before',baseline_row.envelope,'after',null,'detail',catalogue_reconciliation_detail_v2(
            (baseline_row.envelope->>'validatedFoodDocument')::jsonb,null));
        if page_bytes + pg_catalog.octet_length(item::text) > 16776000 then
          if consumed=0 then raise exception 'one removed report record exceeds page budget' using errcode='54000'; end if;
          exit;
        end if;
        records := records || pg_catalog.jsonb_build_array(item);
        page_bytes := page_bytes+pg_catalog.octet_length(item::text)+2;
        state.removed_count := state.removed_count+1;
      end if;
      consumed := consumed+1; end_sequence := baseline_row.sequence_number+1;
    end loop;
    if not exists(select 1 from catalogue_reconciliation_baseline_v2 where batch_id=p_batch_id and sequence_number >= end_sequence) then
      next_phase := 'complete'; complete := true;
    end if;
    following_sequence := end_sequence;
  end if;
  if consumed=0 and next_phase=stream_name then raise exception 'reconciliation cannot make bounded progress' using errcode='55000'; end if;
  document := pg_catalog.jsonb_build_object('schemaVersion',3,'reportType','nutrition-tracker.catalogue-reconciliation',
    'batchId',p_batch_id::text,'contextSha256',p_context,'pageNumber',p_page::text,'stream',stream_name,'records',records)::text;
  document_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(document,'UTF8')),'hex');
  commitment := catalogue_frame_sha256_v2('reconciliation-page',array[p_context,p_page::text,stream_name,
    start_sequence::text,end_sequence::text,document_sha,state.page_commitment_sha256,complete::text]);
  receipt := pg_catalog.jsonb_build_object('batchId',p_batch_id::text,'contextSha256',p_context,'pageNumber',p_page::text,
    'stream',stream_name,'startSequence',start_sequence::text,'endSequence',end_sequence::text,'document',document,
    'documentSha256',document_sha,'previousCommitmentSha256',state.page_commitment_sha256,
    'commitmentSha256',commitment,'complete',complete);
  perform catalogue_charge_preparation_budget_v2(p_batch_id,
    intermediate_bytes+pg_catalog.octet_length(document)*4+16384,0,
    pg_catalog.octet_length(document)+pg_catalog.octet_length(receipt::text));
  insert into catalogue_reconciliation_page_v2(batch_id,page_number,document,receipt) values(p_batch_id,p_page,document,receipt);
  update catalogue_reconciliation_v2 set phase=next_phase,next_sequence=following_sequence,page_count=p_page,
    page_commitment_sha256=commitment,baseline_records=state.baseline_records,baseline_payload_bytes=state.baseline_payload_bytes,
    candidate_records=state.candidate_records,added_count=state.added_count,changed_count=state.changed_count,
    unchanged_count=state.unchanged_count,removed_count=state.removed_count,quarantined_count=state.quarantined_count,
    baseline_valid_count=state.baseline_valid_count,baseline_quarantined_count=state.baseline_quarantined_count,
    baseline_nutrient_count=state.baseline_nutrient_count,baseline_portion_count=state.baseline_portion_count,
    baseline_materializable_nutrients=state.baseline_materializable_nutrients,baseline_excluded_nutrients=state.baseline_excluded_nutrients,
    baseline_warning_count=state.baseline_warning_count,baseline_error_count=state.baseline_error_count where batch_id=p_batch_id;
  return receipt;
end;
$$;

create function catalogue_finish_reconciliation_v2(p_batch_id uuid,p_context text,p_pages bigint,p_commitment text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare actor text; state catalogue_reconciliation_v2%rowtype; terminal text; receipt jsonb;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_validate');
  perform 1 from food_import_batch where id=p_batch_id for update;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=p_batch_id for update;
  if state.validator_principal<>actor or state.context_sha256<>p_context or state.phase<>'complete'
    or state.page_count<>p_pages or state.page_commitment_sha256<>p_commitment then
    raise exception 'reconciliation terminal requires all exact authenticated pages' using errcode='55000';
  end if;
  if state.terminal_sha256 is not null then return state.terminal_receipt; end if;
  terminal:=catalogue_frame_sha256_v2('reconciliation-terminal',array[p_batch_id::text,p_context,
    state.validation_terminal_sha256,p_pages::text,p_commitment,state.baseline_records::text,
    state.candidate_records::text,state.added_count::text,state.changed_count::text,state.unchanged_count::text,
    state.removed_count::text,state.quarantined_count::text]);
  receipt:=pg_catalog.jsonb_build_object('schemaVersion',3,'reportType','nutrition-tracker.catalogue-reconciliation',
    'batchId',p_batch_id::text,'contextSha256',p_context,'validationTerminalSha256',state.validation_terminal_sha256,
    'reportSha256',terminal,'pageCount',p_pages::text,'pageCommitmentSha256',p_commitment,'promotionAvailable',false,
    'counts',pg_catalog.jsonb_build_object('baselineRecords',state.baseline_records::text,'candidateRecords',state.candidate_records::text,
      'added',state.added_count::text,'changed',state.changed_count::text,'unchanged',state.unchanged_count::text,
      'removed',state.removed_count::text,'quarantined',state.quarantined_count::text));
  perform catalogue_charge_preparation_budget_v2(p_batch_id,8192,0,pg_catalog.octet_length(receipt::text));
  update catalogue_reconciliation_v2 set terminal_sha256=terminal,terminal_receipt=receipt where batch_id=p_batch_id;
  return receipt;
end;
$$;

create function catalogue_read_reconciliation_page_v2(p_batch_id uuid,p_report text,p_page bigint,p_role text,p_principal text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare actor text; state catalogue_reconciliation_v2%rowtype; result jsonb;
begin
  if p_role is null or p_role not in ('data','quality','rights') then raise exception 'unsupported reviewer role' using errcode='22023'; end if;
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_'||p_role);
  if actor is distinct from p_principal then raise exception 'reviewer identity mismatch' using errcode='42501'; end if;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=p_batch_id;
  if state.terminal_sha256 is distinct from p_report or state.phase<>'complete' then
    raise exception 'reviewer requires exact completed report commitment' using errcode='55000'; end if;
  select receipt into strict result from catalogue_reconciliation_page_v2 where batch_id=p_batch_id and page_number=p_page;
  return result;
end;
$$;

create function catalogue_record_paged_approval_v2(p_batch_id uuid,p_role text,p_principal text,p_rights text,
  p_validation_terminal text,p_report text,p_context text,p_reference text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare actor text; state catalogue_reconciliation_v2%rowtype; existing catalogue_paged_approval_v2%rowtype;
  batch_row food_import_batch%rowtype; replay boolean:=false;
begin
  if p_role is null or p_role not in ('data','quality','rights') or p_reference is null or pg_catalog.btrim(p_reference)<>p_reference
    or pg_catalog.octet_length(p_reference) not between 1 and 2048 or p_reference ~ '[[:cntrl:]]' then
    raise exception 'paged approval requires explicit role and bounded reference' using errcode='22023'; end if;
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_'||p_role);
  if actor is distinct from p_principal then raise exception 'reviewer identity mismatch' using errcode='42501'; end if;
  select * into strict batch_row from food_import_batch where id=p_batch_id for update;
  perform catalogue_assert_validation_context_v2(p_batch_id);
  select * into strict state from catalogue_reconciliation_v2 where batch_id=p_batch_id;
  if state.phase<>'complete' or state.terminal_sha256 is distinct from p_report
    or state.validation_terminal_sha256 is distinct from p_validation_terminal or state.context_sha256 is distinct from p_context
    or batch_row.rights_manifest_sha256 is distinct from p_rights or actor=state.validator_principal
    or actor=(select stage_principal from catalogue_preparation_admission_v2 a join catalogue_preparation_v2 p
      on p.admission_sha256=a.admission_sha256 where p.batch_id=p_batch_id)
    or (batch_row.evidence_valid_until is not null and batch_row.evidence_valid_until<=pg_catalog.clock_timestamp()) then
    raise exception 'reviewer decision differs from authenticated terminal, rights or independent identity' using errcode='55000'; end if;
  select * into existing from catalogue_paged_approval_v2 where batch_id=p_batch_id and approval_role=p_role;
  if found then
    if row(existing.database_principal,existing.rights_manifest_sha256,existing.validation_terminal_sha256,
      existing.report_sha256,existing.context_sha256,existing.approval_reference)
      is distinct from row(actor,p_rights,p_validation_terminal,p_report,p_context,p_reference) then
      raise exception 'paged approval replay differs from immutable evidence' using errcode='55000'; end if;
    replay:=true;
  else
    perform catalogue_charge_preparation_budget_v2(p_batch_id,8192,0,pg_catalog.octet_length(p_reference)+1024);
    insert into catalogue_paged_approval_v2(batch_id,approval_role,database_principal,rights_manifest_sha256,
      validation_terminal_sha256,context_sha256,report_sha256,approval_reference)
      values(p_batch_id,p_role,actor,p_rights,p_validation_terminal,p_context,p_report,p_reference);
  end if;
  return pg_catalog.jsonb_build_object('approvalRole',p_role,'databasePrincipal',actor,'reportSha256',p_report,
    'wasAlreadyApproved',replay,'promotionAvailable',false);
end;
$$;

-- Strip inherited/default ACLs, prove owner identity, and pin the actual migration
-- schema. Test schemas receive the same ordered safe path as public deployments.
do $authority$
declare target_schema text:=current_schema(); table_owner oid; item record; grantee record;
begin
  select c.relowner into strict table_owner from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=target_schema and c.relname='food_import_batch';
  for item in select c.oid,c.relowner,c.relacl from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=target_schema and c.relname=any(array['catalogue_reconciliation_v2','catalogue_reconciliation_baseline_v2',
      'catalogue_reconciliation_page_v2','catalogue_paged_approval_v2']) loop
    if item.relowner<>table_owner then raise exception 'reconciliation table owner mismatch' using errcode='42501'; end if;
    execute format('revoke all on table %s from public',item.oid::regclass);
    for grantee in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.relacl,acldefault('r',item.relowner))) a
      join pg_roles r on r.oid=a.grantee where a.grantee<>item.relowner loop
      execute format('revoke all on table %s from %I',item.oid::regclass,grantee.rolname);
    end loop;
  end loop;
  for item in select p.oid,p.proowner,p.proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=target_schema and p.proname=any(array['guard_catalogue_reconciliation_state_v2',
      'guard_catalogue_reconciliation_evidence_v2','guard_catalogue_paged_approval_v2','catalogue_reconciliation_baseline_header_v2',
      'catalogue_reconciliation_input_v2','catalogue_reconciliation_validation_page_v2','catalogue_begin_reconciliation_v2',
      'catalogue_reconciliation_baseline_record_v2','catalogue_reconciliation_detail_v2','catalogue_prepare_reconciliation_page_v2',
      'catalogue_finish_reconciliation_v2','catalogue_read_reconciliation_page_v2','catalogue_record_paged_approval_v2']) loop
    if item.proowner<>table_owner then raise exception 'reconciliation function owner mismatch' using errcode='42501'; end if;
    execute format('alter function %s set search_path to pg_catalog,%I,pg_temp',item.oid::regprocedure,target_schema);
    execute format('revoke all on function %s from public',item.oid::regprocedure);
    for grantee in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.proacl,acldefault('f',item.proowner))) a
      join pg_roles r on r.oid=a.grantee where a.grantee<>item.proowner loop
      execute format('revoke all on function %s from %I',item.oid::regprocedure,grantee.rolname);
    end loop;
  end loop;
end;
$authority$;

revoke all on catalogue_reconciliation_v2,catalogue_reconciliation_baseline_v2,catalogue_reconciliation_page_v2,catalogue_paged_approval_v2 from public;
revoke all on function catalogue_reconciliation_baseline_header_v2(uuid),catalogue_reconciliation_input_v2(uuid,text),
 catalogue_reconciliation_validation_page_v2(uuid,text,bigint),catalogue_begin_reconciliation_v2(uuid,text,uuid,text),
 catalogue_reconciliation_baseline_record_v2(bigint,uuid),catalogue_reconciliation_detail_v2(jsonb,jsonb),catalogue_prepare_reconciliation_page_v2(uuid,text,bigint),
 catalogue_finish_reconciliation_v2(uuid,text,bigint,text),catalogue_read_reconciliation_page_v2(uuid,text,bigint,text,text),
 catalogue_record_paged_approval_v2(uuid,text,text,text,text,text,text,text) from public;
grant execute on function catalogue_reconciliation_input_v2(uuid,text),catalogue_reconciliation_validation_page_v2(uuid,text,bigint),
 catalogue_begin_reconciliation_v2(uuid,text,uuid,text),catalogue_prepare_reconciliation_page_v2(uuid,text,bigint),
 catalogue_finish_reconciliation_v2(uuid,text,bigint,text) to nutrition_catalogue_validate;
grant execute on function catalogue_read_reconciliation_page_v2(uuid,text,bigint,text,text),
 catalogue_record_paged_approval_v2(uuid,text,text,text,text,text,text,text)
 to nutrition_catalogue_approve_data,nutrition_catalogue_approve_quality,nutrition_catalogue_approve_rights;
