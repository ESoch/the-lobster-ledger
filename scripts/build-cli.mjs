import { build } from 'esbuild';
import { normalizeOrigin } from '../src/lib/cli-origin.ts';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPackageFiles, cliPackageManifest } from './cli-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloads = join(root, 'dist', 'downloads');
const staging = await mkdtemp(join(tmpdir(), 'lobster-cli-package-'));
const manifest = cliPackageManifest();

try {
  await mkdir(join(staging, 'bin'), { recursive: true });
  await mkdir(downloads, { recursive: true });
  const entry = join(root, 'cli', 'src', 'index.ts');
  const source = await readFile(entry, 'utf8');
  await build({
    entryPoints: [entry],
    outfile: join(staging, 'bin', 'lobster.mjs'),
    bundle: true,
    define: {
      __LOBSTER_DEFAULT_ORIGIN__: process.env.APP_ORIGIN
        ? JSON.stringify(normalizeOrigin(process.env.APP_ORIGIN))
        : 'undefined',
    },
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['@napi-rs/keyring'],
    sourcemap: false,
    legalComments: 'inline',
    ...(!source.startsWith('#!') ? { banner: { js: '#!/usr/bin/env node' } } : {}),
  });
  await chmod(join(staging, 'bin', 'lobster.mjs'), 0o755);
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, 'cli', 'README.md'), join(staging, 'README.md'));
  await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
  await writeFile(
    join(staging, 'THIRD_PARTY_NOTICES.txt'),
    `This CLI bundles Zod. Its license follows.\n\n${await readFile(join(root, 'node_modules', 'zod', 'LICENSE'), 'utf8')}`,
  );
  const packed = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', downloads],
    { cwd: staging, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (packed.status !== 0) throw new Error(`CLI packaging failed: ${packed.stderr}`);
  const [result] = JSON.parse(packed.stdout);
  assertPackageFiles(result.files.map((file) => file.path));
  const expectedName = `${manifest.name}-${manifest.version}.tgz`;
  if (result.filename !== expectedName) throw new Error('Unexpected CLI archive name.');
  const archive = await readFile(join(downloads, result.filename));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await writeFile(join(downloads, `${result.filename}.sha256`), `${sha256}  ${result.filename}\n`);
  await writeFile(
    join(downloads, 'cli.json'),
    `${JSON.stringify(
      {
        version: manifest.version,
        filename: result.filename,
        sha256,
        node: manifest.engines.node,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`CLI ${manifest.version}: /downloads/${result.filename} (${archive.length} bytes)`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
