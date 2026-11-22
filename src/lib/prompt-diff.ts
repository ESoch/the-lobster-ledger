import type { AuditEvent } from './types';

export interface PromptDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const PROPOSED = /^Proposed and approved ChatGPT prompt version (\d+)\. Exact prompt:\n([\s\S]*)$/;

/** Longest comparison worth running on a phone: a table of this many cells, at most. */
const MAX_CELLS = 250_000;

/** One line as a reader sees it: runs of spaces or tabs read as one space, trailing ones as none. */
const lineKey = (line: string) => line.replace(/[ \t]+/g, ' ').trimEnd();

/**
 * A prompt's wording without the spacing nobody can see, so a revision that only adds a trailing
 * space or a double space is the same prompt, not a new version both bettors must approve again.
 */
export function promptKey(text: string): string {
  return text.trim().replace(/\r\n?/g, '\n').split('\n').map(lineKey).join('\n');
}

/** The exact text of one prompt version, as the paper trail recorded it when it was proposed. */
export function promptTextOf(events: readonly AuditEvent[], version: number): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type !== 'propose_prompt') continue;
    const match = PROPOSED.exec(events[index].detail);
    if (match && Number(match[1]) === version) return match[2];
  }
  return undefined;
}

/**
 * The lines a revision kept, added and removed, in reading order. Returns null when the two
 * texts are too long to compare cheaply, so the caller can leave the comparison out.
 */
export function diffLines(before: string, after: string): PromptDiffLine[] | null {
  const old = before.split('\n');
  const next = after.split('\n');
  // Lines that differ only in spacing a reader cannot see count as unchanged.
  const oldKeys = old.map(lineKey);
  const nextKeys = next.map(lineKey);
  let start = 0;
  while (start < old.length && start < next.length && oldKeys[start] === nextKeys[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && oldKeys[oldEnd - 1] === nextKeys[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  const rows = oldEnd - start;
  const columns = nextEnd - start;
  if (rows * columns > MAX_CELLS) return null;
  // common[i][j]: the longest run the old lines from i and the new lines from j share.
  const common = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1));
  for (let i = rows - 1; i >= 0; i--)
    for (let j = columns - 1; j >= 0; j--)
      common[i][j] =
        oldKeys[start + i] === nextKeys[start + j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
  const lines: PromptDiffLine[] = old.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && oldKeys[start + i] === nextKeys[start + j]) {
      lines.push({ kind: 'same', text: old[start + i] });
      i++;
      j++;
    } else if (i < rows && (j === columns || common[i + 1][j] >= common[i][j + 1])) {
      lines.push({ kind: 'removed', text: old[start + i] });
      i++;
    } else {
      lines.push({ kind: 'added', text: next[start + j] });
      j++;
    }
  }
  return lines.concat(old.slice(oldEnd).map((text) => ({ kind: 'same', text })));
}

/** A run of unchanged lines, folded into its length. */
export interface PromptDiffGap {
  kind: 'gap';
  count: number;
}

/** The changed lines only, with each run of unchanged lines folded into a count. */
export function changedRows(lines: readonly PromptDiffLine[]): (PromptDiffLine | PromptDiffGap)[] {
  const rows: (PromptDiffLine | PromptDiffGap)[] = [];
  for (const line of lines) {
    const last = rows.at(-1);
    if (line.kind !== 'same') rows.push(line);
    else if (last?.kind === 'gap') last.count++;
    else rows.push({ kind: 'gap', count: 1 });
  }
  return rows;
}
