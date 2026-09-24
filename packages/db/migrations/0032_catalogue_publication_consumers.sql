-- Explicit V1/V2 public eligibility and successor reconciliation. V2 publication
-- never writes legacy batch/record completion evidence. Historical materialization
-- uses frozen publication mappings and immutable validated documents.

do $preflight$
declare expected record; target oid; workflow_owner oid; schema_name text:=current_schema();
begin
  select relowner into strict workflow_owner from pg_class where oid='food_import_batch'::regclass;
  if current_user::regrole::oid<>workflow_owner then
    raise exception 'publication consumers require the workflow owner' using errcode='42501';
  end if;
  for expected in select * from (values
    ('catalogue_reconciliation_baseline_header_v2(uuid)','4c4a81bc60ede20de39a0f73c473d66bfed68bbfea5dc26fbaa5aabd69b647ba'),
    ('catalogue_reconciliation_baseline_record_v2(bigint,uuid)','99f884f6919854dcffe57863830c9b3141a2b4e46ae338663c4ef8b5af1c05de'),
    ('catalogue_prepare_reconciliation_page_v2(uuid,text,bigint)','c2a8c23b29d23cf5232d4fe0d32a8c75632a1d139a5b35ec41ae58d2c83a665c'),
    ('catalogue_reject_legacy_release_v2(uuid)','a5e6b8a52a9f8e93d77300d3c7f4fc0354ee23fee1d28fb90f00a673c550d943')
  ) predecessor(identity,source_sha256) loop
    target:=to_regprocedure(format('%I.%s',schema_name,expected.identity));
    if not exists(select 1 from pg_proc p where p.oid=target and p.proowner=workflow_owner
      and p.prosecdef and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected.source_sha256) then
      raise exception 'publication consumer predecessor differs: %',expected.identity using errcode='55000';
    end if;
  end loop;
end;
$preflight$;

create or replace view promoted_food_search_catalogue_v1 as
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

create or replace function catalogue_reconciliation_baseline_header_v2(p_batch_id uuid)
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
  publication catalogue_publication_v2%rowtype;
  preparation catalogue_preparation_v2%rowtype;
  validation catalogue_validation_context_v2%rowtype;
  reconciliation catalogue_reconciliation_v2%rowtype;
  expected_summary jsonb;
  expected_counts jsonb;
