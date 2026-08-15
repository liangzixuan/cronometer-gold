-- Nutrition Tracker initial domain schema.
-- Forward-only: corrections must be introduced in a later numbered migration.
-- This file intentionally contains no transaction control; the runner makes the
-- migration ledger and all pending schema changes atomic.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;

create function set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

-- Version rows may be erased by a controlled privacy/retention workflow, but they
-- cannot be rewritten in place. A correction is always a new version.
create function reject_immutable_row_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'immutable row in % cannot be updated; create a new version', tg_table_name
    using errcode = '55000';
end;
$$;

create table app_user (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique check (length(btrim(auth_subject)) > 0),
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 320),
  email_verified_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'disabled', 'pending_deletion')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  check (deleted_at is null or deletion_requested_at is not null)
);

create unique index app_user_email_unique on app_user (lower(email));
create index app_user_status_idx on app_user (status) where deleted_at is null;

create trigger app_user_set_updated_at
before update on app_user
for each row execute function set_row_updated_at();

create table user_profile (
  user_id uuid primary key references app_user(id) on delete cascade,
  display_name text,
  birth_date date,
  sex_at_birth text not null default 'not_specified'
    check (sex_at_birth in ('female', 'intersex', 'male', 'not_specified')),
  height_cm numeric(7,3) check (height_cm is null or height_cm between 30 and 300),
  baseline_weight_kg numeric(8,3)
    check (baseline_weight_kg is null or baseline_weight_kg between 1 and 1000),
  activity_level_code text,
  locale text not null default 'en-US' check (length(locale) between 2 and 35),
  time_zone text not null default 'UTC' check (length(time_zone) between 1 and 63),
  unit_system text not null default 'metric'
    check (unit_system in ('metric', 'us_customary')),
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  onboarding_completed_at timestamptz,
  wellness_disclaimer_acknowledged_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (birth_date is null or birth_date <= current_date)
);

create trigger user_profile_set_updated_at
before update on user_profile
for each row execute function set_row_updated_at();

create table food_source (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  display_name text not null check (length(btrim(display_name)) > 0),
  kind text not null check (kind in ('commercial', 'government', 'open', 'partner')),
  homepage_url text not null,
  access_url text,
  license_expression text not null,
  license_url text not null,
  terms_url text,
  attribution_text text not null,
  attribution_required boolean not null default true,
  commercial_use_allowed boolean,
  redistribution_allowed boolean,
  database_rights_notes text,
  rights_review_status text not null default 'pending'
    check (rights_review_status in ('approved', 'blocked', 'pending', 'restricted')),
  rights_reviewed_at timestamptz,
  rights_reviewed_by text,
  active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (rights_review_status = 'pending' and rights_reviewed_at is null)
    or (rights_review_status <> 'pending' and rights_reviewed_at is not null)
  ),
  check (not active or rights_review_status in ('approved', 'restricted'))
);

create index food_source_rights_idx on food_source (rights_review_status, active);

create trigger food_source_set_updated_at
before update on food_source
for each row execute function set_row_updated_at();

create table food_source_release (
  id uuid primary key default gen_random_uuid(),
  food_source_id bigint not null references food_source(id) on delete restrict,
  release_key text not null check (length(btrim(release_key)) > 0),
  published_on date,
  acquired_at timestamptz not null,
  artifact_uri text not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes bigint not null check (artifact_bytes > 0),
  media_type text not null,
  upstream_schema_version text,
  parser_version text not null,
  status text not null default 'imported'
    check (status in ('failed', 'imported', 'promoted', 'quarantined')),
  record_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(record_counts) = 'object'),
  validation_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(validation_summary) = 'object'),
  rights_manifest_uri text not null,
  promoted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (food_source_id, release_key, artifact_sha256),
  check ((status = 'promoted') = (promoted_at is not null))
);

create index food_source_release_status_idx
  on food_source_release (food_source_id, status, acquired_at desc);

create function guard_food_source_release_update()
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

create trigger food_source_release_guard_update
before update on food_source_release
for each row execute function guard_food_source_release_update();

