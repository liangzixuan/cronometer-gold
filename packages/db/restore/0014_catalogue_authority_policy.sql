-- Versioned post-restore policy for catalogue authority migrations 0014-0015.
--
-- Logical restores deliberately use --no-owner --no-privileges. Run this only
-- against a new isolated nutrition_restore_* database while PUBLIC CONNECT is
-- revoked. The expected object owner is supplied through the validated
-- nutrition.expected_restore_owner setting; this policy never guesses or
-- rewrites ownership.

begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:restore:catalogue-authority:v1')
);

do $policy$
declare
  acl_grantee oid;
  acl_grantee_name name;
  approval_function oid;
  approval_guard_function oid;
  capability_role text;
  capability_role_oid oid;
  expected_owner text := pg_catalog.current_setting(
    'nutrition.expected_restore_owner',
    true
  );
  expected_owner_oid oid;
  target_schema constant name := 'public';
begin
  if pg_catalog.current_database() !~ '^nutrition_restore_[a-z0-9_]{1,45}$' then
    raise exception 'catalogue restore authority policy requires an isolated nutrition_restore_* database'
      using errcode = '22023';
  end if;

  if expected_owner is null
    or expected_owner !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'catalogue restore authority policy requires an explicit safe expected owner'
      using errcode = '22023';
  end if;

  select role_row.oid
  into expected_owner_oid
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = expected_owner;
  if expected_owner_oid is null then
    raise exception 'catalogue restore authority expected owner does not exist'
      using errcode = '42704';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_database as database_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        database_row.datacl,
        pg_catalog.acldefault('d', database_row.datdba)
      )
    ) as acl
    where database_row.datname = pg_catalog.current_database()
      and acl.grantee = 0
      and acl.privilege_type = 'CONNECT'
  ) then
    raise exception 'PUBLIC CONNECT must remain revoked while restore authority is repaired'
      using errcode = '42501';
  end if;

  foreach capability_role in array array[
    'nutrition_catalogue_stage',
    'nutrition_catalogue_validate',
    'nutrition_catalogue_approve_data',
    'nutrition_catalogue_approve_quality',
    'nutrition_catalogue_approve_rights',
    'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ] loop
    select role_row.oid
    into capability_role_oid
    from pg_catalog.pg_roles as role_row
    where role_row.rolname = capability_role;

    if capability_role_oid is null then
      raise exception 'required catalogue capability role % is absent', capability_role
        using errcode = '42704';
    end if;

    if exists (
      select 1
      from pg_catalog.pg_roles as role_row
      where role_row.oid = capability_role_oid
        and (
          role_row.rolcanlogin
          or role_row.rolsuper
          or role_row.rolcreatedb
          or role_row.rolcreaterole
          or role_row.rolreplication
          or role_row.rolbypassrls
        )
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.member = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.roleid = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = capability_role_oid
        and dependency.deptype = 'o'
    ) then
      raise exception 'catalogue capability role % violates the attribute, membership, or ownership policy', capability_role
        using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and class_row.relowner <> expected_owner_oid
  ) then
    raise exception 'restored table, sequence, view, or foreign-table ownership differs from the explicit expected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proowner <> expected_owner_oid
  ) then
    raise exception 'restored function ownership differs from the explicit expected owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_type as type_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = target_schema
      and (
        type_row.typowner <> expected_owner_oid
        or type_row.typacl is not null
      )
  ) then
    raise exception 'restored public types differ from the exact owner and empty-ACL policy'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_namespace as namespace_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = namespace_row.nspowner
    where namespace_row.nspname = target_schema
      and owner_role.rolname = 'pg_database_owner'
  ) then
    raise exception 'public schema owner must remain pg_database_owner'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as class_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and class_row.relacl is not null
  ) then
    raise exception 'restored tables, sequences, or views contain unexpected explicit privileges'
      using errcode = '55000';
  end if;

  select pg_catalog.to_regprocedure(
    'public.catalogue_record_import_approval(uuid,text,text,text,text,text)'
  )
  into approval_function;
  if approval_function is null then
    raise exception 'catalogue approval authority function is absent'
      using errcode = '42883';
  end if;

  select pg_catalog.to_regprocedure(
    'public.guard_food_import_approval_authority()'
  )
  into approval_guard_function;
  if approval_guard_function is null then
    raise exception 'catalogue approval guard function is absent'
      using errcode = '42883';
  end if;

  -- Pin the forward 0015 EXPAND guard as known-good authority policy, not
  -- merely source/target parity.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as class_row
      on class_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname = 'food_source_release_activation'
      and constraint_row.conname =
        'food_source_release_activation_expand_audit_null_check'
  ) <> 1 or exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as class_row
      on class_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and class_row.relname = 'food_source_release_activation'
      and constraint_row.conname =
        'food_source_release_activation_expand_audit_null_check'
      and (
        constraint_row.contype <> 'c'
        or not constraint_row.convalidated
        or pg_catalog.pg_get_constraintdef(constraint_row.oid, true) <>
          'CHECK (database_principal IS NULL AND database_capability_role IS NULL)'
      )
  ) then
    raise exception 'catalogue activation authority constraint differs from the forward 0015 policy'
      using errcode = '55000';
  end if;

  -- Pin every function whose search_path migration 0014 hardened. The exact
  -- identity and executable body are policy, not merely source/target parity.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'catalogue_evidence_bundle_uri_is_valid',
        'catalogue_record_import_approval',
        'guard_food_import_approval_authority',
        'guard_food_import_batch_initial_state',
        'guard_food_import_batch_update',
        'guard_food_import_batch_validation_digest',
        'guard_food_import_record_update',
        'guard_food_source_active_release_authority',
        'guard_food_source_initial_active_release',
        'guard_food_source_release_initial_state',
        'guard_food_source_release_legacy_promotion_grandfather',
        'guard_food_source_release_update',
        'guard_new_food_source_release_authority',
        'reject_new_legacy_unbound_catalogue_evidence'
      )
  ) <> 14 or exists (
    select 1
    from (
      values
        ('catalogue_evidence_bundle_uri_is_valid'::text, 'value text, digest text'::text, '5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e'::text, 'boolean'::text, 'sql'::text, 'i'::text, true, false, 'u'::text, false),
        ('catalogue_record_import_approval', 'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text', '89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac', 'boolean', 'plpgsql', 'v', false, false, 'u', true),
        ('guard_food_import_approval_authority', '', 'f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_initial_state', '', '2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_update', '', '59dc41d73ec62b554caa721e13a2581a75327688f840cab922fddad0ca7be249', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_batch_validation_digest', '', '511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_import_record_update', '', 'b111a6db4f4bd43bf2e9183ecf0ee8b19ccda1ed3679c598ef2f73d58d9cb2d9', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_active_release_authority', '', '306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_initial_active_release', '', 'e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_initial_state', '', '797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_legacy_promotion_grandfather', '', '22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_food_source_release_update', '', '191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('guard_new_food_source_release_authority', '', '93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3', 'trigger', 'plpgsql', 'v', false, false, 'u', false),
        ('reject_new_legacy_unbound_catalogue_evidence', '', 'f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e', 'trigger', 'plpgsql', 'v', false, false, 'u', false)
    ) as expected(
      function_name, arguments, source_sha256, result_type, language_name,
      volatility, is_strict, is_leakproof, parallel_mode, security_definer
    )
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = expected.arguments
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
      and namespace_row.nspname = target_schema
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or namespace_row.oid is null
      or procedure_row.proowner <> expected_owner_oid
      or pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
        'hex'
      ) <> expected.source_sha256
      or pg_catalog.pg_get_function_result(procedure_row.oid) <> expected.result_type
      or language_row.lanname <> expected.language_name
      or procedure_row.provolatile::text <> expected.volatility
      or procedure_row.proisstrict is distinct from expected.is_strict
      or procedure_row.proleakproof is distinct from expected.is_leakproof
      or procedure_row.proparallel::text <> expected.parallel_mode
      or procedure_row.prosecdef is distinct from expected.security_definer
      or procedure_row.proconfig is distinct from array[
        'search_path=pg_catalog, public, pg_temp'
      ]::text[]
  ) then
    raise exception 'catalogue authority function identity or executable semantics differ from policy'
      using errcode = '55000';
  end if;

  -- Pin every non-internal trigger attached to the reviewed authority
  -- functions, including both grandfather and legacy-evidence trigger sites.
  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and not trigger_row.tgisinternal
      and (
        procedure_row.proname in (
          'guard_food_import_approval_authority',
          'guard_food_import_batch_initial_state',
          'guard_food_import_batch_update',
          'guard_food_import_batch_validation_digest',
          'guard_food_import_record_update',
          'guard_food_source_active_release_authority',
          'guard_food_source_initial_active_release',
          'guard_food_source_release_initial_state',
          'guard_food_source_release_legacy_promotion_grandfather',
          'guard_food_source_release_update',
          'guard_new_food_source_release_authority',
          'reject_new_legacy_unbound_catalogue_evidence'
        )
        or trigger_row.tgname in (
          'food_import_approval_guard_authority',
          'food_import_batch_guard_initial_state',
          'food_import_batch_guard_update',
          'food_import_batch_guard_validation_digest',
          'food_import_batch_reject_new_legacy_unbound',
          'food_import_record_guard_update',
          'food_source_guard_active_release_authority',
          'food_source_guard_initial_active_release',
          'food_source_release_guard_initial_state',
          'food_source_release_guard_legacy_grandfather_insert',
          'food_source_release_guard_legacy_grandfather_update',
          'food_source_release_guard_new_authority',
          'food_source_release_guard_update',
          'food_source_release_reject_new_legacy_unbound'
        )
      )
  ) <> 14 or exists (
    select 1
    from (
      values
        ('food_import_approval_guard_authority'::text, 'food_import_approval'::text, 'guard_food_import_approval_authority'::text, 'CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()'::text),
        ('food_import_batch_guard_initial_state', 'food_import_batch', 'guard_food_import_batch_initial_state', 'CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()'),
        ('food_import_batch_guard_update', 'food_import_batch', 'guard_food_import_batch_update', 'CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()'),
        ('food_import_batch_guard_validation_digest', 'food_import_batch', 'guard_food_import_batch_validation_digest', 'CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()'),
        ('food_import_batch_reject_new_legacy_unbound', 'food_import_batch', 'reject_new_legacy_unbound_catalogue_evidence', 'CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()'),
        ('food_import_record_guard_update', 'food_import_record', 'guard_food_import_record_update', 'CREATE TRIGGER food_import_record_guard_update BEFORE UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()'),
        ('food_source_guard_active_release_authority', 'food_source', 'guard_food_source_active_release_authority', 'CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()'),
        ('food_source_guard_initial_active_release', 'food_source', 'guard_food_source_initial_active_release', 'CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()'),
        ('food_source_release_guard_initial_state', 'food_source_release', 'guard_food_source_release_initial_state', 'CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()'),
        ('food_source_release_guard_legacy_grandfather_insert', 'food_source_release', 'guard_food_source_release_legacy_promotion_grandfather', 'CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()'),
        ('food_source_release_guard_legacy_grandfather_update', 'food_source_release', 'guard_food_source_release_legacy_promotion_grandfather', 'CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()'),
        ('food_source_release_guard_new_authority', 'food_source_release', 'guard_new_food_source_release_authority', 'CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()'),
        ('food_source_release_guard_update', 'food_source_release', 'guard_food_source_release_update', 'CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()'),
        ('food_source_release_reject_new_legacy_unbound', 'food_source_release', 'reject_new_legacy_unbound_catalogue_evidence', 'CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()')
    ) as expected(trigger_name, table_name, function_name, definition)
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
      and namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
      and procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    where trigger_row.oid is null
      or class_row.oid is null
      or namespace_row.oid is null
      or procedure_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.definition
  ) then
    raise exception 'catalogue authority trigger identity, definition, or enabled state differs from policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid = approval_function
      and (
        pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
          'hex'
        ) <> '89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac'
        or pg_catalog.pg_get_function_result(procedure_row.oid) <> 'boolean'
        or language_row.lanname <> 'plpgsql'
        or procedure_row.provolatile <> 'v'
        or procedure_row.proisstrict
        or procedure_row.proleakproof
        or procedure_row.proparallel <> 'u'
      )
  ) then
    raise exception 'catalogue approval function executable semantics differ from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.proname in (
        'guard_food_import_approval_authority',
        'guard_food_import_batch_validation_digest'
      )
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'guard_food_import_approval_authority'::text,
          'f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd'::text
        ),
        (
          'guard_food_import_batch_validation_digest'::text,
          '511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2'::text
        )
    ) as expected(function_name, source_sha256)
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.proname = expected.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) = ''
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
      and namespace_row.nspname = target_schema
    left join pg_catalog.pg_language as language_row
      on language_row.oid = procedure_row.prolang
    where procedure_row.oid is null
      or namespace_row.oid is null
      or procedure_row.proowner <> expected_owner_oid
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
      or procedure_row.proconfig is distinct from array[
        'search_path=pg_catalog, public, pg_temp'
      ]::text[]
  ) then
    raise exception 'catalogue guard function executable semantics differ from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
    join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
    where namespace_row.nspname = target_schema
      and not trigger_row.tgisinternal
      and procedure_row.proname in (
        'guard_food_import_approval_authority',
        'guard_food_import_batch_validation_digest'
      )
  ) <> 2 or exists (
    select 1
    from (
      values
        (
          'food_import_approval_guard_authority'::text,
          'food_import_approval'::text,
          'guard_food_import_approval_authority'::text,
          'CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()'::text
        ),
        (
          'food_import_batch_guard_validation_digest'::text,
          'food_import_batch'::text,
          'guard_food_import_batch_validation_digest'::text,
          'CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()'::text
        )
    ) as expected(trigger_name, table_name, function_name, definition)
    left join pg_catalog.pg_trigger as trigger_row
      on trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
    left join pg_catalog.pg_class as class_row
      on class_row.oid = trigger_row.tgrelid
      and class_row.relname = expected.table_name
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = class_row.relnamespace
      and namespace_row.nspname = target_schema
    left join pg_catalog.pg_proc as procedure_row
      on procedure_row.oid = trigger_row.tgfoid
      and procedure_row.proname = expected.function_name
    where trigger_row.oid is null
      or class_row.oid is null
      or namespace_row.oid is null
      or procedure_row.oid is null
      or trigger_row.tgenabled <> 'O'
      or pg_catalog.pg_get_triggerdef(trigger_row.oid, true) <> expected.definition
  ) then
    raise exception 'catalogue authority trigger definition or enabled state differs from policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where procedure_row.oid = approval_function
      and (
        coalesce(grantee.rolname, 'PUBLIC') <> all (array[
          'PUBLIC',
          expected_owner,
          'nutrition_catalogue_approve_data',
          'nutrition_catalogue_approve_quality',
          'nutrition_catalogue_approve_rights'
        ])
        or acl.privilege_type <> 'EXECUTE'
        or acl.is_grantable
      )
  ) then
    raise exception 'catalogue approval function has an unexpected pre-policy privilege'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        namespace_row.nspacl,
        pg_catalog.acldefault('n', namespace_row.nspowner)
      )
    ) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where namespace_row.nspname = target_schema
      and coalesce(grantee.rolname, 'PUBLIC') <> all (array[
        'PUBLIC',
        'pg_database_owner',
        'nutrition_catalogue_approve_data',
        'nutrition_catalogue_approve_quality',
        'nutrition_catalogue_approve_rights'
      ])
  ) then
    raise exception 'public schema has an unexpected pre-policy privilege grantee'
      using errcode = '55000';
  end if;

  execute 'revoke all on function public.catalogue_record_import_approval(uuid,text,text,text,text,text) from public';
  execute 'grant execute on function public.catalogue_record_import_approval(uuid,text,text,text,text,text) to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights';
  execute 'grant usage on schema public to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights';

  execute 'revoke all on function public.guard_food_import_approval_authority() from public';
  for acl_grantee in
    select distinct acl.grantee
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
      and acl.grantee <> 0
  loop
    select role_row.rolname
    into acl_grantee_name
    from pg_catalog.pg_roles as role_row
    where role_row.oid = acl_grantee;
    if acl_grantee_name is null then
      raise exception 'catalogue approval guard function has an unknown ACL grantee'
        using errcode = '55000';
    end if;
    execute pg_catalog.format(
      'revoke all on function public.guard_food_import_approval_authority() from %I',
      acl_grantee_name
    );
  end loop;
  execute pg_catalog.format(
    'grant execute on function public.guard_food_import_approval_authority() to %I',
    expected_owner
  );

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    where procedure_row.oid = approval_function
      and (
        procedure_row.proowner <> expected_owner_oid
        or not procedure_row.prosecdef
        or procedure_row.proconfig is distinct from array[
          'search_path=pg_catalog, public, pg_temp'
        ]::text[]
      )
  ) then
    raise exception 'catalogue approval function owner, SECURITY DEFINER flag, or search_path differs from policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where procedure_row.oid = approval_function
      and acl.privilege_type = 'EXECUTE'
      and acl.grantor = expected_owner_oid
      and not acl.is_grantable
      and coalesce(grantee.rolname, 'PUBLIC') = any (array[
        expected_owner,
        'nutrition_catalogue_approve_data',
        'nutrition_catalogue_approve_quality',
        'nutrition_catalogue_approve_rights'
      ])
  ) <> 4 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_function
  ) <> 4 then
    raise exception 'catalogue approval function ACL is not the exact four-principal policy'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
      and acl.grantee = expected_owner_oid
      and acl.grantor = expected_owner_oid
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_guard_function
  ) <> 1 then
    raise exception 'catalogue approval guard function ACL is not the exact owner-only policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = target_schema
      and procedure_row.oid <> approval_function
      and procedure_row.oid <> approval_guard_function
      and procedure_row.proacl is not null
  ) then
    raise exception 'a non-authority public function has unexpected explicit privileges'
      using errcode = '55000';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as acl
    left join pg_catalog.pg_roles as grantee
      on grantee.oid = acl.grantee
    where namespace_row.nspname = target_schema
      and not acl.is_grantable
      and (
        (coalesce(grantee.rolname, 'PUBLIC') = 'PUBLIC' and acl.privilege_type = 'USAGE')
        or (grantee.rolname = 'pg_database_owner' and acl.privilege_type in ('CREATE', 'USAGE'))
        or (
          grantee.rolname in (
            'nutrition_catalogue_approve_data',
            'nutrition_catalogue_approve_quality',
            'nutrition_catalogue_approve_rights'
          )
          and acl.privilege_type = 'USAGE'
        )
      )
  ) <> 6 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_namespace as namespace_row
    cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as acl
    where namespace_row.nspname = target_schema
  ) <> 6 then
    raise exception 'public schema ACL is not the exact reviewed six-entry policy'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl as default_acl
    left join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = default_acl.defaclnamespace
    where default_acl.defaclnamespace = 0
      or namespace_row.nspname = target_schema
  ) then
    raise exception 'an unversioned global or public-schema default ACL affects restored objects or capabilities'
      using errcode = '55000';
  end if;
end;
$policy$;

commit;
