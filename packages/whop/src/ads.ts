import type { WhopList } from './api.js';
import type { WhopClient } from './client.js';
import { WhopApiError } from './errors.js';

/**
 * Whop's ads API (D33, phase 2): campaign → ad group → ad, plus the direct-upload flow for creatives.
 *
 * Whop's hierarchy: an ad CAMPAIGN holds the objective (and optionally the budget), an AD GROUP holds targeting,
 * placements, the optimized event and (by default) the budget, an AD holds the copy, the creatives and the
 * destination URL. Inputs here use Whop's own snake_case field names so there is no translation layer to get
 * wrong; only `idempotencyKey` is ours. Every create takes one: Whop stores the response for 24 hours and
 * replays it, which is what makes a half-finished launch safe to resume.
 *
 * Facts this code relies on (verified against Whop's sandbox, 2026-09-30):
 *  - A standalone `POST /ad_campaigns` is a DRAFT. Creating an ad under a draft does not launch it, but it DOES
 *    run the pixel check on the destination (400 "The Whop pixel was not detected on <url>").
 *  - `PATCH /ad_campaigns/{id} { status: 'active' }` launches it, checking in this order: a creative on every ad
 *    ("Add a creative to these ads before launching: <ad>"), a Facebook page ("Connect a Facebook page to
 *    launch these ads: <ad>"), then the account's payment method. Each is a 400 whose message says what to fix.
 *  - Files go direct to storage: create the record, PUT the bytes to the presigned URL, poll until `ready`.
 */

export type WhopObjective = 'awareness' | 'traffic' | 'engagement' | 'leads' | 'sales';

/** A human-readable problem attached to a campaign, ad group or ad (Meta's asynchronous rejections land here). */
export interface WhopIssue {
  id: string;
  message: string;
  resource_id: string | null;
  resource_type: 'ad_campaign' | 'ad_group' | 'ad';
}

/** The stats Whop puts on an entity read with a stats window. Only what we use is typed. */
export interface WhopStats {
  spend?: number;
  clicks?: number;
  link_clicks?: number;
  impressions?: number;
  /** Whop's pixel-attributed count behind `result_event` (null when nothing Whop-attributable is optimized). */
  results?: number | null;
  result_event?: string | null;
  /**
   * Whop's pixel-attributed (last-click) count of `submit_application`, our money event, whatever the ad group optimizes:
   * the precise field for it (`results` depends on the optimization goal and is null when goals differ).
   */
  submitted_applications?: number | null;
  spend_currency?: string | null;
}

export interface WhopAdCampaign extends WhopStats {
  id: string;
  title: string;
  /** The configured lifecycle: active, paused, draft, in_review, flagged, ... Billing failures keep active/paused here. */
  status: string;
  /** Whether it is delivering right now, and if not why: draft, processing, active, paused, payment_failed, all_ads_rejected, ... */
  delivery_status: string;
  platform: string;
  objective: WhopObjective;
  budget_amount: number | null;
  budget_type: 'daily' | 'lifetime';
  budget_optimization: 'ad_campaign' | 'ad_group';
  issues: WhopIssue[];
  created_at: string;
  updated_at: string;
}

export interface WhopAdGroup extends WhopStats {
  id: string;
  title: string;
  status: string;
  delivery_status: string;
  conversion_event: string | null;
  budget_amount: number | null;
  budget_type: 'daily' | 'lifetime';
  ad_campaign: { id: string };
  issues: WhopIssue[];
}

export interface WhopAdCreative {
  id: string;
  format: string | null;
  url: string | null;
  media_type: string | null;
}

export interface WhopAd extends WhopStats {
  id: string;
  title: string;
  /** active / paused are ours to set; in_review / rejected come from ad review. */
  status: string;
  delivery_status: string;
  url: string | null;
  url_parameters: Record<string, string>;
  created_at?: string;
  creatives: WhopAdCreative[];
  social_accounts: { id: string }[];
  ad_group: { id: string };
  ad_campaign: { id: string };
  issues: WhopIssue[];
}

export interface WhopFile {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
  url: string | null;
  upload_status: 'pending' | 'processing' | 'ready' | 'failed';
  upload_url?: string | null;
  upload_headers?: Record<string, string>;
}

// ── request bodies (Whop's own field names) ─────────────────────────────────────────────────────────

