-- Migration 0047: recurring invoice templates (paušální faktury)
-- Adds a new table for recurring invoice templates and a nullable FK on invoices.

CREATE TABLE IF NOT EXISTS recurring_invoice_templates (
  id                    SERIAL PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  items                 JSONB NOT NULL DEFAULT '[]',
  interval              TEXT NOT NULL DEFAULT 'monthly',
  day_of_month          INTEGER NOT NULL DEFAULT 1,
  next_generation_date  TEXT NOT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  last_generated_at     TIMESTAMP,
  notes                 TEXT,
  vat_mode_default      TEXT NOT NULL DEFAULT 'standard',
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rit_customer_id_idx ON recurring_invoice_templates(customer_id);
CREATE INDEX IF NOT EXISTS rit_next_generation_date_idx ON recurring_invoice_templates(next_generation_date);
CREATE INDEX IF NOT EXISTS rit_is_active_idx ON recurring_invoice_templates(is_active);

-- Deduplication guard: templateId + billing period must be unique
CREATE TABLE IF NOT EXISTS recurring_invoice_generations (
  id            SERIAL PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES recurring_invoice_templates(id) ON DELETE CASCADE,
  invoice_id    INTEGER NOT NULL,
  period        TEXT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rig_template_id_idx ON recurring_invoice_generations(template_id);
CREATE UNIQUE INDEX IF NOT EXISTS rig_template_period_unique ON recurring_invoice_generations(template_id, period);

-- Add nullable FK to invoices table
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS recurring_template_id INTEGER REFERENCES recurring_invoice_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS invoices_recurring_template_id_idx ON invoices(recurring_template_id) WHERE recurring_template_id IS NOT NULL;
