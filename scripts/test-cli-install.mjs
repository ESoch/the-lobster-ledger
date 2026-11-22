import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloads = join(root, 'dist', 'downloads');
const release = JSON.parse(await readFile(join(downloads, 'cli.json'), 'utf8'));
assert.match(release.filename, /^lobster-ledger-cli-\d+\.\d+\.\d+\.tgz$/);
const archive = join(downloads, release.filename);
assert.equal(
  createHash('sha256')
    .update(await readFile(archive))
    .digest('hex'),
  release.sha256,
);
const prefix = await mkdtemp(join(tmpdir(), 'lobster-cli-install-check-'));
try {
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' },
  );
  const installed = join(prefix, 'node_modules', 'lobster-ledger-cli');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(
    await readFile(join(installed, 'LICENSE'), 'utf8'),
    await readFile(join(root, 'LICENSE'), 'utf8'),
  );
  assert.ok(
    (await readFile(join(installed, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).includes(
      await readFile(join(root, 'node_modules', 'zod', 'LICENSE'), 'utf8'),
    ),
    'The installed package must include the bundled Zod license',
  );
  const entry = join(installed, 'bin', 'lobster.mjs');
  const help = execFileSync(process.execPath, [entry, '--help'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.match(help, /bets create/);
  assert.match(help, /auth login/);
  const version = execFileSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ok(version.includes(release.version));
  const template = execFileSync(process.execPath, [entry, 'bets', 'template'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(typeof JSON.parse(template).bet, 'object');
  console.log(
    `CLI ${release.version} installed and passed help, version, JSON template, license and checksum checks.`,
  );
} finally {
  await rm(prefix, { recursive: true, force: true });
}
