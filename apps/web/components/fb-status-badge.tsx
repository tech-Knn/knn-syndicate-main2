import { Badge } from './ui';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

/** Facebook `effective_status` → Badge tone. The worker reconcile job mirrors each ad set's /
 *  ad's live FB status onto the row; this colours it in the Analytics structure view. */
const TONE: Record<string, Tone> = {
  ACTIVE: 'success',
  PAUSED: 'neutral',
  CAMPAIGN_PAUSED: 'neutral',
  ADSET_PAUSED: 'neutral',
  IN_PROCESS: 'neutral',
  ARCHIVED: 'neutral',
  PREAPPROVED: 'warning',
  PENDING_REVIEW: 'warning',
  PENDING_BILLING_INFO: 'warning',
  WITH_ISSUES: 'warning',
  DISAPPROVED: 'danger',
  DELETED: 'danger',
};

/** Friendlier labels for the statuses whose raw enum reads poorly. */
const LABEL: Record<string, string> = {
  CAMPAIGN_PAUSED: 'Paused (campaign)',
  ADSET_PAUSED: 'Paused (ad set)',
  IN_PROCESS: 'Processing',
  PENDING_REVIEW: 'In review',
  PENDING_BILLING_INFO: 'Billing needed',
  WITH_ISSUES: 'With issues',
};

const humanize = (s: string): string =>
  s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Small inline badge for a Facebook effective_status mirrored onto an ad set / ad. Renders
 * nothing when there's no live status yet (pre-launch, or not synced by the reconcile job).
 */
export function FbStatusBadge({ status }: { status: string | null | undefined }): React.ReactNode {
  if (!status) return null;
  return <Badge tone={TONE[status] ?? 'neutral'}>{LABEL[status] ?? humanize(status)}</Badge>;
}
