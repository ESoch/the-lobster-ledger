import { useState } from 'react';
import { Check, MapPin } from 'lucide-react';
import type {
  Bet,
  Category,
  DecisionTiming,
  HistoricalInput,
  HistoryRevision,
  Member,
  Place,
} from '../lib/types';
import {
  HistoryAcknowledgementFields,
  HistoryFields,
  StageFields,
  TimingFields,
  readHistory,
  readTiming,
} from './WorkflowFields';
import { MapView } from './MapView';
import { trimText } from '../lib/bet-workflow';
import { FieldError, useFieldAria } from './form-errors';
import { dateLabel, timeLabel } from './ui';
import { LIMITS } from '../lib/limits';

/** A title or position is one line of text that wraps; Enter does not add a line to it. */
const keepToOneLine = (event: React.KeyboardEvent) => {
  if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
};
/** Text pasted in with line breaks reads as one line, as it would typed into a New bet field. */
const oneLine = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** A decision date with no time, shown in the timing fields as 12:00 AM UTC that day. */
const legacyTiming = (deadline: string): DecisionTiming => ({
  kind: 'date',
  at: `${deadline}T00:00:00.000Z`,
  timezone: 'UTC',
});

/** The places a revision can choose: the saved ones, plus the bet's own if it is not saved. */
function placeChoices(bet: Bet, places: Place[]): Place[] {
  return bet.location && !places.some((place) => place.id === bet.location!.id)
    ? [...places, bet.location]
    : places;
}

export function HistoryRevisionFields({
  bet,
  members,
  places = [],
  memberId,
}: {
  bet: Bet;
  members: Member[];
  /** Saved places, offered the way New bet offers them. */
  places?: Place[];
  /** Who is revising: the other original bettor is the one who confirms next. */
  memberId?: string;
}) {
  const [stage, setStage] = useState<HistoricalInput['stage']>(bet.history?.stage ?? 'active');
  const [placeId, setPlaceId] = useState(bet.location?.id ?? '');
  const [pin, setPin] = useState<{ lat: number; lng: number }>();
  const [placeName, setPlaceName] = useState('');
  const { aria } = useFieldAria();
  const name = (id: string) =>
    members.find((member) => member.id === id)?.name ?? 'Original bettor';
  const first = (id: string) => name(id).split(' ')[0];
  const other = memberId
    ? members
        .find(
          (member) => member.id === (memberId === bet.creatorId ? bet.opponentId : bet.creatorId),
        )
        ?.name.split(' ')[0]
    : undefined;
  const correction = bet.history?.correction;
  const legacy = !bet.timing && bet.deadline ? bet.deadline : undefined;
  return (
    <>
      {correction && (
        <div className="workflow-notice">
          <p>
            <strong>{name(correction.requestedBy)} asked for this correction</strong> on{' '}
            <time dateTime={correction.at}>{timeLabel(correction.at)}</time>:
          </p>
          <p className="workflow-notice-quote">“{correction.note}”</p>
        </div>
      )}
      <p className="hint">
        Keep the original two bettors. Your revision replaces the proposed history, and both of you
        confirm it again. The earlier version stays in the paper trail.
      </p>
      <section className="workflow-fields">
        <h3>The agreement</h3>
        <div className="field">
          <label>
            Bet title
            <textarea
              name="title"
              className="one-line-text"
              rows={2}
              defaultValue={bet.title}
              required
              minLength={LIMITS.title.min}
              maxLength={LIMITS.title.max}
              onKeyDown={keepToOneLine}
              data-required-message="Say what the bet is in a few words."
              {...aria('title')}
            />
          </label>
          <FieldError name="title" />
        </div>
        <div className="form-grid">
          <div className="field">
            <label>
              Category
              <select name="category" defaultValue={bet.category}>
                <option>Work</option>
                <option>Sports</option>
                <option>Life</option>
                <option>Wild card</option>
              </select>
            </label>
          </div>
          <div className="field">
            <label>
              Rolls at stake
              <input
                name="stake"
                type="number"
                min={1}
                max={100}
                step={1}
                defaultValue={bet.stake}
                required
                data-required-message="Enter how many rolls are at stake."
                data-range-message="Use a whole number of rolls from 1 to 100."
                {...aria('stake')}
              />
            </label>
            <FieldError name="stake" />
          </div>
        </div>
        <div className="field">
          <label>
            {name(bet.creatorId)}’s position
            <textarea
              name="creatorSide"
              className="one-line-text"
              rows={2}
              defaultValue={bet.creatorSide}
              required
              maxLength={LIMITS.side.max}
              onKeyDown={keepToOneLine}
              data-required-message={`Write ${first(bet.creatorId)}’s side of the bet.`}
              {...aria('creatorSide')}
            />
          </label>
          <FieldError name="creatorSide" />
        </div>
        <div className="field">
          <label>
            {name(bet.opponentId)}’s position
            <textarea
              name="opponentSide"
              className="one-line-text"
              rows={2}
              defaultValue={bet.opponentSide}
              required
              maxLength={LIMITS.side.max}
              onKeyDown={keepToOneLine}
              data-required-message={`Write ${first(bet.opponentId)}’s side of the bet.`}
              {...aria('opponentSide')}
            />
          </label>
          <FieldError name="opponentSide" />
        </div>
        <div className="field">
          <label>
            Original decision criteria
            <textarea
              name="terms"
              defaultValue={bet.terms}
              required
              minLength={LIMITS.terms.min}
              maxLength={LIMITS.terms.max}
              rows={4}
              data-required-message="Say what evidence settles the bet."
              {...aria('terms')}
            />
          </label>
          <FieldError name="terms" />
        </div>
      </section>
      <HistoryFields
        value={bet.history}
        members={members}
        creatorId={bet.creatorId}
        opponentId={bet.opponentId}
        stage={stage}
        onStageChange={setStage}
        other={other}
      />
      <StageFields show={stage === 'active'} keep>
        <TimingFields
          timing={bet.timing ?? (legacy ? legacyTiming(legacy) : undefined)}
          cutoff={bet.cutoff}
          dateNote={
            legacy
              ? `The record only named a decision date, ${dateLabel(legacy, { year: true })} (UTC). It is filled in as 12:00 AM UTC that day; leave it to keep that date, or change it to set a time.`
              : undefined
          }
        />
      </StageFields>
      <section className="workflow-fields">
        <h3>Where the bet was made</h3>
        <div className="field">
          <label>
            <span className="field-label">
              <MapPin size={14} aria-hidden="true" /> Location{' '}
              <span className="optional">Optional</span>
            </span>
            <select
              name="location.placeId"
              value={placeId}
              onChange={(event) => setPlaceId(event.target.value)}
            >
              <option value="">No location</option>
              {placeChoices(bet, places).map((place) => (
                <option value={place.id} key={place.id}>
                  {place.name}
                </option>
              ))}
              <option value="custom">+ Pin a new location</option>
            </select>
          </label>
        </div>
        {placeId === 'custom' && (
          <div className="custom-place">
            <div className="field">
              <label>
                Location name
                <input
                  name="location.name"
                  value={placeName}
                  onChange={(event) => setPlaceName(event.target.value)}
                  placeholder="e.g. The office kitchen"
                  required
                  maxLength={120}
                  data-required-message="Name the location you are pinning."
                  {...aria(['location.name', 'location.pin'])}
                />
              </label>
              <FieldError name="location.name" />
              {/* A pin that is missing is said here, with the name field that holds focus, not out
                  of sight below the map. */}
              <FieldError name="location.pin" />
            </div>
            <input type="hidden" name="location.lat" value={pin?.lat ?? ''} />
            <input type="hidden" name="location.lng" value={pin?.lng ?? ''} />
            <MapView
              places={places}
              bets={[]}
              compact
              pickedLocation={pin}
              onPickLocation={setPin}
              onClearPin={() => setPin(undefined)}
            />
            <p className={`hint pin-status${pin ? ' is-pinned' : ''}`} role="status">
              {pin && <Check size={14} aria-hidden="true" />}
              {pin
                ? `${trimText(placeName) || 'Your pin'} is pinned. Tap the map to move it.`
                : 'No pin yet. Tap the map to choose the location.'}
            </p>
          </div>
        )}
      </section>
      <HistoryAcknowledgementFields stage={stage} other={other} />
    </>
  );
}

