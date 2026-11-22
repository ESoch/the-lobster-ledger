import { Fragment, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, Copy } from 'lucide-react';

export const COPY_RESET_MS = 2000;
export const COPY_FAILED = 'Copying isn’t available here. Select and copy the text above.';

// Long addresses and inline JSON may wrap after "/" (keeping "//" together), "," or "{", or before
// a "." that starts a host label or extension. Nothing else inside a token ever breaks.
const BREAKS = /(?<=[/,{])(?!\/)|(?=\.[A-Za-z])/;

function tokenParts(token: string) {
  return token.length > 20 ? token.split(BREAKS).filter(Boolean) : [token];
}

/**
 * Renders a command so it wraps only between words: flags such as `--dry-run` and file names stay
 * whole, and long URLs or JSON wrap at their natural joints. The text content is unchanged.
 */
export function CommandText({ value }: { value: string }) {
  return (
    <>
      {value.split(/( +)/).map((part, index) => {
        if (!part.trim()) return part;
        const parts = tokenParts(part);
        if (parts.length === 1)
          return (
            <span className="cli-token" key={index}>
              {part}
            </span>
          );
        return (
          <span className="cli-token cli-token-long" key={index}>
            {parts.map((segment, at) => (
              <Fragment key={at}>
                {at > 0 && <wbr />}
                <span className="cli-token-part">{segment}</span>
              </Fragment>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** A command quoted in running text, wrapping only between its words. */
export function InlineCommand({ value }: { value: string }) {
  return (
    <code>
      <CommandText value={value} />
    </code>
  );
}

/** One copyable command for both connection guides: same strings, one timer, a reserved status line. */
export function CopyBlock({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    window.clearTimeout(timer.current);
    setStatus('idle');
  }, [value]);
  async function copy() {
    window.clearTimeout(timer.current);
    // Empty the live region first so a second copy is announced again.
    flushSync(() => setStatus('idle'));
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
      timer.current = window.setTimeout(() => setStatus('idle'), COPY_RESET_MS);
    } catch {
      setStatus('failed');
    }
  }
  return (
    <div className="cli-command-wrap">
      <div className="cli-command">
        <pre>
          <code>
            <CommandText value={value} />
          </code>
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          {status === 'copied' ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <Copy size={17} aria-hidden="true" />
          )}
        </button>
      </div>
      <span className={`cli-copy-status${status === 'failed' ? ' is-error' : ''}`} role="status">
        {status === 'copied' ? 'Copied' : status === 'failed' ? COPY_FAILED : ''}
      </span>
    </div>
  );
}
