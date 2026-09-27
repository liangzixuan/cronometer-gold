-- Group repeated immutable coverage references without skipping any validation.
-- Existing migration bytes, trigger events, constraint timing and authority stay fixed.
do $migration$
declare
  target_schema name := pg_catalog.current_schema();
  table_owner oid;
  function_oid oid;
  reconciliation_definition text;
  reconciliation_source text;
  grouped_source text;
  original_trigger_state jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-authority:v1')
  );
  select class_row.relowner into table_owner
  from pg_catalog.pg_class class_row
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema and class_row.relname = 'recipe_version'
    and class_row.relkind in ('r', 'p');
  if table_owner is null or (
    select count(*) from pg_catalog.pg_class class_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname in ('nutrient', 'recipe_version', 'recipe_ingredient',
        'recipe_version_nutrient', 'recipe_version_source')
      and class_row.relkind in ('r', 'p') and class_row.relowner = table_owner
  ) <> 5 then
    raise exception 'recipe coverage tables are absent or have an unexpected owner'
      using errcode = '55000';
  end if;
  if (
    select count(*) from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname = 'reconcile_recipe_components_v2'
  ) <> 1 then
    raise exception 'recipe coverage function identity differs' using errcode = '55000';
  end if;
  select procedure_row.oid, pg_catalog.pg_get_functiondef(procedure_row.oid), procedure_row.prosrc
  into function_oid, reconciliation_definition, reconciliation_source
  from pg_catalog.pg_proc procedure_row
  join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
  join pg_catalog.pg_language language_row on language_row.oid = procedure_row.prolang
  where namespace_row.nspname = target_schema
    and procedure_row.proname = 'reconcile_recipe_components_v2'
    and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    and procedure_row.proowner = table_owner
    and pg_catalog.pg_get_function_result(procedure_row.oid) = 'trigger'
    and language_row.lanname = 'plpgsql' and procedure_row.provolatile = 'v'
    and not procedure_row.proisstrict and not procedure_row.proleakproof
    and procedure_row.proparallel = 'u' and not procedure_row.prosecdef
    and procedure_row.proacl is null
    and procedure_row.proconfig = array[
      pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
    ]
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')), 'hex')
      = 'c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a';
  if not found then
    raise exception 'recipe coverage function body or hardened policy differs'
      using errcode = '55000';
  end if;

  if (
    select count(*) from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class class_row on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
    where not trigger_row.tgisinternal and (
      trigger_row.tgfoid = function_oid or (
        namespace_row.nspname = target_schema and trigger_row.tgname in (
          'recipe_ingredient_reconcile_v2', 'recipe_nutrient_reconcile_v2',
          'recipe_source_reconcile_v2', 'recipe_version_components_reconcile_v2'
        )
      )
    )
  ) <> 4 or exists (
    select 1 from (values
        ('recipe_ingredient_reconcile_v2', 'recipe_ingredient', 'CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_nutrient_reconcile_v2', 'recipe_version_nutrient', 'CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_source_reconcile_v2', 'recipe_version_source', 'CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'),
        ('recipe_version_components_reconcile_v2', 'recipe_version', 'CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()')
    ) expected(trigger_name, table_name, definition)
    left join pg_catalog.pg_namespace namespace_row on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class class_row
      on class_row.relnamespace = namespace_row.oid and class_row.relname = expected.table_name
    left join pg_catalog.pg_trigger trigger_row
      on trigger_row.tgrelid = class_row.oid and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    where trigger_row.oid is null or trigger_row.tgfoid <> function_oid
      or trigger_row.tgenabled <> 'O'
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.definition
  ) then
    raise exception 'recipe coverage trigger identity or deferred semantics differ'
      using errcode = '55000';
  end if;
  select jsonb_agg(to_jsonb(trigger_row) order by trigger_row.oid)
  into original_trigger_state
  from pg_catalog.pg_trigger trigger_row where trigger_row.tgfoid = function_oid;

  -- These replacements are bounded by the exact pre-migration prosrc digest.
  -- count(*) is bigint, so multiplication precedes the existing final integer cast.
  grouped_source := reconciliation_source;
  grouped_source := pg_catalog.replace(grouped_source,
    $before_1$    with expected as ($before_1$,
    $after_1$    with ingredient_references as (
      select ingredient_kind, food_version_id, custom_food_id,
        nested_recipe_version_id, count(*) as reference_count
      from recipe_ingredient
      where recipe_version_id = version_id
      group by ingredient_kind, food_version_id, custom_food_id, nested_recipe_version_id
    ), expected as ($after_1$
  );
  grouped_source := pg_catalog.replace(grouped_source,
    $before_2$sum(case$before_2$,
    $after_2$sum(ingredient.reference_count * case$after_2$
  );
  grouped_source := pg_catalog.replace(grouped_source,
    $before_3$      from recipe_ingredient ingredient
      cross join nutrient definition$before_3$,
    $after_3$      from ingredient_references ingredient
      cross join nutrient definition$after_3$
  );
  grouped_source := pg_catalog.replace(grouped_source,
    $before_4$      where ingredient.recipe_version_id = version_id and definition.active$before_4$,
    $after_4$      where definition.active$after_4$
  );
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(grouped_source, 'UTF8')), 'hex')
      <> 'bd19e74f953196ffeb733c466bdf6f3a46a903d5a86f0121b5ba0af588af7128' then
    raise exception 'recipe grouped coverage transformation differs' using errcode = '55000';
  end if;
  execute pg_catalog.replace(reconciliation_definition, reconciliation_source, grouped_source);

  if not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_language language_row on language_row.oid = procedure_row.prolang
    where procedure_row.oid = function_oid and namespace_row.nspname = target_schema
      and procedure_row.proname = 'reconcile_recipe_components_v2'
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
      and pg_catalog.pg_get_function_result(procedure_row.oid) = 'trigger'
      and procedure_row.proowner = table_owner and language_row.lanname = 'plpgsql'
      and procedure_row.provolatile = 'v' and not procedure_row.proisstrict
      and not procedure_row.proleakproof and procedure_row.proparallel = 'u'
      and not procedure_row.prosecdef and procedure_row.proacl is null
      and procedure_row.proconfig = array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]
      and procedure_row.prosrc = grouped_source
  ) or original_trigger_state is distinct from (
    select jsonb_agg(to_jsonb(trigger_row) order by trigger_row.oid)
    from pg_catalog.pg_trigger trigger_row where trigger_row.tgfoid = function_oid
  ) then
    raise exception 'recipe grouped coverage post-migration policy differs'
      using errcode = '55000';
  end if;
end;
$migration$;
