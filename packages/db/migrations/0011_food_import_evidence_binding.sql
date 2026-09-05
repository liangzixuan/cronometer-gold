-- Bind every new catalogue staging attempt and release to immutable acquisition
-- evidence. Existing rows remain readable but are explicitly non-authoritative.
-- Recovery is forward-only: restore the pre-migration database backup to roll
-- back. Preserve existing rows as legacy-unbound; never fabricate or upgrade
-- their missing acquisition evidence.

alter table food_import_batch
  add column release_class text not null default 'legacy-unbound',
  add column evidence_bundle_sha256 text,
  add column evidence_bundle_uri text,
  add column evidence_decision_sha256 text,
  add column evidence_object_version_id text,
  add column evidence_valid_until timestamptz;

alter table food_source_release
  add column release_class text not null default 'legacy-unbound',
  add column evidence_bundle_sha256 text,
  add column evidence_bundle_uri text,
  add column evidence_decision_sha256 text,
  add column evidence_object_version_id text,
  add column evidence_valid_until timestamptz;

create function catalogue_evidence_bundle_uri_is_valid(value text, digest text)
returns boolean
language sql
immutable
strict
as $$
  select octet_length(value) <= 2048
    and value !~ '[[:space:]]'
    and value ~ (
      '^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/([^/?#]+/)*sha256/'
      || digest
      || '(/[^?#]+)?$'
    )
    and split_part(value, '/', 3) !~ '\.\.'
    and split_part(value, '/', 3) !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$';
$$;

alter table food_import_batch
  alter column release_class drop default,
  add constraint food_import_batch_release_class_check check (
    release_class in ('live-reviewed', 'fixture-nonrelease', 'legacy-unbound')
  ),
  add constraint food_import_batch_evidence_binding_check check (
    (
      release_class = 'legacy-unbound'
      and evidence_bundle_sha256 is null
      and evidence_bundle_uri is null
      and evidence_decision_sha256 is null
      and evidence_object_version_id is null
      and evidence_valid_until is null
    )
    or
    (
      release_class in ('live-reviewed', 'fixture-nonrelease')
      and evidence_bundle_sha256 is not null
      and evidence_bundle_sha256 ~ '^[0-9a-f]{64}$'
      and evidence_bundle_uri is not null
      and length(btrim(evidence_bundle_uri)) > 0
      and catalogue_evidence_bundle_uri_is_valid(
        evidence_bundle_uri,
        evidence_bundle_sha256
      )
      and evidence_decision_sha256 is not null
      and evidence_decision_sha256 ~ '^[0-9a-f]{64}$'
      and evidence_object_version_id is not null
      and length(btrim(evidence_object_version_id)) > 0
      and octet_length(evidence_object_version_id) <= 1024
      and evidence_valid_until is not null
      and evidence_valid_until not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    )
  );

alter table food_source_release
  alter column release_class drop default,
  add constraint food_source_release_release_class_check check (
    release_class in ('live-reviewed', 'fixture-nonrelease', 'legacy-unbound')
  ),
  add constraint food_source_release_evidence_binding_check check (
    (
      release_class = 'legacy-unbound'
      and evidence_bundle_sha256 is null
      and evidence_bundle_uri is null
      and evidence_decision_sha256 is null
      and evidence_object_version_id is null
      and evidence_valid_until is null
    )
    or
    (
      release_class in ('live-reviewed', 'fixture-nonrelease')
      and evidence_bundle_sha256 is not null
      and evidence_bundle_sha256 ~ '^[0-9a-f]{64}$'
      and evidence_bundle_uri is not null
      and length(btrim(evidence_bundle_uri)) > 0
      and catalogue_evidence_bundle_uri_is_valid(
        evidence_bundle_uri,
        evidence_bundle_sha256
      )
      and evidence_decision_sha256 is not null
      and evidence_decision_sha256 ~ '^[0-9a-f]{64}$'
      and evidence_object_version_id is not null
      and length(btrim(evidence_object_version_id)) > 0
      and octet_length(evidence_object_version_id) <= 1024
      and evidence_valid_until is not null
      and evidence_valid_until not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    )
  ),
  add constraint food_source_release_promoted_authority_check check (
    status <> 'promoted' or release_class = 'live-reviewed'
  ) not valid;

alter table food_import_batch
  add constraint food_import_batch_fixture_authority_check check (
    release_class <> 'fixture-nonrelease' or status not in ('promoting', 'completed')
  );

-- A renewed evidence bundle is a new staging attempt even when the source
-- artifact and parser are unchanged. Release identity intentionally remains
-- one logical artifact release so competing evidence cannot rewrite it.
do $migration$
declare
  old_attempt_constraint name;
begin
  select constraint_row.conname
  into old_attempt_constraint
  from pg_constraint as constraint_row
  where constraint_row.conrelid = 'food_import_batch'::regclass
    and constraint_row.contype = 'u'
    and array(
      select attribute.attname::text
      from unnest(constraint_row.conkey) with ordinality as key_column(attnum, position)
      join pg_attribute as attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
      order by key_column.position
    ) = array['food_source_id', 'release_key', 'artifact_sha256', 'parser_version'];

  if old_attempt_constraint is null then
    raise exception 'food import batch attempt identity constraint was not found';
  end if;

  execute format(
    'alter table food_import_batch drop constraint %I',
    old_attempt_constraint
  );
