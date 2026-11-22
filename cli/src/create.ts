import type {
  Category,
  DecisionMethod,
  DecisionTiming,
  HistoricalDate,
  HistoricalInput,
  LedgerState,
  Member,
  NewBet,
  ZonedDateTime,
} from '../../src/lib/types';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { newBetSchema } from '../../src/lib/api-schemas';
import { createBet } from '../../src/lib/ledger';
import { validateHistoricalDate, validateZonedDateTime } from '../../src/lib/bet-workflow';
export type CreateInput = { bet: NewBet; prompt?: string };
export type WizardIO = {
  ask(
    key: string,
    label: string,
    options?: {
      choices?: { value: string; label: string }[];
      defaultValue?: string;
      optional?: boolean;
    },
  ): Promise<string>;
  print(value: string): void;
};
const schema = z
  .object({ bet: newBetSchema, prompt: z.string().trim().min(20).max(8000).optional() })
  .strict();
export function validateCreateInput(
  value: unknown,
  actorId: string,
  members: Member[],
): CreateInput {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('\n'),
    );
  const input = parsed.data;
  if (input.bet.deadline && input.bet.timing)
    throw new Error(
      'bet.deadline and bet.timing cannot both be provided. Use timing for an exact decision date, event, or evidence requirement.',
    );
  const history = input.bet.history;
  if (history && input.bet.acknowledgements) {
    if (history.stage === 'active' && input.bet.acknowledgements.result)
      throw new Error('bet.acknowledgements.result must be false for an ongoing historical bet.');
    if (history.stage !== 'settled' && input.bet.acknowledgements.delivery)
      throw new Error(
        'bet.acknowledgements.delivery must be false unless actual delivery is reported.',
      );
  }
  if (input.prompt !== undefined && (input.bet.decisionMethod !== 'chatgpt' || history))
    throw new Error(
      'An initial ChatGPT prompt is allowed only for a new ChatGPT bet. Historical adjudication belongs in bet.history.previousAdjudication.',
    );
  createBet(input.bet, actorId, members);
  return input;
}
const choices = (values: string[]) => values.map((value) => ({ value, label: value }));
async function text(
  io: WizardIO,
  key: string,
  label: string,
  maximum: number,
  minimum = 1,
  optional = false,
): Promise<string> {
  for (;;) {
    const value = (await io.ask(key, label, { optional })).trim();
    if ((optional && !value) || (value.length >= minimum && value.length <= maximum)) return value;
    io.print(`${label} must contain ${minimum}–${maximum} characters.`);
  }
}
async function number(
  io: WizardIO,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
  whole = false,
  defaultValue?: string,
): Promise<number> {
  for (;;) {
    const raw = await io.ask(key, label, { defaultValue });
    const value = Number(raw);
    if (
      raw.trim() &&
      Number.isFinite(value) &&
      value >= minimum &&
      value <= maximum &&
      (!whole || Number.isInteger(value))
    )
      return value;
    io.print(`Enter ${whole ? 'a whole number' : 'a number'} between ${minimum} and ${maximum}.`);
  }
}
async function yes(io: WizardIO, key: string, label: string) {
  return (
    (await io.ask(key, label, { choices: choices(['no', 'yes']), defaultValue: 'no' })) === 'yes'
  );
}
async function zoned(io: WizardIO, key: string, label: string): Promise<ZonedDateTime> {
  for (;;) {
    const at = await io.ask(
      `${key}.at`,
      `${label}: date and time with offset (e.g. 2030-10-31T17:00:00-07:00)`,
    );
    const timezone = await io.ask(
      `${key}.timezone`,
      `${label}: named timezone (e.g. America/Los_Angeles)`,
      { defaultValue: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );
    try {
      validateZonedDateTime({ at, timezone });
      return { at, timezone };
    } catch (error) {
      io.print((error as Error).message);
    }
  }
}
async function historicalDate(io: WizardIO, key: string, label: string): Promise<HistoricalDate> {
  for (;;) {
    const precision = (await io.ask(
      `${key}.precision`,
      `${label}: how precisely do you know the date?`,
      { choices: choices(['day', 'month', 'year', 'unknown']) },
    )) as HistoricalDate['precision'];
    if (precision === 'unknown') return { precision };
    const value = await io.ask(
      `${key}.value`,
      `${label} (${precision === 'day' ? 'YYYY-MM-DD' : precision === 'month' ? 'YYYY-MM' : 'YYYY'})`,
    );
    try {
      return validateHistoricalDate({ precision, value });
    } catch (error) {
      io.print((error as Error).message);
    }
  }
}
export async function collectBet(
  io: WizardIO,
  ledger: LedgerState,
  actorId: string,
): Promise<CreateInput> {
  const opponents = ledger.members.filter((member) => member.id !== actorId);
  if (!opponents.length)
    throw new Error('Invite another member on the website before creating a bet.');
  const stage = await io.ask(
    'stage',
    'Are you proposing a new bet or recording existing history?',
    {
      choices: [
        { value: 'new', label: 'New agreement' },
        { value: 'active', label: 'Existing, still ongoing' },
        { value: 'owed', label: 'Existing, decided and still owed' },
        { value: 'settled', label: 'Existing, actual lobster rolls delivered' },
        { value: 'voided', label: 'Existing, called off with no winner' },
      ],
    },
  );
  const opponentId = await io.ask('opponentId', 'Who is the other bettor?', {
    choices: opponents.map((member) => ({ value: member.id, label: member.name })),
  });
  const title = await text(io, 'title', 'Bet title', 160, 3);
  const category = (await io.ask('category', 'Category', {
    choices: choices(['Work', 'Sports', 'Life', 'Wild card']),
    defaultValue: 'Work',
  })) as Category;
  const creatorSide = await text(io, 'creatorSide', 'Your position', 300);
  const opponentSide = await text(io, 'opponentSide', 'Their position', 300);
  const stake = await number(
    io,
    'stake',
    'Number of actual lobster rolls at stake',
    1,
    100,
    true,
    '1',
  );
  const terms = await text(
    io,
    'terms',
    'Exact winning conditions, evidence, and tie/cancellation rules',
    3000,
    10,
  );
  const decisionMethod = (await io.ask('decisionMethod', 'How will you adjudicate the result?', {
    choices: [
      { value: 'mutual', label: 'Both bettors agree from the evidence' },
      { value: 'judge', label: 'An independent member judges' },
      { value: 'chatgpt', label: 'ChatGPT with a mutually approved prompt' },
    ],
    defaultValue: 'mutual',
  })) as DecisionMethod;
  const bet: NewBet = {
    title,
    category,
    opponentId,
    creatorSide,
    opponentSide,
    stake,
    terms,
    decisionMethod,
  };
  if (decisionMethod === 'judge') {
    const judges = ledger.members.filter((member) => ![actorId, opponentId].includes(member.id));
    if (!judges.length)
      throw new Error(
        'A judged bet requires another registered member as an independent judge. Invite the judge on the website, then retry.',
      );
    bet.judgeId = await io.ask('judgeId', 'Which independent member will judge?', {
      choices: judges.map((member) => ({ value: member.id, label: member.name })),
    });
  }
  if (
    stage === 'new' ||
    stage === 'active' ||
    (await yes(io, 'timing.enabled', 'Record the original decision timing too?'))
  ) {
    const kind = (await io.ask('timing.kind', 'When can the result be verified?', {
      choices: [
        { value: 'date', label: 'On or after an exact date/time' },
        { value: 'event', label: 'When a future event happens' },
        { value: 'evidence', label: 'When specified evidence is available' },
      ],
    })) as DecisionTiming['kind'];
    const timing: DecisionTiming =
      kind === 'date'
        ? { kind, ...(await zoned(io, 'timing', 'Decision time')) }
        : {
            kind,
            description: await text(
              io,
              'timing.description',
              kind === 'event'
                ? 'Which event must happen?'
                : 'Which evidence must become available?',
              2000,
            ),
          };
    const source = await text(
      io,
      'timing.source',
      'Where will you verify the evidence? (optional)',
      500,
      1,
      true,
    );
    if (source) timing.source = source;
    if (await yes(io, 'timing.checkIn.enabled', 'Set a check-in time to review the evidence?'))
      timing.checkIn = await zoned(io, 'timing.checkIn', 'Evidence check-in');
    bet.timing = timing;
  }
  if (await yes(io, 'cutoff.enabled', 'Set a cutoff for events that count toward the claim?'))
    bet.cutoff = await zoned(io, 'cutoff', 'Claim cutoff');
  const location = await io.ask('location.mode', 'Where was the bet placed?', {
    choices: [
      { value: 'none', label: 'No location' },
      ...(ledger.places.length ? [{ value: 'existing', label: 'Choose a saved place' }] : []),
      { value: 'custom', label: 'Enter a place and map coordinates' },
    ],
    defaultValue: 'none',
  });
  if (location === 'existing') {
    const id = await io.ask('location.id', 'Choose a place', {
      choices: ledger.places.map((place) => ({
        value: place.id,
        label: `${place.name} · ${place.address}`,
      })),
    });
    bet.location = ledger.places.find((place) => place.id === id);
  }
  if (location === 'custom') {
    const place = {
      name: await text(io, 'location.name', 'Place name', 180),
      address: await text(io, 'location.address', 'Place address', 300),
      lat: await number(io, 'location.lat', 'Latitude', -90, 90),
      lng: await number(io, 'location.lng', 'Longitude', -180, 180),
    };
    // The same guided answers must produce the same request after an uncertain response.
    bet.location = {
      id: `cli-${createHash('sha256').update(JSON.stringify(place)).digest('hex').slice(0, 32)}`,
      ...place,
    };
  }
  let prompt: string | undefined;
  if (stage === 'new' && decisionMethod === 'chatgpt')
    prompt =
      (await text(
        io,
        'prompt',
        'Propose the exact fair ChatGPT prompt (optional; the other bettor must approve it)',
        8000,
        20,
        true,
      )) || undefined;
  if (stage !== 'new') {
    const history: HistoricalInput = {
      stage: stage as HistoricalInput['stage'],
      originalDate: await historicalDate(io, 'history.originalDate', 'Original agreement date'),
    };
    if (history.stage !== 'active') {
      const winnerId =
        history.stage === 'voided'
          ? null
          : await io.ask('history.result.winnerId', 'Who won?', {
              choices: ledger.members
                .filter((member) => [actorId, opponentId].includes(member.id))
                .map((member) => ({ value: member.id, label: member.name })),
            });
      history.result = {
        winnerId,
        date: await historicalDate(io, 'history.result.date', 'Result date'),
        note: await text(
          io,
          'history.result.note',
          history.stage === 'voided'
            ? 'Why was the bet called off?'
            : 'Record the result and supporting evidence',
          2000,
        ),
      };
      const previous = await io.ask(
        'history.previousAdjudication.method',
        'Was there a previous judge or ChatGPT adjudication?',
        { choices: choices(['none', 'judge', 'chatgpt']), defaultValue: 'none' },
      );
      if (previous !== 'none') {
        const note = await text(
          io,
          'history.previousAdjudication.note',
          'Describe the previous adjudication (reported history; no new judge approval is implied)',
          2000,
        );
        const sourceUrl = await text(
          io,
          'history.previousAdjudication.sourceUrl',
          'HTTPS evidence link (optional)',
          500,
          1,
          true,
        );
        history.previousAdjudication = {
          method: previous as 'judge' | 'chatgpt',
          note,
          ...(sourceUrl ? { sourceUrl } : {}),
        };
      }
    }
    if (history.stage === 'settled')
      history.delivery = {
        date: await historicalDate(
          io,
          'history.delivery.date',
          'Actual lobster roll delivery date',
        ),
        note: await text(
          io,
          'history.delivery.note',
          'Describe the actual lobster rolls bought and delivered',
          2000,
        ),
      };
    bet.history = history;
    const terms = await yes(
      io,
      'acknowledgements.terms',
      'Do you confirm these historical agreement terms are correct?',
    );
    const result =
      history.stage !== 'active' &&
      (await yes(
        io,
        'acknowledgements.result',
        'Do you confirm this historical result is correct?',
      ));
    const delivery =
      history.stage === 'settled' &&
      (await yes(
        io,
        'acknowledgements.delivery',
        'Do you confirm the actual lobster rolls were bought and delivered? Cash or netting does not count.',
      ));
    bet.acknowledgements = { terms, result, delivery };
    io.print(
      'History is your report. The other bettor must independently confirm the applicable terms, result, and delivery.',
    );
  }
  return { bet, ...(prompt ? { prompt } : {}) };
}

export function betTemplate(): CreateInput {
  return {
    bet: {
      title: 'The release will ship before Friday',
      terms:
        'Use the public release timestamp. A release before Friday wins for me; Friday or later wins for my opponent.',
      category: 'Work',
      opponentId: 'REPLACE_WITH_MEMBER_ID_FROM_lobster_members',
      creatorSide: 'Before Friday',
      opponentSide: 'Friday or later',
      stake: 1,
      decisionMethod: 'mutual',
      timing: {
        kind: 'event',
        description: 'The release is published',
        source: 'The official release page',
      },
    },
  };
}
