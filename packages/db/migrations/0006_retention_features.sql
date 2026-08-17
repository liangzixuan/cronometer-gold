-- Retention features: trends/repeat provenance, private custom foods,
-- biometrics, reminders, platform imports, privacy export, and erasure.
-- This migration is forward-only.  It deliberately refuses to invent version
-- or idempotency history for experimental custom-food rows created before 0006.

lock table food in share row exclusive mode;

do $$
declare legacy_custom_count bigint;
begin
  select count(*) into legacy_custom_count from food where kind = 'custom';
  if legacy_custom_count <> 0 then
    raise exception
      '0006 requires empty legacy custom-food roots; export/remediate % rows and retry the whole migration',
      legacy_custom_count using errcode = '23514';
  end if;
end;
$$;

-- 0002 introduced these as NOT VALID to permit a staged principal cleanup.
-- Fresh installs and restored schemas must not carry the validation debt past
-- the retention boundary.
alter table source_nutrient_map
  validate constraint source_nutrient_map_reviewer_principal_check;
alter table food_source
  validate constraint food_source_rights_reviewer_principal_check;

-- Every deployment/restore epoch is attested only after the offline erasure-ledger replay has
-- reconciled. A restored backup carries an old epoch and/or database identity and remains unready.
create table database_restore_attestation (
  singleton boolean primary key default true check (singleton),
  restore_epoch_hash text not null check (restore_epoch_hash ~ '^[0-9a-f]{64}$'),
  database_oid bigint not null check (database_oid > 0),
  database_name text not null check (char_length(btrim(database_name)) between 1 and 200),
  replayed_subject_count bigint not null check (replayed_subject_count >= 0),
  reconciliation_digest text not null check (reconciliation_digest ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null check (isfinite(completed_at)),
  updated_at timestamptz not null default clock_timestamp()
);

create function guard_retention_immutable_row_v3() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and (
    pg_trigger_depth() > 1 or
    coalesce(current_setting('nutrition_tracker.account_erasure', true), '') = 'on' or
    coalesce(current_setting('nutrition_tracker.privacy_export_cleanup', true), '') = 'on'
  ) then
    return old;
  end if;
  raise exception 'immutable retention evidence cannot be changed directly'
    using errcode = '55000';
end $$;

create table user_data_watermark (
  user_id uuid primary key references app_user(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into user_data_watermark (user_id)
select id from app_user;

create function bump_user_data_watermark_v3()
returns trigger language plpgsql as $$
declare target_user uuid;
begin
  if current_setting('nutrition_tracker.account_erasure', true) = 'on' then
    return coalesce(new, old);
  end if;
  target_user := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> tg_argv[0];
  if target_user is not null and exists (
    select 1 from app_user where id = target_user
  ) then
    insert into user_data_watermark (user_id, revision, updated_at)
    values (target_user, 1, clock_timestamp())
    on conflict (user_id) do update
      set revision = user_data_watermark.revision + 1,
          updated_at = excluded.updated_at;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger user_profile_bump_watermark_v3
after insert or update or delete on user_profile
for each row execute function bump_user_data_watermark_v3('user_id');
create trigger diary_bump_watermark_v3
after insert or update or delete on diary
for each row execute function bump_user_data_watermark_v3('user_id');
create trigger recipe_bump_watermark_v3
after insert or update or delete on recipe
for each row execute function bump_user_data_watermark_v3('owner_user_id');
create trigger nutrition_goal_bump_watermark_v3
after insert or update or delete on nutrition_goal
for each row execute function bump_user_data_watermark_v3('user_id');

create table retention_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  feature text not null check (feature in ('biometric','consent','custom_food','device','erasure','export','import','integration','reauth','reminder')),
  operation text not null check (char_length(btrim(operation)) between 1 and 40),
  entity_id text not null check (char_length(entity_id) between 1 and 100),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id)
);
create trigger retention_operation_reject_update_v3
before update or delete on retention_operation
for each row execute function guard_retention_immutable_row_v3();

create table custom_food (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  food_id bigint not null,
  current_food_version_id bigint not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (id, user_id),
  unique (food_id),
  unique (user_id, food_id),
  foreign key (food_id, user_id) references food(id, owner_user_id) on delete cascade,
  foreign key (food_id, current_food_version_id)
    references food_version(food_id, id) deferrable initially deferred,
  check ((status = 'archived') = (archived_at is not null)),
  check (isfinite(created_at) and isfinite(updated_at))
);

create index custom_food_user_updated_idx
  on custom_food (user_id, updated_at desc, id desc);

create function validate_custom_food_head_v3()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from food
    join food_version version on version.food_id = food.id
    where food.id = new.food_id
      and food.owner_user_id = new.user_id
      and food.kind = 'custom'
      and food.visibility = 'private'
      and food.food_source_id is null
      and food.source_food_key is null
      and food.current_version_id = new.current_food_version_id
      and version.id = new.current_food_version_id
      and version.source_release_id is null
      and version.created_by_user_id = new.user_id
      and version.basis_unit = 'g'
  ) then
    raise exception 'custom-food head does not match its private immutable food version'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and (new.current_revision <> 1 or not exists (
    select 1 from food_version where id = new.current_food_version_id and version_number = 1
  )) then
    raise exception 'initial custom-food root must point to immutable version one'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
    new.id <> old.id or new.user_id <> old.user_id or new.food_id <> old.food_id
    or new.created_at <> old.created_at or new.current_revision <> old.current_revision + 1
    or (new.current_food_version_id = old.current_food_version_id and new.status = old.status)
    or (new.current_food_version_id <> old.current_food_version_id and exists (
      select 1
      from food_version previous, food_version next
      where previous.id = old.current_food_version_id
        and next.id = new.current_food_version_id
        and next.version_number <> previous.version_number + 1
    ))
  ) then
    raise exception 'custom-food identity is immutable and revisions advance by one'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger custom_food_validate_head_v3
before insert or update on custom_food
for each row execute function validate_custom_food_head_v3();
create trigger custom_food_set_updated_at_v3
before update on custom_food
for each row execute function set_row_updated_at();
create trigger custom_food_bump_watermark_v3
after insert or update or delete on custom_food
for each row execute function bump_user_data_watermark_v3('user_id');

create table custom_food_version (
  custom_food_id uuid not null references custom_food(id) on delete cascade,
  food_version_id bigint primary key references food_version(id) on delete cascade,
  version_number bigint not null check (version_number > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (custom_food_id, version_number),
  unique (custom_food_id, food_version_id)
);
create trigger custom_food_version_map_reject_update_v3
before update or delete on custom_food_version
for each row execute function guard_retention_immutable_row_v3();

create table custom_food_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'revise', 'archive')),
  custom_food_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id),
  foreign key (custom_food_id, user_id) references custom_food(id, user_id) on delete cascade
);
create trigger custom_food_operation_reject_update_v3
before update or delete on custom_food_operation
for each row execute function guard_retention_immutable_row_v3();

