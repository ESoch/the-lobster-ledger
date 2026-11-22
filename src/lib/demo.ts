import { applyAction, createBet } from './ledger';
import type {
  Bet,
  BetStatus,
  LedgerState,
  Member,
  NewBet,
  Place,
  PriceObservation,
  Restaurant,
} from './types';

// Fictional people and wagers. Pins are real public places, not endorsements.
const members: Member[] = [
  // Colours come from AVATAR_PALETTE: white initials reach 4.5:1 on every one.
  { id: 'ellis', name: 'Ellis', initials: 'EL', color: '#315b54' },
  { id: 'alex', name: 'Alex', initials: 'AC', color: '#9a5f40' },
  { id: 'sarah', name: 'Sarah', initials: 'SK', color: '#746089' },
  { id: 'marcus', name: 'Marcus', initials: 'MT', color: '#567582' },
  { id: 'olivia', name: 'Olivia', initials: 'OP', color: '#8a6532' },
  { id: 'james', name: 'James', initials: 'JW', color: '#687945' },
];

const places: Place[] = [
  // https://maps.apple.com/place?place-id=I372CE0FE43EC871F
  {
    id: 'long-wharf',
    name: 'Long Wharf',
    address: 'Long Wharf, Boston, MA',
    lat: 42.36024,
    lng: -71.04896,
  },
  // https://mapcarta.com/W823630206 (OpenStreetMap way 823630206)
  {
    id: 'fan-pier',
    name: 'Fan Pier Park',
    address: 'Fan Pier Boulevard, Boston, MA',
    lat: 42.35466,
    lng: -71.04675,
  },
  // https://en.wikipedia.org/wiki/Christopher_Columbus_Waterfront_Park
  {
    id: 'waterfront-park',
    name: 'Waterfront Park',
    address: 'Christopher Columbus Waterfront Park, Boston, MA',
    lat: 42.3612,
    lng: -71.0516,
  },
  // https://mapcarta.com/22243962 (GeoNames 4949142)
  {
    id: 'rowes-wharf',
    name: 'Rowes Wharf',
    address: 'Rowes Wharf, Boston, MA',
    lat: 42.35719,
    lng: -71.04922,
  },
];

