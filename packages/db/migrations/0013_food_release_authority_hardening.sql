-- Align the manifest, application, and database evidence boundaries and close
-- direct-insert authority shortcuts. Preserve 0011/0012 checksums: this is a
-- forward-only hardening migration.
-- Recovery: restore the pre-migration database backup; do not attempt reverse
-- DDL against partially upgraded authority state.

create or replace function catalogue_evidence_bundle_uri_is_valid(value text, digest text)
returns boolean
language sql
immutable
strict
as $$
  select case
    when digest !~ '^[0-9a-f]{64}$' then false
    else octet_length(value) <= 2048
      and value ~ (
        '^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/'
        || '([A-Za-z0-9_-][A-Za-z0-9._~-]*/)*sha256/'
        || digest
        || '(/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*$'
      )
      and split_part(value, '/', 3) !~ '\.\.'
      and split_part(value, '/', 3) !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
  end;
$$;

do $$
begin
  if exists (
    select 1
    from food_import_batch
    where evidence_bundle_uri is not null
      and not catalogue_evidence_bundle_uri_is_valid(
        evidence_bundle_uri,
        evidence_bundle_sha256
      )
  ) then
    raise exception 'existing food import batch has a non-canonical evidence bundle URI'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from food_source_release
    where evidence_bundle_uri is not null
      and not catalogue_evidence_bundle_uri_is_valid(
        evidence_bundle_uri,
        evidence_bundle_sha256
      )
  ) then
    raise exception 'existing food source release has a non-canonical evidence bundle URI'
      using errcode = '23514';
  end if;
end;
$$;

alter table food_import_batch
  add constraint food_import_batch_evidence_object_version_id_check check (
    evidence_object_version_id is null
    or (
      octet_length(evidence_object_version_id) <= 512
      and evidence_object_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._~+/:@=-]*$'
    )
  );

alter table food_source_release
  add constraint food_source_release_evidence_object_version_id_check check (
    evidence_object_version_id is null
    or (
      octet_length(evidence_object_version_id) <= 512
      and evidence_object_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._~+/:@=-]*$'
    )
  );

create function guard_food_import_batch_initial_state()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'staging' then
    raise exception 'new food import batch must begin in staging'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger food_import_batch_guard_initial_state
before insert on food_import_batch
for each row execute function guard_food_import_batch_initial_state();

create function guard_food_source_release_initial_state()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'imported' then
    raise exception 'new food source release must begin imported'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger food_source_release_guard_initial_state
before insert on food_source_release
for each row execute function guard_food_source_release_initial_state();

-- A deferred (food_source.id, active_release_id) foreign key permits the
-- referenced release to be inserted later in the same transaction. Require a
-- new source to begin without an active pointer so fixture releases cannot use
-- that ordering to bypass the UPDATE authority guard.
create function guard_food_source_initial_active_release()
returns trigger
language plpgsql
as $$
begin
  if new.active_release_id is not null then
    raise exception 'new food source must start without an active catalogue release'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger food_source_guard_initial_active_release
before insert on food_source
for each row execute function guard_food_source_initial_active_release();
