import { describe, expect, it } from 'vitest';
import { cliPackageManifest, assertPackageFiles } from './cli-package.mjs';

describe('CLI distribution boundary', () => {
  it('packages only the CLI entry point, documentation, and licenses', () => {
    const manifest = cliPackageManifest();
    expect(manifest.name).toBe('lobster-ledger-cli');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.bin).toEqual({ lobster: 'bin/lobster.mjs' });
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.license).toBe('MIT');
    expect(manifest.dependencies).toEqual({ '@napi-rs/keyring': '2.1.0' });
    expect(() =>
      assertPackageFiles([
        'package.json',
        'bin/lobster.mjs',
        'README.md',
        'LICENSE',
        'THIRD_PARTY_NOTICES.txt',
      ]),
    ).not.toThrow();
  });

  it.each([
    'worker/index.ts',
    '.env',
    '.env.production',
    'wrangler.jsonc',
    '.dev.vars',
    'src/App.tsx',
    'id_rsa',
    '../secret',
    'bin/../../secret',
  ])('refuses unexpected package contents: %s', (file) => {
    expect(() => assertPackageFiles(['package.json', 'bin/lobster.mjs', file])).toThrow();
  });

  it('requires a usable manifest and executable in every package', () => {
    expect(() => assertPackageFiles(['package.json', 'README.md'])).toThrow();
    expect(() => assertPackageFiles(['bin/lobster.mjs'])).toThrow();
  });

  it('requires the project license and bundled dependency notice', () => {
    const files = ['package.json', 'bin/lobster.mjs', 'README.md'];
    expect(() => assertPackageFiles([...files, 'THIRD_PARTY_NOTICES.txt'])).toThrow(
      'Missing CLI package file: LICENSE',
    );
    expect(() => assertPackageFiles([...files, 'LICENSE'])).toThrow(
      'Missing CLI package file: THIRD_PARTY_NOTICES.txt',
    );
  });
});
