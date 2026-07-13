ALTER TABLE "switchboard_defects" ADD COLUMN "phase_key" text;--> statement-breakpoint
ALTER TABLE "switchboard_measurements" ADD COLUMN "phase_key" text;--> statement-breakpoint
ALTER TABLE "switchboard_photos" ADD COLUMN "phase_key" text;--> statement-breakpoint
ALTER TABLE "switchboard_photos" ADD COLUMN "checklist_item_key" text;--> statement-breakpoint
CREATE INDEX "switchboard_defects_board_status_idx" ON "switchboard_defects" USING btree ("switchboard_id","status","is_critical");--> statement-breakpoint
CREATE INDEX "switchboard_measurements_board_idx" ON "switchboard_measurements" USING btree ("switchboard_id","phase_key","measured_at");