create table nutrient (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text not null check (length(btrim(name)) > 0),
  short_name text,
  canonical_unit text not null check (length(btrim(canonical_unit)) > 0),
  dimension text not null check (dimension in ('amount', 'energy', 'mass', 'ratio', 'volume')),
  parent_nutrient_id bigint references nutrient(id) on delete restrict,
  display_decimals integer not null default 1 check (display_decimals between 0 and 8),
  display_order integer not null default 0,
  is_core boolean not null default false,
  is_targetable boolean not null default true,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (parent_nutrient_id is null or parent_nutrient_id <> id)
);

create index nutrient_display_idx on nutrient (active, display_order, id);
create index nutrient_parent_idx on nutrient (parent_nutrient_id) where parent_nutrient_id is not null;

create trigger nutrient_set_updated_at
before update on nutrient
for each row execute function set_row_updated_at();

create table nutrient_alias (
  id bigint generated always as identity primary key,
  nutrient_id bigint not null references nutrient(id) on delete cascade,
  alias text not null check (length(btrim(alias)) > 0),
  locale text not null default 'und',
  alias_kind text not null default 'common'
    check (alias_kind in ('abbreviation', 'common', 'scientific', 'source')),
  created_at timestamptz not null default clock_timestamp(),
  unique (nutrient_id, locale, alias)
);

create index nutrient_alias_lookup_idx on nutrient_alias (lower(alias), locale);

create table source_nutrient_map (
  food_source_id bigint not null references food_source(id) on delete restrict,
  source_nutrient_key text not null,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  source_name text not null,
  source_unit text not null,
  conversion_multiplier numeric(24,12) not null default 1 check (conversion_multiplier > 0),
  mapping_notes text,
  reviewed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (food_source_id, source_nutrient_key)
);

create index source_nutrient_map_nutrient_idx on source_nutrient_map (nutrient_id);

create table food (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('branded', 'custom', 'generic')),
  food_source_id bigint references food_source(id) on delete restrict,
  source_food_key text,
  owner_user_id uuid references app_user(id) on delete restrict,
  visibility text not null default 'public'
    check (visibility in ('private', 'public', 'unlisted')),
  current_version_id bigint,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (id, owner_user_id),
  check (
    (
      kind = 'custom'
      and owner_user_id is not null
      and food_source_id is null
      and source_food_key is null
    )
    or (
      kind in ('branded', 'generic')
      and owner_user_id is null
      and food_source_id is not null
      and source_food_key is not null
    )
  ),
  check (kind = 'custom' or visibility = 'public')
);

create unique index food_source_identity_unique
  on food (food_source_id, source_food_key)
  where food_source_id is not null;
create index food_owner_idx on food (owner_user_id, archived_at) where owner_user_id is not null;
create index food_current_version_idx on food (current_version_id) where current_version_id is not null;

create trigger food_set_updated_at
before update on food
for each row execute function set_row_updated_at();

