-- Production recipe and nutrition-goal persistence.
--
-- The original schema reserved recipe/goal tables before their immutable
-- calculation and idempotency contracts were finalized.  Those rows cannot be
-- upgraded without inventing yield provenance, missing nutrient aggregates,
-- energy snapshots, or request digests.  Fail before any DDL and require an
-- operator export/remediation if an experimental deployment populated them.

-- Migration serialization protects only other migrators.  Block legacy app
-- writers before the emptiness preflight so an old process cannot insert a
-- root with no v2 immutable version between the check and the ALTERs below.
lock table recipe, nutrition_goal in access exclusive mode;

do $$
begin
  if exists (select 1 from recipe) or exists (select 1 from nutrition_goal) then
    raise exception
      '0005 requires empty legacy recipe and nutrition_goal roots; export/remediate experimental rows before retrying'
      using errcode = '23514';
  end if;
end;
$$;

-- Recipe roots own their complete immutable version history.  The created-by
-- references are constrained to the owner below, making account privacy
-- cascades deterministic for recipe data that is not retained by a diary FK.
alter table recipe drop constraint recipe_owner_user_id_fkey;
alter table recipe
  add constraint recipe_owner_user_id_fkey
  foreign key (owner_user_id) references app_user(id) on delete cascade;

alter table recipe_version drop constraint recipe_version_created_by_user_id_fkey;
alter table recipe_version
  add constraint recipe_version_created_by_user_id_fkey
  foreign key (created_by_user_id) references app_user(id) on delete cascade;

alter table recipe_version
  alter column serving_count type numeric using serving_count::numeric,
  alter column total_yield_quantity type numeric using total_yield_quantity::numeric,
  alter column total_yield_quantity set not null,
  alter column total_yield_unit set not null,
  alter column total_weight_grams type numeric using total_weight_grams::numeric,
  alter column total_weight_grams set not null,
  add column recipe_status text not null,
  add column final_yield_source text not null,
  add column input_mass_grams numeric not null,
  add column serving_label text,
  add column ingredient_count integer not null,
  add column nutrient_component_count integer not null,
  add column source_component_count integer not null,
  add column retention_policy_code text not null,
  add column retention_policy_version text not null,
  add column calculation_assumptions jsonb not null default '{}'::jsonb,
  add column warnings jsonb not null default '[]'::jsonb,
  add constraint recipe_version_owner_creator_match check (owner_user_id = created_by_user_id),
  add constraint recipe_version_status_v2 check (recipe_status in ('active', 'archived')),
  add constraint recipe_version_name_v2 check (
    char_length(btrim(name)) between 1 and 200 and octet_length(name) <= 800
  ),
  add constraint recipe_version_description_v2 check (
    description is null or (char_length(description) <= 2000 and octet_length(description) <= 8000)
  ),
  add constraint recipe_version_instructions_v2 check (
    instructions is null or (char_length(instructions) <= 10000 and octet_length(instructions) <= 40000)
  ),
  alter column serving_count drop not null,
  add constraint recipe_version_serving_count_v2 check (
    (serving_count is null and serving_label is null)
    or (
      serving_count is not null and serving_label is not null
      and
      serving_count > 0 and serving_count < '1000000000000'::numeric
      and serving_count < 'Infinity'::numeric
      and char_length(btrim(serving_label)) between 1 and 100
      and octet_length(serving_label) <= 400
    )
  ),
  add constraint recipe_version_yield_v2 check (
    total_weight_grams > 0 and total_weight_grams < '1000000000000000000'::numeric
    and total_weight_grams < 'Infinity'::numeric
    and total_yield_quantity = total_weight_grams
    and total_yield_unit = 'g'
    and final_yield_source in ('estimated', 'measured')
    and input_mass_grams > 0 and input_mass_grams < '1000000000000000000'::numeric
    and input_mass_grams < 'Infinity'::numeric
  ),
  add constraint recipe_version_component_bounds check (
    ingredient_count between 1 and 50
    and nutrient_component_count between 1 and 256
    and source_component_count between 1 and 256
  ),
  add constraint recipe_version_calculation_identity check (
    char_length(btrim(calculation_version)) between 1 and 160
    and retention_policy_code = 'identity-retention-default'
    and retention_policy_version = '1'
    and jsonb_typeof(calculation_assumptions) = 'object'
    and calculation_assumptions @> jsonb_build_object(
      'retentionPolicy', jsonb_build_object(
        'assumption', 'No cooking-retention dataset was applied; omitted factors remain exactly one.',
        'code', 'identity-retention-default',
        'defaultFactor', '1',
        'version', '1'
      )
    )
    and jsonb_typeof(warnings) = 'array'
  );

alter table recipe_ingredient
  alter column quantity type numeric using quantity::numeric,
  alter column resolved_grams type numeric using resolved_grams::numeric,
  add column ingredient_kind text not null,
  add column food_name text,
  add column brand_name text,
  add column source_id bigint,
  add column source_code text,
  add column source_release_id uuid,
  add column source_display_name text,
  add column license_expression text,
  add column attribution_required boolean,
  add column attribution_text text,
  add column serving_label text,
  add column nested_recipe_id uuid,
  add column nested_recipe_name text,
  add column nested_recipe_version_number integer,
  add column nested_recipe_yield_grams numeric,
  add column nested_recipe_serving_count numeric,
  add column nested_recipe_serving_label text,
  add constraint recipe_ingredient_kind_v2 check (ingredient_kind in ('food', 'recipe')),
  add constraint recipe_ingredient_position_v2 check (position between 0 and 49),
  add constraint recipe_ingredient_quantity_v2 check (
    quantity > 0 and quantity < '1000000000000'::numeric and quantity < 'Infinity'::numeric
  ),
  add constraint recipe_ingredient_resolved_v2 check (
    resolved_grams is not null and resolved_grams > 0
    and resolved_grams < '1000000000000000000'::numeric
    and resolved_grams < 'Infinity'::numeric
  ),
  add constraint recipe_ingredient_factor_v2 check (
    yield_factor = 1 and retention_factor_set is null
  ),
  add constraint recipe_ingredient_note_v2 check (note is null or octet_length(note) <= 2000),
  add constraint recipe_ingredient_snapshot_v2 check (
    ((
      ingredient_kind = 'food'
      and food_version_id is not null and nested_recipe_version_id is null
      and nested_recipe_id is null and nested_recipe_name is null
      and nested_recipe_version_number is null
      and nested_recipe_yield_grams is null and nested_recipe_serving_count is null
      and nested_recipe_serving_label is null
      and char_length(btrim(food_name)) between 1 and 500
      and (brand_name is null or (char_length(btrim(brand_name)) between 1 and 300))
      and source_id is not null and source_release_id is not null
      and char_length(btrim(source_code)) between 1 and 32
      and char_length(btrim(source_display_name)) between 1 and 200
      and char_length(btrim(license_expression)) between 1 and 256
      and attribution_required is not null
      and char_length(btrim(attribution_text)) between 1 and 2000
      and input_unit in ('g', 'serving')
      and ((input_unit = 'g' and food_serving_id is null and quantity = resolved_grams)
        or (input_unit = 'serving' and food_serving_id is not null))
    )
    or
    (
      ingredient_kind = 'recipe'
      and food_version_id is null and food_serving_id is null
      and food_name is null and brand_name is null
      and source_id is null and source_code is null and source_release_id is null
      and source_display_name is null and license_expression is null
      and attribution_required is null and attribution_text is null and serving_label is null
      and nested_recipe_version_id is not null and nested_recipe_id is not null
      and nested_recipe_version_number > 0
      and char_length(btrim(nested_recipe_name)) between 1 and 200
      and nested_recipe_yield_grams > 0
      and nested_recipe_yield_grams < '1000000000000000000'::numeric
      and nested_recipe_yield_grams < 'Infinity'::numeric
      and (
        (nested_recipe_serving_count is null and nested_recipe_serving_label is null)
        or (
          nested_recipe_serving_count > 0
          and nested_recipe_serving_count < '1000000000000'::numeric
          and nested_recipe_serving_count < 'Infinity'::numeric
          and char_length(btrim(nested_recipe_serving_label)) between 1 and 100
        )
      )
      and input_unit = 'g' and quantity = resolved_grams
    )) is true
  ),
  add foreign key (source_id) references food_source(id) on delete restrict,
  add foreign key (source_release_id) references food_source_release(id) on delete restrict,
  add foreign key (source_id, source_release_id)
    references food_source_release(food_source_id, id) on delete restrict,
  add foreign key (nested_recipe_id, nested_recipe_version_id)
    references recipe_version(recipe_id, id) deferrable initially deferred;

