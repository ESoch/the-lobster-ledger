import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, TriangleAlert, X } from 'lucide-react';
import './toast.css';

export type ToastTone = 'success' | 'error';
export interface ToastMessage {
  /** New for every call, so the same text shown twice is a new toast with a fresh timer. */
  id: number;
  text: string;
  tone: ToastTone;
}

/** Six seconds at least; longer lines get about 60ms a character so they can be read. */
export const toastDuration = (text: string) => Math.max(6000, 60 * text.length);

export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const counter = useRef(0);
  const show = useCallback(
    (text: string, tone: ToastTone = 'success') => setToast({ id: ++counter.current, text, tone }),
    [],
  );
  const dismiss = useCallback(() => setToast(null), []);
  return { toast, show, dismiss };
}

// The toast on screen. An open dialog keeps Tab inside itself, so its Escape dismisses this first.
let dismissShown: (() => void) | null = null;
/** Dismisses the toast on screen, if there is one, and says whether there was. */
export function dismissShownToast() {
  if (!dismissShown) return false;
  dismissShown();
  return true;
}
const dialogOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest('[role="dialog"]') : null;
/** A dialog shorter than this has under about 160px for its form, once its pinned heading and foot are counted. */
const CRAMPED_DIALOG = 240;
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function ToastCard({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Tab cannot reach the toast from inside a dialog, so moving through one with Tab holds it as
  // focusing it would, wherever it lies clear of the dialog; over the dialog it keeps its time, so
  // it never hides the dialog for long; nor does it where the dialog has shrunk to a sliver. The pointer, or focus back out of the dialog, lets it go.
  const [held, setHeld] = useState(false);
  const paused = hovered || focused || held;
  const remaining = useRef(toastDuration(toast.text));
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dismissShown = onDismiss;
    const hold = (event: KeyboardEvent) => {
      const dialog = dialogOf(event.target);
      if (event.key !== 'Tab' || !dialog || !card.current) return;
      const box = dialog.getBoundingClientRect();
      // A dialog squeezed to a sliver by the toast (a very short window) has about 60px of form
      // left: holding the toast there would keep it so for as long as Tab is used, so it runs out
      // and gives the room back. A box with no height is no layout at all (jsdom).
      const cramped = box.height > 0 && box.height < CRAMPED_DIALOG;
      if (!cramped && !overlaps(card.current.getBoundingClientRect(), box)) setHeld(true);
    };
    const release = () => setHeld(false);
    const leave = (event: FocusEvent) => {
      if (!dialogOf(event.target)) setHeld(false);
    };
    document.addEventListener('keydown', hold, true);
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('focusin', leave, true);
    return () => {
      if (dismissShown === onDismiss) dismissShown = null;
      document.removeEventListener('keydown', hold, true);
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('focusin', leave, true);
    };
  }, [onDismiss]);
  // The bet sheet pads its end by this much so its last entry scrolls clear of the toast, however
  // many lines the copy takes at this width (toast.css). Published as the toast shows, in step with
  // layout so the room is there the moment the toast is, and taken back when it goes.
  useLayoutEffect(() => {
    const node = card.current;
    if (!node) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(
        '--toast-height',
        `${Math.ceil(node.getBoundingClientRect().height)}px`,
      );
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--toast-height');
    };
  }, []);
  useEffect(() => {
    // Hovering or focusing the toast stops the clock; leaving gives back the time that was left.
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, onDismiss]);
  return (
    <div
      ref={card}
      className="toast"
      data-tone={toast.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {toast.tone === 'error' ? <TriangleAlert size={18} /> : <Check size={18} />}
      <span className="toast-text">{toast.text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={15} />
      </button>
    </div>
  );
}

/**
 * The one place notifications appear. It is portaled to <body>, outside the app root that dialogs
 * hide from assistive technology, and both live regions stay mounted so a change in them is
 * announced. Errors go to the assertive region, everything else to the polite one.
 */
export function ToastRegion({
  toast,
  onDismiss,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
}) {
  const card = toast && <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />;
  const error = toast?.tone === 'error';
  return createPortal(
    <div className="toast-region">
      <div role="status" aria-live="polite" aria-atomic="true">
        {error ? null : card}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {error ? card : null}
      </div>
    </div>,
    document.body,
  );
}
