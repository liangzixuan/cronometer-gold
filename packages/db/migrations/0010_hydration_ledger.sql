create table hydration_day (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  local_date date not null check (
    isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'
  ),
  time_zone text not null check (char_length(time_zone) between 1 and 63),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  updated_at timestamptz not null default clock_timestamp() check (isfinite(updated_at)),
  constraint hydration_day_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  unique (user_id, local_date),
  unique (id, user_id)
);

create trigger hydration_day_validate_time_zone
before insert or update of time_zone on hydration_day
for each row execute function validate_iana_time_zone();

create index hydration_day_owner_date_idx
  on hydration_day (user_id, local_date desc);

create table hydration_entry (
  id uuid primary key,
  hydration_day_id uuid not null,
  user_id uuid not null,
  current_revision_id uuid not null,
  current_revision_number bigint not null check (current_revision_number > 0),
  amount_milliliters integer not null check (amount_milliliters between 1 and 20000),
  occurred_at timestamptz(3) not null check (isfinite(occurred_at)),
  local_time time(3) without time zone not null,
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  updated_at timestamptz not null default clock_timestamp() check (isfinite(updated_at)),
  deleted_at timestamptz check (deleted_at is null or isfinite(deleted_at)),
  constraint hydration_entry_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint hydration_entry_day_owner_fk
    foreign key (hydration_day_id, user_id)
    references hydration_day(id, user_id) on delete cascade,
  unique (id, user_id),
  check (deleted_at is null or deleted_at >= created_at)
);

create index hydration_entry_active_day_idx
  on hydration_entry (user_id, hydration_day_id, occurred_at, id)
  where deleted_at is null;

create table hydration_entry_revision (
  id uuid primary key,
  hydration_entry_id uuid not null,
  hydration_day_id uuid not null,
  user_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  supersedes_revision_id uuid,
  operation text not null check (operation in ('create', 'update', 'delete')),
  amount_milliliters integer not null check (amount_milliliters between 1 and 20000),
  occurred_at timestamptz(3) not null check (isfinite(occurred_at)),
  local_date date not null check (
    isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'
  ),
  local_time time(3) without time zone not null,
  time_zone text not null check (char_length(time_zone) between 1 and 63),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  constraint hydration_entry_revision_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint hydration_entry_revision_entry_owner_fk
    foreign key (hydration_entry_id, user_id)
    references hydration_entry(id, user_id) on delete cascade,
  constraint hydration_entry_revision_day_owner_fk
    foreign key (hydration_day_id, user_id)
    references hydration_day(id, user_id) on delete cascade,
  unique (hydration_entry_id, revision_number),
  unique (hydration_entry_id, id),
  unique (hydration_entry_id, id, revision_number),
  check (
    (operation = 'create' and revision_number = 1 and supersedes_revision_id is null)
    or
    (operation in ('update', 'delete') and revision_number > 1 and supersedes_revision_id is not null)
  ),
  constraint hydration_entry_revision_supersedes_fk
    foreign key (hydration_entry_id, supersedes_revision_id)
    references hydration_entry_revision(hydration_entry_id, id)
    deferrable initially deferred
);

alter table hydration_entry
  add constraint hydration_entry_current_revision_fk
    foreign key (id, current_revision_id, current_revision_number)
    references hydration_entry_revision(hydration_entry_id, id, revision_number)
    deferrable initially deferred;

create index hydration_entry_revision_owner_created_idx
  on hydration_entry_revision (user_id, created_at, id);

create trigger hydration_entry_revision_validate_time_zone
before insert or update of time_zone on hydration_entry_revision
for each row execute function validate_iana_time_zone();

create function validate_hydration_revision_insert()
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
    raise exception 'hydration local coordinates do not match occurred_at and time_zone'
      using errcode = '23514';
  end if;

  select local_date into target_local_date
  from hydration_day
  where id = new.hydration_day_id
    and user_id = new.user_id;
  if not found then
    raise exception 'hydration revision references an unavailable owner day'
      using errcode = '23503';
  end if;
  if target_local_date <> new.local_date then
    raise exception 'hydration revision local date does not match its day bucket'
      using errcode = '23514';
  end if;

  if new.operation <> 'create' then
    select revision_number into previous_revision_number
    from hydration_entry_revision
    where hydration_entry_id = new.hydration_entry_id
      and id = new.supersedes_revision_id;
    if not found or previous_revision_number + 1 <> new.revision_number then
      raise exception 'hydration revisions must form a contiguous append-only chain'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger hydration_entry_revision_validate_insert
before insert on hydration_entry_revision
for each row execute function validate_hydration_revision_insert();

create trigger hydration_entry_revision_reject_update
before update on hydration_entry_revision
for each row execute function reject_immutable_row_update();

create function guard_hydration_entry_revision_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'immutable hydration revision cannot be deleted while its entry exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger hydration_entry_revision_guard_delete
before delete on hydration_entry_revision
for each row execute function guard_hydration_entry_revision_delete();