export interface WhopLocationSet {
  countries?: string[];
  country_groups?: string[];
  regions?: string[];
  cities?: unknown[];
  zips?: unknown[];
  custom_locations?: unknown[];
}
export interface WhopRegions {
  include?: WhopLocationSet;
  exclude?: WhopLocationSet;
}
export interface WhopDemographics {
  /** Advantage+ audience: Meta may deliver beyond the ages and genders you set. */
  automatic?: boolean;
  minimum_age?: number;
  maximum_age?: number;
  gender?: 'all' | 'male' | 'female';
}
export type WhopPlacementPlatform = 'facebook' | 'instagram' | 'messenger' | 'audience_network' | 'threads' | 'whatsapp';
export type WhopPlacements = 'automatic' | { platform: WhopPlacementPlatform; positions?: string[] }[];
export interface WhopDevices {
  platforms?: ('mobile' | 'desktop')[];
  /** Objects, not strings (Whop's spec): `{ os }`, optionally with a `minimum_version` such as `18.0`. */
  operating_systems?: { os: 'ios' | 'android'; minimum_version?: string }[];
}

export interface CreateAdCampaignInput {
  account_id: string;
  title: string;
  platform: 'meta';
  objective: WhopObjective;
  budget_optimization?: 'ad_campaign' | 'ad_group';
  /** USD. Only when the campaign owns the budget (`budget_optimization: 'ad_campaign'`). */
  budget_amount?: number;
  budget_type?: 'daily' | 'lifetime';
  special_ad_categories?: string[];
  starts_at?: string;
  ends_at?: string;
  idempotencyKey?: string;
}

export interface UpdateAdCampaignInput {
  title?: string;
  budget_amount?: number;
  budget_type?: 'daily' | 'lifetime';
  budget_optimization?: 'ad_campaign' | 'ad_group';
  special_ad_categories?: string[];
  starts_at?: string;
  ends_at?: string;
  /** `active` launches a draft campaign. Pausing and resuming a live one use the pause / unpause actions. */
  status?: 'active';
}

export interface CreateAdGroupInput {
  ad_campaign_id: string;
  title: string;
  /** USD per day (or lifetime). Omit when the campaign owns the budget. */
  budget_amount?: number;
  budget_type?: 'daily' | 'lifetime';
  conversion_location?: 'website';
  /** The pixel event optimized for. `submit_application` is our money event. */
  conversion_event?: string;
  optimization_goal?: string;
  bid_type?: 'minimum_cost' | 'average_target' | 'maximum_target';
  desired_cost_per_result?: number;
  regions?: WhopRegions;
  demographics?: WhopDemographics;
  placements?: WhopPlacements;
  devices?: WhopDevices;
  languages?: string[];
  starts_at?: string;
  ends_at?: string;
  status?: 'active' | 'paused';
  idempotencyKey?: string;
}

export interface UpdateAdGroupInput {
  title?: string;
  budget_amount?: number;
  budget_type?: 'daily' | 'lifetime';
  regions?: WhopRegions;
  demographics?: WhopDemographics;
  placements?: WhopPlacements;
  devices?: WhopDevices;
  languages?: string[];
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface WhopCopy {
  text: string;
}

export interface CreateAdInput {
  ad_group_id: string;
  title: string;
  /** The destination. An external page needs the Whop pixel: Whop loads it, follows redirects and looks. */
  url: string;
  /** Appended to `url`. Whop's own click parameters (wacid, wasid, waid, utm_*) are reserved and rejected here. */
  url_parameters?: Record<string, string>;
  headlines: WhopCopy[];
  primary_texts: WhopCopy[];
  descriptions?: WhopCopy[];
  call_to_action?: string;
  /** One entry with no `format` (the base asset) is required to launch. */
  creatives?: { id: string; format?: 'square' | 'vertical' | 'horizontal' }[];
  social_accounts?: { id: string }[];
  idempotencyKey?: string;
}

export interface UpdateAdInput {
  title?: string;
  url?: string;
  url_parameters?: Record<string, string>;
  headlines?: WhopCopy[];
  primary_texts?: WhopCopy[];
  descriptions?: WhopCopy[];
  call_to_action?: string;
  /** Replaces the WHOLE set: include the base entry. */
  creatives?: { id: string; format?: 'square' | 'vertical' | 'horizontal' }[];
  social_accounts?: { id: string }[];
}

export interface WhopStatsWindow {
  /** ISO 8601. */
  from?: string;
  to?: string;
  /** IANA zone the window is read in. Whop defaults to UTC; our business day is IST (`Asia/Kolkata`). */
  timeZone?: string;
}

const omit = (o: object, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));
const enc = encodeURIComponent;

