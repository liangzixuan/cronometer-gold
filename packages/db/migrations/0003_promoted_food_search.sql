-- Fail-closed read model for rebuilding external food-search indexes and for
-- PostgreSQL degraded-mode lookup. Historical catalogue rows remain immutable;
-- eligibility is derived from the current, reviewed source-release pointers.

create view promoted_food_search_catalogue_v1 as
select
  food.id as food_id,
  version.id as food_version_id,
  version.version_number,
  food.kind,
  food.source_food_key,
  version.name,
  version.normalized_name,
  version.brand_name,
  version.description,
  version.language_tag,
  version.market_code,
  version.data_quality,
  version.basis_quantity,
  version.basis_unit,
  version.source_modified_at,
  source.id as food_source_id,
  source.code as source_code,
  source.display_name as source_display_name,
  source.license_expression,
  source.attribution_required,
  source.attribution_text,
  release.id as source_release_id,
  release.release_key as source_release_key,
  release.artifact_sha256 as source_artifact_sha256
from food
join food_version as version
  on version.food_id = food.id
  and version.id = food.current_version_id
join food_source as source
  on source.id = food.food_source_id
  and source.active_release_id = version.source_release_id
join food_source_release as release
  on release.id = source.active_release_id
  and release.food_source_id = source.id
where food.kind in ('generic', 'branded')
  and food.visibility = 'public'
  and food.owner_user_id is null
  and food.archived_at is null
  and version.data_quality <> 'quarantined'
  and octet_length(version.name) <= 500
  and octet_length(version.normalized_name) <= 512
  and (
    version.brand_name is null
    or (char_length(btrim(version.brand_name)) > 0 and octet_length(version.brand_name) <= 300)
  )
  and version.source_release_id is not null
  and source.active
  and source.code ~ '^[A-Z][A-Z0-9_]{1,31}$'
  and char_length(btrim(source.display_name)) > 0
  and octet_length(source.display_name) <= 200
  and char_length(btrim(source.license_expression)) > 0
  and octet_length(source.license_expression) <= 256
  and char_length(btrim(source.attribution_text)) > 0
  and octet_length(source.attribution_text) <= 2000
  and source.commercial_use_allowed is true
  and source.redistribution_allowed is true
  and source.rights_review_status in ('approved', 'restricted')
  and source.rights_reviewed_at is not null
  and length(btrim(source.rights_reviewed_by)) > 0
  and release.status = 'promoted'
  and release.promoted_at is not null
  and release.rights_manifest_sha256 is not null
  and exists (
    select 1
    from food_import_batch as batch
    join food_import_record as record
      on record.batch_id = batch.id
      and record.food_version_id = version.id
      and record.validation_status = 'materialized'
    where batch.food_source_id = source.id
      and batch.release_id = release.id
      and batch.status = 'completed'
      and batch.completed_at is not null
  );

create index food_import_record_materialized_version_idx
  on food_import_record (food_version_id, batch_id)
  where validation_status = 'materialized';

-- This expression matches the degraded-mode query exactly. The existing name-
-- only trigram index remains useful for simpler catalogue queries.
create index food_version_search_text_trgm_idx
  on food_version using gin (
    (lower(normalized_name || ' ' || coalesce(brand_name, ''))) gin_trgm_ops
  )
  where source_release_id is not null and data_quality <> 'quarantined';

-- GTIN-8/12/13 are the same identity as their zero-padded GTIN-14 form. Keep
-- that identity unique for every current market mapping; raw-text uniqueness
-- would allow a UPC-A and its zero-padded GTIN-14 to point at different foods.
drop index food_barcode_current_market_unique;

create unique index food_barcode_current_market_unique
  on food_barcode ((lpad(gtin, 14, '0')), market_code)
  where valid_to is null;

-- Cover the additional provenance columns used by exact promoted lookup.
create index food_barcode_gtin14_market_current_idx
  on food_barcode ((lpad(gtin, 14, '0')), market_code, food_id, food_version_id)
  include (source_release_id, food_serving_id)
  where valid_to is null and source_release_id is not null;

