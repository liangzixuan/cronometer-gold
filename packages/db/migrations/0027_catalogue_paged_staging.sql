-- Versioned preparation only. Legacy validation/materialization evidence is not
-- populated by this protocol. Budgets are explicit reviewer admissions.
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('nutrition-tracker:catalogue-paged-staging:v2'));

do $migration$
begin
  if current_user::text is distinct from (
    select pg_catalog.pg_get_userbyid(relowner) from pg_catalog.pg_class
    where oid = 'food_import_batch'::pg_catalog.regclass
  ) then
    raise exception 'paged preparation migration requires the workflow owner' using errcode = '42501';
  end if;
end;
$migration$;

create function catalogue_frame_sha256_v2(p_domain text, p_fields text[])
returns text language plpgsql immutable as $$
declare
  field_value text;
  framed bytea := ''::bytea;
  encoded bytea;
begin
  if p_domain is null or p_domain !~ '^[a-z][a-z0-9-]{0,63}$'
    or p_fields is null or coalesce(pg_catalog.array_ndims(p_fields), 1) <> 1
    or pg_catalog.cardinality(p_fields) > 64 then
    raise exception 'invalid preparation hash frame' using errcode = '22023';
  end if;
  foreach field_value in array array['nourishing:catalogue-preparation:v2', p_domain] || p_fields loop
    if field_value is null then
      raise exception 'preparation hash frame has a null field' using errcode = '22023';
    end if;
    encoded := pg_catalog.convert_to(field_value, 'UTF8');
    if pg_catalog.octet_length(framed)::bigint + pg_catalog.octet_length(encoded)::bigint +
        pg_catalog.length(pg_catalog.octet_length(encoded)::text) + 1 > 17825792 then
      raise exception 'preparation hash frame exceeds its byte limit' using errcode = '54000';
    end if;
    framed := framed || pg_catalog.convert_to(pg_catalog.octet_length(encoded)::text || ':', 'UTF8') || encoded;
  end loop;
  return pg_catalog.encode(pg_catalog.sha256(framed), 'hex');
end;
$$;

create function catalogue_require_preparation_role_v2(p_role text)
returns text language plpgsql stable as $$
declare
  workflow_owner oid;
  capabilities text[];
