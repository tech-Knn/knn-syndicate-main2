import { describe, expect, it } from 'vitest';
import type { Campaign } from '@/lib/types';
import { HAS_DELIVERY, funnelOf, goLink, minBudgetCents, minBudgetMessage, networkName, routingVisibility, statusMeta, timeAgo } from './status';
import { STUCK_LAUNCH_MS, bigCount, budgetText, count, formatWhen, launchStuck, money, safe, scheduleText, totalBudgetCents } from './format';
import { rangeFor } from './use-stats';

type Status = Campaign['status'];
const ALL: Status[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'LAUNCHING', 'ACTIVE', 'PAUSED', 'REJECTED', 'BATCHED', 'QUEUED_NO_CHANNEL', 'META_REJECTED', 'ARCHIVED'];

describe('statusMeta', () => {
  it('names every lifecycle state (no status is left without a label)', () => {
    for (const status of ALL) {
      const m = statusMeta({ status, adProvider: 'WHOP' });
      expect(m.label.length, status).toBeGreaterThan(0);
      expect(['neutral', 'brand', 'success', 'warning', 'danger']).toContain(m.tone);
    }
  });

  it('only a live campaign pulses, and the tones say what needs attention', () => {
    expect(statusMeta({ status: 'ACTIVE', adProvider: 'FACEBOOK' })).toEqual({ label: 'Live', tone: 'success', live: true });
    for (const status of ALL.filter((s) => s !== 'ACTIVE')) expect(statusMeta({ status, adProvider: 'FACEBOOK' }).live, status).toBeUndefined();
    expect(statusMeta({ status: 'META_REJECTED', adProvider: 'WHOP' }).tone).toBe('danger');
    expect(statusMeta({ status: 'PAUSED', adProvider: 'WHOP' }).tone).toBe('warning');
    expect(statusMeta({ status: 'PROCESSING', adProvider: 'WHOP' }).label).toBe('Ready to publish');
  });
});

describe('HAS_DELIVERY', () => {
  it('is exactly the states that have, or had, delivery (so there are numbers to show)', () => {
    expect([...HAS_DELIVERY].sort()).toEqual(['ACTIVE', 'ARCHIVED', 'META_REJECTED', 'PAUSED']);
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  it('says never for nothing and for rubbish', () => {
    expect(timeAgo(null, now)).toBe('never');
    expect(timeAgo(undefined, now)).toBe('never');
    expect(timeAgo('not a date', now)).toBe('never');
  });
  it('reads in the unit a person thinks in', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('3 h ago');
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe('4 d ago');
  });
  it('never goes negative when the clock is a little ahead', () => {
    expect(timeAgo(new Date(now + 60_000).toISOString(), now)).toBe('just now');
  });
  it('falls back to a date after a month', () => {
    expect(timeAgo(ago(45 * 86_400_000), now)).toMatch(/2026/);
  });
});

describe('funnelOf', () => {
  it('a white domain means Cloaker, a launch without one means Normal, no launch means unknown', () => {
    expect(funnelOf({ redirectDomainHost: 'clkroute.com', whiteDomainHost: 'readoranow.com' })).toBe('CLOAKER');
    expect(funnelOf({ redirectDomainHost: 'clkroute.com', whiteDomainHost: null })).toBe('NORMAL');
    expect(funnelOf({ redirectDomainHost: null, whiteDomainHost: null })).toBeNull();
  });
});

describe('links and budgets', () => {
  it("builds an ad's go-link from the recorded host and its own redirect id", () => {
    expect(goLink('clkroute.com', 'aNEa4lQ5nVia')).toBe('https://clkroute.com/go/aNEa4lQ5nVia');
  });
  it('names the network and its budget floor', () => {
    expect(networkName({ adProvider: 'WHOP' })).toBe('Whop');
    expect(networkName({ adProvider: 'FACEBOOK' })).toBe('Facebook');
    expect(minBudgetCents({ adProvider: 'FACEBOOK' })).toBe(200);
    expect(minBudgetCents({ adProvider: 'WHOP' })).toBe(1);
    expect(minBudgetMessage({ adProvider: 'FACEBOOK' })).toContain('$2.00');
    expect(minBudgetMessage({ adProvider: 'WHOP' })).toContain('$0.01');
  });
});

describe('rangeFor', () => {
  const days = (r: { from: string; to: string }): number => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
  it('is an inclusive run of business days ending today', () => {
    expect(days(rangeFor('today'))).toBe(1);
    expect(days(rangeFor('7d'))).toBe(7);
    expect(days(rangeFor('30d'))).toBe(30);
    expect(rangeFor('7d').to).toBe(rangeFor('today').to);
  });
});

describe('routingVisibility (what the Routing tab may show)', () => {
  it('shows the platform everything', () => {
    expect(routingVisibility('SUPER_ADMIN')).toEqual({ publisherAndStyle: true, whiteHost: true, cloakNote: true });
  });
  it('hides the Google account, the white domain and the cloaker explanation from companies and buyers', () => {
    for (const role of ['COMPANY_ADMIN', 'MEDIA_BUYER'] as const) {
      expect(routingVisibility(role), role).toEqual({ publisherAndStyle: false, whiteHost: false, cloakNote: false });
    }
  });
  it('hides it all until the role is known (a page that has not loaded the user yet leaks nothing)', () => {
    expect(routingVisibility(null)).toEqual({ publisherAndStyle: false, whiteHost: false, cloakNote: false });
    expect(routingVisibility(undefined)).toEqual({ publisherAndStyle: false, whiteHost: false, cloakNote: false });
  });
});

describe('safe', () => {
  it('turns anything that is not a finite number into 0', () => {
    expect([safe(3.5), safe(0), safe(-2)]).toEqual([3.5, 0, -2]);
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, '12', {}]) expect(safe(bad)).toBe(0);
  });
});