-- A full account privacy cascade may remove several mutually nested immutable
-- recipe histories in one transaction. Defer the legacy single-column edge so
-- surviving external references still fail at commit without blocking a full
-- same-owner cascade halfway through.
alter table recipe_ingredient
  drop constraint recipe_ingredient_nested_recipe_version_id_fkey,
  add constraint recipe_ingredient_nested_recipe_version_id_fkey
    foreign key (nested_recipe_version_id) references recipe_version(id)
    deferrable initially deferred;

create table recipe_version_nutrient (
  recipe_version_id uuid not null references recipe_version(id) on delete cascade,
  nutrient_id bigint not null references nutrient(id) on delete restrict,
  nutrient_code text not null,
  nutrient_name text not null,
  unit text not null,
  known_amount numeric not null,
  completeness text not null check (completeness in ('complete', 'partial', 'unknown')),
  is_exact boolean not null,
  contributor_count integer not null,
  quantified_count integer not null,
  trace_count integer not null,
  unknown_count integer not null,
  unknown_reasons jsonb not null,
  calculation_version text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (recipe_version_id, nutrient_id),
  unique (recipe_version_id, nutrient_code),
  check (char_length(nutrient_code) between 1 and 64),
  check (char_length(btrim(nutrient_name)) between 1 and 200),
  check (char_length(unit) between 1 and 32),
  check (known_amount >= 0 and known_amount < 'Infinity'::numeric),
  check (char_length(known_amount::text) <= 160),
  check (contributor_count between 1 and 2147483647),
  check (
    quantified_count between 0 and 2147483647
    and trace_count between 0 and 2147483647
    and unknown_count between 0 and 2147483647
  ),
  check (quantified_count + trace_count + unknown_count = contributor_count),
  check (
    (unknown_count = 0 and completeness = 'complete')
    or (unknown_count = contributor_count and completeness = 'unknown')
    or (unknown_count > 0 and unknown_count < contributor_count and completeness = 'partial')
  ),
  check (is_exact = (unknown_count = 0 and trace_count = 0)),
  check (jsonb_typeof(unknown_reasons) = 'object'),
  check (diary_unknown_reasons_match(unknown_reasons, unknown_count)),
  check (char_length(btrim(calculation_version)) between 1 and 160)
);

create table recipe_version_source (
  recipe_version_id uuid not null references recipe_version(id) on delete cascade,
  food_source_id bigint not null references food_source(id) on delete restrict,
  source_release_id uuid not null references food_source_release(id) on delete restrict,
  source_code text not null,
  source_display_name text not null,
  license_expression text not null,
  attribution_required boolean not null,
  attribution_text text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (recipe_version_id, food_source_id, source_release_id),
  foreign key (food_source_id, source_release_id)
    references food_source_release(food_source_id, id) on delete restrict,
  check (char_length(source_code) between 1 and 32),
  check (char_length(btrim(source_display_name)) between 1 and 200),
  check (char_length(btrim(license_expression)) between 1 and 256),
  check (char_length(btrim(attribution_text)) between 1 and 2000)
);

create table recipe_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'revise')),
  recipe_id uuid not null references recipe(id) on delete cascade,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id),
  foreign key (recipe_id, user_id) references recipe(id, owner_user_id) on delete cascade
);

create trigger recipe_operation_reject_update_v2
before update on recipe_operation
for each row execute function reject_immutable_row_update();

create function guard_recipe_operation_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and exists (
    select 1 from recipe where id = old.recipe_id and owner_user_id = old.user_id
  ) then
    raise exception 'recipe idempotency record cannot be deleted while its root exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger recipe_operation_guard_delete_v2
before delete on recipe_operation
for each row execute function guard_recipe_operation_delete_v2();

create function guard_recipe_head_advance_v2()
returns trigger
language plpgsql
as $$
declare
  old_number integer;
  next_number integer;
  next_status text;
begin
  if new.id <> old.id or new.owner_user_id <> old.owner_user_id
    or new.created_at <> old.created_at then
    raise exception 'recipe identity and ownership are immutable' using errcode = '55000';
  end if;
  if new.current_version_id is null or new.current_version_id is not distinct from old.current_version_id then
    raise exception 'recipe head must advance to a new immutable version' using errcode = '55000';
  end if;
  select version_number, recipe_status into strict next_number, next_status
  from recipe_version where id = new.current_version_id and recipe_id = new.id;
  if old.current_version_id is null then
    old_number := 0;
  else
    select version_number into strict old_number
    from recipe_version where id = old.current_version_id and recipe_id = old.id;
  end if;
  if next_number <> old_number + 1 or new.status <> next_status then
    raise exception 'recipe head must advance exactly one matching version' using errcode = '23514';
  end if;
  if (new.status = 'archived') <> (new.archived_at is not null) then
    raise exception 'recipe archive state is inconsistent' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger recipe_guard_head_advance_v2
