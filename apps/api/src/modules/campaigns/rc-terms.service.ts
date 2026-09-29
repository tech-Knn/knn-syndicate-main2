import { type RcBlockedTerm, RcTermSource, RcTermStatus, withSystem } from '@knn/db';
import {
  RC_LEARNING,
  type RcLearningCampaign,
  ROLES,
  addBusinessDays,
  currentBusinessDay,
  effectiveRac,
  findBlockedRcTerms,
  learnRcBlockedTerms,
  measureRcTerms,
  normalizeRcTerm,
  rcBlockedMessage,
} from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/**
 * Referrer Ad Creative words that make Google hide the keyword block (D28). The list is global
 * (`rc_blocked_terms`, no org scope): seeded with the words verified on live pages, grown daily
 * by `learnRcTerms` from real traffic, and overridable by super-admins (ALLOWED = never blocked,
 * never re-learned). Buyers can't SAVE a new rc containing a BLOCKED term; existing values are left
 * alone until they're edited.
 */

/** The BLOCKED terms, as stored (normalized). Small table — read fresh on every check. */
export async function listBlockedRcTerms(): Promise<string[]> {
  const rows = await withSystem((tx) =>
    tx.rcBlockedTerm.findMany({ where: { status: RcTermStatus.BLOCKED }, select: { term: true }, orderBy: { term: 'asc' } }),
  );
  return rows.map((r) => r.term);
}

/** Blocked terms found across `texts` (deduplicated). */
export async function blockedRcHits(texts: readonly (string | null | undefined)[]): Promise<string[]> {
  const present = texts.filter((t): t is string => Boolean(t && t.trim()));
  if (present.length === 0) return [];
  const blocked = await listBlockedRcTerms();
  return [...new Set(present.flatMap((t) => findBlockedRcTerms(t, blocked)))];
}

/** 400 with the buyer-facing explanation when any text uses a blocked term. */
export async function assertRcTextsAllowed(texts: readonly (string | null | undefined)[]): Promise<void> {
  const hits = await blockedRcHits(texts);
  if (hits.length > 0) throw new AppError(400, rcBlockedMessage(hits), { blockedWords: hits });
}

export type RcTermRow = Pick<
  RcBlockedTerm,
  'id' | 'term' | 'source' | 'status' | 'note' | 'suppressedCampaigns' | 'campaignsUsing' | 'keywordClicksPer100' | 'baselinePer100' | 'learnedAt' | 'createdAt' | 'updatedAt'
>;

