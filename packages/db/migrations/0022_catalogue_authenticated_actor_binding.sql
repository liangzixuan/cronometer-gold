-- Bind capability-mediated catalogue audit actors to PostgreSQL's authenticated
-- session identity. External runner identity remains an unverified assertion;
-- the schema-owner/local compatibility path therefore retains its caller label.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:catalogue-authenticated-actor-binding:v1')
);

-- Close the preflight race against approval, promotion, and rollback inserts.
-- Existing authority functions acquire their workflow rows before writing these
-- audit relations; this migration never takes a workflow-row lock afterward.
lock table food_import_approval, food_source_release_activation in access exclusive mode;

do $migration$
declare
  expected_acl_count integer;
  function_oid oid;
  function_spec record;
  migration_role oid;
  target_schema name := pg_catalog.current_schema();
  workflow_owner oid;
begin
  if target_schema is null then
    raise exception 'catalogue authenticated actor binding requires a current schema'
      using errcode = '55000';
  end if;

  select role_row.oid into migration_role
  from pg_catalog.pg_roles as role_row
  where role_row.rolname = current_user;

  select class_row.relowner into workflow_owner
  from pg_catalog.pg_class as class_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = target_schema
    and class_row.relname = 'food_import_approval'
    and class_row.relkind in ('r', 'p');

  if workflow_owner is null
    or workflow_owner is distinct from migration_role
    or workflow_owner is distinct from (
      select class_row.relowner
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      where namespace_row.nspname = target_schema
        and class_row.relname = 'food_import_batch'
        and class_row.relkind in ('r', 'p')
    )
    or workflow_owner is distinct from (
      select class_row.relowner
      from pg_catalog.pg_class as class_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = class_row.relnamespace
      where namespace_row.nspname = target_schema
        and class_row.relname = 'food_source_release_activation'
        and class_row.relkind in ('r', 'p')
    ) then
    raise exception 'catalogue authenticated actor migration must run as the workflow-table owner'
      using errcode = '42501';
  end if;

  if (
    select pg_catalog.count(*)
    from (
      values
        ('food_import_approval'::text, 'food_import_approval_database_authority_check'::text),
        (
          'food_source_release_activation',
          'food_source_release_activation_database_authority_check'
        )
    ) as expected(table_name, constraint_name)
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.nspname = target_schema
    join pg_catalog.pg_class as class_row
      on class_row.relnamespace = namespace_row.oid
      and class_row.relname = expected.table_name
      and class_row.relkind in ('r', 'p')
    join pg_catalog.pg_constraint as constraint_row
      on constraint_row.conrelid = class_row.oid
      and constraint_row.conname = expected.constraint_name
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and not constraint_row.condeferrable
      and not constraint_row.condeferred
  ) <> 2 then
    raise exception 'catalogue authenticated actor prerequisite constraints are absent or unsafe'
      using errcode = '55000';
  end if;

  for function_spec in
    select * from (values
      (
        'catalogue_record_import_approval(uuid,text,text,text,text,text)'::text,
        'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text'::text,
        'abb0ca990b74fedffd4ec77cf666e404da89af8158f4b990b6c0de48cd3dfc41'::text,
        'boolean'::text,
        'approve'::text
      ),
      (
        'catalogue_record_import_approval_v1(uuid,text,text,text,text,text)',
        'p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text',
        '89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac',
        'boolean',
        'owner'
      ),
      (
        'catalogue_promote_import_batch(uuid,text,text)',
        'p_batch_id uuid, p_external_principal_id text, p_reason text',
        '309861b6850a99bb565466981602ee19054b9c2500dfee21bf27edc6be382111',
        'jsonb',
        'promote'
      ),
      (
        'catalogue_promote_import_batch_v1(uuid,text,text)',
        'p_batch_id uuid, p_external_principal_id text, p_reason text',
        '115fdc3ed1943dd77ce70d3a694495da3d2c62ade9c7b82812a89cef82b39f17',
        'jsonb',
        'owner'
      ),
      (
        'catalogue_rollback_source_release(text,uuid,text,text)',
        'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text',
        '56e9fa2cce7f532c1f405658ff9f07908394d0fb9734b70d0bdb92a12292068a',
        'jsonb',
        'rollback'
      ),
      (
        'catalogue_rollback_source_release_v1(text,uuid,text,text)',
        'p_source_code text, p_target_release_id uuid, p_external_principal_id text, p_reason text',
        '3fe493ee5e0b27e43cc881854dddfe4dc12f862a1c4a242bf712c843b2792ff1',
        'jsonb',
        'owner'
      )
    ) as expected(
      function_identity,
      identity_arguments,
      source_sha256,
      result_type,
      acl_kind
    )
  loop
    function_oid := pg_catalog.to_regprocedure(
      pg_catalog.format('%I.%s', target_schema, function_spec.function_identity)
    );
    if function_oid is null or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_language as language_row
        on language_row.oid = procedure_row.prolang
      where procedure_row.oid = function_oid
        and (
          procedure_row.proowner is distinct from workflow_owner
          or procedure_row.prokind <> 'f'
          or not procedure_row.prosecdef
          or procedure_row.proretset
          or procedure_row.proisstrict
          or procedure_row.proleakproof
          or procedure_row.provolatile <> 'v'
          or procedure_row.proparallel <> 'u'
          or language_row.lanname <> 'plpgsql'
          or pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
            is distinct from function_spec.identity_arguments
          or pg_catalog.pg_get_function_result(procedure_row.oid)
            is distinct from function_spec.result_type
          or pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
            'hex'
          ) is distinct from function_spec.source_sha256
          or procedure_row.proconfig is distinct from array[
            'search_path=pg_catalog, ' || pg_catalog.quote_ident(target_schema) || ', pg_temp'
          ]::text[]
        )
    ) then
      raise exception 'catalogue authenticated actor prerequisite function % differs',
        function_spec.function_identity using errcode = '55000';
    end if;

    expected_acl_count := case function_spec.acl_kind
      when 'approve' then 4
      when 'promote' then 2
      when 'rollback' then 2
      else 1
    end;
    if (
      select pg_catalog.count(*)
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
      where procedure_row.oid = function_oid
    ) <> expected_acl_count or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as acl
      left join pg_catalog.pg_roles as grantee_role on grantee_role.oid = acl.grantee
      where procedure_row.oid = function_oid
        and (
          acl.privilege_type <> 'EXECUTE'
          or acl.grantor is distinct from workflow_owner
          or acl.is_grantable
          or not (
            acl.grantee = workflow_owner
            or (
              function_spec.acl_kind = 'approve'
              and grantee_role.rolname in (
                'nutrition_catalogue_approve_data',
                'nutrition_catalogue_approve_quality',
                'nutrition_catalogue_approve_rights'
              )
            )
            or (
              function_spec.acl_kind = 'promote'
              and grantee_role.rolname = 'nutrition_catalogue_promote_activate'
            )
            or (
              function_spec.acl_kind = 'rollback'
              and grantee_role.rolname = 'nutrition_catalogue_rollback'
            )
          )
        )
    ) then
      raise exception 'catalogue authenticated actor prerequisite function % has unsafe ACLs',
        function_spec.function_identity using errcode = '55000';
    end if;
  end loop;

  if exists (
    select 1
    from food_import_approval as approval
    where (approval.database_principal is null) <>
        (approval.database_capability_role is null)
      or (
        approval.database_principal is not null
        and approval.principal_id is distinct from approval.database_principal
      )
  ) or exists (
    select 1
    from food_source_release_activation as activation
    where (activation.database_principal is null) <>
        (activation.database_capability_role is null)
      or (
        activation.database_principal is not null
        and activation.performed_by is distinct from activation.database_principal
      )
  ) then
    raise exception 'catalogue authenticated actor binding found capability-mediated audit labels that differ from database principals'
      using
        errcode = '55000',
        hint = 'Preserve and adjudicate the historical audit rows; never rewrite or infer an authenticated actor.';
  end if;
