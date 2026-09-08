-- Admit only the source-verified U.S.–Canada adult 19–50 reference candidate.
-- Values remain server-owned and are reconciled as one immutable vector at commit.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('nutrition-tracker:reviewed-reference-targets:v1')
);

lock table nutrition_goal_version, nutrition_goal_target, nutrient in access exclusive mode;

do $migration$
begin
  if exists (
    select 1 from nutrition_goal_version
    where dri_reference_group_code is not null or dri_reference_version is not null
  ) then
    raise exception 'reference target migration requires the reserved identity columns to be empty'
      using errcode = '55000';
  end if;
  if exists (select 1 from nutrition_goal_target where metadata <> '{}'::jsonb) then
    raise exception 'reference target migration requires reserved target metadata to be empty'
      using errcode = '55000';
  end if;
end;
$migration$;

alter table nutrition_goal_version
  drop constraint nutrition_goal_version_reserved_fields_v2,
  add constraint nutrition_goal_version_reference_identity_v1 check ((
    exercise_budget_kcal is null
    and thermic_effect_kcal is null
    and (
      (
        dri_reference_group_code is null
        and dri_reference_version is null
        and not (assumptions ? 'referenceTargetSet')
      )
      or (
        dri_reference_group_code in ('male-19-50', 'female-19-50')
        and dri_reference_version = '1'
        and jsonb_typeof(assumptions -> 'referenceTargetSet') = 'object'
        and (assumptions -> 'referenceTargetSet') ?& array[
          'acknowledgement', 'ageYears', 'appliedProfileRevision',
          'eligibleThroughExclusive', 'groupCode', 'policyDigest',
          'sourceCode', 'sourceReviewedOn', 'sourceVersion',
          'templateCode', 'templateVersion'
        ]
        and (assumptions -> 'referenceTargetSet') - array[
          'acknowledgement', 'ageYears', 'appliedProfileRevision',
          'eligibleThroughExclusive', 'groupCode', 'policyDigest',
          'sourceCode', 'sourceReviewedOn', 'sourceVersion',
          'templateCode', 'templateVersion'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(assumptions #> '{referenceTargetSet,templateCode}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,templateVersion}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,groupCode}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,sourceCode}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,sourceVersion}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,sourceReviewedOn}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,policyDigest}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,ageYears}') = 'number'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,appliedProfileRevision}') = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,eligibleThroughExclusive}') = 'string'
        and assumptions #>> '{referenceTargetSet,templateCode}' = 'us-ca-dri-adults-19-50'
        and assumptions #>> '{referenceTargetSet,templateVersion}' = '1'
        and assumptions #>> '{referenceTargetSet,groupCode}' = dri_reference_group_code
        and assumptions #>> '{referenceTargetSet,sourceCode}' = 'health-canada-dri-tables'
        and assumptions #>> '{referenceTargetSet,sourceVersion}' = '2025-11-19'
        and assumptions #>> '{referenceTargetSet,sourceReviewedOn}' = '2026-09-07'
        and assumptions #>> '{referenceTargetSet,policyDigest}' = case dri_reference_group_code
          when 'male-19-50' then '4a1e050607e9bbaa20a4b67921fcbb9dbfa2c9bfd2393ac1a58d41cc3dc03def'
          when 'female-19-50' then '24c3747c2d0c2946d3dc071277935b9bc0e21c715e47952dbff5aedb96e99249'
        end
        and (assumptions #>> '{referenceTargetSet,ageYears}') ~ '^(19|[234][0-9]|50)$'
        and (assumptions #>> '{referenceTargetSet,appliedProfileRevision}') ~ '^(0|[1-9][0-9]{0,19})$'
        and (assumptions #>> '{referenceTargetSet,eligibleThroughExclusive}')
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and case
          when pg_catalog.pg_input_is_valid(
            assumptions #>> '{referenceTargetSet,eligibleThroughExclusive}', 'date'
          ) then (assumptions #>> '{referenceTargetSet,eligibleThroughExclusive}')::date
            > effective_from
          else false
        end
        and jsonb_typeof(assumptions #> '{referenceTargetSet,acknowledgement}') = 'object'
        and (assumptions #> '{referenceTargetSet,acknowledgement}') ?& array[
          'accepted', 'acceptedAt', 'policyCode', 'policyVersion'
        ]
        and (assumptions #> '{referenceTargetSet,acknowledgement}') - array[
          'accepted', 'acceptedAt', 'policyCode', 'policyVersion'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(assumptions #> '{referenceTargetSet,acknowledgement,accepted}')
          = 'boolean'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,acknowledgement,acceptedAt}')
          = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,acknowledgement,policyCode}')
          = 'string'
        and jsonb_typeof(assumptions #> '{referenceTargetSet,acknowledgement,policyVersion}')
          = 'string'
        and assumptions #> '{referenceTargetSet,acknowledgement,accepted}' = 'true'::jsonb
        and assumptions #>> '{referenceTargetSet,acknowledgement,policyCode}'
          = 'us-ca-dri-adults-19-50-eligibility-ack'
        and assumptions #>> '{referenceTargetSet,acknowledgement,policyVersion}' = '1'
        and assumptions #>> '{referenceTargetSet,acknowledgement,acceptedAt}'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        and pg_catalog.pg_input_is_valid(
          assumptions #>> '{referenceTargetSet,acknowledgement,acceptedAt}',
          'timestamp with time zone'
        )
      )
    )
  ) is true);

alter table nutrition_goal_target
  add constraint nutrition_goal_target_reference_metadata_v1 check ((
    metadata = '{}'::jsonb
    or (
      jsonb_typeof(metadata) = 'object'
      and metadata ?& array[
        'groupCode', 'maximumReferenceType', 'policyDigest', 'referenceType',
        'sourceRows', 'sourceTable', 'sourceUrl', 'templateCode',
        'templateVersion', 'timeBasis'
      ]
      and metadata - array[
        'groupCode', 'maximumReferenceType', 'policyDigest', 'referenceType',
        'sourceRows', 'sourceTable', 'sourceUrl', 'templateCode',
        'templateVersion', 'timeBasis'
      ]::text[] = '{}'::jsonb
      and jsonb_typeof(metadata -> 'templateCode') = 'string'
      and jsonb_typeof(metadata -> 'templateVersion') = 'string'
      and jsonb_typeof(metadata -> 'groupCode') = 'string'
      and jsonb_typeof(metadata -> 'policyDigest') = 'string'
      and jsonb_typeof(metadata -> 'timeBasis') = 'string'
      and jsonb_typeof(metadata -> 'referenceType') = 'string'
      and jsonb_typeof(metadata -> 'sourceTable') = 'string'
      and jsonb_typeof(metadata -> 'sourceUrl') = 'string'
      and metadata ->> 'templateCode' = 'us-ca-dri-adults-19-50'
      and metadata ->> 'templateVersion' = '1'
      and metadata ->> 'groupCode' in ('male-19-50', 'female-19-50')
      and metadata ->> 'policyDigest' = case metadata ->> 'groupCode'
        when 'male-19-50' then '4a1e050607e9bbaa20a4b67921fcbb9dbfa2c9bfd2393ac1a58d41cc3dc03def'
        when 'female-19-50' then '24c3747c2d0c2946d3dc071277935b9bc0e21c715e47952dbff5aedb96e99249'
      end
      and metadata ->> 'timeBasis' = 'usual-average-daily-intake'
      and metadata ->> 'referenceType' in ('rda', 'ai')
      and (metadata -> 'maximumReferenceType' = 'null'::jsonb
        or metadata ->> 'maximumReferenceType' = 'ul')
      and jsonb_typeof(metadata -> 'sourceRows') = 'array'
      and jsonb_array_length(metadata -> 'sourceRows') = 2
      and metadata ->> 'sourceUrl' like 'https://%'
    )
  ) is true);

create function reconcile_goal_reference_vector_v1()
returns trigger
language plpgsql
as $$
declare
  version_id uuid;
  version_row record;
  matching_count integer;
begin
  if tg_table_name = 'nutrition_goal_version' then
    version_id := new.id;
  else
    version_id := coalesce(new.nutrition_goal_version_id, old.nutrition_goal_version_id);
  end if;

  select dri_reference_group_code, dri_reference_version, target_count,
    assumptions #>> '{referenceTargetSet,policyDigest}' as policy_digest
  into version_row
  from nutrition_goal_version
  where id = version_id;
  if not found then return null; end if;

  if version_row.dri_reference_group_code is null then
    if exists (
      select 1 from nutrition_goal_target
      where nutrition_goal_version_id = version_id and metadata <> '{}'::jsonb
    ) then
      raise exception 'custom goal targets cannot claim reference provenance'
        using errcode = '23514';
    end if;
    return null;
  end if;

  if version_row.target_count <> 12 then
    raise exception 'reference goal must contain the complete 12-target vector'
      using errcode = '23514';
  end if;
  if version_row.policy_digest is null or version_row.policy_digest <> (
    case
      when version_row.dri_reference_group_code = 'male-19-50'
        then '4a1e050607e9bbaa20a4b67921fcbb9dbfa2c9bfd2393ac1a58d41cc3dc03def'
      when version_row.dri_reference_group_code = 'female-19-50'
        then '24c3747c2d0c2946d3dc071277935b9bc0e21c715e47952dbff5aedb96e99249'
      else null
    end
  ) then
    raise exception 'reference goal policy digest is missing or unsupported'
      using errcode = '23514';
  end if;

  with expected(
    group_code, code, unit, target_amount, maximum_amount, reference_type,
    maximum_reference_type, source_version, source_url, source_table, rationale
  ) as (
    values
      ('male-19-50','carbohydrate','g',130::numeric,null::numeric,'rda',null::text,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','protein','g',56,null,'rda',null,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','fiber','g',38,null,'ai',null,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('male-19-50','sodium','mg',1500,null,'ai',null,'HC-2025-11-19/NASEM-2019','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 3','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('male-19-50','potassium','mg',3400,null,'ai',null,'HC-2025-11-19/NASEM-2019','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 3','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('male-19-50','calcium','mg',1000,2500,'rda','ul','HC-2025-11-19/IOM-2011','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','iron','mg',8,45,'rda','ul','HC-2025-11-19/IOM-2001','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 2','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','vitamin-c','mg',90,2000,'rda','ul','HC-2025-11-19/IOM-2000','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 2','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','vitamin-d','ug',15,100,'rda','ul','HC-2025-11-19/IOM-2011','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','vitamin-b12','ug',2.4,null,'rda',null,'HC-2025-11-19/IOM-1998','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 3','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','folate-dfe','ug_DFE',400,null,'rda',null,'HC-2025-11-19/IOM-1998','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 3','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('male-19-50','vitamin-a-rae','ug_RAE',900,null,'rda',null,'HC-2025-11-19/IOM-2001','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','carbohydrate','g',130,null,'rda',null,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','protein','g',46,null,'rda',null,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','fiber','g',25,null,'ai',null,'HC-2025-11-19/IOM-2005','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-macronutrients.html','Table 1','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('female-19-50','sodium','mg',1500,null,'ai',null,'HC-2025-11-19/NASEM-2019','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 3','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('female-19-50','potassium','mg',2600,null,'ai',null,'HC-2025-11-19/NASEM-2019','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 3','Source-verified U.S.–Canada adult 19–50 AI population reference.'),
      ('female-19-50','calcium','mg',1000,2500,'rda','ul','HC-2025-11-19/IOM-2011','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','iron','mg',18,45,'rda','ul','HC-2025-11-19/IOM-2001','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-elements.html','Table 2','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','vitamin-c','mg',75,2000,'rda','ul','HC-2025-11-19/IOM-2000','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 2','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','vitamin-d','ug',15,100,'rda','ul','HC-2025-11-19/IOM-2011','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','vitamin-b12','ug',2.4,null,'rda',null,'HC-2025-11-19/IOM-1998','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 3','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','folate-dfe','ug_DFE',400,null,'rda',null,'HC-2025-11-19/IOM-1998','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 3','Source-verified U.S.–Canada adult 19–50 RDA population reference.'),
      ('female-19-50','vitamin-a-rae','ug_RAE',700,null,'rda',null,'HC-2025-11-19/IOM-2001','https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/reference-values-vitamins.html','Table 1','Source-verified U.S.–Canada adult 19–50 RDA population reference.')
  )
  select count(*) into matching_count
  from nutrition_goal_target target
  join nutrient definition on definition.id = target.nutrient_id
  join expected on expected.group_code = version_row.dri_reference_group_code
    and expected.code = definition.code
  where target.nutrition_goal_version_id = version_id
    and target.minimum_amount is null
    and target.target_amount = expected.target_amount
    and target.maximum_amount is not distinct from expected.maximum_amount
    and target.unit = expected.unit
    and target.target_source = 'Health Canada Dietary Reference Intakes'
    and target.target_source_version = expected.source_version
    and target.rationale = expected.rationale
    and target.metadata = pg_catalog.jsonb_build_object(
      'maximumReferenceType', expected.maximum_reference_type,
      'policyDigest', version_row.policy_digest,
      'referenceType', expected.reference_type,
      'sourceRows', case version_row.dri_reference_group_code
        when 'male-19-50' then pg_catalog.jsonb_build_array('Males 19–30 y', 'Males 31–50 y')
        else pg_catalog.jsonb_build_array('Females 19–30 y', 'Females 31–50 y')
      end,
      'sourceTable', expected.source_table,
      'sourceUrl', expected.source_url,
      'templateCode', 'us-ca-dri-adults-19-50',
      'templateVersion', '1',
      'groupCode', version_row.dri_reference_group_code,
      'timeBasis', 'usual-average-daily-intake'
    );

  if matching_count <> 12 then
    raise exception 'reference goal target vector or provenance does not match immutable policy'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

do $migration$
declare
  target_schema name := pg_catalog.current_schema();
begin
  if target_schema is null then
    raise exception 'reference target migration requires a current schema'
      using errcode = '55000';
  end if;
  execute pg_catalog.format(
    'alter function %I.reconcile_goal_reference_vector_v1() set search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
end;
$migration$;

create constraint trigger nutrition_goal_reference_vector_from_version_v1
after insert on nutrition_goal_version deferrable initially deferred
for each row execute function reconcile_goal_reference_vector_v1();

create constraint trigger nutrition_goal_reference_vector_from_target_v1
after insert or delete on nutrition_goal_target deferrable initially deferred
for each row execute function reconcile_goal_reference_vector_v1();
