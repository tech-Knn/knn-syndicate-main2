'use client';

import { useCallback, useEffect, useState } from 'react';
import { type OfferStat } from '@knn/shared';
import { Badge, Button, Card } from '@/components/ui';
import { campaigns, stats } from '@/lib/api';
import { type ArticleVariantOption, type CampaignStatus, type OfferDomainOption, type OfferRow } from '@/lib/types';
import styles from '../../admin.module.css';

/** Campaign states where offers can still be edited (before channels are assigned). */
const EDITABLE: CampaignStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'QUEUED_NO_CHANNEL'];
/** States where a LIVE campaign's offers can be rebalanced — rewrites edge KV, no Facebook (OQ#9). */
const LIVE_EDITABLE: CampaignStatus[] = ['PROCESSING', 'LAUNCHING', 'BATCHED', 'ACTIVE', 'PAUSED'];

interface Draft {
  /** Existing offer id (kept on a live edit so its channel is preserved); undefined = new. */
  id?: string;
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
  /** Article variant (A/B); '' → the campaign's default article. */
  articleId: string;
}

/**
 * Phase E — the websites a campaign's traffic routes across. Each PAID offer gets the
 * weighted ad-traffic split (and its own AFS channel, assigned at approval); the optional
 * ORGANIC offer is where non-ad traffic goes. Editable only before approval.
 */