end;
$migration$;

alter table food_import_approval
  drop constraint food_import_approval_database_authority_check,
  add constraint food_import_approval_database_authority_check check (
    (
      (
        database_principal is null
        and database_capability_role is null
      )
      or (
        database_principal is not null
        and principal_id = database_principal
        and pg_catalog.octet_length(database_principal) between 1 and 63
        and database_capability_role = case approval_role
          when 'data' then 'nutrition_catalogue_approve_data'
          when 'quality' then 'nutrition_catalogue_approve_quality'
          when 'rights' then 'nutrition_catalogue_approve_rights'
        end
      )
    ) is true
  );

alter table food_source_release_activation
  drop constraint food_source_release_activation_database_authority_check,
  add constraint food_source_release_activation_database_authority_check check (
    (
      (
        database_principal is null
        and database_capability_role is null
      )
      or (
        database_principal is not null
        and performed_by = database_principal
        and database_capability_role is not null
        and pg_catalog.octet_length(database_principal) between 1 and 63
        and database_capability_role = case
          when import_batch_id is not null and operation = 'activate'
            then 'nutrition_catalogue_promote_activate'
          when import_batch_id is null and operation in ('deactivate', 'rollback')
            then 'nutrition_catalogue_rollback'
        end
      )
    ) is true
  );

