import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useId } from 'react';
import type { Member } from '../lib/types';
import { Avatar } from './ui';
import './member-switcher.css';

export function MemberSwitcher({
  members,
  memberId,
  onChange,
}: {
  members: Member[];
  memberId: string;
  onChange: (id: string) => void;
}) {
  const descriptionId = useId();
  const current = members.find((person) => person.id === memberId);

  return (
    <div className="demo-switcher">
      <span className="demo-switcher-label">Viewing as</span>
      <Select.Root value={memberId} onValueChange={onChange}>
        <Select.Trigger
          className="member-switcher-trigger"
          aria-label="Viewing as demo member"
          aria-describedby={descriptionId}
        >
          <span aria-hidden="true">
            <Avatar member={current} size={26} />
          </span>
          <span className="member-switcher-value">
            <Select.Value />
          </span>
          <Select.Icon className="member-switcher-chevron">
            <ChevronDown size={15} aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <span id={descriptionId} className="sr-only">
          Switch demo perspective to explore a member’s bets and approvals.
        </span>
        <Select.Portal>
          <Select.Content
            className="member-switcher-content"
            position="popper"
            align="end"
            sideOffset={8}
            collisionPadding={12}
          >
            <Select.ScrollUpButton className="member-switcher-scroll">
              <ChevronUp size={16} aria-hidden="true" />
            </Select.ScrollUpButton>
            <Select.Viewport className="member-switcher-viewport">
              <Select.Group>
                <Select.Label className="member-switcher-heading">Explore as a member</Select.Label>
                {members.map((person) => (
                  <Select.Item
                    className="member-switcher-item"
                    key={person.id}
                    value={person.id}
                    textValue={person.name}
                  >
                    <span aria-hidden="true">
                      <Avatar member={person} size={32} />
                    </span>
                    <Select.ItemText>{person.name}</Select.ItemText>
                    <Select.ItemIndicator className="member-switcher-check">
                      <Check size={17} strokeWidth={2.5} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Group>
            </Select.Viewport>
            <Select.ScrollDownButton className="member-switcher-scroll">
              <ChevronDown size={16} aria-hidden="true" />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