begin
  select relowner into workflow_owner from pg_catalog.pg_class
  where oid = 'food_import_batch'::pg_catalog.regclass;
  -- pg_roles deliberately excludes password material.
  if current_user::text is distinct from pg_catalog.pg_get_userbyid(workflow_owner)
    or pg_catalog.current_setting('role') <> 'none'
    or not exists (
      select 1 from pg_catalog.pg_roles r where r.rolname = session_user
        and r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
        and not r.rolreplication and not r.rolbypassrls
    ) or pg_catalog.pg_has_role(session_user, workflow_owner, 'member') then
    raise exception 'preparation requires an actual restricted non-owner login' using errcode = '42501';
  end if;
  select pg_catalog.array_agg(role_name order by role_name) into capabilities
  from pg_catalog.unnest(array[
    'nutrition_catalogue_stage', 'nutrition_catalogue_validate',
    'nutrition_catalogue_approve_data', 'nutrition_catalogue_approve_quality',
    'nutrition_catalogue_approve_rights', 'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ]) names(role_name) where pg_catalog.pg_has_role(session_user, role_name, 'member');
  if p_role is null or pg_catalog.cardinality(capabilities) is distinct from 1
    or capabilities[1] is distinct from p_role then
    raise exception 'preparation requires exactly the requested capability' using errcode = '42501';
  end if;
  return session_user::text;
end;
$$;

create function catalogue_preparation_uint_v2(p_value jsonb)
returns bigint language plpgsql immutable as $$
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string'
    or p_value #>> '{}' !~ '^(0|[1-9][0-9]{0,18})$'
    or (p_value #>> '{}')::numeric > 9223372036854775807 then
    raise exception 'preparation integer must be an exact unsigned decimal string' using errcode = '22023';
  end if;
  return (p_value #>> '{}')::bigint;
end;
$$;

create table catalogue_preparation_admission_v2 (
  admission_sha256 text primary key check (admission_sha256 ~ '^[0-9a-f]{64}$'),
  request_document text not null check (pg_catalog.octet_length(request_document) between 1 and 131072),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  stage_document text not null check (pg_catalog.octet_length(stage_document) between 1 and 65536),
  stage_document_sha256 text not null check (stage_document_sha256 ~ '^[0-9a-f]{64}$'),
  source_code text not null,
  release_key text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  export_sha256 text not null check (export_sha256 ~ '^[0-9a-f]{64}$'),
  export_bytes bigint not null check (export_bytes > 0),
  parser_version text not null,
  stage_principal text not null check (pg_catalog.octet_length(stage_principal) between 1 and 63),
  admitted_by text not null check (pg_catalog.octet_length(admitted_by) between 1 and 63),
  max_records bigint not null check (max_records > 0),
  max_payload_text_bytes bigint not null check (max_payload_text_bytes > 0),
  max_intermediate_bytes bigint not null check (max_intermediate_bytes > 0),
  max_validation_evidence_bytes bigint not null check (max_validation_evidence_bytes > 0),
  max_reconciliation_evidence_bytes bigint not null check (max_reconciliation_evidence_bytes > 0),
  max_baseline_records bigint not null check (max_baseline_records >= 0),
  max_baseline_payload_bytes bigint not null check (max_baseline_payload_bytes >= 0),
  receipt jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (source_code, release_key, artifact_sha256),
  check (stage_principal <> admitted_by)
);

create table catalogue_preparation_budget_usage_v2 (
  admission_sha256 text primary key references catalogue_preparation_admission_v2(admission_sha256),
  intermediate_bytes bigint not null default 0 check (intermediate_bytes >= 0),
  validation_evidence_bytes bigint not null default 0 check (validation_evidence_bytes >= 0),
  reconciliation_evidence_bytes bigint not null default 0 check (reconciliation_evidence_bytes >= 0)
);

create table catalogue_preparation_v2 (
  batch_id uuid primary key references food_import_batch(id) on delete restrict,
  admission_sha256 text not null unique references catalogue_preparation_admission_v2(admission_sha256),
  protocol_version smallint not null default 2 check (protocol_version = 2),
  phase text not null default 'staging' check (phase in ('staging', 'sealing', 'sealed')),
  staged_count bigint not null default 0 check (staged_count >= 0),
  payload_text_bytes bigint not null default 0 check (payload_text_bytes >= 0),
  stage_page_count bigint not null default 0 check (stage_page_count >= 0),
  stage_commitment_sha256 text not null check (stage_commitment_sha256 ~ '^[0-9a-f]{64}$'),
  last_page_receipt_sha256 text check (last_page_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  seal_request_document text,
  seal_request_sha256 text check (seal_request_sha256 ~ '^[0-9a-f]{64}$'),
  seal_begin_receipt jsonb,
  seal_verified_page_count bigint not null default 0 check (seal_verified_page_count >= 0),
  seal_verified_record_count bigint not null default 0 check (seal_verified_record_count >= 0),
  seal_verified_payload_text_bytes bigint not null default 0 check (seal_verified_payload_text_bytes >= 0),
  seal_verified_intermediate_bytes bigint not null default 0 check (seal_verified_intermediate_bytes >= 0),
  seal_record_commitment_sha256 text not null check (seal_record_commitment_sha256 ~ '^[0-9a-f]{64}$'),
  seal_page_receipt_sha256 text check (seal_page_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  staging_seal_sha256 text check (staging_seal_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz,
  terminal_document text,
  terminal_receipt jsonb,
  check ((phase = 'staging') = (seal_request_document is null)),
  check ((phase = 'sealed') = (staging_seal_sha256 is not null)),
  check ((phase = 'sealed') = (sealed_at is not null)),
  check ((phase = 'sealed') = (terminal_document is not null)),
  check ((phase = 'sealed') = (terminal_receipt is not null))
);

create table catalogue_preparation_record_v2 (
  batch_id uuid not null,
  sequence_number bigint not null,
  canonical_payload_document text not null check (pg_catalog.octet_length(canonical_payload_document) between 1 and 1048576),
  payload_text_bytes bigint not null check (payload_text_bytes between 1 and 2097152),
  record_sha256 text not null check (record_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (batch_id, sequence_number),
  foreign key (batch_id, sequence_number) references food_import_record(batch_id, sequence_number) on delete restrict,
  foreign key (batch_id) references catalogue_preparation_v2(batch_id) on delete restrict
);

create table catalogue_preparation_stage_page_v2 (
  batch_id uuid not null references catalogue_preparation_v2(batch_id) on delete restrict,
  page_number bigint not null check (page_number >= 0),
  first_sequence bigint not null check (first_sequence >= 0),
  next_sequence bigint not null,
  record_count bigint not null check (record_count between 1 and 250),
  payload_text_bytes bigint not null check (payload_text_bytes > 0),
  total_payload_text_bytes bigint not null check (total_payload_text_bytes >= payload_text_bytes),
  request_document text not null check (pg_catalog.octet_length(request_document) between 1 and 16777216),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  previous_receipt_sha256 text check (previous_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  record_commitment_sha256 text not null check (record_commitment_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256 text not null check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  primary key (batch_id, page_number),
  unique (batch_id, first_sequence),
  check (next_sequence = first_sequence + record_count)
);

create table catalogue_preparation_seal_page_v2 (
  batch_id uuid not null references catalogue_preparation_v2(batch_id) on delete restrict,
  page_number bigint not null check (page_number >= 0),
  receipt jsonb not null,
  primary key (batch_id, page_number)
);

create function catalogue_charge_preparation_budget_v2(
  p_batch_id uuid, p_intermediate_delta bigint, p_validation_delta bigint, p_reconciliation_delta bigint
)
returns void language plpgsql as $$
declare
  admission catalogue_preparation_admission_v2%rowtype;
  usage catalogue_preparation_budget_usage_v2%rowtype;
begin
  if p_intermediate_delta is null or p_validation_delta is null or p_reconciliation_delta is null
    or p_intermediate_delta < 0 or p_validation_delta < 0 or p_reconciliation_delta < 0 then
    raise exception 'preparation budget charges cannot be absent or negative' using errcode = '22023';
  end if;
  select a.* into admission from catalogue_preparation_admission_v2 a
  join catalogue_preparation_v2 p on p.admission_sha256 = a.admission_sha256 where p.batch_id = p_batch_id;
  if not found then
    raise exception 'preparation admission is absent' using errcode = '55000';
  end if;
  select * into usage from catalogue_preparation_budget_usage_v2
  where admission_sha256 = admission.admission_sha256 for update;
  if not found or p_intermediate_delta > admission.max_intermediate_bytes - usage.intermediate_bytes
    or p_validation_delta > admission.max_validation_evidence_bytes - usage.validation_evidence_bytes
    or p_reconciliation_delta > admission.max_reconciliation_evidence_bytes - usage.reconciliation_evidence_bytes then
    raise exception 'preparation exhausted its immutable admission budget' using errcode = '54000';
  end if;
  update catalogue_preparation_budget_usage_v2 set
    intermediate_bytes = intermediate_bytes + p_intermediate_delta,
    validation_evidence_bytes = validation_evidence_bytes + p_validation_delta,
    reconciliation_evidence_bytes = reconciliation_evidence_bytes + p_reconciliation_delta
  where admission_sha256 = admission.admission_sha256;
end;
$$;

-- This charge is a conservative serialized-state allowance, including duplicated
-- exact text and fixed row/index allowances. It is not a claim about physical
-- heap/TOAST/WAL or container capacity; qualification must measure those too.
comment on column catalogue_preparation_budget_usage_v2.intermediate_bytes is
  'Monotonic conservative serialized-state charge; physical storage/resource qualification remains separately required.';

create function catalogue_guard_preparation_v2()
returns trigger language plpgsql as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  capability text;
begin
  if tg_op = 'DELETE' then
    raise exception 'preparation evidence and budget lineage cannot be deleted' using errcode = '55000';
  end if;
  if tg_table_name = 'catalogue_preparation_budget_usage_v2' then
    select role_name into capability from pg_catalog.unnest(array['nutrition_catalogue_stage','nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data','nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights']) roles(role_name)
    where pg_catalog.pg_has_role(session_user,role_name,'member') order by role_name limit 1;
    perform catalogue_require_preparation_role_v2(capability);
    if tg_op = 'UPDATE' and (new.admission_sha256 <> old.admission_sha256
      or new.intermediate_bytes < old.intermediate_bytes
      or new.validation_evidence_bytes < old.validation_evidence_bytes
      or new.reconciliation_evidence_bytes < old.reconciliation_evidence_bytes) then
      raise exception 'preparation budget lineage and charges cannot be reset' using errcode = '55000';
    end if;
    select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = new.admission_sha256;
    if not found or new.intermediate_bytes > admission.max_intermediate_bytes
      or new.validation_evidence_bytes > admission.max_validation_evidence_bytes
      or new.reconciliation_evidence_bytes > admission.max_reconciliation_evidence_bytes then
      raise exception 'preparation counters exceed accepted admission' using errcode = '54000';
    end if;
    return new;
  end if;
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  select * into admission from catalogue_preparation_admission_v2
    where admission_sha256 = new.admission_sha256;
  if not found or admission.stage_principal <> session_user::text then
    raise exception 'preparation belongs to another staging principal' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.phase <> 'staging' or new.staged_count <> 0 or new.payload_text_bytes <> 0
      or new.stage_page_count <> 0 or new.seal_verified_page_count <> 0
      or new.seal_verified_record_count <> 0 or new.seal_verified_payload_text_bytes <> 0
      or new.seal_verified_intermediate_bytes <> 0 then
      raise exception 'preparation must begin empty' using errcode = '23514';
    end if;
    return new;
  end if;
  if row(new.batch_id, new.admission_sha256, new.protocol_version)
    is distinct from row(old.batch_id, old.admission_sha256, old.protocol_version)
    or old.phase = 'sealed'
    or (old.phase <> new.phase and not (
      (old.phase = 'staging' and new.phase = 'sealing') or
      (old.phase = 'sealing' and new.phase = 'sealed')
    )) or new.staged_count < old.staged_count or new.payload_text_bytes < old.payload_text_bytes
    or new.stage_page_count < old.stage_page_count
    or new.seal_verified_page_count < old.seal_verified_page_count
    or new.seal_verified_record_count < old.seal_verified_record_count
    or new.seal_verified_payload_text_bytes < old.seal_verified_payload_text_bytes
    or new.seal_verified_intermediate_bytes < old.seal_verified_intermediate_bytes then
    raise exception 'preparation identity, phase or progress cannot be rewritten' using errcode = '55000';
  end if;
  if old.phase <> 'staging' and row(new.staged_count,new.payload_text_bytes,new.stage_page_count,
      new.stage_commitment_sha256,new.last_page_receipt_sha256,new.seal_request_document,new.seal_request_sha256,new.seal_begin_receipt)
    is distinct from row(old.staged_count,old.payload_text_bytes,old.stage_page_count,
      old.stage_commitment_sha256,old.last_page_receipt_sha256,old.seal_request_document,old.seal_request_sha256,old.seal_begin_receipt) then
    raise exception 'sealed source preparation cannot change' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger catalogue_preparation_guard_v2 before insert or update or delete on catalogue_preparation_v2
for each row execute function catalogue_guard_preparation_v2();
create trigger catalogue_preparation_budget_guard_v2 before update or delete on catalogue_preparation_budget_usage_v2
for each row execute function catalogue_guard_preparation_v2();

create function catalogue_guard_preparation_evidence_insert_v2()
returns trigger language plpgsql as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  intended_principal text;
begin
  if tg_table_name in ('catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2') then
    perform catalogue_require_preparation_role_v2('nutrition_catalogue_approve_quality');
    if tg_table_name = 'catalogue_preparation_admission_v2' then
      if new.admitted_by is distinct from session_user::text then
        raise exception 'admission must bind its authenticated reviewer' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  select * into preparation from catalogue_preparation_v2 where batch_id = new.batch_id for update;
  if not found then raise exception 'preparation is absent' using errcode = '23503'; end if;
  select stage_principal into intended_principal from catalogue_preparation_admission_v2
  where admission_sha256 = preparation.admission_sha256;
  if intended_principal is distinct from session_user::text or preparation.phase is distinct from
    (case when tg_table_name = 'catalogue_preparation_seal_page_v2' then 'sealing' else 'staging' end) then
    raise exception 'preparation evidence insert has wrong phase or principal' using errcode = '55000';
  end if;
  return new;
end;
$$;

create function catalogue_guard_preparation_source_insert_v2()
returns trigger language plpgsql as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  intended_principal text;
begin
  select * into preparation from catalogue_preparation_v2 where batch_id = new.batch_id for update;
  if not found then return new; end if;
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  select stage_principal into intended_principal from catalogue_preparation_admission_v2
  where admission_sha256 = preparation.admission_sha256;
  if preparation.phase <> 'staging' or intended_principal <> session_user::text then
    raise exception 'preparation source content is frozen or belongs to another principal' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger food_import_record_preparation_phase_v2 before insert on food_import_record
for each row execute function catalogue_guard_preparation_source_insert_v2();

create function catalogue_admit_preparation_v2(p_document text)
returns jsonb language plpgsql security definer as $$
declare
  document jsonb;
  stage jsonb;
  actor text;
  request_sha text;
  admission_sha text;
  receipt_value jsonb;
  existing catalogue_preparation_admission_v2%rowtype;
  initial_charge bigint;
  field_name text;
begin
  actor := catalogue_require_preparation_role_v2('nutrition_catalogue_approve_quality');
  if p_document is null or pg_catalog.octet_length(p_document) not between 1 and 131072 then
    raise exception 'admission document exceeds its bound' using errcode = '22023';
  end if;
  document := p_document::jsonb;
  if pg_catalog.jsonb_typeof(document) <> 'object' or document -> 'schemaVersion' is distinct from '2'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(document)) <> 14
    or document - array['schemaVersion','stageDocument','manifestSha256','exportSha256','exportBytes','stagePrincipal',
      'maxRecords','maxPayloadTextBytes','maxIntermediateBytes','maxValidationEvidenceBytes','maxReconciliationEvidenceBytes',
      'maxBaselineRecords','maxBaselinePayloadBytes','reviewReference'] <> '{}'::jsonb then
    raise exception 'admission contract differs from preparation version 2' using errcode = '22023';
  end if;
  foreach field_name in array array['stageDocument','manifestSha256','exportSha256','stagePrincipal','reviewReference'] loop
    if pg_catalog.jsonb_typeof(document -> field_name) is distinct from 'string' then
      raise exception 'admission text field is invalid' using errcode = '22023';
    end if;
  end loop;
  if pg_catalog.octet_length(document ->> 'stageDocument') not between 1 and 65536
    or document ->> 'manifestSha256' !~ '^[0-9a-f]{64}$' or document ->> 'exportSha256' !~ '^[0-9a-f]{64}$'
    or pg_catalog.octet_length(document ->> 'stagePrincipal') not between 1 and 63
    or document ->> 'stagePrincipal' = actor or pg_catalog.octet_length(document ->> 'reviewReference') not between 1 and 2048 then
    raise exception 'admission identity is invalid or unbounded' using errcode = '22023';
  end if;
  stage := (document ->> 'stageDocument')::jsonb;
  if pg_catalog.jsonb_typeof(stage) <> 'object' or stage -> 'schemaVersion' is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(stage -> 'sourceCode') is distinct from 'string'
    or pg_catalog.jsonb_typeof(stage -> 'releaseKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(stage -> 'artifactSha256') is distinct from 'string'
    or pg_catalog.jsonb_typeof(stage -> 'parserVersion') is distinct from 'string'
    or pg_catalog.octet_length(stage ->> 'sourceCode') not between 1 and 256
    or pg_catalog.octet_length(stage ->> 'releaseKey') not between 1 and 512
    or stage ->> 'artifactSha256' !~ '^[0-9a-f]{64}$'
    or pg_catalog.octet_length(stage ->> 'parserVersion') not between 1 and 512 then
    raise exception 'admission stage provenance is invalid' using errcode = '22023';
  end if;
  foreach field_name in array array['exportBytes','maxRecords','maxPayloadTextBytes','maxIntermediateBytes',
    'maxValidationEvidenceBytes','maxReconciliationEvidenceBytes'] loop
    if catalogue_preparation_uint_v2(document -> field_name) = 0 then
      raise exception 'admission budgets must be explicit and positive' using errcode = '22023';
    end if;
  end loop;
  perform catalogue_preparation_uint_v2(document -> 'maxBaselineRecords');
  perform catalogue_preparation_uint_v2(document -> 'maxBaselinePayloadBytes');
  request_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_document,'UTF8')),'hex');
  admission_sha := catalogue_frame_sha256_v2('admission',array[request_sha,actor]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('catalogue-admission-v2'),
    pg_catalog.hashtext((stage ->> 'sourceCode') || ':' || (stage ->> 'releaseKey') || ':' || (stage ->> 'artifactSha256')));
  select * into existing from catalogue_preparation_admission_v2 where source_code = stage ->> 'sourceCode'
    and release_key = stage ->> 'releaseKey' and artifact_sha256 = stage ->> 'artifactSha256';
  if found then
    if existing.admission_sha256 <> admission_sha or existing.request_document <> p_document then
      raise exception 'admission lineage already exists; changed budget or identity needs adjudication' using errcode = '55000';
    end if;
    return existing.receipt;
  end if;
  receipt_value := pg_catalog.jsonb_build_object('schemaVersion',2,'admissionSha256',admission_sha,
    'requestSha256',request_sha,'admittedBy',actor);
  initial_charge := 32768 + 2 * (pg_catalog.octet_length(p_document)::bigint +
    pg_catalog.octet_length(document ->> 'stageDocument')::bigint);
  if initial_charge > catalogue_preparation_uint_v2(document -> 'maxIntermediateBytes') then
    raise exception 'admission cannot cover its own retained evidence' using errcode = '54000';
  end if;
  insert into catalogue_preparation_admission_v2(admission_sha256,request_document,request_sha256,
    stage_document,stage_document_sha256,source_code,release_key,artifact_sha256,manifest_sha256,
    export_sha256,export_bytes,parser_version,stage_principal,admitted_by,max_records,max_payload_text_bytes,
    max_intermediate_bytes,max_validation_evidence_bytes,max_reconciliation_evidence_bytes,max_baseline_records,
    max_baseline_payload_bytes,receipt)
  values(admission_sha,p_document,request_sha,document ->> 'stageDocument',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(document ->> 'stageDocument','UTF8')),'hex'),
    stage ->> 'sourceCode',stage ->> 'releaseKey',stage ->> 'artifactSha256',document ->> 'manifestSha256',
    document ->> 'exportSha256',catalogue_preparation_uint_v2(document -> 'exportBytes'),stage ->> 'parserVersion',
    document ->> 'stagePrincipal',actor,catalogue_preparation_uint_v2(document -> 'maxRecords'),
    catalogue_preparation_uint_v2(document -> 'maxPayloadTextBytes'),catalogue_preparation_uint_v2(document -> 'maxIntermediateBytes'),
    catalogue_preparation_uint_v2(document -> 'maxValidationEvidenceBytes'),catalogue_preparation_uint_v2(document -> 'maxReconciliationEvidenceBytes'),
    catalogue_preparation_uint_v2(document -> 'maxBaselineRecords'),catalogue_preparation_uint_v2(document -> 'maxBaselinePayloadBytes'),receipt_value);
  insert into catalogue_preparation_budget_usage_v2(admission_sha256,intermediate_bytes) values(admission_sha,initial_charge);
  return receipt_value;
end;
$$;

create function catalogue_read_preparation_admission_v2(p_admission_sha256 text)
returns jsonb language plpgsql security definer as $$
declare
  admission catalogue_preparation_admission_v2%rowtype;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = p_admission_sha256;
  if not found or admission.stage_principal <> session_user::text then
    raise exception 'accepted preparation admission is absent or belongs to another principal' using errcode = '42501';
  end if;
  return admission.receipt || pg_catalog.jsonb_build_object('requestDocument',admission.request_document);
end;
$$;

create function catalogue_begin_preparation_v2(p_admission_sha256 text, p_stage_document text)
returns jsonb language plpgsql security definer as $$
declare
  admission catalogue_preparation_admission_v2%rowtype;
  preparation catalogue_preparation_v2%rowtype;
  result jsonb;
  batch_id_value uuid;
  header_sha text;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = p_admission_sha256 for update;
  if not found or admission.stage_principal <> session_user::text or p_stage_document is distinct from admission.stage_document then
    raise exception 'preparation needs its exact accepted admission and staging principal' using errcode = '42501';
  end if;
  select * into preparation from catalogue_preparation_v2 where admission_sha256 = p_admission_sha256;
  if not found then
    -- Reuse only the reviewed provenance metadata constructor, before the V2
    -- companion exists and within this transaction. No V1 records or hashes.
    result := catalogue_stage_import_batch(p_stage_document);
    if result -> 'resumed' is distinct from 'false'::jsonb then
      raise exception 'V2 preparation cannot adopt an existing V1 attempt' using errcode = '55000';
    end if;
    batch_id_value := (result ->> 'batchId')::uuid;
    perform 1 from food_import_batch where id = batch_id_value and status = 'staging'
      and staged_count = 0 and staging_seal_sha256 is null and validated_at is null for update;
    if not found or exists(select 1 from food_import_record where batch_id = batch_id_value)
      or exists(select 1 from food_import_parser_report where batch_id = batch_id_value)
      or exists(select 1 from food_import_checkpoint where batch_id = batch_id_value) then
      raise exception 'preparation admission cannot adopt an existing record attempt' using errcode = '55000';
    end if;
    header_sha := catalogue_frame_sha256_v2('stage-header',array[batch_id_value::text,p_admission_sha256,
      admission.manifest_sha256,admission.export_sha256,admission.export_bytes::text,admission.parser_version]);
    insert into catalogue_preparation_v2(batch_id,admission_sha256,stage_commitment_sha256,seal_record_commitment_sha256)
      values(batch_id_value,p_admission_sha256,header_sha,header_sha) returning * into preparation;
    perform catalogue_charge_preparation_budget_v2(batch_id_value,16384,0,0);
  end if;
  return pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',preparation.batch_id,
    'admissionSha256',preparation.admission_sha256,'phase',preparation.phase,
    'nextSequence',preparation.staged_count::text,'payloadTextBytes',preparation.payload_text_bytes::text,
    'stagePageCount',preparation.stage_page_count::text,'recordCommitmentSha256',preparation.stage_commitment_sha256,
    'lastPageReceiptSha256',preparation.last_page_receipt_sha256);
end;
$$;

create function catalogue_stage_preparation_page_v2(p_batch_id uuid, p_document text)
returns jsonb language plpgsql security definer as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  prior catalogue_preparation_stage_page_v2%rowtype;
  document jsonb;
  entry jsonb;
  payload jsonb;
  record_count_value bigint;
  sequence_value bigint;
  page_number_value bigint;
  page_bytes bigint := 0;
  payload_bytes bigint;
  charge bigint;
  request_sha text;
  record_sha text;
  chain_sha text;
  receipt_sha text;
  receipt_value jsonb;
  ordinal_value bigint := 0;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  if p_document is null or pg_catalog.octet_length(p_document) not between 1 and 16777216 then
    raise exception 'preparation page exceeds 16 MiB' using errcode = '22023';
  end if;
  document := p_document::jsonb;
  if pg_catalog.jsonb_typeof(document) <> 'object' or document -> 'schemaVersion' is distinct from '2'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(document)) <> 8
    or document - array['schemaVersion','batchId','admissionSha256','parserVersion','pageNumber','firstSequence','previousReceiptSha256','records'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(document -> 'records') is distinct from 'array' then
    raise exception 'preparation stage page contract differs' using errcode = '22023';
  end if;
  page_number_value := catalogue_preparation_uint_v2(document -> 'pageNumber');
  sequence_value := catalogue_preparation_uint_v2(document -> 'firstSequence');
  record_count_value := pg_catalog.jsonb_array_length(document -> 'records');
  if record_count_value not between 1 and 250 or document ->> 'batchId' is distinct from p_batch_id::text then
    raise exception 'preparation page identity or count is invalid' using errcode = '22023';
  end if;
  perform 1 from food_import_batch where id = p_batch_id for update;
  select * into preparation from catalogue_preparation_v2 where batch_id = p_batch_id for update;
  if not found then raise exception 'unknown preparation' using errcode = '23503'; end if;
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = preparation.admission_sha256;
  if admission.stage_principal <> session_user::text or document ->> 'admissionSha256' is distinct from admission.admission_sha256
    or document ->> 'parserVersion' is distinct from admission.parser_version then
    raise exception 'preparation page admission identity differs' using errcode = '42501';
  end if;
  request_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_document,'UTF8')),'hex');
  select * into prior from catalogue_preparation_stage_page_v2 where batch_id = p_batch_id and page_number = page_number_value;
  if found then
    if prior.request_sha256 <> request_sha or prior.request_document <> p_document then
      raise exception 'preparation page replay differs from retained request' using errcode = '55000';
    end if;
    return prior.receipt;
  end if;
  if preparation.phase <> 'staging' or page_number_value <> preparation.stage_page_count
    or sequence_value <> preparation.staged_count
    or document -> 'previousReceiptSha256' is distinct from coalesce(pg_catalog.to_jsonb(preparation.last_page_receipt_sha256),'null'::jsonb)
    or record_count_value > admission.max_records - preparation.staged_count then
    raise exception 'preparation page skips, overlaps, changes phase or exceeds admission' using errcode = '55000';
  end if;
  chain_sha := preparation.stage_commitment_sha256;
  charge := 8192 + 2 * pg_catalog.octet_length(p_document)::bigint;
  -- Preflight the entire bounded page and its accounting before inserting rows.
  for entry in select value from pg_catalog.jsonb_array_elements(document -> 'records') loop
    if pg_catalog.jsonb_typeof(entry) <> 'object' or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry)) <> 6
      or entry - array['sourceRecordKey','sourceRecordType','sequenceNumber','sourcePayloadSha256','canonicalPayloadSha256','canonicalPayloadDocument'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(entry -> 'sourceRecordKey') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry -> 'sourceRecordType') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry -> 'sourcePayloadSha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry -> 'canonicalPayloadSha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(entry -> 'canonicalPayloadDocument') is distinct from 'string'
      or pg_catalog.octet_length(entry ->> 'sourceRecordKey') not between 1 and 1024
      or pg_catalog.octet_length(entry ->> 'sourceRecordType') not between 1 and 256
      or entry ->> 'sourcePayloadSha256' !~ '^[0-9a-f]{64}$'
      or entry ->> 'canonicalPayloadSha256' !~ '^[0-9a-f]{64}$'
      or pg_catalog.octet_length(entry ->> 'canonicalPayloadDocument') not between 1 and 1048576
      or catalogue_preparation_uint_v2(entry -> 'sequenceNumber') <> sequence_value + ordinal_value then
      raise exception 'preparation record identity, size or sequence differs' using errcode = '22023';
    end if;
    if entry ->> 'canonicalPayloadSha256' <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(entry ->> 'canonicalPayloadDocument','UTF8')),'hex') then
      raise exception 'preparation payload digest differs' using errcode = '22023';
    end if;
    payload := (entry ->> 'canonicalPayloadDocument')::jsonb;
    payload_bytes := pg_catalog.octet_length(payload::text);
    if payload_bytes > 2097152 then raise exception 'PostgreSQL payload text exceeds its bound' using errcode = '54000'; end if;
    page_bytes := page_bytes + payload_bytes;
    charge := charge + 8192 + 2 * (payload_bytes + pg_catalog.octet_length(entry ->> 'canonicalPayloadDocument')::bigint
      + pg_catalog.octet_length(entry ->> 'sourceRecordKey')::bigint + pg_catalog.octet_length(entry ->> 'sourceRecordType')::bigint);
    ordinal_value := ordinal_value + 1;
  end loop;
  if page_bytes > admission.max_payload_text_bytes - preparation.payload_text_bytes then
    raise exception 'preparation payload byte budget exhausted' using errcode = '54000';
  end if;
  perform catalogue_charge_preparation_budget_v2(p_batch_id,charge,0,0);
  for entry in select value from pg_catalog.jsonb_array_elements(document -> 'records') loop
    payload := (entry ->> 'canonicalPayloadDocument')::jsonb;
    payload_bytes := pg_catalog.octet_length(payload::text);
    record_sha := catalogue_frame_sha256_v2('stage-record',array[p_batch_id::text,entry ->> 'sequenceNumber',
      entry ->> 'sourceRecordKey',entry ->> 'sourceRecordType',entry ->> 'sourcePayloadSha256',
      entry ->> 'canonicalPayloadSha256',payload_bytes::text]);
    chain_sha := catalogue_frame_sha256_v2('stage-record-link',array[chain_sha,record_sha]);
    insert into food_import_record(batch_id,source_record_key,source_record_type,sequence_number,
      source_payload_sha256,canonical_payload_sha256,canonical_payload)
    values(p_batch_id,entry ->> 'sourceRecordKey',entry ->> 'sourceRecordType',(entry ->> 'sequenceNumber')::bigint,
      entry ->> 'sourcePayloadSha256',entry ->> 'canonicalPayloadSha256',payload);
    insert into catalogue_preparation_record_v2(batch_id,sequence_number,canonical_payload_document,payload_text_bytes,record_sha256)
    values(p_batch_id,(entry ->> 'sequenceNumber')::bigint,entry ->> 'canonicalPayloadDocument',payload_bytes,record_sha);
  end loop;
  receipt_sha := catalogue_frame_sha256_v2('stage-page',array[p_batch_id::text,admission.admission_sha256,
    admission.parser_version,page_number_value::text,sequence_value::text,(sequence_value + record_count_value)::text,
    coalesce(preparation.last_page_receipt_sha256,''),request_sha,chain_sha,page_bytes::text,
    (preparation.payload_text_bytes + page_bytes)::text]);
  receipt_value := pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',p_batch_id,'admissionSha256',admission.admission_sha256,
    'pageNumber',page_number_value::text,'firstSequence',sequence_value::text,'nextSequence',(sequence_value + record_count_value)::text,
    'recordCount',record_count_value::text,'payloadTextBytes',page_bytes::text,'totalPayloadTextBytes',(preparation.payload_text_bytes + page_bytes)::text,
    'recordCommitmentSha256',chain_sha,'requestSha256',request_sha,'previousReceiptSha256',preparation.last_page_receipt_sha256,'receiptSha256',receipt_sha);
  insert into catalogue_preparation_stage_page_v2(batch_id,page_number,first_sequence,next_sequence,record_count,payload_text_bytes,
    total_payload_text_bytes,request_document,request_sha256,previous_receipt_sha256,record_commitment_sha256,receipt_sha256,receipt)
  values(p_batch_id,page_number_value,sequence_value,sequence_value + record_count_value,record_count_value,page_bytes,
    preparation.payload_text_bytes + page_bytes,p_document,request_sha,preparation.last_page_receipt_sha256,chain_sha,receipt_sha,receipt_value);
  update catalogue_preparation_v2 set staged_count = staged_count + record_count_value,payload_text_bytes = payload_text_bytes + page_bytes,
    stage_page_count = stage_page_count + 1,stage_commitment_sha256 = chain_sha,last_page_receipt_sha256 = receipt_sha where batch_id = p_batch_id;
  update food_import_batch set staged_count = sequence_value + record_count_value where id = p_batch_id;
  return receipt_value;
