import { describe, expect, it } from 'vitest';
import { creditToOffers } from './offer-funnel.js';

const offer = (id: string, host: string, weightPct: number, channelIds: string[] = []) => ({ id, host, weightPct, channelIds });

describe('creditToOffers', () => {
  it('credits each event to the website it happened on (host, case-insensitive)', () => {
    const credit = creditToOffers(
      [
        { host: 'hi.example.com', channel: '111', count: 7 },
        { host: 'hi.example.com', channel: '999', count: 2 }, // an older, rolled-over channel: host still decides
        { host: 'lo.example.com', channel: null, count: 3 }, // landing pages carry no channel
      ],
      [offer('hi', 'Hi.Example.com', 60), offer('lo', 'lo.example.com', 40)],
    );
    expect(Object.fromEntries(credit)).toEqual({ hi: 9, lo: 3 });
  });

  it("leaves out events on a host that isn't one of the campaign's websites, and offers with none get 0", () => {
    const credit = creditToOffers(
      [
        { host: 'other.example.com', channel: '1', count: 5 },
        { host: null, channel: null, count: 4 },
      ],
      [offer('a', 'a.example.com', 100)],
    );
    expect(Object.fromEntries(credit)).toEqual({ a: 0 });
  });

  it('one host, several offers (article A/B on one domain): the channel picks, the rest split by traffic share', () => {
    const credit = creditToOffers(
      [
        { host: 'ab.example.com', channel: 'A1', count: 10 },
        { host: 'ab.example.com', channel: 'B1', count: 4 },
        { host: 'ab.example.com', channel: null, count: 5 }, // no channel → 60/40 → 3 / 2
      ],
      [offer('a', 'ab.example.com', 60, ['A1', 'A0']), offer('b', 'ab.example.com', 40, ['B1'])],
    );
    expect(Object.fromEntries(credit)).toEqual({ a: 13, b: 6 });
  });

  it('splits evenly when every sharing offer has a zero traffic share (never drops events)', () => {
    const credit = creditToOffers(
      [{ host: 'o.example.com', channel: null, count: 3 }],
      [offer('x', 'o.example.com', 0), offer('y', 'o.example.com', 0)],
    );
    expect([...credit.values()].reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.fromEntries(credit)).toEqual({ x: 2, y: 1 });
  });
});