create table custom_food_version_nutrient (
  custom_food_id uuid not null,
  food_version_id bigint not null references food_version(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  nutrient_code text not null,
  nutrient_name text not null,
  unit text not null,
  value_state text not null check (value_state in ('quantified', 'trace', 'unknown')),
  amount_per_100_grams numeric,
  unknown_reason text,
  provenance_statement text not null
    check (provenance_statement = 'Entered by the owner; not independently verified.'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (food_version_id, nutrient_id),
  foreign key (custom_food_id, food_version_id)
    references custom_food_version(custom_food_id, food_version_id) on delete cascade,
  check ((
    (value_state = 'quantified' and amount_per_100_grams is not null
      and amount_per_100_grams >= 0 and amount_per_100_grams < 'Infinity'::numeric
      and unknown_reason is null)
    or (value_state = 'trace' and amount_per_100_grams is null and unknown_reason is null)
    or (value_state = 'unknown' and amount_per_100_grams is null
      and unknown_reason in ('not_reported','not_analyzed','not_applicable','withheld'))
  ) is true)
);

create function guard_custom_food_immutable_evidence_v3()
returns trigger language plpgsql as $$
declare version_id bigint;
begin
  if current_setting('nutrition_tracker.account_erasure', true) = 'on'
     or pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;
  version_id := coalesce(
    (to_jsonb(old)->>'food_version_id')::bigint,
    (to_jsonb(old)->>'id')::bigint
  );
  if exists (select 1 from custom_food_version where food_version_id = version_id) then
    raise exception 'published custom-food evidence is immutable' using errcode = '55000';
  end if;
  return old;
end;
$$;
create trigger custom_food_version_guard_delete_v3
before delete on food_version for each row execute function guard_custom_food_immutable_evidence_v3();
create trigger custom_food_nutrient_guard_delete_v3
before delete on food_nutrient_value for each row execute function guard_custom_food_immutable_evidence_v3();
create trigger custom_food_serving_guard_delete_v3
before delete on food_serving for each row execute function guard_custom_food_immutable_evidence_v3();

create function guard_custom_food_child_insert_v3()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from custom_food_version where food_version_id = new.food_version_id) then
    raise exception 'published custom-food children cannot be appended' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger custom_food_nutrient_guard_insert_v3
before insert on food_nutrient_value for each row execute function guard_custom_food_child_insert_v3();
create trigger custom_food_serving_guard_insert_v3
before insert on food_serving for each row execute function guard_custom_food_child_insert_v3();

create function guard_custom_food_root_delete_v3()
returns trigger language plpgsql as $$
begin
  if current_setting('nutrition_tracker.account_erasure', true) <> 'on'
     and pg_trigger_depth() = 1 then
    raise exception 'custom food must be archived; physical deletion is an account-erasure operation'
      using errcode = '55000';
  end if;
  return old;
end;
$$;
create trigger custom_food_guard_delete_v3
before delete on custom_food for each row execute function guard_custom_food_root_delete_v3();

-- Private custom-food versions may be pinned as recipe ingredients. Public
-- source attribution stays nullable only for this owner-scoped branch.
alter table recipe_version
  drop constraint recipe_version_component_bounds,
  add constraint recipe_version_component_bounds_v3 check (
    ingredient_count between 1 and 50
    and nutrient_component_count between 1 and 256
    and source_component_count between 0 and 256
  );

alter table diary_entry_revision
  drop constraint diary_recipe_snapshot_v2,
  add constraint diary_recipe_snapshot_v3 check ((
    (
      entry_kind = 'food'
      and recipe_id is null and recipe_name is null and recipe_yield_grams is null
      and recipe_version_number is null and recipe_yield_source is null
      and recipe_serving_count is null and recipe_serving_label is null
      and recipe_calculation_version is null and recipe_retention_policy_code is null
      and recipe_retention_policy_version is null and recipe_calculation_assumptions is null
      and recipe_warnings is null and source_component_count = 0
    )
    or (
      entry_kind = 'recipe'
      and recipe_version_id is not null and recipe_id is not null
      and recipe_version_number > 0
      and char_length(btrim(recipe_name)) between 1 and 200
      and recipe_yield_grams > 0 and recipe_yield_grams < 'Infinity'::numeric
      and recipe_yield_source in ('estimated', 'measured')
      and (
        (recipe_serving_count is null and recipe_serving_label is null)
        or (
          recipe_serving_count > 0 and recipe_serving_count < 'Infinity'::numeric
          and char_length(btrim(recipe_serving_label)) between 1 and 100
        )
      )
      and char_length(btrim(recipe_calculation_version)) between 1 and 160
      and recipe_retention_policy_code = 'identity-retention-default'
      and recipe_retention_policy_version = '1'
      and jsonb_typeof(recipe_calculation_assumptions) = 'object'
      and recipe_calculation_assumptions @> jsonb_build_object(
        'retentionPolicy', jsonb_build_object(
          'assumption', 'No cooking-retention dataset was applied; omitted factors remain exactly one.',
          'code', 'identity-retention-default', 'defaultFactor', '1', 'version', '1'
        )
      )
      and jsonb_typeof(recipe_warnings) = 'array'
      and source_component_count between 0 and 256
      and source_code is null and source_release_id is null and source_display_name is null
      and license_expression is null and attribution_required is null and attribution_text is null
    )
    or (
      entry_kind in ('note', 'quick_add') and operation = 'delete'
      and recipe_id is null and recipe_name is null and recipe_version_number is null
      and recipe_yield_grams is null and recipe_yield_source is null
      and recipe_serving_count is null and recipe_serving_label is null
      and recipe_calculation_version is null and recipe_retention_policy_code is null
      and recipe_retention_policy_version is null and recipe_calculation_assumptions is null
      and recipe_warnings is null and source_component_count = 0
    )
  ) is true);

alter table recipe_ingredient
  add column custom_food_id uuid,
  add column custom_food_version_number integer,
  drop constraint recipe_ingredient_snapshot_v2,
  add constraint recipe_ingredient_snapshot_v3 check ((
    (
      ingredient_kind = 'food'
      and food_version_id is not null and nested_recipe_version_id is null
      and nested_recipe_id is null and nested_recipe_name is null
      and nested_recipe_version_number is null
      and nested_recipe_yield_grams is null and nested_recipe_serving_count is null
      and nested_recipe_serving_label is null
      and char_length(btrim(food_name)) between 1 and 500
      and (brand_name is null or char_length(btrim(brand_name)) between 1 and 300)
      and (
        (
          custom_food_id is null and custom_food_version_number is null
          and source_id is not null and source_release_id is not null
          and char_length(btrim(source_code)) between 1 and 32
          and char_length(btrim(source_display_name)) between 1 and 200
          and char_length(btrim(license_expression)) between 1 and 256
          and attribution_required is not null
          and char_length(btrim(attribution_text)) between 1 and 2000
        )
        or (
          custom_food_id is not null and custom_food_version_number > 0
          and source_id is null and source_release_id is null and source_code is null
          and source_display_name is null and license_expression is null
          and attribution_required is null and attribution_text is null
        )
      )
      and input_unit in ('g', 'serving')
      and ((input_unit = 'g' and food_serving_id is null and serving_label is null
            and quantity = resolved_grams)
        or (input_unit = 'serving' and food_serving_id is not null))
    )
    or (
      ingredient_kind = 'recipe'
      and food_version_id is null and food_serving_id is null
      and food_name is null and brand_name is null
      and custom_food_id is null and custom_food_version_number is null
      and source_id is null and source_code is null and source_release_id is null
      and source_display_name is null and license_expression is null
      and attribution_required is null and attribution_text is null and serving_label is null
      and nested_recipe_version_id is not null and nested_recipe_id is not null
      and nested_recipe_version_number > 0
      and char_length(btrim(nested_recipe_name)) between 1 and 200
      and nested_recipe_yield_grams > 0
      and nested_recipe_yield_grams < '1000000000000000000'::numeric
      and nested_recipe_yield_grams < 'Infinity'::numeric
      and ((nested_recipe_serving_count is null and nested_recipe_serving_label is null)
        or (nested_recipe_serving_count > 0
          and nested_recipe_serving_count < '1000000000000'::numeric
          and nested_recipe_serving_count < 'Infinity'::numeric
          and char_length(btrim(nested_recipe_serving_label)) between 1 and 100))
      and input_unit = 'g' and quantity = resolved_grams
    )
  ) is true),
  add foreign key (custom_food_id, food_version_id)
    references custom_food_version(custom_food_id, food_version_id) on delete restrict;

create or replace function guard_recipe_component_insert_v2()
returns trigger language plpgsql as $$
declare
  declared_count integer;
  actual_count integer;
  definition record;
  parent_calculation_version text;
begin
  if tg_table_name = 'recipe_ingredient' then
    if new.ingredient_kind = 'food' and new.custom_food_id is not null then
      perform 1
      from recipe_version parent
      join custom_food custom on custom.id = new.custom_food_id
      join custom_food_version custom_version
        on custom_version.custom_food_id = custom.id
       and custom_version.food_version_id = new.food_version_id
      join food on food.id = custom.food_id
      join food_version version on version.id = custom_version.food_version_id
      where parent.id = new.recipe_version_id
        and custom.user_id = parent.owner_user_id
        and custom.status = 'active'
        and custom_version.version_number = new.custom_food_version_number
        and food.owner_user_id = parent.owner_user_id
        and food.visibility = 'private' and food.kind = 'custom'
        and food.food_source_id is null and version.source_release_id is null
        and version.name = new.food_name
        and version.brand_name is not distinct from new.brand_name
        and version.basis_unit = 'g'
        and (
          (new.input_unit = 'g' and new.food_serving_id is null
            and new.serving_label is null and new.quantity = new.resolved_grams)
          or (new.input_unit = 'serving' and exists (
            select 1 from food_serving serving
            where serving.id = new.food_serving_id
              and serving.food_version_id = version.id
              and serving.label = new.serving_label
              and serving.gram_weight > 0 and serving.gram_weight < 'Infinity'::numeric
              and new.resolved_grams = new.quantity * serving.gram_weight
          ))
        )
      for share of custom, food, version;
      if not found then
        raise exception 'private custom-food ingredient does not match owner-scoped immutable evidence'
          using errcode = '23514';
      end if;
    elsif new.ingredient_kind = 'food' then
      perform 1
      from food_source source
      join food_source_release release
        on release.food_source_id = source.id and release.id = new.source_release_id
      join food on food.food_source_id = source.id
      join food_version version on version.food_id = food.id and version.source_release_id = release.id
      where version.id = new.food_version_id
        and source.id = new.source_id and source.active
        and source.commercial_use_allowed and source.redistribution_allowed
        and source.rights_review_status in ('approved', 'restricted')
        and source.rights_reviewed_at is not null
        and char_length(btrim(source.rights_reviewed_by)) > 0
        and release.status = 'promoted' and release.promoted_at is not null
        and release.rights_manifest_sha256 is not null
        and version.name = new.food_name
        and version.brand_name is not distinct from new.brand_name
        and source.code = new.source_code and source.display_name = new.source_display_name
        and source.license_expression = new.license_expression
        and source.attribution_required = new.attribution_required
        and source.attribution_text = new.attribution_text
        and exists (select 1 from promoted_food_search_catalogue_v1 eligible
                    where eligible.food_version_id = version.id)
        and ((new.input_unit = 'g' and new.food_serving_id is null
              and new.serving_label is null and new.quantity = new.resolved_grams)
          or (new.input_unit = 'serving' and exists (
            select 1 from food_serving serving
            where serving.id = new.food_serving_id and serving.food_version_id = version.id
              and serving.label = new.serving_label and serving.gram_weight > 0
              and serving.gram_weight < 'Infinity'::numeric
              and new.resolved_grams = new.quantity * serving.gram_weight)))
      for share of source, release, food, version;
      if not found then
        raise exception 'food ingredient source snapshot does not match its immutable food version'
          using errcode = '23514';
      end if;
    end if;
    select ingredient_count into strict declared_count
    from recipe_version where id = new.recipe_version_id for update;
    select count(*) into actual_count from recipe_ingredient
    where recipe_version_id = new.recipe_version_id;
    if new.ingredient_kind = 'recipe' then
      perform 1
      from recipe_version parent join recipe_version nested on nested.id = new.nested_recipe_version_id
      where parent.id = new.recipe_version_id
        and nested.owner_user_id = parent.owner_user_id
        and nested.recipe_id = new.nested_recipe_id
        and nested.version_number = new.nested_recipe_version_number
        and nested.name = new.nested_recipe_name
        and nested.total_weight_grams = new.nested_recipe_yield_grams
        and nested.serving_count is not distinct from new.nested_recipe_serving_count
        and nested.serving_label is not distinct from new.nested_recipe_serving_label
      for share of nested;
      if not found then
        raise exception 'nested recipe snapshot does not match its immutable version'
          using errcode = '23514';
      end if;
    end if;
  elsif tg_table_name = 'recipe_version_nutrient' then
    select nutrient_component_count, calculation_version
      into strict declared_count, parent_calculation_version
    from recipe_version where id = new.recipe_version_id for update;
    if new.calculation_version <> parent_calculation_version then
      raise exception 'recipe nutrient calculation version does not match its parent'
        using errcode = '23514';
    end if;
    select id, code, name, canonical_unit, active into strict definition
    from nutrient where id = new.nutrient_id for key share;
    if not definition.active or definition.code <> new.nutrient_code
      or definition.name <> new.nutrient_name or definition.canonical_unit <> new.unit then
      raise exception 'recipe nutrient snapshot does not match active ontology'
        using errcode = '23514';
    end if;
    select count(*) into actual_count from recipe_version_nutrient
    where recipe_version_id = new.recipe_version_id;
  else
    perform 1 from food_source source
    join food_source_release release
      on release.food_source_id = source.id and release.id = new.source_release_id
    where source.id = new.food_source_id and source.active
      and source.commercial_use_allowed and source.redistribution_allowed
      and source.rights_review_status in ('approved', 'restricted')
      and source.rights_reviewed_at is not null
      and char_length(btrim(source.rights_reviewed_by)) > 0
      and release.status = 'promoted' and release.promoted_at is not null
      and release.rights_manifest_sha256 is not null
      and source.code = new.source_code and source.display_name = new.source_display_name
      and source.license_expression = new.license_expression
      and source.attribution_required = new.attribution_required
      and source.attribution_text = new.attribution_text
    for share of source, release;
    if not found then
      raise exception 'recipe source snapshot does not match its source and release'
        using errcode = '23514';
    end if;
    select source_component_count into strict declared_count
    from recipe_version where id = new.recipe_version_id for update;
    select count(*) into actual_count from recipe_version_source
    where recipe_version_id = new.recipe_version_id;
  end if;
  if actual_count >= declared_count then
    raise exception 'recipe immutable component count would exceed declaration'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function reconcile_recipe_components_v2()
returns trigger language plpgsql as $$
declare
  version_id uuid;
  declared_ingredients integer;
  declared_nutrients integer;
  declared_sources integer;
  actual_ingredients integer;
  actual_nutrients integer;
  actual_sources integer;
  declared_input_mass numeric;
  actual_input_mass numeric;
begin
  if tg_table_name = 'recipe_version' then
    version_id := new.id;
  else
    version_id := coalesce(new.recipe_version_id, old.recipe_version_id);
  end if;
  select ingredient_count, nutrient_component_count, source_component_count, input_mass_grams
    into declared_ingredients, declared_nutrients, declared_sources, declared_input_mass
  from recipe_version where id = version_id;
  if not found then return null; end if;
  select count(*) into actual_ingredients from recipe_ingredient where recipe_version_id = version_id;
  select count(*) into actual_nutrients from recipe_version_nutrient where recipe_version_id = version_id;
  select count(*) into actual_sources from recipe_version_source where recipe_version_id = version_id;
  select sum(resolved_grams) into actual_input_mass
  from recipe_ingredient where recipe_version_id = version_id;
  if row(actual_ingredients, actual_nutrients, actual_sources)
    <> row(declared_ingredients, declared_nutrients, declared_sources) then
    raise exception 'recipe immutable component counts do not reconcile' using errcode = '23514';
  end if;
  if actual_input_mass is distinct from declared_input_mass then
    raise exception 'recipe input mass does not reconcile to immutable ingredients'
      using errcode = '23514';
  end if;
  lock table nutrient in share mode;
  if exists (
    select 1 from nutrient definition
    where definition.active and not exists (
      select 1 from recipe_version_nutrient actual
      where actual.recipe_version_id = version_id and actual.nutrient_id = definition.id)
    union all
    select 1 from recipe_version_nutrient actual
    join nutrient definition on definition.id = actual.nutrient_id
    where actual.recipe_version_id = version_id and not definition.active
  ) then
    raise exception 'recipe nutrient vector does not equal the active ontology'
      using errcode = '23514';
  end if;
  if exists (
    with expected as (
      select definition.id as nutrient_id,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is null
            and food_value.nutrient_id is not null and food_value.value_status <> 'trace' then 1
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and custom_value.value_state = 'quantified' then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.quantified_count, 0)
          else 0 end)::integer as quantified_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is null
            and food_value.value_status = 'trace' then 1
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and custom_value.value_state = 'trace' then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.trace_count, 0)
          else 0 end)::integer as trace_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is null
            and food_value.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and (custom_value.nutrient_id is null or custom_value.value_state = 'unknown') then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.unknown_count, 1)
          else 0 end)::integer as unknown_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is null
            and food_value.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and (custom_value.nutrient_id is null
              or (custom_value.value_state = 'unknown' and custom_value.unknown_reason = 'not_reported'))
            then 1
          when ingredient.ingredient_kind = 'recipe' and nested.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'recipe'
            then coalesce((nested.unknown_reasons->>'not_reported')::integer, 0)
          else 0 end)::integer as not_reported_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and custom_value.value_state = 'unknown' and custom_value.unknown_reason = 'not_analyzed'
            then 1
          when ingredient.ingredient_kind = 'recipe'
            then coalesce((nested.unknown_reasons->>'not_analyzed')::integer, 0)
          else 0 end)::integer as not_analyzed_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and custom_value.value_state = 'unknown' and custom_value.unknown_reason = 'not_applicable'
            then 1
          when ingredient.ingredient_kind = 'recipe'
            then coalesce((nested.unknown_reasons->>'not_applicable')::integer, 0)
          else 0 end)::integer as not_applicable_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
            and custom_value.value_state = 'unknown' and custom_value.unknown_reason = 'withheld'
            then 1
          when ingredient.ingredient_kind = 'recipe'
            then coalesce((nested.unknown_reasons->>'withheld')::integer, 0)
          else 0 end)::integer as withheld_count
      from recipe_ingredient ingredient
      cross join nutrient definition
      left join food_nutrient_value food_value
        on ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is null
       and food_value.food_version_id = ingredient.food_version_id
       and food_value.nutrient_id = definition.id
      left join custom_food_version_nutrient custom_value
        on ingredient.ingredient_kind = 'food' and ingredient.custom_food_id is not null
       and custom_value.custom_food_id = ingredient.custom_food_id
       and custom_value.food_version_id = ingredient.food_version_id
       and custom_value.nutrient_id = definition.id
      left join recipe_version_nutrient nested
        on ingredient.ingredient_kind = 'recipe'
       and nested.recipe_version_id = ingredient.nested_recipe_version_id
       and nested.nutrient_id = definition.id
      where ingredient.recipe_version_id = version_id and definition.active
      group by definition.id
    )
    select 1 from expected
    join recipe_version_nutrient actual
      on actual.recipe_version_id = version_id and actual.nutrient_id = expected.nutrient_id
    where actual.quantified_count <> expected.quantified_count
      or actual.trace_count <> expected.trace_count
      or actual.unknown_count <> expected.unknown_count
      or actual.contributor_count <>
        expected.quantified_count + expected.trace_count + expected.unknown_count
      or coalesce((actual.unknown_reasons->>'not_reported')::integer, 0)
        <> expected.not_reported_count
      or coalesce((actual.unknown_reasons->>'not_analyzed')::integer, 0)
        <> expected.not_analyzed_count
      or coalesce((actual.unknown_reasons->>'not_applicable')::integer, 0)
        <> expected.not_applicable_count
      or coalesce((actual.unknown_reasons->>'withheld')::integer, 0)
        <> expected.withheld_count
  ) then
    raise exception 'recipe nutrient coverage does not reconcile to immutable ingredients'
      using errcode = '23514';
  end if;
  if exists (
    with expected_sources(food_source_id, source_release_id) as (
      select ingredient.source_id, ingredient.source_release_id
      from recipe_ingredient ingredient
      where ingredient.recipe_version_id = version_id
        and ingredient.ingredient_kind = 'food' and ingredient.source_id is not null
      union
      select nested.food_source_id, nested.source_release_id
      from recipe_ingredient ingredient
      join recipe_version_source nested
        on nested.recipe_version_id = ingredient.nested_recipe_version_id
      where ingredient.recipe_version_id = version_id and ingredient.ingredient_kind = 'recipe'
    )
    select 1 from expected_sources expected where not exists (
      select 1 from recipe_version_source actual
      where actual.recipe_version_id = version_id
        and actual.food_source_id = expected.food_source_id
        and actual.source_release_id = expected.source_release_id)
    union all
    select 1 from recipe_version_source actual
    where actual.recipe_version_id = version_id and not exists (
      select 1 from expected_sources expected
      where expected.food_source_id = actual.food_source_id
        and expected.source_release_id = actual.source_release_id)
  ) then
    raise exception 'recipe attribution set does not match direct and nested ingredients'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