end;
$migration$;

alter table food_import_batch
  add constraint food_import_batch_attempt_identity_unique unique (
    food_source_id,
    release_key,
    artifact_sha256,
    parser_version,
    evidence_bundle_sha256
  );

create or replace function guard_food_import_batch_update()
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
    new.release_class,
    new.evidence_bundle_sha256,
    new.evidence_bundle_uri,
    new.evidence_decision_sha256,
    new.evidence_object_version_id,
    new.evidence_valid_until,
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
    old.release_class,
    old.evidence_bundle_sha256,
    old.evidence_bundle_uri,
    old.evidence_decision_sha256,
    old.evidence_object_version_id,
    old.evidence_valid_until,
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

  if old.status <> new.status
    and new.status in ('promoting', 'completed')
    and (
      new.release_class <> 'live-reviewed'
      or new.evidence_valid_until is null
      or new.evidence_valid_until <= clock_timestamp()
    ) then
    raise exception 'only current live-reviewed evidence may enter batch status %', new.status
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
    new.release_class,
    new.evidence_bundle_sha256,
    new.evidence_bundle_uri,
    new.evidence_decision_sha256,
    new.evidence_object_version_id,
    new.evidence_valid_until,
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
    old.release_class,
    old.evidence_bundle_sha256,
    old.evidence_bundle_uri,
    old.evidence_decision_sha256,
    old.evidence_object_version_id,
    old.evidence_valid_until,
    old.created_at
  ) then
    raise exception 'food source release provenance cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.status <> 'imported' or new.status not in ('failed', 'promoted', 'quarantined') then
    raise exception 'invalid food source release status transition from % to %', old.status, new.status
      using errcode = '23514';
  end if;

  if old.status <> new.status
    and new.status = 'promoted'
    and (
      new.release_class <> 'live-reviewed'
      or new.evidence_valid_until is null
      or new.evidence_valid_until <= clock_timestamp()
    ) then
    raise exception 'only current live-reviewed evidence may promote a food source release'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create function reject_new_legacy_unbound_catalogue_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.release_class = 'legacy-unbound' then
    raise exception 'new catalogue provenance cannot be legacy-unbound'
      using errcode = '23514';
  end if;
  if new.evidence_valid_until is null
    or new.evidence_valid_until <= clock_timestamp()
    or new.evidence_valid_until > clock_timestamp() + interval '24 hours' then
    raise exception 'new catalogue evidence must be current and no more than 24 hours ahead at insertion'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger food_import_batch_reject_new_legacy_unbound
before insert on food_import_batch
for each row execute function reject_new_legacy_unbound_catalogue_evidence();

create trigger food_source_release_reject_new_legacy_unbound
before insert on food_source_release
for each row execute function reject_new_legacy_unbound_catalogue_evidence();

create function guard_new_food_source_release_authority()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'promoted'
    and (
      new.release_class <> 'live-reviewed'
      or new.evidence_valid_until is null
      or new.evidence_valid_until <= clock_timestamp()
    ) then
    raise exception 'only current live-reviewed evidence may create a promoted food source release'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger food_source_release_guard_new_authority
before insert on food_source_release
for each row execute function guard_new_food_source_release_authority();

create function guard_food_import_approval_authority()
returns trigger
language plpgsql
as $$
declare
  batch food_import_batch%rowtype;
begin
  select *
  into batch
  from food_import_batch
  where id = new.batch_id;

  if not found then
    raise exception 'food import approval references an unknown batch'
      using errcode = '23503';
  end if;

  if (
    batch.release_class <> 'live-reviewed'
    or batch.evidence_bundle_sha256 is null
    or batch.evidence_bundle_uri is null
    or batch.evidence_decision_sha256 is null
    or batch.evidence_object_version_id is null
    or batch.evidence_valid_until is null
    or batch.evidence_valid_until <= clock_timestamp()
  ) then
    raise exception 'food import approval requires current live-reviewed evidence'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger food_import_approval_guard_authority
before insert on food_import_approval
for each row execute function guard_food_import_approval_authority();

create function guard_food_source_active_release_authority()
returns trigger
language plpgsql
as $$
declare
  target_release_class text;
  target_release_status text;
begin
  if new.active_release_id is not distinct from old.active_release_id
    or new.active_release_id is null then
    return new;
  end if;

  select release_class, status
  into target_release_class, target_release_status
  from food_source_release
  where id = new.active_release_id
    and food_source_id = new.id;

  if not found then
    raise exception 'active catalogue release does not belong to the food source'
      using errcode = '23503';
  end if;

  if target_release_status <> 'promoted'
    or target_release_class <> 'live-reviewed' then
    raise exception 'only a promoted live-reviewed catalogue release may become active'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger food_source_guard_active_release_authority
before update of active_release_id on food_source
for each row execute function guard_food_source_active_release_authority();
