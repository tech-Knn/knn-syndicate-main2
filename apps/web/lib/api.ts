import {
  type Campaign,
  type ConnectionStatus,
  type FbAccount,
  type FbPage,
  type FbPixel,
  type SessionUser,
  type SyncResult,
  type UploadResult,
} from './types';
import { type CampaignDraftInput } from '@knn/shared';

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
};

export const facebook = {
  status: async (): Promise<ConnectionStatus> => parse(await authedFetch('/api/facebook/status')),
  authUrl: async (): Promise<{ url: string }> => parse(await authedFetch('/api/facebook/auth-url')),
  accounts: async (): Promise<FbAccount[]> =>
    (await parse<{ accounts: FbAccount[] }>(await authedFetch('/api/facebook/accounts'))).accounts,
  pages: async (): Promise<FbPage[]> =>
    (await parse<{ pages: FbPage[] }>(await authedFetch('/api/facebook/pages'))).pages,
  accountPages: async (accountId: string): Promise<FbPage[]> =>
    (
      await parse<{ pages: FbPage[] }>(await authedFetch(`/api/facebook/accounts/${accountId}/pages`))
    ).pages,
  pixels: async (accountId: string): Promise<FbPixel[]> =>
    (
      await parse<{ pixels: FbPixel[] }>(
        await authedFetch(`/api/facebook/accounts/${accountId}/pixels`),
      )
    ).pixels,
  sync: async (): Promise<SyncResult> => parse(await authedFetch('/api/facebook/sync', { method: 'POST' })),
  disconnect: async (): Promise<void> => parse(await authedFetch('/api/facebook/connection', { method: 'DELETE' })),
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
  remove: async (id: string): Promise<void> =>
    parse(await authedFetch(`/api/campaigns/${id}`, { method: 'DELETE' })),
  testLaunch: async (id: string): Promise<{ fbCampaignId: string; adSets: { fbAdSetId: string; ads: { fbAdId: string }[] }[] }> =>
    parse(await authedFetch(`/api/campaigns/${id}/test-launch`, { method: 'POST' })),
};

export const uploads = {
  create: async (file: File): Promise<UploadResult> => {
    const form = new FormData();
    form.append('file', file);
    // No content-type header — the browser sets the multipart boundary.
    return (await parse<{ upload: UploadResult }>(await authedFetch('/api/uploads', { method: 'POST', body: form }))).upload;
  },
};