-- Repeat provenance and private-food provenance are immutable revision facts.
alter table diary_entry_revision
  add column custom_food_id uuid,
  add column custom_food_version_number integer,
  add column repeated_from_revision_id uuid references diary_entry_revision(id) on delete restrict,
  add constraint diary_custom_food_snapshot_v3 check ((
    entry_kind <> 'food'
    or (
      (custom_food_id is null and custom_food_version_number is null)
      or
      (custom_food_id is not null and custom_food_version_number > 0
        and source_code is null and source_release_id is null
        and source_display_name is null and license_expression is null
        and attribution_required is null and attribution_text is null)
    )
  ) is true),
  add constraint diary_repeat_not_self_v3
    check (repeated_from_revision_id is null or repeated_from_revision_id <> id),
  add foreign key (custom_food_id, user_id)
    references custom_food(id, user_id) on delete restrict deferrable initially deferred;

alter table diary_entry
  add column custom_food_id uuid,
  add column custom_food_version_number integer,
  add column repeated_from_revision_id uuid references diary_entry_revision(id) on delete restrict,
  add constraint diary_custom_food_head_v3 check ((
    entry_kind <> 'food'
    or ((custom_food_id is null and custom_food_version_number is null)
      or (custom_food_id is not null and custom_food_version_number > 0))
  ) is true),
  add foreign key (custom_food_id, user_id)
    references custom_food(id, user_id) on delete restrict deferrable initially deferred;