const restaurants: Restaurant[] = [
  { id: 'harbor-shack', name: 'Harbor Shack', address: 'Seaport, Boston, MA' },
  { id: 'north-pier', name: 'North Pier Café', address: 'Waterfront, Boston, MA' },
];
const priceObservations: PriceObservation[] = [
  {
    id: 'price-harbor-june',
    restaurantId: 'harbor-shack',
    itemName: 'Classic lobster roll',
    priceCents: 2500,
    currency: 'USD',
    visitDate: '2026-06-14',
    visitDatePrecision: 'day',
    reporterId: 'ellis',
    reportedAt: '2026-06-14T22:00:00.000Z',
  },
  {
    id: 'price-harbor-july',
    restaurantId: 'harbor-shack',
    itemName: 'Classic lobster roll',
    priceCents: 2600,
    currency: 'USD',
    visitDate: '2026-07-18',
    visitDatePrecision: 'day',
    reporterId: 'sarah',
    reportedAt: '2026-07-18T22:00:00.000Z',
  },
  {
    id: 'price-harbor-september',
    restaurantId: 'harbor-shack',
    itemName: 'Classic lobster roll',
    priceCents: 2800,
    currency: 'USD',
    visitDate: '2026-09-11',
    visitDatePrecision: 'day',
    reporterId: 'alex',
    reportedAt: '2026-09-11T22:00:00.000Z',
    note: 'Menu price before tax and tip.',
  },
  {
    id: 'price-north-august',
    restaurantId: 'north-pier',
    itemName: 'Classic lobster roll',
    priceCents: 3100,
    currency: 'USD',
    visitDate: '2026-08',
    visitDatePrecision: 'month',
    reporterId: 'marcus',
    reportedAt: '2026-08-28T22:00:00.000Z',
    entrySource: 'mcp',
  },
  // The cases the price views must handle: a second item at one restaurant, two members on the
  // same day, a visit remembered only to the year, a report replaced by its correction, one its
  // reporter withdrew, and one entered through an AI connection (above).
  {
    id: 'price-harbor-connecticut',
    restaurantId: 'harbor-shack',
    itemName: 'Connecticut lobster roll',
    priceCents: 3000,
    currency: 'USD',
    visitDate: '2026-07-04',
    visitDatePrecision: 'day',
    reporterId: 'olivia',
    reportedAt: '2026-07-04T21:00:00.000Z',
    note: 'Warm, with butter.',
  },
  {
    id: 'price-harbor-september-marcus',
    restaurantId: 'harbor-shack',
    itemName: 'Classic lobster roll',
    priceCents: 2800,
    currency: 'USD',
    visitDate: '2026-09-11',
    visitDatePrecision: 'day',
    reporterId: 'marcus',
    reportedAt: '2026-09-11T19:30:00.000Z',
  },
  {
    id: 'price-north-last-summer',
    restaurantId: 'north-pier',
    itemName: 'Classic lobster roll',
    priceCents: 2900,
    currency: 'USD',
    visitDate: '2025',
    visitDatePrecision: 'year',
    reporterId: 'sarah',
    reportedAt: '2026-07-02T20:00:00.000Z',
  },
  {
    id: 'price-north-september-typo',
    restaurantId: 'north-pier',
    itemName: 'Classic lobster roll',
    priceCents: 3500,
    currency: 'USD',
    visitDate: '2026-09-20',
    visitDatePrecision: 'day',
    reporterId: 'james',
    reportedAt: '2026-09-20T23:00:00.000Z',
    correctedAt: '2026-09-21T13:00:00.000Z',
  },
  {
    id: 'price-north-september',
    restaurantId: 'north-pier',
    itemName: 'Classic lobster roll',
    priceCents: 3300,
    currency: 'USD',
    visitDate: '2026-09-20',
    visitDatePrecision: 'day',
    reporterId: 'james',
    reportedAt: '2026-09-21T13:00:00.000Z',
    note: 'Corrected a typo: the menu said $33.',
    correctedFromId: 'price-north-september-typo',
    correctionReason: 'Typed $35 by mistake.',
  },
  {
    id: 'price-north-withdrawn',
    restaurantId: 'north-pier',
    itemName: 'Classic lobster roll',
    priceCents: 2700,
    currency: 'USD',
    visitDate: '2026-08-15',
    visitDatePrecision: 'day',
    reporterId: 'olivia',
    reportedAt: '2026-08-15T21:00:00.000Z',
    withdrawnAt: '2026-08-16T09:00:00.000Z',
    withdrawnReason: 'Logged at the wrong restaurant: that visit was Harbor Shack.',
  },
];

interface Sample extends Omit<NewBet, 'location'> {
  creatorId: string;
  status: BetStatus;
  placedAt: string;
  decidedAt?: string;
  place: number;
  winnerId?: string | null;
  resultNote?: string;
  deliveryNote?: string;
  /** A proposal taken back by its creator, or a judge who stepped down (reason in resultNote). */
  exit?: 'withdrawn' | 'judge_declined';
}

