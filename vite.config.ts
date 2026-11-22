import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'hosted-demo-link-preview',
      apply: (_config, { mode }) => mode === 'demo',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'demo-overview.jpg',
          source: readFileSync(new URL('./docs/images/demo-overview.jpg', import.meta.url)),
        });
      },
      transformIndexHtml() {
        const url = new URL(
          process.env.PAGES_DEMO_URL || 'https://esoch.github.io/the-lobster-ledger/',
        );
        const image = new URL('demo-overview.jpg', url);
        return Object.entries({
          'og:type': 'website',
          'og:title': 'The Lobster Ledger · Interactive demo',
          'og:description':
            'Make a friendly wager, switch bettors, and see who owes a lobster roll. Try the fictional ledger in your browser.',
          'og:url': url.href,
          'og:image': image.href,
          'og:image:alt':
            'The demo ledger showing rolls owed, recent wagers, and requests for approval.',
          'og:image:width': '1280',
          'og:image:height': '720',
        }).map(([property, content]) => ({ tag: 'meta', attrs: { property, content } }));
      },
    },
    {
      name: 'lobster-ledger-license',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'LICENSE.txt',
          source: readFileSync(new URL('./LICENSE', import.meta.url), 'utf8'),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD_PARTY_NOTICES.md',
          source: readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  build: {
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787', '/auth': 'http://127.0.0.1:8787' },
  },
});
