import { describe, expect, it } from 'vitest';
import type { Campaign } from '@/lib/types';
import { HAS_DELIVERY, funnelOf, goLink, minBudgetCents, minBudgetMessage, networkName, routingVisibility, statusMeta, timeAgo } from './status';
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