create function validate_hydration_entry_head()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from hydration_entry_revision revision
    where revision.hydration_entry_id = new.id
      and revision.id = new.current_revision_id
      and revision.revision_number = new.current_revision_number
      and revision.user_id = new.user_id
      and revision.hydration_day_id = new.hydration_day_id
      and revision.amount_milliliters = new.amount_milliliters
      and revision.occurred_at = new.occurred_at
      and revision.local_time = new.local_time
      and ((revision.operation = 'delete') = (new.deleted_at is not null))
  ) then
    raise exception 'hydration entry head does not match its immutable current revision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger hydration_entry_head_guard
after insert or update on hydration_entry
deferrable initially deferred
for each row execute function validate_hydration_entry_head();

create function validate_hydration_revision_becomes_head()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from hydration_entry_revision later
    where later.hydration_entry_id = new.hydration_entry_id
      and later.revision_number > new.revision_number
  ) and not exists (
    select 1
    from hydration_entry entry
    where entry.id = new.hydration_entry_id
      and entry.user_id = new.user_id
      and entry.current_revision_id = new.id
      and entry.current_revision_number = new.revision_number
  ) then
    raise exception 'latest hydration revision must become the logical entry head'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger hydration_entry_revision_head_guard
after insert on hydration_entry_revision
deferrable initially deferred
for each row execute function validate_hydration_revision_becomes_head();

-- One immutable revision is appended per logical hydration mutation. Advancing the shared
-- account watermark here makes creates, updates, and tombstones visible to export snapshots.
create trigger hydration_entry_revision_bump_watermark
after insert on hydration_entry_revision
for each row execute function bump_user_data_watermark_v3('user_id');

create function guard_hydration_entry_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at then
    raise exception 'hydration entry identity cannot be rewritten'
      using errcode = '55000';
  end if;
  if old.deleted_at is not null then
    raise exception 'deleted hydration entries cannot be revised'
      using errcode = '55000';
  end if;
  if new.current_revision_number <> old.current_revision_number + 1 then
    raise exception 'hydration entry head must advance exactly one revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger hydration_entry_guard_update
before update on hydration_entry
for each row execute function guard_hydration_entry_update();

create function guard_hydration_entry_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'hydration entries may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger hydration_entry_guard_delete
before delete on hydration_entry
for each row execute function guard_hydration_entry_delete();

create function enforce_hydration_day_bounds()
returns trigger
language plpgsql
as $$
declare
  active_count integer;
  active_total bigint;
begin
  if new.deleted_at is null then
    perform pg_advisory_xact_lock(
      hashtextextended('nutrition-tracker:hydration-day:' || new.hydration_day_id::text, 0)
    );
    select count(*)::integer, coalesce(sum(amount_milliliters), 0)::bigint
      into active_count, active_total
    from hydration_entry
    where hydration_day_id = new.hydration_day_id
      and user_id = new.user_id
      and deleted_at is null;
    if active_count > 64 then
      raise exception 'hydration day exceeds 64 active entries'
        using errcode = '23514';
    end if;
    if active_total > 100000 then
      raise exception 'hydration day exceeds 100000 milliliters'
        using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;

create trigger hydration_entry_day_bounds_guard
after insert or update on hydration_entry
for each row execute function enforce_hydration_day_bounds();

create function guard_hydration_day_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
     or new.user_id <> old.user_id
     or new.local_date <> old.local_date
     or new.time_zone <> old.time_zone
     or new.created_at <> old.created_at then
    raise exception 'hydration day identity cannot be rewritten'
      using errcode = '55000';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'hydration day revision must advance exactly once'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger hydration_day_guard_update
before update on hydration_day
for each row execute function guard_hydration_day_update();

create function guard_hydration_day_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'hydration days may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger hydration_day_guard_delete
before delete on hydration_day
for each row execute function guard_hydration_day_delete();

create table hydration_operation (
  user_id uuid not null,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'update', 'delete')),
  hydration_entry_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  primary key (user_id, client_operation_id),
  constraint hydration_operation_user_fk
    foreign key (user_id) references app_user(id) on delete cascade,
  constraint hydration_operation_entry_owner_fk
    foreign key (hydration_entry_id, user_id)
    references hydration_entry(id, user_id) on delete cascade
);

create index hydration_operation_entry_idx
  on hydration_operation (user_id, hydration_entry_id, created_at desc);

create trigger hydration_operation_reject_update
before update on hydration_operation
for each row execute function reject_immutable_row_update();

create function guard_hydration_operation_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'hydration operation records may only be removed through their owner cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger hydration_operation_guard_delete
before delete on hydration_operation
for each row execute function guard_hydration_operation_delete();

comment on table hydration_day is
  'Owner-scoped profile-local hydration day used for bounded writes and synchronization.';
comment on table hydration_entry_revision is
  'Immutable exact-milliliter history, including delete tombstones and original local coordinates.';
comment on table hydration_operation is
  'Immutable owner-scoped request replay evidence for hydration mutations.';