create or replace function catalogue_record_import_approval(
  p_batch_id uuid,
  p_requested_approval_role text,
  p_validation_digest text,
  p_rights_digest text,
  p_external_principal_id text,
  p_approval_reference text
)
returns boolean language plpgsql security definer as $$
declare
  effective_principal_id text;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner) into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_approval'::pg_catalog.regclass;
  if table_owner is null or current_user::text <> table_owner then
    raise exception 'catalogue approval function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  effective_principal_id := case
    when session_user::text = table_owner then p_external_principal_id
    else session_user::text
  end;
  if exists (select 1 from food_import_batch where id = p_batch_id) then
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = p_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue approval requires prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(p_batch_id);
  end if;
  return catalogue_record_import_approval_v1(
    p_batch_id, p_requested_approval_role, p_validation_digest, p_rights_digest,
    effective_principal_id, p_approval_reference
  );
end;
$$;

create or replace function catalogue_promote_import_batch(
  p_batch_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb language plpgsql security definer as $$
declare
  effective_principal_id text;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner) into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_import_batch'::pg_catalog.regclass;
  if table_owner is null or current_user::text <> table_owner then
    raise exception 'catalogue promotion function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  effective_principal_id := case
    when session_user::text = table_owner then p_external_principal_id
    else session_user::text
  end;
  if exists (select 1 from food_import_batch where id = p_batch_id) then
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = p_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue promotion requires prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(p_batch_id);
  end if;
  return catalogue_promote_import_batch_v1(p_batch_id, effective_principal_id, p_reason);
end;
$$;

create or replace function catalogue_rollback_source_release(
  p_source_code text,
  p_target_release_id uuid,
  p_external_principal_id text,
  p_reason text
)
returns jsonb language plpgsql security definer as $$
declare
  attested_origin_count bigint;
  effective_principal_id text;
  origin_batch_id uuid;
  table_owner text;
begin
  select pg_catalog.pg_get_userbyid(class_row.relowner) into table_owner
  from pg_catalog.pg_class as class_row
  where class_row.oid = 'food_source_release_activation'::pg_catalog.regclass;
  if table_owner is null or current_user::text <> table_owner then
    raise exception 'catalogue rollback function owner does not match the workflow owner'
      using errcode = '42501';
  end if;
  effective_principal_id := case
    when session_user::text = table_owner then p_external_principal_id
    else session_user::text
  end;
  if p_target_release_id is not null and exists (
    select 1 from food_source_release as release
    join food_source as source on source.id = release.food_source_id
    where release.id = p_target_release_id and source.code = p_source_code
  ) then
    select pg_catalog.count(*), pg_catalog.min(batch.id::text)::uuid
    into attested_origin_count, origin_batch_id
    from food_source_release as release
    join food_source as source on source.id = release.food_source_id
    join food_source_release_activation as activation
      on activation.release_id = release.id
      and activation.food_source_id = release.food_source_id
      and activation.operation = 'activate'
      and activation.import_batch_id is not null
    join food_import_batch as batch
      on batch.id = activation.import_batch_id
      and batch.food_source_id = release.food_source_id
      and batch.release_id = release.id
    where release.id = p_target_release_id
      and source.code = p_source_code
      and batch.status = 'completed';
    if attested_origin_count <> 1 then
      raise exception 'catalogue rollback target lacks one completed nutrition semantic attestation'
        using errcode = '55000';
    end if;
    if not exists (
      select 1 from food_import_batch as batch
      where batch.id = origin_batch_id
        and batch.nutrition_semantic_contract_version = 1
        and batch.nutrition_semantic_sha256 ~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'catalogue rollback target lacks prior nutrition semantic attestation'
        using errcode = '55000';
    end if;
    perform catalogue_attest_import_nutrition_semantics(origin_batch_id);
  end if;
  return catalogue_rollback_source_release_v1(
    p_source_code, p_target_release_id, effective_principal_id, p_reason
  );
end;
$$;

-- CREATE OR REPLACE must not be allowed to leave a definer function with an
-- ambient namespace. Re-pin all three public entrypoints to this migration's
-- attested schema; ownership and ACLs were checked before replacement and are
-- preserved by PostgreSQL replacement semantics.
do $migration$
declare
  function_identity text;
  target_schema name := pg_catalog.current_schema();
begin
  foreach function_identity in array array[
    'catalogue_record_import_approval(uuid,text,text,text,text,text)',
    'catalogue_promote_import_batch(uuid,text,text)',
    'catalogue_rollback_source_release(text,uuid,text,text)'
  ] loop
    execute pg_catalog.format(
      'alter function %I.%s set search_path = pg_catalog, %I, pg_temp',
      target_schema,
      function_identity,
      target_schema
    );
  end loop;
end;
$migration$;

comment on column food_import_approval.principal_id is
  'Authenticated PostgreSQL session_user for capability-mediated approvals; caller-supplied owner/local label otherwise.';
comment on column food_source_release_activation.performed_by is
  'Authenticated PostgreSQL session_user for capability-mediated activation or rollback; caller-supplied owner/local label otherwise.';
