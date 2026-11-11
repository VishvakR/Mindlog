import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { REDACTION_KINDS, redact, redactValue } from '../src/index.js';

const ALL = REDACTION_KINDS;

describe('redact', () => {
  test.each([
    ['Mail me at ann.lee+work@example.co.uk today', 'Mail me at [EMAIL] today'],
    ['Call +1 (415) 555-0132 or 020 7946 0958', 'Call [PHONE] or [PHONE]'],
    ['Card 4111 1111 1111 1111 expires soon', 'Card [CARD] expires soon'],
    ['SSN 078-05-1120 on file', 'SSN [ID] on file'],
    ['Pay to GB82 WEST 1234 5698 7654 32 please', 'Pay to [ID] please'],
  ])('%s', (input, output) => {
    expect(redact(input, ALL)).toBe(output);
  });

  test('leaves ordinary numbers alone', () => {
    for (const text of [
      'In 2026 we sold 1500000 units',
      'Version 1.2.3 shipped',
      'Order 4111111111111112 is not a card (bad Luhn)',
      'Meet at 10:30 on 2026-11-11',
    ])
      expect(redact(text, ALL)).toBe(text);
  });

  test('only the chosen kinds', () => {
    expect(redact('a@b.io 078-05-1120', ['email'])).toBe('[EMAIL] 078-05-1120');
    expect(redact('a@b.io', [])).toBe('a@b.io');
  });

  test('is idempotent and never leaves an email behind', () => {
    const email = fc
      .tuple(fc.stringMatching(/^[a-z0-9._]{1,12}$/), fc.stringMatching(/^[a-z]{1,10}$/))
      .map(([user, host]) => `${user}@${host}.com`);
    fc.assert(
      fc.property(fc.string(), email, fc.string(), (before, address, after) => {
        const once = redact(`${before} ${address} ${after}`, ALL);
        expect(once).not.toContain(address);
        expect(redact(once, ALL)).toBe(once);
      }),
    );
  });

  test('text without digits or @ is untouched', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[^0-9@]*$/), (text) => {
        expect(redact(text, ALL)).toBe(text);
      }),
    );
  });

  test('metadata is redacted all the way down', () => {
    expect(redactValue({ who: 'a@b.io', list: ['078-05-1120', 3], n: 4 }, ALL)).toEqual({
      who: '[EMAIL]',
      list: ['[ID]', 3],
      n: 4,
    });
  });
});
