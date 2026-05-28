'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { campaigns } from '@/lib/api';
import { type CampaignStatus, type OfferDomainOption, type OfferRow } from '@/lib/types';
import styles from '../../admin.module.css';

/** Campaign states where offers can still be edited (before channels are assigned). */
const EDITABLE: CampaignStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'QUEUED_NO_CHANNEL'];

interface Draft {
  domainId: string;
  weightPct: number;
  kind: 'PAID' | 'ORGANIC';
}

/**
 * Phase E — the websites a campaign's traffic routes across. Each PAID offer gets the
 * weighted ad-traffic split (and its own AFS channel, assigned at approval); the optional
 * ORGANIC offer is where non-ad traffic goes. Editable only before approval.
 */
export function OffersEditor({ campaignId, status }: { campaignId: string; status: CampaignStatus }) {
  const editable = EDITABLE.includes(status);
  const [domains, setDomains] = useState<OfferDomainOption[]>([]);
  const [rows, setRows] = useState<Draft[]>([]);
  const [saved, setSaved] = useState<OfferRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void campaigns.offers(campaignId).then((offers) => {
      setSaved(offers);
      setRows(offers.map((o) => ({ domainId: o.domainId, weightPct: o.weightPct, kind: o.kind })));
    });
    void campaigns.offerDomains().then(setDomains).catch(() => setDomains([]));
  }, [campaignId]);
  useEffect(() => load(), [load]);

  const setRow = (i: number, patch: Partial<Draft>): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = (): void => setRows((rs) => [...rs, { domainId: '', weightPct: 0, kind: 'PAID' }]);
  const removeRow = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i));

  const paidWeight = rows.filter((r) => r.kind === 'PAID').reduce((s, r) => s + (r.weightPct || 0), 0);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const offers = await campaigns.setOffers(
        campaignId,
        rows.filter((r) => r.domainId).map((r) => ({ domainId: r.domainId, weightPct: r.weightPct, kind: r.kind })),
      );
      setSaved(offers);
      setNote('Saved.');
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
          its own AFS channel.
        </span>
      </div>

      {note && <p className={note === 'Saved.' ? styles.savedNote : styles.fieldHint}>{note}</p>}

      {!editable ? (
        // Read-only once approved/launched — show the assigned channels.
        saved && saved.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Website</th>
                  <th className={styles.thLeft}>Kind</th>
                  <th>Weight</th>
                  <th className={styles.thLeft}>Channel</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <div className={styles.name}>{o.host}</div>
                      {o.afsLabel && <div className={styles.subtle}>{o.afsLabel}</div>}
                    </td>
                    <td>
                      <Badge tone={o.kind === 'PAID' ? 'brand' : 'neutral'}>{o.kind.toLowerCase()}</Badge>
                    </td>
                    <td className={styles.num}>{o.weightPct}%</td>
                    <td className="mono">{o.channelId ?? '—'}</td>
                  </tr>
                ))}
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
                Save offers
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
