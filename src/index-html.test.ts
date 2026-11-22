import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const page = readFile(new URL('../index.html', import.meta.url), 'utf8');

describe('the app shell page', () => {
  it('tells visitors without JavaScript what is missing instead of showing a blank page', async () => {
    const html = await page;
    const body = html.slice(html.indexOf('<body'));
    const message = /<noscript>\s*<main class="no-js">([\s\S]*?)<\/main>\s*<\/noscript>/.exec(body);
    expect(message, 'a <noscript> message in the body').toBeTruthy();
    expect(message![1]).toContain('<h1>The Lobster Ledger needs JavaScript.</h1>');
    expect(message![1]).toMatch(/Turn JavaScript on[^<]*reload/);
    // It sits beside the app's mount point, which stays first and empty for React.
    expect(body.indexOf('<div id="root"></div>')).toBeGreaterThan(-1);
    expect(body.indexOf('<div id="root"></div>')).toBeLessThan(body.indexOf('<noscript>'));
  });

  it('styles that message itself in both colour schemes, since the app styles need script', async () => {
    const html = await page;
    const head = html.slice(0, html.indexOf('</head>'));
    const style = /<noscript>\s*<style>([\s\S]*?)<\/style>\s*<\/noscript>/.exec(head)?.[1];
    expect(style, 'a <noscript><style> in the head').toBeTruthy();
    expect(style).toContain('.no-js');
    expect(style).toContain('prefers-color-scheme: dark');
    expect(style).toContain('min-height');
  });
});
