CREATE TABLE IF NOT EXISTS bet_entry_source_inferences (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id),
  original_created_at TEXT NOT NULL,
  entry_source TEXT NOT NULL CHECK(entry_source = 'browser'),
  basis TEXT NOT NULL CHECK(basis = 'before_cli_release'),
  cutoff_at TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  inferred_at TEXT NOT NULL
);

-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entry_source_inferences_no_update
BEFORE UPDATE ON bet_entry_source_inferences
BEGIN SELECT RAISE(ABORT, 'Entry source inference provenance is immutable'); END;

-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entry_source_inferences_no_delete
BEFORE DELETE ON bet_entry_source_inferences
BEGIN SELECT RAISE(ABORT, 'Entry source inference provenance is immutable'); END;

-- statement-breakpoint
CREATE VIEW IF NOT EXISTS bet_records AS
SELECT b.id, b.created_at,
  CASE WHEN i.bet_id IS NOT NULL AND json_extract(b.data, '$.entrySource') IS NULL
    THEN json_set(b.data, '$.entrySource', i.entry_source,
      '$.entrySourceInference', json_object(
        'basis', i.basis, 'cutoffAt', i.cutoff_at,
        'evidenceUrl', i.evidence_url, 'inferredAt', i.inferred_at))
    ELSE b.data END AS data
FROM bets b LEFT JOIN bet_entry_source_inferences i
  ON b.id = i.bet_id AND b.created_at = i.original_created_at;
