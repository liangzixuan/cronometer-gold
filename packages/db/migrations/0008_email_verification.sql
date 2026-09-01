-- Bounded single-use email-verification credentials. Raw tokens are never
-- persisted; each row is bound to the account's current normalized email.

create table auth_action_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id) on delete cascade,
  purpose text not null check (purpose in ('email_verification')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null check (isfinite(expires_at)),
  consumed_at timestamptz check (consumed_at is null or isfinite(consumed_at)),
  created_at timestamptz not null,
  unique (user_id, purpose),
  check (isfinite(created_at)),
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at),
  check (consumed_at is null or consumed_at < expires_at)
);

create index auth_action_token_expiry_idx
  on auth_action_token (expires_at, id)
  where consumed_at is null;

comment on table auth_action_token is
  'Single-use credential digests; excluded from privacy exports and removed by account erasure.';
