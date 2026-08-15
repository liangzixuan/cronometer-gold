-- Durable, resumable food-catalogue ingestion and release activation.
-- Source artifacts and canonical records are append-only provenance. Only
-- workflow state, checkpoints, and catalogue pointers may change in place.

alter table food_source_release
  add constraint food_source_release_source_identity_unique unique (food_source_id, id),
  add column rights_manifest_sha256 text
    check (rights_manifest_sha256 is null or rights_manifest_sha256 ~ '^[0-9a-f]{64}$');

create or replace function guard_food_source_release_update()
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
    new.record_counts,
    new.validation_summary,
    new.rights_manifest_uri,
    new.rights_manifest_sha256,
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
    old.record_counts,
    old.validation_summary,
    old.rights_manifest_uri,
    old.rights_manifest_sha256,
    old.created_at
  ) then
    raise exception 'food source release provenance cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.status <> 'imported' or new.status not in ('failed', 'promoted', 'quarantined') then
    raise exception 'invalid food source release status transition from % to %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger food_source_release_reject_delete
before delete on food_source_release
for each row execute function reject_immutable_row_update();

-- Imported food-version children are immutable evidence. Custom/user-owned
-- rows remain deletable for privacy workflows and parent cascades.
create function guard_imported_food_version_child_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from food_version
    where id = old.food_version_id
      and source_release_id is not null
  ) then
    raise exception 'imported food-version child in % cannot be deleted', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger food_nutrient_value_reject_delete
before delete on food_nutrient_value
for each row execute function guard_imported_food_version_child_delete();

create trigger food_serving_reject_delete
before delete on food_serving
for each row execute function guard_imported_food_version_child_delete();

create function guard_source_barcode_delete()
returns trigger
language plpgsql
as $$
begin
  if old.source_release_id is not null then
    raise exception 'source barcode history cannot be deleted'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger food_barcode_reject_delete
before delete on food_barcode
for each row execute function guard_source_barcode_delete();

create function guard_diary_snapshot_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from diary_entry where id = old.diary_entry_id
  ) then
    raise exception 'immutable diary snapshot cannot be deleted while its diary entry exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_entry_nutrient_snapshot_guard_delete
before delete on diary_entry_nutrient_snapshot
for each row execute function guard_diary_snapshot_delete();

alter table nutrient drop constraint nutrient_code_check;
alter table nutrient
  add constraint nutrient_code_check check (code ~ '^[a-z][a-z0-9_-]{1,63}$');

create function guard_nutrient_ontology_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.id,
    new.code,
    new.name,
    new.canonical_unit,
    new.dimension,
    new.parent_nutrient_id,
    new.created_at
  ) is distinct from row(
    old.id,
    old.code,
    old.name,
    old.canonical_unit,
    old.dimension,
    old.parent_nutrient_id,
    old.created_at
  ) then
    raise exception 'canonical nutrient ontology cannot be rewritten in place'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger nutrient_guard_ontology_update
before update on nutrient
for each row execute function guard_nutrient_ontology_update();

alter table source_nutrient_map
  add column reviewed_by text,
  add column current_revision_id uuid;
update source_nutrient_map set reviewed_by = 'legacy-unattributed' where reviewed_by is null;
alter table source_nutrient_map alter column reviewed_by set not null;
alter table source_nutrient_map
  add constraint source_nutrient_map_reviewer_principal_check check (
    reviewed_by = btrim(reviewed_by)
    and reviewed_by = lower(reviewed_by)
    and reviewed_by ~ '^[a-z][-a-z0-9._:@/]{2,255}$'
  ) not valid;

alter table food_source
  add constraint food_source_rights_reviewer_principal_check check (
    rights_reviewed_by is null
    or (
      rights_reviewed_by = btrim(rights_reviewed_by)
      and rights_reviewed_by = lower(rights_reviewed_by)
      and rights_reviewed_by ~ '^[a-z][-a-z0-9._:@/]{2,255}$'
    )
  ) not valid;

