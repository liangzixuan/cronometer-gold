-- Account credentials, opaque sessions, and the append-only diary write model.
-- Supported legacy food rows remain readable and are migrated into revision 1.
-- The public diary contract is deliberately food-only and source-backed. Abort
-- before any DDL when an active legacy row cannot satisfy that contract; operators
-- must export/remediate those rows before retrying this forward migration.

do $$
declare
  invalid_count bigint;
  active_nutrient_count bigint;
begin
  select count(*) into invalid_count
  from app_user
  where char_length(email) > 254
     or email is distinct from normalize(email, NFKC)
     or email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$';
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 account upgrade blocked: %s legacy emails exceed the normalized authentication contract',
        invalid_count
      );
  end if;

  select count(*) into invalid_count
  from diary day
  where not (
    isfinite(day.local_date)
    and day.local_date between date '0001-01-01' and date '9999-12-31'
    and isfinite(day.updated_at)
    and extract(year from (day.updated_at at time zone 'UTC')) between 1 and 9999
    and octet_length(day.time_zone) between 1 and 63
    and exists (select 1 from pg_timezone_names zone where zone.name = day.time_zone)
  );
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary-day upgrade blocked: %s legacy diary days exceed date, timestamp, or IANA time-zone bounds',
        invalid_count
      );
  end if;

  select count(*) into invalid_count
  from user_profile profile
  where not coalesce(
    (
      profile.display_name is null
      or (
        length(btrim(profile.display_name)) > 0
        and char_length(profile.display_name) <= 100
        and octet_length(profile.display_name) <= 300
      )
    )
    and (
      profile.birth_date is null
      or (
        isfinite(profile.birth_date)
        and profile.birth_date between date '0001-01-01' and date '9999-12-31'
      )
    )
    and (
      profile.activity_level_code is null
      or (
        char_length(profile.activity_level_code) <= 64
        and profile.activity_level_code ~ '^[a-z][a-z0-9_]*$'
      )
    )
    and char_length(profile.locale) between 2 and 35
    and char_length(profile.time_zone) between 1 and 63
    and exists (select 1 from pg_timezone_names zone where zone.name = profile.time_zone)
    and (
      profile.onboarding_completed_at is null
      or (
        isfinite(profile.onboarding_completed_at)
        and extract(year from (profile.onboarding_completed_at at time zone 'UTC')) between 1 and 9999
      )
    )
    and (
      profile.wellness_disclaimer_acknowledged_at is null
      or (
        isfinite(profile.wellness_disclaimer_acknowledged_at)
        and extract(year from (profile.wellness_disclaimer_acknowledged_at at time zone 'UTC')) between 1 and 9999
      )
    ),
    false
  );
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 profile upgrade blocked: %s legacy profiles exceed the public profile contract',
        invalid_count
      ),
      hint = 'Remediate display name, birth date, activity code, locale, time zone, or timestamp bounds before retrying.';
  end if;

  select count(*) into invalid_count
  from (
    select version.id::text as identity
    from food_version version
    where not (version.basis_quantity > 0 and version.basis_quantity < 'Infinity'::numeric)
    union all
    select value.food_version_id::text || ':' || value.nutrient_id::text
    from food_nutrient_value value
    where not (
      value.amount >= 0 and value.amount < 'Infinity'::numeric
      and value.basis_quantity > 0 and value.basis_quantity < 'Infinity'::numeric
      and (value.source_amount is null
        or (value.source_amount >= 0 and value.source_amount < 'Infinity'::numeric))
      and (value.source_basis_quantity is null
        or (value.source_basis_quantity > 0 and value.source_basis_quantity < 'Infinity'::numeric))
    )
    union all
    select serving.id::text
    from food_serving serving
    where not (
      serving.quantity > 0 and serving.quantity < 'Infinity'::numeric
      and (serving.gram_weight is null
        or (serving.gram_weight > 0 and serving.gram_weight < 'Infinity'::numeric))
      and (serving.milliliter_volume is null
        or (serving.milliliter_volume > 0 and serving.milliliter_volume < 'Infinity'::numeric))
    )
    union all
    select snapshot.diary_entry_id::text || ':' || snapshot.nutrient_id::text
    from diary_entry_nutrient_snapshot snapshot
    where not (snapshot.amount >= 0 and snapshot.amount < 'Infinity'::numeric)
  ) invalid_numeric;
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 numeric upgrade blocked: %s legacy catalogue or diary values are non-finite',
        invalid_count
      ),
      hint = 'Export and remediate numeric NaN/Infinity values before retrying.';
  end if;

  select count(*) into invalid_count
  from nutrient
  where char_length(btrim(name)) = 0
     or char_length(name) > 200
     or char_length(canonical_unit) not between 1 and 32
     or canonical_unit not in ('kcal', 'kJ', 'g', 'mg', 'ug', 'IU', 'mg_NE', 'ug_DFE', 'ug_RAE');
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 nutrient registry upgrade blocked: %s nutrient definitions exceed the diary contract',
        invalid_count
      ),
      hint = 'Use a nonblank name of at most 200 characters and a supported canonical unit of at most 32 characters.';
  end if;

  select count(*) into active_nutrient_count from nutrient where active;
  if active_nutrient_count > 256 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 nutrient registry upgrade blocked: %s active nutrients exceed the 256-element diary vector limit',
        active_nutrient_count
      );
  end if;

  select count(*) into invalid_count
  from diary_entry_nutrient_snapshot snapshot
  join nutrient on nutrient.id = snapshot.nutrient_id
  where snapshot.unit is distinct from nutrient.canonical_unit
     or char_length(snapshot.unit) not between 1 and 32
     or snapshot.unit not in ('kcal', 'kJ', 'g', 'mg', 'ug', 'IU', 'mg_NE', 'ug_DFE', 'ug_RAE')
     or char_length(nutrient.name) not between 1 and 200;
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary snapshot upgrade blocked: %s legacy nutrient snapshots have incompatible names or units',
        invalid_count
      ),
      hint = 'Snapshot units must exactly equal the referenced nutrient canonical unit and use the supported unit vocabulary.';
  end if;

  select count(*) into invalid_count
  from diary_entry entry
  join diary day on day.id = entry.diary_id and day.user_id = entry.user_id
  left join food_version version on version.id = entry.food_version_id
  left join food food_record on food_record.id = version.food_id
  left join food_source source on source.id = food_record.food_source_id
  left join food_serving serving
    on serving.id = entry.food_serving_id
   and serving.food_version_id = entry.food_version_id
  where not coalesce(
    entry.position between 0 and 1000000
    and isfinite(day.local_date)
    and day.local_date between date '0001-01-01' and date '9999-12-31'
    and isfinite(day.updated_at)
    and extract(year from (day.updated_at at time zone 'UTC')) between 1 and 9999
    and isfinite(entry.occurred_at)
    and extract(year from (entry.occurred_at at time zone 'UTC')) between 1 and 9999
    and isfinite(entry.created_at)
    and extract(year from (entry.created_at at time zone 'UTC')) between 1 and 9999
    and octet_length(day.time_zone) between 1 and 63
    and exists (select 1 from pg_timezone_names zone where zone.name = day.time_zone)
    and (entry.note is null or octet_length(entry.note) <= 10000)
    and (entry.input_unit is null or octet_length(entry.input_unit) between 1 and 80)
    and (entry.quantity is null
      or (entry.quantity > 0 and entry.quantity < 'Infinity'::numeric))
    and (entry.resolved_grams is null
      or (entry.resolved_grams > 0 and entry.resolved_grams < 'Infinity'::numeric))
    and octet_length(coalesce(entry.snapshot_engine_version, 'legacy-v1')) between 1 and 100
    and (
      version.brand_name is null
      or (length(btrim(version.brand_name)) > 0 and octet_length(version.brand_name) <= 300)
    )
    and (source.code is null or source.code ~ '^[A-Z][A-Z0-9_]{1,31}$')
    and (source.display_name is null or octet_length(source.display_name) <= 200)
    and (source.license_expression is null or octet_length(source.license_expression) <= 256)
    and (source.attribution_text is null or octet_length(source.attribution_text) <= 2000)
    and (serving.label is null or octet_length(serving.label) <= 300)
    and (
      (
        entry.entry_kind = 'food'
        and version.id is not null
        and octet_length(version.name) between 1 and 500
        and entry.quantity is not null
        and coalesce(entry.resolved_grams, entry.quantity) is not null
      )
      or (
        entry.entry_kind = 'recipe'
        and entry.recipe_version_id is not null
        and entry.quantity is not null
      )
      or entry.entry_kind in ('note', 'quick_add')
    )
    and (
      (
        select count(*)
        from diary_entry_nutrient_snapshot legacy_snapshot
        where legacy_snapshot.diary_entry_id = entry.id
      ) <= 256
    )
    and (
      entry.entry_kind not in ('food', 'recipe', 'quick_add')
      or (
        select count(*)
        from (
          select legacy_snapshot.nutrient_id
          from diary_entry_nutrient_snapshot legacy_snapshot
          where legacy_snapshot.diary_entry_id = entry.id
          union
          select active_nutrient.id
          from nutrient active_nutrient
          where active_nutrient.active
        ) vector
      ) <= 256
    ),
    false
  );
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary structural upgrade blocked: %s legacy entries cannot fit the immutable revision schema',
        invalid_count
      ),
      hint = 'All rows, including deleted tombstones, must satisfy immutable field, position, time-zone, and 256-nutrient vector bounds.';
  end if;

  select count(*) into invalid_count
  from (
    select entry.diary_id
    from diary_entry entry
    where entry.deleted_at is null
    group by entry.diary_id
    having count(*) > 50
  ) overfull_day;
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary upgrade blocked: %s active legacy days exceed the 50-entry beta response limit',
        invalid_count
      );
  end if;

  select count(*) into invalid_count
  from (
    select vectors.diary_id
    from (
      select entry.diary_id, snapshot.nutrient_id
      from diary_entry entry
      join diary_entry_nutrient_snapshot snapshot on snapshot.diary_entry_id = entry.id
      where entry.deleted_at is null
      union
      select entry.diary_id, nutrient.id
      from diary_entry entry
      cross join nutrient
      where entry.deleted_at is null
        and entry.entry_kind in ('food', 'recipe', 'quick_add')
        and nutrient.active
    ) vectors
    group by vectors.diary_id
    having count(*) > 256
  ) overwide_day;
  if invalid_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary upgrade blocked: %s active legacy days exceed the 256-nutrient union limit',
        invalid_count
      );
  end if;
