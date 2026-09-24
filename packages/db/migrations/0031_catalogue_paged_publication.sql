-- Bounded invisible preparation; admitted O(N) atomic publication.
-- Never rewrite V2 preparation or legacy classification evidence.
select pg_advisory_xact_lock(hashtext('catalogue-publication-v2'));
do $migration$
declare schema_name text:=pg_catalog.current_schema();
begin
  if current_user::text is distinct from (select pg_get_userbyid(relowner) from pg_class
      where oid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,'food_import_batch')))
    or pg_catalog.to_regclass(pg_catalog.format('%I.%I',schema_name,'catalogue_publication_v2')) is not null
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=schema_name and p.proname like 'catalogue_%publication%_v2') then
    raise exception 'publication owner or empty namespace preflight failed' using errcode='55000';
  end if;
end;
$migration$;
create table catalogue_publication_admission_v2 (
  batch_id uuid constraint cat_pub_admit_v2_batch_id_pk primary key constraint cat_pub_admit_v2_batch_id_fk references catalogue_preparation_v2(batch_id),
  admission_sha256 text not null constraint cat_pub_admit_v2_admission_sha256_uq unique constraint cat_pub_admit_v2_admission_sha256_check check(admission_sha256 ~ '^[0-9a-f]{64}$'),
  request_document text not null constraint cat_pub_admit_v2_request_document_check check(octet_length(request_document) between 1 and 65536),request_sha256 text not null,
  publisher_principal text not null,admitted_by text not null,
  context_sha256 text not null,validation_terminal_sha256 text not null,report_sha256 text not null,
  max_records bigint not null constraint cat_pub_admit_v2_max_records_check check(max_records>0),max_materialization_bytes bigint not null constraint cat_pub_admit_v2_max_materialization_bytes_check check(max_materialization_bytes>0),
  max_intermediate_bytes bigint not null constraint cat_pub_admit_v2_max_intermediate_bytes_check check(max_intermediate_bytes>0),max_evidence_bytes bigint not null constraint cat_pub_admit_v2_max_evidence_bytes_check check(max_evidence_bytes>0),
  max_cutover_food_rows bigint not null constraint cat_pub_admit_v2_max_cutover_food_rows_check check(max_cutover_food_rows>0),max_cutover_barcode_rows bigint not null constraint cat_pub_admit_v2_max_cutover_barcode_rows_check check(max_cutover_barcode_rows>0),
  max_cutover_bytes bigint not null constraint cat_pub_admit_v2_max_cutover_bytes_check check(max_cutover_bytes>0),receipt jsonb not null,created_at timestamptz not null default clock_timestamp(),
  constraint cat_pub_admit_v2_check_1 check(publisher_principal<>admitted_by));
create table catalogue_publication_v2 (
  batch_id uuid constraint cat_pub_v2_batch_id_pk primary key constraint cat_pub_v2_batch_id_fk references catalogue_publication_admission_v2(batch_id),
  release_id uuid not null constraint cat_pub_v2_release_id_uq unique constraint cat_pub_v2_release_id_fk references food_source_release(id),publication_sha256 text not null constraint cat_pub_v2_publication_sha256_uq unique,
  publisher_principal text not null,admission_sha256 text not null constraint cat_pub_v2_admission_sha256_fk references catalogue_publication_admission_v2(admission_sha256),
  context_sha256 text not null,validation_terminal_sha256 text not null,report_sha256 text not null,
  baseline_release_id uuid constraint cat_pub_v2_baseline_release_id_fk references food_source_release(id),
  mapping_document jsonb not null constraint cat_pub_v2_mapping_document_check check(jsonb_typeof(mapping_document)='array' and jsonb_array_length(mapping_document)<=10000 and octet_length(mapping_document::text)<=4194304),
  mapping_sha256 text not null,initial_generation bigint not null constraint cat_pub_v2_initial_generation_check check(initial_generation>=0),last_generation bigint not null constraint cat_pub_v2_last_generation_check check(last_generation>=initial_generation),
  phase text not null constraint cat_pub_v2_phase_check check(phase in ('materializing','verifying','sealed','activated')),
  next_sequence bigint not null default 0 constraint cat_pub_v2_next_sequence_check check(next_sequence>=0),page_count bigint not null default 0 constraint cat_pub_v2_page_count_check check(page_count>=0),
  materialized_count bigint not null default 0 constraint cat_pub_v2_materialized_count_check check(materialized_count>=0),materialization_bytes bigint not null default 0 constraint cat_pub_v2_materialization_bytes_check check(materialization_bytes>=0),
  intermediate_bytes bigint not null default 0 constraint cat_pub_v2_intermediate_bytes_check check(intermediate_bytes>=0),evidence_bytes bigint not null default 0 constraint cat_pub_v2_evidence_bytes_check check(evidence_bytes>=0),
  verified_sequence bigint not null default 0 constraint cat_pub_v2_verified_sequence_check check(verified_sequence>=0),verified_page_count bigint not null default 0 constraint cat_pub_v2_verified_page_count_check check(verified_page_count>=0),
  verified_materialized_count bigint not null default 0 constraint cat_pub_v2_verified_materialized_count_check check(verified_materialized_count>=0),
  record_commitment_sha256 text not null,verification_commitment_sha256 text not null,last_receipt_sha256 text not null,seal_sha256 text,
  begin_request_document text not null,begin_receipt jsonb not null,finish_request_document text,finish_receipt jsonb,
  activation_request_document text,activation_receipt jsonb,created_at timestamptz not null default clock_timestamp(),activated_at timestamptz,
  constraint cat_pub_v2_check_1 check((seal_sha256 is not null)=(phase in ('sealed','activated'))),constraint cat_pub_v2_check_2 check((activated_at is not null)=(phase='activated')),
  constraint cat_pub_v2_check_3 check((activation_receipt is not null)=(phase='activated')),constraint cat_pub_v2_check_4 check((finish_receipt is not null)=(phase in ('sealed','activated'))));
create table catalogue_publication_record_v2 (
  batch_id uuid not null constraint cat_pub_record_v2_batch_id_fk references catalogue_publication_v2(batch_id),sequence_number bigint not null,
  import_record_id bigint not null constraint cat_pub_record_v2_import_record_id_uq unique constraint cat_pub_record_v2_import_record_id_fk references food_import_record(id),food_id bigint constraint cat_pub_record_v2_food_id_fk references food(id),
  food_version_id bigint constraint cat_pub_record_v2_food_version_id_uq unique constraint cat_pub_record_v2_food_version_id_fk references food_version(id),validated_food_sha256 text,materialization_sha256 text not null,
  materialization_bytes bigint not null constraint cat_pub_record_v2_materialization_bytes_check check(materialization_bytes>0),constraint cat_pub_record_v2_pk_1 primary key(batch_id,sequence_number),
  constraint cat_pub_record_v2_fk_2 foreign key(batch_id,sequence_number) references catalogue_validation_record_v2(batch_id,sequence_number),
  constraint cat_pub_record_v2_check_3 check((food_id is null)=(food_version_id is null) and (food_id is null)=(validated_food_sha256 is null)));
create table catalogue_publication_page_v2 (
  batch_id uuid not null constraint cat_pub_page_v2_batch_id_fk references catalogue_publication_v2(batch_id),phase text not null constraint cat_pub_page_v2_phase_check check(phase in ('materialize','verify')),
  page_number bigint not null constraint cat_pub_page_v2_page_number_check check(page_number>=0),first_sequence bigint not null constraint cat_pub_page_v2_first_sequence_check check(first_sequence>=0),next_sequence bigint not null,
  request_document text not null constraint cat_pub_page_v2_request_document_check check(octet_length(request_document) between 1 and 65536),request_sha256 text not null,
  record_commitment_sha256 text not null,receipt_sha256 text not null,receipt jsonb not null,
  constraint cat_pub_page_v2_pk_1 primary key(batch_id,phase,page_number),constraint cat_pub_page_v2_uq_2 unique(batch_id,phase,first_sequence),constraint cat_pub_page_v2_check_3 check(next_sequence>first_sequence and next_sequence-first_sequence<=250));
create table catalogue_publication_rollback_v2 (
  request_id uuid constraint cat_pub_rollback_v2_request_id_pk primary key,source_id bigint not null constraint cat_pub_rollback_v2_source_id_fk references food_source(id),target_release_id uuid constraint cat_pub_rollback_v2_target_release_id_fk references food_source_release(id),
  previous_release_id uuid constraint cat_pub_rollback_v2_previous_release_id_fk references food_source_release(id),actor text not null,request_document text not null constraint cat_pub_rollback_v2_request_document_check check(octet_length(request_document) between 1 and 65536),
  request_sha256 text not null,receipt jsonb not null,activation_id bigint not null constraint cat_pub_rollback_v2_activation_id_uq unique constraint cat_pub_rollback_v2_activation_id_fk references food_source_release_activation(id),created_at timestamptz not null default clock_timestamp()
);
create function catalogue_publication_request_v2(p_document text,p_keys text[])
returns jsonb language plpgsql immutable as $$
declare d jsonb;
begin
  if p_document is null or octet_length(p_document) not between 1 and 65536 then raise exception 'publication request text bound' using errcode='22023'; end if;
  d:=p_document::jsonb;
  if jsonb_typeof(d)<>'object' or d->'schemaVersion' is distinct from '2'::jsonb or not d ?& p_keys or d-p_keys<>'{}'::jsonb
    or (select count(*) from json_each(p_document::json))<>(select count(*) from jsonb_object_keys(d)) then
    raise exception 'publication request keys or version differ' using errcode='22023'; end if;
  return d;
