-- Price reports can be withdrawn by their reporter, with a reason, and stay on record.
-- Additive only: every existing report stays live, keeps its values and counts as entered
-- on the website, which is the only source the ledger could tell apart before this column.
ALTER TABLE price_observations ADD COLUMN withdrawn_at TEXT;
-- statement-breakpoint
ALTER TABLE price_observations ADD COLUMN withdrawn_reason TEXT;
-- statement-breakpoint
ALTER TABLE price_observations ADD COLUMN correction_reason TEXT;
-- statement-breakpoint
ALTER TABLE price_observations ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'web' CHECK (entry_source IN ('web', 'mcp'));
-- statement-breakpoint
-- A report has at most one successor. Before this ships, the owner checks production for any
-- report corrected twice, which would stop this index from being created.
CREATE UNIQUE INDEX IF NOT EXISTS price_observations_one_successor ON price_observations(corrected_from_id) WHERE corrected_from_id IS NOT NULL;
-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS price_observations_no_delete BEFORE DELETE ON price_observations
BEGIN SELECT RAISE(ABORT, 'Price reports are kept on record'); END;
-- statement-breakpoint
-- The only changes a report takes: it is corrected once, or withdrawn once with a reason, and
-- never both. Every other column keeps the value it was written with.
CREATE TRIGGER IF NOT EXISTS price_observations_append_only BEFORE UPDATE ON price_observations
WHEN NEW.id IS NOT OLD.id
  OR NEW.restaurant_id IS NOT OLD.restaurant_id
  OR NEW.item_name IS NOT OLD.item_name
  OR NEW.price_cents IS NOT OLD.price_cents
  OR NEW.currency IS NOT OLD.currency
  OR NEW.visit_date IS NOT OLD.visit_date
  OR NEW.visit_date_precision IS NOT OLD.visit_date_precision
  OR NEW.reporter_id IS NOT OLD.reporter_id
  OR NEW.reported_at IS NOT OLD.reported_at
  OR NEW.note IS NOT OLD.note
  OR NEW.corrected_from_id IS NOT OLD.corrected_from_id
  OR NEW.correction_reason IS NOT OLD.correction_reason
  OR NEW.entry_source IS NOT OLD.entry_source
  OR (OLD.corrected_at IS NOT NULL AND NEW.corrected_at IS NOT OLD.corrected_at)
  OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NOT OLD.withdrawn_at)
  OR (OLD.withdrawn_reason IS NOT NULL AND NEW.withdrawn_reason IS NOT OLD.withdrawn_reason)
  OR ((NEW.withdrawn_at IS NULL) <> (NEW.withdrawn_reason IS NULL))
  OR (NEW.corrected_at IS NOT NULL AND NEW.withdrawn_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Price reports are append-only'); END;