begin
  select * into strict context_row from catalogue_validation_context_v2 where batch_id=p_batch_id;
  if context_row.baseline_release_id is null then return null; end if;
  select * into strict candidate from food_import_batch where id=p_batch_id;
  select * into strict release_row from food_source_release where id=context_row.baseline_release_id;

  select * into publication from catalogue_publication_v2 where release_id=release_row.id;
  if found then
    select * into strict baseline from food_import_batch where id=publication.batch_id;
    select * into strict preparation from catalogue_preparation_v2 where batch_id=baseline.id;
    select * into strict validation from catalogue_validation_context_v2 where batch_id=baseline.id;
    select * into strict reconciliation from catalogue_reconciliation_v2 where batch_id=baseline.id;
    select * into strict parser from food_import_parser_report where batch_id=baseline.id;
    select a.* into strict admission from catalogue_preparation_admission_v2 a
      join catalogue_preparation_v2 p on p.admission_sha256=a.admission_sha256 where p.batch_id=p_batch_id;
    if baseline.food_source_id<>candidate.food_source_id or release_row.food_source_id<>candidate.food_source_id
      or release_row.status<>'promoted' or release_row.promoted_at is null
      or baseline.release_class<>'live-reviewed' or release_row.release_class<>'live-reviewed'
      or publication.phase<>'activated' or publication.activated_at is null or publication.seal_sha256 is null
      or publication.finish_receipt is null or publication.activation_receipt is null
      or publication.activation_receipt->>'activeReleaseId' is distinct from release_row.id::text
      or preparation.phase<>'sealed' or validation.phase<>'validated' or reconciliation.phase<>'complete'
      or reconciliation.context_sha256<>publication.context_sha256
      or validation.terminal_sha256 is distinct from publication.validation_terminal_sha256
      or reconciliation.terminal_sha256 is distinct from publication.report_sha256
      or reconciliation.validation_terminal_sha256<>validation.terminal_sha256
      or validation.staging_seal_sha256<>preparation.staging_seal_sha256
      or publication.baseline_release_id is distinct from validation.baseline_release_id
      or publication.initial_generation<>validation.generation
      or publication.next_sequence<>preparation.staged_count or preparation.staged_count<>baseline.staged_count
      or publication.verified_sequence<>publication.next_sequence
      or publication.verified_page_count<>publication.page_count
      or publication.materialized_count<>validation.valid_count
      or publication.verified_materialized_count<>publication.materialized_count
      or validation.next_sequence<>preparation.staged_count
      or validation.valid_count+validation.quarantined_count<>preparation.staged_count
      or preparation.staged_count>admission.max_baseline_records
      or baseline.status<>'staging' or baseline.release_id is not null
      or baseline.staging_seal_sha256 is not null or baseline.staging_sealed_at is not null
      or baseline.validated_at is not null or baseline.completed_at is not null
      or baseline.validation_digest is not null or baseline.validated_food_contract_version is not null
      or baseline.nutrient_mapping_digest is not null or baseline.nutrient_mapping_revision_ids is not null
      or baseline.nutrition_semantic_contract_version is not null or baseline.nutrition_semantic_sha256 is not null
      or baseline.validated_database_principal is not null or baseline.validated_database_capability_role is not null
      or baseline.materialized_count<>0 or baseline.valid_count<>0 or baseline.quarantined_count<>0
      or baseline.warning_count<>0 or baseline.unresolved_error_count<>0 or baseline.validation_policy<>'{}'::jsonb
      or baseline.nutrient_input_count<>0 or baseline.nutrient_materializable_count<>0 or baseline.nutrient_excluded_count<>0 then
      raise exception 'V2 baseline requires complete immutable publication without legacy materialization evidence' using errcode='55000';
    end if;
    if publication.publication_sha256 is distinct from catalogue_frame_sha256_v2('publication-context',array[
        baseline.id::text,publication.admission_sha256,publication.context_sha256,publication.validation_terminal_sha256,
        publication.report_sha256,publication.publisher_principal,coalesce(publication.baseline_release_id::text,''),
        publication.initial_generation::text,publication.mapping_sha256])
      or publication.record_commitment_sha256 is distinct from publication.verification_commitment_sha256
      or publication.seal_sha256 is distinct from catalogue_frame_sha256_v2('publication-seal',array[
        publication.publication_sha256,publication.record_commitment_sha256,publication.next_sequence::text,
        publication.materialized_count::text,publication.materialization_bytes::text,publication.page_count::text,
        publication.verified_page_count::text])
      or publication.finish_request_document is null or publication.activation_request_document is null
      or publication.finish_receipt is distinct from catalogue_publication_receipt_v2(
        publication.finish_receipt-array['receiptDocument','receiptSha256'])
      or publication.activation_receipt is distinct from catalogue_publication_receipt_v2(
        publication.activation_receipt-array['receiptDocument','receiptSha256'])
      or publication.finish_receipt->>'operation' is distinct from 'finish'
      or publication.activation_receipt->>'operation' is distinct from 'activate'
      or publication.finish_receipt->>'requestSha256' is distinct from encode(sha256(convert_to(publication.finish_request_document,'UTF8')),'hex')
      or publication.activation_receipt->>'requestSha256' is distinct from encode(sha256(convert_to(publication.activation_request_document,'UTF8')),'hex')
      or publication.finish_receipt->>'sealSha256' is distinct from publication.seal_sha256
      or publication.activation_receipt->>'sealSha256' is distinct from publication.seal_sha256
      or publication.activation_receipt->>'receiptSha256' is distinct from publication.last_receipt_sha256
      or not exists(select 1 from food_source_release_activation a where a.import_batch_id=baseline.id
        and a.food_source_id=baseline.food_source_id and a.release_id=release_row.id and a.operation='activate'
        and a.database_principal=publication.publisher_principal and a.database_capability_role='nutrition_catalogue_promote_activate'
        and a.previous_release_id is not distinct from publication.baseline_release_id
        and a.id::text=publication.activation_receipt->>'activationId') then
      raise exception 'V2 baseline publication seal, receipt or activation authority differs' using errcode='55000';
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
      raise exception 'V2 baseline release provenance differs from immutable staged batch' using errcode='55000';
    end if;
    mappings:=publication.mapping_document;
    if jsonb_typeof(mappings) is distinct from 'array' or jsonb_array_length(mappings)>10000
      or octet_length(mappings::text)>4194304
      or substring(baseline.parser_version,'[+]mapping[.]([0-9a-f]{64})$') is distinct from publication.mapping_sha256
      or parser.report->>'nutrientMappingDigest' is distinct from publication.mapping_sha256 then
      raise exception 'V2 baseline historical mapping registry differs or exceeds its bound' using errcode='55000';
    end if;
    expected_summary:=jsonb_build_object('publicationProtocolVersion',2,'batchId',baseline.id,
      'publicationSha256',publication.publication_sha256,'contextSha256',publication.context_sha256,
      'validationTerminalSha256',publication.validation_terminal_sha256,'reportSha256',publication.report_sha256,
      'nutrientMappingDigest',publication.mapping_sha256,'nutrientMappingRevisionIds',
        (select coalesce(jsonb_agg(m->>'revisionId' order by (m->>'revisionId') collate "C"),'[]'::jsonb) from jsonb_array_elements(mappings) m),
      'parserReportSha256',parser.report_sha256,'validatedFoodContractVersion',1);
    expected_counts:=jsonb_build_object('staged',preparation.staged_count::text,'materializable',validation.valid_count::text,
      'quarantined',validation.quarantined_count::text,'nutrientInput',validation.nutrient_input_count::text,
      'nutrientMaterializable',validation.nutrient_materializable_count::text,'nutrientExcluded',validation.excluded_nutrient_count::text,
      'sourceRecords',parser.source_record_count::text,'sourcePortions',parser.source_portion_count::text,
      'parserExcludedRecords',parser.excluded_record_count::text);
    if release_row.validation_summary is distinct from expected_summary or release_row.record_counts is distinct from expected_counts then
      raise exception 'V2 baseline release summary differs from publication evidence' using errcode='55000';
    end if;
    select coalesce(jsonb_agg(to_jsonb(a) order by a.approval_role),'[]'::jsonb) into approvals
      from catalogue_paged_approval_v2 a where a.batch_id=baseline.id;
    if jsonb_array_length(approvals)<>3
      or (select count(distinct approval_role) from catalogue_paged_approval_v2 where batch_id=baseline.id)<>3
      or (select count(distinct database_principal) from catalogue_paged_approval_v2 where batch_id=baseline.id)<>3
      or exists(select 1 from catalogue_paged_approval_v2 a where a.batch_id=baseline.id
        and (a.database_principal=validation.validator_principal or a.database_principal=publication.publisher_principal
          or a.database_principal=baseline.staged_database_principal or a.validation_terminal_sha256<>publication.validation_terminal_sha256
          or a.context_sha256<>reconciliation.context_sha256 or a.report_sha256<>publication.report_sha256
          or a.rights_manifest_sha256<>baseline.rights_manifest_sha256)) then
      raise exception 'V2 baseline reviewer evidence differs from completed reconciliation' using errcode='55000';
    end if;
    result:=jsonb_build_object('schemaVersion',2,'batch',to_jsonb(baseline),'release',to_jsonb(release_row),
      'parser',to_jsonb(parser),'preparation',to_jsonb(preparation),'validation',to_jsonb(validation),
      'publication',to_jsonb(publication),'mappings',mappings,'approvals',approvals,'sourceCode','USDA_FDC');
    if octet_length(result::text)>16777216 then
      raise exception 'V2 baseline header exceeds bounded evidence limit' using errcode='54000';
    end if;
    return result;
  end if;
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

