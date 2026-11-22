import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import type { Bet, DebtOffsetPreview, LedgerState } from '../lib/types';
import { getDirectDebts, getRemainingRolls, needsAction, previewDebtOffset } from '../lib/ledger';
import { hasDebt, parties } from '../lib/rolls';
import { plural } from '../lib/plural';
import { Avatar, Modal, SectionTitle, StatusBadge, timeLabel } from './ui';
import { BetLink } from './BetLink';

/** What is still owed between two people, optionally counting only bets in the given statuses. */
function pairPosition(
  bets: Bet[],
  memberId: string,
  otherId: string,
  statuses: Bet['status'][] = ['owed', 'settling'],
) {
  const debts = bets.filter(
    (bet) =>
      statuses.includes(bet.status) &&
      hasDebt(bet) &&
      parties(bet).includes(memberId) &&
      parties(bet).includes(otherId) &&
      getRemainingRolls(bet) > 0,
  );
  const total = (winnerId: string) =>
    debts
      .filter((bet) => bet.resolution!.winnerId === winnerId)
      .reduce((sum, bet) => sum + getRemainingRolls(bet), 0);
  return {
    owedToYou: total(memberId),
    youOwe: total(otherId),
    bets: debts.length,
    delivering: debts.some((bet) => bet.status === 'settling'),
    // A reported delivery that is waiting on this member's confirmation.
    confirming: debts.some((bet) => bet.status === 'settling' && needsAction(bet, memberId)),
  };
}

