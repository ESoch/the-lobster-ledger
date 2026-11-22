import * as Dialog from '@radix-ui/react-dialog';
import {
  X,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleDot,
  CircleMinus,
  CircleX,
  ClipboardCheck,
  Clock3,
  FilePenLine,
  Handshake,
  History,
  PackageCheck,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import type { BetStatus, Member } from '../lib/types';
import { betStatusNames, type BetStatusVariant } from '../lib/bet-workflow';
import { avatarColors } from '../lib/avatar-colors';
import { clearPinnedParts } from './pinned';
import { dismissShownToast } from './Toast';

export const statusNames: Record<BetStatus, string> = betStatusNames;
// Each status and each variant has its own icon, so two chips never share both a tone and a glyph.
const statusIcons: Record<BetStatus, LucideIcon> = {
  pending: Clock3,
  confirming: ClipboardCheck,
  active: CircleDot,
  owed: Handshake,
  settling: PackageCheck,
  settled: Check,
  voided: CircleMinus,
  declined: CircleX,
};
const variantIcons: Record<BetStatusVariant, LucideIcon> = {
  history: History,
  correction: FilePenLine,
  offset: ArrowLeftRight,
  withdrawn: Undo2,
};
export function StatusBadge({
  status,
  label,
  variant,
}: {
  status: BetStatus;
  label?: string;
  /** Set when the chip says more than the plain status: history, a correction, an offset or a withdrawal. */
  variant?: BetStatusVariant;
}) {
  const Icon = variant ? variantIcons[variant] : statusIcons[status];
  return (
    <span className={`status-badge status-${status}${variant ? ` status-${variant}` : ''}`}>
      <Icon size={12} aria-hidden="true" />
      {label ?? statusNames[status]}
    </span>
  );
}
export function Avatar({
  member,
  size = 32,
  decorative = false,
}: {
  member?: Member;
  size?: number;
  /** The name is written next to it, so assistive technology skips the initials. */
  decorative?: boolean;
}) {
  // The stored colour is kept when an ink reaches 4.5:1 on it, darkened when neither does.
  const { background, color } = avatarColors(member?.color);
  // With no member there is no name to give, so the placeholder is decorative too.
  const hidden = decorative || !member;
  return (
    <span
      className="avatar"
      aria-hidden={hidden || undefined}
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : member.name}
      title={hidden ? undefined : member.name}
      style={{
        width: size,
        height: size,
        backgroundColor: background,
        color,
        // 11px is the floor for initials; the 12px type floor does not apply inside a small circle.
        fontSize: size > 40 ? 16 : size >= 30 ? 12 : 11,
      }}
    >
      {member?.initials ?? '?'}
    </span>
  );
}
type DialogContentProps = ComponentProps<typeof Dialog.Content>;
/** What an Escape handler can do about unsaved input: see whether the question shows, and ask it. */
export interface DiscardGuard {
  /** The Discard or Keep editing question is already on screen. */
  asking: boolean;
  /** Asks first; Discard then runs `discard` (instead of closing the dialog), Keep editing does nothing. */
  ask: (discard: () => void) => void;
}
/**
 * Leaving an open dialog from outside it, such as the Back button or a typed #hash: runs `leave` and
 * returns true, or, while the dialog holds unsaved input, asks Discard or Keep editing first (Discard
 * runs `leave`) and returns false. A dialog that is busy recording a change returns false too.
 */
export type LeaveRequest = (leave: () => void) => boolean;
// The dialog's own way out, so a Cancel button inside it asks about unsaved input like Close does.
const RequestClose = createContext<(() => void) | null>(null);
// The dialog's question about unsaved input, for a Cancel that closes only one part of it.
const AskDiscard = createContext<DiscardGuard['ask'] | null>(null);
/**
 * The Cancel of a form in a dialog: it closes, or asks first when the dialog holds unsaved input.
 * Given `onCancel`, it leaves only that part (an inline form in a sheet), asking first when `dirty`.
 */
