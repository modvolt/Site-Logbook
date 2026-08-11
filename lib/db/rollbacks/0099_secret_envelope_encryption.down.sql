-- Application rollback is safe before any mve1 value or encrypted backup has
-- been written. Afterwards old application versions cannot read encrypted-only
-- values, so rollback must be roll-forward and the additive columns retained.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM device_credentials WHERE secret_ciphertext IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM email_settings WHERE password_ciphertext IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM email_import_settings WHERE password_ciphertext IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM openai_settings WHERE api_key_ciphertext IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM email_import_accounts WHERE refresh_token_key_id IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM switchboards WHERE qr_token_key_id IS NOT NULL LIMIT 1)
    OR EXISTS (SELECT 1 FROM backup_log WHERE encryption_format IS NOT NULL LIMIT 1)
  THEN
    RAISE EXCEPTION
      'Rollback 0099 blocked: encrypted-only data exists. Restore the required keyring and roll forward.';
  END IF;
END
$$;

ALTER TABLE backup_log DROP CONSTRAINT IF EXISTS backup_log_encryption_metadata_chk;
ALTER TABLE switchboards DROP CONSTRAINT IF EXISTS switchboards_qr_envelope_chk;
ALTER TABLE email_import_accounts DROP CONSTRAINT IF EXISTS email_import_accounts_refresh_envelope_chk;
ALTER TABLE openai_settings DROP CONSTRAINT IF EXISTS openai_settings_api_key_envelope_chk;
ALTER TABLE email_import_settings DROP CONSTRAINT IF EXISTS email_import_settings_password_envelope_chk;
ALTER TABLE email_settings DROP CONSTRAINT IF EXISTS email_settings_password_envelope_chk;
ALTER TABLE device_credentials DROP CONSTRAINT IF EXISTS device_credentials_secret_envelope_chk;

ALTER TABLE backup_log DROP COLUMN IF EXISTS encryption_key_id, DROP COLUMN IF EXISTS encryption_format;
ALTER TABLE switchboards DROP COLUMN IF EXISTS qr_token_encrypted_at, DROP COLUMN IF EXISTS qr_token_key_id;
ALTER TABLE email_import_accounts DROP COLUMN IF EXISTS refresh_token_encrypted_at, DROP COLUMN IF EXISTS refresh_token_key_id;
ALTER TABLE openai_settings DROP COLUMN IF EXISTS api_key_encrypted_at, DROP COLUMN IF EXISTS api_key_key_id, DROP COLUMN IF EXISTS api_key_ciphertext;
ALTER TABLE email_import_settings DROP COLUMN IF EXISTS password_encrypted_at, DROP COLUMN IF EXISTS password_key_id, DROP COLUMN IF EXISTS password_ciphertext;
ALTER TABLE email_settings DROP COLUMN IF EXISTS password_encrypted_at, DROP COLUMN IF EXISTS password_key_id, DROP COLUMN IF EXISTS password_ciphertext;
ALTER TABLE device_credentials DROP COLUMN IF EXISTS secret_encrypted_at, DROP COLUMN IF EXISTS secret_key_id, DROP COLUMN IF EXISTS secret_ciphertext;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383362000;

COMMIT;
