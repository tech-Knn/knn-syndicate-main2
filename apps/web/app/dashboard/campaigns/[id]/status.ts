import type { Campaign } from '@/lib/types';

/** Statuses that have (or had) delivery at the ad network, so there are numbers to show. */
export const HAS_DELIVERY = new Set(['ACTIVE', 'PAUSED', 'META_REJECTED', 'ARCHIVED']);

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

/** The ad network a campaign runs on, in words (D33). Every live control says it instead of assuming Facebook. */
export const networkName = (c: Pick<Campaign, 'adProvider'>): string => (c.adProvider === 'WHOP' ? 'Whop' : 'Facebook');

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Delivering right now: the dot pulses. */
  live?: boolean;
}

/** One place that names each lifecycle state for the page header, so the pill and the status card never disagree. */
export function statusMeta(c: Pick<Campaign, 'status' | 'adProvider'>): StatusMeta {
  switch (c.status) {
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral' };
    case 'PENDING_APPROVAL':
      return { label: 'In review', tone: 'warning' };
    case 'APPROVED':
      return { label: 'Approved', tone: 'brand' };
    case 'PROCESSING':
      return { label: 'Ready to publish', tone: 'brand' };
    case 'LAUNCHING':
      return { label: 'Launching', tone: 'brand' };
    case 'ACTIVE':
      return { label: 'Live', tone: 'success', live: true };
    case 'PAUSED':
      return { label: 'Paused', tone: 'warning' };
    case 'REJECTED':
      return { label: 'Not approved', tone: 'danger' };
    case 'BATCHED':
      return { label: 'Rate-limited', tone: 'warning' };
    case 'QUEUED_NO_CHANNEL':
      return { label: 'Waiting for a channel', tone: 'warning' };
    case 'META_REJECTED':
      return { label: 'Rejected by Meta', tone: 'danger' };
    case 'ARCHIVED':
      return { label: 'Archived', tone: 'neutral' };
  }
}

/** "3 min ago", "2 h ago", "4 d ago". Falls back to a date past a month. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Cloaker campaigns record a white domain at launch; a Normal one never does. null = not launched yet, so unknown. */
export const funnelOf = (c: Pick<Campaign, 'redirectDomainHost' | 'whiteDomainHost'>): 'CLOAKER' | 'NORMAL' | null =>
  c.whiteDomainHost ? 'CLOAKER' : c.redirectDomainHost ? 'NORMAL' : null;

/** The smallest daily budget the UI lets a buyer type, in cents. Facebook's floor is $2.00; Whop states its own and
 *  refuses anything below it in words, so for Whop only a non-budget (under one cent) is stopped here. */
export const minBudgetCents = (c: Pick<Campaign, 'adProvider'>): number => (c.adProvider === 'WHOP' ? 1 : 200);
export const minBudgetMessage = (c: Pick<Campaign, 'adProvider'>): string =>
  c.adProvider === 'WHOP' ? 'Enter a daily budget of at least $0.01.' : 'Minimum daily budget is $2.00 (Facebook minimum).';

/** The go-link one ad carries: the host recorded at launch plus that ad's own redirect id (D9). */
export const goLink = (host: string, redirectId: string): string => `https://${host}/go/${redirectId}`;