export function ModalCancel({
  children = 'Cancel',
  onCancel,
  dirty = false,
  disabled,
}: {
  children?: ReactNode;
  onCancel?: () => void;
  dirty?: boolean;
  disabled?: boolean;
}) {
  const requestClose = useContext(RequestClose);
  const ask = useContext(AskDiscard);
  return (
    <button
      type="button"
      className="button button-secondary"
      disabled={disabled}
      onClick={() => {
        if (!onCancel) requestClose?.();
        else if (dirty && ask) ask(onCancel);
        else onCancel();
      }}
    >
      {children}
    </button>
  );
}
/** Moves focus to the page's main heading, which is the next best place when an opener is gone. */
export function focusPageHeading() {
  const heading =
    document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1');
  if (!heading) return false;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
  return true;
}
// Safari and Firefox on macOS do not focus a button when it is clicked, so a dialog opened with the
// mouse finds <body> focused. The control that was just clicked stands in for it.
let lastClick: { element: HTMLElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'click',
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('button, a[href], summary, [role="button"]')
          : null;
      lastClick = target ? { element: target, at: Date.now() } : null;
    },
    true,
  );
}
/** The control a dialog is being opened from: the focused element, or what was just clicked. */
export function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  const click = lastClick;
  return click && click.element.isConnected && Date.now() - click.at < 1000 ? click.element : null;
}
// What opened each dialog. A dialog opened from inside another one (a New bet form that opens the new
// bet's sheet) falls back to the outer dialog's opener once its own control has gone.
const dialogOpeners = new WeakMap<Element, HTMLElement>();
export function rememberDialogOpener(
  dialog: Element | null | undefined,
  opener: HTMLElement | null,
) {
  if (dialog && opener) dialogOpeners.set(dialog, opener);
}
// Focus cannot land on a control that is gone or inside an inert region such as the closed drawer.
const canTakeFocus = (element: HTMLElement | null): element is HTMLElement =>
  !!element && element.isConnected && !element.closest('[inert]');
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  sheet = false,
  wide = false,
  dirty = false,
  onEscapeKeyDown,
  onInteractOutside,
  onOpenAutoFocus,
  fallbackFocus,
  leaveRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  sheet?: boolean;
  wide?: boolean;
  /** Unsaved input: Escape, outside clicks and Close ask Discard or Keep editing first. */
  dirty?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent, guard: DiscardGuard) => void;
  onInteractOutside?: DialogContentProps['onInteractOutside'];
  /** Runs as the dialog opens, before it focuses its first control; prevent it to focus elsewhere. */
  onOpenAutoFocus?: DialogContentProps['onOpenAutoFocus'];
  /** Where focus lands on close when the control that opened the dialog is gone, before the page heading. */
  fallbackFocus?: () => HTMLElement | null;
  /** Filled while the dialog is open with its way out from outside it, which asks as Close does. */
  leaveRef?: RefObject<LeaveRequest | null>;
}) {
  // Remember what had focus when the dialog opened so closing can hand it back. This is read while
  // rendering, because an autoFocus field inside the dialog takes focus before any effect runs.
  const opener = useRef<HTMLElement | null>(null);
  const outerOpener = useRef<HTMLElement | null>(null);
  const openedOn = useRef('');
  const wasOpen = useRef(false);
  // The last control inside the dialog that had focus, which is what Keep editing goes back to.
  const lastFocus = useRef<HTMLElement | null>(null);
  if (open && !wasOpen.current) {
    opener.current = currentOpener();
    const outer = opener.current?.closest('[role="dialog"]');
    outerOpener.current = (outer && dialogOpeners.get(outer)) || null;
    openedOn.current = window.location.hash;
    lastFocus.current = null;
  }
  wasOpen.current = open;
  // The question about unsaved input, with what Discard does: close the dialog, or a part of it.
  const [asking, setAsking] = useState<{ discard: () => void } | null>(null);
  const fieldFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || !dirty) setAsking(null);
  }, [open, dirty]);
  function ask(discard: () => void) {
    // A mouse press takes focus off the field before the dialog hears about the click, so the
    // field to go back to is the last one that had it, not whatever has focus now.
    if (!asking)
      fieldFocus.current = lastFocus.current?.isConnected
        ? lastFocus.current
        : (document.activeElement as HTMLElement | null);
    setAsking({ discard });
  }
  function requestClose() {
    if (!dirty) return onClose();
    ask(onClose);
  }
  useLayoutEffect(() => {
    if (!leaveRef || !open) return;
    leaveRef.current = (leave) => {
      if (!dirty) {
        leave();
        return true;
      }
      ask(leave);
      return false;
    };
    return () => {
      leaveRef.current = null;
    };
  });
  useEffect(() => {
    if (!open || !dirty) return;
    // Reloading or closing the tab would lose the input too, so the browser asks its own question.
    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [open, dirty]);
  function keepEditing() {
    setAsking(null);
    if (fieldFocus.current?.isConnected) fieldFocus.current.focus();
  }
  function returnFocus() {
    // Radix hands focus back after the page has already moved. A link inside the dialog that went
    // to another page must leave the reader on that page's heading, not on the old page's opener.
    if (window.location.hash !== openedOn.current) return void focusPageHeading();
    for (const target of [opener.current, outerOpener.current]) {
      if (!canTakeFocus(target)) continue;
      target.focus();
      if (document.activeElement === target) return;
    }
    // Neither opener can take focus (gone, hidden or inert): the page may name a better place,
    // such as the note that records what the dialog just did, before the page heading.
    const fallback = fallbackFocus?.() ?? null;
    if (canTakeFocus(fallback)) {
      fallback.focus();
      if (document.activeElement === fallback) return;
    }
    focusPageHeading();
  }
  const discardQuestion = asking && (
    <div className="modal-discard" role="alert">
      <p>Discard what you have entered? Nothing here has been saved.</p>
      <div>
        <button type="button" className="button button-primary" onClick={keepEditing} autoFocus>
          Keep editing
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setAsking(null);
            asking.discard();
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) requestClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          ref={(node) => rememberDialogOpener(node, opener.current)}
          className={`modal-content ${sheet ? 'detail-sheet' : ''} ${wide ? 'modal-wide' : ''}`}
          onFocusCapture={(event) => clearPinnedParts(event.currentTarget, event.target)}
          onOpenAutoFocus={onOpenAutoFocus}
          onFocus={(event) => {
            // A control of the dialog itself: not the dialog's own box, the question, or a popup.
            const target = event.target;
            if (
              target instanceof HTMLElement &&
              target !== event.currentTarget &&
              event.currentTarget.contains(target) &&
              !target.closest('.modal-discard')
            )
              lastFocus.current = target;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
          onEscapeKeyDown={(event) => {
            // Tab cannot reach a notification from inside the dialog, so Escape dismisses it first.
            if (dismissShownToast()) return event.preventDefault();
            onEscapeKeyDown?.(event, { asking: !!asking, ask });
            if (asking && !event.defaultPrevented) {
              event.preventDefault();
              keepEditing();
            }
          }}
          onInteractOutside={(event) => {
            // Notifications sit outside the dialog; using one must not close it.
            if ((event.target as Element | null)?.closest?.('.toast-region, .toast')) {
              event.preventDefault();
            }
            onInteractOutside?.(event);
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {/* A sheet already shows its own heading, so its description is for assistive technology. */}
              <Dialog.Description
                className={description && !sheet ? 'modal-description' : 'sr-only'}
              >
                {description ?? 'Review and manage this ledger record.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={20} />
            </Dialog.Close>
            {/* A sheet pins its heading, so the question joins it there, below Close, rather than
                being pinned over it once the sheet is scrolled. */}
            {sheet && discardQuestion}
          </div>
          {!sheet && discardQuestion}
          <RequestClose.Provider value={requestClose}>
            <AskDiscard.Provider value={ask}>{children}</AskDiscard.Provider>
          </RequestClose.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
  as: Heading = 'h3',
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  /** The heading level, so a state that sits directly under the page title is not an h3 beneath an h1. */
  as?: 'h2' | 'h3' | 'h4';
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <Heading>{title}</Heading>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function SectionTitle({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action && (
        <button className="text-button" onClick={onAction}>
          {action}
          <ArrowUpRight size={15} />
        </button>
      )}
    </div>
  );
}
/**
 * "Oct 1". Pass `{ year: true }` where the date stands alone, such as a decision date on a record,
 * or `now` to add the year only when the date falls in another year ("Oct 1, 2025").
 */
export const dateLabel = (
  value: string,
  yearOrNow?: { year: boolean } | string | number | Date,
) => {
  const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
  const withYear =
    yearOrNow === undefined
      ? false
      : typeof yearOrNow === 'object' && !(yearOrNow instanceof Date)
        ? yearOrNow.year
        : date.getFullYear() !== new Date(yearOrNow).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
};
export const timeLabel = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
