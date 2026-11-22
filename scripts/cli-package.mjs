export function cliPackageManifest() {
  return {
    name: 'lobster-ledger-cli',
    version: '0.1.0',
    description: 'Authenticated command-line access to The Lobster Ledger',
    type: 'module',
    private: true,
    license: 'MIT',
    engines: { node: '>=22' },
    bin: { lobster: 'bin/lobster.mjs' },
    files: ['bin/lobster.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'],
    dependencies: { '@napi-rs/keyring': '2.1.0' },
  };
}

export function assertPackageFiles(files) {
  const allowed = new Set([
    'package.json',
    'bin/lobster.mjs',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
  ]);
  for (const file of files) {
    if (!allowed.has(file)) throw new Error(`Unexpected file in CLI package: ${file}`);
  }
  for (const required of [
    'package.json',
    'bin/lobster.mjs',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
  ]) {
    if (!files.includes(required)) throw new Error(`Missing CLI package file: ${required}`);
  }
}
