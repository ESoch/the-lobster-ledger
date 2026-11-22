import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CLI release gates', () => {
  it('builds the CLI download after the web build clears dist', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(scripts.build).toMatch(/vite build\s*&&\s*pnpm build:cli/);
    expect(scripts.check).toContain('cli/tsconfig.json');
  });

  it('applies remote migrations before the local deploy command publishes the worker', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(scripts.deploy).toMatch(/^node scripts\/production-config\.mjs\s*&&/);
    expect(scripts.deploy).toContain(
      'wrangler d1 migrations apply DB --remote --config wrangler.production.json && wrangler deploy --config wrangler.production.json',
    );
  });

  it('gates deployment on migrations and checks the installable archive in CI', () => {
    const workflow = readFileSync('.github/workflows/ci-deploy.yml', 'utf8');
    const migration = workflow.indexOf(
      'pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.production.json',
    );
    const deploy = workflow.indexOf('pnpm exec wrangler deploy --message');
    expect(migration).toBeGreaterThan(-1);
    const generate = workflow.indexOf('node scripts/production-config.mjs');
    expect(generate).toBeGreaterThan(-1);
    expect(generate).toBeLessThan(migration);
    expect(workflow).toContain(
      'wrangler deploy --message "GitHub commit $GITHUB_SHA" --config wrangler.production.json',
    );
    expect(migration).toBeLessThan(deploy);
    expect(workflow).toContain('pnpm test:cli-install');
    expect(workflow).toContain("request('/downloads/cli.json')");
  });
});