end;
$$;

do $$
declare
  incompatible_count bigint;
  incompatible_sample text;
begin
  select count(*)
  into incompatible_count
  from diary_entry entry
  join diary day on day.id = entry.diary_id and day.user_id = entry.user_id
  left join user_profile profile on profile.user_id = entry.user_id
  left join food_version version on version.id = entry.food_version_id
  left join food food_record on food_record.id = version.food_id
  left join food_source source on source.id = food_record.food_source_id
  left join food_source_release release
    on release.id = version.source_release_id
   and release.food_source_id = source.id
  left join food_serving serving
    on serving.id = entry.food_serving_id
   and serving.food_version_id = entry.food_version_id
  where entry.deleted_at is null
    and not coalesce(
      entry.entry_kind = 'food'
      and version.id is not null
      and food_record.kind in ('branded', 'generic')
      and food_record.owner_user_id is null
      and food_record.visibility = 'public'
      and source.id is not null
      and release.id is not null
      and entry.quantity is not null
      and entry.input_unit is not null
      and octet_length(entry.input_unit) between 1 and 80
      and entry.resolved_grams is not null
      and (
        (
          entry.food_serving_id is null
          and entry.input_unit = 'g'
          and entry.quantity = entry.resolved_grams
        )
        or (
          entry.food_serving_id is not null
          and serving.id is not null
          and serving.gram_weight is not null
          and entry.input_unit = 'serving'
          and entry.resolved_grams = entry.quantity * serving.gram_weight
        )
      )
      and octet_length(version.name) between 1 and 500
      and (
        version.brand_name is null
        or (length(btrim(version.brand_name)) > 0 and octet_length(version.brand_name) <= 300)
      )
      and octet_length(source.display_name) between 1 and 200
      and octet_length(source.license_expression) between 1 and 256
      and octet_length(source.attribution_text) between 1 and 2000
      and (serving.id is null or octet_length(serving.label) <= 300)
      and (entry.note is null or octet_length(entry.note) <= 10000)
      and octet_length(day.time_zone) between 1 and 63
      and exists (select 1 from pg_timezone_names zone where zone.name = day.time_zone)
      and profile.user_id is not null
      and exists (select 1 from pg_timezone_names zone where zone.name = profile.time_zone),
      false
    );

  if incompatible_count > 0 then
    select string_agg(sample.id::text, ', ' order by sample.id::text)
    into incompatible_sample
    from (
      select entry.id
      from diary_entry entry
      join diary day on day.id = entry.diary_id and day.user_id = entry.user_id
      left join user_profile profile on profile.user_id = entry.user_id
      left join food_version version on version.id = entry.food_version_id
      left join food food_record on food_record.id = version.food_id
      left join food_source source on source.id = food_record.food_source_id
      left join food_source_release release
        on release.id = version.source_release_id
       and release.food_source_id = source.id
      left join food_serving serving
        on serving.id = entry.food_serving_id
       and serving.food_version_id = entry.food_version_id
      where entry.deleted_at is null
        and not coalesce(
          entry.entry_kind = 'food'
          and version.id is not null
          and food_record.kind in ('branded', 'generic')
          and food_record.owner_user_id is null
          and food_record.visibility = 'public'
          and source.id is not null
          and release.id is not null
          and entry.quantity is not null
          and entry.input_unit is not null
          and octet_length(entry.input_unit) between 1 and 80
          and entry.resolved_grams is not null
          and (
            (
              entry.food_serving_id is null
              and entry.input_unit = 'g'
              and entry.quantity = entry.resolved_grams
            )
            or (
              entry.food_serving_id is not null
              and serving.id is not null
              and serving.gram_weight is not null
              and entry.input_unit = 'serving'
              and entry.resolved_grams = entry.quantity * serving.gram_weight
            )
          )
          and octet_length(version.name) between 1 and 500
          and (
            version.brand_name is null
            or (length(btrim(version.brand_name)) > 0 and octet_length(version.brand_name) <= 300)
          )
          and octet_length(source.display_name) between 1 and 200
          and octet_length(source.license_expression) between 1 and 256
          and octet_length(source.attribution_text) between 1 and 2000
          and (serving.id is null or octet_length(serving.label) <= 300)
          and (entry.note is null or octet_length(entry.note) <= 10000)
          and octet_length(day.time_zone) between 1 and 63
          and exists (select 1 from pg_timezone_names zone where zone.name = day.time_zone)
          and profile.user_id is not null
          and exists (select 1 from pg_timezone_names zone where zone.name = profile.time_zone),
          false
        )
      order by entry.id
      limit 5
    ) sample;

    raise exception using
      errcode = 'P0001',
      message = format(
        '0004 diary upgrade blocked: %s active legacy diary entries are incompatible with the source-backed food diary contract',
        incompatible_count
      ),
      detail = format('Example entry IDs: %s', coalesce(incompatible_sample, '(unavailable)')),
      hint = 'Export or remediate active note, quick-add, recipe, custom/source-less food, ambiguous or inconsistent portion, and malformed food rows before retrying. Deleted unsupported rows may remain as tombstones.';
  end if;