const samples: Sample[] = [
  {
    title: 'The next offsite will be by the ocean',
    category: 'Work',
    creatorId: 'sarah',
    opponentId: 'ellis',
    stake: 1,
    creatorSide: 'Somewhere on the coast',
    opponentSide: 'A cabin in the mountains',
    terms:
      'The official October offsite booking decides it. Within a 10-minute walk of the ocean counts as coastal. A city venue or cancellation voids the bet.',
    deadline: '2026-09-25',
    placedAt: '2026-09-11T15:20:00.000Z',
    status: 'pending',
    place: 1,
  },
  {
    title: 'The deploy takes under ten minutes',
    category: 'Work',
    creatorId: 'alex',
    opponentId: 'ellis',
    stake: 2,
    creatorSide: 'Ten minutes or more',
    opponentSide: 'Under ten minutes',
    terms:
      'Measure the September 10 production release from the first pipeline step to the final healthy deployment, using the pipeline timestamps. A cancelled run does not count.',
    deadline: '2026-09-10',
    placedAt: '2026-09-08T16:05:00.000Z',
    decidedAt: '2026-09-10T18:40:00.000Z',
    status: 'confirming',
    place: 0,
    winnerId: 'ellis',
    resultNote: 'Pipeline completed in 8 minutes, 42 seconds. Ellis called it.',
  },
  {
    title: 'Not a drop of rain at team lunch',
    category: 'Life',
    creatorId: 'marcus',
    opponentId: 'ellis',
    stake: 1,
    creatorSide: 'We will need to move inside',
    opponentSide: 'The whole lunch stays outside',
    terms:
      'For our September 8 lunch at Fan Pier, rain must cause the group to move inside between noon and 1 pm. A cancelled lunch voids the bet.',
    deadline: '2026-09-08',
    placedAt: '2026-09-07T16:30:00.000Z',
    decidedAt: '2026-09-08T17:05:00.000Z',
    status: 'settling',
    place: 1,
    winnerId: 'ellis',
    resultNote: 'Lunch stayed outside from noon until 1:15. No umbrellas required.',
    deliveryNote:
      'Bought Ellis a warm butter lobster roll at Thursday lunch. Awaiting his confirmation.',
  },
  {
    title: 'The migration finishes before lunch',
    category: 'Work',
    creatorId: 'ellis',
    opponentId: 'alex',
    stake: 3,
    creatorSide: 'All done before noon',
    opponentSide: 'Still running at noon',
    terms:
      'The September 9 staging migration must finish and pass the documented row-count checks before noon Eastern. The job logs and validation output decide it.',
    deadline: '2026-09-09',
    placedAt: '2026-09-05T17:10:00.000Z',
    decidedAt: '2026-09-09T16:05:00.000Z',
    status: 'owed',
    place: 3,
    winnerId: 'ellis',
    resultNote: 'Finished at 11:38 am. Row counts matched across all tables.',
  },
  {
    title: 'September still has a beach day in it',
    category: 'Life',
    creatorId: 'sarah',
    opponentId: 'ellis',
    stake: 2,
    creatorSide: 'Below 80°F all weekend',
    opponentSide: 'At least one 80°F day',
    terms:
      'The official Boston Logan daily high reaches 80°F or more on September 5 or 6. Use the published daily weather record, not a phone forecast.',
    deadline: '2026-09-06',
    placedAt: '2026-09-02T17:45:00.000Z',
    decidedAt: '2026-09-07T15:00:00.000Z',
    status: 'owed',
    place: 2,
    winnerId: 'ellis',
    resultNote: 'Sample result: the agreed daily record showed 82°F on Saturday.',
  },
  {
    title: 'The secret ingredient is brown butter',
    category: 'Wild card',
    creatorId: 'ellis',
    opponentId: 'olivia',
    stake: 1,
    creatorSide: 'Definitely brown butter',
    opponentSide: 'It is miso',
    terms:
      'The chef reveals the extra ingredient in the team bake-off cookies. If the recipe contains both brown butter and miso, or neither, the bet is void.',
    deadline: '2026-09-04',
    placedAt: '2026-09-03T19:00:00.000Z',
    decidedAt: '2026-09-04T18:30:00.000Z',
    status: 'owed',
    place: 3,
    winnerId: 'olivia',
    resultNote: 'The recipe reveal confirmed white miso and regular butter. Olivia wins.',
  },
  {
    title: 'A 5K in under 25 minutes',
    category: 'Sports',
    creatorId: 'ellis',
    opponentId: 'james',
    stake: 2,
    creatorSide: 'James breaks 25 minutes',
    opponentSide: '25 minutes or slower',
    terms:
      'James runs the full measured 5K at our September 19 group run. Elapsed time on his watch, with auto-pause off, decides it. Injury or a shortened course voids the bet.',
    deadline: '2026-09-19',
    placedAt: '2026-09-10T17:20:00.000Z',
    status: 'active',
    place: 2,
    decisionMethod: 'judge',
    judgeId: 'sarah',
  },
  {
    title: 'The first game goes to New England',
    category: 'Sports',
    creatorId: 'alex',
    opponentId: 'marcus',
    stake: 1,
    creatorSide: 'New England wins',
    opponentSide: 'Their opponent wins',
    terms:
      'The final official result of New England’s first regular-season football game decides the winner. Overtime counts. A tie or cancellation voids the wager.',
    deadline: '2026-09-15',
    placedAt: '2026-09-09T19:30:00.000Z',
    status: 'active',
    place: 0,
  },
  {
    title: 'Friday’s demo runs without a refresh',
    category: 'Work',
    creatorId: 'ellis',
    opponentId: 'sarah',
    stake: 1,
    creatorSide: 'One clean run, start to finish',
    opponentSide: 'At least one browser refresh',
    terms:
      'During the scheduled September 18 product demo, count manual browser refreshes after the presenter starts the live workflow. Refreshing before the demo starts does not count.',
    deadline: '2026-09-18',
    placedAt: '2026-09-10T15:00:00.000Z',
    status: 'active',
    place: 1,
    decisionMethod: 'chatgpt',
  },
  {
    title: 'The book club actually finishes the book',
    category: 'Life',
    creatorId: 'ellis',
    opponentId: 'olivia',
    stake: 1,
    creatorSide: 'Everyone finishes it',
    opponentSide: 'At least one person does not',
    terms:
      'All four regular book club members confirm that they have finished the September book before the meeting begins. An audiobook counts. A postponed meeting voids the bet.',
    deadline: '2026-09-24',
    placedAt: '2026-09-11T14:00:00.000Z',
    status: 'pending',
    place: 2,
  },
  {
    title: 'The build will be twice as fast',
    category: 'Work',
    creatorId: 'ellis',
    opponentId: 'alex',
    stake: 2,
    creatorSide: 'At least 50% faster',
    opponentSide: 'Less than 50% faster',
    terms:
      'Compare the median of five clean builds on the same runner before and after the cache change. A 50% or greater reduction in elapsed time wins for Ellis.',
    deadline: '2026-09-02',
    placedAt: '2026-08-28T16:20:00.000Z',
    decidedAt: '2026-09-02T20:00:00.000Z',
    status: 'settled',
    place: 0,
    winnerId: 'ellis',
    resultNote:
      'The median dropped from 6:40 to 2:55. The benchmark was shared with both participants.',
    deliveryNote: 'Alex bought two lobster rolls for Ellis at our Friday waterfront lunch.',
  },
  {
    title: 'The ferry beats the rideshare',
    category: 'Life',
    creatorId: 'olivia',
    opponentId: 'ellis',
    stake: 1,
    creatorSide: 'The ferry arrives first',
    opponentSide: 'The rideshare arrives first',
    terms:
      'Start together at Long Wharf and compare arrival at the agreed Charlestown meeting point. Include walking and waiting time. The first timestamped arrival message decides it.',
    deadline: '2026-09-01',
    placedAt: '2026-09-01T13:00:00.000Z',
    decidedAt: '2026-09-01T16:10:00.000Z',
    status: 'settled',
    place: 0,
    winnerId: 'olivia',
    resultNote: 'Olivia arrived at 11:32 am. Ellis arrived at 11:41 am.',
    deliveryNote:
      'Ellis bought Olivia a lobster roll at lunch. A delicious lesson in Boston traffic.',
  },
  {
    title: 'One last outdoor table',
    category: 'Life',
    creatorId: 'sarah',
    opponentId: 'james',
    stake: 1,
    creatorSide: 'A table within ten minutes',
    opponentSide: 'The wait is longer',
    terms:
      'After joining the outdoor waitlist for our August 29 lunch, the host must seat the full group in under ten minutes. If the patio is closed, the wager is void.',
    deadline: '2026-08-29',
    placedAt: '2026-08-29T14:00:00.000Z',
    decidedAt: '2026-08-29T16:00:00.000Z',
    status: 'voided',
    place: 3,
    winnerId: null,
    resultNote: 'The patio was closed for a private event. Both agreed to void the bet.',
  },
  {
    title: 'The office plant grows a new leaf',
    category: 'Wild card',
    creatorId: 'marcus',
    opponentId: 'james',
    stake: 1,
    creatorSide: 'A new leaf before Friday',
    opponentSide: 'No new leaf by Friday',
    terms:
      'A fully unfurled new leaf on the kitchen monstera before Friday at 5 pm, compared with our Monday reference photo, decides the bet.',
    deadline: '2026-09-04',
    placedAt: '2026-08-31T15:10:00.000Z',
    status: 'declined',
    place: 1,
    resultNote: 'James was away that week and could not verify the reference photo.',
  },
  {
    title: 'The parking garage reopens by Monday',
    category: 'Life',
    creatorId: 'ellis',
    opponentId: 'marcus',
    stake: 1,
    creatorSide: 'Open to the public on Monday morning',
    opponentSide: 'Still closed on Monday',
    terms:
      'The garage must admit public cars before 9 am on Monday, September 21, per the posted notice at the entrance. A partial reopening of one level counts.',
    deadline: '2026-09-21',
    placedAt: '2026-09-12T14:30:00.000Z',
    status: 'declined',
    exit: 'withdrawn',
    place: 0,
    resultNote:
      'I had the reopening week wrong. I will propose it again once the notice is updated.',
  },
  {
    title: 'The quarterly numbers beat the forecast',
    category: 'Work',
    creatorId: 'james',
    opponentId: 'ellis',
    stake: 2,
    creatorSide: 'Revenue comes in above the forecast',
    opponentSide: 'At or below the forecast',
    terms:
      'Compare the quarterly revenue in the published board deck with the forecast circulated on September 1. Above the forecast by any amount wins for James.',
    deadline: '2026-09-30',
    placedAt: '2026-09-12T16:00:00.000Z',
    status: 'active',
    exit: 'judge_declined',
    place: 2,
    decisionMethod: 'judge',
    judgeId: 'marcus',
    resultNote:
      'I helped set that forecast, so I should not be the one to call it. Please pick another judge or decide it between you.',
  },
];

