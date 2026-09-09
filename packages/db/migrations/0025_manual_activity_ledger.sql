-- Owner-private manual activity ledger. This migration is forward-only.
-- Recovery is to restore the pre-migration database backup and re-run the
-- complete bundled migration set; do not edit or remove an applied migration.

create table activity_day (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  local_date date not null check (
    isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'
  ),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  updated_at timestamptz not null default clock_timestamp() check (isfinite(updated_at)),
  constraint activity_day_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  unique (user_id, local_date),
  unique (id, user_id)
);

create index activity_day_owner_date_idx
  on activity_day (user_id, local_date desc);

create function is_canonical_activity_name_v1(value text)
returns boolean
language sql
immutable
strict
as $$
  select value = normalize(value, NFC)
     and char_length(value) between 1 and 120
     and octet_length(value) <= 480
     and value = btrim(value)
     and value !~ '[[:cntrl:]]'
     and value !~ '  '
     and translate(value, ' ', '') !~ '[[:space:]]'
$$;

create function is_bounded_activity_energy_v1(value numeric)
returns boolean
language sql
immutable
as $$
  select value is null or (
    value > 0 and value <= 20000 and value < 'Infinity'::numeric
    and scale(value) <= 3
    and value::text = trim_scale(value)::text
  )
$$;

create table activity_entry (
  id uuid primary key,
  activity_day_id uuid not null,
  user_id uuid not null,
  current_revision_id uuid not null,
  current_revision_number bigint not null check (current_revision_number > 0),
  name text not null check (is_canonical_activity_name_v1(name)),
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  self_reported_energy_kilocalories numeric
    check (is_bounded_activity_energy_v1(self_reported_energy_kilocalories)),
  occurred_at timestamptz(3) not null check (
    isfinite(occurred_at)
    and extract(year from (occurred_at at time zone 'UTC')) between 1 and 9999
  ),
  local_time time(3) without time zone not null,
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  updated_at timestamptz not null default clock_timestamp() check (isfinite(updated_at)),
  deleted_at timestamptz check (deleted_at is null or isfinite(deleted_at)),
  constraint activity_entry_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint activity_entry_day_owner_fk
    foreign key (activity_day_id, user_id)
    references activity_day(id, user_id) on delete cascade,
  unique (id, user_id),
  check (deleted_at is null or deleted_at >= created_at)
);

create index activity_entry_active_day_idx
  on activity_entry (user_id, activity_day_id, occurred_at, id)
  where deleted_at is null;

create table activity_entry_revision (
  id uuid primary key,
  activity_entry_id uuid not null,
  activity_day_id uuid not null,
  user_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  supersedes_revision_id uuid,
  operation text not null check (operation in ('create', 'update', 'delete')),
  name text not null check (is_canonical_activity_name_v1(name)),
  duration_minutes integer not null check (duration_minutes between 1 and 1440),
  self_reported_energy_kilocalories numeric
    check (is_bounded_activity_energy_v1(self_reported_energy_kilocalories)),
  occurred_at timestamptz(3) not null check (
    isfinite(occurred_at)
    and extract(year from (occurred_at at time zone 'UTC')) between 1 and 9999
  ),
  local_date date not null check (
    isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'
  ),
  local_time time(3) without time zone not null,
  time_zone text not null check (char_length(time_zone) between 1 and 63),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  constraint activity_entry_revision_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint activity_entry_revision_entry_owner_fk
    foreign key (activity_entry_id, user_id)
    references activity_entry(id, user_id) on delete cascade,
  constraint activity_entry_revision_day_owner_fk
    foreign key (activity_day_id, user_id)
    references activity_day(id, user_id) on delete cascade,
  unique (activity_entry_id, revision_number),
  unique (activity_entry_id, id),
  unique (activity_entry_id, id, revision_number),
  check (
    (operation = 'create' and revision_number = 1 and supersedes_revision_id is null)
    or
    (operation in ('update', 'delete') and revision_number > 1 and supersedes_revision_id is not null)
  ),
  constraint activity_entry_revision_supersedes_fk
    foreign key (activity_entry_id, supersedes_revision_id)
    references activity_entry_revision(activity_entry_id, id)
    deferrable initially deferred
);

alter table activity_entry
  add constraint activity_entry_current_revision_fk
    foreign key (id, current_revision_id, current_revision_number)
    references activity_entry_revision(activity_entry_id, id, revision_number)
    deferrable initially deferred;

create index activity_entry_revision_owner_created_idx
  on activity_entry_revision (user_id, created_at, id);

create trigger activity_entry_revision_validate_time_zone
before insert or update of time_zone on activity_entry_revision
for each row execute function validate_iana_time_zone();

create function validate_activity_revision_insert()
returns trigger
language plpgsql
as $$
declare
  previous_revision_number bigint;
  derived_local timestamp without time zone;
  target_local_date date;
begin
  derived_local := new.occurred_at at time zone new.time_zone;
  if derived_local::date <> new.local_date
     or derived_local::time(3) <> new.local_time then
    raise exception 'activity local coordinates do not match occurred_at and time_zone'
      using errcode = '23514';
  end if;

  select local_date into target_local_date
  from activity_day
  where id = new.activity_day_id
    and user_id = new.user_id;
  if not found then
    raise exception 'activity revision references an unavailable owner day'
      using errcode = '23503';
  end if;
  if target_local_date <> new.local_date then
    raise exception 'activity revision local date does not match its day bucket'
      using errcode = '23514';
  end if;

  if new.operation <> 'create' then
    select revision_number into previous_revision_number
    from activity_entry_revision
    where activity_entry_id = new.activity_entry_id
      and id = new.supersedes_revision_id;
    if not found or previous_revision_number + 1 <> new.revision_number then
      raise exception 'activity revisions must form a contiguous append-only chain'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger activity_entry_revision_validate_insert