end;
$$;
create function catalogue_publication_receipt_v2(p_core jsonb)
returns jsonb language sql immutable strict as $$
  select p_core||jsonb_build_object('receiptDocument',p_core::text,'receiptSha256',encode(sha256(convert_to(p_core::text,'UTF8')),'hex'));
$$;
create function catalogue_publication_timeouts_v2()
returns void language plpgsql stable as $$
begin
  if not exists(select 1 from pg_settings where name='lock_timeout' and setting::bigint between 1 and 2000)
    or not exists(select 1 from pg_settings where name='statement_timeout' and setting::bigint between 1 and 30000) then
    raise exception 'publication requires lock timeout <=2s and statement timeout <=30s' using errcode='55000'; end if;
end;
$$;
create function catalogue_publication_progress_v2(p_batch_id uuid)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object('schemaVersion',2,'batchId',p.batch_id::text,'sourceCode',s.code,
    'publicationSha256',p.publication_sha256,'admissionSha256',p.admission_sha256,'releaseId',p.release_id::text,
    'contextSha256',p.context_sha256,'validationTerminalSha256',p.validation_terminal_sha256,'reportSha256',p.report_sha256,
    'baselineReleaseId',p.baseline_release_id::text,'phase',p.phase,'nextSequence',p.next_sequence::text,'pageCount',p.page_count::text,
    'materializedCount',p.materialized_count::text,'verifiedSequence',p.verified_sequence::text,'verifiedPageCount',p.verified_page_count::text,
    'generation',p.last_generation::text,'sealSha256',p.seal_sha256)
  from catalogue_publication_v2 p join food_import_batch b on b.id=p.batch_id join food_source s on s.id=b.food_source_id where p.batch_id=p_batch_id;
$$;
create function catalogue_lock_publication_v2(p_batch_id uuid,p_actor text,p_require_live boolean default true)
returns void language plpgsql security definer as $$
declare b food_import_batch%rowtype;s food_source%rowtype;p catalogue_publication_v2%rowtype;epoch bigint;
begin
  perform catalogue_publication_timeouts_v2();
  select * into strict b from food_import_batch where id=p_batch_id for update;
  select * into strict s from food_source where id=b.food_source_id for update;
  perform pg_advisory_xact_lock(hashtext('nutrition-tracker:catalogue-source:v1'),hashtext(s.id::text));
  perform lock_active_nutrient_registry_for_read();
  select * into p from catalogue_publication_v2 where batch_id=p_batch_id for update;
  select generation into strict epoch from catalogue_validation_generation_v2 where singleton for update;
  if p.batch_id is not null and p.publisher_principal is distinct from p_actor then raise exception 'publication publisher differs' using errcode='42501'; end if;
  if p_require_live then
    if b.release_class<>'live-reviewed' or b.evidence_bundle_sha256 is null or b.evidence_bundle_uri is null
      or b.evidence_decision_sha256 is null or b.evidence_object_version_id is null or b.evidence_valid_until is null
      or b.evidence_valid_until<=clock_timestamp() or not s.active or s.commercial_use_allowed is distinct from true
      or s.redistribution_allowed is distinct from true or s.rights_review_status not in ('approved','restricted')
      or s.rights_reviewed_at is null or s.rights_reviewed_by is null then
      raise exception 'publication requires current bound live-reviewed source evidence' using errcode='55000'; end if;
    if p.batch_id is null then perform catalogue_assert_validation_context_v2(p_batch_id);
    elsif p.last_generation is distinct from epoch or s.active_release_id is distinct from p.baseline_release_id then
      raise exception 'publication generation or baseline changed; lineage cannot restart' using errcode='40001'; end if;
  end if;
end;
$$;
create function catalogue_assert_publication_approvals_v2(p_batch_id uuid,p_context text,p_terminal text,p_report text,p_actor text)
returns void language plpgsql security definer as $$
declare b food_import_batch%rowtype;c catalogue_validation_context_v2%rowtype;r catalogue_reconciliation_v2%rowtype;
begin
  select * into strict b from food_import_batch where id=p_batch_id;
  select * into strict c from catalogue_validation_context_v2 where batch_id=p_batch_id;
  select * into strict r from catalogue_reconciliation_v2 where batch_id=p_batch_id;
  if c.phase<>'validated' or c.terminal_sha256 is distinct from p_terminal
    or r.phase<>'complete' or r.terminal_sha256 is distinct from p_report or r.context_sha256 is distinct from p_context
    or r.validation_terminal_sha256 is distinct from p_terminal or c.validator_principal=p_actor or b.staged_database_principal=p_actor
    or (select count(*) from catalogue_paged_approval_v2 where batch_id=p_batch_id)<>3
    or (select count(distinct database_principal) from catalogue_paged_approval_v2 where batch_id=p_batch_id)<>3
    or exists(select 1 from catalogue_paged_approval_v2 a where a.batch_id=p_batch_id and
      (a.context_sha256 is distinct from p_context or a.validation_terminal_sha256 is distinct from p_terminal
      or a.report_sha256 is distinct from p_report or a.rights_manifest_sha256 is distinct from b.rights_manifest_sha256
      or a.database_principal=p_actor or a.database_principal=c.validator_principal or a.database_principal=b.staged_database_principal)) then
    raise exception 'publication requires exact terminal and three independent reviewer decisions' using errcode='55000'; end if;
end;
$$;

create function catalogue_admit_publication_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;l jsonb;actor text;batch uuid;digest text;admission text;result jsonb;
  prior catalogue_publication_admission_v2%rowtype;c catalogue_validation_context_v2%rowtype;s food_source%rowtype;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_quality');
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','batchId','contextSha256','validationTerminalSha256','reportSha256','publisherPrincipal','limits']);
  batch:=(d->>'batchId')::uuid;l:=d->'limits';digest:=encode(sha256(convert_to(p_document,'UTF8')),'hex');
  if jsonb_typeof(l) is distinct from 'object' or not l ?& array['maxRecords','maxMaterializationBytes','maxIntermediateBytes','maxEvidenceBytes','maxCutoverFoodRows','maxCutoverBarcodeRows','maxCutoverBytes']
    or (select count(*) from jsonb_object_keys(l))<>7 or (select count(*) from json_each(p_document::json->'limits'))<>7
    or (d->>'publisherPrincipal') !~ '^[a-z][-a-z0-9._:@/]{2,62}$' or d->>'publisherPrincipal'=actor then
    raise exception 'publication admission limits or publisher differ' using errcode='22023'; end if;
  perform catalogue_preparation_uint_v2(value) from jsonb_each(l);
  if exists(select 1 from jsonb_each(l) where catalogue_preparation_uint_v2(value)=0) then raise exception 'publication budgets must be positive' using errcode='22023'; end if;
  select * into strict s from food_source where id=(select food_source_id from food_import_batch where id=batch);
  select * into prior from catalogue_publication_admission_v2 where batch_id=batch;
  if found then
    if prior.admitted_by<>actor or prior.request_document<>p_document then raise exception 'publication admission replay differs' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  perform catalogue_lock_publication_v2(batch,d->>'publisherPrincipal');
  select * into prior from catalogue_publication_admission_v2 where batch_id=batch;
  if found then
    if prior.admitted_by<>actor or prior.request_document<>p_document then raise exception 'publication admission replay differs' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  perform catalogue_assert_publication_approvals_v2(batch,d->>'contextSha256',d->>'validationTerminalSha256',d->>'reportSha256',d->>'publisherPrincipal');
  if not exists(select 1 from catalogue_paged_approval_v2 where batch_id=batch and approval_role='quality' and database_principal=actor) then
    raise exception 'publication budget requires exact quality reviewer' using errcode='42501'; end if;
  select * into strict c from catalogue_validation_context_v2 where batch_id=batch;
  if c.next_sequence>catalogue_preparation_uint_v2(l->'maxRecords') then raise exception 'publication record admission too small' using errcode='54000'; end if;
  admission:=catalogue_frame_sha256_v2('publication-admission',array[batch::text,actor,digest]);
  result:=catalogue_publication_receipt_v2(jsonb_build_object('schemaVersion',2,'operation','admit','batchId',batch::text,
    'sourceCode',s.code,'requestSha256',digest,'admissionSha256',admission,'publisherPrincipal',d->>'publisherPrincipal','limits',l));
  insert into catalogue_publication_admission_v2 values(batch,admission,p_document,digest,d->>'publisherPrincipal',actor,
    d->>'contextSha256',d->>'validationTerminalSha256',d->>'reportSha256',
    catalogue_preparation_uint_v2(l->'maxRecords'),catalogue_preparation_uint_v2(l->'maxMaterializationBytes'),
    catalogue_preparation_uint_v2(l->'maxIntermediateBytes'),catalogue_preparation_uint_v2(l->'maxEvidenceBytes'),
    catalogue_preparation_uint_v2(l->'maxCutoverFoodRows'),catalogue_preparation_uint_v2(l->'maxCutoverBarcodeRows'),
    catalogue_preparation_uint_v2(l->'maxCutoverBytes'),result,clock_timestamp());
  return result;
