-- Add one global, owner-bound idempotency record for full-day atomic reorders.
-- Reorders remain anchored to the lexicographically first participating entry so
-- the established export and account-erasure cascades continue to cover them.

do $$
begin
  if exists (
    select 1
    from diary_operation operation_record
    left join diary_entry entry
      on entry.id = operation_record.diary_entry_id
     and entry.user_id = operation_record.user_id
    where entry.id is null
  ) then
    raise exception '0024 diary operation owner binding blocked: mismatched operation owner'
      using errcode = 'P0001';
  end if;
end;
$$;

alter table diary_entry
  add constraint diary_entry_id_user_unique unique (id, user_id);

alter table diary_operation
  drop constraint diary_operation_operation_check,
  add constraint diary_operation_operation_check
    check (operation in ('create', 'update', 'delete', 'reorder')),
  drop constraint diary_operation_diary_entry_id_fkey,
  add constraint diary_operation_diary_entry_id_fkey
    foreign key (diary_entry_id, user_id)
    references diary_entry(id, user_id)
    on delete cascade;

comment on column diary_operation.diary_entry_id is
  'Mutation subject; full-day reorder records use the lexicographically first participating entry as a deterministic cascade anchor.';
