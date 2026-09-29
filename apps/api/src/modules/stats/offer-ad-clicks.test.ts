import { describe, expect, it } from 'vitest';
import { creditAdClicksToOffers } from './offer-ad-clicks.js';

const offer = (id: string, host: string, weightPct: number, channelIds: string[] = []) => ({ id, host, weightPct, channelIds });

describe('creditAdClicksToOffers', () => {
  it('credits each click to the website it happened on (host, case-insensitive)', () => {
    const credit = creditAdClicksToOffers(
      [
        { host: 'hi.example.com', channel: '111', clicks: 7 },
        { host: 'hi.example.com', channel: '999', clicks: 2 }, // an older, rolled-over channel: host still decides
        { host: 'lo.example.com', channel: null, clicks: 3 },
      ],
      [offer('hi', 'Hi.Example.com', 60), offer('lo', 'lo.example.com', 40)],
    );
    expect(Object.fromEntries(credit)).toEqual({ hi: 9, lo: 3 });
  });

  it("leaves out clicks on a host that isn't one of the campaign's websites, and offers with none get 0", () => {
    const credit = creditAdClicksToOffers(
      [
        { host: 'other.example.com', channel: '1', clicks: 5 },
        { host: null, channel: null, clicks: 4 },
      ],
      [offer('a', 'a.example.com', 100)],
    );
    expect(Object.fromEntries(credit)).toEqual({ a: 0 });
  });

  it('one host, several offers (article A/B on one domain): the channel picks, the rest split by traffic share', () => {
    const credit = creditAdClicksToOffers(
      [
        { host: 'ab.example.com', channel: 'A1', clicks: 10 },
        { host: 'ab.example.com', channel: 'B1', clicks: 4 },
        { host: 'ab.example.com', channel: null, clicks: 5 }, // no channel → 60/40 → 3 / 2
      ],
      [offer('a', 'ab.example.com', 60, ['A1', 'A0']), offer('b', 'ab.example.com', 40, ['B1'])],
    );
    expect(Object.fromEntries(credit)).toEqual({ a: 13, b: 6 });
  });

  it('splits evenly when every sharing offer has a zero traffic share (never drops clicks)', () => {
    const credit = creditAdClicksToOffers(
      [{ host: 'o.example.com', channel: null, clicks: 3 }],
      [offer('x', 'o.example.com', 0), offer('y', 'o.example.com', 0)],
    );
    expect([...credit.values()].reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.fromEntries(credit)).toEqual({ x: 2, y: 1 });
  });
});