end;
$$;
create function catalogue_begin_publication_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;actor text;batch uuid;digest text;pubhash text;epoch bigint;after_epoch bigint;result jsonb;mapping_doc jsonb;mapping_digest text;
  a catalogue_publication_admission_v2%rowtype;p catalogue_publication_v2%rowtype;b food_import_batch%rowtype;
  c catalogue_validation_context_v2%rowtype;parser food_import_parser_report%rowtype;release_uuid uuid;summary jsonb;counts jsonb;charge bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','batchId','admissionSha256']);batch:=(d->>'batchId')::uuid;
  digest:=encode(sha256(convert_to(p_document,'UTF8')),'hex');
  select * into p from catalogue_publication_v2 where batch_id=batch;
  if found then
    if p.publisher_principal<>actor or p.begin_request_document<>p_document then raise exception 'publication begin replay differs' using errcode='55000'; end if;
    return p.begin_receipt;
  end if;
  perform catalogue_lock_publication_v2(batch,actor);
  select * into p from catalogue_publication_v2 where batch_id=batch;
  if found then
    if p.publisher_principal<>actor or p.begin_request_document<>p_document then raise exception 'publication begin replay differs' using errcode='55000'; end if;
    return p.begin_receipt;
  end if;
  select * into strict a from catalogue_publication_admission_v2 where batch_id=batch;
  if a.publisher_principal<>actor or a.admission_sha256 is distinct from d->>'admissionSha256' then raise exception 'publication admission identity differs' using errcode='42501'; end if;
  perform catalogue_assert_publication_approvals_v2(batch,a.context_sha256,a.validation_terminal_sha256,a.report_sha256,actor);
  select * into strict b from food_import_batch where id=batch;
  select * into strict c from catalogue_validation_context_v2 where batch_id=batch;
  if c.valid_count<=0 or c.next_sequence<=0 then
    raise exception 'publication requires at least one validated food' using errcode='55000'; end if;
  select * into strict parser from food_import_parser_report where batch_id=batch;
  select generation into strict epoch from catalogue_validation_generation_v2 where singleton;
  mapping_digest:=catalogue_mapping_digest_for_validation_v2(b.food_source_id);
  if mapping_digest is distinct from substring(b.parser_version,'[+]mapping[.]([0-9a-f]{64})$') then raise exception 'publication mappings differ from frozen parser' using errcode='55000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('canonicalUnit',n.canonical_unit,
    'conversionMultiplier',catalogue_canonical_decimal_product(r.conversion_multiplier::text,'1'),
    'nutrientCode',n.code,'nutrientDimension',n.dimension,'nutrientId',n.id::text,'nutrientName',n.name,
    'revisionId',r.id::text,'sourceNutrientKey',m.source_nutrient_key,'sourceUnit',r.source_unit)
    order by catalogue_utf16_sort_key_v2(m.source_nutrient_key) collate "C"),'[]'::jsonb) into mapping_doc
    from source_nutrient_map m join source_nutrient_map_revision r on r.id=m.current_revision_id
    join nutrient n on n.id=r.nutrient_id where m.food_source_id=b.food_source_id;
  pubhash:=catalogue_frame_sha256_v2('publication-context',array[batch::text,a.admission_sha256,a.context_sha256,
    a.validation_terminal_sha256,a.report_sha256,actor,coalesce(c.baseline_release_id::text,''),epoch::text,mapping_digest]);
  summary:=jsonb_build_object('publicationProtocolVersion',2,'batchId',batch::text,'publicationSha256',pubhash,
    'contextSha256',a.context_sha256,'validationTerminalSha256',a.validation_terminal_sha256,'reportSha256',a.report_sha256,
    'nutrientMappingDigest',mapping_digest,'nutrientMappingRevisionIds',(select coalesce(jsonb_agg(v->>'revisionId' order by (v->>'revisionId') collate "C"),'[]'::jsonb) from jsonb_array_elements(mapping_doc) v),
    'parserReportSha256',parser.report_sha256,'validatedFoodContractVersion',1);
  counts:=jsonb_build_object('staged',c.next_sequence::text,'materializable',c.valid_count::text,'quarantined',c.quarantined_count::text,
    'nutrientInput',c.nutrient_input_count::text,'nutrientMaterializable',c.nutrient_materializable_count::text,'nutrientExcluded',c.excluded_nutrient_count::text,
    'sourceRecords',parser.source_record_count::text,'sourcePortions',parser.source_portion_count::text,'parserExcludedRecords',parser.excluded_record_count::text);
  charge:=octet_length(mapping_doc::text)::bigint*3+octet_length(p_document)::bigint*3+65536;
  if charge>a.max_intermediate_bytes or charge>a.max_evidence_bytes then raise exception 'publication begin exceeds immutable admission' using errcode='54000'; end if;
  insert into food_source_release(food_source_id,release_key,published_on,acquired_at,artifact_uri,artifact_sha256,artifact_bytes,
    media_type,upstream_schema_version,parser_version,status,record_counts,validation_summary,rights_manifest_uri,rights_manifest_sha256,
    release_class,evidence_bundle_sha256,evidence_bundle_uri,evidence_decision_sha256,evidence_object_version_id,evidence_valid_until)
  values(b.food_source_id,b.release_key,b.published_on,b.acquired_at,b.artifact_uri,b.artifact_sha256,b.artifact_bytes,
    b.media_type,b.upstream_schema_version,b.parser_version,'imported',counts,summary,b.rights_manifest_uri,b.rights_manifest_sha256,
    b.release_class,b.evidence_bundle_sha256,b.evidence_bundle_uri,b.evidence_decision_sha256,b.evidence_object_version_id,b.evidence_valid_until)
  returning id into release_uuid;
  select generation into strict after_epoch from catalogue_validation_generation_v2 where singleton;
  insert into catalogue_publication_v2(batch_id,release_id,publication_sha256,publisher_principal,admission_sha256,context_sha256,
    validation_terminal_sha256,report_sha256,baseline_release_id,mapping_document,mapping_sha256,initial_generation,last_generation,phase,
    intermediate_bytes,evidence_bytes,record_commitment_sha256,verification_commitment_sha256,last_receipt_sha256,begin_request_document,begin_receipt)
  values(batch,release_uuid,pubhash,actor,a.admission_sha256,a.context_sha256,a.validation_terminal_sha256,a.report_sha256,c.baseline_release_id,
    mapping_doc,mapping_digest,epoch,after_epoch,'materializing',charge,charge,pubhash,pubhash,pubhash,p_document,'{}'::jsonb);
  result:=catalogue_publication_receipt_v2(catalogue_publication_progress_v2(batch)||jsonb_build_object('operation','begin','requestSha256',digest));
  update catalogue_publication_v2 set begin_receipt=result,last_receipt_sha256=result->>'receiptSha256' where batch_id=batch;
  return result;
end;
$$;

-- Static source copy of V1 frozen-food materialization, adapted only to V2 evidence.
create function catalogue_materialize_publication_record_v2(p_batch_id uuid,p_sequence bigint)
returns bigint language plpgsql security definer as $$
declare
  record_row record;workflow_batch food_import_batch%rowtype;source_row food_source%rowtype;release_row food_source_release%rowtype;
  food_row food%rowtype;food_version_row food_version%rowtype;food_document jsonb;nutrient_document jsonb;serving_document jsonb;
  next_version_number integer;mapped_nutrient_id bigint;mapped_nutrient_code text;mapped_canonical_unit text;mapped_source_name text;mapped_source_unit text;
begin
  select v.*,r.source_record_type,r.source_payload_sha256 into strict record_row from catalogue_validation_record_v2 v
    join food_import_record r on r.batch_id=v.batch_id and r.sequence_number=v.sequence_number
    where v.batch_id=p_batch_id and v.sequence_number=p_sequence;
  select * into strict workflow_batch from food_import_batch where id=p_batch_id;
  select * into strict source_row from food_source where id=workflow_batch.food_source_id;
  select r.* into strict release_row from food_source_release r join catalogue_publication_v2 p on p.release_id=r.id where p.batch_id=p_batch_id;
  if record_row.validation_status<>'valid' then raise exception 'only valid frozen records materialize' using errcode='55000'; end if;
    if record_row.validated_food_document is null
      or record_row.validated_food_sha256 is null
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
        'validatedFoodContractVersion', 1,
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


  return food_version_row.id;
end;
$$;

-- Exact persisted materialization check independent of current heads and mapping pointers.
create function catalogue_verify_publication_record_v2(p_batch_id uuid,p_sequence bigint)
returns jsonb language plpgsql security definer as $$
declare
  record_row food_import_record%rowtype;batch_row food_import_batch%rowtype;validation_row catalogue_validation_record_v2%rowtype;
  publication catalogue_publication_v2%rowtype;publication_record catalogue_publication_record_v2%rowtype;
  food_row food%rowtype;version_row food_version%rowtype;food_document jsonb;nutrient_document jsonb;serving_document jsonb;expected_attributes jsonb;expected_hash text;