create table food_version (
  id bigint generated always as identity primary key,
  food_id bigint not null references food(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  source_release_id uuid references food_source_release(id) on delete restrict,
  name text not null check (length(btrim(name)) > 0),
  normalized_name text not null check (length(btrim(normalized_name)) > 0),
  brand_name text,
  description text,
  ingredients_text text,
  language_tag text not null default 'und' check (length(language_tag) between 2 and 35),
  market_code text not null default '001' check (market_code ~ '^[A-Z0-9]{2,3}$'),
  data_quality text not null default 'provisional'
    check (data_quality in ('curated', 'provisional', 'quarantined', 'verified')),
  basis_quantity numeric(18,6) not null check (basis_quantity > 0),
  basis_unit text not null check (basis_unit in ('g', 'ml', 'serving')),
  source_modified_at timestamptz,
  effective_from timestamptz not null default clock_timestamp(),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  created_by_user_id uuid references app_user(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (food_id, version_number),
  unique (food_id, id)
);

alter table food
  add constraint food_current_version_fk
  foreign key (id, current_version_id)
  references food_version(food_id, id)
  deferrable initially deferred;

create index food_version_name_trgm_idx
  on food_version using gin (normalized_name gin_trgm_ops)
  where data_quality <> 'quarantined';
create index food_version_brand_name_idx
  on food_version (lower(brand_name))
  where brand_name is not null and data_quality <> 'quarantined';
create index food_version_release_idx on food_version (source_release_id, id);

create trigger food_version_reject_update
before update on food_version
for each row execute function reject_immutable_row_update();

create table food_nutrient_value (
  food_version_id bigint not null references food_version(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  amount numeric(24,12) not null check (amount >= 0),
  unit text not null,
  basis_quantity numeric(18,6) not null check (basis_quantity > 0),
  basis_unit text not null check (basis_unit in ('g', 'ml', 'serving')),
  source_amount numeric(24,12) check (source_amount is null or source_amount >= 0),
  source_unit text,
  source_basis_quantity numeric(18,6)
    check (source_basis_quantity is null or source_basis_quantity > 0),
  source_basis_unit text check (source_basis_unit in ('g', 'ml', 'serving')),
  value_status text not null
    check (value_status in ('calculated', 'estimated', 'label', 'measured', 'trace')),
  derivation_code text,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (food_version_id, nutrient_id),
  check (
    (source_amount is null and source_unit is null and source_basis_quantity is null and source_basis_unit is null)
    or
    (source_amount is not null and source_unit is not null and source_basis_quantity is not null and source_basis_unit is not null)
  )
);

create index food_nutrient_value_nutrient_idx
  on food_nutrient_value (nutrient_id, food_version_id);

create trigger food_nutrient_value_reject_update
before update on food_nutrient_value
for each row execute function reject_immutable_row_update();

create table food_serving (
  id bigint generated always as identity primary key,
  food_version_id bigint not null references food_version(id) on delete cascade,
  source_serving_key text,
  label text not null check (length(btrim(label)) > 0),
  quantity numeric(18,6) not null check (quantity > 0),
  unit text not null check (length(btrim(unit)) > 0),
  unit_kind text not null check (unit_kind in ('count', 'mass', 'volume')),
  gram_weight numeric(18,6) check (gram_weight is null or gram_weight > 0),
  milliliter_volume numeric(18,6) check (milliliter_volume is null or milliliter_volume > 0),
  is_default boolean not null default false,
  display_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (food_version_id, id),
  check (gram_weight is not null or milliliter_volume is not null),
  check (unit_kind <> 'mass' or gram_weight is not null),
  check (unit_kind <> 'volume' or milliliter_volume is not null)
);

create unique index food_serving_source_key_unique
  on food_serving (food_version_id, source_serving_key)
  where source_serving_key is not null;
create unique index food_serving_default_unique
  on food_serving (food_version_id)
  where is_default;

create trigger food_serving_reject_update
before update on food_serving
for each row execute function reject_immutable_row_update();

create table food_barcode (
  id bigint generated always as identity primary key,
  gtin text not null check (gtin ~ '^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$'),
  market_code text not null default '001' check (market_code ~ '^[A-Z0-9]{2,3}$'),
  food_id bigint not null references food(id) on delete cascade,
  food_version_id bigint references food_version(id) on delete restrict,
  food_serving_id bigint references food_serving(id) on delete restrict,
  source_release_id uuid references food_source_release(id) on delete restrict,
  valid_from timestamptz not null default clock_timestamp(),
  valid_to timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (food_id, food_version_id)
    references food_version(food_id, id) deferrable initially deferred,
  foreign key (food_version_id, food_serving_id)
    references food_serving(food_version_id, id) deferrable initially deferred,
  check (valid_to is null or valid_to > valid_from),
  check (food_serving_id is null or food_version_id is not null)
);

create unique index food_barcode_current_market_unique
  on food_barcode (gtin, market_code)
  where valid_to is null;
create index food_barcode_food_idx on food_barcode (food_id, valid_from desc);

create table recipe (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app_user(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'archived')),
  current_version_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (id, owner_user_id),
  check ((status = 'archived') = (archived_at is not null))
);

create index recipe_owner_idx on recipe (owner_user_id, updated_at desc);

create trigger recipe_set_updated_at
before update on recipe
for each row execute function set_row_updated_at();

create table recipe_version (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipe(id) on delete cascade,
  owner_user_id uuid not null,
  version_number integer not null check (version_number > 0),
  name text not null check (length(btrim(name)) > 0),
  description text,
  instructions text,
  serving_count numeric(12,4) not null check (serving_count > 0),
  total_yield_quantity numeric(18,6) check (total_yield_quantity is null or total_yield_quantity > 0),
  total_yield_unit text,
  total_weight_grams numeric(18,6) check (total_weight_grams is null or total_weight_grams > 0),
  calculation_version text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by_user_id uuid not null references app_user(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (recipe_id, owner_user_id) references recipe(id, owner_user_id) on delete cascade,
  unique (recipe_id, version_number),
  unique (recipe_id, id),
  unique (id, owner_user_id),
  check (
    (total_yield_quantity is null and total_yield_unit is null)
    or (total_yield_quantity is not null and total_yield_unit is not null)
  )
);

alter table recipe
  add constraint recipe_current_version_fk
  foreign key (id, current_version_id)
  references recipe_version(recipe_id, id)
  deferrable initially deferred;

create trigger recipe_version_reject_update
before update on recipe_version
for each row execute function reject_immutable_row_update();

create table recipe_ingredient (
  id bigint generated always as identity primary key,
  recipe_version_id uuid not null references recipe_version(id) on delete cascade,
  position integer not null check (position >= 0),
  food_version_id bigint references food_version(id) on delete restrict,
  nested_recipe_version_id uuid references recipe_version(id) on delete restrict,
  food_serving_id bigint references food_serving(id) on delete restrict,
  quantity numeric(18,6) not null check (quantity > 0),
  input_unit text not null,
  resolved_grams numeric(18,6) check (resolved_grams is null or resolved_grams > 0),
  yield_factor numeric(8,6) not null default 1 check (yield_factor > 0 and yield_factor <= 1),
  retention_factor_set text,
  note text,
  created_at timestamptz not null default clock_timestamp(),
  unique (recipe_version_id, position),
  foreign key (food_version_id, food_serving_id)
    references food_serving(food_version_id, id) deferrable initially deferred,
  check ((food_version_id is not null)::integer + (nested_recipe_version_id is not null)::integer = 1),
  check (food_serving_id is null or food_version_id is not null)
);

create index recipe_ingredient_food_idx
  on recipe_ingredient (food_version_id) where food_version_id is not null;
create index recipe_ingredient_nested_idx
  on recipe_ingredient (nested_recipe_version_id) where nested_recipe_version_id is not null;

create function reject_recipe_cycle()
returns trigger
language plpgsql
as $$
declare
  owner_recipe_id uuid;
  root_owner_user_id uuid;
begin
  if new.nested_recipe_version_id is null then
    return new;
  end if;

  select recipe_id, recipe_version.owner_user_id
    into strict owner_recipe_id, root_owner_user_id
  from recipe_version
  where id = new.recipe_version_id;

  if exists (
    select 1
    from recipe_version nested_owner
    where nested_owner.id = new.nested_recipe_version_id
      and nested_owner.owner_user_id <> root_owner_user_id
  ) then
    raise exception 'nested recipe must have the same owner' using errcode = '23514';
  end if;

  if exists (
    with recursive nested_versions(id) as (
      select new.nested_recipe_version_id
      union
      select ingredient.nested_recipe_version_id
      from recipe_ingredient ingredient
      join nested_versions parent on ingredient.recipe_version_id = parent.id
      where ingredient.nested_recipe_version_id is not null
    )
    select 1
    from nested_versions nested
    join recipe_version candidate on candidate.id = nested.id
    where candidate.recipe_id = owner_recipe_id
  ) then
    raise exception 'nested recipe would create a cycle' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger recipe_ingredient_reject_cycle
before insert or update on recipe_ingredient
for each row execute function reject_recipe_cycle();

create trigger recipe_ingredient_reject_update
before update on recipe_ingredient
for each row execute function reject_immutable_row_update();

create table diary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete restrict,
  local_date date not null,
  time_zone text not null check (length(time_zone) between 1 and 63),
  status text not null default 'open' check (status in ('locked', 'open')),
  note text,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, local_date),
  unique (id, user_id)
);

create index diary_user_recent_idx on diary (user_id, local_date desc);

create trigger diary_set_updated_at
before update on diary
for each row execute function set_row_updated_at();

create table diary_entry (
  id uuid primary key default gen_random_uuid(),
  diary_id uuid not null,
  user_id uuid not null,
  client_operation_id uuid not null,
  entry_kind text not null check (entry_kind in ('food', 'note', 'quick_add', 'recipe')),
  food_version_id bigint references food_version(id) on delete restrict,
  recipe_version_id uuid references recipe_version(id) on delete restrict,
  food_serving_id bigint references food_serving(id) on delete restrict,
  meal_slot text,
  quantity numeric(18,6) check (quantity is null or quantity > 0),
  input_unit text,
  resolved_grams numeric(18,6) check (resolved_grams is null or resolved_grams > 0),
  occurred_at timestamptz not null,
  local_time time without time zone not null,
  position integer not null default 0,
  note text,
  snapshot_status text not null default 'pending'
    check (snapshot_status in ('complete', 'partial', 'pending')),
  snapshot_engine_version text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (diary_id, user_id) references diary(id, user_id) on delete cascade,
  foreign key (food_version_id, food_serving_id)
    references food_serving(food_version_id, id) deferrable initially deferred,
  foreign key (recipe_version_id, user_id)
    references recipe_version(id, owner_user_id) deferrable initially deferred,
  unique (user_id, client_operation_id),
  check (
    (
      entry_kind = 'food'
      and food_version_id is not null
      and recipe_version_id is null
      and quantity is not null
    )
    or (
      entry_kind = 'recipe'
      and recipe_version_id is not null
      and food_version_id is null
      and food_serving_id is null
      and quantity is not null
    )
    or (
      entry_kind in ('note', 'quick_add')
      and food_version_id is null
      and recipe_version_id is null
      and food_serving_id is null
      and quantity is null
    )
  ),
  check (food_serving_id is null or food_version_id is not null),
  check (
    (snapshot_status = 'pending' and snapshot_engine_version is null)
    or (snapshot_status <> 'pending' and snapshot_engine_version is not null)
  )
);

create index diary_entry_day_order_idx
  on diary_entry (diary_id, meal_slot, position, occurred_at, id)
  where deleted_at is null;
create index diary_entry_user_recent_idx
  on diary_entry (user_id, occurred_at desc)
  where deleted_at is null;

create trigger diary_entry_set_updated_at
before update on diary_entry
for each row execute function set_row_updated_at();

create table diary_entry_nutrient_snapshot (
  diary_entry_id uuid not null references diary_entry(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  amount numeric(24,12) not null check (amount >= 0),
  unit text not null,
  calculation_version text not null,
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (diary_entry_id, nutrient_id)
);

create index diary_entry_snapshot_nutrient_idx
  on diary_entry_nutrient_snapshot (nutrient_id, diary_entry_id);

create trigger diary_entry_nutrient_snapshot_reject_update
before update on diary_entry_nutrient_snapshot
for each row execute function reject_immutable_row_update();

create table nutrition_goal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete restrict,
  status text not null default 'draft' check (status in ('active', 'archived', 'draft')),
  current_version_id uuid,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  check (effective_to is null or effective_to > effective_from)
);

alter table nutrition_goal
  add constraint nutrition_goal_active_period_exclusion
  exclude using gist (
    user_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  ) where (status = 'active')
  deferrable initially deferred;

create index nutrition_goal_user_idx on nutrition_goal (user_id, status, effective_from desc);

create trigger nutrition_goal_set_updated_at
before update on nutrition_goal
for each row execute function set_row_updated_at();

create table nutrition_goal_version (
  id uuid primary key default gen_random_uuid(),
  nutrition_goal_id uuid not null references nutrition_goal(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  energy_mode text not null check (energy_mode in ('component', 'fixed', 'pal_total')),
  energy_target_kcal numeric(12,4) check (energy_target_kcal is null or energy_target_kcal > 0),
  bmr_kcal numeric(12,4) check (bmr_kcal is null or bmr_kcal > 0),
  bmr_equation_code text,
  bmr_equation_version text,
  dri_reference_group_code text,
  dri_reference_version text,
  activity_factor numeric(8,5) check (activity_factor is null or activity_factor > 0),
  exercise_budget_kcal numeric(12,4)
    check (exercise_budget_kcal is null or exercise_budget_kcal >= 0),
  thermic_effect_kcal numeric(12,4)
    check (thermic_effect_kcal is null or thermic_effect_kcal >= 0),
  energy_adjustment_kcal numeric(12,4),
  assumptions jsonb not null default '{}'::jsonb check (jsonb_typeof(assumptions) = 'object'),
  rationale text,
  created_by_user_id uuid not null references app_user(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (nutrition_goal_id, version_number),
  unique (nutrition_goal_id, id),
  check (
    (bmr_equation_code is null and bmr_equation_version is null)
    or (bmr_equation_code is not null and bmr_equation_version is not null)
  ),
  check (
    (dri_reference_group_code is null and dri_reference_version is null)
    or (dri_reference_group_code is not null and dri_reference_version is not null)
  ),
  check (energy_mode <> 'fixed' or energy_target_kcal is not null),
  check (energy_mode <> 'pal_total' or (bmr_kcal is not null and activity_factor is not null))
);

alter table nutrition_goal
  add constraint nutrition_goal_current_version_fk
  foreign key (id, current_version_id)
  references nutrition_goal_version(nutrition_goal_id, id)
  deferrable initially deferred;

create trigger nutrition_goal_version_reject_update
before update on nutrition_goal_version
for each row execute function reject_immutable_row_update();

create table nutrition_goal_target (
  nutrition_goal_version_id uuid not null references nutrition_goal_version(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  minimum_amount numeric(24,12) check (minimum_amount is null or minimum_amount >= 0),
  target_amount numeric(24,12) check (target_amount is null or target_amount >= 0),
  maximum_amount numeric(24,12) check (maximum_amount is null or maximum_amount >= 0),
  unit text not null,
  target_source text not null,
  target_source_version text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (nutrition_goal_version_id, nutrient_id),
  check (minimum_amount is not null or target_amount is not null or maximum_amount is not null),
  check (minimum_amount is null or target_amount is null or minimum_amount <= target_amount),
  check (target_amount is null or maximum_amount is null or target_amount <= maximum_amount),
  check (minimum_amount is null or maximum_amount is null or minimum_amount <= maximum_amount)
);

create index nutrition_goal_target_nutrient_idx
  on nutrition_goal_target (nutrient_id, nutrition_goal_version_id);

create trigger nutrition_goal_target_reject_update
before update on nutrition_goal_target
for each row execute function reject_immutable_row_update();

create table audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references app_user(id) on delete set null,
  subject_user_id uuid references app_user(id) on delete set null,
  action text not null check (length(btrim(action)) > 0),
  entity_type text not null check (length(btrim(entity_type)) > 0),
  entity_id text,
  sensitivity text not null
    check (sensitivity in ('health', 'operational', 'personal', 'security')),
  reason text,
  request_id text,
  source_ip inet,
  user_agent text,
  before_state jsonb,
  after_state jsonb,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  check (before_state is null or jsonb_typeof(before_state) = 'object'),
  check (after_state is null or jsonb_typeof(after_state) = 'object')
);

create index audit_log_subject_time_idx on audit_log (subject_user_id, occurred_at desc);
create index audit_log_entity_time_idx on audit_log (entity_type, entity_id, occurred_at desc);
create index audit_log_request_idx on audit_log (request_id) where request_id is not null;

create trigger audit_log_reject_update
before update on audit_log
for each row execute function reject_immutable_row_update();

create table outbox_event (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  event_version integer not null default 1 check (event_version > 0),
  deduplication_key text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  check ((locked_at is null) = (locked_by is null))
);

create unique index outbox_event_deduplication_unique
  on outbox_event (deduplication_key)
  where deduplication_key is not null;
create index outbox_event_pending_idx
  on outbox_event (available_at, occurred_at, id)
  where published_at is null;
create index outbox_event_aggregate_idx
  on outbox_event (aggregate_type, aggregate_id, occurred_at);

comment on table food_source is
  'Contract and provenance registry; a source cannot become active before a rights review.';
comment on table food_nutrient_value is
  'No row means unknown. Zero is a known numeric value and must never be synthesized from absence.';
comment on table diary_entry_nutrient_snapshot is
  'Resolved immutable nutrition at log time; source corrections affect future logs, not history.';
comment on column nutrition_goal.effective_to is
  'Exclusive local date. Active goal periods for one user may not overlap.';
comment on table outbox_event is
  'Events written in the same transaction as domain changes and published with at-least-once delivery.';
