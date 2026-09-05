-- Expand the catalogue authority boundary without changing runtime credentials
-- or granting shared-table access. The schema owner retains an explicit
-- legacy/local compatibility path; production cutover is a later change.
-- Recovery is forward-only: restore the pre-migration database backup. Do not
-- attempt reverse DDL against partially upgraded authority state.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-capability-roles:v1')
);

do $migration$
declare
  capability_role text;
  capability_role_oid oid;
  target_schema name := current_schema();
begin
  foreach capability_role in array array[
    'nutrition_catalogue_stage',
    'nutrition_catalogue_validate',
    'nutrition_catalogue_approve_data',
    'nutrition_catalogue_approve_quality',
    'nutrition_catalogue_approve_rights',
    'nutrition_catalogue_promote_activate',
    'nutrition_catalogue_rollback'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_roles where rolname = capability_role
    ) then
      execute pg_catalog.format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
        capability_role
      );
    end if;

    select role_row.oid
    into capability_role_oid
    from pg_catalog.pg_roles as role_row
    where role_row.rolname = capability_role;

    if exists (
      select 1
      from pg_catalog.pg_roles as role_row
      where role_row.oid = capability_role_oid
        and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.member = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.roleid = capability_role_oid
        and membership.admin_option
    ) or exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = capability_role_oid
        and dependency.deptype = 'o'
    ) or exists (
      select 1
      from pg_catalog.pg_namespace as namespace_row
      cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as acl
      where namespace_row.nspname = target_schema
        and acl.grantee = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      cross join lateral pg_catalog.aclexplode(class_row.relacl) as acl
      where namespace_row.nspname = target_schema
        and acl.grantee = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
      where namespace_row.nspname = target_schema
        and acl.grantee = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_type as type_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = type_row.typnamespace
      cross join lateral pg_catalog.aclexplode(type_row.typacl) as acl
      where namespace_row.nspname = target_schema
        and acl.grantee = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_default_acl as default_acl
      left join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = default_acl.defaclnamespace
      where (default_acl.defaclnamespace = 0 or namespace_row.nspname = target_schema)
        and default_acl.defaclrole = capability_role_oid
    ) or exists (
      select 1
      from pg_catalog.pg_default_acl as default_acl
      left join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = default_acl.defaclnamespace
      cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) as acl
      where (default_acl.defaclnamespace = 0 or namespace_row.nspname = target_schema)
        and acl.grantee = capability_role_oid
    ) then
      raise exception 'catalogue capability role % has unsafe attributes, memberships, ownership, or target-schema privileges', capability_role
        using errcode = '55000';
    end if;
  end loop;
end;
$migration$;

alter table food_import_batch
  add column validation_digest text,
  add constraint food_import_batch_validation_digest_check check (
    validation_digest is null or validation_digest ~ '^[0-9a-f]{64}$'
  ),
  add constraint food_import_batch_validation_digest_requires_validation_check check (
    validation_digest is null or validated_at is not null
  );

do $migration$
begin
  if exists (
    select 1
    from food_import_batch
    where release_class = 'live-reviewed'
      and status in ('ready', 'promoting')
      and validation_digest is null
  ) then
    raise exception 'catalogue authority expansion found active live-reviewed batches without a frozen validation digest'
      using
        errcode = '55000',
        hint = 'Resolve the ready or promoting batches under the pre-0014 workflow before retrying; do not fabricate a validation digest.';
  end if;
end;
$migration$;

alter table food_import_approval
  add column database_principal text,
  add column database_capability_role text,
  add constraint food_import_approval_database_authority_check check (
    (database_principal is null and database_capability_role is null)
    or (
      database_principal is not null
      and octet_length(database_principal) between 1 and 63
      and database_capability_role is not null
      and database_capability_role = case approval_role
        when 'data' then 'nutrition_catalogue_approve_data'
        when 'quality' then 'nutrition_catalogue_approve_quality'
        when 'rights' then 'nutrition_catalogue_approve_rights'
      end
    )
  );

