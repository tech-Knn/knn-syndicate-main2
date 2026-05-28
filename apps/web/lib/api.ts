import {
  type AdminOrg,
  type AdsenseStatus,
  type AfsAccountRow,
  type AuditRow,
  type AfsChannelRow,
  type Campaign,
  type CreateOrgInput,
  type DomainRow,
  type FbAccount,
  type FbPage,
  type FbPixel,
  type FbProfile,
  type FbProfileWithOwner,
  type OfferDomainOption,
  type OfferInput,
  type OfferRow,
  type OrgRow,
  type PublicUser,
  type SessionUser,
  type SyncResult,
  type UploadResult,
  type UserAction,
} from './types';
import {
  type ArticleRow,
  type BuyerRollup,
  type CampaignBreakdown,
  type CampaignDraftInput,
  type CampaignPerf,
  type ChannelRow,
  type ChannelSummary,
  type CompanyRollup,
  type DimStat,
  type OfferStat,
  type PlatformSettings,
  type StatsSummary,
} from '@knn/shared';

type RangeArg = { from?: string; to?: string } | undefined;

function rangeQs(range: RangeArg): string {
  if (!range) return '';
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Empty base = same-origin (staging: Caddy routes /api/* to the API). For local
// dev against the API on :3000, set NEXT_PUBLIC_API_BASE=http://localhost:3000.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

const ACCESS_KEY = 'knn.access';
const REFRESH_KEY = 'knn.refresh';
const USER_KEY = 'knn.user';

export class ApiError extends Error {
  readonly status: number;
  /** Structured payload (e.g. the submit-validation issues list). */
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

function read(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

function persistSession(data: SessionResponse): SessionUser {
  write(ACCESS_KEY, data.accessToken);
  write(REFRESH_KEY, data.refreshToken);
  write(USER_KEY, JSON.stringify(data.user));
  return data.user;
}

export function clearSession(): void {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
  write(USER_KEY, null);
}

export function getAccessToken(): string | null {
  return read(ACCESS_KEY);
}

export function getStoredUser(): SessionUser | null {
  const raw = read(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API_BASE + path, init);
}

function jsonHeaders(init: RequestInit = {}): Headers {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return headers;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: string; details?: unknown };
      if (body.error) message = body.error;
      details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }
  return res.json() as Promise<T>;
}

// Single-flight refresh so concurrent 401s don't stampede the refresh endpoint.
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = read(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await rawFetch('/api/auth/refresh', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearSession();
        return false;
      }
      persistSession((await res.json()) as SessionResponse);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Authenticated fetch with a one-shot refresh-and-retry on 401. */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (): Promise<Response> => {
    const token = getAccessToken();
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return rawFetch(path, { ...init, headers });
  };
  const res = await send();
  if (res.status !== 401) return res;
  const refreshed = await refreshSession();
  return refreshed ? send() : res;
}

export const auth = {
  async login(email: string, password: string): Promise<SessionUser> {
    const res = await rawFetch('/api/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email, password }),
    });
    return persistSession(await parse<SessionResponse>(res));
  },

  async logout(): Promise<void> {
    const refreshToken = read(REFRESH_KEY);
    clearSession();
    if (!refreshToken) return;
    try {
      await rawFetch('/api/auth/logout', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      /* best-effort */
    }
  },

  async me(): Promise<SessionUser> {
    const res = await authedFetch('/api/auth/me');
    const data = await parse<{ user: SessionUser }>(res);
    return data.user;
  },

  /** Public buyer signup → PENDING (a company admin approves). Needs the company slug. */
  async signup(input: { name: string; email: string; password: string; companySlug: string }): Promise<{ status: string }> {
    return parse(await rawFetch('/api/auth/signup', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  },
};

export const facebook = {
  authUrl: async (): Promise<{ url: string }> => parse(await authedFetch('/api/facebook/auth-url')),
  // The actor's own connected profiles.
  profiles: async (): Promise<FbProfile[]> =>
    (await parse<{ profiles: FbProfile[] }>(await authedFetch('/api/facebook/profiles'))).profiles,
  // Every connected profile across the platform (super-admin oversight).
  allProfiles: async (): Promise<FbProfileWithOwner[]> =>
    (await parse<{ profiles: FbProfileWithOwner[] }>(await authedFetch('/api/facebook/profiles/all'))).profiles,
  syncProfile: async (id: string): Promise<SyncResult> =>
    parse(await authedFetch(`/api/facebook/profiles/${id}/sync`, { method: 'POST' })),
  disconnectProfile: async (id: string): Promise<void> =>
    parse(await authedFetch(`/api/facebook/profiles/${id}`, { method: 'DELETE' })),
  profileAccounts: async (id: string): Promise<FbAccount[]> =>
    (await parse<{ accounts: FbAccount[] }>(await authedFetch(`/api/facebook/profiles/${id}/accounts`))).accounts,
  profilePages: async (id: string): Promise<FbPage[]> =>
    (await parse<{ pages: FbPage[] }>(await authedFetch(`/api/facebook/profiles/${id}/pages`))).pages,
  // Aggregated across all the actor's profiles — feeds the campaign launcher.
  accounts: async (): Promise<FbAccount[]> =>
    (await parse<{ accounts: FbAccount[] }>(await authedFetch('/api/facebook/accounts'))).accounts,
  pages: async (): Promise<FbPage[]> =>
    (await parse<{ pages: FbPage[] }>(await authedFetch('/api/facebook/pages'))).pages,
  accountPages: async (accountId: string): Promise<FbPage[]> =>
    (await parse<{ pages: FbPage[] }>(await authedFetch(`/api/facebook/accounts/${accountId}/pages`))).pages,
  pixels: async (accountId: string): Promise<FbPixel[]> =>
    (await parse<{ pixels: FbPixel[] }>(await authedFetch(`/api/facebook/accounts/${accountId}/pixels`))).pixels,
};

export const campaigns = {
  list: async (): Promise<Campaign[]> =>
    (await parse<{ campaigns: Campaign[] }>(await authedFetch('/api/campaigns'))).campaigns,
  get: async (id: string): Promise<Campaign> =>
    (await parse<{ campaign: Campaign }>(await authedFetch(`/api/campaigns/${id}`))).campaign,
  create: async (draft: CampaignDraftInput): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch('/api/campaigns', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(draft),
        }),
      )
    ).campaign,
  update: async (id: string, draft: CampaignDraftInput): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch(`/api/campaigns/${id}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify(draft),
        }),
      )
    ).campaign,
  submit: async (id: string): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch(`/api/campaigns/${id}/submit`, { method: 'POST' }),
      )
    ).campaign,
  reopen: async (id: string): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch(`/api/campaigns/${id}/reopen`, { method: 'POST' }),
      )
    ).campaign,
  pause: async (id: string): Promise<{ id: string; status: string }> =>
    (await parse<{ campaign: { id: string; status: string } }>(await authedFetch(`/api/campaigns/${id}/pause`, { method: 'POST' }))).campaign,
  resume: async (id: string): Promise<{ id: string; status: string }> =>
    (await parse<{ campaign: { id: string; status: string } }>(await authedFetch(`/api/campaigns/${id}/resume`, { method: 'POST' }))).campaign,
  pending: async (): Promise<Campaign[]> =>
    (await parse<{ campaigns: Campaign[] }>(await authedFetch('/api/campaigns/pending'))).campaigns,
  approve: async (id: string): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch(`/api/campaigns/${id}/approve`, { method: 'POST' }),
      )
    ).campaign,
  reject: async (id: string, reason: string): Promise<Campaign> =>
    (
      await parse<{ campaign: Campaign }>(
        await authedFetch(`/api/campaigns/${id}/reject`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ reason }),
        }),
      )
    ).campaign,
  remove: async (id: string): Promise<void> =>
    parse(await authedFetch(`/api/campaigns/${id}`, { method: 'DELETE' })),
  testLaunch: async (id: string): Promise<{ fbCampaignId: string; adSets: { fbAdSetId: string; ads: { fbAdId: string }[] }[] }> =>
    parse(await authedFetch(`/api/campaigns/${id}/test-launch`, { method: 'POST' })),
  // Phase E — campaign offers (the websites a campaign's traffic routes across).
  offers: async (id: string): Promise<OfferRow[]> =>
    (await parse<{ offers: OfferRow[] }>(await authedFetch(`/api/campaigns/${id}/offers`))).offers,
  setOffers: async (id: string, offers: OfferInput[]): Promise<OfferRow[]> =>
    (
      await parse<{ offers: OfferRow[] }>(
        await authedFetch(`/api/campaigns/${id}/offers`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ offers }) }),
      )
    ).offers,
  offerDomains: async (): Promise<OfferDomainOption[]> =>
    (await parse<{ domains: OfferDomainOption[] }>(await authedFetch('/api/campaigns/offer-domains'))).domains,
};

export const admin = {
  organization: async (): Promise<AdminOrg> =>
    (await parse<{ organization: AdminOrg }>(await authedFetch('/api/admin/organization'))).organization,
  organizations: async (): Promise<OrgRow[]> =>
    (await parse<{ organizations: OrgRow[] }>(await authedFetch('/api/admin/organizations'))).organizations,
  createOrganization: async (input: CreateOrgInput): Promise<{ orgId: string; adminId: string }> =>
    parse(await authedFetch('/api/admin/organizations', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })),
  addOrgUser: async (orgId: string, input: { name: string; email: string; password: string; role: 'COMPANY_ADMIN' | 'MEDIA_BUYER' }): Promise<PublicUser> =>
    (await parse<{ user: PublicUser }>(await authedFetch(`/api/admin/organizations/${orgId}/users`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }))).user,
  setAutoApprove: async (orgId: string, autoApprove: boolean): Promise<AdminOrg> =>
    (
      await parse<{ organization: AdminOrg }>(
        await authedFetch(`/api/admin/organizations/${orgId}/auto-approve`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ autoApprove }),
        }),
      )
    ).organization,
  setAutoLaunch: async (orgId: string, autoLaunch: boolean): Promise<AdminOrg> =>
    (
      await parse<{ organization: AdminOrg }>(
        await authedFetch(`/api/admin/organizations/${orgId}/auto-launch`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ autoLaunch }),
        }),
      )
    ).organization,
  users: async (): Promise<PublicUser[]> =>
    (await parse<{ users: PublicUser[] }>(await authedFetch('/api/admin/users'))).users,
  setUserStatus: async (id: string, action: UserAction): Promise<PublicUser> =>
    (
      await parse<{ user: PublicUser }>(
        await authedFetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ action }),
        }),
      )
    ).user,
  deleteUser: async (id: string): Promise<{ id: string }> =>
    parse<{ id: string }>(await authedFetch(`/api/admin/users/${id}`, { method: 'DELETE' })),
  orgUsers: async (orgId: string): Promise<PublicUser[]> =>
    (await parse<{ users: PublicUser[] }>(await authedFetch(`/api/admin/organizations/${orgId}/users`))).users,
  audit: async (opts?: { limit?: number; actions?: string[] }): Promise<AuditRow[]> => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.actions?.length) q.set('actions', opts.actions.join(','));
    const qs = q.toString();
    return (await parse<{ entries: AuditRow[] }>(await authedFetch(`/api/admin/audit${qs ? `?${qs}` : ''}`))).entries;
  },
  channels: async (): Promise<ChannelRow[]> =>
    (await parse<{ channels: ChannelRow[] }>(await authedFetch('/api/admin/channels'))).channels,
  channelSummary: async (): Promise<ChannelSummary> => parse(await authedFetch('/api/admin/channel-summary')),
  articles: async (): Promise<ArticleRow[]> =>
    (await parse<{ articles: ArticleRow[] }>(await authedFetch('/api/admin/articles'))).articles,
  settings: async (): Promise<PlatformSettings> =>
    (await parse<{ settings: PlatformSettings }>(await authedFetch('/api/admin/settings'))).settings,
  updateSettings: async (input: Partial<PlatformSettings>): Promise<PlatformSettings> =>
    (
      await parse<{ settings: PlatformSettings }>(
        await authedFetch('/api/admin/settings', {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify(input),
        }),
      )
    ).settings,
  setRevenueCut: async (orgId: string, pct: number): Promise<void> => {
    await authedFetch(`/api/admin/organizations/${orgId}/revenue-cut`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ pct }),
    });
  },
};

export const stats = {
  summary: async (range?: RangeArg): Promise<StatsSummary> =>
    parse(await authedFetch(`/api/stats/summary${rangeQs(range)}`)),
  campaigns: async (range?: RangeArg): Promise<CampaignPerf[]> =>
    (await parse<{ campaigns: CampaignPerf[] }>(await authedFetch(`/api/stats/campaigns${rangeQs(range)}`)))
      .campaigns,
  campaignBreakdown: async (id: string, range?: RangeArg): Promise<CampaignBreakdown> =>
    parse(await authedFetch(`/api/stats/campaigns/${id}${rangeQs(range)}`)),
  byBuyer: async (range?: RangeArg): Promise<BuyerRollup[]> =>
    (await parse<{ buyers: BuyerRollup[] }>(await authedFetch(`/api/stats/by-buyer${rangeQs(range)}`))).buyers,
  byCompany: async (range?: RangeArg): Promise<CompanyRollup[]> =>
    (await parse<{ companies: CompanyRollup[] }>(await authedFetch(`/api/stats/by-company${rangeQs(range)}`)))
      .companies,
  campaignOffers: async (id: string, range?: RangeArg): Promise<OfferStat[]> =>
    (await parse<{ offers: OfferStat[] }>(await authedFetch(`/api/stats/campaigns/${id}/offers${rangeQs(range)}`))).offers,
  campaignDim: async (id: string, dim: 'country' | 'hour', range?: RangeArg): Promise<DimStat[]> => {
    const q = rangeQs(range);
    return (await parse<{ rows: DimStat[] }>(await authedFetch(`/api/stats/campaigns/${id}/dim${q ? `${q}&` : '?'}dim=${dim}`))).rows;
  },
};

export const adsense = {
  status: async (): Promise<AdsenseStatus> => parse(await authedFetch('/api/adsense/status')),
  accounts: async (): Promise<AfsAccountRow[]> =>
    (await parse<{ accounts: AfsAccountRow[] }>(await authedFetch('/api/adsense/accounts'))).accounts,
  setAccountLabel: async (id: string, label: string): Promise<AfsAccountRow> =>
    (
      await parse<{ account: AfsAccountRow }>(
        await authedFetch(`/api/adsense/accounts/${id}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ label }),
        }),
      )
    ).account,
  disconnectAccount: async (id: string): Promise<void> => {
    await authedFetch(`/api/adsense/accounts/${id}`, { method: 'DELETE' });
  },
  authUrl: async (): Promise<{ url: string }> => parse(await authedFetch('/api/adsense/auth-url')),
  sync: async (ranges?: string): Promise<{ synced: number; added: number; account: string | null; ranges: string }> =>
    parse(
      await authedFetch('/api/adsense/sync', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ranges }),
      }),
    ),
  disconnect: async (): Promise<void> => parse(await authedFetch('/api/adsense/connection', { method: 'DELETE' })),
  // Sync an AFS account's full channel list into the local catalog (fast browsing of ~100k).
  syncCatalog: async (accountId: string): Promise<{ synced: number; account: string | null }> =>
    parse(await authedFetch(`/api/adsense/accounts/${accountId}/catalog/sync`, { method: 'POST' })),
};