begin
  select * into strict publication from catalogue_publication_v2 where batch_id=p_batch_id;
  select * into strict publication_record from catalogue_publication_record_v2 where batch_id=p_batch_id and sequence_number=p_sequence;
  select * into strict record_row from food_import_record where id=publication_record.import_record_id and batch_id=p_batch_id and sequence_number=p_sequence;
  select * into strict batch_row from food_import_batch where id=p_batch_id;
  select * into strict validation_row from catalogue_validation_record_v2 where batch_id=p_batch_id and sequence_number=p_sequence;
  if validation_row.canonical_payload_sha256 is distinct from record_row.canonical_payload_sha256
    or validation_row.validated_food_sha256 is distinct from publication_record.validated_food_sha256 then
    raise exception 'publication frozen record identity differs' using errcode='55000'; end if;
  expected_hash:=catalogue_frame_sha256_v2('publication-record',array[publication.publication_sha256,p_sequence::text,
    record_row.id::text,validation_row.record_sha256,coalesce(publication_record.food_id::text,''),
    coalesce(publication_record.food_version_id::text,''),publication_record.materialization_bytes::text]);
  if expected_hash is distinct from publication_record.materialization_sha256 then raise exception 'publication materialization commitment differs' using errcode='55000'; end if;
  if validation_row.validation_status='valid' then
    if publication_record.food_version_id is null or validation_row.validated_food_document is null
      or validation_row.validated_food_sha256 is distinct from encode(sha256(convert_to(validation_row.validated_food_document,'UTF8')),'hex') then
      raise exception 'publication frozen document hash differs' using errcode='55000'; end if;
    food_document:=validation_row.validated_food_document::jsonb;
    select * into strict version_row from food_version where id=publication_record.food_version_id;
    select * into strict food_row from food where id=version_row.food_id;
    expected_attributes := (food_document->'attributes') || pg_catalog.jsonb_build_object(
      'canonicalPayloadSha256',record_row.canonical_payload_sha256,'importBatchId',batch_row.id,
      'validatedFoodContractVersion',1,'validatedFoodSha256',validation_row.validated_food_sha256);
    if food_row.food_source_id <> batch_row.food_source_id or food_row.source_food_key is distinct from food_document->>'sourceFoodKey'
      or food_row.kind is distinct from food_document->>'kind' or food_row.owner_user_id is not null
      or food_row.visibility <> 'public'
      or version_row.source_release_id is distinct from publication.release_id or version_row.name is distinct from food_document->>'name'
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

    if publication_record.food_id is distinct from food_row.id then raise exception 'publication root differs' using errcode='55000'; end if;
  elsif publication_record.food_id is not null or publication_record.food_version_id is not null or publication_record.validated_food_sha256 is not null then
    raise exception 'quarantined publication has materialized food' using errcode='55000';
  end if;
  return jsonb_build_object('sequenceNumber',record_row.sequence_number::text,'sourceRecordKey',record_row.source_record_key,
    'sourceRecordType',record_row.source_record_type,'sourcePayloadSha256',record_row.source_payload_sha256,
    'canonicalPayloadSha256',record_row.canonical_payload_sha256,'canonicalPayload',record_row.canonical_payload,
    'validationStatus',validation_row.validation_status,'validationIssues',validation_row.validation_issues_document::jsonb,
    'validatedFoodDocument',validation_row.validated_food_document,'validatedFoodSha256',validation_row.validated_food_sha256,
    'nutritionSemanticSha256',validation_row.nutrition_semantic_sha256,'foodId',publication_record.food_id::text,
    'foodVersionId',publication_record.food_version_id::text,'materializationSha256',publication_record.materialization_sha256);
end;
$$;

