import type { BetEntrySource } from './types';

export function entrySourceLabel(
  source?: BetEntrySource,
  inferred = false,
  reported = false,
): string {
  const labels = { browser: 'Browser', cli: 'CLI', mcp: 'MCP' };
  const label = source ? (labels[source] ?? 'Not recorded') : 'Not recorded';
  if (source && reported) return `${label} (reported)`;
  return source && inferred ? `${label} (inferred)` : label;
}
