import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import {
  actionSchema,
  newBetSchema,
  readJson,
  requireSameOrigin,
  verifyGoogleIdentity,
} from './security';

describe('request boundaries', () => {
  it('requires the configured origin on every mutation', () => {
    expect(() =>
      requireSameOrigin(
        new Request('https://ledger.example/api/bets', {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
        }),
        'https://ledger.example',
      ),
    ).toThrow();
    expect(() =>
      requireSameOrigin(
        new Request('https://ledger.example/api/bets', { method: 'POST' }),
        'https://ledger.example',
      ),
    ).toThrow();
    expect(() =>
      requireSameOrigin(
        new Request('https://ledger.example/api/bets', {
          method: 'POST',
          headers: { Origin: 'https://ledger.example' },
        }),
        'https://ledger.example',
      ),
    ).not.toThrow();
  });

  it('rejects cash settlement and client-supplied actor identities', () => {
    expect(
      actionSchema.safeParse({ type: 'propose_settlement', method: 'cash', note: 'Sent money' })
        .success,
    ).toBe(false);
    expect(actionSchema.safeParse({ type: 'accept', actorId: 'another-member' }).success).toBe(
      false,
    );
    expect(
      actionSchema.safeParse({
        type: 'propose_settlement',
        method: 'roll',
        note: 'Bought the actual rolls',
      }).success,
    ).toBe(true);
  });

  it('rejects impossible dates and out-of-range locations', () => {
    const input = {
      title: 'A wager',
      terms: 'The official announcement decides',
      category: 'Work',
      opponentId: 'peer',
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake: 1,
      deadline: '2027-02-30',
    };
    expect(newBetSchema.safeParse(input).success).toBe(false);
    expect(
      newBetSchema.safeParse({
        ...input,
        deadline: '2027-02-28',
        location: { id: 'bad', name: 'Bad', address: '', lat: 100, lng: 0 },
      }).success,
    ).toBe(false);
  });

  it('accepts optional named judges and only official HTTPS ChatGPT share links', () => {
    const input = {
      title: 'A wager',
      terms: 'The official announcement decides',
      category: 'Work',
      opponentId: 'peer',
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake: 1,
      deadline: '2027-02-28',
      decisionMethod: 'judge',
      judgeId: 'judge',
    };
    expect(newBetSchema.safeParse(input).success).toBe(true);
    const verdict = {
      type: 'adjudicate',
      winnerId: 'peer',
      note: 'The terms support the other side.',
    };
    expect(actionSchema.safeParse(verdict).success).toBe(true);
    expect(actionSchema.safeParse({ ...verdict, recordedBy: 'the-judge' }).success).toBe(false);
    for (const sourceUrl of [
      'https://chatgpt.com/share/abc-123',
      'https://chat.openai.com/share/abc-123',
    ]) {
      expect(actionSchema.safeParse({ ...verdict, sourceUrl }).success).toBe(true);
    }
    for (const sourceUrl of [
      'https://attacker.example/share/abc',
      'javascript:alert(1)',
      'http://chatgpt.com/share/abc',
      'https://chatgpt.com.attacker.example/share/abc',
      'https://chatgpt.com@attacker.example/share/abc',
      'https://user:password@chatgpt.com/share/abc',
      'https://chatgpt.com/c/abc',
      'https://chatgpt.com/share/',
      'https://chatgpt.com/share/abc?redirect=other',
    ]) {
      expect(actionSchema.safeParse({ ...verdict, sourceUrl }).success).toBe(false);
    }
  });

  it('accepts historical stages and precise decision timing without a legacy deadline', () => {
    const base = {
      title: 'A wager',
      terms: 'The official announcement decides',
      category: 'Work',
      opponentId: 'peer',
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake: 1,
    };
    for (const stage of ['active', 'owed', 'settled', 'voided']) {
      const history = {
        stage,
        originalDate: { precision: 'month', value: '2024-02' },
        ...(stage === 'active'
          ? {}
          : {
              result: {
                winnerId: stage === 'voided' ? null : 'peer',
                date: { precision: 'unknown' },
                note: 'The announcement was made',
              },
            }),
        ...(stage === 'settled'
          ? {
              delivery: {
                date: { precision: 'day', value: '2024-03-01' },
                note: 'Actual rolls at lunch',
              },
            }
          : {}),
      };
      expect(
        newBetSchema.safeParse({
          ...base,
          history,
          acknowledgements: {
            terms: true,
            result: stage !== 'active',
            delivery: stage === 'settled',
          },
          ...(stage === 'active'
            ? {
                timing: {
                  kind: 'event',
                  description: 'The launch is announced',
                  source: 'Company newsroom',
                },
              }
            : {}),
        }).success,
      ).toBe(true);
    }
    expect(
      newBetSchema.safeParse({
        ...base,
        timing: { kind: 'date', at: '2027-02-28T17:00:00-08:00', timezone: 'America/Los_Angeles' },
        cutoff: { at: '2027-02-28T12:00:00Z', timezone: 'UTC' },
      }).success,
    ).toBe(true);
  });

  it('rejects invented historical dates, unknown-date values, and invalid zoned instants', () => {
    const base = {
      title: 'A wager',
      terms: 'The official announcement decides',
      category: 'Work',
      opponentId: 'peer',
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake: 1,
      acknowledgements: { terms: true, result: false, delivery: false },
      timing: { kind: 'event', description: 'The launch is announced' },
    };
    for (const originalDate of [
      { precision: 'day', value: '2025-02-29' },
      { precision: 'month', value: '2024-13' },
      { precision: 'year', value: '24' },
      { precision: 'year', value: '0000' },
      { precision: 'month', value: '0000-02' },
      { precision: 'day', value: '0000-02-28' },
      { precision: 'unknown', value: '2024-01-01' },
    ])
      expect(
        newBetSchema.safeParse({ ...base, history: { stage: 'active', originalDate } }).success,
      ).toBe(false);
    for (const checkIn of [
      { at: '2027-02-28T17:00', timezone: 'UTC' },
      { at: '2027-02-28T17:00Z', timezone: 'UTC' },
      { at: '2027-02-30T17:00:00Z', timezone: 'UTC' },
      { at: '2027-02-28T17:00:00Z', timezone: 'Invalid/Timezone' },
    ])
      expect(actionSchema.safeParse({ type: 'set_check_in', checkIn }).success).toBe(false);
  });

  it('accepts workflow actions while rejecting approval, actor, and audit-field injection at every level', () => {
    const acknowledgements = { terms: true, result: true, delivery: true };
    const history = {
      stage: 'settled',
      originalDate: { precision: 'year', value: '2024' },
      result: { winnerId: 'peer', date: { precision: 'unknown' }, note: 'Agreed result' },
      delivery: { date: { precision: 'unknown' }, note: 'Actual rolls were delivered' },
      previousAdjudication: {
        method: 'judge',
        note: 'Previously reported by the named judge',
        sourceUrl: 'https://evidence.example/report',
      },
    };
    const revision = {
      title: 'A wager',
      terms: 'The official announcement decides',
      category: 'Work',
      creatorSide: 'Yes',
      opponentSide: 'No',
      stake: 1,
      history,
    };
    const timing = {
      kind: 'evidence',
      description: 'The published result',
      source: 'Company newsroom',
    };
    for (const action of [
      { type: 'confirm_history', acknowledgements },
      { type: 'request_history_correction', note: 'The original stake was two rolls' },
      { type: 'revise_history', revision, acknowledgements },
      { type: 'mark_ready', evidence: 'The published announcement is available' },
      { type: 'set_check_in', checkIn: { at: '2027-03-01T12:00:00Z', timezone: 'UTC' } },
      { type: 'set_check_in', checkIn: null },
      {
        type: 'propose_amendment',
        terms: 'The official announcement decides',
        timing,
        note: 'Use the published result',
      },
      { type: 'confirm_amendment' },
      { type: 'reject_amendment', note: 'Keep the original terms' },
      { type: 'propose_void', note: 'No clear result is possible' },
      { type: 'confirm_void' },
      { type: 'reject_void', note: 'Keep the original bet' },
    ]) {
      expect(actionSchema.safeParse(action).success).toBe(true);
      for (const forged of [
        { actorId: 'peer' },
        { approvals: ['peer'] },
        { status: 'settled' },
        { at: '2024-01-01T00:00:00Z' },
      ])
        expect(actionSchema.safeParse({ ...action, ...forged }).success).toBe(false);
    }
    for (const forged of [
      { approvals: [] },
      { proposedBy: 'peer' },
      { confirmedAt: '2024-01-01T00:00:00Z' },
    ]) {
      expect(
        actionSchema.safeParse({
          type: 'revise_history',
          revision: { ...revision, history: { ...history, ...forged } },
          acknowledgements,
        }).success,
      ).toBe(false);
    }
    expect(
      actionSchema.safeParse({ type: 'confirm_history', acknowledgements: { terms: true } })
        .success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'confirm_history',
        acknowledgements: { ...acknowledgements, actorId: 'peer' },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'revise_history',
        revision: { ...revision, opponentId: 'outsider' },
        acknowledgements,
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'propose_amendment',
        terms: revision.terms,
        timing: { ...timing, markedBy: 'peer' },
        note: 'Changed',
      }).success,
    ).toBe(false);
  });

  it('limits body bytes even without Content-Length and translates invalid JSON', async () => {
    await expect(
      readJson(
        new Request('https://ledger.example/api/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'x'.repeat(40000),
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readJson(
        new Request('https://ledger.example/api/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('preserves a maximum-length Unicode prompt within the body limit', async () => {
    const action = { type: 'propose_prompt', text: '議'.repeat(8000) };
    const payload = { action, version: 1 };
    expect(actionSchema.safeParse(action).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'propose_prompt', text: 'Too short' }).success).toBe(
      false,
    );
    expect(
      actionSchema.safeParse({ type: 'approve_prompt', actorId: 'another-bettor' }).success,
    ).toBe(false);
    await expect(
      readJson(
        new Request('https://ledger.example/api/bets/id/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      ),
    ).resolves.toEqual(payload);
  });
});

describe('Google identity verification', () => {
  it('only treats Gmail and hosted Google Workspace email as authoritative', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const issue = (email: string, hd?: string) =>
      new SignJWT({ email, email_verified: true, nonce: 'nonce', ...(hd ? { hd } : {}) })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('google-subject')
        .setIssuer('https://accounts.google.com')
        .setAudience('client-id')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    expect(
      await verifyGoogleIdentity(await issue('owner@gmail.com'), 'client-id', 'nonce', publicKey),
    ).toMatchObject({ emailAuthoritative: true });
    expect(
      await verifyGoogleIdentity(
        await issue('owner@company.example', 'company.example'),
        'client-id',
        'nonce',
        publicKey,
      ),
    ).toMatchObject({ emailAuthoritative: true });
    expect(
      await verifyGoogleIdentity(
        await issue('former-owner@company.example'),
        'client-id',
        'nonce',
        publicKey,
      ),
    ).toMatchObject({ emailAuthoritative: false });
  });

  it('accepts a valid Google token and rejects replay, wrong audience, unverified email, and expired tokens', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const issue = (claims = {}, audience = 'client-id', expiry: number | string = '5m') =>
      new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        name: 'Owner',
        nonce: 'expected-nonce',
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('google-subject')
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiry)
        .sign(privateKey);
    await expect(
      verifyGoogleIdentity(await issue(), 'client-id', 'expected-nonce', publicKey),
    ).resolves.toMatchObject({ sub: 'google-subject', email: 'owner@example.com' });
    await expect(
      verifyGoogleIdentity(await issue(), 'client-id', 'wrong-nonce', publicKey),
    ).rejects.toThrow();
    await expect(
      verifyGoogleIdentity(
        await issue({}, 'different-client'),
        'client-id',
        'expected-nonce',
        publicKey,
      ),
    ).rejects.toThrow();
    await expect(
      verifyGoogleIdentity(
        await issue({ email_verified: false }),
        'client-id',
        'expected-nonce',
        publicKey,
      ),
    ).rejects.toThrow();
    await expect(
      verifyGoogleIdentity(
        await issue({}, 'client-id', 1),
        'client-id',
        'expected-nonce',
        publicKey,
      ),
    ).rejects.toThrow();
  });
});
