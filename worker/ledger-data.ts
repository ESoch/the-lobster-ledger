import type { Bet, LedgerState, Member, PriceObservation, Restaurant } from '../src/lib/types';
import { priceColumns } from './storage';

export async function readLedger(
  db: D1Database,
  groupName = 'The Lobster Ledger',
): Promise<LedgerState> {
  const [memberRows, betRows] = await db.batch<{ data: string }>([
    db.prepare(
      "SELECT json_object('id', id, 'name', name, 'initials', initials, 'color', color) AS data FROM members ORDER BY created_at, id",
    ),
    db.prepare('SELECT data FROM bet_records ORDER BY created_at DESC, id DESC'),
  ]);
  const members = memberRows.results.map((row) => JSON.parse(row.data) as Member);
  const bets = betRows.results.map((row) => JSON.parse(row.data) as Bet);
  const [restaurantRows, priceRows] = await Promise.all([
    db
      .prepare('SELECT id, name, address, lat, lng FROM restaurants ORDER BY name, id')
      .all<Restaurant>(),
    db
      .prepare(
        `SELECT ${priceColumns} FROM price_observations ORDER BY visit_date DESC, reported_at DESC`,
      )
      .all<PriceObservation>(),
  ]);
  const places = [
    ...new Map(
      bets.flatMap((bet) => (bet.location ? [[bet.location.id, bet.location] as const] : [])),
    ).values(),
  ];
  return {
    members,
    bets,
    places,
    restaurants: restaurantRows.results,
    priceObservations: priceRows.results,
    groupName,
  } satisfies LedgerState;
}