create function catalogue_advance_publication_page_v2(p_document text,p_phase text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;actor text;batch uuid;number bigint;first_seq bigint;end_seq bigint;row_count bigint;input_bytes bigint;
  charge bigint;material_charge bigint;request_sha text;result jsonb;commitment text;version_id bigint;root_id bigint;record_hash text;
  own_generation bigint;valid_count bigint:=0;row_bytes bigint;semantics jsonb;semantic_sha text;item record;
  p catalogue_publication_v2%rowtype;a catalogue_publication_admission_v2%rowtype;c catalogue_validation_context_v2%rowtype;
  prior catalogue_publication_page_v2%rowtype;material_page catalogue_publication_page_v2%rowtype;material_request jsonb;previous_material_receipt text;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  if p_phase not in ('materialize','verify') then raise exception 'unknown publication page phase' using errcode='22023'; end if;
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','batchId','publicationSha256','pageNumber','firstSequence','previousReceiptSha256']);
  batch:=(d->>'batchId')::uuid;number:=catalogue_preparation_uint_v2(d->'pageNumber');first_seq:=catalogue_preparation_uint_v2(d->'firstSequence');
  request_sha:=encode(sha256(convert_to(p_document,'UTF8')),'hex');
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  if p.publisher_principal<>actor or p.publication_sha256 is distinct from d->>'publicationSha256' then raise exception 'publication page identity differs' using errcode='42501'; end if;
  select * into prior from catalogue_publication_page_v2 where batch_id=batch and phase=p_phase and page_number=number;
  if found then
    if prior.request_document<>p_document then raise exception 'publication page replay differs' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  perform catalogue_lock_publication_v2(batch,actor);
  select * into prior from catalogue_publication_page_v2 where batch_id=batch and phase=p_phase and page_number=number;
  if found then
    if prior.request_document<>p_document then raise exception 'publication page replay differs' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  select * into strict a from catalogue_publication_admission_v2 where batch_id=batch;
  select * into strict c from catalogue_validation_context_v2 where batch_id=batch;
  if d->>'previousReceiptSha256' is distinct from p.last_receipt_sha256
    or (p_phase='materialize' and (p.phase<>'materializing' or number<>p.page_count or first_seq<>p.next_sequence))
    or (p_phase='verify' and (p.phase<>'verifying' or number<>p.verified_page_count or first_seq<>p.verified_sequence)) then
    raise exception 'publication page skipped, reordered, overlapped or continued terminal state' using errcode='55000'; end if;
  -- Only a bounded prefix is considered; no batch JSON aggregation is allocated.
  with bounded as (
    select v.sequence_number,coalesce(octet_length(v.validated_food_document),0)::bigint+octet_length(v.validation_issues_document)+8192 as bytes
    from catalogue_validation_record_v2 v where v.batch_id=batch and v.sequence_number>=first_seq order by v.sequence_number limit 250
  ), running as (select *,sum(bytes) over(order by sequence_number) as total from bounded)
  select count(*),coalesce(max(sequence_number)+1,first_seq),coalesce(sum(bytes),0) into row_count,end_seq,input_bytes from running where total<=16777216;
  if row_count=0 or end_seq-first_seq<>row_count or end_seq>c.next_sequence then raise exception 'publication page missing, oversized or discontinuous' using errcode='54000'; end if;
  if exists(select 1 from catalogue_validation_record_v2 where batch_id=batch and sequence_number>=first_seq and sequence_number<end_seq
    and (coalesce(octet_length(validated_food_document),0)>1048576 or octet_length(validation_issues_document)>1048576)) then
    raise exception 'publication record exceeds 1MiB bound' using errcode='54000'; end if;
  select coalesce(sum((coalesce(octet_length(validated_food_document),0)::bigint+8192)*4+
    case when validation_status='valid' then 4096::bigint*(jsonb_array_length(validated_food_document::jsonb->'nutrients')+
      jsonb_array_length(validated_food_document::jsonb->'servings')) else 0 end),0) into material_charge
    from catalogue_validation_record_v2 where batch_id=batch and sequence_number>=first_seq and sequence_number<end_seq;
  charge:=input_bytes*4+row_count*8192+octet_length(p_document)::bigint*3+32768;
  if end_seq>a.max_records or charge>a.max_intermediate_bytes-p.intermediate_bytes
    or octet_length(p_document)::bigint*3+32768>a.max_evidence_bytes-p.evidence_bytes
    or (p_phase='materialize' and material_charge>a.max_materialization_bytes-p.materialization_bytes) then
    raise exception 'publication page exceeds immutable admission' using errcode='54000'; end if;
  if p_phase='verify' then
    select * into strict material_page from catalogue_publication_page_v2 where batch_id=batch and phase='materialize' and page_number=number;
    material_request:=material_page.request_document::jsonb;
    if number=0 then previous_material_receipt:=p.begin_receipt->>'receiptSha256';
    else select receipt_sha256 into strict previous_material_receipt from catalogue_publication_page_v2 where batch_id=batch and phase='materialize' and page_number=number-1; end if;
    if material_page.first_sequence<>first_seq or material_page.next_sequence<>end_seq
      or material_page.request_sha256 is distinct from encode(sha256(convert_to(material_page.request_document,'UTF8')),'hex')
      or material_request->>'publicationSha256' is distinct from p.publication_sha256
      or material_request->>'previousReceiptSha256' is distinct from previous_material_receipt
      or material_request->>'pageNumber' is distinct from number::text or material_request->>'firstSequence' is distinct from first_seq::text
      or material_page.receipt_sha256 is distinct from material_page.receipt->>'receiptSha256'
      or material_page.receipt_sha256 is distinct from encode(sha256(convert_to(material_page.receipt->>'receiptDocument','UTF8')),'hex')
      or (material_page.receipt->>'receiptDocument')::jsonb is distinct from material_page.receipt-array['receiptDocument','receiptSha256']
      or material_page.receipt->>'requestSha256' is distinct from material_page.request_sha256
      or material_page.receipt->>'nextSequence' is distinct from end_seq::text
      or material_page.receipt->>'pageCount' is distinct from (number+1)::text then
      raise exception 'publication retained materialization page chain differs' using errcode='55000'; end if;
  end if;
  commitment:=case when p_phase='materialize' then p.record_commitment_sha256 else p.verification_commitment_sha256 end;
  for item in select v.*,r.id as import_id from catalogue_validation_record_v2 v
    join food_import_record r on r.batch_id=v.batch_id and r.sequence_number=v.sequence_number
    where v.batch_id=batch and v.sequence_number>=first_seq and v.sequence_number<end_seq order by v.sequence_number loop
    if p_phase='materialize' then
      semantics:=catalogue_compute_record_nutrition_semantics_v2(item.import_id,batch);
      semantic_sha:=catalogue_frame_sha256_v2('nutrition-semantic',array[c.context_sha256,item.sequence_number::text,
        item.canonical_payload_sha256,item.validation_status,semantics::text,coalesce(item.validated_food_sha256,'')]);
      if semantic_sha is distinct from item.nutrition_semantic_sha256 or (item.validation_status='valid' and
        ((item.validated_food_document::jsonb)->'nutrients' is distinct from semantics->'nutrients'
        or semantics->'basisIsExact100g' is distinct from 'true'::jsonb)) then
        raise exception 'publication independent frozen nutrient semantics differ' using errcode='55000'; end if;
      version_id:=null;root_id:=null;
      if item.validation_status='valid' then
        version_id:=catalogue_materialize_publication_record_v2(batch,item.sequence_number);
        select food_id into strict root_id from food_version where id=version_id;
      end if;
      row_bytes:=(coalesce(octet_length(item.validated_food_document),0)::bigint+8192)*4+
        case when item.validation_status='valid' then 4096::bigint*(jsonb_array_length(item.validated_food_document::jsonb->'nutrients')+
          jsonb_array_length(item.validated_food_document::jsonb->'servings')) else 0 end;
      record_hash:=catalogue_frame_sha256_v2('publication-record',array[p.publication_sha256,item.sequence_number::text,item.import_id::text,
        item.record_sha256,coalesce(root_id::text,''),coalesce(version_id::text,''),row_bytes::text]);
      insert into catalogue_publication_record_v2 values(batch,item.sequence_number,item.import_id,root_id,version_id,item.validated_food_sha256,record_hash,row_bytes);
    else
      perform catalogue_verify_publication_record_v2(batch,item.sequence_number);
      select materialization_sha256 into strict record_hash from catalogue_publication_record_v2 where batch_id=batch and sequence_number=item.sequence_number;
    end if;
    commitment:=catalogue_frame_sha256_v2('publication-record-chain',array[commitment,record_hash]);
    if item.validation_status='valid' then valid_count:=valid_count+1; end if;
  end loop;
  if p_phase='verify' and commitment is distinct from material_page.record_commitment_sha256 then
    raise exception 'publication page records differ from retained materialization commitment' using errcode='55000'; end if;
  select generation into strict own_generation from catalogue_validation_generation_v2 where singleton;
  update catalogue_publication_v2 set
    phase=case when p_phase='materialize' and end_seq=c.next_sequence then 'verifying' else phase end,
    next_sequence=case when p_phase='materialize' then end_seq else next_sequence end,
    page_count=page_count+case when p_phase='materialize' then 1 else 0 end,
    materialized_count=materialized_count+case when p_phase='materialize' then valid_count else 0 end,
    materialization_bytes=materialization_bytes+case when p_phase='materialize' then material_charge else 0 end,
    verified_sequence=case when p_phase='verify' then end_seq else verified_sequence end,
    verified_page_count=verified_page_count+case when p_phase='verify' then 1 else 0 end,
    verified_materialized_count=verified_materialized_count+case when p_phase='verify' then valid_count else 0 end,
    record_commitment_sha256=case when p_phase='materialize' then commitment else record_commitment_sha256 end,
    verification_commitment_sha256=case when p_phase='verify' then commitment else verification_commitment_sha256 end,
    last_generation=own_generation,intermediate_bytes=intermediate_bytes+charge,evidence_bytes=evidence_bytes+octet_length(p_document)::bigint*3+32768
    where batch_id=batch;
  result:=catalogue_publication_receipt_v2(catalogue_publication_progress_v2(batch)||jsonb_build_object('operation',p_phase,'requestSha256',request_sha));
  insert into catalogue_publication_page_v2 values(batch,p_phase,number,first_seq,end_seq,p_document,request_sha,commitment,result->>'receiptSha256',result);
  update catalogue_publication_v2 set last_receipt_sha256=result->>'receiptSha256' where batch_id=batch;
  if (select evidence_valid_until from food_import_batch where id=batch)<=clock_timestamp() then raise exception 'publication evidence expired during page' using errcode='55000'; end if;
  return result;
end;
$$;
create function catalogue_materialize_publication_page_v2(p_document text)
returns jsonb language sql security definer as $$ select catalogue_advance_publication_page_v2(p_document,'materialize'); $$;
create function catalogue_verify_publication_page_v2(p_document text)
returns jsonb language sql security definer as $$ select catalogue_advance_publication_page_v2(p_document,'verify'); $$;
create function catalogue_finish_publication_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;actor text;batch uuid;p catalogue_publication_v2%rowtype;c catalogue_validation_context_v2%rowtype;
  a catalogue_publication_admission_v2%rowtype;seal text;result jsonb;charge bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','batchId','publicationSha256','previousReceiptSha256']);batch:=(d->>'batchId')::uuid;
  perform catalogue_publication_timeouts_v2();
  perform 1 from food_import_batch where id=batch for update;
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  if p.publisher_principal<>actor or p.publication_sha256 is distinct from d->>'publicationSha256' then raise exception 'publication finish identity differs' using errcode='42501'; end if;
  if p.finish_receipt is not null then
    if p.finish_request_document<>p_document then raise exception 'publication finish replay differs' using errcode='55000'; end if;
    return p.finish_receipt;
  end if;
  perform catalogue_lock_publication_v2(batch,actor);
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  select * into strict c from catalogue_validation_context_v2 where batch_id=batch;
  select * into strict a from catalogue_publication_admission_v2 where batch_id=batch;
  if p.phase<>'verifying' or p.verified_sequence<>c.next_sequence or p.next_sequence<>c.next_sequence
    or p.materialized_count<>c.valid_count or p.verified_materialized_count<>c.valid_count
    or p.record_commitment_sha256<>p.verification_commitment_sha256 or d->>'previousReceiptSha256' is distinct from p.last_receipt_sha256
    or (select count(*) from catalogue_publication_record_v2 where batch_id=batch)<>c.next_sequence
    or (select count(*) from catalogue_publication_page_v2 where batch_id=batch and phase='materialize')<>p.page_count
    or (select count(*) from catalogue_publication_page_v2 where batch_id=batch and phase='verify')<>p.verified_page_count then
    raise exception 'publication finalization lacks complete verified coverage' using errcode='55000'; end if;
  charge:=octet_length(p_document)::bigint*3+32768;
  if charge>a.max_intermediate_bytes-p.intermediate_bytes or charge>a.max_evidence_bytes-p.evidence_bytes then
    raise exception 'publication finalization exceeds admission' using errcode='54000'; end if;
  seal:=catalogue_frame_sha256_v2('publication-seal',array[p.publication_sha256,p.record_commitment_sha256,
    p.next_sequence::text,p.materialized_count::text,p.materialization_bytes::text,p.page_count::text,p.verified_page_count::text]);
  -- One transaction builds the exact receipt before the guarded terminal transition.
  result:=catalogue_publication_receipt_v2(catalogue_publication_progress_v2(batch)||jsonb_build_object('operation','finish',
    'requestSha256',encode(sha256(convert_to(p_document,'UTF8')),'hex'),'phase','sealed','sealSha256',seal));
  update catalogue_publication_v2 set phase='sealed',seal_sha256=seal,finish_request_document=p_document,finish_receipt=result,
    last_receipt_sha256=result->>'receiptSha256',intermediate_bytes=intermediate_bytes+charge,evidence_bytes=evidence_bytes+charge where batch_id=batch;
  return result;
end;
$$;
create function catalogue_read_publication_v2(p_batch_id uuid)
returns jsonb language plpgsql security definer as $$
declare p catalogue_publication_v2%rowtype;actor text;
begin
  if pg_has_role(session_user,'nutrition_catalogue_promote_activate','member') then
    actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  else actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_rollback'); end if;
  select * into strict p from catalogue_publication_v2 where batch_id=p_batch_id;
  if (pg_has_role(session_user,'nutrition_catalogue_promote_activate','member') and p.publisher_principal<>actor)
    or (pg_has_role(session_user,'nutrition_catalogue_rollback','member') and p.phase<>'activated') then
    raise exception 'publication context unavailable for this identity' using errcode='42501'; end if;
  return catalogue_publication_progress_v2(p_batch_id)||jsonb_build_object('lastReceiptSha256',p.last_receipt_sha256);
end;
$$;

do $migration$
begin
  if not exists(select 1 from pg_proc where oid='guard_food_source_release_activation_authority()'::regprocedure
    and proowner=(select relowner from pg_class where oid='food_import_batch'::regclass)
    and not prosecdef and proconfig is not distinct from array[format('search_path=pg_catalog, %I, pg_temp',current_schema())]
    and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) acl where acl.grantee<>proowner)
    and exists(select 1 from pg_trigger t where t.tgrelid='food_source_release_activation'::regclass
      and t.tgname='food_source_release_activation_guard_authority' and t.tgfoid=pg_proc.oid and t.tgtype=7 and t.tgenabled='O' and not t.tgisinternal)
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='d46f53aeffa6469eada5461ab59bd9c23d43bf9aab77704c61b21c44291ae028') then
    raise exception 'activation guard predecessor attestation differs' using errcode='55000'; end if;
