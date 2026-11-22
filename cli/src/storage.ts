import type { Credentials, SessionStore } from './auth';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeOrigin } from './auth';
type VaultEntry = {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function dataRoot(): string {
  return join(homedir(), '.lobster-ledger');
}
export class CredentialStore implements SessionStore {
  readonly directory: string;
  private readonly service: string;
  constructor(
    origin: string,
    root = dataRoot(),
    private entryFactory?: (service: string, account: string) => VaultEntry,
  ) {
    origin = normalizeOrigin(origin);
    this.service = `Lobster Ledger CLI ${origin}`;
    this.directory = join(root, createHash('sha256').update(origin).digest('hex').slice(0, 24));
  }
  private async entry(memberId: string): Promise<VaultEntry> {
    try {
      if (this.entryFactory) return this.entryFactory(this.service, memberId);
      const { Entry } = await import('@napi-rs/keyring');
      return new Entry(this.service, memberId, { linux: { store: 'secret-service' } });
    } catch {
      throw new Error(
        'Your operating system credential store is unavailable. Unlock Keychain, Credential Manager, or Linux Secret Service and retry. Tokens will not be saved to a plaintext file.',
      );
    }
  }
  private async member(): Promise<string | undefined> {
    try {
      const metadata = JSON.parse(await readFile(join(this.directory, 'account.json'), 'utf8')) as {
        memberId?: unknown;
      };
      if (typeof metadata.memberId !== 'string') throw new Error('Invalid local account metadata.');
      return metadata.memberId;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  async read(): Promise<Credentials | undefined> {
    const memberId = await this.member();
    if (!memberId) return undefined;
    try {
      const raw = (await this.entry(memberId)).getPassword();
      if (!raw) return undefined;
      const value = JSON.parse(raw) as Credentials;
      if (
        typeof value.accessToken !== 'string' ||
        typeof value.refreshToken !== 'string' ||
        !Number.isFinite(value.expiresAt) ||
        value.member?.id !== memberId ||
        typeof value.member.name !== 'string' ||
        typeof value.sessionId !== 'string'
      )
        throw new Error('Invalid saved session.');
      return value;
    } catch {
      throw new Error(
        'Could not read your session from the operating system credential store. Unlock it and retry.',
      );
    }
  }
  async write(value: Credentials): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entry = await this.entry(value.member.id);
    try {
      entry.setPassword(JSON.stringify(value));
    } catch {
      throw new Error(
        'Could not save the session in your operating system credential store. Unlock it and retry.',
      );
    }
    const path = join(this.directory, 'account.json');
    const temporary = `${path}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ memberId: value.member.id }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  }
  async clear(): Promise<void> {
    const memberId = await this.member();
    if (!memberId) return;
    try {
      (await this.entry(memberId)).deletePassword();
    } catch {
      throw new Error(
        'Could not remove the saved credential. Unlock your operating system credential store and retry logout.',
      );
    }
    await unlink(join(this.directory, 'account.json')).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'session.lock');
    const deadline = Date.now() + 25_000;
    let handle;
    while (!handle) {
      try {
        handle = await open(path, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Another lobster command holds the session lock. Close other lobster commands and retry. If an earlier command crashed, remove this lock only after confirming no lobster commands are running: ${path}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await unlink(path);
    }
  }
}
