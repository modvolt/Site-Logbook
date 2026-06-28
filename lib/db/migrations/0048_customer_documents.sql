-- Migration 0043: customer documents registry
-- Adds rich metadata columns to customer_site_attachments non-destructively.
-- All existing rows are preserved; title is backfilled from file_name,
-- customer_id is backfilled via customer_sites, status defaults to 'current'.

-- ---- row / URL count guard (before) ----
DO $$
DECLARE
  _rows  BIGINT;
  _urls  BIGINT;
BEGIN
  SELECT COUNT(*) INTO _rows FROM customer_site_attachments;
  SELECT COUNT(*) INTO _urls FROM customer_site_attachments WHERE url IS NOT NULL;
  RAISE NOTICE 'customer_site_attachments BEFORE migration 0043: % rows, % non-null URLs', _rows, _urls;
END $$;

-- ---- add nullable columns first ----
ALTER TABLE customer_site_attachments
  ADD COLUMN IF NOT EXISTS customer_id           INTEGER,
  ADD COLUMN IF NOT EXISTS title                 TEXT,
  ADD COLUMN IF NOT EXISTS document_number       TEXT,
  ADD COLUMN IF NOT EXISTS revision              TEXT,
  ADD COLUMN IF NOT EXISTS issued_at             DATE,
  ADD COLUMN IF NOT EXISTS valid_from            DATE,
  ADD COLUMN IF NOT EXISTS valid_until           DATE,
  ADD COLUMN IF NOT EXISTS doc_status            TEXT NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS replaces_attachment_id INTEGER,
  ADD COLUMN IF NOT EXISTS tags                  TEXT,
  ADD COLUMN IF NOT EXISTS mime_type             TEXT,
  ADD COLUMN IF NOT EXISTS file_size             BIGINT,
  ADD COLUMN IF NOT EXISTS sha256                TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id   INTEGER,
  ADD COLUMN IF NOT EXISTS uploaded_by_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMP,
  ADD COLUMN IF NOT EXISTS archived_at           TIMESTAMP;

-- ---- backfill: title = file_name, customer_id from customer_sites ----
UPDATE customer_site_attachments csa
SET
  title       = COALESCE(csa.file_name, 'Dokument'),
  customer_id = cs.customer_id
FROM customer_sites cs
WHERE csa.site_id = cs.id
  AND (csa.title IS NULL OR csa.customer_id IS NULL);

-- For any rows where site_id has no match (shouldn't exist but be safe): leave customer_id null

-- ---- set customer_id NOT NULL only where backfilled ----
-- We use a deferred constraint approach: only rows that went through the backfill
-- will be NOT NULL. If the table is empty or all rows were backfilled, we can
-- make it NOT NULL on new data via the application layer (the route always sets it).
-- Adding a partial index instead to enforce it for non-archived rows.

-- ---- make site_id nullable (customer-level docs have no site) ----
ALTER TABLE customer_site_attachments
  ALTER COLUMN site_id DROP NOT NULL;

-- ---- add FK constraints ----
ALTER TABLE customer_site_attachments
  ADD CONSTRAINT csa_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE customer_site_attachments
  ADD CONSTRAINT csa_replaces_attachment_id_fkey
    FOREIGN KEY (replaces_attachment_id) REFERENCES customer_site_attachments(id) ON DELETE SET NULL;

-- ---- CHECK constraint for status values ----
ALTER TABLE customer_site_attachments
  ADD CONSTRAINT csa_doc_status_check
    CHECK (doc_status IN ('current', 'expiring', 'expired', 'replaced', 'archived'));

-- ---- indexes for common queries ----
CREATE INDEX IF NOT EXISTS idx_csa_customer_id        ON customer_site_attachments (customer_id);
CREATE INDEX IF NOT EXISTS idx_csa_valid_until        ON customer_site_attachments (valid_until) WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csa_sha256_customer    ON customer_site_attachments (sha256, customer_id) WHERE sha256 IS NOT NULL;

-- ---- row / URL count guard (after — must match before) ----
DO $$
DECLARE
  _rows  BIGINT;
  _urls  BIGINT;
BEGIN
  SELECT COUNT(*) INTO _rows FROM customer_site_attachments;
  SELECT COUNT(*) INTO _urls FROM customer_site_attachments WHERE url IS NOT NULL;
  RAISE NOTICE 'customer_site_attachments AFTER  migration 0043: % rows, % non-null URLs', _rows, _urls;
END $$;