before update on recipe
for each row execute function guard_recipe_head_advance_v2();

create function require_recipe_current_version_v2()
returns trigger
language plpgsql
as $$
declare
  current_row record;
begin
  select version.version_number, version.recipe_status,
    root.status as root_status,
    version.recipe_id = root.id as recipe_matches,
    version.owner_user_id = root.owner_user_id as owner_matches
  into current_row
  from recipe root
  join recipe_version version on version.id = root.current_version_id
  where root.id = new.id;
  if not found or not current_row.recipe_matches or not current_row.owner_matches
    or current_row.recipe_status <> current_row.root_status then
    raise exception 'recipe current version must match its root projection'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and current_row.version_number <> 1 then
    raise exception 'initial recipe current version must be version 1'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger recipe_require_current_version_v2
after insert or update on recipe
deferrable initially deferred
for each row execute function require_recipe_current_version_v2();

create function guard_recipe_version_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and exists (
    select 1 from recipe where id = old.recipe_id
  ) then
    raise exception 'immutable recipe versions cannot be deleted while their root exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger recipe_version_guard_delete_v2
before delete on recipe_version
for each row execute function guard_recipe_version_delete_v2();

create function guard_recipe_component_insert_v2()
returns trigger
language plpgsql
as $$
declare
  declared_count integer;
  actual_count integer;
  definition record;
  parent_calculation_version text;
begin
  if tg_table_name = 'recipe_ingredient' then
    if new.ingredient_kind = 'food' then
      perform 1
      from food_source source
      join food_source_release release
        on release.food_source_id = source.id and release.id = new.source_release_id
      join food on food.food_source_id = source.id
      join food_version version
        on version.food_id = food.id and version.source_release_id = release.id
      where version.id = new.food_version_id
        and source.id = new.source_id
        and source.active
        and source.commercial_use_allowed
        and source.redistribution_allowed
        and source.rights_review_status in ('approved', 'restricted')
        and source.rights_reviewed_at is not null
        and char_length(btrim(source.rights_reviewed_by)) > 0
        and release.status = 'promoted'
        and release.promoted_at is not null
        and release.rights_manifest_sha256 is not null
        and version.name = new.food_name
        and version.brand_name is not distinct from new.brand_name
        and source.code = new.source_code
        and source.display_name = new.source_display_name
        and source.license_expression = new.license_expression
        and source.attribution_required = new.attribution_required
        and source.attribution_text = new.attribution_text
        and exists (
          select 1 from promoted_food_search_catalogue_v1 eligible
          where eligible.food_version_id = version.id
        )
        and (
          (
            new.input_unit = 'g' and new.food_serving_id is null
            and new.serving_label is null and new.quantity = new.resolved_grams
          )
          or (
            new.input_unit = 'serving'
            and exists (
              select 1 from food_serving serving
              where serving.id = new.food_serving_id
                and serving.food_version_id = version.id
                and serving.label = new.serving_label
                and serving.gram_weight is not null
                and serving.gram_weight > 0
                and serving.gram_weight < 'Infinity'::numeric
                and new.resolved_grams = new.quantity * serving.gram_weight
            )
          )
        )
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
      from recipe_version parent
      join recipe_version nested on nested.id = new.nested_recipe_version_id
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
    perform 1
    from food_source source
    join food_source_release release
      on release.food_source_id = source.id and release.id = new.source_release_id
    where source.id = new.food_source_id
      and source.active
      and source.commercial_use_allowed
      and source.redistribution_allowed
      and source.rights_review_status in ('approved', 'restricted')
      and source.rights_reviewed_at is not null
      and char_length(btrim(source.rights_reviewed_by)) > 0
      and release.status = 'promoted'
      and release.promoted_at is not null
      and release.rights_manifest_sha256 is not null
      and source.code = new.source_code
      and source.display_name = new.source_display_name
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

create trigger recipe_ingredient_guard_insert_v2
before insert on recipe_ingredient
for each row execute function guard_recipe_component_insert_v2();
create trigger recipe_nutrient_guard_insert_v2
before insert on recipe_version_nutrient
for each row execute function guard_recipe_component_insert_v2();
create trigger recipe_source_guard_insert_v2
before insert on recipe_version_source
for each row execute function guard_recipe_component_insert_v2();

create function reconcile_recipe_components_v2()
returns trigger
language plpgsql
as $$
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
    where definition.active
      and not exists (
        select 1 from recipe_version_nutrient actual
        where actual.recipe_version_id = version_id
          and actual.nutrient_id = definition.id
      )
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
          when ingredient.ingredient_kind = 'food'
            and food_value.nutrient_id is not null and food_value.value_status <> 'trace' then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.quantified_count, 0)
          else 0
        end)::integer as quantified_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and food_value.value_status = 'trace' then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.trace_count, 0)
          else 0
        end)::integer as trace_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and food_value.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'recipe' then coalesce(nested.unknown_count, 1)
          else 0
        end)::integer as unknown_count,
        sum(case
          when ingredient.ingredient_kind = 'food' and food_value.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'recipe' and nested.nutrient_id is null then 1
          when ingredient.ingredient_kind = 'recipe'
            then coalesce((nested.unknown_reasons->>'not_reported')::integer, 0)
          else 0
        end)::integer as not_reported_count,
        sum(case when ingredient.ingredient_kind = 'recipe'
          then coalesce((nested.unknown_reasons->>'not_analyzed')::integer, 0) else 0 end
        )::integer as not_analyzed_count,
        sum(case when ingredient.ingredient_kind = 'recipe'
          then coalesce((nested.unknown_reasons->>'not_applicable')::integer, 0) else 0 end
        )::integer as not_applicable_count,
        sum(case when ingredient.ingredient_kind = 'recipe'
          then coalesce((nested.unknown_reasons->>'withheld')::integer, 0) else 0 end
        )::integer as withheld_count
      from recipe_ingredient ingredient
      cross join nutrient definition
      left join food_nutrient_value food_value
        on ingredient.ingredient_kind = 'food'
        and food_value.food_version_id = ingredient.food_version_id
        and food_value.nutrient_id = definition.id
      left join recipe_version_nutrient nested
        on ingredient.ingredient_kind = 'recipe'
        and nested.recipe_version_id = ingredient.nested_recipe_version_id
        and nested.nutrient_id = definition.id
      where ingredient.recipe_version_id = version_id and definition.active
      group by definition.id
    )
    select 1
    from expected
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
        and ingredient.ingredient_kind = 'food'
      union
      select nested.food_source_id, nested.source_release_id
      from recipe_ingredient ingredient
      join recipe_version_source nested
        on nested.recipe_version_id = ingredient.nested_recipe_version_id
      where ingredient.recipe_version_id = version_id
        and ingredient.ingredient_kind = 'recipe'
    )
    select 1 from expected_sources expected
    where not exists (
      select 1 from recipe_version_source actual
      where actual.recipe_version_id = version_id
        and actual.food_source_id = expected.food_source_id
        and actual.source_release_id = expected.source_release_id
    )
    union all
    select 1 from recipe_version_source actual
    where actual.recipe_version_id = version_id
      and not exists (
        select 1 from expected_sources expected
        where expected.food_source_id = actual.food_source_id
          and expected.source_release_id = actual.source_release_id
      )
  ) then
    raise exception 'recipe attribution set does not match direct and nested ingredients'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger recipe_ingredient_reconcile_v2
