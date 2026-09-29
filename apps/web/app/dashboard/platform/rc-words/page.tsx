'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { RC_LEARNING } from '@knn/shared';
import { Badge, Button, Card, EmptyState, Skeleton, useToast } from '@/components/ui';
import { ApiError, admin } from '@/lib/api';
import { type RcTermRow } from '@/lib/types';
import styles from '../../admin.module.css';

const SOURCE_LABEL: Record<RcTermRow['source'], string> = {
  SEED: 'Tested',
  LEARNED: 'Learned',
  MANUAL: 'Added',
};

/**
 * RC words (D28) — words in the Referrer Ad Creative that make Google hide the related-search
 * keyword block. Buyers can't save a new rc containing a BLOCKED word. The list starts with the
 * words tested on live pages, grows daily from real traffic, and super-admins can add words or
 * Allow one (an allowed word is never blocked or re-learned). Guarded by platform/layout.tsx.
 */
export default function RcWordsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<RcTermRow[] | null>(null);
  const [term, setTerm] = useState('');
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [learning, setLearning] = useState(false);

  const load = useCallback(() => {
    void admin.rcTerms().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(() => load(), [load]);

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!term.trim()) return;
    setAdding(true);
    try {
      const row = await admin.addRcTerm(term, note || undefined);
      toast.success(`“${row.term}” is now blocked in new rc text.`);
      setTerm('');
      setNote('');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add the word.');
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (row: RcTermRow): Promise<void> => {
    const next = row.status === 'BLOCKED' ? 'ALLOWED' : 'BLOCKED';
    setBusyId(row.id);
    try {
      await admin.setRcTermStatus(row.id, next);
      toast.success(next === 'ALLOWED' ? `“${row.term}” is allowed again (and won't be re-learned).` : `“${row.term}” is blocked.`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the word.');
    } finally {
      setBusyId(null);
    }
  };

  const learnNow = async (): Promise<void> => {
    setLearning(true);
    try {
      const r = await admin.learnRcTerms();
      toast.success(
        r.added.length
          ? `Learned ${r.added.map((a) => `“${a.term}”`).join(', ')} from ${r.eligibleCampaigns} campaigns.`
          : `Nothing new — checked ${r.eligibleCampaigns} campaigns (median ${r.baselinePer100 ?? '—'} keyword clicks per 100 visits).`,
      );
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Learning run failed.');
    } finally {
      setLearning(false);
    }
  };

  const blockedCount = rows?.filter((r) => r.status === 'BLOCKED').length ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Platform</span>
          <h1 className={`serif ${styles.title}`}>RC words</h1>
          <p className={styles.sub}>
            Words in the Referrer Ad Creative that make Google hide the keyword block. Buyers can&apos;t save a new rc with a
            blocked word.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void learnNow()} loading={learning}>
          Learn now
        </Button>
      </div>

      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Words</span>
          <span className={styles.subtle}>
            {rows ? `${blockedCount} blocked` : ''} · learned daily from the last {RC_LEARNING.windowDays} days of traffic
          </span>
        </div>
        <p className={styles.fieldHint}>
          A word is learned when at least {RC_LEARNING.minSuppressedCampaigns} campaigns using it (in different wordings, each
          with {RC_LEARNING.minVisits}+ visits) get fewer than {Math.round(RC_LEARNING.suppressedBelow * 100)}% of the median
          keyword clicks, and {Math.round(RC_LEARNING.minShare * 100)}%+ of all campaigns using it do. Numbers show the latest
          run. <b>Allow</b> undoes a wrong one for good.
        </p>

        {rows === null ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <EmptyState title="No words yet" description="Tested words ship with the database migration; learned words appear after the daily run." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Word</th>
                  <th className={styles.thLeft}>Status</th>
                  <th className={styles.thLeft}>Source</th>
                  <th>Campaigns hit</th>
                  <th>Keyword clicks / 100 visits</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ minWidth: 260, maxWidth: 440, whiteSpace: 'normal' }}>
                      <div className={styles.name}>{r.term}</div>
                      {r.note && <div className={styles.subtle}>{r.note}</div>}
                    </td>
                    <td>
                      <Badge tone={r.status === 'BLOCKED' ? 'danger' : 'success'}>{r.status === 'BLOCKED' ? 'Blocked' : 'Allowed'}</Badge>
                    </td>
                    <td>
                      <Badge tone={r.source === 'LEARNED' ? 'brand' : 'neutral'}>{SOURCE_LABEL[r.source]}</Badge>
                    </td>
                    <td className={styles.num}>
                      {r.campaignsUsing ? `${r.suppressedCampaigns ?? 0} of ${r.campaignsUsing}` : <span className={styles.subtle}>—</span>}
                    </td>
                    <td className={styles.num}>
                      {r.keywordClicksPer100 === null ? (
                        <span className={styles.subtle}>—</span>
                      ) : (
                        <>
                          {r.keywordClicksPer100}
                          {r.baselinePer100 !== null && <span className={styles.subtle}> vs {r.baselinePer100}</span>}
                        </>
                      )}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${r.status === 'BLOCKED' ? '' : styles.actionDanger}`}
                          disabled={busyId === r.id}
                          onClick={() => void toggle(r)}
                        >
                          {r.status === 'BLOCKED' ? 'Allow' : 'Block'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Block a word</span>
          <span className={styles.subtle}>A word or short phrase — matched as whole words, plurals included.</span>
        </div>
        <form className={styles.domainForm} onSubmit={(e) => void add(e)}>
          <input
            className={styles.rangeInput}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="e.g. guaranteed"
            aria-label="Word or phrase to block"
            maxLength={60}
          />
          <input
            className={styles.rangeInput}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why (optional) — e.g. hid the block on a live test"
            aria-label="Reason"
            maxLength={500}
          />
          <Button type="submit" loading={adding} disabled={!term.trim()}>
            Block
          </Button>
        </form>
      </Card>
    </div>
  );
}