end;
$migration$;
create or replace function guard_food_source_release_activation_authority()
returns trigger language plpgsql as $$
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
      or batch.food_source_id <> new.food_source_id
      or not ((batch.status='promoting' and batch.release_id is not distinct from new.release_id)
        or exists(select 1 from catalogue_publication_v2 p where p.batch_id=batch.id and p.release_id=new.release_id
          and p.phase='sealed' and p.seal_sha256 is not null and p.publisher_principal=session_user::text)) then
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
create function catalogue_verify_legacy_publication_record_v2(p_record_id bigint,p_release_id uuid)
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
      or food_row.visibility <> 'public'
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

create function catalogue_publication_target_barcodes_v2(p_release_id uuid)
returns table(food_id bigint,food_version_id bigint,gtin text,market_code text)
language sql stable security definer as $$
  select r.food_id,r.food_version_id,v.gtin14,v.market_code from catalogue_publication_v2 p
    join catalogue_publication_record_v2 r on r.batch_id=p.batch_id
    join catalogue_validation_record_v2 v on v.batch_id=r.batch_id and v.sequence_number=r.sequence_number
    where p.release_id=p_release_id and v.validation_status='valid' and v.gtin14 is not null
  union all
  select f.id,r.food_version_id,r.validated_food_document::jsonb->>'gtin',r.validated_food_document::jsonb->>'marketCode'
    from food_import_batch b join food_import_record r on r.batch_id=b.id join food_version v on v.id=r.food_version_id
    join food f on f.id=v.food_id where b.release_id=p_release_id and b.status='completed' and r.validation_status='materialized'
      and r.validated_food_document::jsonb->>'gtin' is not null
      and not exists(select 1 from catalogue_publication_v2 where release_id=p_release_id);
$$;
create function catalogue_assert_publication_cutover_budget_v2(p_source_id bigint,p_target uuid,p_budget_batch uuid,p_extra_bytes bigint)
returns void language plpgsql security definer as $$
declare a catalogue_publication_admission_v2%rowtype;p catalogue_publication_v2%rowtype;foods bigint;barcodes bigint;bytes bigint;old_evidence bigint;
begin
  select * into strict a from catalogue_publication_admission_v2 where batch_id=p_budget_batch;
  select * into strict p from catalogue_publication_v2 where batch_id=p_budget_batch;
  select count(*),coalesce(sum(pg_column_size(f)::bigint+2048),0) into foods,bytes from food f where food_source_id=p_source_id;
  select count(*),bytes+coalesce(sum(pg_column_size(b)::bigint+4096),0) into barcodes,bytes from food_barcode b
    join food f on f.id=b.food_id where f.food_source_id=p_source_id and b.valid_to is null;
  select barcodes+count(*),bytes+coalesce(sum(octet_length(gtin)+octet_length(market_code)+4096),0) into barcodes,bytes
    from catalogue_publication_target_barcodes_v2(p_target);
  select coalesce(sum(octet_length(request_document)::bigint*3+32768),0) into old_evidence
    from catalogue_publication_rollback_v2 where source_id=p_source_id;
  if foods>a.max_cutover_food_rows or barcodes>a.max_cutover_barcode_rows or bytes>a.max_cutover_bytes
    or p_extra_bytes>a.max_evidence_bytes-p.evidence_bytes-old_evidence
    or p_extra_bytes>a.max_intermediate_bytes-p.intermediate_bytes-old_evidence then
    raise exception 'atomic cutover exceeds admitted row, byte or retained-history budget' using errcode='54000'; end if;
end;
$$;
create function catalogue_cutover_publication_v2(p_source_id bigint,p_target uuid,p_operation text,p_batch uuid,p_actor text,p_reason text)
returns bigint language plpgsql security definer as $$
declare prior uuid;activation bigint;role_name text;
begin
  role_name:=case when p_operation='activate' then 'nutrition_catalogue_promote_activate' else 'nutrition_catalogue_rollback' end;
  if catalogue_require_preparation_role_v2(role_name)<>p_actor or p_operation not in ('activate','rollback','deactivate') then
    raise exception 'cutover role or operation differs' using errcode='42501'; end if;
  select active_release_id into strict prior from food_source where id=p_source_id;
  if exists(select 1 from catalogue_publication_target_barcodes_v2(p_target) desired
    join food_barcode active on lpad(active.gtin,14,'0')=desired.gtin and active.market_code=desired.market_code and active.valid_to is null
    join food f on f.id=active.food_id where f.food_source_id is distinct from p_source_id) then
    raise exception 'target barcode is active for another source' using errcode='23505'; end if;
  update food set current_version_id=null,archived_at=clock_timestamp() where food_source_id=p_source_id;
  if p_target is not null then
    update food f set current_version_id=v.id,archived_at=null from food_version v
      where f.food_source_id=p_source_id and v.food_id=f.id and v.source_release_id=p_target;
  end if;
  update food_barcode b set valid_to=clock_timestamp() from food f
    where f.id=b.food_id and f.food_source_id=p_source_id and b.valid_to is null;
  insert into food_barcode(food_id,food_version_id,gtin,market_code,source_release_id,metadata)
    select food_id,food_version_id,gtin,market_code,p_target,jsonb_build_object('activation',p_operation,'publicationProtocolVersion',2)
    from catalogue_publication_target_barcodes_v2(p_target);
  update food_source set active_release_id=p_target where id=p_source_id;
  insert into food_source_release_activation(food_source_id,import_batch_id,operation,performed_by,previous_release_id,reason,release_id,database_principal,database_capability_role)
    values(p_source_id,p_batch,p_operation,p_actor,prior,p_reason,p_target,p_actor,role_name) returning id into activation;
  insert into outbox_event(aggregate_id,aggregate_type,attempt_count,available_at,deduplication_key,event_version,event_type,headers,payload)
    values(p_source_id::text,'food_source',0,clock_timestamp(),'catalogue-activation:'||activation::text,1,'catalogue.source_release_activated','{}'::jsonb,
      jsonb_build_object('activationId',activation::text,'previousReleaseId',prior,'releaseId',p_target,'sourceId',p_source_id::text));
  return activation;
end;
$$;
create function catalogue_activate_publication_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;actor text;batch uuid;expected uuid;p catalogue_publication_v2%rowtype;b food_import_batch%rowtype;
  result jsonb;activation bigint;epoch bigint;charge bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','batchId','publicationSha256','sealSha256','expectedCurrentReleaseId','reason']);
  batch:=(d->>'batchId')::uuid;expected:=(d->>'expectedCurrentReleaseId')::uuid;
  if jsonb_typeof(d->'reason') is distinct from 'string' or length(btrim(d->>'reason'))=0 or octet_length(d->>'reason')>2048 then
    raise exception 'publication activation reason missing or oversized' using errcode='22023'; end if;
  perform catalogue_publication_timeouts_v2();
  perform 1 from food_import_batch where id=batch for update;
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  select * into strict b from food_import_batch where id=batch;
  if p.publisher_principal<>actor or p.publication_sha256 is distinct from d->>'publicationSha256' or p.seal_sha256 is distinct from d->>'sealSha256' then
    raise exception 'publication activation identity differs' using errcode='42501'; end if;
  if p.activation_receipt is not null then
    if p.activation_request_document<>p_document or (select active_release_id from food_source where id=b.food_source_id) is distinct from p.release_id
      or (select max(id)::text from food_source_release_activation where food_source_id=b.food_source_id) is distinct from p.activation_receipt->>'activationId' then
      raise exception 'activation retry differs or has been superseded' using errcode='55000'; end if;
    return p.activation_receipt;
  end if;
  perform catalogue_lock_publication_v2(batch,actor);
  select * into strict p from catalogue_publication_v2 where batch_id=batch;
  if p.phase<>'sealed' or expected is distinct from p.baseline_release_id then raise exception 'publication activation phase or baseline differs' using errcode='55000'; end if;
  perform catalogue_assert_publication_approvals_v2(batch,p.context_sha256,p.validation_terminal_sha256,p.report_sha256,actor);
  charge:=octet_length(p_document)::bigint*3+32768;
  perform catalogue_assert_publication_cutover_budget_v2(b.food_source_id,p.release_id,batch,charge);
  if (select count(*) from food_version where source_release_id=p.release_id)<>p.materialized_count then
    raise exception 'publication release has an unexpected materialized version' using errcode='55000'; end if;
  update food_source_release set status='promoted',promoted_at=clock_timestamp() where id=p.release_id and status='imported';
  if not found then raise exception 'publication release is not imported' using errcode='55000'; end if;
  activation:=catalogue_cutover_publication_v2(b.food_source_id,p.release_id,'activate',batch,actor,d->>'reason');
  select generation into strict epoch from catalogue_validation_generation_v2 where singleton;
  result:=catalogue_publication_receipt_v2(catalogue_publication_progress_v2(batch)||jsonb_build_object('operation','activate',
    'requestSha256',encode(sha256(convert_to(p_document,'UTF8')),'hex'),'phase','activated','generation',epoch::text,
    'activationId',activation::text,'previousReleaseId',p.baseline_release_id::text,'activeReleaseId',p.release_id::text));
  update catalogue_publication_v2 set phase='activated',activated_at=clock_timestamp(),last_generation=epoch,
    activation_request_document=p_document,activation_receipt=result,last_receipt_sha256=result->>'receiptSha256',
    intermediate_bytes=intermediate_bytes+charge,evidence_bytes=evidence_bytes+charge where batch_id=batch;
  if b.evidence_valid_until<=clock_timestamp() then raise exception 'publication evidence expired during cutover' using errcode='55000'; end if;
  return result;
end;
$$;

