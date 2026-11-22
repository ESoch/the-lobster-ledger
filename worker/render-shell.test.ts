import { describe, expect, it } from 'vitest';
import { breakableAddress } from './render-shell';

const rendered = async (address: string) => (await breakableAddress(address)).toString();
const joints = async (address: string) => (await rendered(address)).split('<wbr>');

describe('breakableAddress', () => {
  it('breaks after a slash, a question mark and an ampersand, and before a dotted label', async () => {
    expect(await joints('https://claude.ai/api/mcp/auth_callback?code=1&state=2')).toEqual([
      'https://',
      'claude',
      '.ai/',
      'api/',
      'mcp/',
      'auth_callback?',
      'code=1&amp;',
      'state=2',
    ]);
  });

  it('keeps the two slashes of a scheme together, and an address with no joint whole', async () => {
    expect(await joints('http://127.0.0.1:53682/callback')).toEqual([
      'http://',
      '127.0.0.1:53682/',
      'callback',
    ]);
    expect(await joints('x')).toEqual(['x']);
  });

  it('escapes every part, so an address can never inject markup', async () => {
    const text = await rendered('https://a.example/<script>alert("1")</script>');
    expect(text).not.toContain('<script>');
    expect(text.replaceAll('<wbr>', '')).toBe(
      'https://a.example/&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;',
    );
  });
});
