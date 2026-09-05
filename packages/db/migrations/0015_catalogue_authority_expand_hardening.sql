-- Follow-up hardening for the catalogue database-authority EXPAND boundary.
-- Migration 0014 is already part of the immutable migration ledger; keep its
-- checksum stable and apply these fail-closed corrections forward-only.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-capability-roles:v1')
);

alter table food_source_release_activation
  add constraint food_source_release_activation_expand_audit_null_check check (
    database_principal is null and database_capability_role is null
  ) not valid;

comment on constraint food_source_release_activation_expand_audit_null_check
on food_source_release_activation is
  'EXPAND guard: new or changed activation and rollback rows must keep database authority NULL; preserved pre-0015 audit evidence leaves this constraint unvalidated pending a reviewed forward repair.';

do $migration$
declare
  acl_grantee oid;
  acl_grantee_name name;
  approval_function oid;
  expected_acl_count integer;
  function_owner oid;
  function_owner_name name;
  has_incoming_capability_membership boolean;
  has_legacy_activation_authority_rows boolean;
  target_schema name := current_schema();
begin
  select
    procedure_row.oid,
    procedure_row.proowner,
    pg_catalog.pg_get_userbyid(procedure_row.proowner)
  into approval_function, function_owner, function_owner_name
  from pg_catalog.pg_proc as procedure_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  where namespace_row.nspname = target_schema
    and procedure_row.oid = pg_catalog.to_regprocedure(
      pg_catalog.format(
        '%I.catalogue_record_import_approval(uuid,text,text,text,text,text)',
        target_schema
      )
    );

  if approval_function is null then
    raise exception 'catalogue approval authority function is absent'
      using errcode = '42883';
  end if;

  execute pg_catalog.format(
    'revoke all on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) from public',
    target_schema
  );

  for acl_grantee in
    select distinct acl.grantee
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_function
      and acl.privilege_type = 'EXECUTE'
      and acl.grantee <> 0
  loop
    select role_row.rolname
    into acl_grantee_name
    from pg_catalog.pg_roles as role_row
    where role_row.oid = acl_grantee;
    if acl_grantee_name is null then
      raise exception 'catalogue approval function has an unknown ACL grantee'
        using errcode = '55000';
    end if;
    execute pg_catalog.format(
      'revoke all on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) from %I',
      target_schema,
      acl_grantee_name
    );
  end loop;

  execute pg_catalog.format(
    'grant execute on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) to %I',
    target_schema,
    function_owner_name
  );

  select exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as capability_role
      on capability_role.oid = membership.roleid
    where capability_role.rolname in (
      'nutrition_catalogue_stage',
      'nutrition_catalogue_validate',
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights',
      'nutrition_catalogue_promote_activate',
      'nutrition_catalogue_rollback'
    )
  )
  into has_incoming_capability_membership;

  select exists (
    select 1
    from food_source_release_activation
    where database_principal is not null
      or database_capability_role is not null
  )
  into has_legacy_activation_authority_rows;

  if has_incoming_capability_membership or has_legacy_activation_authority_rows then
    raise notice
      'catalogue capability membership or legacy activation authority evidence detected; reviewer EXECUTE remains disabled; this migration never changes memberships';
  else
    execute pg_catalog.format(
      'grant execute on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights',
      target_schema
    );
  end if;

  expected_acl_count := case
    when has_incoming_capability_membership or has_legacy_activation_authority_rows then 1
    else 4
  end;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    left join pg_catalog.pg_roles as grantee_role
      on grantee_role.oid = acl.grantee
    where procedure_row.oid = approval_function
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
      and acl.grantor = function_owner
      and (
        acl.grantee = function_owner
        or (
          not has_incoming_capability_membership
          and not has_legacy_activation_authority_rows
          and grantee_role.rolname in (
            'nutrition_catalogue_approve_data',
            'nutrition_catalogue_approve_quality',
            'nutrition_catalogue_approve_rights'
          )
        )
      )
  ) <> expected_acl_count or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = approval_function
  ) <> expected_acl_count then
    raise exception 'catalogue approval function ACL is not the exact owner-and-reviewer policy'
      using errcode = '55000';
  end if;
end;
$migration$;

do $migration$
begin
  if exists (
    select 1
    from food_source_release_activation
    where database_principal is not null
      or database_capability_role is not null
  ) then
    raise notice
      'legacy activation authority evidence detected; the EXPAND audit constraint remains NOT VALID and readiness stays blocked pending a reviewed forward repair';
  else
    alter table food_source_release_activation
      validate constraint food_source_release_activation_expand_audit_null_check;
  end if;
end;
$migration$;

do $migration$
declare
  acl_grantee oid;
  acl_grantee_name name;
  function_owner oid;
  function_owner_name name;
  guard_function oid;
  target_schema name := current_schema();
begin
  select procedure_row.oid, procedure_row.proowner, owner_role.rolname
  into guard_function, function_owner, function_owner_name
  from pg_catalog.pg_proc as procedure_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  join pg_catalog.pg_roles as owner_role
    on owner_role.oid = procedure_row.proowner
  where namespace_row.nspname = target_schema
    and procedure_row.oid = pg_catalog.to_regprocedure(
      pg_catalog.format(
        '%I.guard_food_import_approval_authority()',
        target_schema
      )
    );

  if guard_function is null or function_owner_name is null then
    raise exception 'catalogue approval guard function is absent'
      using errcode = '42883';
  end if;

  execute pg_catalog.format(
    'revoke all on function %I.guard_food_import_approval_authority() from public',
    target_schema
  );
  for acl_grantee in
    select distinct acl.grantee
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = guard_function
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
      'revoke all on function %I.guard_food_import_approval_authority() from %I',
      target_schema,
      acl_grantee_name
    );
  end loop;
  execute pg_catalog.format(
    'grant execute on function %I.guard_food_import_approval_authority() to %I',
    target_schema,
    function_owner_name
  );

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = guard_function
      and acl.grantee = function_owner
      and acl.grantor = function_owner
      and acl.privilege_type = 'EXECUTE'
      and not acl.is_grantable
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
    where procedure_row.oid = guard_function
  ) <> 1 then
    raise exception 'catalogue approval guard function ACL is not the exact owner-only policy'
      using errcode = '55000';
  end if;
end;
$migration$;
