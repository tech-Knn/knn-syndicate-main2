import { type FbAppKind } from './app-creds.js';
import { type GraphRequest, graphRequest } from './graph.js';

export interface AdAccountDTO {
  fbAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
  /** The owning Business Manager id (for BM-level pixel lookup), if any. */
  businessId: string | null;
}
export interface PageDTO {
  fbPageId: string;
  name: string;
  instagramId: string | null;
}
export interface PixelDTO {
  fbPixelId: string;
  name: string;
}

interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Fetch every page of a Graph edge by following cursor pagination
 * (`paging.next` present → keep going, advancing the `after` cursor). Without
 * this, a buyer with more accounts/pages/pixels than the page `limit` would be
 * silently truncated. Account-scoped calls pass `accountId` so *each* page is
 * still gated by that account's rate limiter (D12). Hard-capped to avoid a
 * runaway loop on a misbehaving cursor.
 */
async function fetchAllPages<T>(req: GraphRequest): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const params = { ...(req.params ?? {}), ...(after ? { after } : {}) };
    const r = await graphRequest<Paged<T>>({ ...req, params });
    out.push(...r.data);
    const next = r.paging?.next;
    after = r.paging?.cursors?.after;
    if (!next || !after) break;
  }
  return out;
}

export async function fetchAdAccounts(accessToken: string): Promise<AdAccountDTO[]> {
  const data = await fetchAllPages<{
    account_id: string;
    name?: string;
    currency?: string;
    timezone_name?: string;
    account_status?: number;
    business?: { id?: string };
  }>({
    path: '/me/adaccounts',
    // `business{id}` lets us resolve each account's BM in this one call (no per-account lookup).
    params: { fields: 'account_id,name,currency,timezone_name,account_status,business{id}', limit: '200' },
    accessToken,
  });
  return data.map((a) => ({
    fbAccountId: a.account_id,
    name: a.name ?? a.account_id,
    currency: a.currency ?? 'USD',
    timezone: a.timezone_name ?? 'UTC',
    status: String(a.account_status ?? ''),
    businessId: a.business?.id ?? null,
  }));
}

export async function fetchPages(accessToken: string): Promise<PageDTO[]> {
  const data = await fetchAllPages<{
    id: string;
    name?: string;
    instagram_business_account?: { id: string };
  }>({
    path: '/me/accounts',
    params: { fields: 'id,name,instagram_business_account', limit: '200' },
    accessToken,
  });
  return data.map((p) => ({
    fbPageId: p.id,
    name: p.name ?? p.id,
    instagramId: p.instagram_business_account?.id ?? null,
  }));
}

export async function fetchPixels(fbAccountId: string, accessToken: string): Promise<PixelDTO[]> {
  const data = await fetchAllPages<{ id: string; name?: string }>({
    path: `/act_${fbAccountId}/adspixels`,
    params: { fields: 'id,name', limit: '100' },
    accessToken,
    accountId: fbAccountId,
  });
  return data.map((p) => ({ fbPixelId: p.id, name: p.name ?? p.id }));
}

/**
 * Pixels owned by a Business Manager (not just those already on an ad account). A
 * fresh ad account has no `adspixels` of its own, but the BM usually owns pixels that
 * can be assigned to it — surfacing them lets the buyer pick one. Best-effort:
 * returns [] if the BM read isn't permitted, so callers can merge it safely. Pass the
 * business id (resolved cheaply from `fetchAdAccounts`) so this is ONE call per BM.
 */
export async function fetchBusinessPixels(businessId: string, accessToken: string): Promise<PixelDTO[]> {
  if (!businessId) return [];
  try {
    const data = await fetchAllPages<{ id: string; name?: string }>({
      path: `/${businessId}/adspixels`,
      params: { fields: 'id,name', limit: '100' },
      accessToken,
    });
    return data.map((p) => ({ fbPixelId: p.id, name: p.name ?? p.id }));
  } catch {
    return [];
  }
}

export interface AdStatusDTO {
  fbAdId: string;
  /** FB effective_status: ACTIVE | PAUSED | DISAPPROVED | WITH_ISSUES | PENDING_REVIEW | … */
  effectiveStatus: string;
}
export interface AdSetStatusDTO {
  fbAdSetId: string;
  /** FB effective_status: ACTIVE | PAUSED | CAMPAIGN_PAUSED | WITH_ISSUES | … */
  effectiveStatus: string;
}

/** A campaign's live delivery state from Facebook: its own `effective_status` plus the
 *  effective_status of every ad set AND ad under it. Drives campaign-status reconciliation
 *  (a pause/resume done directly in Ads Manager is mirrored into our DB), the per-ad-set /
 *  per-ad status mirror, AND meta-rejection (a DISAPPROVED ad). One Graph node read with two
 *  nested edges (`adsets`, `ads`) = a single call. */
export interface CampaignDeliveryDTO {
  /** Campaign FB effective_status: ACTIVE | PAUSED | CAMPAIGN_PAUSED | ARCHIVED | DELETED | … */
  effectiveStatus: string;
  /** effective_status of every ad set under the campaign. */
  adSets: AdSetStatusDTO[];
  /** effective_status of every ad under the campaign (across all its ad sets). */
  ads: AdStatusDTO[];
}
export async function fetchCampaignDelivery(
  fbAccountId: string,
  accessToken: string,
  fbCampaignId: string,
  appKind?: FbAppKind,
): Promise<CampaignDeliveryDTO> {
  const node = await graphRequest<{
    effective_status?: string;
    adsets?: { data?: { id: string; effective_status?: string }[] };
    ads?: { data?: { id: string; effective_status?: string }[] };
  }>({
    path: `/${fbCampaignId}`,
    params: {
      fields: 'effective_status,adsets.limit(200){id,effective_status},ads.limit(200){id,effective_status}',
    },
    accessToken,
    accountId: fbAccountId,
    appKind,
  });
  return {
    effectiveStatus: node.effective_status ?? '',
    adSets: (node.adsets?.data ?? []).map((s) => ({
      fbAdSetId: s.id,
      effectiveStatus: s.effective_status ?? '',
    })),
    ads: (node.ads?.data ?? []).map((a) => ({
      fbAdId: a.id,
      effectiveStatus: a.effective_status ?? '',
    })),
  };
}

/** Pages that a specific ad account can promote (owned + client pages). Scopes the
 *  page picker to the chosen ad account rather than the whole connection. */
export async function fetchPromotePages(
  fbAccountId: string,
  accessToken: string,
): Promise<PageDTO[]> {
  const data = await fetchAllPages<{ id: string; name?: string }>({
    path: `/act_${fbAccountId}/promote_pages`,
    params: { fields: 'id,name', limit: '200' },
    accessToken,
    accountId: fbAccountId,
  });
  return data.map((p) => ({ fbPageId: p.id, name: p.name ?? p.id, instagramId: null }));
}