create function validate_diary_custom_food_snapshot_v3()
returns trigger language plpgsql as $$
begin
  if new.entry_kind = 'food' and new.custom_food_id is not null and not exists (
    select 1
    from custom_food custom
    join food_version version on version.food_id = custom.food_id
    where custom.id = new.custom_food_id
      and custom.user_id = new.user_id
      and version.id = new.food_version_id
      and version.version_number = new.custom_food_version_number
  ) then
    raise exception 'private custom-food diary snapshot does not match its immutable version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger diary_revision_validate_custom_food_v3
before insert on diary_entry_revision
for each row execute function validate_diary_custom_food_snapshot_v3();

create function reconcile_diary_retention_head_v3()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from diary_entry_revision revision
    where revision.id = new.current_revision_id
      and revision.diary_entry_id = new.id
      and revision.custom_food_id is not distinct from new.custom_food_id
      and revision.custom_food_version_number is not distinct from new.custom_food_version_number
      and revision.repeated_from_revision_id is not distinct from new.repeated_from_revision_id
  ) then
    raise exception 'diary head retention provenance does not match its current revision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger diary_entry_reconcile_retention_head_v3
after insert or update on diary_entry
deferrable initially deferred
for each row execute function reconcile_diary_retention_head_v3();

create table biometric_definition (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  current_version_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (id, user_id),
  check ((status = 'archived') = (archived_at is not null))
);