after insert or delete on recipe_ingredient deferrable initially deferred
for each row execute function reconcile_recipe_components_v2();
create constraint trigger recipe_nutrient_reconcile_v2
after insert or delete on recipe_version_nutrient deferrable initially deferred
for each row execute function reconcile_recipe_components_v2();
create constraint trigger recipe_source_reconcile_v2
after insert or delete on recipe_version_source deferrable initially deferred
for each row execute function reconcile_recipe_components_v2();
create constraint trigger recipe_version_components_reconcile_v2
after insert on recipe_version deferrable initially deferred
for each row execute function reconcile_recipe_components_v2();

create function guard_recipe_component_delete_v2()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  if exists (select 1 from recipe_version where id = old.recipe_version_id) then
    raise exception 'immutable recipe component cannot be deleted while its version exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger recipe_ingredient_guard_delete_v2
before delete on recipe_ingredient
for each row execute function guard_recipe_component_delete_v2();
create trigger recipe_nutrient_reject_update_v2
before update on recipe_version_nutrient
for each row execute function reject_immutable_row_update();
create trigger recipe_nutrient_guard_delete_v2
before delete on recipe_version_nutrient
for each row execute function guard_recipe_component_delete_v2();
create trigger recipe_source_reject_update_v2
before update on recipe_version_source
for each row execute function reject_immutable_row_update();
create trigger recipe_source_guard_delete_v2
before delete on recipe_version_source
for each row execute function guard_recipe_component_delete_v2();

-- Replace the original unbounded cycle check with a same-owner, cycle-safe,
-- maximum-depth-10 guard.  Immutable nested versions make this result stable.
create or replace function reject_recipe_cycle()
returns trigger
language plpgsql
as $$
declare
  owner_recipe_id uuid;
  root_owner_user_id uuid;
  maximum_depth integer;
  closure_count integer;
  reaches_root boolean;
begin
  if new.nested_recipe_version_id is null then return new; end if;
  select recipe_id, owner_user_id into strict owner_recipe_id, root_owner_user_id
  from recipe_version where id = new.recipe_version_id;
  if not exists (
    select 1 from recipe_version
    where id = new.nested_recipe_version_id and owner_user_id = root_owner_user_id
  ) then
    raise exception 'nested recipe must have the same owner' using errcode = '23514';
  end if;
  -- UNION deduplicates each (version, depth) state.  The depth-11 sentinel
  -- bounds work to at most 10 states per reachable version even for dense
  -- shared-subgraph DAGs; it never enumerates exponentially many paths.
  with recursive direct_nested(id) as (
    select new.nested_recipe_version_id
    union
    select ingredient.nested_recipe_version_id
    from recipe_ingredient ingredient
    where ingredient.recipe_version_id = new.recipe_version_id
      and ingredient.nested_recipe_version_id is not null
  ), nested_versions(id, recipe_id, depth) as (
    select v.id, v.recipe_id, 2
    from recipe_version v join direct_nested direct on direct.id = v.id
    union
    select child.id, child.recipe_id, parent.depth + 1
    from nested_versions parent
    join recipe_ingredient ingredient on ingredient.recipe_version_id = parent.id
    join recipe_version child on child.id = ingredient.nested_recipe_version_id
    where parent.depth <= 10
  )
  select
    coalesce(bool_or(recipe_id = owner_recipe_id), false),
    coalesce(max(depth), 2),
    count(distinct id)
  into reaches_root, maximum_depth, closure_count
  from nested_versions;
  if reaches_root then
    raise exception 'nested recipe would create a cycle' using errcode = '23514';
  end if;
  if maximum_depth > 10 then
    raise exception 'nested recipe depth exceeds 10' using errcode = '23514';
  end if;
  if closure_count > 500 then
    raise exception 'nested recipe closure exceeds 500 versions' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Goal versions snapshot their effective period, profile-derived energy inputs,
-- and complete explicit target vector.  The root is only a current projection.
alter table nutrition_goal drop constraint nutrition_goal_user_id_fkey;
alter table nutrition_goal
  add constraint nutrition_goal_user_id_fkey
  foreign key (user_id) references app_user(id) on delete cascade;

