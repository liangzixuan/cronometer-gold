-- Pin the remaining food-search projection trigger functions to the application
-- schema. All four functions remain SECURITY INVOKER with their existing
-- owners, bodies, and ACLs. This migration grants no table, sequence, schema,
-- role, or function authority.

do $migration$
declare
  table_owner oid;
  target_schema name := pg_catalog.current_schema();
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
    and class_row.relname = 'food'
    and class_row.relkind in ('r', 'p');
  if table_owner is null then
    raise exception 'food is absent from the application schema'
      using errcode = '42P01';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname in ('food', 'food_barcode', 'food_serving', 'food_source')
      and class_row.relkind in ('r', 'p')
      and class_row.relowner = table_owner
  ) <> 4 then
    raise exception 'food-search projection tables are absent or do not share the expected owner'
      using errcode = '55000';
  end if;

  -- The four callers below depend on the revision helper hardened by migration
  -- 0016. Refuse to trust them if that upstream function has drifted or lost
  -- its schema pin.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname = 'advance_food_search_projection_revision'
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where namespace_row.nspname = target_schema
      and procedure_row.proname = 'advance_food_search_projection_revision'
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
      and procedure_row.proowner = table_owner
      and pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) = 'd1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108'
      and pg_catalog.pg_get_function_result(procedure_row.oid) = 'void'
      and language_row.lanname = 'plpgsql'
      and procedure_row.provolatile = 'v'
      and not procedure_row.proisstrict
      and not procedure_row.proleakproof
      and procedure_row.proparallel = 'u'
      and not procedure_row.prosecdef
      and procedure_row.proacl is null
      and procedure_row.proconfig = array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]::text[]
  ) <> 1 then
    raise exception 'food-search projection revision helper identity or hardened semantics differ'
      using errcode = '55000';
  end if;

  -- Refuse to turn already-drifted functions or overloads into trusted ledger
  -- history. Migration 0003 created exactly these SECURITY INVOKER/default-ACL
  -- bodies with no function-local configuration.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'enqueue_food_search_barcode_insert',
        'enqueue_food_search_barcode_update',
        'enqueue_food_search_food_eligibility_change',
        'enqueue_food_search_serving_insert'
      )
  ) <> 4 or exists (
    select 1
    from (
      values
        (
          'enqueue_food_search_barcode_insert'::text,
          '4e888f3ef0b3af1e7eee14568069ae3fe06b65b88718614ed0e2c243a5d22318'::text
        ),
        (
          'enqueue_food_search_barcode_update',
          '9d7a90d0fee1a6923631c9b9018d9c813d3c8f7eea2df941fc32fbb4f5d453b0'
        ),
        (
          'enqueue_food_search_food_eligibility_change',
          '85ada305a6fd6b40cd5fb0652d64c240d1953033a243b0f7ce243caa9bc9c4de'
        ),
        (
          'enqueue_food_search_serving_insert',
          '223f2d1dc8f90c6bc04c4d85ec763bcb50727473f5576b0bcdbbf394c1c9d804'
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
    raise exception 'food-search projection trigger function identity or pre-hardening semantics differ'
      using errcode = '55000';
  end if;

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
    where (
        (
          namespace_row.nspname = target_schema
          and trigger_row.tgname in (
            'food_search_barcode_insert_outbox',
            'food_search_barcode_update_outbox',
            'food_search_eligibility_outbox',
            'food_search_serving_insert_outbox'
          )
        )
        or (
          procedure_namespace_row.nspname = target_schema
          and procedure_row.proname in (
            'enqueue_food_search_barcode_insert',
            'enqueue_food_search_barcode_update',
            'enqueue_food_search_food_eligibility_change',
            'enqueue_food_search_serving_insert'
          )
          and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
        )
      )
      and not trigger_row.tgisinternal
  ) <> 4 or exists (
    select 1
    from (
      values
        (
          'food_search_barcode_insert_outbox'::text,
          'food_barcode'::text,
          'enqueue_food_search_barcode_insert'::text,
          'CREATE TRIGGER food_search_barcode_insert_outbox AFTER INSERT ON food_barcode REFERENCING NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_insert()'::text
        ),
        (
          'food_search_barcode_update_outbox',
          'food_barcode',
          'enqueue_food_search_barcode_update',
          'CREATE TRIGGER food_search_barcode_update_outbox AFTER UPDATE ON food_barcode REFERENCING OLD TABLE AS old_food_search_barcodes NEW TABLE AS new_food_search_barcodes FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_barcode_update()'
        ),
        (
          'food_search_eligibility_outbox',
          'food',
          'enqueue_food_search_food_eligibility_change',
          'CREATE TRIGGER food_search_eligibility_outbox AFTER UPDATE ON food REFERENCING OLD TABLE AS old_food_search_rows NEW TABLE AS new_food_search_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_food_eligibility_change()'
        ),
        (
          'food_search_serving_insert_outbox',
          'food_serving',
          'enqueue_food_search_serving_insert',
          'CREATE TRIGGER food_search_serving_insert_outbox AFTER INSERT ON food_serving REFERENCING NEW TABLE AS new_food_search_servings FOR EACH STATEMENT EXECUTE FUNCTION enqueue_food_search_serving_insert()'
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
    raise exception 'food-search projection trigger identity or definition differs'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'alter function %I.enqueue_food_search_barcode_insert() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.enqueue_food_search_barcode_update() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.enqueue_food_search_food_eligibility_change() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.enqueue_food_search_serving_insert() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'enqueue_food_search_barcode_insert',
        'enqueue_food_search_barcode_update',
        'enqueue_food_search_food_eligibility_change',
        'enqueue_food_search_serving_insert'
      )
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
      and procedure_row.proconfig = array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]::text[]
  ) <> 4 then
    raise exception 'food-search projection trigger search path hardening did not persist'
      using errcode = '55000';
  end if;
end;
$migration$;
