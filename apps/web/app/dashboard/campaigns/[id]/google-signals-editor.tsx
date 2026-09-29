'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GOOGLE_SIGNAL_LIMITS,
  type GoogleSignalsUpdate,
  type GoogleSignalsView,
  type TermsSource,
  findBlockedRcTerms,
  normalizeCustomTerms,
  rcBlockedMessage,
} from '@knn/shared';
import { Badge, Button, Card, Spinner, useToast } from '@/components/ui';
import { ApiError, campaigns } from '@/lib/api';
import adminStyles from '../../admin.module.css';
import styles from './google-signals.module.css';

const SOURCE_LABEL: Record<TermsSource, string> = {
  custom: 'Your keywords',
  article: 'AI keywords (article)',
  keywords: 'Campaign keywords',
  none: 'None — Google picks from the page',
};

function toText(terms: readonly string[]): string {
  return terms.join('\n');
}

/** Buyer-typed text → the exact value saved (and sent): trimmed; blank → null (use the default). */
function clean(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

/**
 * D28 inline check for one rc box. A CHANGED value with a blocked word is an error (Save is off, the
 * API rejects it too); an unchanged saved value with one is a warning — it predates the list.
 */
function RcWordCheck({ hits, changed }: { hits: readonly string[]; changed: boolean }) {
  if (hits.length === 0) return null;
  return changed ? (
    <p className={`${adminStyles.fieldHint} ${styles.over}`}>{rcBlockedMessage(hits)}</p>
  ) : (
    <p className={`${adminStyles.fieldHint} ${styles.warn}`}>
      This saved text contains {hits.map((h) => `“${h}”`).join(', ')}, which makes Google hide the keyword block. Change the
      ad&apos;s wording and update it here.
    </p>
  );
}

function CharCount({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return (
    <span className={`${styles.count} ${n > max ? styles.over : ''}`}>
      {n}/{max}
    </span>
  );
}

/**
 * "Sent to Google" (D27): exactly what every paid click on this campaign sends Google AFS — the
 * Referrer Ad Creative per ad and the related-search keywords per landing article — editable on the
 * spot. No approval, no ad republish: a launched campaign's redirect re-syncs on save, so the NEXT
 * click carries the new values. Text is sent as typed; the only limits are the technical caps.
 */
export function GoogleSignalsEditor({
  campaignId,
  onCampaignRacChange,
}: {
  campaignId: string;
  /** Lets the page keep its copy of the campaign in step after a save. */
  onCampaignRacChange?: (racValue: string | null) => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<GoogleSignalsView | null | 'error'>(null);
  const [campaignRac, setCampaignRac] = useState('');
  const [adRac, setAdRac] = useState<Record<string, string>>({});
  const [termsText, setTermsText] = useState('');
  const [busy, setBusy] = useState(false);
  // D28: rc words that make Google hide the keyword block (flag inline; the API enforces the same list).
  const [blockedTerms, setBlockedTerms] = useState<string[]>([]);

  const hydrate = useCallback((v: GoogleSignalsView) => {
    setView(v);
    setCampaignRac(v.racValue ?? '');
    setAdRac(Object.fromEntries(v.ads.map((a) => [a.id, a.racValue ?? ''])));
    setTermsText(toText(v.customTerms));
  }, []);

  useEffect(() => {
    void campaigns
      .googleSignals(campaignId)
      .then(hydrate)
      .catch(() => setView('error'));
    void campaigns
      .rcBlockedTerms()
      .then(setBlockedTerms)
      .catch(() => setBlockedTerms([]));
  }, [campaignId, hydrate]);

  const customTerms = useMemo(() => normalizeCustomTerms(termsText), [termsText]);
  // All the AI keywords across the landing articles (deduped, in order) — the "start from" seed.
  const aiTerms = useMemo(
    () => (view && view !== 'error' ? normalizeCustomTerms(view.articles.flatMap((a) => a.aiTerms)) : []),
    [view],
  );

  if (view === 'error') {
    return (
      <Card className={adminStyles.section}>
        <span className={adminStyles.sectionTitle}>Sent to Google</span>
        <p className={adminStyles.fieldHint}>Couldn&apos;t load what this campaign sends Google. Refresh to retry.</p>
      </Card>
    );
  }
  if (view === null) {
    return (
      <Card className={adminStyles.section} style={{ display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </Card>
    );
  }

  const perAdEditable = view.status !== 'DRAFT';
  const campaignRacChanged = clean(campaignRac) !== (view.racValue ?? null);
  const termsChanged = customTerms.join('\n') !== view.customTerms.join('\n');
  const changedAds = view.ads.filter((a) => clean(adRac[a.id] ?? '') !== (a.racValue ?? null));
  const dirty = campaignRacChanged || termsChanged || changedAds.length > 0;

  const tooManyTerms = customTerms.length > GOOGLE_SIGNAL_LIMITS.termsMaxCount;
  const longTerm = customTerms.find((t) => t.length > GOOGLE_SIGNAL_LIMITS.termMaxChars);
  const racTooLong =
    campaignRac.trim().length > GOOGLE_SIGNAL_LIMITS.racMaxChars ||
    view.ads.some((a) => (adRac[a.id] ?? '').trim().length > GOOGLE_SIGNAL_LIMITS.racMaxChars);
  const rcHits = (text: string): string[] => findBlockedRcTerms(text, blockedTerms);
  const defaultHits = rcHits(campaignRac);
  const rcWordBlocked = (campaignRacChanged && defaultHits.length > 0) || changedAds.some((a) => rcHits(adRac[a.id] ?? '').length > 0);
  const blocked = tooManyTerms || Boolean(longTerm) || racTooLong || rcWordBlocked;

  const reset = (): void => hydrate(view);

  const save = async (): Promise<void> => {
    const body: GoogleSignalsUpdate = {};
    if (campaignRacChanged) body.racValue = clean(campaignRac);
    if (termsChanged) body.terms = customTerms;
    if (changedAds.length) body.ads = changedAds.map((a) => ({ adId: a.id, racValue: clean(adRac[a.id] ?? '') }));
    setBusy(true);
    try {
      const next = await campaigns.updateGoogleSignals(campaignId, body);
      hydrate(next);
      if (campaignRacChanged) onCampaignRacChange?.(next.racValue);
      toast.success(
        next.synced
          ? 'Saved — new clicks pick it up within about a minute. No ad republish, no review.'
          : 'Saved — goes out with this campaign when it launches.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const defaultRac = clean(campaignRac);
  // Google only uses publisher `terms` when a Referrer Ad Creative is sent with them. Informational
  // only (never blocks): name the ads that, as currently typed, would send keywords with no rc.
  const keywordsSent = customTerms.length > 0 || view.articles.some((a) => a.aiTerms.length > 0);
  const adsWithoutRac = keywordsSent
    ? view.ads.map((a, i) => ({ a, label: a.name || `Ad ${i + 1}` })).filter(({ a }) => !(clean(adRac[a.id] ?? '') ?? defaultRac))
    : [];
  const noRacNote =
    adsWithoutRac.length === 0
      ? null
      : adsWithoutRac.length === view.ads.length
        ? 'Google only uses these keywords when a Referrer Ad Creative is sent — no ad has one right now.'
        : `Google only uses these keywords when a Referrer Ad Creative is sent — ${
            adsWithoutRac.length <= 3
              ? adsWithoutRac.map((x) => x.label).join(', ')
              : `${adsWithoutRac.slice(0, 3).map((x) => x.label).join(', ')} and ${adsWithoutRac.length - 3} more`
          } ${adsWithoutRac.length === 1 ? 'has' : 'have'} none.`;

  return (
    <Card className={adminStyles.section}>
      <div className={adminStyles.sectionHead}>
        <span className={adminStyles.sectionTitle}>Sent to Google</span>
        <span className={adminStyles.subtle}>
          {view.live
            ? 'Exactly what each paid click sends Google. Edit and save — new clicks use it within about a minute, no approval, no ad republish.'
            : 'Exactly what each paid click will send Google once this campaign is live. Edit any time — no approval.'}
        </span>
      </div>

      {/* ── Referrer Ad Creative ─────────────────────────────────────────────── */}
      <div className={styles.block}>
        <div className={styles.blockHead}>
          <span className={styles.blockTitle}>Referrer Ad Creative</span>
          <span className={adminStyles.subtle}>Sent as-is. An ad with its own text uses it; the rest use the campaign default.</span>
        </div>

        <label className={adminStyles.fieldLabel} htmlFor="gs-campaign-rac">
          Campaign default
        </label>
        <textarea
          id="gs-campaign-rac"
          className={styles.input}
          rows={2}
          value={campaignRac}
          disabled={busy}
          onChange={(e) => setCampaignRac(e.target.value)}
          placeholder="The ad creative text Google receives for ads without their own"
        />
        <div className={styles.meta}>
          <span>Used by every ad below that has no text of its own.</span>
          <CharCount value={campaignRac} max={GOOGLE_SIGNAL_LIMITS.racMaxChars} />
        </div>
        <RcWordCheck hits={defaultHits} changed={campaignRacChanged} />

        {view.ads.length > 0 && (
          <div>
            {view.ads.map((a, i) => {
              const own = adRac[a.id] ?? '';
              const willSend = clean(own) ?? defaultRac;
              const inputId = `gs-ad-rac-${a.id}`;
              return (
                <div key={a.id} className={styles.adRow}>
                  <div className={styles.adMeta}>
                    <label className={styles.adName} htmlFor={inputId}>
                      {a.name || `Ad ${i + 1}`}
                    </label>
                    <span className={styles.adSub}>{a.adSetName}</span>
                    <span className={styles.adSub}>
                      <Badge tone="neutral">{a.creativeType.toLowerCase()}</Badge>
                      {a.fileName ? ` ${a.fileName}` : ''}
                    </span>
                  </div>
                  <div className={styles.adEdit}>
                    <textarea
                      id={inputId}
                      className={styles.input}
                      rows={2}
                      value={own}
                      disabled={busy || !perAdEditable}
                      onChange={(e) => setAdRac((m) => ({ ...m, [a.id]: e.target.value }))}
                      placeholder={defaultRac ? `Uses campaign default: ${defaultRac}` : 'Uses the campaign default (empty)'}
                    />
                    <div className={styles.meta}>
                      <span className={styles.sent} style={{ whiteSpace: 'pre-wrap' }}>
                        {willSend ? (
                          <>
                            Google gets: <b>{willSend}</b>
                          </>
                        ) : (
                          'Google gets: nothing (no text set)'
                        )}
                      </span>
                      <span className={styles.helpers}>
                        {own.trim() && (
                          <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => setAdRac((m) => ({ ...m, [a.id]: '' }))}>
                            Use campaign default
                          </button>
                        )}
                        <CharCount value={own} max={GOOGLE_SIGNAL_LIMITS.racMaxChars} />
                      </span>
                    </div>
                    <RcWordCheck hits={rcHits(own)} changed={clean(own) !== (a.racValue ?? null)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!perAdEditable && (
          <p className={adminStyles.fieldHint}>Per-ad text unlocks once the campaign is submitted (the draft editor recreates ads on save).</p>
        )}
      </div>

      {/* ── Related-search keywords (RSOC `terms`) ───────────────────────────── */}
      <div className={styles.block}>
        <div className={styles.blockHead}>
          <span className={styles.blockTitle}>Related-search keywords</span>
          <span className={adminStyles.subtle}>The keyword suggestions passed to Google&apos;s search box on the landing page.</span>
        </div>

        {view.articles.length === 0 ? (
          <p className={adminStyles.fieldHint}>No landing article yet — it&apos;s generated at launch. Keywords you set here are used from the first click.</p>
        ) : (
          view.articles.map((a) => (
            <div key={a.articleId} className={styles.articleRow}>
              <div className={styles.articleHead}>
                <span className={styles.articleTitle}>{a.title}</span>
                <Badge tone={a.source === 'custom' ? 'brand' : 'neutral'}>Now: {SOURCE_LABEL[a.source]}</Badge>
              </div>
              {a.sent.length > 0 ? (
                <div className={styles.chips}>
                  {a.sent.map((t) => (
                    <span key={t} className={styles.chip}>
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                <span className={adminStyles.subtle}>No keywords sent.</span>
              )}
            </div>
          ))
        )}

        <label className={adminStyles.fieldLabel} htmlFor="gs-terms">
          Your keywords — one per line, sent exactly as typed and in this order
        </label>
        <textarea
          id="gs-terms"
          className={`${styles.input} ${styles.termsInput}`}
          value={termsText}
          disabled={busy}
          onChange={(e) => setTermsText(e.target.value)}
          placeholder={'Leave empty to send the AI keywords above.\nOr type your own, one per line.'}
        />
        <div className={styles.meta}>
          <span className={styles.helpers}>
            <button
              type="button"
              className={styles.linkBtn}
              disabled={busy || aiTerms.length === 0}
              onClick={() => setTermsText(toText(aiTerms))}
              title="Fill the box with the AI keywords, then edit them"
            >
              Start from AI keywords
            </button>
            <button type="button" className={styles.linkBtn} disabled={busy || !termsText.trim()} onClick={() => setTermsText('')}>
              Clear — send AI keywords
            </button>
          </span>
          <span className={`${styles.count} ${tooManyTerms ? styles.over : ''}`}>
            {customTerms.length}/{GOOGLE_SIGNAL_LIMITS.termsMaxCount} keywords
          </span>
        </div>
        {noRacNote && <p className={adminStyles.fieldHint}>{noRacNote}</p>}
        {longTerm && (
          <p className={`${adminStyles.fieldHint} ${styles.over}`}>
            A keyword is over {GOOGLE_SIGNAL_LIMITS.termMaxChars} characters: “{longTerm.slice(0, 40)}…”
          </p>
        )}
        {termsChanged && (
          <div className={styles.articleRow}>
            <div className={styles.articleHead}>After save, every article sends:</div>
            {customTerms.length > 0 ? (
              <div className={styles.chips}>
                {customTerms.map((t) => (
                  <span key={t} className={`${styles.chip} ${styles.chipNew}`}>
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <span className={adminStyles.subtle}>Its AI keywords (shown above per article).</span>
            )}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={adminStyles.subtle}>
          {view.live
            ? 'Updates reach every location within about a minute (edge cache). Visitors already on the page keep what they arrived with.'
            : 'Not live yet — saved values go out with the first click.'}
        </span>
        <div className={styles.footerActions}>
          <Button variant="ghost" onClick={reset} disabled={!dirty || busy}>
            Discard
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty || blocked}>
            {view.live ? 'Save — live now' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