alter table nutrition_goal_version drop constraint nutrition_goal_version_created_by_user_id_fkey;
alter table nutrition_goal_version drop constraint nutrition_goal_version_energy_mode_check;
alter table nutrition_goal_version
  alter column energy_target_kcal type numeric using energy_target_kcal::numeric,
  alter column bmr_kcal type numeric using bmr_kcal::numeric,
  alter column activity_factor type numeric using activity_factor::numeric,
  alter column exercise_budget_kcal type numeric using exercise_budget_kcal::numeric,
  alter column thermic_effect_kcal type numeric using thermic_effect_kcal::numeric,
  alter column energy_adjustment_kcal type numeric using energy_adjustment_kcal::numeric,
  add column user_id uuid not null,
  add column goal_status text not null,
  add column effective_from date not null,
  add column effective_to date,
  add column target_count integer not null,
  add column profile_revision bigint,
  add column age_years integer,
  add column profile_height_cm numeric,
  add column profile_weight_kg numeric,
  add column profile_sex_at_birth text,
  add column activity_level_code text,
  add column energy_source_code text not null,
  add column energy_source_version text not null,
  add column energy_source_url text,
  add column activity_policy_code text,
  add column activity_policy_version text,
  add column activity_policy_url text,
  add column calculation_version text not null,
  add constraint nutrition_goal_version_user_fk
    foreign key (nutrition_goal_id, user_id)
    references nutrition_goal(id, user_id) on delete cascade,
  add constraint nutrition_goal_version_creator_fk
    foreign key (created_by_user_id) references app_user(id) on delete cascade,
  add constraint nutrition_goal_version_owner_creator check (user_id = created_by_user_id),
  add constraint nutrition_goal_version_mode_v2 check (energy_mode in ('derived', 'fixed')),
  add constraint nutrition_goal_version_status_v2 check (goal_status in ('active', 'archived', 'draft')),
  add constraint nutrition_goal_version_period_v2 check (
    effective_to is null or effective_to > effective_from
  ),
  add constraint nutrition_goal_version_target_count_v2 check (target_count between 0 and 256),
  add constraint nutrition_goal_version_rationale_v2 check (
    rationale is not null and char_length(btrim(rationale)) between 1 and 1000
    and octet_length(rationale) <= 4000
  ),
  add constraint nutrition_goal_version_energy_v2 check (
    energy_target_kcal is not null and energy_target_kcal > 0
    and energy_target_kcal < '1000000000000'::numeric
    and energy_target_kcal < 'Infinity'::numeric
    and char_length(btrim(energy_source_code)) between 1 and 100
    and char_length(btrim(energy_source_version)) between 1 and 100
    and char_length(btrim(calculation_version)) between 1 and 160
  ),
  add constraint nutrition_goal_version_fixed_v2 check (
    (energy_mode <> 'fixed' or (
      energy_source_code = 'user-fixed' and energy_source_version = '1'
      and bmr_kcal is null and bmr_equation_code is null and bmr_equation_version is null
      and activity_factor is null and profile_revision is null and age_years is null
      and profile_height_cm is null and profile_weight_kg is null
      and profile_sex_at_birth is null and activity_level_code is null
      and activity_policy_code is null and activity_policy_version is null
      and activity_policy_url is null
      and energy_adjustment_kcal is null and energy_source_url is null
    )) is true
  ),
  add constraint nutrition_goal_version_derived_v2 check (
    (energy_mode <> 'derived' or (
      bmr_kcal > 0 and bmr_kcal < '1000000000000'::numeric and bmr_kcal < 'Infinity'::numeric
      and bmr_equation_code = 'mifflin-st-jeor-ree'
      and bmr_equation_version = '1990-original'
      and energy_source_code = 'mifflin-st-jeor-ree'
      and energy_source_version = '1990-original'
      and profile_revision >= 0 and age_years between 19 and 78
      and profile_height_cm > 0 and profile_height_cm < 'Infinity'::numeric
      and profile_weight_kg > 0 and profile_weight_kg < 'Infinity'::numeric
      and profile_sex_at_birth in ('female', 'male')
      and activity_level_code in ('sedentary_or_light', 'active_or_moderate', 'vigorous')
      and activity_factor > 0 and activity_factor < 'Infinity'::numeric
      and (
        (activity_level_code = 'sedentary_or_light' and activity_factor between 1.40 and 1.69)
        or (activity_level_code = 'active_or_moderate' and activity_factor between 1.70 and 1.99)
        or (activity_level_code = 'vigorous' and activity_factor between 2.00 and 2.40)
      )
      and energy_adjustment_kcal is not null
      and energy_adjustment_kcal > '-1000000000000'::numeric
      and energy_adjustment_kcal < '1000000000000'::numeric
      and bmr_kcal = (
        10 * profile_weight_kg + 6.25 * profile_height_cm - 5 * age_years
        + case profile_sex_at_birth when 'male' then 5 else -161 end
      )
      and energy_target_kcal = bmr_kcal * activity_factor + energy_adjustment_kcal
      and activity_policy_code = 'fao-who-unu-pal-policy'
      and activity_policy_version = '2004-reviewed-v1'
      and activity_policy_url = 'https://www.fao.org/4/y5686e/y5686e07.htm'
      and energy_source_url = 'https://doi.org/10.1093/ajcn/51.2.241'
    )) is true
  ),
  add constraint nutrition_goal_version_reserved_fields_v2 check (
    dri_reference_group_code is null and dri_reference_version is null
    and exercise_budget_kcal is null and thermic_effect_kcal is null
  );

alter table nutrition_goal
  add constraint nutrition_goal_period_finite_v2 check (
    effective_from not in ('infinity'::date, '-infinity'::date)
    and extract(year from effective_from) between 1 and 9999
    and (
      effective_to is null
      or (
        effective_to not in ('infinity'::date, '-infinity'::date)
        and extract(year from effective_to) between 1 and 9999
      )
    )
  );

alter table nutrition_goal_version
  add constraint nutrition_goal_version_period_finite_v2 check (
    effective_from not in ('infinity'::date, '-infinity'::date)
    and extract(year from effective_from) between 1 and 9999
    and (
      effective_to is null
      or (
        effective_to not in ('infinity'::date, '-infinity'::date)
        and extract(year from effective_to) between 1 and 9999
      )
    )
  );

alter table nutrition_goal_target
  alter column minimum_amount type numeric using minimum_amount::numeric,
  alter column target_amount type numeric using target_amount::numeric,
  alter column maximum_amount type numeric using maximum_amount::numeric,
  add column rationale text,
  add constraint nutrition_goal_target_amount_bounds_v2 check (
    (minimum_amount is null or (minimum_amount >= 0 and minimum_amount < '1000000000000000000'::numeric and minimum_amount < 'Infinity'::numeric and scale(minimum_amount) <= 12 and char_length(minimum_amount::text) <= 31))
    and (target_amount is null or (target_amount >= 0 and target_amount < '1000000000000000000'::numeric and target_amount < 'Infinity'::numeric and scale(target_amount) <= 12 and char_length(target_amount::text) <= 31))
    and (maximum_amount is null or (maximum_amount >= 0 and maximum_amount < '1000000000000000000'::numeric and maximum_amount < 'Infinity'::numeric and scale(maximum_amount) <= 12 and char_length(maximum_amount::text) <= 31))
  ),
  add constraint nutrition_goal_target_order_v2 check (
    (minimum_amount is null or maximum_amount is null or minimum_amount <= maximum_amount)
      is true
  ),
  add constraint nutrition_goal_target_source_v2 check (
    char_length(btrim(target_source)) between 1 and 160
    and octet_length(target_source) <= 640
    and (target_source_version is null or (char_length(btrim(target_source_version)) between 1 and 100 and octet_length(target_source_version) <= 400))
    and (rationale is null or (char_length(rationale) <= 1000 and octet_length(rationale) <= 4000))
  ),
  add constraint nutrition_goal_target_unit_v2 check (char_length(unit) between 1 and 32);

create table nutrition_goal_operation (
  user_id uuid not null references app_user(id) on delete cascade,
  client_operation_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('create', 'revise')),
  nutrition_goal_id uuid not null references nutrition_goal(id) on delete cascade,
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_operation_id),
  foreign key (nutrition_goal_id, user_id)
    references nutrition_goal(id, user_id) on delete cascade
);

create trigger nutrition_goal_operation_reject_update_v2
before update on nutrition_goal_operation
for each row execute function reject_immutable_row_update();

create function guard_nutrition_goal_operation_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and exists (
    select 1 from nutrition_goal
    where id = old.nutrition_goal_id and user_id = old.user_id
  ) then
    raise exception 'nutrition goal idempotency record cannot be deleted while its root exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger nutrition_goal_operation_guard_delete_v2
