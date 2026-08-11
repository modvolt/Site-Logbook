-- Safe only before the first authenticated external account is provisioned.
-- Once used, old application images cannot safely interpret external identity.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM external_accounts)
     OR EXISTS (SELECT 1 FROM external_account_scopes)
     OR EXISTS (SELECT 1 FROM external_account_events)
     OR EXISTS (SELECT 1 FROM users WHERE account_type = 'external') THEN
    RAISE EXCEPTION
      '0105 rollback blocked: authenticated external account state exists; use roll-forward recovery';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS user_permission_overrides_external_guard_trg ON user_permission_overrides;
DROP TRIGGER IF EXISTS users_external_identity_guard_trg ON users;
DROP TRIGGER IF EXISTS external_account_events_immutable_trg ON external_account_events;
DROP TRIGGER IF EXISTS external_account_scopes_no_delete_trg ON external_account_scopes;
DROP TRIGGER IF EXISTS external_accounts_no_delete_trg ON external_accounts;
DROP TRIGGER IF EXISTS external_account_scopes_validate_trg ON external_account_scopes;
DROP TRIGGER IF EXISTS external_accounts_validate_trg ON external_accounts;

DROP FUNCTION IF EXISTS reject_external_permission_override();
DROP FUNCTION IF EXISTS guard_external_identity_row();
DROP FUNCTION IF EXISTS deny_external_ledger_delete();
DROP FUNCTION IF EXISTS validate_external_account_scope_row();
DROP FUNCTION IF EXISTS validate_external_account_row();

DROP TABLE IF EXISTS external_account_events;
DROP TABLE IF EXISTS external_account_scopes;
DROP TABLE IF EXISTS external_accounts;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_external_identity_shape_chk;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_chk;
ALTER TABLE users DROP COLUMN IF EXISTS account_type;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383367000;

COMMIT;