create table source_nutrient_map_revision (
  id uuid primary key default gen_random_uuid(),
  food_source_id bigint not null references food_source(id) on delete restrict,
  source_nutrient_key text not null,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  source_name text not null,
  source_unit text not null,
  conversion_multiplier numeric(24,12) not null check (conversion_multiplier > 0),
  mapping_notes text,
  reviewed_at timestamptz not null,
  reviewed_by text not null check (
    reviewed_by = btrim(reviewed_by)
    and reviewed_by = lower(reviewed_by)
    and reviewed_by ~ '^[a-z][-a-z0-9._:@/]{2,255}$'
  ),
  change_reason text not null check (length(btrim(change_reason)) > 0),
  supersedes_revision_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (food_source_id, source_nutrient_key, id),
  foreign key (food_source_id, source_nutrient_key, supersedes_revision_id)
    references source_nutrient_map_revision(food_source_id, source_nutrient_key, id)
    deferrable initially deferred
);

insert into source_nutrient_map_revision (
  food_source_id,
  source_nutrient_key,
  nutrient_id,
  source_name,
  source_unit,
  conversion_multiplier,
  mapping_notes,
  reviewed_at,
  reviewed_by,
  change_reason
)
select
  food_source_id,
  source_nutrient_key,
  nutrient_id,
  source_name,
  source_unit,
  conversion_multiplier,
  mapping_notes,
  reviewed_at,
  reviewed_by,
  'Initial revision migrated from source_nutrient_map'
from source_nutrient_map;

update source_nutrient_map as mapping
set current_revision_id = revision.id
from source_nutrient_map_revision as revision
where revision.food_source_id = mapping.food_source_id
  and revision.source_nutrient_key = mapping.source_nutrient_key
  and revision.supersedes_revision_id is null;

alter table source_nutrient_map alter column current_revision_id set not null;
alter table source_nutrient_map
  add constraint source_nutrient_map_current_revision_fk
  foreign key (food_source_id, source_nutrient_key, current_revision_id)
  references source_nutrient_map_revision(food_source_id, source_nutrient_key, id)
  deferrable initially deferred;
alter table source_nutrient_map_revision
  add constraint source_nutrient_map_revision_registry_fk
  foreign key (food_source_id, source_nutrient_key)
  references source_nutrient_map(food_source_id, source_nutrient_key)
  deferrable initially deferred;

create function guard_source_nutrient_map_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.food_source_id,
    new.source_nutrient_key,
    new.nutrient_id,
    new.source_name,
    new.source_unit,
    new.conversion_multiplier,
    new.mapping_notes,
    new.reviewed_at,
    new.reviewed_by,
    new.created_at
  ) is distinct from row(
    old.food_source_id,
    old.source_nutrient_key,
    old.nutrient_id,
    old.source_name,
    old.source_unit,
    old.conversion_multiplier,
    old.mapping_notes,
    old.reviewed_at,
    old.reviewed_by,
    old.created_at
  ) then
    raise exception 'source nutrient mapping provenance cannot be rewritten; add a revision'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger source_nutrient_map_guard_update
before update on source_nutrient_map
for each row execute function guard_source_nutrient_map_update();

create trigger source_nutrient_map_reject_delete
before delete on source_nutrient_map
for each row execute function reject_immutable_row_update();

create trigger source_nutrient_map_revision_reject_update
before update or delete on source_nutrient_map_revision
for each row execute function reject_immutable_row_update();

alter table food_version
  add constraint food_version_release_identity_unique unique (food_id, source_release_id);

alter table food_source
  add column active_release_id uuid,
  add constraint food_source_active_release_fk
    foreign key (id, active_release_id)
    references food_source_release(food_source_id, id)
    deferrable initially deferred;

create index food_source_active_release_idx
  on food_source (active_release_id)
  where active_release_id is not null;

