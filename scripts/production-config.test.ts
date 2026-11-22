import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const script = resolve('scripts/production-config.mjs');
const settings = {
  APP_ORIGIN: 'https://ledger.example.org',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  D1_DATABASE_ID: '11111111-2222-4333-8444-555555555555',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  OWNER_EMAIL: 'owner@example.org',
  RATE_LIMIT_NAMESPACE_ID: '123',
};
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lobster-deploy-test-'));
  copyFileSync('wrangler.jsonc', join(directory, 'wrangler.jsonc'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function generate(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    env: { ...settings, ...overrides },
    encoding: 'utf8',
  });
}

it('binds the named deployment to its own account, database, owner and rate limiter', () => {
  const result = generate({ WORKER_NAME: 'fork-worker', D1_DATABASE_NAME: 'fork-db' });
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(readFileSync(join(directory, 'wrangler.production.json'), 'utf8'));
  expect(config).toMatchObject({
    name: 'fork-worker',
    account_id: settings.CLOUDFLARE_ACCOUNT_ID,
    vars: {
      APP_ORIGIN: settings.APP_ORIGIN,
      GOOGLE_CLIENT_ID: settings.GOOGLE_CLIENT_ID,
      OWNER_EMAIL: settings.OWNER_EMAIL,
    },
    d1_databases: [
      {
        binding: 'DB',
        database_id: settings.D1_DATABASE_ID,
        database_name: 'fork-db',
        migrations_dir: 'migrations',
      },
    ],
    ratelimits: [{ name: 'AUTH_RATE_LIMITER', namespace_id: '123' }],
  });
});

it.each([
  ['OWNER_EMAIL', ''],
  ['D1_DATABASE_ID', '00000000-0000-0000-0000-000000000000'],
  ['RATE_LIMIT_NAMESPACE_ID', '0'],
  ['APP_ORIGIN', 'https://ledger.example.org/path'],
])('rejects invalid %s before generating a deployable file', (name, value) => {
  const result = generate({ [name]: value });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(name);
  expect(existsSync(join(directory, 'wrangler.production.json'))).toBe(false);
});