export const domains = {
  list: async (): Promise<{ domains: DomainRow[]; dns: { cnameTarget: string } }> =>
    parse(await authedFetch('/api/domains')),
  create: async (input: { host: string; afsAccountId: string; channelRanges?: string; styleId?: string; adsafe?: string }): Promise<DomainRow> =>
    (await parse<{ domain: DomainRow }>(await authedFetch('/api/domains', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }))).domain,
  update: async (id: string, input: Partial<{ afsAccountId: string; channelRanges: string; styleId: string; adsafe: string }>): Promise<DomainRow> =>
    (await parse<{ domain: DomainRow }>(await authedFetch(`/api/domains/${id}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(input) }))).domain,
  verify: async (id: string): Promise<DomainRow> =>
    (await parse<{ domain: DomainRow }>(await authedFetch(`/api/domains/${id}/verify`, { method: 'POST' }))).domain,
  setOwner: async (id: string, orgId: string | null): Promise<DomainRow> =>
    (await parse<{ domain: DomainRow }>(await authedFetch(`/api/domains/${id}/owner`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ orgId }) }))).domain,
  sync: async (id: string, ranges?: string): Promise<{ synced: number; added: number; ranges: string }> =>
    parse(await authedFetch(`/api/domains/${id}/sync`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ranges }) })),
  // Browse the AFS account's channels by name/id (pick which to use), then import/remove.
  afsChannels: async (id: string, q?: string, range?: string): Promise<{ channels: AfsChannelRow[]; scanned: number; total: number; truncated: boolean }> =>
    parse(await authedFetch(`/api/domains/${id}/afs-channels?q=${encodeURIComponent(q ?? '')}&range=${encodeURIComponent(range ?? '')}&limit=2000`)),
  setChannels: async (id: string, sel: { add?: { channelId: string; label?: string }[]; remove?: string[] }): Promise<{ added: number; removed: number }> =>
    parse(await authedFetch(`/api/domains/${id}/afs-channels`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(sel) })),
  importAllChannels: async (id: string, q?: string, range?: string): Promise<{ added: number; matched: number; scanned: number; cappedAt?: number }> =>
    parse(await authedFetch(`/api/domains/${id}/afs-channels`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ importAll: true, q, range }) })),
  remove: async (id: string): Promise<void> => {
    await authedFetch(`/api/domains/${id}`, { method: 'DELETE' });
  },
};

export const uploads = {
  create: async (file: File): Promise<UploadResult> => {
    const form = new FormData();
    form.append('file', file);
    // No content-type header — the browser sets the multipart boundary.
    return (await parse<{ upload: UploadResult }>(await authedFetch('/api/uploads', { method: 'POST', body: form }))).upload;
  },
};
