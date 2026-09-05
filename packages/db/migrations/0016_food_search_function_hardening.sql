-- Pin the food_source eligibility trigger call chain to the application schema.
--
-- Both functions remain SECURITY INVOKER with their existing owners and ACLs.
-- This migration grants no table, sequence, schema, role, or function authority.

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
    and class_row.relname = 'food_source'
    and class_row.relkind in ('r', 'p');
  if table_owner is null then
    raise exception 'food_source is absent from the application schema'
      using errcode = '42P01';
  end if;

  -- Refuse to turn an already-drifted function or overload into trusted ledger
  -- history. Migration 0003 created exactly these SECURITY INVOKER/default-ACL
  -- bodies with no function-local configuration.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'advance_food_search_projection_revision',
        'enqueue_food_search_source_eligibility_change'
      )
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'advance_food_search_projection_revision'::text,
          'd1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108'::text,
          'void'::text
        ),
        (
          'enqueue_food_search_source_eligibility_change',
          '3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87',
          'trigger'
        )
    ) as expected(function_name, source_sha256, result_type)
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
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> expected.result_type
      or language_row.lanname <> 'plpgsql'
      or procedure_row.provolatile <> 'v'
      or procedure_row.proisstrict
      or procedure_row.proleakproof
      or procedure_row.proparallel <> 'u'
      or procedure_row.prosecdef
      or procedure_row.proacl is not null
      or procedure_row.proconfig is not null
  ) then
    raise exception 'food-search source eligibility function identity or pre-hardening semantics differ'
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
    where namespace_row.nspname = target_schema
      and class_row.relname = 'food_source'
      and trigger_row.tgname = 'food_source_search_eligibility_outbox'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and procedure_namespace_row.nspname = target_schema
      and procedure_row.proname = 'enqueue_food_search_source_eligibility_change'
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
      and pg_catalog.pg_get_triggerdef(trigger_row.oid, true) =
        'CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()'
  ) <> 1 then
    raise exception 'food-search source eligibility trigger identity or definition differs'
      using errcode = '55000';
  end if;

  execute pg_catalog.format(
    'alter function %I.advance_food_search_projection_revision() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.enqueue_food_search_source_eligibility_change() set search_path = pg_catalog, %I, pg_temp',
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
        'advance_food_search_projection_revision',
        'enqueue_food_search_source_eligibility_change'
      )
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
      and procedure_row.proconfig = array[
        pg_catalog.format('search_path=pg_catalog, %I, pg_temp', target_schema)
      ]::text[]
  ) <> 2 then
    raise exception 'food-search source eligibility search path hardening did not persist'
      using errcode = '55000';
  end if;
end;
$migration$;
