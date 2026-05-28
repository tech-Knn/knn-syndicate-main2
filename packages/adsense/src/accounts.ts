import { AdsenseRequestError } from './errors.js';

/**
 * AdSense Management API v2 — account / ad-client / custom-channel listing. Used to
 * discover the connected account and to SEED our channel pool with the publisher's
 * real custom channels (replacing the placeholder ids). Read-only; the caller passes
 * a Google OAuth access token (adsense.readonly scope).
 *
 * Channel ids: a custom channel's resource name is
 *   accounts/pub-X/adclients/ca-pub-X/customchannels/<NUMERIC_ID>
 * The trailing <NUMERIC_ID> is the value we store as `Channel.channelId` (the `ch`
 * passed to CSA). The exact ch ↔ reportingDimensionId mapping is confirmed on a live
 * account (OPEN_QUESTIONS #4) — we keep both.
 */

export interface AdsenseAccount {
  /** Resource name, e.g. `accounts/pub-1234567890`. */
  name: string;
  displayName?: string;
}

export interface AdsenseAdClient {
  /** Resource name, e.g. `accounts/pub-X/adclients/ca-pub-X`. */
  name: string;
  /** e.g. `AFS` (AdSense for Search) or `AFC` (content). */
  productCode?: string;
}

export interface AdsenseCustomChannel {
  /** Full resource name. */
  name: string;
  displayName?: string;
  /** The numeric id (trailing segment of `name`) → our `Channel.channelId`. */
  channelId: string;
  reportingDimensionId?: string;
}

export interface ListDeps {
  fetch: typeof fetch;
  baseUrl: string;
}
// Resolve `fetch` lazily (per call) so tests can `vi.stubGlobal('fetch', …)`.
const defaultDeps: ListDeps = {
  fetch: (input, init) => fetch(input, init),
  baseUrl: 'https://adsense.googleapis.com/v2',
};

async function getJson<T>(url: string, token: string, deps: ListDeps): Promise<T> {
  const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AdsenseRequestError(`AdSense API failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return (await res.json()) as T;
}

/** Follow `nextPageToken` pagination, accumulating `key`'d arrays. */
async function paged<T>(base: string, key: string, token: string, deps: ListDeps): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${pageToken ? `${sep}pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const json = await getJson<Record<string, unknown>>(url, token, deps);
    const items = (json[key] as T[] | undefined) ?? [];
    out.push(...items);
    pageToken = json.nextPageToken as string | undefined;
  } while (pageToken);
  return out;
}

export async function listAccounts(accessToken: string, deps: ListDeps = defaultDeps): Promise<AdsenseAccount[]> {
  return paged<AdsenseAccount>(`${deps.baseUrl}/accounts`, 'accounts', accessToken, deps);
}

export async function listAdClients(
  accessToken: string,
  account: string,
  deps: ListDeps = defaultDeps,
): Promise<AdsenseAdClient[]> {
  return paged<AdsenseAdClient>(`${deps.baseUrl}/${account}/adclients`, 'adClients', accessToken, deps);
}

/** Map a raw custom-channel resource to our DTO (id = trailing path segment). */
export function toCustomChannel(raw: { name: string; displayName?: string; reportingDimensionId?: string }): AdsenseCustomChannel {
  const channelId = raw.name.split('/').pop() ?? raw.name;
  return { name: raw.name, displayName: raw.displayName, channelId, reportingDimensionId: raw.reportingDimensionId };
}

export async function listCustomChannels(
  accessToken: string,
  adClient: string,
  deps: ListDeps = defaultDeps,
): Promise<AdsenseCustomChannel[]> {
  const raw = await paged<{ name: string; displayName?: string; reportingDimensionId?: string }>(
    `${deps.baseUrl}/${adClient}/customchannels`,
    'customChannels',
    accessToken,
    deps,
  );
  return raw.map(toCustomChannel);
}

/**
 * Discover every custom channel across the account's ad clients (optionally only AFS).
 * Returns the channels we can seed into the pool.
 */
export async function discoverChannels(
  accessToken: string,
  account: string,
  opts: { afsOnly?: boolean } = {},
  deps: ListDeps = defaultDeps,
): Promise<AdsenseCustomChannel[]> {
  const clients = await listAdClients(accessToken, account, deps);
  const wanted = opts.afsOnly ? clients.filter((c) => c.productCode === 'AFS') : clients;
  const all: AdsenseCustomChannel[] = [];
  for (const client of wanted) {
    all.push(...(await listCustomChannels(accessToken, client.name, deps)));
  }
  return all;
}
