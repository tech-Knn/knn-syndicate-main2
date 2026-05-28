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

/** Follow `nextPageToken` pagination, accumulating `key`'d arrays (stops at `max`). */
async function paged<T>(base: string, key: string, token: string, deps: ListDeps, max = Infinity): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${pageToken ? `${sep}pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const json = await getJson<Record<string, unknown>>(url, token, deps);
    const items = (json[key] as T[] | undefined) ?? [];
    out.push(...items);
    pageToken = json.nextPageToken as string | undefined;
  } while (pageToken && out.length < max);
  return out.length > max ? out.slice(0, max) : out;
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
  max = Infinity,
): Promise<AdsenseCustomChannel[]> {
  const raw = await paged<{ name: string; displayName?: string; reportingDimensionId?: string }>(
    `${deps.baseUrl}/${adClient}/customchannels`,
    'customChannels',
    accessToken,
    deps,
    max,
  );
  return raw.map(toCustomChannel);
}

/**
 * Discover custom channels across the account's ad clients (optionally only AFS), up
 * to `max` total. AFS partner accounts can carry 10k+ channels, so the pool seed is
 * capped — only a bounded set is needed (1 channel per concurrent campaign).
 */
export async function discoverChannels(
  accessToken: string,
  account: string,
  opts: { afsOnly?: boolean; max?: number } = {},
  deps: ListDeps = defaultDeps,
): Promise<AdsenseCustomChannel[]> {
  const max = opts.max ?? Infinity;
  const clients = await listAdClients(accessToken, account, deps);
  const wanted = opts.afsOnly ? clients.filter((c) => c.productCode === 'AFS') : clients;
  const all: AdsenseCustomChannel[] = [];
  for (const client of wanted) {
    if (all.length >= max) break;
    all.push(...(await listCustomChannels(accessToken, client.name, deps, max - all.length)));
  }
  return all.length > max ? all.slice(0, max) : all;
}

export interface ChannelRange {
  start: number;
  end: number;
}

/**
 * Parse a channel-range spec ("03700-05000, 00500-01000" or single ids "03700") into
 * numeric inclusive ranges. AFS accounts can carry 100k+ channels split across teams,
 * so an admin selects only the id series that belong to THIS platform.
 */
export function parseChannelRanges(spec: string): ChannelRange[] {
  const out: ChannelRange[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      out.push(a <= b ? { start: a, end: b } : { start: b, end: a });
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      out.push({ start: n, end: n });
    }
  }
  return out;
}

function channelNum(channelId: string): number | null {
  return /^\d+$/.test(channelId) ? Number(channelId) : null;
}

/**
 * Discover only the AFS channels whose numeric id falls in `ranges`. Channels list
 * sorted ascending, so we page with the max page size and STOP once we pass the
 * highest requested id — bounding the scan even for a 100k-channel account. `hardCap`
 * is a safety ceiling on the import size.
 */
export async function discoverChannelsInRanges(
  accessToken: string,
  adClient: string,
  ranges: ChannelRange[],
  deps: ListDeps = defaultDeps,
  hardCap = 5000,
): Promise<AdsenseCustomChannel[]> {
  if (ranges.length === 0) return [];
  const maxEnd = Math.max(...ranges.map((r) => r.end));
  const inRange = (n: number): boolean => ranges.some((r) => n >= r.start && n <= r.end);
  const out: AdsenseCustomChannel[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${deps.baseUrl}/${adClient}/customchannels?pageSize=10000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const json = await getJson<{
      customChannels?: { name: string; displayName?: string; reportingDimensionId?: string }[];
      nextPageToken?: string;
    }>(url, accessToken, deps);
    let overshot = false;
    for (const raw of json.customChannels ?? []) {
      const ch = toCustomChannel(raw);
      const n = channelNum(ch.channelId);
      if (n === null) continue;
      if (n > maxEnd) {
        overshot = true;
        continue;
      }
      if (inRange(n)) out.push(ch);
    }
    if (overshot || out.length >= hardCap) break;
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out.slice(0, hardCap);
}
