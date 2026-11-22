CREATE TABLE IF NOT EXISTS bet_entry_source_reports (
  bet_id TEXT PRIMARY KEY REFERENCES bets(id),
  original_created_at TEXT NOT NULL,
  entry_source TEXT NOT NULL CHECK(entry_source IN ('browser', 'cli', 'mcp')),
  basis TEXT NOT NULL CHECK(basis = 'user_report'),
  note TEXT NOT NULL,
  reported_at TEXT NOT NULL
);

-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entry_source_reports_no_update
BEFORE UPDATE ON bet_entry_source_reports
BEGIN SELECT RAISE(ABORT, 'Entry source report provenance is immutable'); END;

-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS entry_source_reports_no_delete
BEFORE DELETE ON bet_entry_source_reports
BEGIN SELECT RAISE(ABORT, 'Entry source report provenance is immutable'); END;

-- statement-breakpoint
DROP VIEW bet_records;

-- statement-breakpoint
CREATE VIEW bet_records AS
SELECT b.id, b.created_at,
  CASE
    WHEN json_extract(b.data, '$.entrySource') IS NOT NULL THEN b.data
    WHEN r.bet_id IS NOT NULL THEN json_set(b.data,
      '$.entrySource', r.entry_source,
      '$.entrySourceReport', json_object('basis', r.basis, 'note', r.note, 'reportedAt', r.reported_at))
    WHEN i.bet_id IS NOT NULL THEN json_set(b.data,
      '$.entrySource', i.entry_source,
      '$.entrySourceInference', json_object(
        'basis', i.basis, 'cutoffAt', i.cutoff_at,
        'evidenceUrl', i.evidence_url, 'inferredAt', i.inferred_at))
    ELSE b.data END AS data
FROM bets b
LEFT JOIN bet_entry_source_reports r ON b.id = r.bet_id AND b.created_at = r.original_created_at
LEFT JOIN bet_entry_source_inferences i ON b.id = i.bet_id AND b.created_at = i.original_created_at;