alter table food_source_release_activation
  add column database_principal text,
  add column database_capability_role text,
  add constraint food_source_release_activation_database_authority_check check (
    (database_principal is null and database_capability_role is null)
    or (
      database_principal is not null
      and octet_length(database_principal) between 1 and 63
      and database_capability_role is not null
      and database_capability_role = case operation
        when 'activate' then 'nutrition_catalogue_promote_activate'
        when 'deactivate' then 'nutrition_catalogue_rollback'
        when 'rollback' then 'nutrition_catalogue_rollback'
      end
    )
  );

create unique index food_import_approval_database_principal_unique
  on food_import_approval (batch_id, database_principal)
  where database_principal is not null;

comment on column food_import_batch.validation_digest is
  'Frozen digest of the post-validation evidence used by immutable approvals.';
comment on column food_import_approval.database_principal is
  'Authenticated PostgreSQL session_user; NULL only for pre-boundary or explicit owner/local approvals.';
comment on column food_import_approval.database_capability_role is
  'Exact reviewer capability derived from database role membership; paired with database_principal.';
comment on column food_source_release_activation.database_principal is
  'Authenticated PostgreSQL session_user for capability-mediated activation; legacy/local rows remain NULL.';
comment on column food_source_release_activation.database_capability_role is
  'Database capability used for activation or rollback; paired with database_principal.';

create function guard_food_import_batch_validation_digest()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.validation_digest is not null or new.validated_at is not null then
      raise exception 'new food import batch cannot begin with validation evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if (old.validated_at is not null or old.validation_digest is not null)
    and new.validation_digest is distinct from old.validation_digest then
    raise exception 'validated food import batch digest cannot be rewritten'
      using errcode = '55000';
  end if;

  if old.validated_at is null and new.validated_at is not null
    and (new.status not in ('quarantined', 'ready') or new.validation_digest is null) then
    raise exception 'food import batch validation must freeze its digest while becoming ready or quarantined'
      using errcode = '23514';
  end if;

  if old.status is distinct from new.status
    and new.status in ('completed', 'promoting', 'quarantined', 'ready')
    and new.validation_digest is null then
    raise exception 'food import batch status % requires a frozen validation digest', new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger food_import_batch_guard_validation_digest
before insert or update on food_import_batch
for each row execute function guard_food_import_batch_validation_digest();