before delete on nutrition_goal_operation
for each row execute function guard_nutrition_goal_operation_delete_v2();

create function guard_goal_head_advance_v2()
returns trigger
language plpgsql
as $$
declare
  old_number integer;
  next_row record;
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at then
    raise exception 'nutrition goal identity and ownership are immutable' using errcode = '55000';
  end if;
  if old.current_version_id is not null and old.effective_to is not null then
    raise exception 'closed nutrition goal history cannot be revised' using errcode = '55000';
  end if;
  if new.effective_from <> old.effective_from then
    raise exception 'nutrition goal effective start is immutable across revisions'
      using errcode = '55000';
  end if;
  if new.current_version_id is null or new.current_version_id is not distinct from old.current_version_id then
    raise exception 'nutrition goal head must advance to a new immutable version' using errcode = '55000';
  end if;
  select version_number, goal_status, effective_from, effective_to into strict next_row
  from nutrition_goal_version
  where id = new.current_version_id and nutrition_goal_id = new.id and user_id = new.user_id;
  if old.current_version_id is null then old_number := 0;
  else
    select version_number into strict old_number from nutrition_goal_version
    where id = old.current_version_id and nutrition_goal_id = old.id;
  end if;
  if next_row.version_number <> old_number + 1
    or row(new.status, new.effective_from, new.effective_to)
      is distinct from row(next_row.goal_status, next_row.effective_from, next_row.effective_to) then
    raise exception 'nutrition goal head must advance exactly one matching version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger nutrition_goal_guard_head_advance_v2
before update on nutrition_goal
for each row execute function guard_goal_head_advance_v2();

create function require_goal_current_version_v2()
returns trigger language plpgsql as $$
declare
  current_row record;
begin
  select version.version_number,
    row(version.goal_status, version.effective_from, version.effective_to)
      is not distinct from row(root.status, root.effective_from, root.effective_to)
      as projection_matches,
    version.nutrition_goal_id = root.id as goal_matches,
    version.user_id = root.user_id as owner_matches
  into current_row
  from nutrition_goal root
  join nutrition_goal_version version on version.id = root.current_version_id
  where root.id = new.id;
  if not found or not current_row.projection_matches
    or not current_row.goal_matches or not current_row.owner_matches then
    raise exception 'nutrition goal current version must match its root projection'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and current_row.version_number <> 1 then
    raise exception 'initial nutrition goal current version must be version 1'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger nutrition_goal_require_current_version_v2
after insert or update on nutrition_goal deferrable initially deferred
for each row execute function require_goal_current_version_v2();

create function guard_goal_version_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and exists (
    select 1 from nutrition_goal where id = old.nutrition_goal_id
  ) then
    raise exception 'immutable nutrition goal versions cannot be deleted while their root exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger nutrition_goal_version_guard_delete_v2
before delete on nutrition_goal_version
for each row execute function guard_goal_version_delete_v2();

create function guard_goal_target_insert_v2()
returns trigger language plpgsql as $$
declare
  declared_count integer;
  actual_count integer;
  definition record;
begin
  select target_count into strict declared_count
  from nutrition_goal_version where id = new.nutrition_goal_version_id for update;
  select id, canonical_unit, active, is_targetable, dimension into strict definition
  from nutrient where id = new.nutrient_id for key share;
  if not definition.active or not definition.is_targetable or definition.dimension = 'energy'
    or definition.canonical_unit <> new.unit then
    raise exception 'goal target does not match an active targetable nutrient'
      using errcode = '23514';
  end if;
  select count(*) into actual_count from nutrition_goal_target
  where nutrition_goal_version_id = new.nutrition_goal_version_id;
  if actual_count >= declared_count then
    raise exception 'goal target count would exceed declaration' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger nutrition_goal_target_guard_insert_v2
before insert on nutrition_goal_target
for each row execute function guard_goal_target_insert_v2();

create function reconcile_goal_targets_v2()
returns trigger language plpgsql as $$
declare
  version_id uuid;
  declared_count integer;
  actual_count integer;
begin
  if tg_table_name = 'nutrition_goal_version' then
    version_id := new.id;
  else
    version_id := coalesce(new.nutrition_goal_version_id, old.nutrition_goal_version_id);
  end if;
  select target_count into declared_count from nutrition_goal_version where id = version_id;
  if not found then return null; end if;
  select count(*) into actual_count from nutrition_goal_target
  where nutrition_goal_version_id = version_id;
  if actual_count <> declared_count then
    raise exception 'goal target count does not reconcile' using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger nutrition_goal_target_reconcile_v2
after insert or delete on nutrition_goal_target deferrable initially deferred
for each row execute function reconcile_goal_targets_v2();
create constraint trigger nutrition_goal_version_target_reconcile_v2
after insert on nutrition_goal_version deferrable initially deferred
for each row execute function reconcile_goal_targets_v2();

create function guard_goal_target_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  if exists (
    select 1 from nutrition_goal_version where id = old.nutrition_goal_version_id
  ) then
    raise exception 'immutable goal target cannot be deleted while its version exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger nutrition_goal_target_guard_delete_v2
before delete on nutrition_goal_target
for each row execute function guard_goal_target_delete_v2();

-- Recipe diary revisions snapshot the exact recipe semantics and an immutable,
-- deduplicated attribution set.  Food revisions keep their existing singular
-- source snapshot and therefore declare zero child sources here.
alter table diary_entry
  add constraint diary_entry_recipe_head_v2 check (
    (entry_kind <> 'recipe' or (
      recipe_version_id is not null and food_version_id is null and food_serving_id is null
      and quantity is not null and input_unit in ('g', 'serving')
      and resolved_grams is not null and resolved_grams > 0
      and resolved_grams < 'Infinity'::numeric
      and snapshot_engine_version is not null
      and (input_unit <> 'g' or quantity = resolved_grams)
    )) is true
  );

create function validate_diary_recipe_head_v2()
returns trigger language plpgsql as $$
begin
  if new.entry_kind = 'recipe' and new.input_unit = 'serving' and not exists (
    select 1 from recipe_version version
    where version.id = new.recipe_version_id
      and version.owner_user_id = new.user_id
      and version.serving_count is not null
      and version.serving_label is not null
  ) then
    raise exception 'recipe serving diary head requires a pinned serving definition'
      using errcode = '23514';
  end if;
  if new.entry_kind = 'recipe' and not exists (
    select 1 from recipe_version version
    where version.id = new.recipe_version_id
      and version.owner_user_id = new.user_id
      and version.calculation_version = new.snapshot_engine_version
  ) then
    raise exception 'recipe diary head engine does not match its pinned version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger diary_entry_validate_recipe_head_v2