-- Search rebuild delivery is at-least-once. A terminal failure remains visible
-- for operators instead of being misrepresented as a published event.
alter table outbox_event
  add column dead_lettered_at timestamptz,
  add constraint outbox_event_single_terminal_state
    check (published_at is null or dead_lettered_at is null),
  add constraint outbox_event_dead_letter_evidence
    check (
      dead_lettered_at is null
      or (last_error is not null and locked_at is null and locked_by is null)
    );

create index food_search_rebuild_outbox_pending_idx
  on outbox_event (available_at, occurred_at, id)
  where event_type = 'catalogue.source_release_activated'
    and published_at is null
    and dead_lettered_at is null;

create table food_search_projection_revision (
  singleton boolean primary key default true check (singleton),
  current_revision bigint not null default 0 check (current_revision >= 0),
  published_revision bigint check (published_revision is null or published_revision >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into food_search_projection_revision (singleton) values (true);

create function advance_food_search_projection_revision()
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('nutrition-tracker:food-search-rebuild:v1'));
  update food_search_projection_revision
  set current_revision = current_revision + 1, updated_at = clock_timestamp()
  where singleton;
  if not found then
    raise exception 'food-search projection revision singleton is missing';
  end if;
end;
$$;

-- Search eligibility is partly controlled outside source-release activation.
-- Enqueue a full rebuild whenever reviewed distribution rights are changed so
-- a revoked source cannot remain in the disposable external index.
create function enqueue_food_search_source_eligibility_change()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.active,
    new.active_release_id,
    new.code,
    new.display_name,
    new.license_expression,
    new.attribution_required,
    new.attribution_text,
    new.commercial_use_allowed,
    new.redistribution_allowed,
    new.rights_review_status,
    new.rights_reviewed_at,
    new.rights_reviewed_by
  ) is distinct from row(
    old.active,
    old.active_release_id,
    old.code,
    old.display_name,
    old.license_expression,
    old.attribution_required,
    old.attribution_text,
    old.commercial_use_allowed,
    old.redistribution_allowed,
    old.rights_review_status,
    old.rights_reviewed_at,
    old.rights_reviewed_by
  ) then
    perform advance_food_search_projection_revision();
    insert into outbox_event (
      aggregate_type,
      aggregate_id,
      event_type,
      deduplication_key,
      payload
    ) values (
      'food_source',
      new.id::text,
      'catalogue.source_release_activated',
      'search-source-eligibility:' || gen_random_uuid()::text,
      jsonb_build_object(
        'reason', 'source_eligibility_changed',
        'sourceId', new.id::text
      )
    );
  end if;
  return new;
end;
$$;

create trigger food_source_search_eligibility_outbox
after update of
  active,
  active_release_id,
  code,
  display_name,
  license_expression,
  attribution_required,
  attribution_text,
  commercial_use_allowed,
  redistribution_allowed,
  rights_review_status,
  rights_reviewed_at,
  rights_reviewed_by
on food_source
for each row execute function enqueue_food_search_source_eligibility_change();

-- Coalesce food eligibility changes per source and SQL statement. Catalogue
-- activation may update millions of current-version pointers in one statement;
-- this trigger emits one event per affected source rather than one per food.
create function enqueue_food_search_food_eligibility_change()
returns trigger
language plpgsql
as $$
declare
  inserted_count integer;
begin
  insert into outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    deduplication_key,
    payload
  )
  select
      'food_source',
      changed.food_source_id::text,
      'catalogue.source_release_activated',
      'search-food-archive:' || gen_random_uuid()::text,
      jsonb_build_object(
        'reason', 'food_eligibility_changed',
        'sourceId', changed.food_source_id::text
      )
  from (
    with changed_rows as materialized (
      select
        old_rows.food_source_id as old_food_source_id,
        new_rows.food_source_id as new_food_source_id
      from old_food_search_rows as old_rows
      join new_food_search_rows as new_rows using (id)
      where row(
        old_rows.kind,
        old_rows.food_source_id,
        old_rows.owner_user_id,
        old_rows.visibility,
        old_rows.current_version_id,
        old_rows.archived_at
      ) is distinct from row(
        new_rows.kind,
        new_rows.food_source_id,
        new_rows.owner_user_id,
        new_rows.visibility,
        new_rows.current_version_id,
        new_rows.archived_at
      )
    )
    select old_food_source_id as food_source_id from changed_rows
    union
    select new_food_source_id as food_source_id from changed_rows
  ) as changed
  where changed.food_source_id is not null;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    perform advance_food_search_projection_revision();
  end if;
  return null;
