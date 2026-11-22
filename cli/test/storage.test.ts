import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/storage';
import type { Credentials } from '../src/auth';
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const session: Credentials = {
  accessToken: 'private-access-token',
  refreshToken: 'private-refresh-token',
  member: { id: 'member-a', name: 'Alex' },
  sessionId: 's',
  expiresAt: 9999999999,
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lobster-test-'));
  folders.push(root);
  const vault = new Map<string, string>();
  const entry = (service: string, account: string) => ({
    getPassword: () => vault.get(service + account) ?? null,
    setPassword: (value: string) => {
      vault.set(service + account, value);
    },
    deletePassword: () => vault.delete(service + account),
  });
  return { root, vault, store: new CredentialStore('https://ledger.example', root, entry), entry };
}
describe('persistent credential storage', () => {
  it('keeps tokens only in the OS vault and keys them by origin and member', async () => {
    const { root, vault, store } = await setup();
    await store.write(session);
    expect(await store.read()).toEqual(session);
    const directory = join(root, (await readdir(root))[0]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(directory))
      expect(await readFile(join(directory, file), 'utf8')).not.toContain('private-');
    expect([...vault.keys()][0]).toContain('https://ledger.example');
    expect([...vault.keys()][0]).toContain('member-a');
    await store.clear();
    expect(vault.size).toBe(0);
    expect(await store.read()).toBeUndefined();
  });
  it('fails closed when a secure credential store is unavailable', async () => {
    const { root } = await setup();
    const store = new CredentialStore('https://ledger.example', root, () => {
      throw new Error('no keyring');
    });
    await expect(store.write(session)).rejects.toThrow(/credential store/i);
    expect(await store.read()).toBeUndefined();
  });
  it('serializes concurrent credential operations in independent store instances', async () => {
    const { root, store, entry } = await setup();
    const other = new CredentialStore('https://ledger.example', root, entry);
    const order: string[] = [];
    await Promise.all([
      store.locked(async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 75));
        order.push('first-end');
      }),
      other.locked(async () => {
        order.push('second');
      }),
    ]);
    expect(order.indexOf('first-end')).toBe(order.indexOf('first-start') + 1);
    expect(order).toHaveLength(3);
  });
});