end;
$$;

create function catalogue_begin_preparation_seal_v2(p_batch_id uuid, p_document text)
returns jsonb language plpgsql security definer as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  document jsonb;
  report_value jsonb;
  request_sha text;
  field_name text;
  receipt_value jsonb;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  if p_document is null or pg_catalog.octet_length(p_document) not between 1 and 16777216 then
    raise exception 'preparation parser evidence exceeds its bound' using errcode = '22023';
  end if;
  document := p_document::jsonb;
  if pg_catalog.jsonb_typeof(document) <> 'object' or document -> 'schemaVersion' is distinct from '2'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(document)) <> 12
    or document - array['schemaVersion','reportDocument','reportSha256','sourceRecordCount','emittedRecordCount','excludedRecordCount',
      'sourceNutrientCount','emittedNutrientCount','excludedNutrientCount','sourcePortionCount','emittedPortionCount','excludedPortionCount'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(document -> 'reportDocument') is distinct from 'string'
    or pg_catalog.jsonb_typeof(document -> 'reportSha256') is distinct from 'string'
    or pg_catalog.octet_length(document ->> 'reportDocument') not between 1 and 15728640
    or document ->> 'reportSha256' is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(document ->> 'reportDocument','UTF8')),'hex') then
    raise exception 'preparation parser evidence contract or digest differs' using errcode = '22023';
  end if;
  report_value := (document ->> 'reportDocument')::jsonb;
  if pg_catalog.jsonb_typeof(report_value) <> 'object' then
    raise exception 'preparation parser report must be an object' using errcode = '22023';
  end if;
  foreach field_name in array array['Record','Nutrient','Portion'] loop
    if catalogue_preparation_uint_v2(document -> ('source' || field_name || 'Count')) -
      catalogue_preparation_uint_v2(document -> ('emitted' || field_name || 'Count')) <>
      catalogue_preparation_uint_v2(document -> ('excluded' || field_name || 'Count')) then
      raise exception 'preparation parser evidence fails count conservation' using errcode = '23514';
    end if;
  end loop;
  perform 1 from food_import_batch where id = p_batch_id for update;
  select * into preparation from catalogue_preparation_v2 where batch_id = p_batch_id for update;
  if not found then raise exception 'unknown preparation' using errcode = '23503'; end if;
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = preparation.admission_sha256;
  if admission.stage_principal <> session_user::text then
    raise exception 'preparation belongs to another stage principal' using errcode = '42501';
  end if;
  request_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_document,'UTF8')),'hex');
  if preparation.phase <> 'staging' then
    if preparation.seal_request_document is distinct from p_document or preparation.seal_request_sha256 is distinct from request_sha then
      raise exception 'preparation seal replay differs from retained parser evidence' using errcode = '55000';
    end if;
    return preparation.seal_begin_receipt;
  end if;
  if catalogue_preparation_uint_v2(document -> 'emittedRecordCount') <> preparation.staged_count
    or preparation.staged_count > admission.max_records or preparation.payload_text_bytes > admission.max_payload_text_bytes then
    raise exception 'preparation parser evidence differs from admitted stage totals' using errcode = '23514';
  end if;
  perform catalogue_charge_preparation_budget_v2(p_batch_id,
    16384 + 2 * (pg_catalog.octet_length(p_document)::bigint + pg_catalog.octet_length(report_value::text)::bigint),0,0);
  insert into food_import_parser_report(batch_id,report,report_sha256,source_record_count,emitted_record_count,excluded_record_count,
    source_nutrient_count,emitted_nutrient_count,excluded_nutrient_count,source_portion_count,emitted_portion_count,excluded_portion_count)
  values(p_batch_id,report_value,document ->> 'reportSha256',
    catalogue_preparation_uint_v2(document -> 'sourceRecordCount'),catalogue_preparation_uint_v2(document -> 'emittedRecordCount'),
    catalogue_preparation_uint_v2(document -> 'excludedRecordCount'),catalogue_preparation_uint_v2(document -> 'sourceNutrientCount'),
    catalogue_preparation_uint_v2(document -> 'emittedNutrientCount'),catalogue_preparation_uint_v2(document -> 'excludedNutrientCount'),
    catalogue_preparation_uint_v2(document -> 'sourcePortionCount'),catalogue_preparation_uint_v2(document -> 'emittedPortionCount'),
    catalogue_preparation_uint_v2(document -> 'excludedPortionCount'));
  receipt_value := pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',p_batch_id,'sealRequestSha256',request_sha,
    'parserReportSha256',document ->> 'reportSha256','recordCount',preparation.staged_count::text,
    'payloadTextBytes',preparation.payload_text_bytes::text,'stagePageCount',preparation.stage_page_count::text);
  update catalogue_preparation_v2 set phase = 'sealing',seal_request_document = p_document,
    seal_request_sha256 = request_sha,seal_begin_receipt = receipt_value,
    seal_verified_intermediate_bytes = 65536 + 2 * (pg_catalog.octet_length(admission.request_document)::bigint +
      pg_catalog.octet_length(admission.stage_document)::bigint + pg_catalog.octet_length(p_document)::bigint +
      pg_catalog.octet_length(report_value::text)::bigint)
  where batch_id = p_batch_id;
  return receipt_value;