end;
$$;

create trigger food_search_eligibility_outbox
after update on food
referencing old table as old_food_search_rows new table as new_food_search_rows
for each statement execute function enqueue_food_search_food_eligibility_change();

-- Imported child rows are immutable after insertion (except that a barcode can
-- be closed). Inserts normally happen before release activation and therefore
-- do not invalidate search. If an operator changes children of a live version,
-- publish a new projection revision and rebuild instead of letting barcodes or
-- serving labels drift indefinitely in the external index.
create function enqueue_food_search_serving_insert()
returns trigger
language plpgsql
as $$
declare
  inserted_count integer;
begin
  insert into outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    deduplication_key,
    payload
  )
  select
    'food_source',
    changed.food_source_id::text,
    'catalogue.source_release_activated',
    'search-serving-insert:' || gen_random_uuid()::text,
    jsonb_build_object(
      'reason', 'serving_inserted_for_current_version',
      'sourceId', changed.food_source_id::text
    )
  from (
    select distinct food.food_source_id
    from new_food_search_servings as serving
    join food_version as version on version.id = serving.food_version_id
    join food on food.id = version.food_id and food.current_version_id = version.id
    join food_source as source
      on source.id = food.food_source_id
      and source.active_release_id = version.source_release_id
  ) as changed
  where changed.food_source_id is not null;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    perform advance_food_search_projection_revision();
  end if;
  return null;
end;
$$;

create trigger food_search_serving_insert_outbox
after insert on food_serving
referencing new table as new_food_search_servings
for each statement execute function enqueue_food_search_serving_insert();

create function enqueue_food_search_barcode_insert()
returns trigger
language plpgsql
as $$
declare
  inserted_count integer;
begin
  insert into outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    deduplication_key,
    payload
  )
  select
    'food_source',
    changed.food_source_id::text,
    'catalogue.source_release_activated',
    'search-barcode-insert:' || gen_random_uuid()::text,
    jsonb_build_object(
      'reason', 'barcode_inserted_for_current_version',
      'sourceId', changed.food_source_id::text
    )
  from (
    select distinct food.food_source_id
    from new_food_search_barcodes as barcode
    join food_version as version on version.id = barcode.food_version_id
    join food on food.id = version.food_id and food.current_version_id = version.id
    join food_source as source
      on source.id = food.food_source_id
      and source.active_release_id = version.source_release_id
    where barcode.valid_to is null
  ) as changed
  where changed.food_source_id is not null;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    perform advance_food_search_projection_revision();
  end if;
  return null;
end;
$$;

create trigger food_search_barcode_insert_outbox
after insert on food_barcode
referencing new table as new_food_search_barcodes
for each statement execute function enqueue_food_search_barcode_insert();

create function enqueue_food_search_barcode_update()
returns trigger
language plpgsql
as $$
declare
  inserted_count integer;
begin
  insert into outbox_event (
    aggregate_type,
    aggregate_id,
    event_type,
    deduplication_key,
    payload
  )
  select
    'food_source',
    changed.food_source_id::text,
    'catalogue.source_release_activated',
    'search-barcode-close:' || gen_random_uuid()::text,
    jsonb_build_object(
      'reason', 'barcode_closed_for_current_version',
      'sourceId', changed.food_source_id::text
    )
  from (
    select distinct food.food_source_id
    from old_food_search_barcodes as old_barcode
    join new_food_search_barcodes as new_barcode using (id)
    join food_version as version on version.id = new_barcode.food_version_id
    join food on food.id = version.food_id and food.current_version_id = version.id
    join food_source as source
      on source.id = food.food_source_id
      and source.active_release_id = version.source_release_id
    where old_barcode.valid_to is null and new_barcode.valid_to is not null
  ) as changed
  where changed.food_source_id is not null;
  get diagnostics inserted_count = row_count;
  if inserted_count > 0 then
    perform advance_food_search_projection_revision();
  end if;
  return null;
end;
$$;

create trigger food_search_barcode_update_outbox
after update on food_barcode
referencing old table as old_food_search_barcodes new table as new_food_search_barcodes
for each statement execute function enqueue_food_search_barcode_update();
