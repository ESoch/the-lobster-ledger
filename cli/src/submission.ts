import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export class PendingSubmissions {
  constructor(
    private directory: string,
    private origin: string,
    private memberId: string,
  ) {}
  private async locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${path}.lock`;
    const deadline = Date.now() + 10_000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Another lobster command holds this submission lock. Close other commands and retry. If a command crashed, remove this lock only after confirming no lobster commands are running: ${lock}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
  async prepare(body: unknown): Promise<{ key: string; path: string }> {
    const digest = createHash('sha256')
      .update(canonical({ origin: this.origin, memberId: this.memberId, body }))
      .digest('hex');
    const path = join(this.directory, `${digest}.json`);
    return this.locked(path, async () => {
      const candidate = { key: randomUUID(), createdAt: Date.now() };
      try {
        await writeFile(path, JSON.stringify(candidate), { flag: 'wx', mode: 0o600 });
        return { key: candidate.key, path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const saved = JSON.parse(await readFile(path, 'utf8')) as { key: string; createdAt: number };
      if (!/^[\da-f-]{36}$/.test(saved.key) || !Number.isFinite(saved.createdAt))
        throw new Error(
          'The pending submission record is invalid. Check your ledger before trying another submission.',
        );
      return { key: saved.key, path };
    });
  }
  async complete(request: { key: string; path: string }): Promise<void> {
    await this.locked(request.path, async () => {
      try {
        const current = JSON.parse(await readFile(request.path, 'utf8')) as { key: string };
        // A late response for an old request must never erase a newer request's key.
        if (current.key === request.key) await unlink(request.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }
}