before insert on activity_entry_revision
for each row execute function validate_activity_revision_insert();

create trigger activity_entry_revision_reject_update
before update on activity_entry_revision
for each row execute function reject_immutable_row_update();

create function guard_activity_entry_revision_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'immutable activity revision cannot be deleted while its entry exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger activity_entry_revision_guard_delete
before delete on activity_entry_revision
for each row execute function guard_activity_entry_revision_delete();

create function validate_activity_entry_head()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from activity_entry_revision revision
    where revision.activity_entry_id = new.id
      and revision.id = new.current_revision_id
      and revision.revision_number = new.current_revision_number
      and revision.user_id = new.user_id
      and revision.activity_day_id = new.activity_day_id
      and revision.name = new.name
      and revision.duration_minutes = new.duration_minutes
      and revision.self_reported_energy_kilocalories
          is not distinct from new.self_reported_energy_kilocalories
      and revision.occurred_at = new.occurred_at
      and revision.local_time = new.local_time
      and ((revision.operation = 'delete') = (new.deleted_at is not null))
  ) then
    raise exception 'activity entry head does not match its immutable current revision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger activity_entry_head_guard
after insert or update on activity_entry
deferrable initially deferred
for each row execute function validate_activity_entry_head();

create function validate_activity_revision_becomes_head()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from activity_entry_revision later
    where later.activity_entry_id = new.activity_entry_id
      and later.revision_number > new.revision_number
  ) and not exists (
    select 1
    from activity_entry entry
    where entry.id = new.activity_entry_id
      and entry.user_id = new.user_id
      and entry.current_revision_id = new.id
      and entry.current_revision_number = new.revision_number
  ) then
    raise exception 'latest activity revision must become the logical entry head'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger activity_entry_revision_head_guard
after insert on activity_entry_revision
deferrable initially deferred
for each row execute function validate_activity_revision_becomes_head();

create trigger activity_entry_revision_bump_watermark
after insert on activity_entry_revision
for each row execute function bump_user_data_watermark_v3('user_id');

create function guard_activity_entry_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at then
    raise exception 'activity entry identity cannot be rewritten'
      using errcode = '55000';
  end if;
  if old.deleted_at is not null then
    raise exception 'deleted activity entries cannot be revised'
      using errcode = '55000';
  end if;
  if new.current_revision_number <> old.current_revision_number + 1 then
    raise exception 'activity entry head must advance exactly one revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger activity_entry_guard_update
before update on activity_entry
for each row execute function guard_activity_entry_update();

create function guard_activity_entry_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'activity entries may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger activity_entry_guard_delete
before delete on activity_entry
for each row execute function guard_activity_entry_delete();

create function enforce_activity_day_bounds()
returns trigger
language plpgsql
as $$
declare
  active_count integer;
begin
  if new.deleted_at is null then
    perform pg_advisory_xact_lock(
      hashtextextended('nutrition-tracker:activity-day:' || new.activity_day_id::text, 0)
    );
    select count(*)::integer into active_count
    from activity_entry
    where activity_day_id = new.activity_day_id
      and user_id = new.user_id
      and deleted_at is null;
    if active_count > 64 then
      raise exception 'activity day exceeds 64 active entries'
        using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;

create trigger activity_entry_day_bounds_guard
after insert or update on activity_entry
for each row execute function enforce_activity_day_bounds();

create function guard_activity_day_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
     or new.user_id <> old.user_id
     or new.local_date <> old.local_date
     or new.created_at <> old.created_at then
    raise exception 'activity day identity cannot be rewritten'
      using errcode = '55000';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'activity day revision must advance exactly once'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger activity_day_guard_update
before update on activity_day
for each row execute function guard_activity_day_update();

create function guard_activity_day_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'activity days may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger activity_day_guard_delete
before delete on activity_day
for each row execute function guard_activity_day_delete();

create table activity_operation (
  user_id uuid not null,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'update', 'delete')),
  activity_entry_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  primary key (user_id, client_operation_id),
  constraint activity_operation_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint activity_operation_entry_owner_fk
    foreign key (activity_entry_id, user_id)
    references activity_entry(id, user_id) on delete cascade
);

create index activity_operation_entry_idx
  on activity_operation (user_id, activity_entry_id, created_at desc);

create trigger activity_operation_reject_update
before update on activity_operation
for each row execute function reject_immutable_row_update();

create function guard_activity_operation_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'activity operation records may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger activity_operation_guard_delete
before delete on activity_operation
for each row execute function guard_activity_operation_delete();

do $migration$
declare
  target_schema name := pg_catalog.current_schema();
begin
  if target_schema is null then
    raise exception 'manual activity migration requires a current schema'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'alter function %I.is_canonical_activity_name_v1(text) set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.is_bounded_activity_energy_v1(numeric) set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.validate_activity_revision_insert() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_entry_revision_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.validate_activity_entry_head() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.validate_activity_revision_becomes_head() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_entry_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_entry_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.enforce_activity_day_bounds() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_day_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_day_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.guard_activity_operation_delete() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
end;
$migration$;

comment on table activity_day is
  'Owner-scoped profile-local activity start day used for bounded writes and synchronization.';
comment on table activity_entry_revision is
  'Immutable manual activity history; optional energy is self-reported and never adjusts goals or energy balance.';
comment on table activity_operation is
  'Immutable owner-scoped request replay evidence for manual activity mutations.';
