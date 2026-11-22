export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTPS origin without a path, query, or credentials. Local development may use http://127.0.0.1:<port>.',
    );
  return url.origin;
}