end;
$$;

create function catalogue_verify_preparation_seal_page_v2(p_batch_id uuid, p_page_number bigint)
returns jsonb language plpgsql security definer as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  page catalogue_preparation_stage_page_v2%rowtype;
  source_row record;
  entry jsonb;
  document jsonb;
  receipt_value jsonb;
  expected_receipt jsonb;
  record_sha text;
  chain_sha text;
  receipt_sha text;
  payload_bytes bigint;
  page_bytes bigint := 0;
  record_count_value bigint := 0;
  verified_charge bigint;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  if p_page_number is null or p_page_number < 0 then
    raise exception 'seal verification cursor is invalid' using errcode = '22023';
  end if;
  perform 1 from food_import_batch where id = p_batch_id for update;
  select * into preparation from catalogue_preparation_v2 where batch_id = p_batch_id for update;
  if not found then raise exception 'unknown preparation' using errcode = '23503'; end if;
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = preparation.admission_sha256;
  if admission.stage_principal <> session_user::text then
    raise exception 'preparation belongs to another stage principal' using errcode = '42501';
  end if;
  select receipt into receipt_value from catalogue_preparation_seal_page_v2 where batch_id = p_batch_id and page_number = p_page_number;
  if found then return receipt_value; end if;
  if preparation.phase <> 'sealing' or preparation.seal_verified_page_count <> p_page_number
    or p_page_number >= preparation.stage_page_count then
    raise exception 'seal verification cursor skips a page or phase' using errcode = '55000';
  end if;
  select * into page from catalogue_preparation_stage_page_v2 where batch_id = p_batch_id and page_number = p_page_number;
  if not found or page.first_sequence <> preparation.seal_verified_record_count
    or page.previous_receipt_sha256 is distinct from preparation.seal_page_receipt_sha256
    or page.request_sha256 <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(page.request_document,'UTF8')),'hex') then
    raise exception 'retained stage page or accounting is corrupt' using errcode = '55000';
  end if;
  document := page.request_document::jsonb;
  if document ->> 'batchId' is distinct from p_batch_id::text
    or document ->> 'admissionSha256' is distinct from admission.admission_sha256
    or document ->> 'parserVersion' is distinct from admission.parser_version
    or document ->> 'pageNumber' is distinct from p_page_number::text
    or document ->> 'firstSequence' is distinct from page.first_sequence::text
    or document -> 'previousReceiptSha256' is distinct from coalesce(pg_catalog.to_jsonb(page.previous_receipt_sha256),'null'::jsonb)
    or pg_catalog.jsonb_array_length(document -> 'records') <> page.record_count then
    raise exception 'retained stage request identity is corrupt' using errcode = '55000';
  end if;
  chain_sha := preparation.seal_record_commitment_sha256;
  if p_page_number = 0 and chain_sha <> catalogue_frame_sha256_v2('stage-header',array[p_batch_id::text,
    admission.admission_sha256,admission.manifest_sha256,admission.export_sha256,admission.export_bytes::text,admission.parser_version]) then
    raise exception 'independent seal header differs from immutable admission' using errcode = '55000';
  end if;
  verified_charge := 8192 + 2 * pg_catalog.octet_length(page.request_document)::bigint;
  for source_row in
    select r.source_record_key,r.source_record_type,r.sequence_number,r.source_payload_sha256,
      r.canonical_payload_sha256,r.canonical_payload,e.canonical_payload_document,e.payload_text_bytes,e.record_sha256
    from food_import_record r join catalogue_preparation_record_v2 e using(batch_id,sequence_number)
    where r.batch_id = p_batch_id and r.sequence_number >= page.first_sequence and r.sequence_number < page.next_sequence
    order by r.sequence_number
  loop
    if source_row.sequence_number <> page.first_sequence + record_count_value
      or source_row.canonical_payload_sha256 <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(source_row.canonical_payload_document,'UTF8')),'hex')
      or source_row.canonical_payload is distinct from source_row.canonical_payload_document::jsonb then
      raise exception 'independent seal verification found corrupt source content' using errcode = '55000';
    end if;
    entry := document -> 'records' -> record_count_value::integer;
    if entry is distinct from pg_catalog.jsonb_build_object('sourceRecordKey',source_row.source_record_key,
      'sourceRecordType',source_row.source_record_type,'sequenceNumber',source_row.sequence_number::text,
      'sourcePayloadSha256',source_row.source_payload_sha256,'canonicalPayloadSha256',source_row.canonical_payload_sha256,
      'canonicalPayloadDocument',source_row.canonical_payload_document) then
      raise exception 'retained page differs from independently read source records' using errcode = '55000';
    end if;
    payload_bytes := pg_catalog.octet_length(source_row.canonical_payload::text);
    record_sha := catalogue_frame_sha256_v2('stage-record',array[p_batch_id::text,source_row.sequence_number::text,
      source_row.source_record_key,source_row.source_record_type,source_row.source_payload_sha256,
      source_row.canonical_payload_sha256,payload_bytes::text]);
    if payload_bytes <> source_row.payload_text_bytes or record_sha <> source_row.record_sha256 then
      raise exception 'retained source accounting or commitment is corrupt' using errcode = '55000';
    end if;
    chain_sha := catalogue_frame_sha256_v2('stage-record-link',array[chain_sha,record_sha]);
    page_bytes := page_bytes + payload_bytes;
    verified_charge := verified_charge + 8192 + 2 * (payload_bytes +
      pg_catalog.octet_length(source_row.canonical_payload_document)::bigint +
      pg_catalog.octet_length(source_row.source_record_key)::bigint + pg_catalog.octet_length(source_row.source_record_type)::bigint);
    record_count_value := record_count_value + 1;
  end loop;
  if record_count_value <> page.record_count or page_bytes <> page.payload_text_bytes
    or page.total_payload_text_bytes <> preparation.seal_verified_payload_text_bytes + page_bytes
    or chain_sha <> page.record_commitment_sha256 then
    raise exception 'independent seal verification found corrupt stage counters' using errcode = '55000';
  end if;
  receipt_sha := catalogue_frame_sha256_v2('stage-page',array[p_batch_id::text,admission.admission_sha256,
    admission.parser_version,p_page_number::text,page.first_sequence::text,page.next_sequence::text,
    coalesce(preparation.seal_page_receipt_sha256,''),page.request_sha256,chain_sha,page_bytes::text,
    (preparation.seal_verified_payload_text_bytes + page_bytes)::text]);
  expected_receipt := pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',p_batch_id,'admissionSha256',admission.admission_sha256,
    'pageNumber',p_page_number::text,'firstSequence',page.first_sequence::text,'nextSequence',page.next_sequence::text,
    'recordCount',record_count_value::text,'payloadTextBytes',page_bytes::text,'totalPayloadTextBytes',page.total_payload_text_bytes::text,
    'recordCommitmentSha256',chain_sha,'requestSha256',page.request_sha256,'previousReceiptSha256',page.previous_receipt_sha256,'receiptSha256',receipt_sha);
  if receipt_sha <> page.receipt_sha256 or expected_receipt is distinct from page.receipt then
    raise exception 'independent seal verification found a corrupt receipt' using errcode = '55000';
  end if;
  receipt_value := pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',p_batch_id,'pageNumber',p_page_number::text,
    'nextSequence',page.next_sequence::text,'recordCommitmentSha256',chain_sha,'stageReceiptSha256',receipt_sha,
    'verifiedPayloadTextBytes',page.total_payload_text_bytes::text);
  perform catalogue_charge_preparation_budget_v2(p_batch_id,8192,0,0);
  insert into catalogue_preparation_seal_page_v2(batch_id,page_number,receipt) values(p_batch_id,p_page_number,receipt_value);
  update catalogue_preparation_v2 set seal_verified_page_count = seal_verified_page_count + 1,
    seal_verified_record_count = page.next_sequence,seal_verified_payload_text_bytes = page.total_payload_text_bytes,
    seal_verified_intermediate_bytes = seal_verified_intermediate_bytes + verified_charge + 8192,
    seal_record_commitment_sha256 = chain_sha,seal_page_receipt_sha256 = receipt_sha where batch_id = p_batch_id;
  return receipt_value;