end;
$$;

-- New code treats diary_entry as the logical identity and
-- diary_entry_revision as immutable content.

create table user_password_credential (
  user_id uuid primary key references app_user(id) on delete cascade,
  password_hash text not null check (octet_length(password_hash) between 16 and 1024),
  password_salt text not null check (octet_length(password_salt) between 16 and 512),
  password_parameters jsonb not null check (jsonb_typeof(password_parameters) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create trigger user_password_credential_set_updated_at
before update on user_password_credential
for each row execute function set_row_updated_at();

create table user_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  user_agent text check (user_agent is null or octet_length(user_agent) <= 1024),
  ip_address inet,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index user_session_user_active_idx
  on user_session (user_id, expires_at desc)
  where revoked_at is null;

alter table app_user
  add constraint app_user_auth_email_contract_check check (
    char_length(email) <= 254
    and email = normalize(email, NFKC)
    and email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
  );

alter table diary
  add constraint diary_public_local_date_check
    check (isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'),
  add constraint diary_public_updated_at_check
    check (
      isfinite(updated_at)
      and extract(year from (updated_at at time zone 'UTC')) between 1 and 9999
    );

alter table user_profile
  add column revision bigint not null default 0 check (revision >= 0),
  add constraint user_profile_display_name_bytes_check
    check (
      display_name is null
      or (
        length(btrim(display_name)) > 0
        and char_length(display_name) <= 100
        and octet_length(display_name) <= 300
      )
    ),
  add constraint user_profile_birth_date_public_range_check
    check (
      birth_date is null
      or (isfinite(birth_date) and birth_date between date '0001-01-01' and date '9999-12-31')
    ),
  add constraint user_profile_activity_level_public_check
    check (
      activity_level_code is null
      or (char_length(activity_level_code) <= 64 and activity_level_code ~ '^[a-z][a-z0-9_]*$')
    ),
  add constraint user_profile_onboarding_public_range_check
    check (
      onboarding_completed_at is null
      or (
        isfinite(onboarding_completed_at)
        and extract(year from (onboarding_completed_at at time zone 'UTC')) between 1 and 9999
      )
    ),
  add constraint user_profile_wellness_public_range_check
    check (
      wellness_disclaimer_acknowledged_at is null
      or (
        isfinite(wellness_disclaimer_acknowledged_at)
        and extract(year from (wellness_disclaimer_acknowledged_at at time zone 'UTC')) between 1 and 9999
      )
    );

alter table nutrient
  add constraint nutrient_public_name_check
    check (char_length(btrim(name)) > 0 and char_length(name) <= 200),
  add constraint nutrient_diary_unit_check
    check (
      char_length(canonical_unit) between 1 and 32
      and canonical_unit in ('kcal', 'kJ', 'g', 'mg', 'ug', 'IU', 'mg_NE', 'ug_DFE', 'ug_RAE')
    );

alter table food_version
  add constraint food_version_finite_basis_check
    check (basis_quantity > 0 and basis_quantity < 'Infinity'::numeric);

alter table food_nutrient_value
  add constraint food_nutrient_value_finite_amount_check
    check (amount >= 0 and amount < 'Infinity'::numeric),
  add constraint food_nutrient_value_finite_basis_check
    check (basis_quantity > 0 and basis_quantity < 'Infinity'::numeric),
  add constraint food_nutrient_value_finite_source_amount_check
    check (source_amount is null or (source_amount >= 0 and source_amount < 'Infinity'::numeric)),
  add constraint food_nutrient_value_finite_source_basis_check
    check (
      source_basis_quantity is null
      or (source_basis_quantity > 0 and source_basis_quantity < 'Infinity'::numeric)
    );

alter table food_serving
  add constraint food_serving_finite_quantity_check
    check (quantity > 0 and quantity < 'Infinity'::numeric),
  add constraint food_serving_finite_gram_weight_check
    check (gram_weight is null or (gram_weight > 0 and gram_weight < 'Infinity'::numeric)),
  add constraint food_serving_finite_volume_check
    check (
      milliliter_volume is null
      or (milliliter_volume > 0 and milliliter_volume < 'Infinity'::numeric)
    );

create function lock_active_nutrient_registry_before_write()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nutrition-tracker:active-nutrient-registry:v1'));
  return null;
end;
$$;

create trigger nutrient_registry_lock_before_insert
before insert on nutrient
for each statement execute function lock_active_nutrient_registry_before_write();

create trigger nutrient_registry_lock_before_active_update
before update of active on nutrient
for each statement execute function lock_active_nutrient_registry_before_write();

create function guard_active_nutrient_vector_size()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nutrition-tracker:active-nutrient-registry:v1'));
  if (select count(*) from nutrient where active) > 256 then
    raise exception 'active nutrient registry exceeds the 256-element diary vector limit'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger nutrient_active_vector_size_guard
after insert or update of active on nutrient
deferrable initially immediate
for each row execute function guard_active_nutrient_vector_size();

create function validate_food_version_child_insert()
returns trigger
language plpgsql
as $$
declare
  discovered_food_id bigint;
  discovered_source_id bigint;
  discovered_release_id uuid;
  discovered_kind text;
  locked_release_status text;
begin
  select version.food_id, version.source_release_id, food.food_source_id, food.kind
    into discovered_food_id, discovered_release_id, discovered_source_id, discovered_kind
  from food_version version
  join food on food.id = version.food_id
  where version.id = new.food_version_id;
  if not found then
    raise exception 'food-version child references an unavailable version' using errcode = '23503';
  end if;

  if discovered_release_id is null then
    perform 1
    from food
    where id = discovered_food_id
      and kind = 'custom'
      and food_source_id is null
    for share;
    if not found or discovered_kind <> 'custom' then
      raise exception 'source-backed food-version child requires an imported release'
        using errcode = '55000';
    end if;
    perform 1
    from food_version
    where id = new.food_version_id
      and food_id = discovered_food_id
      and source_release_id is null
    for share;
    if not found then
      raise exception 'custom food version changed during child materialization'
        using errcode = '40001';
    end if;
    return new;
  end if;

  if discovered_source_id is null then
    raise exception 'source-backed food-version child has no source' using errcode = '55000';
  end if;

  -- Match catalogue promotion order: source -> food -> version -> release.
  perform 1 from food_source where id = discovered_source_id for share;
  if not found then
    raise exception 'food source disappeared during child materialization' using errcode = '40001';
  end if;
  perform 1
  from food
  where id = discovered_food_id
    and food_source_id = discovered_source_id
  for share;
  if not found then
    raise exception 'food changed during child materialization' using errcode = '40001';
  end if;
  perform 1
  from food_version
  where id = new.food_version_id
    and food_id = discovered_food_id
    and source_release_id = discovered_release_id
  for share;
  if not found then
    raise exception 'food version changed during child materialization' using errcode = '40001';
  end if;
  select status into locked_release_status
  from food_source_release
  where id = discovered_release_id
    and food_source_id = discovered_source_id
  for share;
  if not found then
    raise exception 'food release disappeared during child materialization' using errcode = '40001';
  end if;
  if locked_release_status <> 'imported' then
    raise exception 'food-version children may only be inserted while their release is imported'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger food_nutrient_value_validate_insert
before insert on food_nutrient_value
for each row execute function validate_food_version_child_insert();

create trigger food_serving_validate_insert
before insert on food_serving
for each row execute function validate_food_version_child_insert();

comment on table food_nutrient_value is
  'Immutable after insert; source-backed children may only materialize while their release is imported.';
comment on table food_serving is
  'Immutable after insert; source-backed children may only materialize while their release is imported.';

create function validate_iana_time_zone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'unknown IANA time zone: %', new.time_zone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger user_profile_validate_time_zone
before insert or update of time_zone on user_profile
for each row execute function validate_iana_time_zone();

create trigger diary_validate_time_zone
before insert or update of time_zone on diary
for each row execute function validate_iana_time_zone();

alter table diary_entry
  alter column quantity type numeric,
  alter column resolved_grams type numeric,
  add constraint diary_entry_position_public_check check (position between 0 and 1000000),
  add constraint diary_entry_quantity_finite_check
    check (quantity is null or (quantity > 0 and quantity < 'Infinity'::numeric)),
  add constraint diary_entry_resolved_grams_finite_check
    check (
      resolved_grams is null
      or (resolved_grams > 0 and resolved_grams < 'Infinity'::numeric)
    ),
  add constraint diary_entry_occurred_at_public_check
    check (
      isfinite(occurred_at)
      and extract(year from (occurred_at at time zone 'UTC')) between 1 and 9999
    ),
  add constraint diary_entry_created_at_public_check
    check (
      isfinite(created_at)
      and extract(year from (created_at at time zone 'UTC')) between 1 and 9999
    );

create table diary_entry_revision (
  id uuid primary key default gen_random_uuid(),
  diary_entry_id uuid not null references diary_entry(id) on delete cascade,
  diary_id uuid not null,
  user_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  operation text not null check (operation in ('create', 'update', 'move', 'delete')),
  entry_kind text not null check (entry_kind in ('food', 'note', 'quick_add', 'recipe')),
  food_version_id bigint references food_version(id) on delete restrict,
  recipe_version_id uuid references recipe_version(id) on delete restrict,
  food_serving_id bigint references food_serving(id) on delete restrict,
  meal_slot text not null check (meal_slot in ('breakfast', 'lunch', 'dinner', 'snacks')),
  quantity numeric check (
    quantity is null or (quantity > 0 and quantity < 'Infinity'::numeric)
  ),
  input_unit text check (input_unit is null or octet_length(input_unit) between 1 and 80),
  resolved_quantity numeric check (
    resolved_quantity is null
    or (resolved_quantity > 0 and resolved_quantity < 'Infinity'::numeric)
  ),
  resolved_unit text check (resolved_unit is null or resolved_unit in ('g', 'ml', 'serving')),
  occurred_at timestamptz not null,
  local_date date not null,
  local_time time without time zone not null,
  time_zone text not null check (octet_length(time_zone) between 1 and 63),
  position integer not null default 0 check (position between 0 and 1000000),
  note text check (note is null or octet_length(note) <= 10000),
  food_name text check (food_name is null or octet_length(food_name) between 1 and 500),
  brand_name text check (brand_name is null or octet_length(brand_name) <= 300),
  source_code text check (source_code is null or source_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  source_release_id uuid references food_source_release(id) on delete restrict,
  source_display_name text check (source_display_name is null or octet_length(source_display_name) <= 200),
  license_expression text check (license_expression is null or octet_length(license_expression) <= 256),
  attribution_required boolean,
  attribution_text text check (attribution_text is null or octet_length(attribution_text) <= 2000),
  serving_label text check (serving_label is null or octet_length(serving_label) <= 300),
  snapshot_status text not null check (snapshot_status in ('complete', 'partial')),
  snapshot_engine_version text not null check (octet_length(snapshot_engine_version) between 1 and 100),
  nutrient_component_count integer not null check (nutrient_component_count between 0 and 256),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (diary_id, user_id) references diary(id, user_id) on delete cascade,
  foreign key (food_version_id, food_serving_id)
    references food_serving(food_version_id, id) deferrable initially deferred,
  foreign key (recipe_version_id, user_id)
    references recipe_version(id, owner_user_id) deferrable initially deferred,
  unique (diary_entry_id, revision_number),
  unique (diary_entry_id, id),
  unique (diary_entry_id, id, revision_number),
  check ((resolved_quantity is null) = (resolved_unit is null)),
  check (
    (entry_kind = 'food' and food_version_id is not null and recipe_version_id is null
      and quantity is not null and resolved_quantity is not null and food_name is not null)
    or
    (entry_kind = 'recipe' and recipe_version_id is not null and food_version_id is null
      and food_serving_id is null and quantity is not null)
    or
    (entry_kind in ('note', 'quick_add') and food_version_id is null
      and recipe_version_id is null and food_serving_id is null and quantity is null)
  ),
  check (food_serving_id is null or food_version_id is not null),
  check (
    isfinite(occurred_at)
    and extract(year from (occurred_at at time zone 'UTC')) between 1 and 9999
  ),
  check (isfinite(local_date) and local_date between date '0001-01-01' and date '9999-12-31'),
  check (
    isfinite(created_at)
    and extract(year from (created_at at time zone 'UTC')) between 1 and 9999
  ),
  check (operation <> 'delete' or snapshot_status in ('complete', 'partial'))
);

create index diary_entry_revision_entry_idx
  on diary_entry_revision (diary_entry_id, revision_number desc);
create index diary_entry_revision_day_idx
  on diary_entry_revision (user_id, local_date, meal_slot, position, occurred_at, diary_entry_id);

create trigger diary_entry_revision_validate_time_zone
before insert or update of time_zone on diary_entry_revision
for each row execute function validate_iana_time_zone();

create trigger diary_entry_revision_reject_update
before update on diary_entry_revision
for each row execute function reject_immutable_row_update();

create function guard_diary_entry_revision_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'immutable diary revision cannot be deleted while its logical entry exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_entry_revision_guard_delete
before delete on diary_entry_revision
for each row execute function guard_diary_entry_revision_delete();

create table diary_entry_revision_nutrient (
  diary_entry_revision_id uuid not null references diary_entry_revision(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  nutrient_code text not null check (nutrient_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  nutrient_name text not null check (char_length(nutrient_name) between 1 and 200),
  unit text not null check (
    char_length(unit) between 1 and 32
    and unit in ('kcal', 'kJ', 'g', 'mg', 'ug', 'IU', 'mg_NE', 'ug_DFE', 'ug_RAE')
  ),
  known_amount numeric not null check (
    known_amount >= 0
    and known_amount < 'Infinity'::numeric
    and char_length(known_amount::text) <= 160
  ),
  completeness text not null check (completeness in ('complete', 'partial', 'unknown')),
  is_exact boolean not null,
  contributor_count integer not null check (contributor_count > 0),
  quantified_count integer not null check (quantified_count >= 0),
  unknown_count integer not null check (unknown_count >= 0),
  trace_count integer not null check (trace_count >= 0),
  unknown_reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(unknown_reasons) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (diary_entry_revision_id, nutrient_id),
  check (quantified_count + unknown_count + trace_count = contributor_count),
  check (is_exact = (trace_count = 0 and unknown_count = 0)),
  check (
    completeness = case
      when unknown_count = 0 then 'complete'
      when unknown_count = contributor_count then 'unknown'
      else 'partial'
    end
  )
);

create function diary_unknown_reasons_match(reasons jsonb, expected_count integer)
returns boolean
language sql
immutable
strict
as $$
  select
    not exists (
      select 1
      from jsonb_each_text(reasons) item
      where item.key not in ('not_reported', 'not_analyzed', 'not_applicable', 'withheld')
         or item.value !~ '^(0|[1-9][0-9]*)$'
    )
    and coalesce((select sum((item.value)::integer) from jsonb_each_text(reasons) item), 0)
      = expected_count;
$$;

alter table diary_entry_revision_nutrient
  add constraint diary_revision_nutrient_reasons_reconcile_check
  check (diary_unknown_reasons_match(unknown_reasons, unknown_count));

create index diary_entry_revision_nutrient_nutrient_idx
  on diary_entry_revision_nutrient (nutrient_id, diary_entry_revision_id);

create function validate_diary_revision_nutrient_insert()
returns trigger
language plpgsql
as $$
declare
  declared_count integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('nutrition-tracker:diary-revision-nutrients:' || new.diary_entry_revision_id::text, 0)
  );
  select revision.nutrient_component_count into declared_count
  from diary_entry_revision revision
  where revision.id = new.diary_entry_revision_id;
  if not found then
    raise exception 'diary nutrient snapshot references an unavailable revision'
      using errcode = '23503';
  end if;
  if (select count(*) from diary_entry_revision_nutrient
      where diary_entry_revision_id = new.diary_entry_revision_id) >= declared_count then
    raise exception 'diary nutrient snapshot exceeds its declared component count'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from nutrient
    where nutrient.id = new.nutrient_id
      and nutrient.code = new.nutrient_code
      and nutrient.name = new.nutrient_name
      and nutrient.canonical_unit = new.unit
  ) then
    raise exception 'diary nutrient snapshot does not match its nutrient definition'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger diary_entry_revision_nutrient_validate_insert
before insert on diary_entry_revision_nutrient
for each row execute function validate_diary_revision_nutrient_insert();

create function validate_diary_revision_component_count()
returns trigger
language plpgsql
as $$
declare
  persisted_count integer;
begin
  select count(*)::integer into persisted_count
  from diary_entry_revision_nutrient nutrient
  where nutrient.diary_entry_revision_id = new.id;
  if persisted_count <> new.nutrient_component_count then
    raise exception 'diary revision declared % nutrient components but persisted %',
      new.nutrient_component_count, persisted_count
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger diary_entry_revision_component_count_guard
after insert on diary_entry_revision
deferrable initially deferred
for each row execute function validate_diary_revision_component_count();

create trigger diary_entry_revision_nutrient_reject_update
before update on diary_entry_revision_nutrient
for each row execute function reject_immutable_row_update();

create function guard_diary_entry_revision_nutrient_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'immutable diary revision nutrient cannot be deleted while its revision exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_entry_revision_nutrient_guard_delete
before delete on diary_entry_revision_nutrient
for each row execute function guard_diary_entry_revision_nutrient_delete();

alter table diary_entry
  add column current_revision_id uuid,
  add column current_revision_number bigint check (current_revision_number is null or current_revision_number > 0);

insert into diary_entry_revision (
  diary_entry_id, diary_id, user_id, revision_number, operation, entry_kind,
  food_version_id, recipe_version_id, food_serving_id, meal_slot, quantity, input_unit,
  resolved_quantity, resolved_unit, occurred_at, local_date, local_time, time_zone,
  position, note, food_name, brand_name, source_code, source_release_id,
  source_display_name, license_expression, attribution_required, attribution_text,
  serving_label, snapshot_status,
  snapshot_engine_version, nutrient_component_count, created_at
)
select
  entry.id, entry.diary_id, entry.user_id, 1,
  case when entry.deleted_at is null then 'create' else 'delete' end,
  entry.entry_kind,
  entry.food_version_id, entry.recipe_version_id, entry.food_serving_id,
  case when entry.meal_slot in ('breakfast', 'lunch', 'dinner', 'snacks')
       then entry.meal_slot else 'snacks' end,
  entry.quantity, entry.input_unit,
  case when entry.resolved_grams is not null then entry.resolved_grams
       when entry.quantity is not null then entry.quantity else null end,
  case when entry.resolved_grams is not null then 'g'
       when entry.quantity is not null then 'serving' else null end,
  entry.occurred_at, day.local_date, entry.local_time, day.time_zone,
  entry.position, entry.note, version.name, version.brand_name, source.code,
  version.source_release_id, source.display_name, source.license_expression,
  source.attribution_required, source.attribution_text, serving.label,
  case
    when entry.snapshot_status <> 'complete' then 'partial'
    when entry.entry_kind in ('food', 'recipe', 'quick_add') and exists (
      select 1
      from nutrient active_nutrient
      where active_nutrient.active
        and not exists (
          select 1
          from diary_entry_nutrient_snapshot legacy_snapshot
          where legacy_snapshot.diary_entry_id = entry.id
            and legacy_snapshot.nutrient_id = active_nutrient.id
        )
    ) then 'partial'
    else 'complete'
  end,
  coalesce(entry.snapshot_engine_version, 'legacy-v1'),
  (
    select count(*)::integer
    from (
      select legacy_snapshot.nutrient_id
      from diary_entry_nutrient_snapshot legacy_snapshot
      where legacy_snapshot.diary_entry_id = entry.id
      union
      select active_nutrient.id
      from nutrient active_nutrient
      where active_nutrient.active
        and entry.entry_kind in ('food', 'recipe', 'quick_add')
    ) snapshot_nutrients
  ),
  entry.created_at
from diary_entry entry
join diary day on day.id = entry.diary_id and day.user_id = entry.user_id
left join food_version version on version.id = entry.food_version_id
left join food food_record on food_record.id = version.food_id
left join food_source source on source.id = food_record.food_source_id
left join food_serving serving on serving.id = entry.food_serving_id;

insert into diary_entry_revision_nutrient (
  diary_entry_revision_id, nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
  completeness, is_exact, contributor_count, quantified_count, unknown_count,
  trace_count, unknown_reasons, created_at
)
select revision.id, snapshot.nutrient_id, nutrient.code, nutrient.name, snapshot.unit,
       case when snapshot.provenance ->> 'valueStatus' = 'trace' then 0 else snapshot.amount end,
       'complete',
       (snapshot.provenance ->> 'valueStatus') is distinct from 'trace',
       1,
       case when snapshot.provenance ->> 'valueStatus' = 'trace' then 0 else 1 end,
       0,
       case when snapshot.provenance ->> 'valueStatus' = 'trace' then 1 else 0 end,
       '{}'::jsonb,
       snapshot.created_at
from diary_entry_revision revision
join diary_entry_nutrient_snapshot snapshot on snapshot.diary_entry_id = revision.diary_entry_id
join nutrient on nutrient.id = snapshot.nutrient_id
where revision.revision_number = 1;

-- Old snapshots stored only reported nutrients. Materialize every absent active
-- definition as explicitly unknown so a partial legacy vector can never turn
-- missing sodium (or any other nutrient) into an implied zero after upgrade.
insert into diary_entry_revision_nutrient (
  diary_entry_revision_id, nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
  completeness, is_exact, contributor_count, quantified_count, unknown_count,
  trace_count, unknown_reasons, created_at
)
select revision.id, nutrient.id, nutrient.code, nutrient.name, nutrient.canonical_unit,
       0, 'unknown', false, 1, 0, 1, 0, '{"not_reported": 1}'::jsonb, revision.created_at
from diary_entry_revision revision
cross join nutrient
where revision.revision_number = 1
  and revision.entry_kind in ('food', 'recipe', 'quick_add')
  and nutrient.active
  and not exists (
    select 1
    from diary_entry_revision_nutrient existing
    where existing.diary_entry_revision_id = revision.id
      and existing.nutrient_id = nutrient.id
  );

update diary_entry entry
set current_revision_id = revision.id, current_revision_number = 1
from diary_entry_revision revision
where revision.diary_entry_id = entry.id and revision.revision_number = 1;

alter table diary_entry
  alter column current_revision_id set not null,
  alter column current_revision_number set not null,
  add constraint diary_entry_current_revision_fk
    foreign key (id, current_revision_id, current_revision_number)
    references diary_entry_revision(diary_entry_id, id, revision_number)
    deferrable initially deferred;

create function guard_diary_entry_logical_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.id, new.user_id, new.client_operation_id, new.entry_kind, new.food_version_id,
    new.recipe_version_id, new.food_serving_id, new.meal_slot, new.quantity, new.input_unit,
    new.resolved_grams, new.occurred_at, new.local_time, new.position, new.note,
    new.snapshot_status, new.snapshot_engine_version, new.created_at, new.deleted_at
  ) is distinct from row(
    old.id, old.user_id, old.client_operation_id, old.entry_kind, old.food_version_id,
    old.recipe_version_id, old.food_serving_id, old.meal_slot, old.quantity, old.input_unit,
    old.resolved_grams, old.occurred_at, old.local_time, old.position, old.note,
    old.snapshot_status, old.snapshot_engine_version, old.created_at, old.deleted_at
  ) then
    raise exception 'diary entry identity/content cannot be rewritten; append a revision'
      using errcode = '55000';
  end if;

  if new.current_revision_number <> old.current_revision_number + 1 then
    raise exception 'diary entry head must advance exactly one revision'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from diary_entry_revision revision
    where revision.id = new.current_revision_id
      and revision.diary_entry_id = new.id
      and revision.user_id = new.user_id
      and revision.diary_id = new.diary_id
      and revision.revision_number = new.current_revision_number
  ) then
    raise exception 'diary entry head must reference its matching immutable next revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger diary_entry_guard_logical_update
before update on diary_entry
for each row execute function guard_diary_entry_logical_update();

create function guard_direct_diary_entry_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'logical diary entry may only be removed through its diary privacy cascade'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_entry_guard_direct_delete
before delete on diary_entry
for each row execute function guard_direct_diary_entry_delete();

create table diary_operation (
  user_id uuid not null references app_user(id) on delete restrict,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'update', 'delete')),
  diary_entry_id uuid not null references diary_entry(id) on delete cascade,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id)
);

create index diary_operation_entry_idx
  on diary_operation (user_id, diary_entry_id, created_at desc);

create trigger diary_operation_reject_update
before update on diary_operation
for each row execute function reject_immutable_row_update();

create function guard_diary_operation_delete()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 1 then
    raise exception 'diary idempotency record cannot be deleted while its logical entry exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_operation_guard_delete
before delete on diary_operation
for each row execute function guard_diary_operation_delete();


comment on table diary_entry_revision is
  'Immutable content history. The diary_entry row is only the user-owned logical identity.';
comment on table diary_entry_revision_nutrient is
  'Exact nutrient aggregate snapshots. known_amount is a lower bound; coverage counters preserve missingness.';
