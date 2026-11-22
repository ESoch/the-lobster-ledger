import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { latestCalendarDay } from '../src/lib/bet-workflow';
import type { PriceObservation, Restaurant } from '../src/lib/types';
import app, { type WorkerBindings } from './index';
import {
  correctPrice,
  getOrCreateRestaurant,
  recordPrice,
  withdrawPrice,
  type PriceCorrectionInput,
  type PriceReportInput,
} from './prices';
import { tokenHash } from './security';
import { correctPriceObservation } from './storage';
import { applyEntrySourceMigration } from './test-entry-source-migration';
import { applyPriceWithdrawMigration } from './test-price-migration';

const origin = 'https://ledger.example';
let mf: Miniflare;
let env: WorkerBindings;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-09-12',
      d1Databases: ['DB'],
    }),
  );
  DB = await mf.getD1Database('DB');
  env = {
    DB,
    APP_ORIGIN: origin,
    GROUP_NAME: 'Test ledger',
    OWNER_EMAIL: 'alice@example.com',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  for (const file of ['0001_ledger.sql', '0002_roll_prices.sql', '0003_cli_sessions.sql'])
    await DB.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  await applyEntrySourceMigration(DB);
  await applyPriceWithdrawMigration(DB);
  for (const id of ['alice', 'bob']) {
    await DB.prepare(
      'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, `${id}@example.com`, id[0], '#153b3e', new Date().toISOString())
      .run();
    await DB.prepare(
      'INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(
        await tokenHash(id),
        id,
        new Date().toISOString(),
        new Date(Date.now() + 3600_000).toISOString(),
      )
      .run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});

const send = (path: string, actor: string, body: unknown, method = 'POST') =>
  app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        Cookie: `__Host-lobster_session=${actor}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  );
const count = async (sql: string, ...values: unknown[]) =>
  (await DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>())!.n;
const visit = (overrides: Record<string, unknown> = {}) => ({
  itemName: 'Classic lobster roll',
  priceCents: 2800,
  visitDate: '2026-09-11',
  visitDatePrecision: 'day',
  ...overrides,
});
let named = 0;
/** A restaurant of its own for each test, so tests never see each other's reports. */
async function restaurant(name = `Test Shack ${++named}`, address = 'Seaport, Boston') {
  const response = await send('/api/restaurants', 'alice', { name, address });
  expect(response.status).toBe(201);
  return (await response.json()) as Restaurant;
}
type Recorded = { observation: PriceObservation; restaurant: Restaurant; duplicateOf?: string };

describe('recording a price at a new restaurant', () => {
  it('writes the restaurant and its first report together', async () => {
    const response = await send('/api/price-observations', 'bob', {
      ...visit(),
      restaurant: { name: 'Pearl Street Clam Bar', address: 'Fort Point' },
    });
    expect(response.status).toBe(201);
    const { observation, restaurant } = (await response.json()) as Recorded;
    expect(restaurant).toMatchObject({ name: 'Pearl Street Clam Bar', address: 'Fort Point' });
    expect(observation).toMatchObject({
      restaurantId: restaurant.id,
      reporterId: 'bob',
      priceCents: 2800,
    });
    expect(await count('SELECT count(*) AS n FROM restaurants WHERE id = ?', restaurant.id)).toBe(
      1,
    );
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE id = ?', observation.id),
    ).toBe(1);
  });

  it('leaves no restaurant behind when its report cannot be written', async () => {
    // The table refuses a zero price, so the second statement of the batch fails.
    await expect(
      recordPrice(
        DB,
        {
          ...visit({ priceCents: 0 }),
          restaurant: { name: 'Ghost Kitchen', address: '' },
        } as PriceReportInput,
        'alice',
      ),
    ).rejects.toThrow();
    expect(await count("SELECT count(*) AS n FROM restaurants WHERE name = 'Ghost Kitchen'")).toBe(
      0,
    );
  });

  it('uses the restaurant already on the record when only case and spacing differ', async () => {
    const harbor = await restaurant('Harbor Shack', 'Seaport, Boston, MA');
    const again = await send('/api/restaurants', 'bob', {
      name: 'harbor  shack',
      address: 'seaport, boston, ma ',
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Restaurant).id).toBe(harbor.id);
    const response = await send('/api/price-observations', 'bob', {
      ...visit(),
      restaurant: { name: 'Harbor shack', address: 'Seaport,  Boston, MA' },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      restaurant: { id: harbor.id, name: 'Harbor Shack' },
      matched: 'normalised',
      observation: { restaurantId: harbor.id },
    });
    expect(
      await count("SELECT count(*) AS n FROM restaurants WHERE lower(name) = 'harbor shack'"),
    ).toBe(1);
  });

  it('answers with the row another member just added when both add it at once', async () => {
    await DB.prepare(
      "INSERT INTO restaurants (id, name, address, created_by, created_at) VALUES ('raced', 'Race Shack', 'Dock 1', 'alice', '2026-10-01T00:00:00.000Z')",
    ).run();
    // The lookup misses the row (it is being written as this request reads), so the insert hits
    // the unique index; the answer is the row that won, not an error.
    const result = await getOrCreateRestaurant(
      blindToRestaurantsUntilInsert(DB),
      { name: 'Race Shack', address: 'Dock 1' },
      'bob',
    );
    expect(result).toMatchObject({ restaurant: { id: 'raced' }, matched: 'normalised' });
    expect(await count("SELECT count(*) AS n FROM restaurants WHERE name = 'Race Shack'")).toBe(1);
  });
});

describe('visit dates', () => {
  it.each([
    ['an impossible day', { visitDate: '2026-02-31' }],
    ['a far-future day', { visitDate: '2099-01-01' }],
    ['a year before 1900', { visitDate: '1899', visitDatePrecision: 'year' }],
  ])('refuses %s', async (_label, overrides) => {
    const { id } = await restaurant();
    const response = await send('/api/price-observations', 'bob', {
      ...visit(overrides),
      restaurantId: id,
    });
    expect(response.status).toBe(400);
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(0);
  });

  it('accepts today in the latest timezone on Earth', async () => {
    const { id } = await restaurant();
    const response = await send('/api/price-observations', 'bob', {
      ...visit({ visitDate: latestCalendarDay(Date.now()) }),
      restaurantId: id,
    });
    expect(response.status).toBe(201);
  });
});

describe('a second report of the same visit', () => {
  it('returns the report already on record when the price matches, and writes nothing', async () => {
    const { id } = await restaurant();
    const first = (await (
      await send('/api/price-observations', 'bob', { ...visit(), restaurantId: id })
    ).json()) as Recorded;
    const retry = await send('/api/price-observations', 'bob', {
      ...visit({ itemName: '  classic LOBSTER roll ' }),
      restaurantId: id,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      observation: { id: first.observation.id },
      duplicateOf: first.observation.id,
    });
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(1);
  });

  it('asks before recording a different price for the same visit', async () => {
    const { id } = await restaurant();
    const first = (await (
      await send('/api/price-observations', 'bob', { ...visit(), restaurantId: id })
    ).json()) as Recorded;
    const conflict = await send('/api/price-observations', 'bob', {
      ...visit({ priceCents: 3000 }),
      restaurantId: id,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      existingId: first.observation.id,
      existing: { priceCents: 2800 },
      error: expect.stringContaining('$28.00'),
    });
    const separate = await send('/api/price-observations', 'bob', {
      ...visit({ priceCents: 3000 }),
      restaurantId: id,
      confirmSeparateReport: true,
    });
    expect(separate.status).toBe(201);
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(2);
  });

  it('returns either of two separate purchases when one is resent, and writes nothing', async () => {
    const { id } = await restaurant();
    const first = (await (
      await send('/api/price-observations', 'bob', { ...visit(), restaurantId: id })
    ).json()) as Recorded;
    const separate = (await (
      await send('/api/price-observations', 'bob', {
        ...visit({ priceCents: 3000 }),
        restaurantId: id,
        confirmSeparateReport: true,
      })
    ).json()) as Recorded;
    for (const [body, existing] of [
      [{ ...visit(), restaurantId: id }, first],
      [{ ...visit({ priceCents: 3000 }), restaurantId: id, confirmSeparateReport: true }, separate],
    ] as const) {
      const resent = await send('/api/price-observations', 'bob', body);
      expect(resent.status).toBe(200);
      expect(await resent.json()).toMatchObject({ duplicateOf: existing.observation.id });
    }
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(2);
  });

  it('counts other members, items, days and precisions as other visits', async () => {
    const { id } = await restaurant();
    expect(
      (await send('/api/price-observations', 'bob', { ...visit(), restaurantId: id })).status,
    ).toBe(201);
    for (const [actor, overrides] of [
      ['alice', {}],
      ['bob', { itemName: 'Connecticut roll', priceCents: 3100 }],
      ['bob', { visitDate: '2026-09-12', priceCents: 3100 }],
      ['bob', { visitDate: '2026-09', visitDatePrecision: 'month', priceCents: 3100 }],
    ] as const)
      expect(
        (await send('/api/price-observations', actor, { ...visit(overrides), restaurantId: id }))
          .status,
      ).toBe(201);
  });
});

describe('two reports of one visit sent at once', () => {
  const reports = (id: string) =>
    count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id);

  it('writes one report when an identical one passed the check at the same moment', async () => {
    const { id } = await restaurant();
    const input = { ...visit(), restaurantId: id } as PriceReportInput;
    const first = await recordPrice(DB, input, 'bob');
    // The second request read the visit before the first one's report was written.
    const second = await recordPrice(blindUntilWrite(DB), input, 'bob');
    expect(second).toMatchObject({
      observation: { id: first.observation.id },
      duplicateOf: first.observation.id,
    });
    expect(await reports(id)).toBe(1);
  });

  it('still asks about another price for the visit that passed the check at the same moment', async () => {
    const { id } = await restaurant();
    await recordPrice(DB, { ...visit(), restaurantId: id } as PriceReportInput, 'bob');
    await expect(
      recordPrice(
        blindUntilWrite(DB),
        { ...visit({ priceCents: 3000 }), restaurantId: id } as PriceReportInput,
        'bob',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await reports(id)).toBe(1);
    // A separate purchase the member confirmed is still written.
    await recordPrice(
      blindUntilWrite(DB),
      {
        ...visit({ priceCents: 3000 }),
        restaurantId: id,
        confirmSeparateReport: true,
      } as PriceReportInput,
      'bob',
    );
    expect(await reports(id)).toBe(2);
  });

  it('writes one restaurant and one report when a new one is named twice at once', async () => {
    const input = {
      ...visit(),
      restaurant: { name: 'Twin Dock Shack', address: 'Pier 2' },
    } as PriceReportInput;
    const first = await recordPrice(DB, input, 'bob');
    const second = await recordPrice(
      blindUntilWrite(DB, ['restaurants', 'price_observations']),
      input,
      'bob',
    );
    expect(second).toMatchObject({
      restaurant: { id: first.restaurant.id },
      duplicateOf: first.observation.id,
    });
    expect(
      await count("SELECT count(*) AS n FROM restaurants WHERE name = 'Twin Dock Shack'"),
    ).toBe(1);
    expect(await reports(first.restaurant.id)).toBe(1);
  });
});

describe('correcting a price', () => {
  const report = async (restaurantId: string) =>
    (
      (await (
        await send('/api/price-observations', 'bob', { ...visit(), restaurantId })
      ).json()) as Recorded
    ).observation;
  const correct = (id: string, restaurantId: string, overrides: Record<string, unknown> = {}) =>
    send(
      `/api/price-observations/${id}`,
      'bob',
      { ...visit({ priceCents: 2900, ...overrides }), restaurantId },
      'PUT',
    );

  it('cannot correct a report that does not exist', async () => {
    const { id } = await restaurant();
    expect((await correct(crypto.randomUUID(), id)).status).toBe(404);
  });

  it('refuses a correction that changes nothing', async () => {
    const { id } = await restaurant();
    const original = await report(id);
    const unchanged = await correct(original.id, id, { priceCents: 2800 });
    expect(unchanged.status).toBe(400);
    expect(await unchanged.json()).toMatchObject({
      error:
        'This correction changes nothing. Change the restaurant, price, item, date or note first.',
    });
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(1);
  });

  it('refuses a correction onto a visit the member already reported', async () => {
    const { id } = await restaurant();
    const first = await report(id);
    const second = (
      (await (
        await send('/api/price-observations', 'bob', {
          ...visit({ visitDate: '2026-09-12', priceCents: 3000 }),
          restaurantId: id,
        })
      ).json()) as Recorded
    ).observation;
    const live = () =>
      count(
        "SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ? AND visit_date = '2026-09-11' AND corrected_at IS NULL AND withdrawn_at IS NULL",
        id,
      );
    for (const [priceCents, confirmSeparateReport] of [
      [2800, false],
      [2800, true],
      [2900, false],
    ] as const) {
      const refused = await correct(second.id, id, { priceCents, confirmSeparateReport });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ existingId: first.id });
    }
    expect(await live()).toBe(1);
    const separate = await correct(second.id, id, { confirmSeparateReport: true });
    expect(separate.status).toBe(201);
    expect(await live()).toBe(2);
  });

  it('refuses a second correction of the same report', async () => {
    const { id } = await restaurant();
    const original = await report(id);
    expect((await correct(original.id, id)).status).toBe(201);
    expect((await correct(original.id, id, { priceCents: 3000 })).status).toBe(409);
  });

  it('lets exactly one of two corrections sent at once win', async () => {
    const { id } = await restaurant();
    const original = await report(id);
    const statuses = (
      await Promise.all([correct(original.id, id), correct(original.id, id, { priceCents: 3000 })])
    ).map((response) => response.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(
      await count(
        'SELECT count(*) AS n FROM price_observations WHERE corrected_from_id = ?',
        original.id,
      ),
    ).toBe(1);
  });

  it('writes no second successor even when both corrections passed the first check', async () => {
    const { id } = await restaurant();
    const original = await report(id);
    const successor = (priceCents: number): PriceObservation => ({
      ...original,
      id: crypto.randomUUID(),
      priceCents,
      correctedFromId: original.id,
      reportedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    expect(await correctPriceObservation(DB, original.id, successor(2900), now)).toBe(true);
    expect(await correctPriceObservation(DB, original.id, successor(3000), now)).toBe(false);
    expect(
      await count(
        'SELECT count(*) AS n FROM price_observations WHERE corrected_from_id = ?',
        original.id,
      ),
    ).toBe(1);
    await expect(
      correctPrice(
        DB,
        original.id,
        { ...visit({ priceCents: 3100 }), restaurantId: id } as never,
        'bob',
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is refused for another member', async () => {
    const { id } = await restaurant();
    const original = await report(id);
    const response = await send(
      `/api/price-observations/${original.id}`,
      'alice',
      { ...visit({ priceCents: 2900 }), restaurantId: id },
      'PUT',
    );
    expect(response.status).toBe(403);
  });
});

const reportBy = async (actor: string, restaurantId: string, overrides = {}) => {
  const response = await send('/api/price-observations', actor, {
    ...visit(overrides),
    restaurantId,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as Recorded).observation;
};
const withdraw = (
  id: string,
  actor: string,
  body: unknown = { reason: 'Logged at the wrong place' },
) => send(`/api/price-observations/${id}/withdraw`, actor, body);
const stored = (id: string) =>
  DB.prepare(
    'SELECT withdrawn_at AS withdrawnAt, withdrawn_reason AS withdrawnReason, corrected_at AS correctedAt, correction_reason AS correctionReason, entry_source AS entrySource FROM price_observations WHERE id = ?',
  )
    .bind(id)
    .first<Record<string, string | null>>();

describe('withdrawing a price', () => {
  it('keeps the report on record, stamped with when and why', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    const response = await withdraw(original.id, 'bob', { reason: '  Wrong restaurant  ' });
    expect(response.status).toBe(200);
    const { observation } = (await response.json()) as { observation: PriceObservation };
    expect(observation).toMatchObject({
      id: original.id,
      priceCents: 2800,
      withdrawnReason: 'Wrong restaurant',
    });
    expect(Date.parse(observation.withdrawnAt!)).not.toBeNaN();
    expect(await stored(original.id)).toMatchObject({
      withdrawnAt: observation.withdrawnAt,
      withdrawnReason: 'Wrong restaurant',
    });
    const ledger = await app.request(
      `${origin}/api/ledger`,
      { headers: { Cookie: '__Host-lobster_session=bob' } },
      env,
    );
    const { priceObservations } = (await ledger.json()) as {
      priceObservations: PriceObservation[];
    };
    expect(priceObservations.find((item) => item.id === original.id)).toMatchObject({
      withdrawnAt: observation.withdrawnAt,
      withdrawnReason: 'Wrong restaurant',
      entrySource: 'web',
    });
  });

  it.each([
    ['no reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['a reason over 500 characters', { reason: 'R'.repeat(501) }],
    ['anything else', { reason: 'Wrong place', withdrawnAt: '2020-01-01T00:00:00.000Z' }],
  ])('needs a reason of 1 to 500 characters, refusing %s', async (_case, body) => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect((await withdraw(original.id, 'bob', body)).status).toBe(400);
    expect((await stored(original.id))?.withdrawnAt).toBeNull();
    expect((await withdraw(original.id, 'bob', { reason: 'R'.repeat(500) })).status).toBe(200);
  });

  it('is only for the member who reported it', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect((await withdraw(original.id, 'alice')).status).toBe(403);
    expect((await withdraw(crypto.randomUUID(), 'bob')).status).toBe(404);
    expect((await stored(original.id))?.withdrawnAt).toBeNull();
  });

  it('happens once, and never to a report a correction replaced', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect((await withdraw(original.id, 'bob')).status).toBe(200);
    const again = await withdraw(original.id, 'bob', { reason: 'Another reason' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: 'That price report has already been withdrawn.',
    });
    expect((await stored(original.id))?.withdrawnReason).toBe('Logged at the wrong place');
    const other = await reportBy('bob', id, { visitDate: '2026-09-12' });
    expect(
      (
        await send(
          `/api/price-observations/${other.id}`,
          'bob',
          { ...visit({ visitDate: '2026-09-12', priceCents: 2900 }), restaurantId: id },
          'PUT',
        )
      ).status,
    ).toBe(201);
    const corrected = await withdraw(other.id, 'bob');
    expect(corrected.status).toBe(409);
    expect(await corrected.json()).toMatchObject({
      error: 'That price report has already been corrected.',
    });
  });

  it('cannot be corrected once withdrawn', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect((await withdraw(original.id, 'bob')).status).toBe(200);
    const correction = await send(
      `/api/price-observations/${original.id}`,
      'bob',
      { ...visit({ priceCents: 2900 }), restaurantId: id },
      'PUT',
    );
    expect(correction.status).toBe(409);
    expect(await correction.json()).toMatchObject({
      error: 'That price report has been withdrawn.',
    });
    expect(
      await count(
        'SELECT count(*) AS n FROM price_observations WHERE corrected_from_id = ?',
        original.id,
      ),
    ).toBe(0);
  });

  it('lets exactly one of a withdrawal and a correction sent at once win', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    const statuses = (
      await Promise.all([
        withdraw(original.id, 'bob'),
        send(
          `/api/price-observations/${original.id}`,
          'bob',
          { ...visit({ priceCents: 2900 }), restaurantId: id },
          'PUT',
        ),
      ])
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    const row = await stored(original.id);
    expect(Boolean(row?.withdrawnAt) !== Boolean(row?.correctedAt)).toBe(true);
  });

  it('answers 409 when the report changed between the check and the write', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    // Both requests read the live report; only the first stamp lands.
    const now = new Date().toISOString();
    const results = await Promise.allSettled([
      withdrawPrice(DB, original.id, { reason: 'First' }, 'bob', now),
      withdrawPrice(DB, original.id, { reason: 'Second' }, 'bob', now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
  });

  it('frees the visit for a new report', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect((await withdraw(original.id, 'bob')).status).toBe(200);
    // At another price this would otherwise ask whether it was a separate purchase.
    const again = await reportBy('bob', id, { priceCents: 3000 });
    expect(again.id).not.toBe(original.id);
  });

  it('is refused to CLI credentials and to other sites', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    const cli = await app.request(
      `${origin}/api/price-observations/${original.id}/withdraw`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer some-cli-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Wrong place' }),
      },
      env,
    );
    expect(cli.status).toBe(403);
    const crossSite = await app.request(
      `${origin}/api/price-observations/${original.id}/withdraw`,
      {
        method: 'POST',
        headers: {
          Cookie: '__Host-lobster_session=bob',
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Wrong place' }),
      },
      env,
    );
    expect(crossSite.status).toBe(403);
    expect((await stored(original.id))?.withdrawnAt).toBeNull();
  });
});

describe('where a report came from and why it was corrected', () => {
  it('stamps reports from the website as web, and never takes a source from the client', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    expect(original.entrySource).toBe('web');
    expect((await stored(original.id))?.entrySource).toBe('web');
    const claimed = await send('/api/price-observations', 'bob', {
      ...visit({ visitDate: '2026-09-13' }),
      restaurantId: id,
      entrySource: 'mcp',
    });
    expect(claimed.status).toBe(400);
  });

  it('stamps a price recorded or corrected through MCP as mcp', async () => {
    const { id } = await restaurant();
    const recorded = await recordPrice(
      DB,
      { ...visit({ visitDate: '2026-09-14' }), restaurantId: id } as PriceReportInput,
      'bob',
      undefined,
      'mcp',
    );
    expect(recorded.observation.entrySource).toBe('mcp');
    expect((await stored(recorded.observation.id))?.entrySource).toBe('mcp');
    const corrected = await correctPrice(
      DB,
      recorded.observation.id,
      {
        ...visit({ visitDate: '2026-09-14', priceCents: 2900 }),
        restaurantId: id,
      } as PriceCorrectionInput,
      'bob',
      undefined,
      'mcp',
    );
    expect((await stored(corrected.observation.id))?.entrySource).toBe('mcp');
  });

  it('keeps an optional reason with a correction', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    const response = await send(
      `/api/price-observations/${original.id}`,
      'bob',
      { ...visit({ priceCents: 2900 }), restaurantId: id, correctionReason: ' Misread the menu ' },
      'PUT',
    );
    expect(response.status).toBe(201);
    const { observation } = (await response.json()) as { observation: PriceObservation };
    expect(observation.correctionReason).toBe('Misread the menu');
    expect((await stored(observation.id))?.correctionReason).toBe('Misread the menu');
    const tooLong = await send(
      `/api/price-observations/${observation.id}`,
      'bob',
      { ...visit({ priceCents: 3000 }), restaurantId: id, correctionReason: 'R'.repeat(501) },
      'PUT',
    );
    expect(tooLong.status).toBe(400);
  });
});

describe('an unusual price', () => {
  it('is asked about before it is saved, and saved once the member confirms it', async () => {
    const { id } = await restaurant();
    const slip = { ...visit({ priceCents: 250 }), restaurantId: id };
    const response = await send('/api/price-observations', 'bob', slip);
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      warnings: { message: string; suggestedCents?: number }[];
    };
    expect(body.warnings[0]).toMatchObject({
      message: 'You entered $2.50. Did you mean $25.00?',
      suggestedCents: 2500,
    });
    expect(
      await count('SELECT count(*) AS n FROM price_observations WHERE restaurant_id = ?', id),
    ).toBe(0);
    const confirmed = await send('/api/price-observations', 'bob', {
      ...slip,
      confirmUnusualPrice: true,
    });
    expect(confirmed.status).toBe(201);
    // Sending the confirmed report again is a retry, not a new question.
    expect((await send('/api/price-observations', 'bob', slip)).status).toBe(200);
  });

  it('is asked about when it is ten times, or a tenth of, the last report of that roll', async () => {
    const { id } = await restaurant();
    await reportBy('alice', id, { priceCents: 8500, visitDate: '2026-09-01' });
    const tenth = await send('/api/price-observations', 'bob', {
      ...visit({ priceCents: 850 }),
      restaurantId: id,
    });
    expect(tenth.status).toBe(422);
    // A different roll at the same restaurant is its own series.
    expect(
      (
        await send('/api/price-observations', 'bob', {
          ...visit({ priceCents: 850, itemName: 'Lobster bisque cup', visitDate: '2026-09-02' }),
          restaurantId: id,
          confirmUnusualPrice: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await send('/api/price-observations', 'bob', {
          ...visit({ priceCents: 8400 }),
          restaurantId: id,
        })
      ).status,
    ).toBe(201);
  });

  it('is asked about in a correction too', async () => {
    const { id } = await restaurant();
    const original = await reportBy('bob', id);
    const response = await send(
      `/api/price-observations/${original.id}`,
      'bob',
      { ...visit({ priceCents: 28000 }), restaurantId: id },
      'PUT',
    );
    expect(response.status).toBe(422);
    expect(
      (
        await send(
          `/api/price-observations/${original.id}`,
          'bob',
          { ...visit({ priceCents: 28000 }), restaurantId: id, confirmUnusualPrice: true },
          'PUT',
        )
      ).status,
    ).toBe(201);
  });
});

/**
 * The database as a request sees it while another request is adding the same restaurant: every
 * restaurant lookup misses until this request tries its own insert.
 */
function blindToRestaurantsUntilInsert(db: D1Database): D1Database {
  let blind = true;
  const bound = <T extends object>(target: T, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (blind && /^SELECT .* FROM restaurants/.test(sql)) {
          if (prop === 'first') return async () => null;
          if (prop === 'all') return async () => ({ results: [], success: true, meta: {} });
        }
        if (prop === 'run' && sql.startsWith('INSERT INTO restaurants'))
          return () => {
            blind = false;
            return target.run();
          };
        return bound(target, prop);
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      return bound(target, prop);
    },
  });
}

/**
 * The database as a request sees it while another request is writing the same report: every read
 * of the named tables misses until this request writes.
 */
function blindUntilWrite(db: D1Database, tables: string[] = ['price_observations']): D1Database {
  const reads = new RegExp(`^SELECT .* FROM (${tables.join('|')})\\b`);
  let blind = true;
  const statements = new WeakMap<object, D1PreparedStatement>();
  const bound = <T extends object>(target: T, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (blind && reads.test(sql)) {
          if (prop === 'first') return async () => null;
          if (prop === 'all') return async () => ({ results: [], success: true, meta: {} });
        }
        if (prop === 'run' && sql.startsWith('INSERT'))
          return () => {
            blind = false;
            return target.run();
          };
        return bound(target, prop);
      },
    });
    statements.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return (batch: D1PreparedStatement[]) => {
          blind = false;
          return target.batch(batch.map((statement) => statements.get(statement) ?? statement));
        };
      return bound(target, prop);
    },
  });
}
