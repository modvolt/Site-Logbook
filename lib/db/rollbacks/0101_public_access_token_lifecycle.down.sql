-- Application rollback is preferred. Dropping this table after any new,
-- revoked, consumed, or plaintext-cleaned credential would either restore
-- replay or make existing public links unrecoverable.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public_access_tokens
    WHERE legacy_imported_at IS NULL
       OR revoked_at IS NOT NULL
       OR consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '0101 rollback blocked: new, revoked, or consumed public token records exist; use roll-forward recovery';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public_access_tokens token
    WHERE NOT (
      (token.purpose = 'job_signature' AND EXISTS (
        SELECT 1 FROM jobs legacy
        WHERE legacy.id = token.resource_id
          AND legacy.signature_token IS NOT NULL
          AND encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex') = token.token_hash
      )) OR
      (token.purpose = 'ppe_signature' AND EXISTS (
        SELECT 1 FROM ppe_assignments legacy
        WHERE legacy.id = token.resource_id
          AND legacy.signature_token IS NOT NULL
          AND encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex') = token.token_hash
      )) OR
      (token.purpose = 'ppe_confirmation' AND EXISTS (
        SELECT 1 FROM ppe_assignments legacy
        WHERE legacy.id = token.resource_id
          AND legacy.confirm_token IS NOT NULL
          AND encode(sha256(convert_to(legacy.confirm_token, 'UTF8')), 'hex') = token.token_hash
      )) OR
      (token.purpose = 'quote_decision' AND EXISTS (
        SELECT 1 FROM quotes legacy
        WHERE legacy.id = token.resource_id
          AND legacy.share_token IS NOT NULL
          AND encode(sha256(convert_to(legacy.share_token, 'UTF8')), 'hex') = token.token_hash
      ))
    )
  ) THEN
    RAISE EXCEPTION
      '0101 rollback blocked: one or more hash records no longer have a recoverable legacy plaintext token';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "public_access_tokens";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383363000;

COMMIT;
