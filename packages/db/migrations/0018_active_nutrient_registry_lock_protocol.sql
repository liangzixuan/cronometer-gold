-- Replace broad nutrient table locks with one transaction-scoped advisory
-- reader/writer protocol. This migration changes no role, membership, owner,
-- table ACL, sequence ACL, or function ACL and adds no elevated execution path.

do $migration$
declare
  target_schema name := pg_catalog.current_schema();
  table_owner oid;
  reconciliation_definition text;
  reconciliation_source text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('nutrition-tracker:catalogue-authority:v1')
  );

  select class_row.relowner
  into table_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'nutrient'
    and class_row.relkind in ('r', 'p');
  if table_owner is null then
    raise exception 'nutrient is absent from the application schema'
      using errcode = '42P01';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname in (
        'nutrient',
        'recipe_ingredient',
        'recipe_version',
        'recipe_version_nutrient',
        'recipe_version_source'
      )
      and class_row.relkind in ('r', 'p')
      and class_row.relowner = table_owner
  ) <> 5 then
    raise exception 'nutrient lock protocol tables are absent or have an unexpected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname = 'lock_active_nutrient_registry_for_read'
  ) then
    raise exception 'active nutrient registry reader lock function already exists'
      using errcode = '55000';
  end if;

  -- Refuse to bless drifted functions or overloads. Migration 0004 created the
  -- two writer functions and migration 0006 installed the current recipe
  -- reconciler with these exact owner-mode, default-ACL definitions.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_active_nutrient_vector_size',
        'lock_active_nutrient_registry_before_write',
        'reconcile_recipe_components_v2'
      )
  ) <> 3 or exists (
    select 1
    from (
      values
        (
          'guard_active_nutrient_vector_size'::text,
          '24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda'::text
        ),
        (
          'lock_active_nutrient_registry_before_write',
          'c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de'
        ),
        (
          'reconcile_recipe_components_v2',
          '8b3b4ae604c710597bfdd3f1261ce8468db2e722db2c46ebbc9fab54950e9371'
        )
    ) as expected(function_name, source_sha256)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.pronamespace = namespace_row.oid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or namespace_row.oid is null
      or procedure_row.proowner <> table_owner
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> 'trigger'
      or language_row.lanname <> 'plpgsql'
      or procedure_row.provolatile <> 'v'
      or procedure_row.proisstrict
      or procedure_row.proleakproof
      or procedure_row.proparallel <> 'u'
      or procedure_row.prosecdef
      or procedure_row.proacl is not null
      or procedure_row.proconfig is not null
  ) then
    raise exception 'active nutrient registry function identity or pre-hardening semantics differ'
      using errcode = '55000';
  end if;

  -- Include same-schema names and every binding of these dedicated functions
  -- so a foreign-schema trigger cannot survive outside the reviewed set.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where not trigger_row.tgisinternal
      and (
        (
          namespace_row.nspname = target_schema
          and trigger_row.tgname in (
            'nutrient_active_vector_size_guard',
            'nutrient_registry_lock_before_active_update',
            'nutrient_registry_lock_before_insert',
            'recipe_ingredient_reconcile_v2',
            'recipe_nutrient_reconcile_v2',
            'recipe_source_reconcile_v2',
            'recipe_version_components_reconcile_v2'
          )
        )
        or (
          procedure_namespace_row.nspname = target_schema
          and procedure_row.proname in (
            'guard_active_nutrient_vector_size',
            'lock_active_nutrient_registry_before_write',
            'reconcile_recipe_components_v2'
          )
          and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
        )
      )
  ) <> 7 or exists (
    select 1
    from (
      values
        (
          'nutrient_active_vector_size_guard'::text,
          'nutrient'::text,
          'guard_active_nutrient_vector_size'::text,
          'CREATE CONSTRAINT TRIGGER nutrient_active_vector_size_guard AFTER INSERT OR UPDATE OF active ON nutrient DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_active_nutrient_vector_size()'::text
        ),
        (
          'nutrient_registry_lock_before_active_update',
          'nutrient',
          'lock_active_nutrient_registry_before_write',
          'CREATE TRIGGER nutrient_registry_lock_before_active_update BEFORE UPDATE OF active ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()'
        ),
        (
          'nutrient_registry_lock_before_insert',
          'nutrient',
          'lock_active_nutrient_registry_before_write',
          'CREATE TRIGGER nutrient_registry_lock_before_insert BEFORE INSERT ON nutrient FOR EACH STATEMENT EXECUTE FUNCTION lock_active_nutrient_registry_before_write()'
        ),
        (
          'recipe_ingredient_reconcile_v2',
          'recipe_ingredient',
          'reconcile_recipe_components_v2',
          'CREATE CONSTRAINT TRIGGER recipe_ingredient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_ingredient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'
        ),
        (
          'recipe_nutrient_reconcile_v2',
          'recipe_version_nutrient',
          'reconcile_recipe_components_v2',
          'CREATE CONSTRAINT TRIGGER recipe_nutrient_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_nutrient DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'
        ),
        (
          'recipe_source_reconcile_v2',
          'recipe_version_source',
          'reconcile_recipe_components_v2',
          'CREATE CONSTRAINT TRIGGER recipe_source_reconcile_v2 AFTER INSERT OR DELETE ON recipe_version_source DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'
        ),
        (
          'recipe_version_components_reconcile_v2',
          'recipe_version',
          'reconcile_recipe_components_v2',
          'CREATE CONSTRAINT TRIGGER recipe_version_components_reconcile_v2 AFTER INSERT ON recipe_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_recipe_components_v2()'
        )
    ) as expected(trigger_name, table_name, function_name, trigger_definition)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
      and class_row.relkind in ('r', 'p')
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgrelid = class_row.oid
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    left join pg_catalog.pg_namespace as procedure_namespace_row
      on procedure_namespace_row.oid = procedure_row.pronamespace
    where trigger_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or procedure_namespace_row.nspname <> target_schema
      or procedure_row.proname <> expected.function_name
      or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) <> ''
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.trigger_definition
  ) then
    raise exception 'active nutrient registry trigger identity or definition differs'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    $create_function$
      create function %I.lock_active_nutrient_registry_for_read()
      returns void
      language sql
      as $function$
  select pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtext('nutrition-tracker:active-nutrient-registry:v1')
  );