create function catalogue_rollback_publication_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare d jsonb;actor text;target uuid;expected uuid;request_uuid uuid;source_row food_source%rowtype;target_row food_source_release%rowtype;
  prior catalogue_publication_rollback_v2%rowtype;current_pub catalogue_publication_v2%rowtype;target_pub catalogue_publication_v2%rowtype;
  batch_uuid uuid;origin_batch uuid;origin_count bigint;activation bigint;result jsonb;charge bigint;item record;actual_versions bigint;
begin
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_rollback');perform catalogue_publication_timeouts_v2();
  d:=catalogue_publication_request_v2(p_document,array['schemaVersion','sourceCode','targetReleaseId','expectedCurrentReleaseId','reason','requestId']);
  target:=(d->>'targetReleaseId')::uuid;expected:=(d->>'expectedCurrentReleaseId')::uuid;request_uuid:=(d->>'requestId')::uuid;
  if d->>'sourceCode' is null or d->>'sourceCode' !~ '^[A-Z][A-Z0-9_]{1,31}$'
    or jsonb_typeof(d->'reason') is distinct from 'string' or length(btrim(d->>'reason'))=0 or octet_length(d->>'reason')>2048 then
    raise exception 'publication rollback source or reason differs' using errcode='22023'; end if;
  select * into strict source_row from food_source where code=d->>'sourceCode';
  select * into prior from catalogue_publication_rollback_v2 where request_id=request_uuid;
  if found then
    if prior.actor<>actor or prior.request_document<>p_document or source_row.active_release_id is distinct from prior.target_release_id
      or (select max(id) from food_source_release_activation where food_source_id=source_row.id) is distinct from prior.activation_id then
      raise exception 'rollback replay differs or has been superseded' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  -- Lock all known original batch rows first, then the source, registry and generation.
  -- The expected source head is rechecked after locks; a changed read cannot select new inputs.
  for batch_uuid in select b.id from food_import_batch b where b.id in (
    select batch_id from catalogue_publication_v2 where release_id in (expected,target)
    union select id from food_import_batch where release_id in (expected,target)
  ) order by b.id loop perform 1 from food_import_batch where id=batch_uuid for update; end loop;
  select * into strict source_row from food_source where id=source_row.id for update;
  perform pg_advisory_xact_lock(hashtext('nutrition-tracker:catalogue-source:v1'),hashtext(source_row.id::text));
  perform lock_active_nutrient_registry_for_read();
  perform 1 from catalogue_validation_generation_v2 where singleton for update;
  select * into prior from catalogue_publication_rollback_v2 where request_id=request_uuid;
  if found then
    if prior.actor<>actor or prior.request_document<>p_document or source_row.active_release_id is distinct from prior.target_release_id
      or (select max(id) from food_source_release_activation where food_source_id=source_row.id) is distinct from prior.activation_id then
      raise exception 'rollback replay differs or has been superseded' using errcode='55000'; end if;
    return prior.receipt;
  end if;
  if source_row.active_release_id is distinct from expected or target is not distinct from expected then
    raise exception 'rollback expected current release differs or operation is a no-op' using errcode='40001'; end if;
  select * into current_pub from catalogue_publication_v2 where release_id=expected;
  select * into target_pub from catalogue_publication_v2 where release_id=target;
  if current_pub.batch_id is null and target_pub.batch_id is null then
    raise exception 'V1-only rollback uses its existing reviewed consumer' using errcode='55000'; end if;
  if current_pub.batch_id is not null and current_pub.phase<>'activated' then raise exception 'current V2 source is not an activated publication' using errcode='55000'; end if;
  charge:=octet_length(p_document)::bigint*3+32768;
  if current_pub.batch_id is not null then perform catalogue_assert_publication_cutover_budget_v2(source_row.id,target,current_pub.batch_id,charge); end if;
  if target_pub.batch_id is not null then perform catalogue_assert_publication_cutover_budget_v2(source_row.id,target,target_pub.batch_id,charge); end if;
  if target is not null then
    select * into strict target_row from food_source_release where id=target and food_source_id=source_row.id;
    if not source_row.active or source_row.commercial_use_allowed is distinct from true or source_row.redistribution_allowed is distinct from true
      or source_row.rights_review_status not in ('approved','restricted') or source_row.rights_reviewed_at is null or source_row.rights_reviewed_by is null
      or target_row.status<>'promoted' or target_row.release_class<>'live-reviewed' then
      raise exception 'rollback requires an eligible source and previously promoted live-reviewed target' using errcode='55000'; end if;
    if target_pub.batch_id is not null then
      if target_pub.phase<>'activated' or target_pub.activated_at is null or target_pub.seal_sha256 is null
        or target_pub.activation_receipt is null or not exists(select 1 from food_source_release_activation a
          where a.id=(target_pub.activation_receipt->>'activationId')::bigint and a.operation='activate'
            and a.release_id=target and a.import_batch_id=target_pub.batch_id and a.food_source_id=source_row.id) then
        raise exception 'V2 rollback target lacks immutable activation lineage' using errcode='55000'; end if;
      for item in select sequence_number from catalogue_publication_record_v2 where batch_id=target_pub.batch_id order by sequence_number loop
        perform catalogue_verify_publication_record_v2(target_pub.batch_id,item.sequence_number);
      end loop;
      if (select count(*) from catalogue_publication_record_v2 where batch_id=target_pub.batch_id)<>target_pub.next_sequence then
        raise exception 'V2 rollback target lost record coverage' using errcode='55000'; end if;
      select count(*) into actual_versions from food_version where source_release_id=target;
      if actual_versions<>target_pub.materialized_count then raise exception 'V2 rollback materialization cardinality differs' using errcode='55000'; end if;
    else
      select count(*),min(b.id::text)::uuid into origin_count,origin_batch from food_source_release_activation a
        join food_import_batch b on b.id=a.import_batch_id and b.food_source_id=a.food_source_id and b.release_id=a.release_id
        where a.food_source_id=source_row.id and a.release_id=target and a.operation='activate' and b.status='completed';
      if origin_count<>1 or not exists(select 1 from food_import_batch where id=origin_batch
        and nutrition_semantic_contract_version=1 and nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$') then
        raise exception 'V1 rollback target lacks its completed semantic lineage' using errcode='55000'; end if;
      perform catalogue_attest_import_nutrition_semantics(origin_batch);
      for item in select id from food_import_record where batch_id=origin_batch order by sequence_number loop
        perform catalogue_verify_legacy_publication_record_v2(item.id,target);
      end loop;
      if (select count(*) from food_version where source_release_id=target)<>(select materialized_count from food_import_batch where id=origin_batch) then
        raise exception 'V1 rollback materialization cardinality differs' using errcode='55000'; end if;
    end if;
  end if;
  activation:=catalogue_cutover_publication_v2(source_row.id,target,case when target is null then 'deactivate' else 'rollback' end,null,actor,d->>'reason');
  result:=catalogue_publication_receipt_v2(jsonb_build_object('schemaVersion',2,'operation','rollback','batchId',null,
    'sourceCode',source_row.code,'requestSha256',encode(sha256(convert_to(p_document,'UTF8')),'hex'),
    'requestId',request_uuid::text,'activationId',activation::text,'previousReleaseId',expected::text,'activeReleaseId',target::text));
  insert into catalogue_publication_rollback_v2 values(request_uuid,source_row.id,target,expected,actor,p_document,
    encode(sha256(convert_to(p_document,'UTF8')),'hex'),result,activation,clock_timestamp());
  return result;
end;
$$;

-- Restricted functions are the only writers. Owner/local direct DML cannot mint
-- evidence; actual singleton logins are required even inside these definer guards.
create function catalogue_guard_publication_v2()
returns trigger language plpgsql security definer as $$
declare actor text;a catalogue_publication_admission_v2%rowtype;p catalogue_publication_v2%rowtype;v catalogue_validation_record_v2%rowtype;
begin
  if tg_op in ('DELETE','TRUNCATE') then raise exception 'publication evidence cannot be deleted or truncated' using errcode='55000'; end if;
  if tg_table_name='catalogue_publication_admission_v2' then
    actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_approve_quality');
    if tg_op<>'INSERT' or new.admitted_by<>actor or new.publisher_principal=actor then raise exception 'publication admission is immutable' using errcode='55000'; end if;
    perform catalogue_assert_validation_context_v2(new.batch_id);
    if new.request_sha256 is distinct from encode(sha256(convert_to(new.request_document,'UTF8')),'hex')
      or new.admission_sha256 is distinct from catalogue_frame_sha256_v2('publication-admission',array[new.batch_id::text,actor,new.request_sha256]) then
      raise exception 'publication admission identity commitment differs' using errcode='55000'; end if;
    return new;
  end if;
  if tg_table_name='catalogue_publication_rollback_v2' then
    actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_rollback');
    if tg_op<>'INSERT' or new.actor<>actor or new.request_sha256 is distinct from encode(sha256(convert_to(new.request_document,'UTF8')),'hex')
      or not exists(select 1 from food_source_release_activation h where h.id=new.activation_id and h.food_source_id=new.source_id
        and h.release_id is not distinct from new.target_release_id and h.previous_release_id is not distinct from new.previous_release_id
        and h.database_principal=actor and h.database_capability_role='nutrition_catalogue_rollback') then
      raise exception 'rollback evidence lacks exact authenticated activation' using errcode='55000'; end if;
    return new;
  end if;
  actor:=catalogue_require_preparation_role_v2('nutrition_catalogue_promote_activate');
  select * into strict a from catalogue_publication_admission_v2 where batch_id=new.batch_id;
  if a.publisher_principal<>actor then raise exception 'publication evidence belongs to another publisher' using errcode='42501'; end if;
  if tg_table_name='catalogue_publication_v2' then
    if new.publisher_principal<>actor or new.admission_sha256<>a.admission_sha256 or new.context_sha256<>a.context_sha256
      or new.validation_terminal_sha256<>a.validation_terminal_sha256 or new.report_sha256<>a.report_sha256
      or new.next_sequence>a.max_records or new.materialization_bytes>a.max_materialization_bytes
      or new.intermediate_bytes>a.max_intermediate_bytes or new.evidence_bytes>a.max_evidence_bytes
      or new.verified_sequence>new.next_sequence or new.verified_materialized_count>new.materialized_count then
      raise exception 'publication context or budget differs' using errcode='55000'; end if;
    if tg_op='INSERT' then
      if new.phase not in ('materializing','verifying') or new.next_sequence<>0 or new.page_count<>0 or new.materialized_count<>0
        or new.verified_sequence<>0 or new.verified_page_count<>0 or new.verified_materialized_count<>0
        or new.record_commitment_sha256<>new.publication_sha256 or new.verification_commitment_sha256<>new.publication_sha256
        or new.last_generation<>(select generation from catalogue_validation_generation_v2 where singleton) then
        raise exception 'publication must begin with empty progress and own current generation' using errcode='55000'; end if;
    else
      if (to_jsonb(new)-array['phase','next_sequence','page_count','materialized_count','materialization_bytes','intermediate_bytes','evidence_bytes',
        'verified_sequence','verified_page_count','verified_materialized_count','record_commitment_sha256','verification_commitment_sha256',
        'last_receipt_sha256','seal_sha256','last_generation','begin_receipt','finish_request_document','finish_receipt','activation_request_document','activation_receipt','activated_at'])
        is distinct from (to_jsonb(old)-array['phase','next_sequence','page_count','materialized_count','materialization_bytes','intermediate_bytes','evidence_bytes',
        'verified_sequence','verified_page_count','verified_materialized_count','record_commitment_sha256','verification_commitment_sha256',
        'last_receipt_sha256','seal_sha256','last_generation','begin_receipt','finish_request_document','finish_receipt','activation_request_document','activation_receipt','activated_at'])
        or old.phase='activated' or (new.phase<>old.phase and not (old.phase='materializing' and new.phase='verifying'
          or old.phase='verifying' and new.phase='sealed' or old.phase='sealed' and new.phase='activated'))
        or new.next_sequence<old.next_sequence or new.next_sequence>old.next_sequence+250
        or new.verified_sequence<old.verified_sequence or new.verified_sequence>old.verified_sequence+250
        or new.materialized_count<old.materialized_count or new.verified_materialized_count<old.verified_materialized_count
        or new.page_count<old.page_count or new.page_count>old.page_count+1 or new.verified_page_count<old.verified_page_count or new.verified_page_count>old.verified_page_count+1
        or new.last_generation<old.last_generation or new.materialization_bytes<old.materialization_bytes
        or new.intermediate_bytes<old.intermediate_bytes or new.evidence_bytes<old.evidence_bytes
        or (old.begin_receipt<>'{}'::jsonb and new.begin_receipt is distinct from old.begin_receipt)
        or (old.finish_receipt is not null and new.finish_receipt is distinct from old.finish_receipt)
        or (old.finish_request_document is not null and new.finish_request_document is distinct from old.finish_request_document)
        or (old.seal_sha256 is not null and new.seal_sha256 is distinct from old.seal_sha256) then
        raise exception 'publication immutable identity or monotonic transition differs' using errcode='55000'; end if;
    end if;
    return new;
  end if;
  if tg_op<>'INSERT' then raise exception 'publication page and record evidence is immutable' using errcode='55000'; end if;
  select * into strict p from catalogue_publication_v2 where batch_id=new.batch_id;
  if tg_table_name='catalogue_publication_record_v2' then
    select * into strict v from catalogue_validation_record_v2 where batch_id=new.batch_id and sequence_number=new.sequence_number;
    if p.phase<>'materializing' or new.sequence_number<p.next_sequence or new.sequence_number>=p.next_sequence+250
      or new.validated_food_sha256 is distinct from v.validated_food_sha256
      or (v.validation_status='valid') is distinct from (new.food_version_id is not null)
      or not exists(select 1 from food_import_record r where r.id=new.import_record_id and r.batch_id=new.batch_id and r.sequence_number=new.sequence_number) then
      raise exception 'publication record is outside its frozen page' using errcode='55000'; end if;
  else
    if new.request_sha256 is distinct from encode(sha256(convert_to(new.request_document,'UTF8')),'hex')
      or new.receipt_sha256 is distinct from new.receipt->>'receiptSha256'
      or (new.phase='materialize' and (new.page_number+1<>p.page_count or new.next_sequence<>p.next_sequence or new.record_commitment_sha256<>p.record_commitment_sha256))
      or (new.phase='verify' and (new.page_number+1<>p.verified_page_count or new.next_sequence<>p.verified_sequence or new.record_commitment_sha256<>p.verification_commitment_sha256)) then
      raise exception 'publication page differs from its durable progress' using errcode='55000'; end if;
  end if;
  return new;
end;
$$;

do $migration$
declare schema_name text:=current_schema();owner_name text;relation_name text;function_row record;grant_row record;
begin
  select pg_get_userbyid(relowner) into owner_name from pg_class where oid='food_import_batch'::regclass;
  foreach relation_name in array array['catalogue_publication_admission_v2','catalogue_publication_v2','catalogue_publication_record_v2','catalogue_publication_page_v2','catalogue_publication_rollback_v2'] loop
    execute format('create trigger %I before insert or update or delete on %I.%I for each row execute function %I.catalogue_guard_publication_v2()',relation_name||'_guard',schema_name,relation_name,schema_name);
    execute format('create trigger %I before truncate on %I.%I for each statement execute function %I.catalogue_guard_publication_v2()',relation_name||'_truncate',schema_name,relation_name,schema_name);
    execute format('revoke all on table %I.%I from public',schema_name,relation_name);
    for grant_row in select distinct r.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      join pg_roles r on r.oid=a.grantee where c.oid=to_regclass(format('%I.%I',schema_name,relation_name)) and r.rolname<>owner_name loop
      execute format('revoke all on table %I.%I from %I',schema_name,relation_name,grant_row.rolname);
    end loop;
  end loop;
  for function_row in select p.oid,p.proname,pg_get_function_identity_arguments(p.oid) arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=schema_name and p.proname in ('catalogue_publication_request_v2','catalogue_publication_receipt_v2','catalogue_publication_timeouts_v2','catalogue_publication_progress_v2','catalogue_lock_publication_v2','catalogue_assert_publication_approvals_v2','catalogue_admit_publication_v2','catalogue_begin_publication_v2','catalogue_materialize_publication_record_v2','catalogue_verify_publication_record_v2','catalogue_advance_publication_page_v2','catalogue_materialize_publication_page_v2','catalogue_verify_publication_page_v2','catalogue_finish_publication_v2','catalogue_read_publication_v2','catalogue_verify_legacy_publication_record_v2','catalogue_publication_target_barcodes_v2','catalogue_assert_publication_cutover_budget_v2','catalogue_cutover_publication_v2','catalogue_activate_publication_v2','catalogue_rollback_publication_v2','catalogue_guard_publication_v2') loop
    execute format('alter function %I.%I(%s) set search_path=pg_catalog,%I,pg_temp',schema_name,function_row.proname,function_row.arguments,schema_name);
    execute format('alter function %I.%I(%s) owner to %I',schema_name,function_row.proname,function_row.arguments,owner_name);
    execute format('revoke all on function %I.%I(%s) from public',schema_name,function_row.proname,function_row.arguments);
    for grant_row in select distinct r.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      join pg_roles r on r.oid=a.grantee where p.oid=function_row.oid and r.rolname<>owner_name loop
      execute format('revoke all on function %I.%I(%s) from %I',schema_name,function_row.proname,function_row.arguments,grant_row.rolname);
    end loop;
  end loop;
  execute format('alter function %I.guard_food_source_release_activation_authority() set search_path=pg_catalog,%I,pg_temp',schema_name,schema_name);
  execute format('grant execute on function %I.catalogue_admit_publication_v2(text) to nutrition_catalogue_approve_quality',schema_name);
  execute format('grant execute on function %I.catalogue_begin_publication_v2(text) to nutrition_catalogue_promote_activate',schema_name);
  execute format('grant execute on function %I.catalogue_materialize_publication_page_v2(text) to nutrition_catalogue_promote_activate',schema_name);
  execute format('grant execute on function %I.catalogue_verify_publication_page_v2(text) to nutrition_catalogue_promote_activate',schema_name);
  execute format('grant execute on function %I.catalogue_finish_publication_v2(text) to nutrition_catalogue_promote_activate',schema_name);
  execute format('grant execute on function %I.catalogue_activate_publication_v2(text) to nutrition_catalogue_promote_activate',schema_name);
  execute format('grant execute on function %I.catalogue_rollback_publication_v2(text) to nutrition_catalogue_rollback',schema_name);
  execute format('grant execute on function %I.catalogue_read_publication_v2(uuid) to nutrition_catalogue_promote_activate,nutrition_catalogue_rollback',schema_name);
end;
$migration$;