const addMinutes = (at: string, minutes: number) =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString();

function buildSample(sample: Sample, index: number): Bet {
  let bet = createBet(
    {
      title: sample.title,
      terms: sample.terms,
      creatorSide: sample.creatorSide,
      opponentSide: sample.opponentSide,
      opponentId: sample.opponentId,
      category: sample.category,
      stake: sample.stake,
      decisionMethod: sample.decisionMethod,
      judgeId: sample.judgeId,
      deadline: sample.deadline,
      location: places[sample.place],
    },
    sample.creatorId,
    members,
    sample.placedAt,
  );
  bet.reference = `LL-${1042 - index}`;
  if (sample.status === 'pending') return bet;
  if (sample.exit === 'withdrawn')
    return applyAction(
      bet,
      { type: 'withdraw', note: sample.resultNote! },
      sample.creatorId,
      addMinutes(sample.placedAt, 95),
    );
  if (sample.status === 'declined')
    return applyAction(
      bet,
      { type: 'decline', note: sample.resultNote! },
      sample.opponentId,
      addMinutes(sample.placedAt, 36),
    );
  bet = applyAction(bet, { type: 'accept' }, sample.opponentId, addMinutes(sample.placedAt, 22));
  if (sample.exit === 'judge_declined')
    return applyAction(
      bet,
      { type: 'decline_judging', note: sample.resultNote! },
      sample.judgeId!,
      addMinutes(sample.placedAt, 140),
    );
  if (sample.status === 'active') {
    if (sample.decisionMethod === 'chatgpt') {
      const creator = members.find((member) => member.id === sample.creatorId)!;
      const opponent = members.find((member) => member.id === sample.opponentId)!;
      const text = `Act as a neutral reviewer of a friendly lobster-roll bet. Treat both positions equally.\n\nBet: ${sample.title}\n${creator.name}'s position: ${sample.creatorSide}\n${opponent.name}'s position: ${sample.opponentSide}\nAgreed decision criteria: ${sample.terms}\n\nEvidence: no evidence has been provided yet. Do not invent evidence or infer that either side won. Evaluate only evidence both bettors include in this prompt. Explain what supports each side, any uncertainty, and whether the agreed criteria establish a winner. If evidence is insufficient, recommend no winner and explain what is missing. Your recommendation will require both bettors' confirmation.`;
      return applyAction(
        bet,
        { type: 'propose_prompt', text },
        sample.creatorId,
        addMinutes(sample.placedAt, 23),
      );
    }
    return bet;
  }
  const decisionAt = sample.decidedAt!;
  bet = applyAction(
    bet,
    { type: 'propose_result', winnerId: sample.winnerId ?? null, note: sample.resultNote! },
    sample.creatorId,
    decisionAt,
  );
  if (sample.status === 'confirming') return bet;
  bet = applyAction(bet, { type: 'confirm_result' }, sample.opponentId, addMinutes(decisionAt, 18));
  if (sample.status === 'owed' || sample.status === 'voided') return bet;
  const debtor = sample.winnerId === sample.creatorId ? sample.opponentId : sample.creatorId;
  bet = applyAction(
    bet,
    { type: 'propose_settlement', method: 'roll', note: sample.deliveryNote! },
    debtor,
    addMinutes(decisionAt, 2880),
  );
  if (sample.status === 'settling') return bet;
  return applyAction(
    bet,
    { type: 'confirm_settlement' },
    sample.winnerId!,
    addMinutes(decisionAt, 2894),
  );
}

export function createDemoState(): LedgerState {
  return {
    groupName: 'The Lobster Ledger',
    members: structuredClone(members),
    places: structuredClone(places),
    restaurants: structuredClone(restaurants),
    priceObservations: structuredClone(priceObservations),
    bets: samples.map(buildSample),
  };
}
