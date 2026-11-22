import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type { Bet, Member } from '../src/lib/types';
import { AVATAR_PALETTE, avatarColorFor } from '../src/lib/avatar-colors';
import { admitIdentity, insertBet, updateBet } from './storage';

let mf: Miniflare;
let db: D1Database;
const members: Member[] = [
  { id: 'alice', name: 'Alice', initials: 'A', color: '#153b3e' },
  { id: 'bob', name: 'Bob', initials: 'B', color: '#bd4938' },
];
const initialBet = (): Bet => ({
  id: crypto.randomUUID(),
  reference: crypto.randomUUID(),
  title: 'Launch by Friday',
  terms: 'Public announcement before 5pm Friday',
  category: 'Work',
  creatorId: 'alice',
  opponentId: 'bob',
  creatorSide: 'Yes',
  opponentSide: 'No',
  stake: 2,
  deadline: '2027-01-01',
  status: 'pending',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  version: 1,
  agreementApprovals: ['alice'],
  events: [
    {
      id: crypto.randomUUID(),
      at: '2026-09-12T00:00:00Z',
      actorId: 'alice',
      type: 'created',
      detail: 'Proposed bet',
    },
  ],
});

const invitation = async (token: string, name: string) =>
  db
    .prepare(
      'INSERT INTO invites (token_hash, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      token,
      name,
      'alice',
      new Date().toISOString(),
      new Date(Date.now() + 60000).toISOString(),
    )
    .run();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-09-12',
      d1Databases: ['DB'],
    }),
  );
  db = await mf.getD1Database('DB');
  await db.exec(await readFile(new URL('../migrations/0001_ledger.sql', import.meta.url), 'utf8'));
  await db.exec(
    await readFile(new URL('../migrations/0002_roll_prices.sql', import.meta.url), 'utf8'),
  );
  for (const member of members)
    await db
      .prepare(
        'INSERT INTO members (id, google_sub, name, email, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        member.id,
        member.id,
        member.name,
        `${member.id}@example.com`,
        member.initials,
        member.color,
        new Date().toISOString(),
      )
      .run();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('D1 ledger atomicity', () => {
  it('inserts the bet and its immutable audit event together', async () => {
    const bet = initialBet();
    await insertBet(db, bet);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(1);
    await expect(
      db
        .prepare('UPDATE events SET detail = ? WHERE bet_id = ?')
        .bind('Rewritten history', bet.id)
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.prepare('DELETE FROM events WHERE bet_id = ?').bind(bet.id).run(),
    ).rejects.toThrow(/immutable/);
  });

  it('allows one concurrent approval and leaves exactly one event for that version', async () => {
    const bet = initialBet();
    await insertBet(db, bet);
    const next = {
      ...bet,
      status: 'active' as const,
      version: 2,
      agreementApprovals: ['alice', 'bob'],
      events: [
        ...bet.events,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          actorId: 'bob',
          type: 'accepted',
          detail: 'Accepted',
        },
      ],
    };
    const results = await Promise.allSettled([updateBet(db, next, 1), updateBet(db, next, 1)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(2);
    expect(
      await db.prepare('SELECT version FROM bets WHERE id = ?').bind(bet.id).first('version'),
    ).toBe(2);
  });

  it('rolls back the bet update if the event cannot be appended', async () => {
    const bet = initialBet();
    await insertBet(db, bet);
    const next = { ...bet, version: 2, events: [...bet.events, bet.events[0]] };
    await expect(updateBet(db, next, 1)).rejects.toThrow();
    expect(
      await db.prepare('SELECT version FROM bets WHERE id = ?').bind(bet.id).first('version'),
    ).toBe(1);
  });

  it('keeps a corrected stake consistent between the aggregate and SQL balances', async () => {
    const bet = initialBet();
    await insertBet(db, bet);
    const next: Bet = {
      ...bet,
      stake: 5,
      version: 2,
      events: [
        ...bet.events,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          actorId: 'alice',
          type: 'history_revised',
          detail: 'Corrected the original stake to five rolls',
        },
      ],
    };
    await updateBet(db, next, 1);
    expect(
      await db
        .prepare(
          "SELECT stake, json_extract(data, '$.stake') AS recorded_stake FROM bets WHERE id = ?",
        )
        .bind(bet.id)
        .first(),
    ).toEqual({ stake: 5, recorded_stake: 5 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE bet_id = ?')
        .bind(bet.id)
        .first('count'),
    ).toBe(2);
  });

  it('admits at most one new member per invitation even under concurrent redemption', async () => {
    await db
      .prepare(
        'INSERT INTO invites (token_hash, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        'single-use',
        'Friend',
        'alice',
        new Date().toISOString(),
        new Date(Date.now() + 60000).toISOString(),
      )
      .run();
    const result = await Promise.allSettled([
      admitIdentity(
        db,
        { sub: 'new-one', email: 'one@example.com', name: 'One', emailAuthoritative: false },
        'owner@example.com',
        'single-use',
      ),
      admitIdentity(
        db,
        { sub: 'new-two', email: 'two@example.com', name: 'Two', emailAuthoritative: false },
        'owner@example.com',
        'single-use',
      ),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM members WHERE google_sub IN ('new-one', 'new-two')")
        .first('count'),
    ).toBe(1);
  });

  it('refuses uninvited identities and expired invitations', async () => {
    await expect(
      admitIdentity(
        db,
        {
          sub: 'intruder',
          email: 'intruder@example.com',
          name: 'Intruder',
          emailAuthoritative: false,
        },
        'owner@example.com',
      ),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .prepare(
        'INSERT INTO invites (token_hash, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('expired', 'Friend', 'alice', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z')
      .run();
    await expect(
      admitIdentity(
        db,
        { sub: 'late', email: 'late@example.com', name: 'Late', emailAuthoritative: false },
        'owner@example.com',
        'expired',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  describe('avatar colour and initials', () => {
    const invite = async (token: string, name = 'Friend') => invitation(token, name);
    const worn = async () =>
      (await db.prepare('SELECT color FROM members').all<{ color: string }>()).results.map(
        (row) => row.color,
      );
    const identity = (sub: string, name: string) => ({
      sub,
      email: `${sub}@example.com`,
      name,
      emailAuthoritative: false,
    });

    it('gives two admitted identities different colours from the shared palette', async () => {
      await invite('colour-one');
      await invite('colour-two');
      const firstWorn = await worn();
      const first = await admitIdentity(
        db,
        identity('colour-a', 'Casey'),
        'owner@example.com',
        'colour-one',
      );
      const second = await admitIdentity(
        db,
        identity('colour-b', 'Drew'),
        'owner@example.com',
        'colour-two',
      );
      expect(AVATAR_PALETTE).toContain(first.color);
      expect(AVATAR_PALETTE).toContain(second.color);
      expect(second.color).not.toBe(first.color);
      // The first choice is the hash of the id; the group's worn colours only move it to a free one.
      expect(first.color).toBe(avatarColorFor(first.id, firstWorn));
      expect(second.color).toBe(avatarColorFor(second.id, [...firstWorn, first.color]));
    });

    it('keeps the colour a member was given, and maps one id to one colour', async () => {
      await invite('colour-three');
      const admitted = await admitIdentity(
        db,
        identity('colour-c', 'Erin'),
        'owner@example.com',
        'colour-three',
      );
      const again = await admitIdentity(db, identity('colour-c', 'Erin'), 'owner@example.com');
      expect(again.color).toBe(admitted.color);
      expect(avatarColorFor(admitted.id)).toBe(avatarColorFor(admitted.id));
    });

    it('draws initials from letters, so an emoji in the name is not the initial', async () => {
      await invite('colour-four', '🦞 Pat Smith');
      const admitted = await admitIdentity(
        db,
        identity('colour-d', 'Pat'),
        'owner@example.com',
        'colour-four',
      );
      expect(admitted.initials).toBe('PS');
    });
  });

  describe('the name a new member is admitted under', () => {
    const google = (sub: string, name: string) => ({
      sub,
      email: `${sub}@example.com`,
      name,
      emailAuthoritative: false,
    });
    const stored = (sub: string) =>
      db
        .prepare('SELECT name, initials FROM members WHERE google_sub = ?')
        .bind(sub)
        .first<{ name: string; initials: string }>();

    it('is the name the inviter typed, not the Google profile name', async () => {
      await invitation('name-typed', 'Jamie Chen');
      const admitted = await admitIdentity(
        db,
        google('name-a', 'jchen1987'),
        'owner@example.com',
        'name-typed',
      );
      expect(admitted).toMatchObject({ name: 'Jamie Chen', initials: 'JC' });
      expect(await stored('name-a')).toEqual({ name: 'Jamie Chen', initials: 'JC' });
    });

    it('is cleaned of stray whitespace left in an older invitation', async () => {
      await invitation('name-spaced', '  riley   park ');
      const admitted = await admitIdentity(
        db,
        google('name-b', 'Someone Else'),
        'owner@example.com',
        'name-spaced',
      );
      expect(admitted.name).toBe('riley park');
    });

    it('falls back to the Google profile name when the invitation holds no usable name', async () => {
      await invitation('name-blank', '   ');
      const admitted = await admitIdentity(
        db,
        google('name-c', 'Casey Morgan'),
        'owner@example.com',
        'name-blank',
      );
      expect(admitted).toMatchObject({ name: 'Casey Morgan', initials: 'CM' });
    });

    it('falls back to the Google profile name when a member took the typed name in the meantime', async () => {
      await invitation('name-race', 'Morgan Lee');
      await db
        .prepare(
          'INSERT INTO members (id, google_sub, email, name, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'morgan',
          'morgan-sub',
          'morgan@example.com',
          'morgan  LEE',
          'ML',
          '#315b54',
          '2026-10-01T00:00:00Z',
        )
        .run();
      const admitted = await admitIdentity(
        db,
        google('name-race-sub', 'Morgan L.'),
        'owner@example.com',
        'name-race',
      );
      expect(admitted.name).toBe('Morgan L.');
    });

    it('never lets the Google profile name duplicate a member, whatever its case or spacing', async () => {
      await invitation('name-dupe-blank', '   ');
      const blank = await admitIdentity(
        db,
        google('name-dupe-a', '  ALICE '),
        'owner@example.com',
        'name-dupe-blank',
      );
      expect(blank.name).toBe('ALICE (2)');
      expect(blank.initials).toBe('A2');
      await invitation('name-dupe-twice', '');
      const twice = await admitIdentity(
        db,
        google('name-dupe-b', 'alice'),
        'owner@example.com',
        'name-dupe-twice',
      );
      expect(twice.name).toBe('alice (3)');
    });

    it('keeps the typed name with a number when the typed name and the Google name are both taken', async () => {
      await invitation('name-dupe-both', 'Bob');
      const admitted = await admitIdentity(
        db,
        google('name-dupe-c', 'bob'),
        'owner@example.com',
        'name-dupe-both',
      );
      expect(admitted.name).toBe('Bob (2)');
    });

    it('cleans the Google profile name of stray whitespace when it is the fallback', async () => {
      await invitation('name-clean-google', '');
      const admitted = await admitIdentity(
        db,
        google('name-clean-a', '  Taylor \t Reed '),
        'owner@example.com',
        'name-clean-google',
      );
      expect(admitted.name).toBe('Taylor Reed');
    });

    it('goes by the local part of the email when Google sends no usable name', async () => {
      await invitation('name-no-google', '');
      const admitted = await admitIdentity(
        db,
        google('name-no-google-sub', '   '),
        'owner@example.com',
        'name-no-google',
      );
      expect(admitted.name).toBe('name-no-google-sub');
    });

    it('stays the same when the member signs in again under another Google name', async () => {
      await invitation('name-again', 'Drew Hart');
      await admitIdentity(db, google('name-d', 'Drew'), 'owner@example.com', 'name-again');
      const again = await admitIdentity(db, google('name-d', 'Andrew H.'), 'owner@example.com');
      expect(again.name).toBe('Drew Hart');
    });
  });

  it('rejects first-owner bootstrap when Google cannot establish current mailbox ownership', async () => {
    await expect(
      admitIdentity(
        db,
        {
          sub: 'former-owner',
          email: 'owner@example.com',
          name: 'Former owner',
          emailAuthoritative: false,
        },
        'owner@example.com',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.prepare('SELECT COUNT(*) AS count FROM members WHERE is_owner = 1').first('count'),
    ).toBe(0);
  });

  it('bootstraps only the configured owner and reuses the Google subject for future sign-in', async () => {
    const identity = {
      sub: 'owner-google',
      email: 'owner@example.com',
      name: 'Owner',
      emailAuthoritative: true,
    };
    const first = await admitIdentity(db, identity, 'owner@example.com');
    const again = await admitIdentity(db, identity, 'owner@example.com');
    expect(first.id).toBe(again.id);
    await expect(
      admitIdentity(db, { ...identity, sub: 'other-owner-sub' }, 'owner@example.com'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
