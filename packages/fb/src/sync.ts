import { graphRequest } from './graph.js';

export interface AdAccountDTO {
  fbAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
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
}

export async function fetchAdAccounts(accessToken: string): Promise<AdAccountDTO[]> {
  const r = await graphRequest<
    Paged<{
      account_id: string;
      name?: string;
      currency?: string;
      timezone_name?: string;
      account_status?: number;
    }>
  >({
    path: '/me/adaccounts',
    params: { fields: 'account_id,name,currency,timezone_name,account_status', limit: '200' },
    accessToken,
  });
  return r.data.map((a) => ({
    fbAccountId: a.account_id,
    name: a.name ?? a.account_id,
    currency: a.currency ?? 'USD',
    timezone: a.timezone_name ?? 'UTC',
    status: String(a.account_status ?? ''),
  }));
}

export async function fetchPages(accessToken: string): Promise<PageDTO[]> {
  const r = await graphRequest<
    Paged<{ id: string; name?: string; instagram_business_account?: { id: string } }>
  >({
    path: '/me/accounts',
    params: { fields: 'id,name,instagram_business_account', limit: '200' },
    accessToken,
  });
  return r.data.map((p) => ({
    fbPageId: p.id,
    name: p.name ?? p.id,
    instagramId: p.instagram_business_account?.id ?? null,
  }));
}

export async function fetchPixels(fbAccountId: string, accessToken: string): Promise<PixelDTO[]> {
  const r = await graphRequest<Paged<{ id: string; name?: string }>>({
    path: `/act_${fbAccountId}/adspixels`,
    params: { fields: 'id,name', limit: '100' },
    accessToken,
    accountId: fbAccountId,
  });
  return r.data.map((p) => ({ fbPixelId: p.id, name: p.name ?? p.id }));
}

/** Pages that a specific ad account can promote (owned + client pages). Scopes the
 *  page picker to the chosen ad account rather than the whole connection. */
export async function fetchPromotePages(
  fbAccountId: string,
  accessToken: string,
): Promise<PageDTO[]> {
  const r = await graphRequest<Paged<{ id: string; name?: string }>>({
    path: `/act_${fbAccountId}/promote_pages`,
    params: { fields: 'id,name', limit: '200' },
    accessToken,
    accountId: fbAccountId,
  });
  return r.data.map((p) => ({ fbPageId: p.id, name: p.name ?? p.id, instagramId: null }));
}
