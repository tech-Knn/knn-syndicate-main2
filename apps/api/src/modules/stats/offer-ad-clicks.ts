import { allocateByWeights } from '@knn/shared';

/** A campaign's tracked ad clicks grouped by the website host + AFS channel of the click's page URL. */
export interface AdClickSource {
  host: string | null;
  channel: string | null;
  clicks: number;
}

export interface OfferForCredit {
  id: string;
  host: string;
  /** AFS channel ids the offer used in the range (current + any it rolled over from). */
  channelIds: readonly string[];
  weightPct: number;
}

/**
 * Credit a campaign's tracked ad clicks to its offers (websites). The host decides: the ad click
 * happens on the /search page of the website the visitor landed on (every staging click matched an
 * offer host). When one host serves several offers (e.g. an article A/B test on one domain), the
 * click's channel picks the offer; failing that, that host's clicks are split by traffic share.
 * Clicks on a host that isn't one of the campaign's websites are left out.
 */
export function creditAdClicksToOffers(sources: readonly AdClickSource[], offers: readonly OfferForCredit[]): Map<string, number> {
  const out = new Map(offers.map((o) => [o.id, 0]));
  const byHost = new Map<string, OfferForCredit[]>();
  for (const o of offers) {
    const host = o.host.toLowerCase();
    byHost.set(host, [...(byHost.get(host) ?? []), o]);
  }
  const add = (id: string, n: number): void => {
    out.set(id, (out.get(id) ?? 0) + n);
  };

  const toSplit = new Map<string, number>(); // shared host → clicks no channel could place
  for (const s of sources) {
    if (!s.host || s.clicks <= 0) continue;
    const host = s.host.toLowerCase();
    const candidates = byHost.get(host);
    if (!candidates) continue;
    const pick =
      candidates.length === 1 ? candidates[0] : candidates.find((o) => s.channel !== null && o.channelIds.includes(s.channel));
    if (pick) add(pick.id, s.clicks);
    else toSplit.set(host, (toSplit.get(host) ?? 0) + s.clicks);
  }
  for (const [host, clicks] of toSplit) {
    const candidates = byHost.get(host) ?? [];
    const weights = candidates.map((o) => o.weightPct);
    // All-zero shares (e.g. organic offers) would drop the clicks — split evenly instead.
    const shares = allocateByWeights(clicks, weights.some((w) => w > 0) ? weights : weights.map(() => 1));
    candidates.forEach((o, i) => add(o.id, shares[i] ?? 0));
  }
  return out;
}
