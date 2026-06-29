CREATE UNIQUE INDEX "rig_template_period_success_udx" ON "recurring_invoice_generations" ("template_id","period") WHERE invoice_id IS NOT NULL;