export function DebtOffsets({
  state,
  memberId,
  onApply,
  onOpenBet,
}: {
  state: LedgerState;
  memberId: string;
  onApply: (preview: DebtOffsetPreview) => Promise<void>;
  /** Opens a bet's sheet in place; the history links use it instead of leaving the page. */
  onOpenBet: (betId: string) => void;
}) {
  const [review, setReview] = useState<{ input: DebtOffsetPreview; bets: Bet[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  // The toast fades after a few seconds; this stays until the next review begins.
  const [applied, setApplied] = useState<{ counterpartyId: string; rolls: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const reviewOpener = useRef<HTMLButtonElement | null>(null);
  // The ledger can catch up after the review has closed and handed focus back to its opener. When
  // that opener then leaves the list, focus would fall to the page, so land on the confirmation.
  useEffect(() => {
    const opener = reviewOpener.current;
    if (!applied || !opener || opener.isConnected) return;
    reviewOpener.current = null;
    if (!document.activeElement || document.activeElement === document.body)
      confirmation.current?.focus();
  }, [applied, state.bets]);
  const person = (id: string) => state.members.find((member) => member.id === id);
  const name = (id: string) => person(id)?.name ?? 'Member';
  const others = state.members.filter((member) => member.id !== memberId);
  const suggestions = others.flatMap((member) => {
    const preview = previewDebtOffset(state.bets, memberId, member.id);
    return preview ? [preview] : [];
  });
  // Debts both ways that cannot be offset yet: a delivery on one side is still being confirmed.
  const unavailable = others.flatMap((member) => {
    if (suggestions.some((input) => input.counterpartyId === member.id)) return [];
    const position = pairPosition(state.bets, memberId, member.id);
    return position.owedToYou && position.youOwe && position.delivering
      ? [{ counterpartyId: member.id, confirming: position.confirming }]
      : [];
  });
  const current = review && previewDebtOffset(state.bets, memberId, review.input.counterpartyId);
  const stale = !!review && JSON.stringify(current) !== JSON.stringify(review.input);
  // Say what is true now: another offset may still exist, or the pair may no longer qualify.
  const staleMessage = review
    ? current
      ? `Debts with ${name(review.input.counterpartyId)} changed while you were reviewing, so these numbers are out of date. Close this review and open it again from the card to see the current offset.`
      : `Debts with ${name(review.input.counterpartyId)} changed while you were reviewing, and no offset is available right now. Close this review. The card lists an offset again if one becomes possible.`
    : '';
  const offsets = [
    ...new Map(
      state.bets.flatMap((bet) =>
        (bet.offsets ?? [])
          .filter((offset) => [offset.actorId, offset.counterpartyId].includes(memberId))
          .map((offset) => [offset.id, offset] as const),
      ),
    ).values(),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!suggestions.length && !unavailable.length && !review && !offsets.length) return null;

  async function apply() {
    if (!review || busy || stale || failed) return;
    setBusy(true);
    setError('');
    try {
      await onApply(review.input);
      setApplied({ counterpartyId: review.input.counterpartyId, rolls: review.input.rolls });
      setHistoryOpen(true);
      setReview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to apply the offset.');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const pairDebts = review
    ? getDirectDebts(review.bets).filter(
        (debt) =>
          [debt.fromId, debt.toId].includes(memberId) &&
          [debt.fromId, debt.toId].includes(review.input.counterpartyId),
      )
    : [];
  // The reviewed bets, split by who owes whom, in the order the offset uses them.
  const reviewed = review
    ? review.input.allocations.map((item) => ({
        item,
        bet: review.bets.find((bet) => bet.id === item.betId)!,
      }))
    : [];
  const groups = review
    ? [
        {
          key: 'incoming',
          title: `${name(review.input.counterpartyId)} owes you`,
          debt: pairDebts.find((debt) => debt.toId === memberId),
          items: reviewed.filter(({ bet }) => bet.resolution?.winnerId === memberId),
        },
        {
          key: 'outgoing',
          title: `You owe ${name(review.input.counterpartyId)}`,
          debt: pairDebts.find((debt) => debt.fromId === memberId),
          items: reviewed.filter(({ bet }) => bet.resolution?.winnerId !== memberId),
        },
      ]
    : [];
  // Once the review closes its opener is usually gone (the pair left the list), so focus lands on
  // what the dialog just did: the lasting confirmation, or failing that the card itself.
  const landingAfterClose = () => {
    if (confirmation.current) return confirmation.current;
    const heading = panel.current?.querySelector<HTMLElement>('h2') ?? null;
    if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    return heading;
  };
  const position = (counterpartyId: string, statuses?: Bet['status'][]) => {
    const { owedToYou, youOwe, bets } = pairPosition(
      state.bets,
      memberId,
      counterpartyId,
      statuses,
    );
    return {
      owedToYou,
      youOwe,
      bets,
      line: `${name(counterpartyId)} owes you ${plural(owedToYou, 'roll')} · you owe ${plural(youOwe, 'roll')}`,
    };
  };
  return (
    <section className="panel debt-offsets" ref={panel}>
      <SectionTitle
        title="Offset mutual debts"
        subtitle="Either bettor can offset equal amounts owed to each other. No second approval needed. An offset is permanent and stays on record."
      />
      {applied && (
        <p className="offset-applied" ref={confirmation} tabIndex={-1}>
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            Offset recorded with {name(applied.counterpartyId)}: {plural(applied.rolls, 'roll')} in
            each direction. It is on every affected bet and at the top of the history below.
          </span>
        </p>
      )}
      {suggestions.map((input) => {
        const { line, bets } = position(input.counterpartyId, ['owed']);
        return (
          <div className="person-balance offset-suggestion" key={input.counterpartyId}>
            <span className="balance-avatar" aria-hidden="true">
              <Avatar member={person(input.counterpartyId)} size={42} />
            </span>
            <div>
              <strong>{name(input.counterpartyId)}</strong>
              <span>{`${line} · ${plural(bets, 'bet')}`}</span>
            </div>
            <button
              className="button button-secondary"
              aria-label={`Review offset with ${name(input.counterpartyId)}`}
              onClick={(event) => {
                reviewOpener.current = event.currentTarget;
                setReview({ input, bets: structuredClone(state.bets) });
                setApplied(null);
                setError('');
                setFailed(false);
              }}
            >
              Review offset
            </button>
          </div>
        );
      })}
      {unavailable.map(({ counterpartyId, confirming }) => (
        <div className="person-balance offset-suggestion offset-unavailable" key={counterpartyId}>
          <span className="balance-avatar" aria-hidden="true">
            <Avatar member={person(counterpartyId)} size={42} />
          </span>
          <div>
            <strong>{name(counterpartyId)}</strong>
            <span>{position(counterpartyId).line}</span>
            <span>
              Not available while a delivery on one of these bets is waiting for confirmation.
              {confirming && ' It is yours to confirm.'}
            </span>
          </div>
        </div>
      ))}
      <div className="balance-disclaimer">
        <ShieldCheck size={16} aria-hidden="true" />
        <p>
          Only confirmed debts between the same two people qualify. Bets awaiting delivery
          confirmation are excluded. No debts involving someone else can be used.
        </p>
      </div>
      {offsets.length > 0 && (
        <details
          className="offset-history"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary>Offset history ({offsets.length})</summary>
          <ul>
            {offsets.map((offset) => (
              <li className="offset-entry" key={offset.id}>
                <p>
                  <strong>{name(offset.actorId)}</strong> offset {plural(offset.rolls, 'roll')} in
                  each direction with {name(offset.counterpartyId)}.{' '}
                  <time dateTime={offset.at}>{timeLabel(offset.at)}</time>
                </p>
                <ul>
                  {offset.allocations.map((item) => {
                    const winnerId = state.bets.find((bet) => bet.id === item.betId)?.resolution
                      ?.winnerId;
                    return (
                      <li key={item.betId}>
                        <BetLink betId={item.betId} onOpen={onOpenBet}>
                          {offset.references[item.betId]}
                        </BetLink>
                        {winnerId && ` · ${name(winnerId)} won`} · {item.rolls} offset
                      </li>
                    );
                  })}
                </ul>
                <small>
                  <span title={offset.id}>Offset {offset.id.slice(0, 8)}</span>. No physical
                  delivery recorded.
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {review && (
        <Modal
          open
          onClose={() => {
            if (!busy) setReview(null);
          }}
          title={`Offset debts with ${name(review.input.counterpartyId)}`}
          fallbackFocus={landingAfterClose}
          description={
            stale
              ? 'These debts have changed, so this review can no longer be applied.'
              : 'Review the affected bets. This settles equal amounts in both directions immediately and cannot be undone.'
          }
        >
          <div className="offset-review">
            {(error || stale) && (
              <p className="form-error" role="alert">
                {error || staleMessage}
              </p>
            )}
            {!stale && (
              <>
                <p>
                  <strong>Offset {plural(review.input.rolls, 'roll')} in each direction.</strong>{' '}
                  Oldest debts are used first.
                </p>
                {groups
                  .filter((group) => group.items.length)
                  .map((group) => (
                    <section className="offset-review-group" key={group.key}>
                      <h3>
                        {group.title}
                        {group.debt &&
                          `: ${group.debt.rolls} → ${group.debt.rolls - review.input.rolls} remaining`}
                      </h3>
                      <ul>
                        {group.items.map(({ item, bet }) => {
                          const remaining = getRemainingRolls(bet) - item.rolls;
                          return (
                            <li key={item.betId}>
                              <strong>
                                {bet.reference}: {bet.title}
                              </strong>
                              <span>
                                {item.rolls} offset · {remaining} remaining
                              </span>
                              {remaining === 0 ? (
                                <StatusBadge status="settled" label="Settled by offset" />
                              ) : (
                                <StatusBadge status="owed" label="Partly offset" />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                <p>
                  The offset is permanent and is recorded on every affected bet. Both people can
                  review it in their offset history. Wins and original stakes stay on record. This
                  does not report delivery of any rolls.
                </p>
              </>
            )}
            <div className="modal-footer">
              {stale ? (
                // Keyed so it mounts afresh and takes focus; otherwise React would reuse "Not now".
                <button
                  key="close"
                  className="button button-secondary"
                  autoFocus
                  onClick={() => setReview(null)}
                >
                  Close
                </button>
              ) : (
                <>
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => setReview(null)}
                  >
                    {failed ? 'Close' : 'Not now'}
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy || failed}
                    onClick={() => void apply()}
                  >
                    {busy ? 'Offsetting…' : `Offset ${plural(review.input.rolls, 'roll')}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