before insert or update of entry_kind, recipe_version_id, input_unit, quantity, resolved_grams
on diary_entry
for each row execute function validate_diary_recipe_head_v2();

create function reconcile_diary_recipe_head_v2()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from diary_entry_revision revision
    join diary day on day.id = new.diary_id and day.user_id = new.user_id
    where revision.id = new.current_revision_id
      and revision.diary_entry_id = new.id
      and revision.diary_id = new.diary_id
      and revision.user_id = new.user_id
      and revision.revision_number = new.current_revision_number
      and revision.entry_kind = new.entry_kind
      and revision.recipe_version_id is not distinct from new.recipe_version_id
      and revision.food_version_id is not distinct from new.food_version_id
      and revision.local_date = day.local_date
      and (
        new.entry_kind <> 'recipe'
        or revision.snapshot_engine_version is not distinct from new.snapshot_engine_version
      )
  ) then
    raise exception 'diary head does not match its immutable current revision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger diary_entry_reconcile_recipe_head_v2
after insert or update on diary_entry
deferrable initially deferred
for each row execute function reconcile_diary_recipe_head_v2();

alter table diary_entry_revision
  add column recipe_id uuid,
  add column recipe_name text,
  add column recipe_version_number integer,
  add column recipe_yield_grams numeric,
  add column recipe_yield_source text,
  add column recipe_serving_count numeric,
  add column recipe_serving_label text,
  add column recipe_calculation_version text,
  add column recipe_retention_policy_code text,
  add column recipe_retention_policy_version text,
  add column recipe_calculation_assumptions jsonb,
  add column recipe_warnings jsonb,
  add column source_component_count integer not null default 0,
  add constraint diary_recipe_portion_v2 check (
    (entry_kind <> 'recipe' or (
      quantity is not null and input_unit in ('g', 'serving')
      and resolved_quantity is not null and resolved_quantity > 0
      and resolved_quantity < 'Infinity'::numeric and resolved_unit = 'g'
      and nutrient_component_count between 1 and 256
      and (
        (input_unit = 'g' and quantity = resolved_quantity)
        or (
          input_unit = 'serving'
          and recipe_serving_count is not null and recipe_serving_label is not null
        )
      )
    )) is true
  ),
  add constraint diary_recipe_snapshot_v2 check (
    ((
      entry_kind = 'food'
      and recipe_id is null and recipe_name is null and recipe_yield_grams is null
      and recipe_version_number is null
      and recipe_yield_source is null and recipe_serving_count is null
      and recipe_serving_label is null and recipe_calculation_version is null
      and recipe_retention_policy_code is null and recipe_retention_policy_version is null
      and recipe_calculation_assumptions is null and recipe_warnings is null
      and source_component_count = 0
    )
    or
    (
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
          'code', 'identity-retention-default',
          'defaultFactor', '1',
          'version', '1'
        )
      )
      and jsonb_typeof(recipe_warnings) = 'array'
      and source_component_count between 1 and 256
      and source_code is null and source_release_id is null and source_display_name is null
      and license_expression is null and attribution_required is null and attribution_text is null
    )
    or
    (
      entry_kind in ('note', 'quick_add') and operation = 'delete'
      and recipe_id is null and recipe_name is null and recipe_version_number is null
      and recipe_yield_grams is null and recipe_yield_source is null
      and recipe_serving_count is null and recipe_serving_label is null
      and recipe_calculation_version is null and recipe_retention_policy_code is null
      and recipe_retention_policy_version is null and recipe_calculation_assumptions is null
      and recipe_warnings is null and source_component_count = 0
    )) is true
  ),
  add foreign key (recipe_id, recipe_version_id)
    references recipe_version(recipe_id, id) deferrable initially deferred;

create table diary_entry_revision_source (
  diary_entry_revision_id uuid not null references diary_entry_revision(id) on delete cascade,
  food_source_id bigint not null references food_source(id) on delete restrict,
  source_release_id uuid not null references food_source_release(id) on delete restrict,
  source_code text not null,
  source_display_name text not null,
  license_expression text not null,
  attribution_required boolean not null,
  attribution_text text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (diary_entry_revision_id, food_source_id, source_release_id),
  foreign key (food_source_id, source_release_id)
    references food_source_release(food_source_id, id) on delete restrict,
  check (char_length(source_code) between 1 and 32),
  check (char_length(btrim(source_display_name)) between 1 and 200),
  check (char_length(btrim(license_expression)) between 1 and 256),
  check (char_length(btrim(attribution_text)) between 1 and 2000)
);

create function guard_diary_revision_source_insert_v2()
returns trigger language plpgsql as $$
declare
  declared_count integer;
  entry_kind_value text;
  operation_value text;
  actual_count integer;
begin
  select source_component_count, entry_kind, operation
    into strict declared_count, entry_kind_value, operation_value
  from diary_entry_revision where id = new.diary_entry_revision_id for update;
  if entry_kind_value <> 'recipe' then
    raise exception 'only recipe diary revisions have source-set rows' using errcode = '23514';
  end if;
  if operation_value = 'create' then
    perform 1
    from food_source source
    join food_source_release release
      on release.food_source_id = source.id and release.id = new.source_release_id
    where source.id = new.food_source_id
      and source.active
      and source.commercial_use_allowed
      and source.redistribution_allowed
      and source.rights_review_status in ('approved', 'restricted')
      and source.rights_reviewed_at is not null
      and char_length(btrim(source.rights_reviewed_by)) > 0
      and release.status = 'promoted'
      and release.promoted_at is not null
      and release.rights_manifest_sha256 is not null
    for share of source, release;
    if not found then
      raise exception 'diary recipe source is no longer eligible'
        using errcode = '23514';
    end if;
  end if;
  select count(*) into actual_count from diary_entry_revision_source
  where diary_entry_revision_id = new.diary_entry_revision_id;
  if actual_count >= declared_count then
    raise exception 'diary recipe source count would exceed declaration' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger diary_revision_source_guard_insert_v2
before insert on diary_entry_revision_source
for each row execute function guard_diary_revision_source_insert_v2();

create function reconcile_diary_revision_sources_v2()
returns trigger language plpgsql as $$
declare
  revision_id uuid;
  declared_count integer;
  actual_count integer;
  pinned_recipe_version_id uuid;
  entry_kind_value text;
  operation_value text;
  rights_required boolean := false;