end;
$$;

create function catalogue_finish_preparation_seal_v2(p_batch_id uuid, p_document text)
returns jsonb language plpgsql security definer as $$
declare
  preparation catalogue_preparation_v2%rowtype;
  admission catalogue_preparation_admission_v2%rowtype;
  parser food_import_parser_report%rowtype;
  parser_document jsonb;
  document jsonb;
  expected_document jsonb;
  seal_sha text;
  receipt_value jsonb;
begin
  perform catalogue_require_preparation_role_v2('nutrition_catalogue_stage');
  if p_document is null or pg_catalog.octet_length(p_document) not between 1 and 65536 then
    raise exception 'preparation terminal document exceeds its bound' using errcode = '22023';
  end if;
  document := p_document::jsonb;
  perform 1 from food_import_batch where id = p_batch_id for update;
  select * into preparation from catalogue_preparation_v2 where batch_id = p_batch_id for update;
  if not found then raise exception 'unknown preparation' using errcode = '23503'; end if;
  select * into admission from catalogue_preparation_admission_v2 where admission_sha256 = preparation.admission_sha256;
  if admission.stage_principal <> session_user::text then
    raise exception 'preparation belongs to another stage principal' using errcode = '42501';
  end if;
  if preparation.phase = 'sealed' then
    if preparation.terminal_document is distinct from p_document then
      raise exception 'preparation terminal replay differs' using errcode = '55000';
    end if;
    return preparation.terminal_receipt;
  end if;
  if preparation.phase <> 'sealing' or preparation.seal_verified_page_count <> preparation.stage_page_count
    or preparation.seal_verified_record_count <> preparation.staged_count
    or preparation.seal_verified_payload_text_bytes <> preparation.payload_text_bytes
    or preparation.seal_record_commitment_sha256 <> preparation.stage_commitment_sha256
    or preparation.seal_page_receipt_sha256 is distinct from preparation.last_page_receipt_sha256
    or exists(select 1 from food_import_record where batch_id = p_batch_id and sequence_number >= preparation.staged_count)
    or exists(select 1 from catalogue_preparation_stage_page_v2 where batch_id = p_batch_id and page_number >= preparation.stage_page_count)
    or exists(select 1 from food_import_batch where id = p_batch_id and staged_count <> preparation.staged_count) then
    raise exception 'preparation seal lacks complete independent verification' using errcode = '55000';
  end if;
  if preparation.staged_count = 0 and preparation.seal_record_commitment_sha256 <>
    catalogue_frame_sha256_v2('stage-header',array[p_batch_id::text,admission.admission_sha256,
      admission.manifest_sha256,admission.export_sha256,admission.export_bytes::text,admission.parser_version]) then
    raise exception 'empty preparation seal header differs from immutable admission' using errcode = '55000';
  end if;
  if not exists(select 1 from catalogue_preparation_budget_usage_v2 where admission_sha256 = admission.admission_sha256
    and intermediate_bytes = preparation.seal_verified_intermediate_bytes
    and validation_evidence_bytes = 0 and reconciliation_evidence_bytes = 0) then
    raise exception 'independent seal verification found corrupt intermediate accounting' using errcode = '55000';
  end if;
  select * into parser from food_import_parser_report where batch_id = p_batch_id;
  if not found then raise exception 'preparation parser evidence is absent' using errcode = '55000'; end if;
  parser_document := preparation.seal_request_document::jsonb;
  if preparation.seal_request_sha256 <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(preparation.seal_request_document,'UTF8')),'hex')
    or parser.report_sha256 is distinct from parser_document ->> 'reportSha256'
    or parser.report is distinct from (parser_document ->> 'reportDocument')::jsonb
    or parser.report_sha256 <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(parser_document ->> 'reportDocument','UTF8')),'hex')
    or row(parser.source_record_count,parser.emitted_record_count,parser.excluded_record_count,
      parser.source_nutrient_count,parser.emitted_nutrient_count,parser.excluded_nutrient_count,
      parser.source_portion_count,parser.emitted_portion_count,parser.excluded_portion_count)
    is distinct from row(catalogue_preparation_uint_v2(parser_document -> 'sourceRecordCount'),
      catalogue_preparation_uint_v2(parser_document -> 'emittedRecordCount'),catalogue_preparation_uint_v2(parser_document -> 'excludedRecordCount'),
      catalogue_preparation_uint_v2(parser_document -> 'sourceNutrientCount'),catalogue_preparation_uint_v2(parser_document -> 'emittedNutrientCount'),
      catalogue_preparation_uint_v2(parser_document -> 'excludedNutrientCount'),catalogue_preparation_uint_v2(parser_document -> 'sourcePortionCount'),
      catalogue_preparation_uint_v2(parser_document -> 'emittedPortionCount'),catalogue_preparation_uint_v2(parser_document -> 'excludedPortionCount'))
    or parser.emitted_record_count <> preparation.staged_count then
    raise exception 'preparation parser evidence differs from the frozen source' using errcode = '55000';
  end if;
  expected_document := pg_catalog.jsonb_build_object('schemaVersion',2,'batchId',p_batch_id,'admissionSha256',admission.admission_sha256,
    'recordCount',preparation.staged_count::text,'payloadTextBytes',preparation.payload_text_bytes::text,
    'recordCommitmentSha256',preparation.stage_commitment_sha256,'stageReceiptSha256',preparation.last_page_receipt_sha256,
    'parserReportSha256',parser.report_sha256,'sealRequestSha256',preparation.seal_request_sha256);
  if document is distinct from expected_document then
    raise exception 'preparation terminal does not bind the exact verified identity' using errcode = '55000';
  end if;
  seal_sha := catalogue_frame_sha256_v2('stage-terminal',array[p_batch_id::text,admission.admission_sha256,
    admission.manifest_sha256,admission.export_sha256,admission.export_bytes::text,admission.parser_version,
    parser.report_sha256,preparation.staged_count::text,preparation.payload_text_bytes::text,preparation.stage_page_count::text,
    coalesce(preparation.last_page_receipt_sha256,''),preparation.stage_commitment_sha256,preparation.seal_request_sha256]);
  receipt_value := expected_document || pg_catalog.jsonb_build_object('stagingSealSha256',seal_sha);
  perform catalogue_charge_preparation_budget_v2(p_batch_id,16384 + 2 * pg_catalog.octet_length(p_document)::bigint,0,0);
  update catalogue_preparation_v2 set phase = 'sealed',staging_seal_sha256 = seal_sha,sealed_at = pg_catalog.clock_timestamp(),
    terminal_document = p_document,terminal_receipt = receipt_value,
    seal_verified_intermediate_bytes = seal_verified_intermediate_bytes + 16384 + 2 * pg_catalog.octet_length(p_document)::bigint
  where batch_id = p_batch_id;
  return receipt_value;
