-- A single insert checks every version before changing any wager. Trigger failures
-- roll back the operation, all wager updates, and their existing audit triggers.
CREATE TABLE debt_offsets (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES members(id),
  counterparty_id TEXT NOT NULL REFERENCES members(id),
  rolls INTEGER NOT NULL CHECK(rolls > 0),
  created_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  CHECK(actor_id <> counterparty_id),
  CHECK(json_array_length(data, '$.bets') >= 2)
);
-- statement-breakpoint
CREATE TRIGGER debt_offsets_check_versions BEFORE INSERT ON debt_offsets
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM bets b JOIN json_each(NEW.data, '$.bets') u
    ON b.id = json_extract(u.value, '$.id')
    AND b.version = json_extract(u.value, '$.version') - 1
    AND b.status = 'owed'
    AND b.creator_id IN (NEW.actor_id, NEW.counterparty_id)
    AND b.opponent_id IN (NEW.actor_id, NEW.counterparty_id)
  ) <> json_array_length(NEW.data, '$.bets')
  THEN RAISE(ABORT, 'Offset debts changed') END;
END;
-- statement-breakpoint
CREATE TRIGGER debt_offsets_apply AFTER INSERT ON debt_offsets
BEGIN
  UPDATE bets SET (status, version, updated_at, data) = (
    SELECT json_extract(u.value, '$.status'), json_extract(u.value, '$.version'),
      json_extract(u.value, '$.updatedAt'), u.value
    FROM json_each(NEW.data, '$.bets') u WHERE json_extract(u.value, '$.id') = bets.id
  ) WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(NEW.data, '$.bets'));
END;
-- statement-breakpoint
CREATE TRIGGER debt_offsets_no_update BEFORE UPDATE ON debt_offsets
BEGIN SELECT RAISE(ABORT, 'Debt offsets are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER debt_offsets_no_delete BEFORE DELETE ON debt_offsets
BEGIN SELECT RAISE(ABORT, 'Debt offsets are immutable'); END;
-- statement-breakpoint
DROP VIEW outstanding_obligations;
-- statement-breakpoint
CREATE VIEW outstanding_obligations AS
SELECT b.id AS bet_id,
  CASE WHEN b.winner_id = b.creator_id THEN b.opponent_id ELSE b.creator_id END AS from_id,
  b.winner_id AS to_id,
  b.stake - COALESCE((
    SELECT SUM(json_extract(a.value, '$.rolls'))
    FROM json_each(b.data, '$.offsets') o, json_each(o.value, '$.allocations') a
    WHERE json_extract(a.value, '$.betId') = b.id
  ), 0) AS rolls
FROM bets b WHERE b.status IN ('owed', 'settling') AND b.winner_id IS NOT NULL;
