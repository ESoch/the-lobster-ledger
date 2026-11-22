import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

function setting(name, pattern) {
  const value = process.env[name] ?? '';
  if (!pattern.test(value)) throw new Error(`Missing or invalid ${name}`);
  return value;
}

const template = 'wrangler.jsonc';
const errors = [];
const config = parse(readFileSync(template, 'utf8'), errors, { allowTrailingComma: true });
if (errors.length) throw new Error(`Invalid ${template}`);
const origin = setting('APP_ORIGIN', /^https:\/\/[^\s]+$/);
if (new URL(origin).origin !== origin)
  throw new Error('APP_ORIGIN must be a canonical HTTPS origin');
const databaseId = setting('D1_DATABASE_ID', /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
if (databaseId === config.d1_databases[0].database_id)
  throw new Error('Set D1_DATABASE_ID to your database UUID');

config.name = process.env.WORKER_NAME || 'lobster-ledger';
config.account_id = setting('CLOUDFLARE_ACCOUNT_ID', /^[a-f\d]{32}$/i);
config.vars.APP_ORIGIN = origin;
config.vars.GOOGLE_CLIENT_ID = setting(
  'GOOGLE_CLIENT_ID',
  /^[\w.-]+\.apps\.googleusercontent\.com$/,
);
config.vars.OWNER_EMAIL = setting('OWNER_EMAIL', /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
config.d1_databases[0].database_id = databaseId;
if (process.env.D1_DATABASE_NAME)
  config.d1_databases[0].database_name = process.env.D1_DATABASE_NAME;
config.ratelimits[0].namespace_id = setting('RATE_LIMIT_NAMESPACE_ID', /^[1-9]\d*$/);

writeFileSync('wrangler.production.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