const rowSelect = {
  id: true,
  term: true,
  source: true,
  status: true,
  note: true,
  suppressedCampaigns: true,
  campaignsUsing: true,
  keywordClicksPer100: true,
  baselinePer100: true,
  learnedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Super-admin view: every term with its evidence (BLOCKED first). */
export async function listRcTermsAdmin(): Promise<RcTermRow[]> {
  return withSystem((tx) => tx.rcBlockedTerm.findMany({ select: rowSelect, orderBy: [{ status: 'asc' }, { term: 'asc' }] }));
}

/** Super-admin adds a word/phrase to block. An existing ALLOWED term is switched back to BLOCKED. */
export async function addRcTerm(auth: AuthContext, input: { term: unknown; note?: unknown }): Promise<RcTermRow> {
  const term = normalizeRcTerm(typeof input.term === 'string' ? input.term : '');
  if (!term) throw new AppError(400, 'Enter a word or phrase');
  if (term.length > 60) throw new AppError(400, 'Keep it to a word or short phrase (60 characters max)');
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  return withSystem(async (tx) => {
    const existing = await tx.rcBlockedTerm.findUnique({ where: { term } });
    if (existing?.status === RcTermStatus.BLOCKED) throw new AppError(409, `“${term}” is already blocked`);
    const row = existing
      ? await tx.rcBlockedTerm.update({
          where: { id: existing.id },
          data: { status: RcTermStatus.BLOCKED, note: note ?? existing.note, updatedById: auth.userId },
          select: rowSelect,
        })
      : await tx.rcBlockedTerm.create({
          data: { term, source: RcTermSource.MANUAL, status: RcTermStatus.BLOCKED, note, updatedById: auth.userId },
          select: rowSelect,
        });
    await writeAudit(tx, { orgId: auth.orgId, actorId: auth.userId, action: 'rc_term.blocked', entityType: 'rc_blocked_term', entityId: row.id, details: { term, note } });
    return row;
  });
}

/** Super-admin flips a term: ALLOWED (never blocked, never re-learned) ⇄ BLOCKED. */
export async function setRcTermStatus(auth: AuthContext, id: string, status: unknown): Promise<RcTermRow> {
  if (status !== RcTermStatus.BLOCKED && status !== RcTermStatus.ALLOWED) throw new AppError(400, 'status must be BLOCKED or ALLOWED');
  return withSystem(async (tx) => {
    const existing = await tx.rcBlockedTerm.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Term not found');
    const row = await tx.rcBlockedTerm.update({ where: { id }, data: { status, updatedById: auth.userId }, select: rowSelect });
    await writeAudit(tx, {
      orgId: auth.orgId,
      actorId: auth.userId,
      action: status === RcTermStatus.ALLOWED ? 'rc_term.allowed' : 'rc_term.blocked',
      entityType: 'rc_blocked_term',
      entityId: id,
      details: { term: existing.term, from: existing.status, to: status },
    });
    return row;
  });
}

/**
 * Per-campaign traffic for the learner over the last `RC_LEARNING.windowDays` IST days: paid visits
 * (FB link clicks), keyword-block clicks (AFS ad requests — /search is only reached from a chip), and
 * every effective rc the campaign sent (campaign default + per-ad overrides).
 */
async function loadLearningCampaigns(opts: { campaignIds?: readonly string[] }): Promise<RcLearningCampaign[]> {
  const from = addBusinessDays(currentBusinessDay(), -RC_LEARNING.windowDays);
  const scope = opts.campaignIds ? { campaignId: { in: [...opts.campaignIds] } } : {};
  return withSystem(async (tx) => {
    const visits = await tx.adStatsDaily.groupBy({ by: ['campaignId'], where: { day: { gte: from }, ...scope }, _sum: { clicks: true } });
    const ids = visits.map((v) => v.campaignId);
    if (ids.length === 0) return [];
    const kw = await tx.campaignRevenueDaily.groupBy({ by: ['campaignId'], where: { day: { gte: from }, campaignId: { in: ids } }, _sum: { afsRequests: true } });
    const kwBy = new Map(kw.map((k) => [k.campaignId, k._sum.afsRequests ?? 0]));
    const campaigns = await tx.campaign.findMany({
      where: { id: { in: ids } },
      select: { id: true, racValue: true, adSets: { select: { ads: { select: { racValue: true } } } } },
    });
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    return visits.flatMap((v) => {
      const c = byId.get(v.campaignId);
      if (!c) return [];
      const ads = c.adSets.flatMap((s) => s.ads);
      const rcTexts = [...new Set([c.racValue, ...ads.map((a) => effectiveRac(a.racValue, c.racValue))].filter((x): x is string => Boolean(x)))];
      return [{ rcTexts, visits: v._sum.clicks ?? 0, keywordClicks: kwBy.get(v.campaignId) ?? 0 }];
    });
  });
}

export interface RcLearningRun {
  baselinePer100: number | null;
  eligibleCampaigns: number;
  suppressedCampaigns: number;
  /** Terms added to the block list by this run. */
  added: { term: string; suppressedCampaigns: number; campaignsUsing: number; keywordClicksPer100: number }[];
}

/**
 * The daily learning run (worker cron → internal API; super-admins can also trigger it). Adds newly
 * learned terms as LEARNED + BLOCKED, refreshes every known term's evidence, and pings the alert
 * channel when something new is blocked. `campaignIds` scopes the data (tests only).
 */
export async function learnRcTerms(opts: { campaignIds?: readonly string[] } = {}): Promise<RcLearningRun> {
  const campaigns = await loadLearningCampaigns(opts);
  const known = await withSystem((tx) => tx.rcBlockedTerm.findMany({ select: { id: true, term: true, status: true } }));
  const result = learnRcBlockedTerms({ campaigns, known });
  const now = new Date();

  const added: RcLearningRun['added'] = [];
  await withSystem(async (tx) => {
    for (const l of result.learned) {
      const note =
        `Learned ${now.toISOString().slice(0, 10)}: ${l.suppressedCampaigns} of ${l.campaignsUsing} campaigns using it were suppressed ` +
        `(${l.keywordClicksPer100} keyword clicks per 100 visits vs a ${result.baselinePer100} median).`;
      const created = await tx.rcBlockedTerm.createMany({
        data: [{
          term: l.term,
          source: RcTermSource.LEARNED,
          status: RcTermStatus.BLOCKED,
          note,
          suppressedCampaigns: l.suppressedCampaigns,
          campaignsUsing: l.campaignsUsing,
          keywordClicksPer100: l.keywordClicksPer100,
          baselinePer100: result.baselinePer100,
          learnedAt: now,
        }],
        skipDuplicates: true,
      });
      if (created.count > 0) added.push(l);
    }
    // Fresh evidence for every previously known term (the admin page shows it next to each word).
    const measured = measureRcTerms({ campaigns, terms: known.map((k) => k.term) });
    for (const k of known) {
      const s = measured.stats[k.term];
      if (!s) continue;
      await tx.rcBlockedTerm.update({
        where: { id: k.id },
        data: {
          campaignsUsing: s.campaignsUsing,
          suppressedCampaigns: s.suppressedCampaigns,
          keywordClicksPer100: s.keywordClicksPer100,
          baselinePer100: measured.baselinePer100,
        },
      });
    }
  });

  if (added.length > 0) {
    const sa = await withSystem((tx) => tx.user.findFirst({ where: { role: ROLES.SUPER_ADMIN }, select: { id: true, orgId: true } }));
    if (sa) {
      await notify({
        orgId: sa.orgId,
        userId: sa.id,
        type: 'rc_term_learned',
        title: `New rc word${added.length > 1 ? 's' : ''} blocked: ${added.map((a) => a.term).join(', ')}`,
        body: added
          .map((a) => `“${a.term}”: ${a.suppressedCampaigns}/${a.campaignsUsing} campaigns suppressed, ${a.keywordClicksPer100} keyword clicks per 100 visits (median ${result.baselinePer100}).`)
          .join('\n') + '\nReview in Platform → RC words (Allow to undo).',
      });
    }
  }

  return {
    baselinePer100: result.baselinePer100,
    eligibleCampaigns: result.eligibleCampaigns,
    suppressedCampaigns: result.suppressedCampaigns,
    added,
  };
}
