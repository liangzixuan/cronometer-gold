-- Standalone owner-private day notes; forward-only. Restore a reviewed backup and
-- apply the complete forward migration set; never edit an applied migration.
create table diary_day_note (
  id uuid primary key,
  user_id uuid not null,
  local_date date not null check (isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'),
  current_revision_id uuid not null,
  current_revision_number bigint not null check (current_revision_number > 0),
  state text not null check (state in ('active','cleared')),
  created_at timestamptz not null check (isfinite(created_at)),
  updated_at timestamptz not null check (isfinite(updated_at) and updated_at >= created_at),
  constraint diary_day_note_user_fk foreign key (user_id) references app_user(id) on delete cascade,
  unique (user_id,local_date), unique (id,user_id), unique (id,user_id,local_date)
);
create table diary_day_note_revision (
  id uuid primary key,
  day_note_id uuid not null,
  user_id uuid not null,
  local_date date not null,
  revision_number bigint not null check (revision_number > 0),
  supersedes_revision_id uuid,
  operation text not null check (operation in ('set','clear')),
  note text check (note is null or char_length(note) between 1 and 2000),
  recorded_time_zone text not null check (char_length(recorded_time_zone) between 1 and 63),
  created_at timestamptz not null check (isfinite(created_at)),
  constraint diary_day_note_revision_user_fk foreign key (user_id) references app_user(id) on delete cascade,
  constraint diary_day_note_revision_root_owner_date_fk foreign key (day_note_id,user_id,local_date) references diary_day_note(id,user_id,local_date) on delete cascade,
  unique (day_note_id,revision_number), unique (day_note_id,id), unique (day_note_id,id,revision_number),
  check ((operation='clear') = (note is null)),
  check ((revision_number=1 and supersedes_revision_id is null and operation='set') or (revision_number>1 and supersedes_revision_id is not null)),
  constraint diary_day_note_revision_supersedes_fk foreign key (day_note_id,supersedes_revision_id) references diary_day_note_revision(day_note_id,id) deferrable initially deferred
);
alter table diary_day_note add constraint diary_day_note_current_revision_fk foreign key (id,current_revision_id,current_revision_number)
  references diary_day_note_revision(day_note_id,id,revision_number) deferrable initially deferred;
create table diary_day_note_operation (
  user_id uuid not null,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  day_note_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload)='object'),
  created_at timestamptz not null check (isfinite(created_at)),
  primary key (user_id,client_operation_id),
  constraint diary_day_note_operation_user_fk foreign key (user_id) references app_user(id) on delete cascade,
  constraint diary_day_note_operation_root_owner_fk foreign key (day_note_id,user_id) references diary_day_note(id,user_id) on delete cascade,
  check (coalesce(result_payload #>> '{data,receipt,protocol}' = 'diary-day-note-v1',false)),
  check (coalesce(result_payload #>> '{data,receipt,operationId}' = client_operation_id::text,false)),
  check (coalesce(result_payload #>> '{data,receipt,ownerUserId}' = user_id::text,false)),
  check (coalesce(result_payload #>> '{data,note,id}' = day_note_id::text,false))
);
create index diary_day_note_revision_owner_created_idx on diary_day_note_revision(user_id,created_at,id);

create function validate_diary_day_note_revision_insert() returns trigger language plpgsql as $$
declare previous_number bigint;
begin
  if new.revision_number > 1 then
    select revision_number into previous_number from diary_day_note_revision
      where day_note_id=new.day_note_id and id=new.supersedes_revision_id and user_id=new.user_id;
    if previous_number is null or previous_number+1 <> new.revision_number then
      raise exception using errcode='23514',message='day note revisions must form a contiguous chain';
    end if;
  end if;
  return new;
end $$;
create trigger diary_day_note_revision_validate_insert before insert on diary_day_note_revision for each row execute function validate_diary_day_note_revision_insert();

create function validate_diary_day_note_zone() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=new.recorded_time_zone) then
    raise exception using errcode='23514',message='day note recording zone is invalid';
  end if;
  return new;
end $$;
create trigger diary_day_note_revision_validate_zone before insert on diary_day_note_revision for each row execute function validate_diary_day_note_zone();

create function validate_diary_day_note_head() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from diary_day_note_revision r where r.day_note_id=new.id
    and r.id=new.current_revision_id and r.revision_number=new.current_revision_number
    and r.user_id=new.user_id and r.local_date=new.local_date and r.created_at=new.updated_at
    and ((r.operation='clear')=(new.state='cleared'))) then
    raise exception using errcode='23514',message='day note head must match its immutable revision';
  end if;
  return null;
end $$;
create constraint trigger diary_day_note_head_guard after insert or update on diary_day_note deferrable initially deferred for each row execute function validate_diary_day_note_head();

create function validate_diary_day_note_latest_revision() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from diary_day_note_revision r where r.day_note_id=new.day_note_id and r.revision_number>new.revision_number)
    and not exists(select 1 from diary_day_note n where n.id=new.day_note_id and n.user_id=new.user_id
      and n.current_revision_id=new.id and n.current_revision_number=new.revision_number) then
    raise exception using errcode='23514',message='latest day note revision must become its head';
  end if;
  return null;
end $$;
create constraint trigger diary_day_note_revision_head_guard after insert on diary_day_note_revision deferrable initially deferred for each row execute function validate_diary_day_note_latest_revision();

create function guard_diary_day_note_update() returns trigger language plpgsql as $$
begin
  if new.id<>old.id or new.user_id<>old.user_id or new.local_date<>old.local_date or new.created_at<>old.created_at then
    raise exception using errcode='55000',message='day note identity cannot be rewritten';
  end if;
  if new.current_revision_number<>old.current_revision_number+1 then
    raise exception using errcode='23514',message='day note head must advance exactly once';
  end if;
  return new;
end $$;
create trigger diary_day_note_guard_update before update on diary_day_note for each row execute function guard_diary_day_note_update();
create trigger diary_day_note_revision_reject_update before update on diary_day_note_revision for each row execute function reject_immutable_row_update();
create trigger diary_day_note_operation_reject_update before update on diary_day_note_operation for each row execute function reject_immutable_row_update();
create function guard_diary_day_note_delete() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth()=1 then raise exception using errcode='55000',message='day note records may only be removed through owner erasure'; end if;
  return old;
end $$;
create trigger diary_day_note_guard_delete before delete on diary_day_note for each row execute function guard_diary_day_note_delete();
create trigger diary_day_note_revision_guard_delete before delete on diary_day_note_revision for each row execute function guard_diary_day_note_delete();
create trigger diary_day_note_operation_guard_delete before delete on diary_day_note_operation for each row execute function guard_diary_day_note_delete();
create trigger diary_day_note_revision_bump_watermark after insert on diary_day_note_revision for each row execute function bump_user_data_watermark_v3('user_id');

-- Keep the existing artifact/expiry proof, and reject old in-flight completions
-- at the database boundary. Historical completed artifacts remain historical.
create or replace function guard_privacy_export_job_completion_v3() returns trigger language plpgsql as $$
declare
  artifact_count integer;
  earliest_expiry timestamptz;
  latest_expiry timestamptz;
  format_count integer;
  actual_entities text[];
  expected_entities constant text[] := ARRAY['account','activity_day','activity_entry','activity_entry_revision','activity_operation','audit_event','biometric_definition','biometric_definition_operation','biometric_definition_version','biometric_event','biometric_event_operation','biometric_event_revision','custom_food','custom_food_catalogue_barcode','custom_food_catalogue_food','custom_food_catalogue_nutrient','custom_food_catalogue_serving','custom_food_catalogue_version','custom_food_nutrient','custom_food_operation','custom_food_version','device','diary_day','diary_day_note','diary_day_note_operation','diary_day_note_revision','diary_entry','diary_entry_legacy_nutrient','diary_entry_nutrient','diary_entry_revision','diary_entry_source','diary_operation','hydration_day','hydration_entry','hydration_entry_revision','hydration_operation','nutrition_goal','nutrition_goal_operation','nutrition_goal_target','nutrition_goal_version','platform_health_import','platform_health_import_conflict','platform_health_import_revision','platform_import_batch','platform_integration','platform_integration_version','privacy_export_artifact','privacy_export_artifact_deletion','privacy_export_artifact_tombstone','privacy_export_download_audit','privacy_export_job','profile','reauthentication_proof','recipe','recipe_ingredient','recipe_nutrient','recipe_operation','recipe_source','recipe_version','reminder_consent','reminder_consent_version','reminder_delivery','reminder_schedule','reminder_schedule_version','retention_operation','security_challenge','session','user_watermark'];
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    if jsonb_typeof(new.reconciliation) is distinct from 'object'
      or new.reconciliation->>'formatVersion' is distinct from 'nutrition-account-export-v2'
      or jsonb_typeof(new.reconciliation->'entities') is distinct from 'array' then
      raise exception using errcode='23514',message='export completion requires the current family inventory';
    end if;
    if exists(select 1 from jsonb_array_elements(new.reconciliation->'entities') item
      where jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'entity') is distinct from 'string') then
      raise exception using errcode='23514',message='export family inventory is malformed';
    end if;
    select array_agg(item->>'entity' order by (item->>'entity') collate "C") into actual_entities
      from jsonb_array_elements(new.reconciliation->'entities') item;
    if actual_entities is distinct from expected_entities then
      raise exception using errcode='23514',message='export family inventory is incomplete or duplicated';
    end if;
  end if;
  if new.status = 'completed' then
    select count(*), min(expires_at), max(expires_at),
           count(*) filter (where
             (format = 'json' and 'json' = any(new.requested_formats)) or
             (format = 'csv_zip' and 'csv' = any(new.requested_formats)))
    into artifact_count, earliest_expiry, latest_expiry, format_count
    from privacy_export_artifact where job_id = new.id;
    if artifact_count <> cardinality(new.requested_formats) or format_count <> artifact_count or
       earliest_expiry is distinct from latest_expiry or new.expires_at is distinct from earliest_expiry then
      raise exception using errcode = '23514', message = 'completed export artifact set is inconsistent';
    end if;
  end if;
  return new;
end $$;

do $migration$
declare target_schema name := pg_catalog.current_schema(); function_name text;
begin
  if target_schema is null then raise exception 'day notes migration requires a current schema'; end if;
  foreach function_name in array ARRAY['validate_diary_day_note_revision_insert','validate_diary_day_note_zone','validate_diary_day_note_head','validate_diary_day_note_latest_revision','guard_diary_day_note_update','guard_diary_day_note_delete','guard_privacy_export_job_completion_v3'] loop
    execute pg_catalog.format('alter function %I.%I() set search_path = pg_catalog, %I, pg_temp',target_schema,function_name,target_schema);
  end loop;
end;
$migration$;
