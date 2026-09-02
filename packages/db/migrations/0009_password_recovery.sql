-- Extend the bounded digest-only action credential table for password recovery.
-- Existing email-verification rows and invariants remain unchanged.

alter table auth_action_token
  drop constraint auth_action_token_purpose_check,
  add constraint auth_action_token_purpose_check
    check (purpose in ('email_verification', 'password_recovery'));

comment on table auth_action_token is
  'Single-use email-verification and password-recovery credential digests; excluded from privacy exports and removed by account erasure.';