export function OffersEditor({ campaignId, status }: { campaignId: string; status: CampaignStatus }) {
  const editable = EDITABLE.includes(status);
  const liveEditable = LIVE_EDITABLE.includes(status);
  const [domains, setDomains] = useState<OfferDomainOption[]>([]);
  const [articleVariants, setArticleVariants] = useState<ArticleVariantOption[]>([]);
  const [rows, setRows] = useState<Draft[]>([]);
  const [saved, setSaved] = useState<OfferRow[] | null>(null);
  const [rev, setRev] = useState<Map<string, OfferStat>>(new Map());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void campaigns.offers(campaignId).then((offers) => {
      setSaved(offers);
      setRows(offers.map((o) => ({ id: o.id, domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId ?? '' })));
    });
    void campaigns.offerDomains().then(setDomains).catch(() => setDomains([]));
    void campaigns.articleVariants().then(setArticleVariants).catch(() => setArticleVariants([]));
    // Per-offer revenue (Phase F) — populated once the campaign runs (30-day window).
    void stats
      .campaignOffers(campaignId, { from: undefined, to: undefined })
      .then((r) => setRev(new Map(r.map((x) => [x.offerId, x]))))
      .catch(() => setRev(new Map()));
  }, [campaignId]);
  useEffect(() => load(), [load]);

  const setRow = (i: number, patch: Partial<Draft>): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = (): void => setRows((rs) => [...rs, { domainId: '', weightPct: 0, kind: 'PAID', articleId: '' }]);
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i));

  const paidWeight = rows.filter((r) => r.kind === 'PAID').reduce((s, r) => s + (r.weightPct || 0), 0);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    const payload = rows.filter((r) => r.domainId);
    try {
      if (liveEditable) {
        // Post-launch rebalance — rewrites edge KV, never touches the Facebook ads.
        const res = await campaigns.updateLiveOffers(
          campaignId,
          payload.map((r) => ({ id: r.id, domainId: r.domainId, weightPct: r.weightPct, kind: r.kind, articleId: r.articleId || null })),
        );
        setSaved(res.offers);
        setRows(res.offers.map((o) => ({ id: o.id, domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId ?? '' })));
        setNote(
          res.rebalancing
            ? 'Rebalancing — assigning/releasing channels, then the new routing lands on the edge in a few seconds. No ad republish.'
            : 'Saved — the new split is live on the edge and takes effect on the next click. No ad republish.',
        );
      } else {
        const offers = await campaigns.setOffers(
          campaignId,
          payload.map((r) => ({ domainId: r.domainId, weightPct: r.weightPct, kind: r.kind, articleId: r.articleId || null })),
        );
        setSaved(offers);
        setNote('Saved.');
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not save offers');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Offers</span>
        <span className={styles.subtle}>
          Route this campaign&apos;s traffic across websites — each paid offer gets a weighted share and
          its own AFS channel. Pick a different <strong>article variant</strong> per offer to A/B test angles
          (each variant&apos;s revenue is tracked on its own channel).
        </span>
      </div>

      {liveEditable && (
        <p className={styles.fieldHint}>
          This campaign is <strong>live</strong> — you can rebalance weights, swap article variants, and add/remove
          offers on the fly. Changes rewrite the edge routing only; the Facebook ads are never touched or re-reviewed.
        </p>
      )}

      {note && <p className={note === 'Saved.' ? styles.savedNote : styles.fieldHint}>{note}</p>}

      {!(editable || liveEditable) ? (
        // Read-only once approved/launched — show the assigned channels.
        saved && saved.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Website</th>
                  <th className={styles.thLeft}>Article</th>
                  <th className={styles.thLeft}>Kind</th>
                  <th>Weight</th>
                  <th>Revenue (30d)</th>
                  <th className={styles.thLeft}>Channel</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((o) => {
                  const r = rev.get(o.id);
                  return (
                    <tr key={o.id}>
                      <td>
                        <div className={styles.name}>{o.host}</div>
                        {o.afsLabel && <div className={styles.subtle}>{o.afsLabel}</div>}
                      </td>
                      <td className={styles.subtle}>{o.articleTitle ?? 'Campaign default'}</td>
                      <td>
                        <Badge tone={o.kind === 'PAID' ? 'brand' : 'neutral'}>{o.kind.toLowerCase()}</Badge>
                      </td>
                      <td className={styles.num}>{o.weightPct}%</td>
                      <td className={`${styles.num} ${r && r.revenueUsd > 0 ? styles.pos : ''}`}>
                        {r ? `$${r.revenueUsd.toFixed(2)}` : '$0.00'}
                      </td>
                      <td className="mono">{o.channelId ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>No offers — this campaign uses the default single-channel funnel.</p>
        )
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Website</th>
                  <th className={styles.thLeft}>Article (A/B)</th>
                  <th className={styles.thLeft}>Kind</th>
                  <th>Weight %</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select className={styles.select} value={r.domainId} onChange={(e) => setRow(i, { domainId: e.target.value })}>
                        <option value="">Select a website…</option>
                        {domains.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.host}
                            {d.afsLabel ? ` — ${d.afsLabel}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className={styles.select}
                        value={r.articleId}
                        onChange={(e) => setRow(i, { articleId: e.target.value })}
                        title="Serve a specific article variant for this offer (A/B test). Default = the campaign's article."
                      >
                        <option value="">Campaign default</option>
                        {articleVariants.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.title}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className={styles.select} value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as Draft['kind'] })}>
                        <option value="PAID">paid</option>
                        <option value="ORGANIC">organic</option>
                      </select>
                    </td>
                    <td className={styles.num}>
                      <input
                        className={styles.cutInput}
                        type="number"
                        min={0}
                        max={100}
                        value={r.weightPct}
                        disabled={r.kind === 'ORGANIC'}
                        onChange={(e) => setRow(i, { weightPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                      />
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button type="button" className={`${styles.actionBtn} ${styles.actionDanger}`} onClick={() => removeRow(i)}>
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && <p className={styles.empty}>No offers yet — add one to route traffic to a website.</p>}

          <div className={styles.adsBody} style={{ marginTop: '0.8rem' }}>
            <div className={styles.adsActions}>
              <Button variant="ghost" onClick={addRow} disabled={domains.length === 0}>
                Add offer
              </Button>
              <Button onClick={() => void save()} loading={busy}>
                {liveEditable ? 'Save — no ad republish' : 'Save offers'}
              </Button>
            </div>
            <span className={styles.subtle}>Paid weights total {paidWeight}% (split is proportional — need not equal 100).</span>
          </div>
          {domains.length === 0 && <p className={styles.fieldHint}>No LIVE websites yet — a super-admin adds &amp; verifies domains first.</p>}
        </>
      )}
    </Card>
  );
}