create or replace function catalogue_reconciliation_baseline_record_v2(p_record_id bigint,p_release_id uuid)
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
  publication catalogue_publication_v2%rowtype;
  envelope jsonb;
begin
  select * into strict record_row from food_import_record where id=p_record_id;
  select * into strict batch_row from food_import_batch where id=record_row.batch_id;

  select * into publication from catalogue_publication_v2 where batch_id=record_row.batch_id and release_id=p_release_id;
  if found then
    if publication.phase<>'activated' or publication.seal_sha256 is null or publication.activated_at is null
      or not exists(select 1 from food_source s where s.id=batch_row.food_source_id and s.active_release_id=p_release_id) then
      raise exception 'V2 baseline publication is not the active attested source release' using errcode='55000';
    end if;
    envelope:=catalogue_verify_publication_record_v2(record_row.batch_id,record_row.sequence_number);
    if envelope->>'validationStatus'='valid' then
      food_document:=(envelope->>'validatedFoodDocument')::jsonb;
      if not exists(select 1 from food f where f.id=(envelope->>'foodId')::bigint
        and f.current_version_id=(envelope->>'foodVersionId')::bigint and f.archived_at is null) then
        raise exception 'V2 baseline current food pointer differs from immutable publication' using errcode='55000';
      end if;
      select count(*) into barcode_count from food_barcode where food_version_id=(envelope->>'foodVersionId')::bigint and valid_to is null;
      if barcode_count<>(case when food_document->>'gtin' is null then 0 else 1 end)
        or exists(select 1 from food_barcode b where b.food_version_id=(envelope->>'foodVersionId')::bigint and b.valid_to is null
          and (b.food_id is distinct from (envelope->>'foodId')::bigint or b.gtin is distinct from food_document->>'gtin'
            or b.market_code is distinct from food_document->>'marketCode' or b.source_release_id is distinct from p_release_id)) then
        raise exception 'V2 baseline live barcode assignment differs from immutable publication' using errcode='55000';
      end if;
    end if;
    return envelope-array['nutritionSemanticSha256','foodId','foodVersionId','materializationSha256'];
  end if;
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