create or replace function guard_food_import_approval_authority()
returns trigger
language plpgsql
as $$
declare
  batch food_import_batch%rowtype;
  expected_capability text;
  reviewer_capability_count integer;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_approval'::regclass;

  if current_user::text <> table_owner then
    raise exception 'direct non-owner food import approval insert is forbidden'
      using errcode = '42501';
  end if;

  if session_user::text = table_owner then
    if new.database_principal is not null or new.database_capability_role is not null then
      raise exception 'owner/local approval cannot claim database capability audit identity'
        using errcode = '42501';
    end if;
  else
    expected_capability := case new.approval_role
      when 'data' then 'nutrition_catalogue_approve_data'
      when 'quality' then 'nutrition_catalogue_approve_quality'
      when 'rights' then 'nutrition_catalogue_approve_rights'
    end;
    select pg_catalog.count(*)::integer
    into reviewer_capability_count
    from pg_catalog.unnest(array[
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if reviewer_capability_count <> 1
      or expected_capability is null
      or new.database_principal is distinct from session_user::text
      or new.database_capability_role is distinct from expected_capability
      or not pg_catalog.pg_has_role(session_user, expected_capability, 'member') then
      raise exception 'food import approval database authority does not match the authenticated reviewer'
        using errcode = '42501';
    end if;
  end if;

  select * into batch
  from food_import_batch
  where id = new.batch_id
  for update;
  if not found then
    raise exception 'food import approval references an unknown batch'
      using errcode = '23503';
  end if;
  if batch.release_class <> 'live-reviewed'
    or batch.evidence_bundle_sha256 is null
    or batch.evidence_bundle_uri is null
    or batch.evidence_decision_sha256 is null
    or batch.evidence_object_version_id is null
    or batch.evidence_valid_until is null
    or batch.evidence_valid_until <= pg_catalog.clock_timestamp() then
    raise exception 'food import approval requires current live-reviewed evidence'
      using errcode = '23514';
  end if;
  if batch.status <> 'ready' then
    raise exception 'food import approval requires a ready batch'
      using errcode = '55000';
  end if;
  if batch.validation_digest is null
    or new.validation_digest is distinct from batch.validation_digest then
    raise exception 'food import approval digest does not match the stored validation evidence'
      using errcode = '23514';
  end if;
  if new.rights_manifest_sha256 is distinct from batch.rights_manifest_sha256 then
    raise exception 'food import approval rights digest does not match the staged batch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create function catalogue_record_import_approval(
  p_batch_id uuid,
  p_requested_approval_role text,
  p_validation_digest text,
  p_rights_digest text,
  p_external_principal_id text,
  p_approval_reference text
)
returns boolean
language plpgsql
security definer
as $$
declare
  approval_inserted boolean;
  batch food_import_batch%rowtype;
  database_capability text;
  database_principal_name text;
  derived_approval_role text;
  existing_approval food_import_approval%rowtype;
  reviewer_capabilities text[];
  table_owner text;
begin
  if p_requested_approval_role is null
    or p_requested_approval_role not in ('data', 'quality', 'rights') then
    raise exception 'approval role must be data, quality, or rights'
      using errcode = '22023';
  end if;
  if p_validation_digest is null or p_validation_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'validation digest must be a lowercase SHA-256 digest'
      using errcode = '22023';
  end if;
  if p_rights_digest is null or p_rights_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'rights digest must be a lowercase SHA-256 digest'
      using errcode = '22023';
  end if;
  if p_external_principal_id is null
    or p_external_principal_id <> pg_catalog.btrim(p_external_principal_id)
    or p_external_principal_id <> pg_catalog.lower(p_external_principal_id)
    or p_external_principal_id !~ '^[a-z][-a-z0-9._:@/]{2,255}$' then
    raise exception 'external principal id is invalid'
      using errcode = '22023';
  end if;
  if p_approval_reference is null
    or pg_catalog.length(pg_catalog.btrim(p_approval_reference)) = 0 then
    raise exception 'approval reference is required'
      using errcode = '22023';
  end if;

  select pg_catalog.pg_get_userbyid(class_row.relowner)
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_approval'::regclass;
  if session_user::text = table_owner then
    database_capability := null;
    database_principal_name := null;
  else
    select pg_catalog.array_agg(candidate.capability_role order by candidate.capability_role)
    into reviewer_capabilities
    from pg_catalog.unnest(array[
      'nutrition_catalogue_approve_data',
      'nutrition_catalogue_approve_quality',
      'nutrition_catalogue_approve_rights'
    ]) as candidate(capability_role)
    where pg_catalog.pg_has_role(session_user, candidate.capability_role, 'member');
    if coalesce(pg_catalog.cardinality(reviewer_capabilities), 0) <> 1 then
      raise exception 'database principal must hold exactly one catalogue reviewer capability'
        using errcode = '42501';
    end if;
    database_capability := reviewer_capabilities[1];
    derived_approval_role := case database_capability
      when 'nutrition_catalogue_approve_data' then 'data'
      when 'nutrition_catalogue_approve_quality' then 'quality'
      when 'nutrition_catalogue_approve_rights' then 'rights'
    end;
    if derived_approval_role is distinct from p_requested_approval_role then
      raise exception 'requested approval role does not match authenticated reviewer capability'
        using errcode = '42501';
    end if;
    database_principal_name := session_user::text;
  end if;

  select * into batch
  from food_import_batch
  where id = p_batch_id
  for update;
  if not found then
    raise exception 'food import approval references an unknown batch'
      using errcode = '23503';
  end if;
  if batch.release_class <> 'live-reviewed'
    or batch.evidence_bundle_sha256 is null
    or batch.evidence_bundle_uri is null
    or batch.evidence_decision_sha256 is null
    or batch.evidence_object_version_id is null
    or batch.evidence_valid_until is null
    or batch.evidence_valid_until <= pg_catalog.clock_timestamp() then
    raise exception 'food import approval requires current live-reviewed evidence'
      using errcode = '23514';
  end if;
  if batch.status <> 'ready' then
    raise exception 'food import approval requires a ready batch'
      using errcode = '55000';
  end if;
  if batch.validation_digest is null
    or p_validation_digest is distinct from batch.validation_digest then
    raise exception 'food import approval digest does not match the stored validation evidence'
      using errcode = '23514';
  end if;
  if p_rights_digest is distinct from batch.rights_manifest_sha256 then
    raise exception 'food import approval rights digest does not match the staged batch'
      using errcode = '23514';
  end if;

  insert into food_import_approval (
    approval_reference, approval_role, batch_id, database_capability_role,
    database_principal, principal_id, rights_manifest_sha256, validation_digest
  ) values (
    p_approval_reference, p_requested_approval_role, p_batch_id, database_capability,
    database_principal_name, p_external_principal_id, p_rights_digest, p_validation_digest
  )
  on conflict do nothing
  returning true into approval_inserted;
  if coalesce(approval_inserted, false) then
    return true;
  end if;

  select * into existing_approval
  from food_import_approval
  where batch_id = p_batch_id
    and (approval_role = p_requested_approval_role or principal_id = p_external_principal_id)
  order by (approval_role = p_requested_approval_role) desc, id
  limit 1;
  if found
    and existing_approval.approval_role is not distinct from p_requested_approval_role
    and existing_approval.validation_digest is not distinct from p_validation_digest
    and existing_approval.rights_manifest_sha256 is not distinct from p_rights_digest
    and existing_approval.principal_id is not distinct from p_external_principal_id
    and existing_approval.approval_reference is not distinct from p_approval_reference
    and existing_approval.database_principal is not distinct from database_principal_name
    and existing_approval.database_capability_role is not distinct from database_capability then
    return false;
  end if;
  raise exception 'Batch % already has a different immutable approval', p_batch_id
    using errcode = '23505';
end;
$$;

do $migration$
declare
  authority_function text;
  target_schema name := current_schema();
  table_owner name;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner)::name
  into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_approval'::regclass;

  foreach authority_function in array array[
    'catalogue_evidence_bundle_uri_is_valid(text,text)',
    'guard_food_import_batch_update()',
    'guard_food_import_record_update()',
    'guard_food_source_release_update()',
    'reject_new_legacy_unbound_catalogue_evidence()',
    'guard_new_food_source_release_authority()',
    'guard_food_import_approval_authority()',
    'guard_food_source_active_release_authority()',
    'guard_food_source_release_legacy_promotion_grandfather()',
    'guard_food_import_batch_initial_state()',
    'guard_food_source_release_initial_state()',
    'guard_food_source_initial_active_release()',
    'guard_food_import_batch_validation_digest()',
    'catalogue_record_import_approval(uuid,text,text,text,text,text)'
  ] loop
    execute pg_catalog.format(
      'alter function %I.%s set search_path = pg_catalog, %I, pg_temp',
      target_schema, authority_function, target_schema
    );
  end loop;

  execute pg_catalog.format(
    'revoke all on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) from public',
    target_schema
  );
  execute pg_catalog.format(
    'grant execute on function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights',
    target_schema
  );
  execute pg_catalog.format(
    'grant usage on schema %I to nutrition_catalogue_approve_data, nutrition_catalogue_approve_quality, nutrition_catalogue_approve_rights',
    target_schema
  );
  execute pg_catalog.format(
    'alter function %I.catalogue_record_import_approval(uuid,text,text,text,text,text) owner to %I',
    target_schema, table_owner
  );
end;
$migration$;
