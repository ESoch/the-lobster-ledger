import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { LobsterMark } from './Brand';

/** How long the opening screen stays quiet before it admits the ledger is slow and offers a retry. */
export const STILL_OPENING_MS = 8_000;

/**
 * The screen while the ledger opens. Its words live in one status region, so a screen reader hears
 * them, and hears them change when the wait runs long. Try again appears then; using it hands focus
 * to those words and starts the count over.
 */
export function LoadingScreen({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  const [run, setRun] = useState(0);
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), STILL_OPENING_MS);
    return () => clearTimeout(timer);
  }, [run]);
  return (
    <main className="loading-screen">
      <LobsterMark size={48} />
      <LoaderCircle size={22} className="spinner" aria-hidden="true" />
      <div role="status" className="loading-status" tabIndex={-1} ref={status}>
        {slow
          ? 'Still opening the ledger… This is taking longer than usual.'
          : 'Opening the ledger…'}
      </div>
      {slow && (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            // The button goes away with the slow notice, so focus stays on the screen's own words.
            status.current?.focus({ preventScroll: true });
            setSlow(false);
            setRun((count) => count + 1);
            onRetry();
          }}
        >
          Try again
        </button>
      )}
    </main>
  );
}