create table food_import_batch (
  id uuid primary key default gen_random_uuid(),
  food_source_id bigint not null references food_source(id) on delete restrict,
  release_key text not null check (length(btrim(release_key)) > 0),
  published_on date,
  acquired_at timestamptz not null,
  artifact_uri text not null check (length(btrim(artifact_uri)) > 0),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes bigint not null check (artifact_bytes > 0),
  media_type text not null check (length(btrim(media_type)) > 0),
  upstream_schema_version text,
  parser_version text not null check (length(btrim(parser_version)) > 0),
  rights_manifest_uri text not null check (length(btrim(rights_manifest_uri)) > 0),
  rights_manifest_sha256 text not null check (rights_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'staging'
    check (status in ('completed', 'failed', 'promoting', 'quarantined', 'ready', 'staging')),
  staged_count bigint not null default 0 check (staged_count >= 0),
  valid_count bigint not null default 0 check (valid_count >= 0),
  quarantined_count bigint not null default 0 check (quarantined_count >= 0),
  unresolved_error_count bigint not null default 0 check (unresolved_error_count >= 0),
  warning_count bigint not null default 0 check (warning_count >= 0),
  nutrient_input_count bigint not null default 0 check (nutrient_input_count >= 0),
  nutrient_materializable_count bigint not null default 0
    check (nutrient_materializable_count >= 0),
  nutrient_excluded_count bigint not null default 0 check (nutrient_excluded_count >= 0),
  materialized_count bigint not null default 0 check (materialized_count >= 0),
  validation_policy jsonb not null default '{}'::jsonb
    check (jsonb_typeof(validation_policy) = 'object'),
  release_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  validated_at timestamptz,
  completed_at timestamptz,
  unique (food_source_id, release_key, artifact_sha256, parser_version),
  unique (food_source_id, id),
  foreign key (food_source_id, release_id)
    references food_source_release(food_source_id, id) deferrable initially deferred,
  check (valid_count <= staged_count),
  check (materialized_count <= valid_count),
  check (nutrient_materializable_count + nutrient_excluded_count <= nutrient_input_count),
  check (status not in ('ready', 'promoting', 'completed', 'quarantined') or validated_at is not null),
  check (status <> 'completed' or completed_at is not null),
  check (completed_at is null or status = 'completed'),
  check (release_id is null or status in ('promoting', 'completed'))
);

create index food_import_batch_work_idx
  on food_import_batch (status, updated_at, id)
  where status not in ('completed', 'failed', 'quarantined');
create index food_import_batch_source_idx
  on food_import_batch (food_source_id, created_at desc);

create function guard_food_import_batch_update()
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
    old.validated_at
  ) then
    raise exception 'validated food import batch summary cannot be rewritten'
      using errcode = '55000';
  end if;

  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger food_import_batch_guard_update
before update or delete on food_import_batch
for each row execute function guard_food_import_batch_update();

create table food_import_parser_report (
  batch_id uuid primary key references food_import_batch(id) on delete restrict,
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  source_record_count bigint not null check (source_record_count >= 0),
  emitted_record_count bigint not null check (emitted_record_count >= 0),
  excluded_record_count bigint not null check (excluded_record_count >= 0),
  source_nutrient_count bigint not null check (source_nutrient_count >= 0),
  emitted_nutrient_count bigint not null check (emitted_nutrient_count >= 0),
  excluded_nutrient_count bigint not null check (excluded_nutrient_count >= 0),
  source_portion_count bigint not null check (source_portion_count >= 0),
  emitted_portion_count bigint not null check (emitted_portion_count >= 0),
  excluded_portion_count bigint not null check (excluded_portion_count >= 0),
  created_at timestamptz not null default clock_timestamp(),
  check (source_record_count = emitted_record_count + excluded_record_count),
  check (source_nutrient_count = emitted_nutrient_count + excluded_nutrient_count),
  check (source_portion_count = emitted_portion_count + excluded_portion_count)
);

create trigger food_import_parser_report_reject_update
before update or delete on food_import_parser_report
for each row execute function reject_immutable_row_update();

