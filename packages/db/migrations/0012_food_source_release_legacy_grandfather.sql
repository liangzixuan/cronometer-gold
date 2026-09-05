-- Replace 0011's temporary unvalidated promoted-release constraint with an
-- explicit, immutable marker for releases that were already promoted before
-- acquisition-evidence binding existed. The marker records migration lineage,
-- never evidence or a new grant of release authority.
-- Recovery is forward-only: restore the pre-migration database backup to roll
-- back. Never copy the marker to another release or infer acquisition evidence
-- from it.

alter table food_source_release
  add column legacy_promotion_grandfathered_at timestamptz;

-- 0011 blocks every new legacy-unbound insert and promotion. While this
-- transaction holds the table lock, remove its temporary constraint and pause
-- the immutable-row trigger only long enough to mark the exact promoted legacy
-- rows that predate evidence binding.
alter table food_source_release
  drop constraint food_source_release_promoted_authority_check;

alter table food_source_release
  disable trigger food_source_release_guard_update;

update food_source_release
set legacy_promotion_grandfathered_at = transaction_timestamp()
where release_class = 'legacy-unbound'
  and status = 'promoted';

alter table food_source_release
  enable trigger food_source_release_guard_update;

alter table food_source_release
  add constraint food_source_release_legacy_promotion_grandfather_check check (
    legacy_promotion_grandfathered_at is null
    or (
      release_class = 'legacy-unbound'
      and status = 'promoted'
      and legacy_promotion_grandfathered_at not in (
        '-infinity'::timestamptz,
        'infinity'::timestamptz
      )
    )
  ),
  add constraint food_source_release_promoted_authority_check check (
    status <> 'promoted'
    or release_class = 'live-reviewed'
    or (
      release_class = 'legacy-unbound'
      and legacy_promotion_grandfathered_at is not null
    )
  );

create function guard_food_source_release_legacy_promotion_grandfather()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and new.legacy_promotion_grandfathered_at is not null then
    raise exception 'legacy promotion grandfather marker is migration-owned and immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
    and new.legacy_promotion_grandfathered_at
      is distinct from old.legacy_promotion_grandfathered_at then
    raise exception 'legacy promotion grandfather marker is migration-owned and immutable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger food_source_release_guard_legacy_grandfather_insert
before insert on food_source_release
for each row execute function guard_food_source_release_legacy_promotion_grandfather();

create trigger food_source_release_guard_legacy_grandfather_update
before update of legacy_promotion_grandfathered_at on food_source_release
for each row execute function guard_food_source_release_legacy_promotion_grandfather();
