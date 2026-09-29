import { allocateByWeights } from '@knn/shared';

/** A campaign's tracked funnel events of one stage, grouped by the host + AFS channel of their page URL. */
export interface EventSource {
  host: string | null;
  channel: string | null;
  count: number;
}

export interface OfferForCredit {
  id: string;
  host: string;
  /** AFS channel ids the offer used in the range (current + any it rolled over from). */
  channelIds: readonly string[];
  weightPct: number;
}

/**
 * Credit a campaign's tracked funnel events (landings, keyword clicks, ad clicks) to its offers
 * (websites). The host decides: every event happens on a page of the website the visitor landed on
 * (every staging event matched an offer host). When one host serves several offers (e.g. an article
 * A/B test on one domain), the event's channel picks the offer — only results-page URLs carry one —
 * and failing that, that host's events are split by traffic share. Events on a host that isn't one of
 * the campaign's websites are left out.
 */
export function creditToOffers(sources: readonly EventSource[], offers: readonly OfferForCredit[]): Map<string, number> {
  const out = new Map(offers.map((o) => [o.id, 0]));
  const byHost = new Map<string, OfferForCredit[]>();
  for (const o of offers) {
    const host = o.host.toLowerCase();
    byHost.set(host, [...(byHost.get(host) ?? []), o]);
  }
  const add = (id: string, n: number): void => {
    out.set(id, (out.get(id) ?? 0) + n);
  };

  const toSplit = new Map<string, number>(); // shared host → events no channel could place
  for (const s of sources) {
    if (!s.host || s.count <= 0) continue;
    const host = s.host.toLowerCase();
    const candidates = byHost.get(host);
    if (!candidates) continue;
    const pick =
      candidates.length === 1 ? candidates[0] : candidates.find((o) => s.channel !== null && o.channelIds.includes(s.channel));
    if (pick) add(pick.id, s.count);
    else toSplit.set(host, (toSplit.get(host) ?? 0) + s.count);
  }
  for (const [host, count] of toSplit) {
    const candidates = byHost.get(host) ?? [];
    const weights = candidates.map((o) => o.weightPct);
    // All-zero shares (e.g. organic offers) would drop the events — split evenly instead.
    const shares = allocateByWeights(count, weights.some((w) => w > 0) ? weights : weights.map(() => 1));
    candidates.forEach((o, i) => add(o.id, shares[i] ?? 0));
  }
  return out;
}