create or replace function catalogue_prepare_reconciliation_page_v2(p_batch_id uuid,p_context text,p_page bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  actor text;
  state catalogue_reconciliation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  baseline_batch food_import_batch%rowtype;
  baseline_is_v2 boolean:=false;
  baseline_validation catalogue_validation_context_v2%rowtype;
  baseline_record catalogue_validation_record_v2%rowtype;
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
      baseline_is_v2:=exists(select 1 from catalogue_publication_v2 where batch_id=state.baseline_batch_id and release_id=state.baseline_release_id and phase='activated');
      if baseline_is_v2 then
        select * into strict baseline_validation from catalogue_validation_context_v2 where batch_id=state.baseline_batch_id;
      end if;
      for source_row in select * from food_import_record where batch_id=state.baseline_batch_id
        and sequence_number >= start_sequence order by sequence_number limit 250 loop
        before_envelope := catalogue_reconciliation_baseline_record_v2(source_row.id,state.baseline_release_id);
        item := pg_catalog.jsonb_build_object('change','baseline','sourceRecordKey',source_row.source_record_key,
          'before',before_envelope,'after',null,'detail',catalogue_reconciliation_detail_v2((before_envelope->>'validatedFoodDocument')::jsonb,null));
        if page_bytes + pg_catalog.octet_length(item::text) > 16776000 then
          if consumed=0 then raise exception 'one baseline report record exceeds page budget' using errcode='54000'; end if;
          exit;
        end if;
        if source_row.sequence_number <> end_sequence then raise exception 'baseline sequence has a gap' using errcode='55000'; end if;
        state.baseline_records := state.baseline_records+1;
        if baseline_is_v2 then
          select * into strict baseline_record from catalogue_validation_record_v2
            where batch_id=state.baseline_batch_id and sequence_number=source_row.sequence_number;
          semantic_counts:=jsonb_build_object('nutrientInputCount',baseline_record.nutrient_input_count,
            'excludedNutrientCount',baseline_record.excluded_nutrient_count,
            'nutrientMaterializableCount',baseline_record.nutrient_materializable_count);
        else
          semantic_counts:=catalogue_compute_record_nutrition_semantics(source_row.id);
        end if;
        state.baseline_nutrient_count:=state.baseline_nutrient_count+(semantic_counts->>'nutrientInputCount')::bigint;
        state.baseline_portion_count:=state.baseline_portion_count+case when pg_catalog.jsonb_typeof(source_row.canonical_payload->'servings')='array'
          then pg_catalog.jsonb_array_length(source_row.canonical_payload->'servings') else 0 end;
        state.baseline_excluded_nutrients:=state.baseline_excluded_nutrients+(semantic_counts->>'excludedNutrientCount')::bigint;
        state.baseline_warning_count:=state.baseline_warning_count+(select count(*) from pg_catalog.jsonb_array_elements(before_envelope->'validationIssues') i where i->>'severity'='warning');
        state.baseline_error_count:=state.baseline_error_count+(select count(*) from pg_catalog.jsonb_array_elements(before_envelope->'validationIssues') i where i->>'severity'='error');
        state.baseline_payload_bytes := state.baseline_payload_bytes+pg_catalog.octet_length(source_row.canonical_payload::text);
        if state.baseline_records > admission.max_baseline_records or state.baseline_payload_bytes > admission.max_baseline_payload_bytes then
          raise exception 'baseline exceeds immutable reconciliation admission' using errcode='54000';
        end if;
        if before_envelope->>'validationStatus' in ('materialized','valid') then
          state.baseline_valid_count:=state.baseline_valid_count+1;
          state.baseline_materializable_nutrients:=state.baseline_materializable_nutrients+(semantic_counts->>'nutrientMaterializableCount')::bigint;
          food_document := (before_envelope->>'validatedFoodDocument')::jsonb;
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
        if baseline_is_v2 then
          if state.baseline_records<>baseline_batch.staged_count or state.baseline_records<>parser_row.emitted_record_count
            or state.baseline_records<>baseline_validation.next_sequence
            or state.baseline_valid_count<>baseline_validation.valid_count
            or state.baseline_quarantined_count<>baseline_validation.quarantined_count
            or state.baseline_nutrient_count<>parser_row.emitted_nutrient_count
            or state.baseline_nutrient_count<>baseline_validation.nutrient_input_count
            or state.baseline_portion_count<>parser_row.emitted_portion_count
            or state.baseline_portion_count<>baseline_validation.portion_input_count
            or state.baseline_materializable_nutrients<>baseline_validation.nutrient_materializable_count
            or state.baseline_excluded_nutrients<>baseline_validation.excluded_nutrient_count
            or state.baseline_warning_count<>baseline_validation.warning_count
            or state.baseline_error_count<>baseline_validation.record_error_count then
            raise exception 'V2 baseline complete pages differ from retained validation evidence' using errcode='55000';
          end if;
        elsif state.baseline_records<>baseline_batch.staged_count or state.baseline_records<>parser_row.emitted_record_count
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

create or replace function catalogue_reject_legacy_release_v2(p_release_id uuid)
returns void language plpgsql stable security definer as $$
begin
  if p_release_id is not null and (exists(
    select 1 from food_import_batch b join catalogue_preparation_v2 p on p.batch_id=b.id
    where b.release_id=p_release_id
  ) or exists(select 1 from catalogue_publication_v2 where release_id=p_release_id)) then
    raise exception 'V2 preparation cannot be a legacy release or rollback target' using errcode='55000';
  end if;
end;
$$;

-- Lock the source before checking its current protocol; a concurrent activation
-- cannot turn a checked V1 source into V2 before a legacy rollback acquires it.
do $legacy_rollback$
declare
  schema_name text:=current_schema(); workflow_owner oid; expected record; target oid;
  definition text; source text; new_source text; begin_position integer;
  prelude text:=E'  perform 1 from food_source where code=p_source_code for update;\n'
    || E'  if exists(select 1 from food_source s join catalogue_publication_v2 p on p.release_id=s.active_release_id where s.code=p_source_code) then\n'
    || E'    raise exception ''V2 current release requires versioned rollback'' using errcode=''55000'';\n'
    || E'  end if;\n';
begin
  select relowner into strict workflow_owner from pg_class where oid='food_import_batch'::regclass;
  for expected in select * from (values
    ('catalogue_rollback_source_release(text,uuid,text,text)','8946f31585a418f750601e35621b06ac938a8c466f26fddc1a123cd6c2df4ffd'),
    ('catalogue_rollback_source_release_v1(text,uuid,text,text)','a2cf554f00f20d13720e268e3778eca9e26064da34291befa9b75f3dbe55b915')
  ) predecessor(identity,source_sha256) loop
    target:=to_regprocedure(format('%I.%s',schema_name,expected.identity));
    select p.prosrc,pg_get_functiondef(p.oid) into source,definition from pg_proc p
      join pg_language l on l.oid=p.prolang where p.oid=target and p.proowner=workflow_owner
        and p.prosecdef and l.lanname='plpgsql';
    if not found or encode(sha256(convert_to(source,'UTF8')),'hex')<>expected.source_sha256 then
      raise exception 'legacy rollback body differs before current V2 fence: %',expected.identity using errcode='55000';
    end if;
    begin_position:=strpos(source,E'\nbegin\n');
    if begin_position=0 or strpos(definition,source)=0 then
      raise exception 'legacy rollback entry differs before current V2 fence' using errcode='55000';
    end if;
    new_source:=overlay(source placing prelude from begin_position+length(E'\nbegin\n') for 0);
    definition:=overlay(definition placing new_source from strpos(definition,source) for length(source));
    execute definition;
    if (select prosrc from pg_proc where oid=target) is distinct from new_source then
      raise exception 'legacy current V2 fence postflight differs' using errcode='55000';
    end if;
  end loop;
end;
$legacy_rollback$;

-- CREATE OR REPLACE retains original owners and ACLs. Re-pin paths for the actual
-- migration schema, including isolated integration schemas, and prove ownership.
do $authority$
declare schema_name text:=current_schema(); workflow_owner oid; item record;
begin
  select relowner into strict workflow_owner from pg_class where oid='food_import_batch'::regclass;
  for item in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=schema_name and p.proname=any(array[
      'catalogue_reconciliation_baseline_header_v2','catalogue_reconciliation_baseline_record_v2',
      'catalogue_prepare_reconciliation_page_v2','catalogue_reject_legacy_release_v2',
      'catalogue_rollback_source_release','catalogue_rollback_source_release_v1']) loop
    if item.proowner<>workflow_owner then
      raise exception 'publication consumer function owner mismatch' using errcode='42501';
    end if;
    execute format('alter function %s set search_path=pg_catalog,%I,pg_temp',item.oid::regprocedure,schema_name);
  end loop;
end;
$authority$;