create table biometric_definition_version (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null,
  user_id uuid not null,
  version_number bigint not null check (version_number > 0),
  code text not null check (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  canonical_unit text not null check (char_length(btrim(canonical_unit)) between 1 and 32),
  dimension text not null check (dimension in ('mass', 'length', 'temperature', 'duration', 'count', 'other')),
  minimum_value numeric check (minimum_value is null or minimum_value > '-Infinity'::numeric),
  maximum_value numeric check (maximum_value is null or maximum_value < 'Infinity'::numeric),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and (metadata->'notes' is null or metadata->'notes' = 'null'::jsonb
         or (jsonb_typeof(metadata->'notes') = 'string' and char_length(metadata->>'notes') <= 1000))
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (definition_id, version_number),
  unique (definition_id, id),
  foreign key (definition_id, user_id) references biometric_definition(id, user_id) on delete cascade,
  check (minimum_value is null or maximum_value is null or minimum_value <= maximum_value)
);
alter table biometric_definition
  add foreign key (id, current_version_id)
    references biometric_definition_version(definition_id, id) deferrable initially deferred;
create unique index biometric_definition_active_code_v3
  on biometric_definition_version(user_id, code)
  where version_number = 1;
create function guard_biometric_definition_identity_v3() returns trigger language plpgsql as $$
begin
  if new.version_number > 1 and not exists (
    select 1
    from biometric_definition_version initial
    where initial.definition_id = new.definition_id
      and initial.version_number = 1
      and initial.user_id = new.user_id
      and initial.code = new.code
      and initial.dimension = new.dimension
      and initial.canonical_unit = new.canonical_unit
      and initial.minimum_value is not distinct from new.minimum_value
      and initial.maximum_value is not distinct from new.maximum_value
  ) then
    raise exception 'biometric definition identity is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger biometric_definition_identity_guard_v3
before insert on biometric_definition_version
for each row execute function guard_biometric_definition_identity_v3();
create trigger biometric_definition_version_reject_update_v3
before update or delete on biometric_definition_version
for each row execute function guard_retention_immutable_row_v3();
create trigger biometric_definition_set_updated_at_v3
before update on biometric_definition
for each row execute function set_row_updated_at();
create trigger biometric_definition_bump_watermark_v3
after insert or update or delete on biometric_definition
for each row execute function bump_user_data_watermark_v3('user_id');

create function guard_retention_owner_cap_v3() returns trigger language plpgsql as $$
declare row_count bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('nutrition-tracker:retention:' || new.user_id::text, 0)
  );
  execute format('select count(*) from %I where user_id = $1', tg_table_name)
    into row_count using new.user_id;
  if row_count > tg_argv[0]::bigint then
    raise exception '% owner row limit exceeded', tg_table_name using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger biometric_definition_owner_cap_v3
after insert on biometric_definition
deferrable initially immediate
for each row execute function guard_retention_owner_cap_v3('100');

create table biometric_definition_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'revise', 'archive')),
  definition_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id),
  foreign key (definition_id, user_id)
    references biometric_definition(id, user_id) on delete cascade
);
create trigger biometric_definition_operation_reject_update_v3
before update or delete on biometric_definition_operation
for each row execute function guard_retention_immutable_row_v3();

create table biometric_event (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  current_revision_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (id, user_id)
);

create table biometric_event_revision (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  user_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  operation text not null check (operation in ('create', 'update', 'delete')),
  definition_version_id uuid not null references biometric_definition_version(id) on delete restrict,
  value numeric not null check (value > '-Infinity'::numeric and value < 'Infinity'::numeric and char_length(value::text) <= 160),
  canonical_unit text not null check (char_length(btrim(canonical_unit)) between 1 and 32),
  measured_at timestamptz not null check (isfinite(measured_at)),
  local_date date not null check (isfinite(local_date)),
  local_time time without time zone not null,
  time_zone text not null check (octet_length(time_zone) between 1 and 63),
  source_kind text not null check (source_kind in ('manual', 'device', 'platform')),
  source_device_id uuid,
  provider text,
  external_source_id text,
  external_revision text,
  raw_digest text check (raw_digest is null or raw_digest ~ '^[0-9a-f]{64}$'),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  unique (event_id, revision_number),
  unique (event_id, id),
  foreign key (event_id, user_id) references biometric_event(id, user_id) on delete cascade,
  check ((source_kind = 'manual') = (
    source_device_id is null and provider is null and external_source_id is null
    and external_revision is null and raw_digest is null
  )),
  check ((source_kind = 'manual') or source_device_id is not null)
);
alter table biometric_event
  add foreign key (id, current_revision_id)
    references biometric_event_revision(event_id, id) deferrable initially deferred;
create trigger biometric_event_revision_validate_timezone_v3
before insert or update of time_zone on biometric_event_revision
for each row execute function validate_iana_time_zone();
create trigger biometric_event_revision_reject_update_v3
before update or delete on biometric_event_revision
for each row execute function guard_retention_immutable_row_v3();
create trigger biometric_event_set_updated_at_v3
before update on biometric_event
for each row execute function set_row_updated_at();
create trigger biometric_event_bump_watermark_v3
after insert or update or delete on biometric_event
for each row execute function bump_user_data_watermark_v3('user_id');
create index biometric_event_user_time_v3 on biometric_event_revision(user_id, measured_at desc, id desc);

create table biometric_event_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'update', 'delete')),
  event_id uuid not null,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id),
  foreign key (event_id, user_id) references biometric_event(id, user_id) on delete cascade
);
create trigger biometric_event_operation_reject_update_v3
before update or delete on biometric_event_operation
for each row execute function guard_retention_immutable_row_v3();

create table reminder_consent (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  current_version_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  status text not null check (status in ('granted', 'revoked')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id)
);
create table reminder_consent_version (
  id uuid primary key default gen_random_uuid(),
  consent_id uuid not null,
  user_id uuid not null,
  version_number bigint not null check (version_number > 0),
  status text not null check (status in ('granted', 'revoked')),
  policy_version text not null check (char_length(btrim(policy_version)) between 1 and 100),
  reason text check (reason is null or char_length(reason) <= 1000),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  created_at timestamptz not null default clock_timestamp(),
  unique (consent_id, version_number),
  unique (consent_id, id),
  foreign key (consent_id, user_id) references reminder_consent(id, user_id) on delete cascade
);
alter table reminder_consent add foreign key (id, current_version_id)
  references reminder_consent_version(consent_id, id) deferrable initially deferred;
create trigger reminder_consent_version_reject_update_v3
before update or delete on reminder_consent_version
for each row execute function guard_retention_immutable_row_v3();
create trigger reminder_consent_set_updated_at_v3
before update on reminder_consent
for each row execute function set_row_updated_at();
create trigger reminder_consent_bump_watermark_v3
after insert or update or delete on reminder_consent
for each row execute function bump_user_data_watermark_v3('user_id');

create table reminder_schedule (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  current_version_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  next_delivery_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (id, user_id),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (next_delivery_at is null or isfinite(next_delivery_at))
);
create function is_canonical_iso_weekdays_v3(days smallint[]) returns boolean
language sql immutable strict as $$
  select cardinality(days) between 1 and 7
     and days <@ array[1,2,3,4,5,6,7]::smallint[]
     and days = array(select distinct value from unnest(days) value order by value)
$$;

create table reminder_schedule_version (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
  user_id uuid not null,
  version_number bigint not null check (version_number > 0),
  schedule_status text not null check (schedule_status in ('active', 'paused', 'revoked')),
  consent_version_id uuid not null references reminder_consent_version(id) on delete restrict,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  channel text not null check (channel = 'local'),
  time_zone text not null check (octet_length(time_zone) between 1 and 63),
  local_time time without time zone not null,
  days_of_week smallint[] not null,
  dst_policy text not null check (dst_policy = 'earliest_offset_skip_gap'),
  notification_title text not null check (notification_title = 'Nutrition Tracker'),
  notification_body text not null
    check (notification_body = 'Time to check in.'),
  initial_delivery_at timestamptz check (initial_delivery_at is null or isfinite(initial_delivery_at)),
  created_at timestamptz not null default clock_timestamp(),
  unique (schedule_id, version_number),
  unique (schedule_id, id),
  foreign key (schedule_id, user_id) references reminder_schedule(id, user_id) on delete cascade,
  check (is_canonical_iso_weekdays_v3(days_of_week)),
  check ((schedule_status = 'active') = (initial_delivery_at is not null))
);
alter table reminder_schedule add foreign key (id, current_version_id)
  references reminder_schedule_version(schedule_id, id) deferrable initially deferred;
create trigger reminder_schedule_version_validate_timezone_v3
before insert or update of time_zone on reminder_schedule_version
for each row execute function validate_iana_time_zone();
create trigger reminder_schedule_version_reject_update_v3
before update or delete on reminder_schedule_version
for each row execute function guard_retention_immutable_row_v3();
create function reconcile_reminder_schedule_head_v3() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from reminder_schedule_version version
    where version.schedule_id = new.id
      and version.id = new.current_version_id
      and version.user_id = new.user_id
      and version.version_number = new.current_revision
      and version.schedule_status = new.status
  ) then
    raise exception 'reminder schedule head does not match its immutable version'
      using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger reminder_schedule_head_reconcile_v3