describe('formatWhen / scheduleText', () => {
  const at = '2026-10-01T09:00:00Z';
  it('writes a moment in the ad set timezone', () => {
    expect(formatWhen(at, 'Asia/Kolkata')).toMatch(/1 Oct.*14:30/);
    expect(formatWhen(at, 'UTC')).toMatch(/1 Oct.*09:00/);
  });
  it('does not blow up on an unknown timezone name, or a bad date', () => {
    expect(() => formatWhen(at, 'Mars/Phobos')).not.toThrow();
    expect(formatWhen(at, 'Mars/Phobos')).toMatch(/14:30/); // falls back to the business timezone
    expect(formatWhen('not a date', 'UTC')).toBe('an unknown time');
    expect(formatWhen(at, null)).toMatch(/14:30/);
  });
  it('reads as a schedule', () => {
    expect(scheduleText({ startTime: null, endTime: null, timezone: null })).toBe('Runs until paused');
    expect(scheduleText({ startTime: at, endTime: null, timezone: 'UTC' })).toMatch(/^1 Oct.* to until paused$/);
    expect(scheduleText({ startTime: null, endTime: at, timezone: 'UTC' })).toMatch(/^now to 1 Oct/);
  });
});

describe('budgets', () => {
  const sets = (...cents: (number | null)[]): Pick<Campaign, 'adSets'>['adSets'] => cents.map((c) => ({ dailyBudgetCents: c }) as never);
  it('adds the ad sets up for ABO and uses the campaign figure for CBO', () => {
    expect(totalBudgetCents({ budgetMode: 'AD_SET', dailyBudgetCents: null, adSets: sets(2500, 1000) })).toBe(3500);
    expect(totalBudgetCents({ budgetMode: 'CAMPAIGN', dailyBudgetCents: 4000, adSets: sets(1, 1) })).toBe(4000);
  });
  it('says "Not set" instead of $0.00 when nothing is set', () => {
    expect(budgetText({ budgetMode: 'AD_SET', dailyBudgetCents: null, adSets: sets(null) })).toBe('Not set');
    expect(budgetText({ budgetMode: 'CAMPAIGN', dailyBudgetCents: null, adSets: [] })).toBe('Not set');
    expect(budgetText({ budgetMode: 'CAMPAIGN', dailyBudgetCents: 2500, adSets: [] })).toBe('$25.00 a day');
  });
});

describe('launchStuck', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  it('only a launching campaign that has been silent past the limit is stuck', () => {
    expect(launchStuck({ status: 'LAUNCHING', updatedAt: ago(STUCK_LAUNCH_MS + 1000) }, now)).toBe(true);
    expect(launchStuck({ status: 'LAUNCHING', updatedAt: ago(60_000) }, now)).toBe(false);
    expect(launchStuck({ status: 'ACTIVE', updatedAt: ago(STUCK_LAUNCH_MS * 10) }, now)).toBe(false);
    expect(launchStuck({ status: 'LAUNCHING', updatedAt: 'garbage' }, now)).toBe(false);
  });
});

describe('money / bigCount / count (figures that must fit a tile)', () => {
  it('is exact to the cent below a million dollars', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(-999_999.99)).toBe('-$999,999.99');
  });
  it('goes compact from a million, for gains and losses alike', () => {
    expect(money(22_222_042.02)).toBe('$22.2M');
    expect(money(-4_777_737.15)).toBe('-$4.8M');
  });
  it('never prints NaN, whatever the API sent', () => {
    for (const bad of [null, undefined, NaN, Infinity]) {
      expect(money(bad as never), String(bad)).toBe('$0.00');
      expect(count(bad as never), String(bad)).toBe('0');
      expect(bigCount(bad as never), String(bad)).toBe('0');
    }
  });
  it('counts are exact to ten million, then compact', () => {
    expect(count(3627)).toBe('3,627');
    expect(bigCount(9_999_999)).toBe('9,999,999');
    expect(bigCount(222_222_186)).toBe('222.2M');
  });
});