export interface WhopAdsApi {
  createCampaign(p: CreateAdCampaignInput): Promise<WhopAdCampaign>;
  getCampaign(id: string, stats?: WhopStatsWindow): Promise<WhopAdCampaign>;
  updateCampaign(id: string, patch: UpdateAdCampaignInput): Promise<WhopAdCampaign>;
  /** Launch a draft. Refused with a 400 naming what is missing (creative, page, payment method, agreement). */
  launchCampaign(id: string): Promise<WhopAdCampaign>;
  pauseCampaign(id: string): Promise<WhopAdCampaign>;
  /** Needs an ads payment method on the account. */
  unpauseCampaign(id: string): Promise<WhopAdCampaign>;
  /** Deletes the campaign and archives it on Meta; cascades to its ad groups and ads. */
  deleteCampaign(id: string): Promise<void>;

  createAdGroup(p: CreateAdGroupInput): Promise<WhopAdGroup>;
  getAdGroup(id: string, stats?: WhopStatsWindow): Promise<WhopAdGroup>;
  updateAdGroup(id: string, patch: UpdateAdGroupInput): Promise<WhopAdGroup>;
  pauseAdGroup(id: string): Promise<WhopAdGroup>;
  unpauseAdGroup(id: string): Promise<WhopAdGroup>;
  deleteAdGroup(id: string): Promise<void>;

  createAd(p: CreateAdInput): Promise<WhopAd>;
  getAd(id: string, stats?: WhopStatsWindow): Promise<WhopAd>;
  updateAd(id: string, patch: UpdateAdInput): Promise<WhopAd>;
  pauseAd(id: string): Promise<WhopAd>;
  unpauseAd(id: string): Promise<WhopAd>;
  deleteAd(id: string): Promise<void>;

  /**
   * Every campaign of a business (all pages), optionally with stats over a window. One call per page of 100
   * instead of one per campaign: this is how the status and spend syncs read Whop.
   */
  listCampaigns(p: { accountId: string; stats?: WhopStatsWindow; maxPages?: number }): Promise<WhopAdCampaign[]>;
  /** The ads of up to 100 campaigns at a time (Whop's limit), all pages, optionally with stats. */
  listAds(p: { accountId: string; campaignIds: readonly string[]; stats?: WhopStatsWindow; maxPages?: number }): Promise<WhopAd[]>;

  /** Create the file record and get the presigned destination. */
  createFile(p: { filename: string; idempotencyKey?: string }): Promise<WhopFile>;
  getFile(id: string): Promise<WhopFile>;
  /**
   * The whole direct-upload flow for one creative: create the record, PUT the bytes to storage, poll until
   * Whop has it (`ready`). A transient failure, or an upload link that has expired, starts over on a NEW record
   * under a new key (the presigned URL lives an hour), up to twice. Returns the ready file: pass its `id` in an ad's `creatives`.
   */
  uploadCreative(p: { filename: string; bytes: Uint8Array; idempotencyKey?: string; pollMs?: number; timeoutMs?: number }): Promise<WhopFile>;
}

function statsQuery(w?: WhopStatsWindow): Record<string, string | undefined> {
  return { stats_from: w?.from, stats_to: w?.to, time_zone: w?.timeZone };
}