after insert or update on reminder_schedule
deferrable initially deferred
for each row execute function reconcile_reminder_schedule_head_v3();
create trigger reminder_schedule_set_updated_at_v3
before update on reminder_schedule
for each row execute function set_row_updated_at();
create trigger reminder_schedule_bump_watermark_v3
after insert or update or delete on reminder_schedule
for each row execute function bump_user_data_watermark_v3('user_id');
create function guard_reminder_schedule_owner_cap_v3() returns trigger language plpgsql as $$
declare row_count bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('nutrition-tracker:retention:' || new.user_id::text, 0)
  );
  select count(*) into row_count
  from reminder_schedule
  where user_id = new.user_id and status <> 'revoked';
  if row_count > 100 then
    raise exception 'reminder schedule owner row limit exceeded' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger reminder_schedule_owner_cap_v3
after insert or update on reminder_schedule
deferrable initially immediate
for each row execute function guard_reminder_schedule_owner_cap_v3();

create function guard_reminder_version_occurrence_cap_v3() returns trigger language plpgsql as $$
declare active_occurrences bigint;
begin
  if new.schedule_status <> 'active' then return new; end if;
  perform pg_advisory_xact_lock(
    hashtextextended('nutrition-tracker:retention:' || new.user_id::text, 0)
  );
  select coalesce(sum(cardinality(version.days_of_week)), 0)
    into active_occurrences
  from reminder_schedule root
  join reminder_schedule_version version on version.id = root.current_version_id
  where root.user_id = new.user_id
    and root.status = 'active'
    and root.id <> new.schedule_id;
  if active_occurrences + cardinality(new.days_of_week) > 64 then
    raise exception 'active reminder occurrence limit exceeded' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger reminder_version_occurrence_cap_v3
before insert on reminder_schedule_version
for each row execute function guard_reminder_version_occurrence_cap_v3();

create function guard_reminder_head_occurrence_cap_v3() returns trigger language plpgsql as $$
declare active_occurrences bigint;
declare requested_occurrences integer;
begin
  if new.status <> 'active' then return new; end if;
  if new.status = old.status and new.current_version_id = old.current_version_id then return new; end if;
  perform pg_advisory_xact_lock(
    hashtextextended('nutrition-tracker:retention:' || new.user_id::text, 0)
  );
  select cardinality(days_of_week) into requested_occurrences
  from reminder_schedule_version
  where schedule_id = new.id and id = new.current_version_id and user_id = new.user_id;
  if requested_occurrences is null then
    raise exception 'active reminder head version is unavailable' using errcode = '23514';
  end if;
  select coalesce(sum(cardinality(version.days_of_week)), 0)
    into active_occurrences
  from reminder_schedule root
  join reminder_schedule_version version on version.id = root.current_version_id
  where root.user_id = new.user_id
    and root.status = 'active'
    and root.id <> new.id;
  if active_occurrences + requested_occurrences > 64 then
    raise exception 'active reminder occurrence limit exceeded' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger reminder_head_occurrence_cap_v3
before update of current_version_id, status on reminder_schedule
for each row execute function guard_reminder_head_occurrence_cap_v3();