end;
$$;

-- All durable source, admission and receipt rows reject rewriting and removal.
do $migration$
declare
  table_name text;
  target_schema name := pg_catalog.current_schema();
  function_spec record;
  role_name text;
begin
  foreach table_name in array array['catalogue_preparation_admission_v2','catalogue_preparation_record_v2',
    'catalogue_preparation_stage_page_v2','catalogue_preparation_seal_page_v2'] loop
    execute pg_catalog.format('create trigger %I before update or delete on %I.%I for each row execute function %I.reject_immutable_row_update()',
      table_name || '_immutable',target_schema,table_name,target_schema);
  end loop;
  foreach table_name in array array['catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2',
    'catalogue_preparation_record_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_seal_page_v2'] loop
    execute pg_catalog.format('create trigger %I before insert on %I.%I for each row execute function %I.catalogue_guard_preparation_evidence_insert_v2()',
      table_name || '_insert',target_schema,table_name,target_schema);
  end loop;
  foreach table_name in array array['catalogue_preparation_admission_v2','catalogue_preparation_budget_usage_v2',
    'catalogue_preparation_v2','catalogue_preparation_record_v2','catalogue_preparation_stage_page_v2','catalogue_preparation_seal_page_v2'] loop
    execute pg_catalog.format('revoke all on table %I.%I from public',target_schema,table_name);
    for role_name in
      select distinct r.rolname from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(c.relacl) a
      join pg_catalog.pg_roles r on r.oid = a.grantee
      where c.oid = pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,table_name))
        and a.grantee <> c.relowner
    loop
      execute pg_catalog.format('revoke all on table %I.%I from %I',target_schema,table_name,role_name);
    end loop;
    foreach role_name in array array['nutrition_catalogue_stage','nutrition_catalogue_validate','nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights','nutrition_catalogue_promote_activate','nutrition_catalogue_rollback'] loop
      execute pg_catalog.format('revoke all on table %I.%I from %I',target_schema,table_name,role_name);
    end loop;
  end loop;
  for function_spec in select * from (values
    ('catalogue_frame_sha256_v2(text,text[])'::text,null::text),
    ('catalogue_require_preparation_role_v2(text)',null),
    ('catalogue_preparation_uint_v2(jsonb)',null),
    ('catalogue_charge_preparation_budget_v2(uuid,bigint,bigint,bigint)',null),
    ('catalogue_guard_preparation_v2()',null),
    ('catalogue_guard_preparation_evidence_insert_v2()',null),
    ('catalogue_guard_preparation_source_insert_v2()',null),
    ('catalogue_admit_preparation_v2(text)','nutrition_catalogue_approve_quality'),
    ('catalogue_read_preparation_admission_v2(text)','nutrition_catalogue_stage'),
    ('catalogue_begin_preparation_v2(text,text)','nutrition_catalogue_stage'),
    ('catalogue_stage_preparation_page_v2(uuid,text)','nutrition_catalogue_stage'),
    ('catalogue_begin_preparation_seal_v2(uuid,text)','nutrition_catalogue_stage'),
    ('catalogue_verify_preparation_seal_page_v2(uuid,bigint)','nutrition_catalogue_stage'),
    ('catalogue_finish_preparation_seal_v2(uuid,text)','nutrition_catalogue_stage')
  ) specs(identity,capability) loop
    execute pg_catalog.format('alter function %I.%s set search_path = pg_catalog, %I, pg_temp',target_schema,function_spec.identity,target_schema);
    execute pg_catalog.format('revoke all on function %I.%s from public',target_schema,function_spec.identity);
    for role_name in
      select distinct r.rolname from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(p.proacl) a
      join pg_catalog.pg_roles r on r.oid = a.grantee
      where p.oid = pg_catalog.to_regprocedure(pg_catalog.format('%I.%s',target_schema,function_spec.identity))
        and a.grantee <> p.proowner
    loop
      execute pg_catalog.format('revoke all on function %I.%s from %I',target_schema,function_spec.identity,role_name);
    end loop;
    foreach role_name in array array['nutrition_catalogue_stage','nutrition_catalogue_validate','nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality','nutrition_catalogue_approve_rights','nutrition_catalogue_promote_activate','nutrition_catalogue_rollback'] loop
      execute pg_catalog.format('revoke all on function %I.%s from %I',target_schema,function_spec.identity,role_name);
    end loop;
    if function_spec.capability is not null then
      execute pg_catalog.format('grant execute on function %I.%s to %I',target_schema,function_spec.identity,function_spec.capability);
    end if;
  end loop;
end;
$migration$;
