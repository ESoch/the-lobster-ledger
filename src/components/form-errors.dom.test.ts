// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlProblem, shareLinkProblem, timezoneProblem } from './form-errors';

describe('timezoneProblem', () => {
  it('accepts a place name, UTC and an Etc zone', () => {
    for (const zone of ['America/New_York', 'Europe/London', 'UTC', 'GMT', 'Etc/GMT+5', ' UTC '])
      expect(timezoneProblem(zone)).toBeUndefined();
  });

  it('asks for a timezone when the box is empty', () => {
    expect(timezoneProblem('  ')).toContain('Choose a timezone');
  });

  it('names a zone it does not know', () => {
    expect(timezoneProblem('Mars/Base')).toContain('“Mars/Base” is not a timezone we know');
  });

  it('turns away a fixed-offset abbreviation that ignores daylight saving, and says what to use', () => {
    for (const zone of ['EST', 'est', 'MST']) {
      const problem = timezoneProblem(zone);
      expect(problem, zone).toContain(`“${zone}”`);
      expect(problem, zone).toContain('daylight saving');
      expect(problem, zone).toContain('America/New_York');
    }
  });

  it('accepts short names that follow daylight saving, and HST, which Hawaii keeps all year', () => {
    // CET is +01:00 in January and +02:00 in July; EST5EDT is -05:00 and -04:00.
    for (const zone of [
      'CET',
      'MET',
      'EET',
      'WET',
      'EST5EDT',
      'CST6CDT',
      'MST7MDT',
      'PST8PDT',
      'HST',
    ])
      expect(timezoneProblem(zone), zone).toBeUndefined();
  });
});

describe('shareLinkProblem', () => {
  it('accepts exactly the share links the ledger records, with an example otherwise', () => {
    for (const link of [
      'https://chatgpt.com/share/abc123',
      ' https://chat.openai.com/share/a-b_c/ ',
    ])
      expect(shareLinkProblem(link), link).toBeUndefined();
    for (const link of [
      '',
      'chatgpt.com/share/abc123',
      'http://chatgpt.com/share/abc123',
      'https://chatgpt.com/c/abc123',
      'https://chatgpt.com:444/share/abc123',
      'https://chatgpt.com/share/abc123?x=1',
      'https://evil.example/share/abc123',
      `https://chatgpt.com/share/${'a'.repeat(500)}`,
    ])
      expect(shareLinkProblem(link), link).toBe(
        'Paste a ChatGPT share link, such as https://chatgpt.com/share/abc123.',
      );
  });
});

describe('text that takes no room on screen', () => {
  afterEach(() => document.body.replaceChildren());
  function control(html: string, value: string) {
    const form = document.createElement('form');
    form.innerHTML = html;
    document.body.appendChild(form);
    const element = form.elements[0] as HTMLInputElement;
    element.value = value;
    return { form, element };
  }

  it('counts only what shows toward a minimum, and treats nothing but zero-width text as empty', () => {
    const { form, element } = control('<input name="title" required minlength="5" />', '');
    element.value = 'ab\u200b\u200c\u200d\u2060\ufeff';
    expect(controlProblem(element, form)).toBe('Use at least 5 characters.');
    element.value = '\u200b\u200b\u200b\u200b\u200b\u200b';
    expect(controlProblem(element, form)).toBe('Fill this in.');
    element.value = '\u200bab\u200bcde';
    expect(controlProblem(element, form)).toBeUndefined();
  });

  it('still counts every stored character toward a maximum', () => {
    const { form, element } = control('<input name="title" maxlength="8" />', '');
    // Typed text is held to the maxlength attribute by the browser; a pasted value can still be over.
    element.value = 'ab\u200b\u200b\u200b\u200b\u200b\u200bcd';
    expect(controlProblem(element, form)).toBe('Use 8 characters or fewer.');
  });
});

describe('a date far outside the calendar people use', () => {
  afterEach(() => document.body.replaceChildren());
  function formWith(attributes: string, value: string) {
    const form = document.createElement('form');
    form.innerHTML = `
      <input name="when.local" type="datetime-local" data-zone-field="when.timezone" required ${attributes} />
      <input name="when.timezone" value="America/Los_Angeles" required />`;
    document.body.appendChild(form);
    const local = form.elements.namedItem('when.local') as HTMLInputElement;
    local.value = value;
    return { form, local };
  }
  const message = 'Choose a date between 2000 and 2100.';

  it('says so in plain words, whether or not the field states its range', () => {
    for (const attributes of ['', 'min="2000-01-01T00:00" max="2100-12-31T23:59"']) {
      for (const value of ['0001-01-01T00:00', '9999-12-31T23:59', '1999-12-31T23:59']) {
        const { form, local } = formWith(`${attributes} data-range-message="${message}"`, value);
        expect(controlProblem(local, form), `${value} ${attributes}`).toBe(message);
        form.remove();
      }
    }
  });

  it('accepts the ends of the range', () => {
    const { form, local } = formWith('', '2000-01-01T00:00');
    expect(controlProblem(local, form)).toBeUndefined();
    local.value = '2100-12-31T23:59';
    expect(controlProblem(local, form)).toBeUndefined();
  });
});

describe('a time that must still be ahead', () => {
  afterEach(() => vi.useRealTimers());
  function formWith(attributes: {
    future?: 'always' | 'changed';
    value: string;
    initial?: string;
  }) {
    const form = document.createElement('form');
    form.innerHTML = `
      <input name="when.local" type="datetime-local" data-zone-field="when.timezone" required />
      <input name="when.timezone" value="UTC" required />`;
    document.body.appendChild(form);
    const local = form.elements.namedItem('when.local') as HTMLInputElement;
    if (attributes.future) local.dataset.future = attributes.future;
    // The value the form opened with, as an uncontrolled React input sets it.
    local.defaultValue = attributes.initial ?? '';
    local.value = attributes.value;
    const zone = form.elements.namedItem('when.timezone') as HTMLInputElement;
    zone.defaultValue = 'UTC';
    return { form, local };
  }
  afterEach(() => document.body.replaceChildren());

  it('names a time that has passed, in the zone that was chosen', () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T12:00:00Z') });
    const { form, local } = formWith({ future: 'always', value: '2026-09-01T11:59' });
    expect(controlProblem(local, form)).toBe('Choose a time that hasn’t passed yet.');
    local.value = '2026-09-01T12:01';
    expect(controlProblem(local, form)).toBeUndefined();
    // The same wall-clock time is later in a zone that is behind UTC.
    (form.elements.namedItem('when.timezone') as HTMLInputElement).value = 'America/Los_Angeles';
    local.value = '2026-09-01T11:59';
    expect(controlProblem(local, form)).toBeUndefined();
  });

  it('lets a time that was already there stay when only changes are checked', () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T12:00:00Z') });
    const unchanged = formWith({
      future: 'changed',
      value: '2026-08-20T09:00',
      initial: '2026-08-20T09:00',
    });
    expect(controlProblem(unchanged.local, unchanged.form)).toBeUndefined();
    unchanged.local.value = '2026-08-21T09:00';
    expect(controlProblem(unchanged.local, unchanged.form)).toBe(
      'Choose a time that hasn’t passed yet.',
    );
  });

  it('leaves a past time alone when no check was asked for', () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T12:00:00Z') });
    const { form, local } = formWith({ value: '2026-08-01T09:00' });
    expect(controlProblem(local, form)).toBeUndefined();
  });
});
