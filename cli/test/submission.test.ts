import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PendingSubmissions } from '../src/submission';
describe('retry-safe wager creation', () => {
  it('does not let a late response erase the key of a newer uncertain submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-pending-'));
    try {
      const pending = new PendingSubmissions(directory, 'https://ledger.example', 'member-a');
      const body = { bet: { title: 'Same agreement', stake: 1 } };
      const first = await pending.prepare(body);
      const duplicate = await pending.prepare(body);
      expect(first.key).toBe(duplicate.key);
      await pending.complete(first);
      const newer = await pending.prepare(body);
      expect(newer.key).not.toBe(first.key);
      await pending.complete(duplicate);
      expect((await pending.prepare(body)).key).toBe(newer.key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('shares a single durable key across concurrent independent store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-pending-'));
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          new PendingSubmissions(directory, 'https://ledger.example', 'member-a').prepare({
            title: 'Same',
          }),
        ),
      );
      expect(new Set(results.map((result) => result.key)).size).toBe(1);
      await Promise.all(
        results.map((result) =>
          new PendingSubmissions(directory, 'https://ledger.example', 'member-a').complete(result),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('reuses an unresolved request key without saving wager content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-pending-'));
    try {
      const pending = new PendingSubmissions(directory, 'https://ledger.example', 'member-a');
      const body = { bet: { title: 'Confidential title', stake: 2 } };
      const first = await pending.prepare(body);
      const again = await pending.prepare(body);
      expect(again.key).toBe(first.key);
      for (const name of await readdir(directory))
        expect(await readFile(join(directory, name), 'utf8')).not.toContain('Confidential');
      await pending.complete(first);
      expect((await pending.prepare(body)).key).not.toBe(first.key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps different people and server origins separate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lobster-pending-'));
    try {
      const a = await new PendingSubmissions(directory, 'https://a.example', 'member-a').prepare({
        title: 'Same',
      });
      const b = await new PendingSubmissions(directory, 'https://b.example', 'member-a').prepare({
        title: 'Same',
      });
      const c = await new PendingSubmissions(directory, 'https://a.example', 'member-b').prepare({
        title: 'Same',
      });
      expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