$function$
    $create_function$,
    target_schema
  );

  select
    pg_catalog.pg_get_functiondef(procedure_row.oid),
    procedure_row.prosrc
  into strict reconciliation_definition, reconciliation_source
  from pg_catalog.pg_proc as procedure_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  where namespace_row.nspname = target_schema
    and procedure_row.proname = 'reconcile_recipe_components_v2'
    and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = '';
  if reconciliation_source not like '%  lock table nutrient in share mode;%'
     or reconciliation_source like '%  lock table nutrient in share mode;%  lock table nutrient in share mode;%' then
    raise exception 'recipe reconciler nutrient table-lock site differs'
      using errcode = '55000';
  end if;
  reconciliation_definition := pg_catalog.replace(
    reconciliation_definition,
    '  lock table nutrient in share mode;',
    '  perform lock_active_nutrient_registry_for_read();'
  );
  execute reconciliation_definition;

  execute pg_catalog.format(
    'alter function %I.guard_active_nutrient_vector_size() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.lock_active_nutrient_registry_before_write() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.lock_active_nutrient_registry_for_read() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.reconcile_recipe_components_v2() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );

  -- Keep the reviewed trigger identity while expanding the writer side from
  -- active-only updates to every update plus deletion.
  execute pg_catalog.format(
    'create or replace trigger nutrient_registry_lock_before_active_update before update or delete on %I.nutrient for each statement execute function %I.lock_active_nutrient_registry_before_write()',
    target_schema,
    target_schema
  );

  if exists (
    select 1
    from (
      values
        (
          'guard_active_nutrient_vector_size'::text,
          '24df72943bad96fc758d4a994ac2e8eaa18d9c9538ad117544abc4ccf4a22bda'::text,
          'trigger'::text,
          'plpgsql'::text
        ),
        (
          'lock_active_nutrient_registry_before_write',
          'c10e7e9df6768e94416aba47afe5639ffa7b3abfe5d2a6486a61e229dbe995de',
          'trigger',
          'plpgsql'
        ),
        (
          'lock_active_nutrient_registry_for_read',
          '22ab05f2e9749ecff7035e5188e1b9353d46533e7bc558748c76c43dbfc37ea5',
          'void',
          'sql'
        ),
        (
          'reconcile_recipe_components_v2',
          'c82895a20dc837d80959a01991ede3dd1ab0f99ae48bec66984d4ea7368e720a',
          'trigger',
          'plpgsql'
        )
    ) as expected(function_name, source_sha256, result_type, language_name)
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.pronamespace = namespace_row.oid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or procedure_row.proowner <> table_owner
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> expected.result_type
      or language_row.lanname <> expected.language_name
      or procedure_row.provolatile <> 'v'
      or procedure_row.proisstrict
      or procedure_row.proleakproof
      or procedure_row.proparallel <> 'u'
      or procedure_row.prosecdef
      or procedure_row.proacl is not null
      or procedure_row.proconfig is distinct from array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]::text[]
  ) then
    raise exception 'active nutrient registry post-migration function policy differs'
      using errcode = '55000';
  end if;
end;
$migration$;

-- Rollback: restore the pre-migration database backup. Forward repair must use
-- a new reviewed migration; do not replay or edit this migration in place.