begin
  if tg_table_name = 'diary_entry_revision' then
    revision_id := new.id;
  else
    revision_id := coalesce(new.diary_entry_revision_id, old.diary_entry_revision_id);
  end if;
  select source_component_count, recipe_version_id, entry_kind, operation
    into declared_count, pinned_recipe_version_id, entry_kind_value, operation_value
  from diary_entry_revision where id = revision_id;
  if not found then return null; end if;
  select count(*) into actual_count from diary_entry_revision_source
  where diary_entry_revision_id = revision_id;
  if actual_count <> declared_count then
    raise exception 'diary recipe source count does not reconcile' using errcode = '23514';
  end if;
  if entry_kind_value = 'recipe' and not exists (
    select 1
    from diary_entry_revision revision
    join recipe_version version on version.id = revision.recipe_version_id
    where revision.id = revision_id
      and version.recipe_id = revision.recipe_id
      and version.version_number = revision.recipe_version_number
      and version.name = revision.recipe_name
      and version.total_weight_grams = revision.recipe_yield_grams
      and version.final_yield_source = revision.recipe_yield_source
      and version.serving_count is not distinct from revision.recipe_serving_count
      and version.serving_label is not distinct from revision.recipe_serving_label
      and version.calculation_version = revision.recipe_calculation_version
      and version.calculation_version = revision.snapshot_engine_version
      and version.retention_policy_code = revision.recipe_retention_policy_code
      and version.retention_policy_version = revision.recipe_retention_policy_version
      and version.calculation_assumptions = revision.recipe_calculation_assumptions
      and version.warnings = revision.recipe_warnings
  ) then
    raise exception 'diary recipe snapshot does not match its pinned immutable version'
      using errcode = '23514';
  end if;
  if entry_kind_value = 'recipe' then
    rights_required := operation_value = 'create';
    if operation_value in ('move', 'update') then
      rights_required := exists (
        select 1
        from diary_entry_revision current_revision
        left join diary_entry_revision previous_revision
          on previous_revision.diary_entry_id = current_revision.diary_entry_id
          and previous_revision.revision_number = current_revision.revision_number - 1
        where current_revision.id = revision_id
          and (
            previous_revision.id is null
            or row(
              current_revision.quantity, current_revision.input_unit,
              current_revision.resolved_quantity, current_revision.resolved_unit,
              current_revision.snapshot_engine_version
            ) is distinct from row(
              previous_revision.quantity, previous_revision.input_unit,
              previous_revision.resolved_quantity, previous_revision.resolved_unit,
              previous_revision.snapshot_engine_version
            )
            or exists (
              (select nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
                completeness, is_exact, contributor_count, quantified_count,
                trace_count, unknown_count, unknown_reasons
               from diary_entry_revision_nutrient
               where diary_entry_revision_id = current_revision.id
               except
               select nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
                completeness, is_exact, contributor_count, quantified_count,
                trace_count, unknown_count, unknown_reasons
               from diary_entry_revision_nutrient
               where diary_entry_revision_id = previous_revision.id)
              union all
              (select nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
                completeness, is_exact, contributor_count, quantified_count,
                trace_count, unknown_count, unknown_reasons
               from diary_entry_revision_nutrient
               where diary_entry_revision_id = previous_revision.id
               except
               select nutrient_id, nutrient_code, nutrient_name, unit, known_amount,
                completeness, is_exact, contributor_count, quantified_count,
                trace_count, unknown_count, unknown_reasons
               from diary_entry_revision_nutrient
               where diary_entry_revision_id = current_revision.id)
            )
          )
      );
    end if;
    if rights_required and exists (
      select 1
      from diary_entry_revision_source snapshot
      left join food_source source on source.id = snapshot.food_source_id
      left join food_source_release release
        on release.food_source_id = snapshot.food_source_id
        and release.id = snapshot.source_release_id
      where snapshot.diary_entry_revision_id = revision_id
        and not (
          source.active
          and source.commercial_use_allowed
          and source.redistribution_allowed
          and source.rights_review_status in ('approved', 'restricted')
          and source.rights_reviewed_at is not null
          and char_length(btrim(source.rights_reviewed_by)) > 0
          and release.status = 'promoted'
          and release.promoted_at is not null
          and release.rights_manifest_sha256 is not null
        )
    ) then
      raise exception 'changed diary recipe nutrition requires currently eligible sources'
        using errcode = '23514';
    end if;
  end if;
  if entry_kind_value = 'recipe' and exists (
    select 1
    from recipe_version_source expected
    where expected.recipe_version_id = pinned_recipe_version_id
      and not exists (
        select 1 from diary_entry_revision_source actual
        where actual.diary_entry_revision_id = revision_id
          and actual.food_source_id = expected.food_source_id
          and actual.source_release_id = expected.source_release_id
          and actual.source_code = expected.source_code
          and actual.source_display_name = expected.source_display_name
          and actual.license_expression = expected.license_expression
          and actual.attribution_required = expected.attribution_required
          and actual.attribution_text = expected.attribution_text
      )
    union all
    select 1
    from diary_entry_revision_source actual
    where actual.diary_entry_revision_id = revision_id
      and not exists (
        select 1 from recipe_version_source expected
        where expected.recipe_version_id = pinned_recipe_version_id
          and expected.food_source_id = actual.food_source_id
          and expected.source_release_id = actual.source_release_id
          and expected.source_code = actual.source_code
          and expected.source_display_name = actual.source_display_name
          and expected.license_expression = actual.license_expression
          and expected.attribution_required = actual.attribution_required
          and expected.attribution_text = actual.attribution_text
      )
  ) then
    raise exception 'diary recipe attribution set does not match its pinned recipe version'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger diary_revision_source_reconcile_v2
after insert or delete on diary_entry_revision_source deferrable initially deferred
for each row execute function reconcile_diary_revision_sources_v2();
create constraint trigger diary_revision_parent_source_reconcile_v2
after insert on diary_entry_revision deferrable initially deferred
for each row execute function reconcile_diary_revision_sources_v2();

create trigger diary_revision_source_reject_update_v2
before update on diary_entry_revision_source
for each row execute function reject_immutable_row_update();

create function guard_diary_revision_source_delete_v2()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  if exists (
    select 1 from diary_entry_revision where id = old.diary_entry_revision_id
  ) then
    raise exception 'immutable diary recipe source cannot be deleted while its revision exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger diary_revision_source_guard_delete_v2
before delete on diary_entry_revision_source
for each row execute function guard_diary_revision_source_delete_v2();

comment on table recipe_version is
  'Immutable recipe calculation revision with explicit final yield, retention policy, warnings, and declared child counts.';
comment on table recipe_version_nutrient is
  'Immutable total recipe nutrient aggregates; known_amount is a lower bound and missingness is explicit in counters.';
comment on table recipe_version_source is
  'Deterministic deduplicated source/release attribution snapshot for a recipe version.';
comment on table nutrition_goal_version is
  'Immutable goal period and fixed/derived energy snapshot; derived rows bind to a locked profile revision.';
comment on table diary_entry_revision_source is
  'Immutable source/release attribution set copied when a recipe version is logged.';
