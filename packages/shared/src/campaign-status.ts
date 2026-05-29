/**
 * Campaign lifecycle state machine (single source of truth for legal transitions).
 *
 * The DB enum `CampaignStatus` (Prisma) holds the same values; this module is the
 * pure, dependency-free graph that the API (approval) and worker (channel/launch/
 * rejection pipelines) both validate against, so no phase can move a campaign
 * through an illegal transition. Keep the values in lockstep with the Prisma enum.
 */

export const CAMPAIGN_STATUS = {
  /** Being built by the buyer; the only editable/deletable state. */
  DRAFT: 'DRAFT',
  /** Submitted by the buyer; awaiting admin review. */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** Admin (or auto-approve) cleared it; the launch pipeline will pick it up. */
  APPROVED: 'APPROVED',
  /** Pipeline working it (channel assignment + article generation). */
  PROCESSING: 'PROCESSING',
  /** Creating the Campaign→AdSet→Ad on Facebook. */
  LAUNCHING: 'LAUNCHING',
  /** Live on Facebook. */
  ACTIVE: 'ACTIVE',
  /** Paused on Facebook (by buyer/admin); resumable. */
  PAUSED: 'PAUSED',
  /** Admin rejected it during review; revisable back to DRAFT or archivable. */
  REJECTED: 'REJECTED',
  /** Held behind the per-ad-account FB rate limiter (D12). */
  BATCHED: 'BATCHED',
  /** Approved but no AdSense channel free; waiting in the FIFO queue (D11). */
  QUEUED_NO_CHANNEL: 'QUEUED_NO_CHANNEL',
  /** Facebook disapproved the ads after launch (D14). */
  META_REJECTED: 'META_REJECTED',
  /** Terminal; hidden from active views. */
  ARCHIVED: 'ARCHIVED',
} as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

/**
 * Legal forward transitions per state. The graph is intentionally complete (it
 * covers states wired in later phases) so it can be the canonical validator from
 * day one; phases attach routes/jobs to individual edges as they're built.
 *
 * Edges by phase:
 *  - Phase 3 (launcher):  DRAFT → PENDING_APPROVAL (submit).
 *  - Phase 4 (approval):  PENDING_APPROVAL → APPROVED | REJECTED (+ auto-approve);
 *                         PENDING_APPROVAL → DRAFT (withdraw); REJECTED → DRAFT (revise).
 *  - Phase 6 (channels):  APPROVED/PROCESSING ↔ QUEUED_NO_CHANNEL; queue → PROCESSING.
 *  - Phase 8 (launch):    APPROVED/PROCESSING → BATCHED/LAUNCHING → ACTIVE; → META_REJECTED.
 *  - Ops:                 ACTIVE ↔ PAUSED; (most states) → ARCHIVED (terminal).
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: [CAMPAIGN_STATUS.PENDING_APPROVAL, CAMPAIGN_STATUS.ARCHIVED],
  PENDING_APPROVAL: [
    CAMPAIGN_STATUS.APPROVED,
    CAMPAIGN_STATUS.REJECTED,
    CAMPAIGN_STATUS.DRAFT,
  ],
  APPROVED: [
    CAMPAIGN_STATUS.PROCESSING,
    CAMPAIGN_STATUS.QUEUED_NO_CHANNEL,
    CAMPAIGN_STATUS.BATCHED,
    CAMPAIGN_STATUS.LAUNCHING,
    CAMPAIGN_STATUS.ARCHIVED,
  ],
  PROCESSING: [
    CAMPAIGN_STATUS.LAUNCHING,
    CAMPAIGN_STATUS.BATCHED,
    CAMPAIGN_STATUS.QUEUED_NO_CHANNEL,
    CAMPAIGN_STATUS.DRAFT, // reopen to edit (releases the assigned channel) — pre-launch only
    CAMPAIGN_STATUS.ARCHIVED,
  ],
  QUEUED_NO_CHANNEL: [CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.ARCHIVED],
  BATCHED: [CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.LAUNCHING, CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.ARCHIVED],
  LAUNCHING: [
    CAMPAIGN_STATUS.ACTIVE,
    CAMPAIGN_STATUS.BATCHED,
    CAMPAIGN_STATUS.META_REJECTED,
    CAMPAIGN_STATUS.ARCHIVED,
  ],
  ACTIVE: [CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.META_REJECTED, CAMPAIGN_STATUS.ARCHIVED],
  PAUSED: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.META_REJECTED, CAMPAIGN_STATUS.ARCHIVED],
  REJECTED: [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.ARCHIVED],
  META_REJECTED: [CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.ARCHIVED],
  ARCHIVED: [],
};

/** True if `from → to` is a legal campaign transition (self-transitions are illegal). */
export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/** The states reachable from `from` in one legal step. */
export function nextCampaignStates(from: CampaignStatus): readonly CampaignStatus[] {
  return CAMPAIGN_TRANSITIONS[from];
}

/** True if no transition can leave `status` (terminal). */
export function isTerminalCampaignStatus(status: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[status].length === 0;
}
