import { useId, useState } from 'react';
import type { Bet, DecisionMethod, Member } from '../lib/types';
import { FieldError, useFieldAria } from './form-errors';

/**
 * Lets an amendment change who decides the bet. It starts on the agreed method; when the named
 * judge has stepped down, that judge cannot be chosen again.
 */
export function DecisionMethodFields({ bet, members }: { bet: Bet; members: Member[] }) {
  const current = bet.decisionMethod ?? 'mutual';
  const steppedDown = current === 'judge' && bet.judgeDeclined ? bet.judgeId : undefined;
  const [method, setMethod] = useState<DecisionMethod>(current);
  const [judgeId, setJudgeId] = useState(steppedDown ? '' : (bet.judgeId ?? ''));
  const judges = members.filter(
    (person) => ![bet.creatorId, bet.opponentId, steppedDown].includes(person.id),
  );
  const steppedDownName = members.find((person) => person.id === steppedDown)?.name;
  const { aria } = useFieldAria();
  const hintId = useId();
  return (
    <>
      <label>
        Who makes the call?
        <select
          name="decisionMethod"
          value={method}
          onChange={(event) => setMethod(event.target.value as DecisionMethod)}
        >
          <option value="mutual">Both bettors agree</option>
          <option value="judge">An appointed judge</option>
          <option value="chatgpt">ChatGPT, with an agreed prompt</option>
        </select>
      </label>
      {method === 'judge' && (
        <div className="field">
          <label>
            Appoint a judge
            <select
              name="judgeId"
              value={judgeId}
              onChange={(event) => setJudgeId(event.target.value)}
              required
              data-required-message="Choose a judge."
              {...aria('judgeId', steppedDownName && hintId)}
            >
              <option value="">Choose another member</option>
              {judges.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          {/* Under the field, not in its label, so it is a description and not part of the name. */}
          {steppedDownName && (
            <p className="hint" id={hintId}>
              {steppedDownName} stepped down and cannot be named again for this bet.
            </p>
          )}
          <FieldError name="judgeId" />
        </div>
      )}
    </>
  );
}

/** The method change an amendment proposes, or nothing when it keeps the agreed method. */
export function readDecisionMethod(
  data: FormData,
  bet: Bet,
): { decisionMethod?: DecisionMethod; judgeId?: string } {
  const method = data.get('decisionMethod');
  if (method !== 'mutual' && method !== 'judge' && method !== 'chatgpt') return {};
  const judgeId = method === 'judge' ? String(data.get('judgeId') ?? '') : undefined;
  const unchanged =
    !bet.judgeDeclined &&
    method === (bet.decisionMethod ?? 'mutual') &&
    (judgeId ?? '') === (method === 'judge' ? (bet.judgeId ?? '') : '');
  if (unchanged) return {};
  return method === 'judge' ? { decisionMethod: method, judgeId } : { decisionMethod: method };
}