export function whopAdsApi(client: WhopClient, opts: { sleep?: (ms: number) => Promise<void> } = {}): WhopAdsApi {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const post = <T>(path: string, body: Record<string, unknown> | undefined, idempotencyKey?: string): Promise<T> => client.request<T>({ method: 'POST', path, body, idempotencyKey });
  const get = <T>(path: string, stats?: WhopStatsWindow): Promise<T> => client.request<T>({ method: 'GET', path, query: statsQuery(stats) });
  const patch = <T>(path: string, body: Record<string, unknown>): Promise<T> => client.request<T>({ method: 'PATCH', path, body });
  const del = async (path: string): Promise<void> => void (await client.request({ method: 'DELETE', path }));

  const api: WhopAdsApi = {
    createCampaign: (p) => post('/ad_campaigns', omit(p, 'idempotencyKey'), p.idempotencyKey),
    getCampaign: (id, stats) => get(`/ad_campaigns/${enc(id)}`, stats),
    updateCampaign: (id, body) => patch(`/ad_campaigns/${enc(id)}`, body as Record<string, unknown>),
    launchCampaign: (id) => patch(`/ad_campaigns/${enc(id)}`, { status: 'active' }),
    pauseCampaign: (id) => post(`/ad_campaigns/${enc(id)}/pause`, undefined),
    unpauseCampaign: (id) => post(`/ad_campaigns/${enc(id)}/unpause`, undefined),
    deleteCampaign: (id) => del(`/ad_campaigns/${enc(id)}`),

    createAdGroup: (p) => post('/ad_groups', omit(p, 'idempotencyKey'), p.idempotencyKey),
    getAdGroup: (id, stats) => get(`/ad_groups/${enc(id)}`, stats),
    updateAdGroup: (id, body) => patch(`/ad_groups/${enc(id)}`, body as Record<string, unknown>),
    pauseAdGroup: (id) => post(`/ad_groups/${enc(id)}/pause`, undefined),
    unpauseAdGroup: (id) => post(`/ad_groups/${enc(id)}/unpause`, undefined),
    deleteAdGroup: (id) => del(`/ad_groups/${enc(id)}`),

    createAd: (p) => post('/ads', omit(p, 'idempotencyKey'), p.idempotencyKey),
    getAd: (id, stats) => get(`/ads/${enc(id)}`, stats),
    updateAd: (id, body) => patch(`/ads/${enc(id)}`, body as Record<string, unknown>),
    pauseAd: (id) => post(`/ads/${enc(id)}/pause`, undefined),
    unpauseAd: (id) => post(`/ads/${enc(id)}/unpause`, undefined),
    deleteAd: (id) => del(`/ads/${enc(id)}`),

    async listCampaigns({ accountId, stats, maxPages = 50 }) {
      const out: WhopAdCampaign[] = [];
      let after: string | undefined;
      for (let i = 0; i < maxPages; i++) {
        const page = await client.request<WhopList<WhopAdCampaign>>({ method: 'GET', path: '/ad_campaigns', query: { account_id: accountId, first: 100, after, ...statsQuery(stats) } });
        out.push(...page.data);
        if (!page.page_info.has_next_page || !page.page_info.end_cursor) break;
        after = page.page_info.end_cursor;
      }
      return out;
    },
    async listAds({ accountId, campaignIds, stats, maxPages = 50 }) {
      const out: WhopAd[] = [];
      for (let i = 0; i < campaignIds.length; i += 100) {
        const ids = campaignIds.slice(i, i + 100);
        let after: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const res = await client.request<WhopList<WhopAd>>({ method: 'GET', path: '/ads', query: { account_id: accountId, ad_campaign_ids: ids, first: 100, after, ...statsQuery(stats) } });
          out.push(...res.data);
          if (!res.page_info.has_next_page || !res.page_info.end_cursor) break;
          after = res.page_info.end_cursor;
        }
      }
      return out;
    },

    createFile: (p) => post('/files', { filename: p.filename, visibility: 'private' }, p.idempotencyKey),
    getFile: (id) => get(`/files/${enc(id)}`),

    async uploadCreative({ filename, bytes, idempotencyKey, pollMs = 1000, timeoutMs = 60_000 }) {
      const attempt = async (key: string | undefined): Promise<WhopFile> => {
        const created = await api.createFile({ filename, idempotencyKey: key });
        if (!created.upload_url) throw new WhopApiError('server', 'Whop did not return an upload destination.', { status: 200, method: 'POST', path: '/files' });
        await client.upload(created.upload_url, created.upload_headers ?? {}, bytes);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const file = await api.getFile(created.id);
          if (file.upload_status === 'ready') return file;
          if (file.upload_status === 'failed') throw new WhopApiError('validation', 'Whop could not process the uploaded file.', { status: 200, method: 'GET', path: `/files/${created.id}` });
          if (Date.now() > deadline) throw new WhopApiError('timeout', 'Whop took too long to process the uploaded file.', { status: 0, method: 'GET', path: `/files/${created.id}` });
          await sleep(pollMs);
        }
      };
      // Up to three tries, each on a NEW record. A replayed idempotency key hands back the old record and its presigned link,
      // which is exactly what has just failed, so a retry never reuses the key that failed:
      //  - a transient failure (network, timeout, 5xx) -> the deterministic `:retry` key, then fresh ones;
      //  - an upload link that expired or was refused (403) -> a FRESH key at once. This is what an earlier launch's leftover
      //    record looks like an hour later; without it that ad would fail every launch until Whop forgets the key (24 h).
      let key = idempotencyKey;
      for (let i = 0; ; i++) {
        try {
          return await attempt(key);
        } catch (err) {
          const transient = err instanceof WhopApiError && ['network', 'timeout', 'server'].includes(err.kind);
          const dead = err instanceof WhopApiError && err.kind === 'validation' && err.status === 403;
          if ((!transient && !dead) || i >= 2) throw err;
          key = idempotencyKey ? (i === 0 && transient ? `${idempotencyKey}:retry` : `${idempotencyKey}:r${Date.now().toString(36)}${i}`) : undefined;
        }
      }
    },
  };
  return api;
}