create table food_import_approval (
  id bigint generated always as identity primary key,
  batch_id uuid not null references food_import_batch(id) on delete restrict,
  approval_role text not null check (approval_role in ('data', 'quality', 'rights')),
  validation_digest text not null check (validation_digest ~ '^[0-9a-f]{64}$'),
  rights_manifest_sha256 text not null check (rights_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz not null default clock_timestamp(),
  principal_id text not null check (
    principal_id = btrim(principal_id)
    and principal_id = lower(principal_id)
    and principal_id ~ '^[a-z][-a-z0-9._:@/]{2,255}$'
  ),
  approval_reference text not null check (length(btrim(approval_reference)) > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (batch_id, approval_role),
  unique (batch_id, principal_id)
);

create trigger food_import_approval_reject_update
before update or delete on food_import_approval
for each row execute function reject_immutable_row_update();

create table food_import_record (
  id bigint generated always as identity primary key,
  batch_id uuid not null references food_import_batch(id) on delete restrict,
  source_record_key text not null check (length(btrim(source_record_key)) > 0),
  source_record_type text not null check (length(btrim(source_record_type)) > 0),
  sequence_number bigint not null check (sequence_number >= 0),
  source_payload_sha256 text not null check (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_payload_sha256 text not null check (canonical_payload_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_payload jsonb not null,
  validation_status text not null default 'pending'
    check (validation_status in ('materialized', 'pending', 'quarantined', 'valid')),
  validation_issues jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_issues) = 'array'),
  food_version_id bigint references food_version(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  validated_at timestamptz,
  materialized_at timestamptz,
  unique (batch_id, source_record_key),
  unique (batch_id, sequence_number),
  check ((validation_status = 'pending') = (validated_at is null)),
  check ((validation_status = 'materialized') = (materialized_at is not null)),
  check ((validation_status = 'materialized') = (food_version_id is not null))
);

create index food_import_record_pending_idx
  on food_import_record (batch_id, sequence_number)
  where validation_status in ('pending', 'valid');
create index food_import_record_quarantine_idx
  on food_import_record (batch_id, sequence_number)
  where validation_status = 'quarantined';

create function guard_food_import_record_update()
returns trigger
language plpgsql
as $$
begin
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
     and old.validation_issues is distinct from new.validation_issues then
    raise exception 'validated import record issues cannot be rewritten'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger food_import_record_guard_update
before update on food_import_record
for each row execute function guard_food_import_record_update();

create trigger food_import_record_reject_delete
before delete on food_import_record
for each row execute function reject_immutable_row_update();

create function guard_food_barcode_validity_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.id,
    new.gtin,
    new.market_code,
    new.food_id,
    new.food_version_id,
    new.food_serving_id,
    new.source_release_id,
    new.valid_from,
    new.metadata,
    new.created_at
  ) is distinct from row(
    old.id,
    old.gtin,
    old.market_code,
    old.food_id,
    old.food_version_id,
    old.food_serving_id,
    old.source_release_id,
    old.valid_from,
    old.metadata,
    old.created_at
  ) or old.valid_to is not null or new.valid_to is null then
    raise exception 'food barcode provenance cannot be rewritten; only closing is allowed'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger food_barcode_guard_update
before update on food_barcode
for each row execute function guard_food_barcode_validity_update();

create table food_import_checkpoint (
  batch_id uuid not null references food_import_batch(id) on delete restrict,
  stage text not null check (stage in ('download', 'materialize', 'parse', 'stage', 'validate')),
  cursor_data jsonb not null check (jsonb_typeof(cursor_data) = 'object'),
  last_sequence_number bigint check (last_sequence_number is null or last_sequence_number >= 0),
  processed_count bigint not null default 0 check (processed_count >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (batch_id, stage)
);

create trigger food_import_checkpoint_set_updated_at
before update on food_import_checkpoint
for each row execute function set_row_updated_at();

create table food_source_release_activation (
  id bigint generated always as identity primary key,
  food_source_id bigint not null references food_source(id) on delete restrict,
  operation text not null check (operation in ('activate', 'deactivate', 'rollback')),
  release_id uuid,
  previous_release_id uuid,
  import_batch_id uuid,
  reason text not null check (length(btrim(reason)) > 0),
  performed_by text not null check (
    performed_by = btrim(performed_by)
    and performed_by = lower(performed_by)
    and performed_by ~ '^[a-z][-a-z0-9._:@/]{2,255}$'
  ),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (food_source_id, release_id)
    references food_source_release(food_source_id, id) deferrable initially deferred,
  foreign key (food_source_id, previous_release_id)
    references food_source_release(food_source_id, id) deferrable initially deferred,
  foreign key (food_source_id, import_batch_id)
    references food_import_batch(food_source_id, id) deferrable initially deferred,
  check ((operation = 'deactivate') = (release_id is null)),
  check (release_id is null or release_id is distinct from previous_release_id)
);

create index food_source_release_activation_history_idx
  on food_source_release_activation (food_source_id, occurred_at desc, id desc);

create trigger food_source_release_activation_reject_update
before update or delete on food_source_release_activation
for each row execute function reject_immutable_row_update();

comment on table food_import_batch is
  'Resumable workflow state. Artifact identity and parser provenance are immutable.';
comment on table food_import_approval is
  'Immutable post-validation approval bound to the exact validation digest and rights manifest.';
comment on table food_import_record is
  'Append-only staged canonical record. Validation may classify it once; materialization may link it once.';
comment on table food_source_release_activation is
  'Immutable activation history. Rollback changes only live catalogue pointers, never food versions or diary snapshots.';