/**
 * The messages a change to `name` answers in the revision form: a new Location choice answers the
 * name and pin it asked for, and a new name answers a pin that was missing under it.
 */
export function historyRevisionAnswered(name: string): string[] {
  if (name === 'location.placeId') return ['location.name', 'location.pin'];
  if (name === 'location.name') return ['location.pin'];
  return [];
}

const sameTiming = (first: DecisionTiming, second: DecisionTiming) =>
  first.kind === 'date' &&
  second.kind === 'date' &&
  Date.parse(first.at) === Date.parse(second.at) &&
  first.timezone === second.timezone &&
  !first.source &&
  !first.checkIn;

export function readHistoryRevision(
  data: FormData,
  bet: Bet,
  places: Place[] = [],
): HistoryRevision {
  const history = readHistory(data);
  const placeId = String(data.get('location.placeId') ?? '');
  let location: Place | undefined;
  if (placeId === 'custom') {
    const placeName = trimText(String(data.get('location.name') ?? ''));
    if (!placeName || !data.get('location.lat') || !data.get('location.lng'))
      throw new Error('Name the location and choose a point on the map.');
    // A newly pinned place gets its own id, so the saved place it may resemble is untouched.
    location = {
      id: crypto.randomUUID(),
      name: placeName,
      address: 'Pinned location',
      lat: Number(data.get('location.lat')),
      lng: Number(data.get('location.lng')),
    };
  } else if (placeId) {
    const saved = placeChoices(bet, places).find((place) => place.id === placeId);
    location = saved && structuredClone(saved);
  }
  // A decision date left as it was stays a decision date; it is never rewritten as a timing.
  const legacy = !bet.timing && bet.deadline ? bet.deadline : undefined;
  let schedule: Pick<HistoryRevision, 'deadline' | 'timing' | 'cutoff'> = legacy
    ? { deadline: legacy }
    : {};
  if (history.stage === 'active') {
    const read = readTiming(data);
    schedule =
      legacy && !read.cutoff && sameTiming(read.timing, legacyTiming(legacy))
        ? { deadline: legacy }
        : read;
  }
  return {
    title: oneLine(data.get('title')),
    terms: String(data.get('terms')),
    category: data.get('category') as Category,
    creatorSide: oneLine(data.get('creatorSide')),
    opponentSide: oneLine(data.get('opponentSide')),
    stake: Number(data.get('stake')),
    ...schedule,
    ...(location ? { location } : {}),
    history,
  };
}