create table device_registration (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  platform text not null check (platform in ('apple_healthkit', 'android_health_connect')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
  public_key_spki_base64 text not null check (octet_length(public_key_spki_base64) between 32 and 8192),
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  key_algorithm text not null check (key_algorithm = 'ES256'),
  proof_signature_digest text not null check (proof_signature_digest ~ '^[0-9a-f]{64}$'),
  attestation_status text not null check (attestation_status in ('not_provided', 'unverified', 'verified')),
  attestation_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(attestation_metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (id, user_id),
  unique (user_id, key_fingerprint)
);
create trigger device_registration_set_updated_at_v3
before update on device_registration
for each row execute function set_row_updated_at();
create trigger device_registration_bump_watermark_v3
after insert or update or delete on device_registration
for each row execute function bump_user_data_watermark_v3('user_id');

alter table biometric_event_revision
  add foreign key (source_device_id, user_id)
    references device_registration(id, user_id) on delete restrict;

create table security_challenge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  device_id uuid,
  purpose text not null check (purpose = 'device_registration'),
  platform text not null check (platform in ('apple_healthkit', 'android_health_connect')),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null check (isfinite(expires_at)),
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  proof_signature_digest text check (proof_signature_digest is null or proof_signature_digest ~ '^[0-9a-f]{64}$'),
  unique (user_id, nonce_hash),
  foreign key (device_id, user_id) references device_registration(id, user_id) on delete cascade,
  check (consumed_at is null or revoked_at is null)
);

create table reauthentication_proof (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  session_token_hash text not null check (session_token_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('account_export', 'account_erasure')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null check (isfinite(expires_at)),
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  consumed_client_operation_id uuid,
  revoked_at timestamptz,
  unique (user_id, token_hash),
  check ((consumed_at is null) = (consumed_client_operation_id is null))
);

create table platform_integration (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  device_id uuid not null,
  platform text not null check (platform in ('apple_healthkit', 'android_health_connect')),
  current_version_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  status text not null check (status in ('connected', 'disconnected')),
  data_type_codes text[] not null default array['body_weight']::text[]
    check (data_type_codes = array['body_weight']::text[]),
  cursor_epoch bigint not null default 1 check (cursor_epoch > 0),
  current_source_cursor text,
  consent_granted_at timestamptz not null check (isfinite(consent_granted_at)),
  disconnected_at timestamptz,
  last_import_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  unique (user_id, platform),
  foreign key (device_id, user_id) references device_registration(id, user_id) on delete restrict,
  check ((status = 'disconnected') = (disconnected_at is not null))
);
create table platform_integration_version (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null,
  user_id uuid not null,
  device_id uuid not null,
  version_number bigint not null check (version_number > 0),
  status text not null check (status in ('connected', 'disconnected')),
  data_type_codes text[] not null check (data_type_codes = array['body_weight']::text[]),
  recorded_at timestamptz not null check (isfinite(recorded_at)),
  disconnect_disposition text check (disconnect_disposition in ('retain', 'delete')),
  created_at timestamptz not null default clock_timestamp(),
  unique (integration_id, version_number),
  unique (integration_id, id),
  foreign key (integration_id, user_id)
    references platform_integration(id, user_id) on delete cascade,
  foreign key (device_id, user_id)
    references device_registration(id, user_id) on delete restrict,
  check ((status = 'disconnected') = (disconnect_disposition is not null))
);
alter table platform_integration add foreign key (id, current_version_id)
  references platform_integration_version(integration_id, id) deferrable initially deferred;
create trigger platform_integration_version_reject_update_v3
before update or delete on platform_integration_version
for each row execute function guard_retention_immutable_row_v3();
create trigger platform_integration_set_updated_at_v3
before update on platform_integration
for each row execute function set_row_updated_at();
create trigger platform_integration_bump_watermark_v3
after insert or update or delete on platform_integration
for each row execute function bump_user_data_watermark_v3('user_id');

create table platform_import_batch (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null,
  user_id uuid not null,
  device_id uuid not null,
  batch_id uuid not null,
  cursor_epoch bigint not null check (cursor_epoch > 0),
  source_cursor text,
  next_source_cursor text not null check (char_length(next_source_cursor) between 1 and 1000),
  batch_digest text not null check (batch_digest ~ '^[0-9a-f]{64}$'),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  signature_digest text not null check (signature_digest ~ '^[0-9a-f]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz not null check (isfinite(signed_at)),
  record_count integer not null check (record_count between 0 and 1000),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  applied_at timestamptz not null default clock_timestamp(),
  unique (integration_id, batch_id),
  unique (device_id, nonce_hash),
  unique (integration_id, cursor_epoch, source_cursor, next_source_cursor),
  foreign key (integration_id, user_id) references platform_integration(id, user_id) on delete cascade,
  foreign key (device_id, user_id) references device_registration(id, user_id) on delete restrict
);
create trigger platform_import_batch_reject_update_v3
before update or delete on platform_import_batch
for each row execute function guard_retention_immutable_row_v3();

create table reminder_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  schedule_id uuid not null,
  schedule_version_id uuid not null references reminder_schedule_version(id) on delete cascade,
  device_id uuid,
  scheduled_for timestamptz not null check (isfinite(scheduled_for)),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed','cancelled')),
  notification_title text not null default 'Nutrition Tracker'
    check (notification_title = 'Nutrition Tracker'),
  notification_body text not null default 'Time to check in.'
    check (notification_body = 'Time to check in.'),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  dead_lettered_at timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  unique nulls not distinct (schedule_id, schedule_version_id, scheduled_for, device_id),
  foreign key (schedule_id, user_id) references reminder_schedule(id, user_id) on delete cascade,
  foreign key (device_id, user_id) references device_registration(id, user_id) on delete cascade,
  check ((locked_at is null) = (locked_by is null))
);
create index reminder_delivery_claim_v3 on reminder_delivery_outbox(status, available_at, scheduled_for);

create table platform_health_import (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  integration_id uuid not null,
  device_id uuid,
  provider text not null check (char_length(btrim(provider)) between 1 and 64),
  external_source_id text not null check (char_length(external_source_id) between 1 and 500),
  current_revision_id uuid not null,
  current_revision bigint not null default 1 check (current_revision > 0),
  state text not null check (state in ('active', 'deleted', 'conflict')),
  current_event_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, user_id),
  unique (integration_id, external_source_id),
  foreign key (device_id, user_id) references device_registration(id, user_id) on delete restrict,
  foreign key (integration_id, user_id) references platform_integration(id, user_id) on delete cascade,
  foreign key (current_event_id, user_id) references biometric_event(id, user_id) on delete restrict
);
create table platform_health_import_revision (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null,
  user_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  operation text not null check (operation in ('upsert', 'delete')),
  provider_revision text not null check (char_length(provider_revision) between 1 and 300),
  provider_modified_at timestamptz not null check (isfinite(provider_modified_at)),
  raw_digest text not null check (raw_digest ~ '^[0-9a-f]{64}$'),
  definition_version_id uuid references biometric_definition_version(id) on delete restrict,
  measured_at timestamptz,
  canonical_value numeric,
  canonical_unit text,
  biometric_event_revision_id uuid references biometric_event_revision(id) on delete restrict,
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  received_at timestamptz not null default clock_timestamp(),
  unique (import_id, revision_number),
  unique (import_id, id),
  foreign key (import_id, user_id) references platform_health_import(id, user_id) on delete cascade,
  check ((operation = 'delete') = (definition_version_id is null and measured_at is null and canonical_value is null and canonical_unit is null)),
  check (canonical_value is null or (canonical_value > '-Infinity'::numeric and canonical_value < 'Infinity'::numeric and char_length(canonical_value::text) <= 160))
);
alter table platform_health_import add foreign key (id, current_revision_id)
  references platform_health_import_revision(import_id, id) deferrable initially deferred;
create table platform_health_import_conflict (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references platform_health_import(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  provider_revision text not null,
  provider_modified_at timestamptz not null,
  existing_raw_digest text not null check (existing_raw_digest ~ '^[0-9a-f]{64}$'),
  attempted_raw_digest text not null check (attempted_raw_digest ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  detected_at timestamptz not null default clock_timestamp()
);
create trigger platform_health_import_revision_reject_update_v3
before update or delete on platform_health_import_revision
for each row execute function guard_retention_immutable_row_v3();
create trigger platform_health_import_conflict_reject_update_v3
before update or delete on platform_health_import_conflict
for each row execute function guard_retention_immutable_row_v3();
create trigger platform_health_import_set_updated_at_v3
before update on platform_health_import
for each row execute function set_row_updated_at();
create trigger platform_health_import_bump_watermark_v3
after insert or update or delete on platform_health_import
for each row execute function bump_user_data_watermark_v3('user_id');

create table privacy_export_job (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  requested_formats text[] not null default array['json']::text[]
    check (requested_formats <@ array['json','csv']::text[] and cardinality(requested_formats) between 1 and 2),
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  started_at timestamptz,
  expires_at timestamptz,
  failure_code text check (failure_code is null or failure_code = 'EXPORT_FAILED'),
  available_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  dead_lettered_at timestamptz,
  watermark_revision bigint,
  snapshot_id text,
  snapshot_bytes bigint check (snapshot_bytes is null or snapshot_bytes >= 0),
  manifest_digest text check (manifest_digest is null or manifest_digest ~ '^[0-9a-f]{64}$'),
  entity_count bigint check (entity_count is null or entity_count >= 0),
  semantic_reconciliation_digest text check (
    semantic_reconciliation_digest is null or semantic_reconciliation_digest ~ '^[0-9a-f]{64}$'
  ),
  reconciliation jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (user_id, client_operation_id),
  unique (id, user_id),
  check (reconciliation is null or jsonb_typeof(reconciliation) = 'object'),
  check ((locked_at is null) = (locked_by is null))
);
create unique index privacy_export_job_one_retryable_per_user_v3
  on privacy_export_job(user_id)
  where status in ('queued','running','failed') and dead_lettered_at is null;
create table privacy_export_entity_snapshot (
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  entity_type text not null check (char_length(entity_type) between 1 and 100),
  source_count bigint not null check (source_count >= 0),
  watermark_revision bigint not null check (watermark_revision >= 0),
  source_record_set_sha256 text not null check (source_record_set_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (job_id, entity_type)
);
create table privacy_export_upload_artifact (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  snapshot_id text not null check (char_length(btrim(snapshot_id)) between 1 and 500),
  format text not null check (format in ('json','csv_zip')),
  object_key text not null check (char_length(btrim(object_key)) between 1 and 1000),
  worker_id text not null check (char_length(btrim(worker_id)) between 1 and 200),
  status text not null default 'staged' check (status in ('staged','uploading','uploaded','promoted','cancelled','deleted')),
  staged_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  dead_lettered_at timestamptz,
  last_error_code text,
  uploaded_at timestamptz,
  upload_lease_expires_at timestamptz,
  cancelled_at timestamptz,
  deleted_at timestamptz,
  deletion_evidence_digest text check (
    deletion_evidence_digest is null or deletion_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  unique (job_id, snapshot_id, format),
  unique (object_key),
  check ((locked_at is null) = (locked_by is null)),
  check (
    (status = 'staged' and uploaded_at is null and upload_lease_expires_at is null and cancelled_at is null and deleted_at is null)
    or (status = 'uploading' and uploaded_at is null and upload_lease_expires_at is not null and deleted_at is null)
    or (status in ('uploaded','promoted') and uploaded_at is not null and upload_lease_expires_at is null and cancelled_at is null and deleted_at is null)
    or (status = 'cancelled' and upload_lease_expires_at is null and cancelled_at is not null and deleted_at is null)
    or (status = 'deleted' and upload_lease_expires_at is null and cancelled_at is not null and deleted_at is not null and deletion_evidence_digest is not null)
  )
);
create table privacy_export_artifact (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  format text not null check (format in ('json','csv_zip')),
  file_name text not null check (char_length(btrim(file_name)) between 1 and 200),
  media_type text not null check (media_type in ('application/json','application/zip')),
  object_key text not null check (char_length(btrim(object_key)) between 1 and 1000),
  plaintext_bytes bigint not null check (plaintext_bytes >= 0),
  plaintext_sha256 text not null check (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_bytes bigint not null check (ciphertext_bytes >= 0),
  encryption_key_id text not null check (char_length(btrim(encryption_key_id)) between 1 and 500),
  expires_at timestamptz not null check (isfinite(expires_at)),
  created_at timestamptz not null default clock_timestamp(),
  unique (job_id, format)
);
create function guard_privacy_export_artifact_insert_v3() returns trigger language plpgsql as $$
declare
  job_status text;
  sibling_expiry timestamptz;
begin
  select status into job_status from privacy_export_job where id = new.job_id for update;
  if job_status is distinct from 'running' then
    raise exception using errcode = '55000', message = 'export artifacts may only be installed while the job is running';
  end if;
  select expires_at into sibling_expiry
  from privacy_export_artifact where job_id = new.job_id limit 1;
  if sibling_expiry is not null and sibling_expiry is distinct from new.expires_at then
    raise exception using errcode = '23514', message = 'all export artifacts must share one expiry';
  end if;
  return new;
end $$;
create trigger privacy_export_artifact_insert_guard_v3
before insert on privacy_export_artifact
for each row execute function guard_privacy_export_artifact_insert_v3();

create function guard_privacy_export_job_completion_v3() returns trigger language plpgsql as $$
declare
  artifact_count integer;
  earliest_expiry timestamptz;
  latest_expiry timestamptz;
  format_count integer;
begin
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
create trigger privacy_export_job_completion_guard_v3
before update of status,expires_at,requested_formats on privacy_export_job
for each row execute function guard_privacy_export_job_completion_v3();
create table privacy_export_artifact_deletion (
  artifact_id uuid primary key references privacy_export_artifact(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  dead_lettered_at timestamptz,
  deletion_evidence_digest text check (deletion_evidence_digest is null or deletion_evidence_digest ~ '^[0-9a-f]{64}$'),
  deleted_at timestamptz,
  last_error_code text,
  check ((locked_at is null) = (locked_by is null)),
  check ((status = 'completed') = (deleted_at is not null and deletion_evidence_digest is not null))
);
create table privacy_export_artifact_tombstone (
  artifact_id uuid primary key,
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  format text not null check (format in ('json','csv_zip')),
  deleted_at timestamptz not null check (isfinite(deleted_at)),
  deletion_evidence_digest text not null check (deletion_evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create trigger privacy_export_artifact_tombstone_reject_update_v3
before update or delete on privacy_export_artifact_tombstone
for each row execute function guard_retention_immutable_row_v3();
create table privacy_export_download_audit (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  format text not null check (format in ('json','csv_zip')),
  outcome text not null check (outcome in ('opened','not_found','failed')),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (job_id,user_id) references privacy_export_job(id,user_id) on delete cascade
);
create index privacy_export_download_audit_user_time_v3
  on privacy_export_download_audit(user_id,occurred_at desc,id desc);
create trigger privacy_export_download_audit_reject_update_v3
before update or delete on privacy_export_download_audit
for each row execute function guard_retention_immutable_row_v3();
create table privacy_export_record (
  job_id uuid not null references privacy_export_job(id) on delete cascade,
  ordinal bigint not null check (ordinal > 0),
  entity_type text not null,
  entity_id text not null,
  revision text,
  deleted boolean not null,
  watermark_revision bigint not null check (watermark_revision >= 0),
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (job_id, ordinal),
  unique (job_id, entity_type, entity_id)
);
create trigger privacy_export_job_set_updated_at_v3
before update on privacy_export_job
for each row execute function set_row_updated_at();
create or replace function guard_privacy_export_snapshot_change_v3() returns trigger language plpgsql as $$
declare job_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'privacy export snapshot evidence is immutable';
  end if;
  if pg_trigger_depth() > 1 or
     coalesce(current_setting('nutrition_tracker.account_erasure', true), '') = 'on' then
    return old;
  end if;
  select status into job_status from privacy_export_job where id = old.job_id for update;
  if job_status is distinct from 'completed' then return old; end if;
  raise exception using errcode = '55000', message = 'completed privacy export snapshot evidence is immutable';
end $$;
create trigger privacy_export_record_guard_v3
before update or delete on privacy_export_record
for each row execute function guard_privacy_export_snapshot_change_v3();
create trigger privacy_export_entity_snapshot_guard_v3
before update or delete on privacy_export_entity_snapshot
for each row execute function guard_privacy_export_snapshot_change_v3();
create trigger privacy_export_artifact_reject_update_v3
before update or delete on privacy_export_artifact
for each row execute function guard_retention_immutable_row_v3();

create table account_erasure_job (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references app_user(id) on delete set null,
  client_operation_id uuid,
  request_digest text check (request_digest is null or request_digest ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  requested_at timestamptz not null default clock_timestamp(),
  execute_after timestamptz not null check (isfinite(execute_after)),
  available_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  dead_lettered_at timestamptz,
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  status_capability_hash text not null check (status_capability_hash ~ '^[0-9a-f]{64}$'),
  status_capability_expires_at timestamptz not null check (isfinite(status_capability_expires_at)),
  recovery_session_token_hash text check (recovery_session_token_hash is null or recovery_session_token_hash ~ '^[0-9a-f]{64}$'),
  restore_locator text check (restore_locator is null or char_length(btrim(restore_locator)) between 32 and 500),
  restore_ledger_reference text,
  restore_ledger_digest text check (restore_ledger_digest is null or restore_ledger_digest ~ '^[0-9a-f]{64}$'),
  restore_ledger_acknowledged_at timestamptz,
  object_deletion_evidence jsonb,
  unique (user_id, client_operation_id),
  unique (status_capability_hash),
  check ((locked_at is null) = (locked_by is null)),
  check (object_deletion_evidence is null or jsonb_typeof(object_deletion_evidence) = 'object'),
  check ((restore_ledger_reference is null) = (restore_ledger_digest is null)),
  check ((restore_ledger_reference is null) = (restore_ledger_acknowledged_at is null)),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'completed') = (
    user_id is null and client_operation_id is null and request_digest is null and
    recovery_session_token_hash is null and
    restore_locator is null and restore_ledger_reference is null and restore_ledger_digest is null and
    restore_ledger_acknowledged_at is null and object_deletion_evidence is null and
    locked_at is null and locked_by is null
  )),
  check (
    status = 'completed'
    or (
      user_id is not null and client_operation_id is not null and request_digest is not null and
      recovery_session_token_hash is not null and restore_locator is not null
    )
    or (
      coalesce(current_setting('nutrition_tracker.account_erasure', true), '') = 'on'
      and user_id is null
    )
  )
);
create table account_erasure_receipt (
  id uuid primary key,
  job_id uuid not null unique references account_erasure_job(id) on delete restrict,
  completed_at timestamptz not null check (isfinite(completed_at)),
  policy_version text not null,
  deleted_counts jsonb not null check (jsonb_typeof(deleted_counts) = 'object'),
  backup_caveat text not null check (char_length(btrim(backup_caveat)) between 1 and 1000)
);
create trigger account_erasure_receipt_reject_update_v3
before update or delete on account_erasure_receipt
for each row execute function guard_retention_immutable_row_v3();

create table retention_job_recovery_audit (
  id uuid primary key default gen_random_uuid(),
  recovery_kind text not null check (recovery_kind in (
    'privacy_export','account_erasure','staged_artifact_deletion','artifact_deletion'
  )),
  target_id uuid not null,
  attempt_count_before integer not null check (attempt_count_before = 20),
  approval_digest text not null check (approval_digest ~ '^[0-9a-f]{64}$'),
  reason_code text not null check (reason_code = 'operator_requeue'),
  requeued_at timestamptz not null check (isfinite(requeued_at)),
  created_at timestamptz not null default clock_timestamp(),
  unique (recovery_kind, target_id, approval_digest)
);
create trigger retention_job_recovery_audit_reject_update_v3
before update or delete on retention_job_recovery_audit
for each row execute function guard_retention_immutable_row_v3();

create table retention_dead_letter_event (
  id uuid primary key default gen_random_uuid(),
  recovery_kind text not null check (recovery_kind in (
    'privacy_export','account_erasure','staged_artifact_deletion','artifact_deletion'
  )),
  target_id uuid not null,
  attempt_count integer not null check (attempt_count = 20),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  status text not null default 'pending' check (status in ('pending','processing','completed')),
  locked_at timestamptz,
  locked_by text,
  acknowledged_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((locked_at is null) = (locked_by is null)),
  check ((status = 'completed') = (acknowledged_at is not null))
);
create unique index retention_dead_letter_event_open_v3
  on retention_dead_letter_event(recovery_kind,target_id) where status <> 'completed';
create trigger retention_dead_letter_event_reject_update_delete_v3
before delete on retention_dead_letter_event
for each row execute function guard_retention_immutable_row_v3();

comment on table custom_food is
  'Private custom-food root whose immutable facts remain in food_version/food_serving/food_nutrient_value.';
comment on table platform_health_import_revision is
  'Append-only normalized import ledger; raw health payloads are never persisted, only a digest and canonical facts.';
comment on table account_erasure_receipt is
  'Random non-identifying completion evidence linked only to the scrubbed random lifecycle job; it stores no subject identifier or external restore locator.';
comment on table retention_job_recovery_audit is
  'Immutable operator-approval evidence for explicitly requeueing a terminal retention job or cleanup target; target IDs are opaque and no subject identity is stored.';
