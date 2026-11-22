import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Member } from '../lib/types';
import { Avatar } from './ui';
import './account-menu.css';

export type AccountMenuItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Draws a divider above this item, to set a different kind of action apart. */
  separated?: boolean;
};

/**
 * The avatar in the topbar, as a menu button (WAI-ARIA menu button pattern): Enter, Space or the
 * arrow keys open it, the arrow keys, Home and End move through it, Escape closes it and hands focus
 * back to the avatar, and Tab or a click elsewhere simply dismisses it.
 */
export function AccountMenu({
  member,
  caption,
  items,
}: {
  member?: Member;
  caption: string;
  items: AccountMenuItem[];
}) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const choices = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    const list = choices();
    (open === 'last' ? list[list.length - 1] : list[0])?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }
  function triggerKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(event.key === 'ArrowUp' ? 'last' : 'first');
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const list = choices();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(true);
  }

  return (
    <div className="account-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="profile-button"
        aria-label={member ? `Account menu, ${member.name}` : 'Account menu'}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen('first'))}
        onKeyDown={triggerKeys}
      >
        <Avatar member={member} size={32} decorative />
      </button>
      {open && (
        <div className="account-menu-popover">
          <div className="account-menu-header">
            <Avatar member={member} size={36} decorative />
            <span>
              <strong>{member?.name}</strong>
              <small>{caption}</small>
            </span>
          </div>
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Account"
            className="account-menu-list"
            onKeyDown={menuKeys}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`account-menu-item ${item.separated ? 'account-menu-separated' : ''}`}
                onClick={() => {
                  // The menu is gone by the time the choice takes effect; the avatar stands in as the
                  // control a dialog or page change came from.
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
