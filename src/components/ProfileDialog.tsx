import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/client';
import { LIMITS } from '../lib/limits';
import { memberNameProblem, normalizeMemberName } from '../lib/member-name';
import type { Member } from '../lib/types';
import { FieldError, FieldErrorsProvider, useFieldErrors } from './form-errors';
import { Modal, ModalCancel } from './ui';

export function ProfileDialog({
  member,
  members,
  onSave,
  onClose,
}: {
  member: Member;
  members: Member[];
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(member.name);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fields = useFieldErrors();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    setError('');
    const problem = memberNameProblem(
      name,
      members.filter((other) => other.id !== member.id),
    );
    if (problem && input.current) {
      fields.show([{ name: 'name', message: problem, element: input.current }]);
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      await onSave(normalizeMemberName(name));
      onClose();
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        [400, 422].includes(reason.status) &&
        input.current?.isConnected
      )
        fields.show([{ name: 'name', message: reason.message, element: input.current }]);
      else setError(reason instanceof Error ? reason.message : 'Unable to save your display name.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Edit profile"
      description="Choose the display name people see on your profile and bets."
      dirty={!busy && normalizeMemberName(name) !== member.name}
      onClose={() => {
        if (!saving.current) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (saving.current) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (saving.current) event.preventDefault();
      }}
    >
      <form className="bet-form" onSubmit={submit} noValidate>
        <FieldErrorsProvider value={fields}>
          <div className="field">
            <label>
              Display name
              <input
                ref={input}
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  fields.clear('name');
                  setError('');
                }}
                required
                minLength={LIMITS.memberName.min}
                maxLength={LIMITS.memberName.max}
                autoComplete="nickname"
                autoFocus
                readOnly={busy}
                {...fields.aria('name')}
              />
            </label>
            <FieldError name="name" alert />
          </div>
          <div className="modal-footer">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <ModalCancel disabled={busy} />
            <button
              className="button button-primary"
              type="submit"
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </FieldErrorsProvider>
      </form>
    </Modal>
  );
}
