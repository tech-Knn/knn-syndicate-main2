import { randomBytes } from 'node:crypto';
import type { WhopIssue } from '../ads.js';

/**
 * The ads half of the mock Whop API: campaigns, ad groups, ads, files. It reproduces what was observed against
 * Whop's real sandbox on 2026-09-30, so launch code is tested against Whop's actual behaviour:
 *  - a standalone campaign is a DRAFT; an ad group starts `active` with `delivery_status: draft`;
 *  - creating an ad runs the PIXEL CHECK on its `url` (even under a draft campaign), using the same fetch the
 *    pixel-validation endpoint does; a whop.com page needs no pixel;
 *  - launching (`PATCH … status: active`) checks, in this order: a creative on every ad, a Facebook page on
 *    every ad, the account's payment method (and agreement), each as a 400 whose message says what to fix;
 *  - files are created, the bytes PUT to a presigned URL (no Authorization header allowed), then `ready`;
 *  - a repeated POST with the same Idempotency-Key replays the first answer, creating nothing.
 * The launch-gate texts for the payment method and the agreement, and the "no ad group / no ad" texts, are NOT
 * verified against Whop (the sandbox cannot reach them): they follow Whop's docs / are best guesses.
 */

export interface MockCampaign {
  id: string;
  title: string;
  status: string;
  delivery_status: string;
  platform: 'meta';
  objective: string;
  budget_amount: number | null;
  budget_type: string;
  budget_optimization: string;
  issues: WhopIssue[];
  created_at: string;
  updated_at: string;
}
export interface MockGroup {
  id: string;
  title: string;
  status: string;
  delivery_status: string;
  conversion_event: string | null;
  budget_amount: number | null;
  budget_type: string;
  ad_campaign: { id: string };
  issues: WhopIssue[];
  /** The body it was created with (targeting etc.), kept so tests can assert what we sent. */
  body: Record<string, unknown>;
}
export interface MockAd {
  id: string;
  title: string;
  status: string;
  delivery_status: string;
  url: string;
  url_parameters: Record<string, string>;
  headlines: { text: string }[];
  primary_texts: { text: string }[];
  descriptions: { text: string }[];
  call_to_action: string | null;
  creatives: { id: string; format: string | null; url: string | null; media_type: string | null }[];
  social_accounts: { id: string }[];
  ad_group: { id: string };
  ad_campaign: { id: string };
  issues: WhopIssue[];
}
export interface MockFile {
  id: string;
  filename: string;
  content_type: string;
  size: number | null;
  url: string | null;
  upload_status: 'pending' | 'processing' | 'ready' | 'failed';
  /** Bytes received by the presigned PUT. */
  received?: Uint8Array;
  /** GETs left before a finished upload reads `ready` (simulates Whop's short processing step). */
  processingPolls: number;
}

/** One observation of an ad's delivery at an instant; a stats window sums the ones inside it. */
export interface MockStat {
  adId: string;
  /** Epoch ms of the observation. */
  at: number;
  spend: number;
  clicks: number;
  link_clicks: number;
  impressions: number;
  results: number | null;
  result_event: string | null;
  submitted_applications: number;
  spend_currency: string;
}

export interface MockAdsState {
  campaigns: Map<string, MockCampaign>;
  groups: Map<string, MockGroup>;
  ads: Map<string, MockAd>;
  files: Map<string, MockFile>;
  /** Idempotency-Key → the answer to replay. */
  replay: Map<string, { status: number; body: unknown }>;
  stats: MockStat[];
}

export const newAdsState = (): MockAdsState => ({ campaigns: new Map(), groups: new Map(), ads: new Map(), files: new Map(), replay: new Map(), stats: [] });

/** Test hook: record what an ad delivered at an instant. Whop's bulk reads then report it inside a `stats_from`..`stats_to` window. */
export function addAdStats(ads: MockAdsState, adId: string, s: { at: string | Date; spend: number; clicks?: number; link_clicks?: number; impressions?: number; results?: number | null; result_event?: string | null; submitted_applications?: number; spend_currency?: string }): void {
  if (!ads.ads.has(adId)) throw new Error(`mock: no ad ${adId}`);
  ads.stats.push({
    adId,
    at: new Date(s.at).getTime(),
    spend: s.spend,
    clicks: s.clicks ?? s.link_clicks ?? 0,
    link_clicks: s.link_clicks ?? s.clicks ?? 0,
    impressions: s.impressions ?? 0,
    results: s.results ?? null,
    result_event: s.result_event ?? null,
    // Whop's own count of our money event; by default what `results` says when the ad group optimizes that event.
    submitted_applications: s.submitted_applications ?? (s.result_event === 'submit_application' ? (s.results ?? 0) : 0),
    spend_currency: s.spend_currency ?? 'usd',
  });
}

/** An ad with the stats of the window a read asked for (`stats_from` / `stats_to`); zeros when no window was asked. */
function adWithStats(ads: MockAdsState, a: MockAd, query: Record<string, string | string[]>): unknown {
  const from = typeof query.stats_from === 'string' ? Date.parse(query.stats_from) : NaN;
  const to = typeof query.stats_to === 'string' ? Date.parse(query.stats_to) : NaN;
  const inWindow = Number.isNaN(from) || Number.isNaN(to) ? [] : ads.stats.filter((x) => x.adId === a.id && x.at >= from && x.at <= to);
  const sum = (f: (x: MockStat) => number): number => inWindow.reduce((t, x) => t + f(x), 0);
  const anyResults = inWindow.some((x) => x.results !== null);
  return {
    ...a,
    spend: sum((x) => x.spend),
    clicks: sum((x) => x.clicks),
    link_clicks: sum((x) => x.link_clicks),
    impressions: sum((x) => x.impressions),
    results: anyResults ? sum((x) => x.results ?? 0) : null,
    result_event: inWindow.find((x) => x.result_event)?.result_event ?? null,
    submitted_applications: sum((x) => x.submitted_applications),
    spend_currency: inWindow[0]?.spend_currency ?? null,
  };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rid = (prefix: string, len: number): string => `${prefix}_${Array.from(randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
const now = (): string => new Date().toISOString();

export const OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'sales'];
/** Whop's own click parameters: reserved, rejected in an ad's `url_parameters`. */
const RESERVED = ['wacid', 'wasid', 'waid', 'utm_whop', 'utm_meta_ad_id', 'utm_meta_adset_id', 'utm_meta_campaign_id', 'utm_source', 'utm_placement', 'utm_medium', 'utm_content', 'utm_adset', 'tw_source', 'tw_adid'];

export class MockAdsError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string): never => {
  throw new MockAdsError(400, 'bad_request', message);
};
const notFound = (what: string): never => {
  throw new MockAdsError(404, 'not_found', `${what} not found.`);
};

export interface AdsContext {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  ads: MockAdsState;
  biz: { bizId: string; payment: unknown; agreement: string; pages: { id: string; error: string | null }[] };
  baseUrl: string;
  /** The pixel check (shared with validate_pixel). */
  inspect: (url: string) => Promise<{ installed: boolean }>;
  /** Permission gate: answers false (after writing the 403) when the key lacks all of these. */
  need: (anyOf: string[]) => boolean;
}

type Reply = { status: number; body: unknown } | undefined;

function launchGateError(ctx: AdsContext, campaign: MockCampaign): string | null {
  const groups = [...ctx.ads.groups.values()].filter((g) => g.ad_campaign.id === campaign.id);
  const ads = [...ctx.ads.ads.values()].filter((a) => a.ad_campaign.id === campaign.id);
  const titles = (list: MockAd[]): string => list.map((a) => a.title).join(', ');
  if (groups.length === 0) return 'Add an ad group before launching.';
  if (ads.length === 0) return 'Add an ad before launching.';
  const noCreative = ads.filter((a) => !a.creatives.some((c) => !c.format));
  if (noCreative.length) return `Add a creative to these ads before launching: ${titles(noCreative)}`;
  const noPage = ads.filter((a) => a.social_accounts.length === 0);
  if (noPage.length) return `Connect a Facebook page to launch these ads: ${titles(noPage)}`;
  const pay = ctx.biz.payment as { primary?: unknown } | null;
  if (!pay?.primary) return 'Connect an ads payment method before launching';
  if (ctx.biz.agreement === 'pending_signature') return 'Sign the Whop Ads agreement before launching.';
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function checkBudget(level: 'ad_campaign' | 'ad_group', campaign: MockCampaign, amount: number | undefined): void {
  if (campaign.budget_optimization === level) {
    if (amount === undefined) bad('budget_amount is required');
  } else if (amount !== undefined) {
    bad("budget_amount can't be set here: the budget is owned by the other level.");
  }
}

/** Run one ads/files route. Returns undefined when the path is not one of ours. Throws MockAdsError for refusals. */
export async function handleAdsRoute(ctx: AdsContext): Promise<Reply> {
  const { method, path, body, ads, biz } = ctx;

  // ── files ──
  if (method === 'POST' && path === '/files') {
    const filename = str(body.filename) ?? bad('filename is required');
    const id = rid('file', 13);
    const ext = /\.(\w+)$/.exec(filename)?.[1]?.toLowerCase() ?? '';
    const contentType = ext === 'png' ? 'image/png' : ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime' : 'image/jpeg';
    const file: MockFile = { id, filename: filename as string, content_type: contentType, size: null, url: null, upload_status: 'pending', processingPolls: 0 };
    ads.files.set(id, file);
    return { status: 201, body: { object: 'file', ...publicFile(file), visibility: 'private', upload_url: `${ctx.baseUrl}/_upload/${id}`, upload_headers: { 'Content-Type': contentType }, multipart_upload_id: null, multipart_upload_urls: null, multipart_chunk_size: null } };
  }
  const fileMatch = /^\/files\/([^/]+)$/.exec(path);
  if (method === 'GET' && fileMatch) {
    const file = ads.files.get(decodeURIComponent(fileMatch[1]!)) ?? notFound('File');
    const f = file as MockFile;
    if (f.received && f.upload_status === 'processing') {
      if (f.processingPolls > 0) f.processingPolls -= 1;
      else {
        f.upload_status = 'ready';
        f.size = f.received.byteLength;
        f.url = `https://assets.mock.whop.test/${f.id}/${f.filename}`;
      }
    }
    return { status: 200, body: { object: 'file', ...publicFile(f), visibility: 'private' } };
  }

  // ── lists (the status and spend syncs read a business in bulk) ──
  if (method === 'GET' && (path === '/ad_campaigns' || path === '/ads')) {
    if (!ctx.need(['ad_campaign:basic:read'])) return undefined;
    const first = Math.min(Number(ctx.query.first ?? 100) || 100, 100);
    const offset = Number(Buffer.from(String(ctx.query.after ?? ''), 'base64url').toString() || 0) || 0;
    const wanted = new Set([ctx.query.ad_campaign_ids, ctx.query.ad_campaign_id].flat().filter((x): x is string => typeof x === 'string'));
    const rows =
      path === '/ad_campaigns'
        ? [...ads.campaigns.values()].map(campaignView)
        : [...ads.ads.values()].filter((a) => wanted.size === 0 || wanted.has(a.ad_campaign.id)).map((a) => adWithStats(ads, a, ctx.query));
    const slice = rows.slice(offset, offset + first);
    const next = offset + first < rows.length;
    return { status: 200, body: { data: slice, page_info: { end_cursor: next ? Buffer.from(String(offset + first)).toString('base64url') : null, has_next_page: next, has_previous_page: offset > 0, start_cursor: null } } };
  }

  // ── ad campaigns ──
  if (path === '/ad_campaigns' && method === 'POST') {
    if (!ctx.need(['ad_campaign:create'])) return undefined;
    const title = str(body.title) ?? bad('title is required');
    if (body.platform !== 'meta') bad('platform must be meta');
    if (!OBJECTIVES.includes(String(body.objective))) bad(`objective must be one of: ${OBJECTIVES.join(', ')}`);
    const optimization = body.budget_optimization === 'ad_campaign' ? 'ad_campaign' : 'ad_group';
    const amount = num(body.budget_amount);
    if (optimization === 'ad_campaign' && amount === undefined) bad('budget_amount is required');
    if (optimization === 'ad_group' && amount !== undefined) bad("budget_amount can't be set on the campaign unless budget_optimization is ad_campaign");
    const c: MockCampaign = { id: rid('adcamp', 11), title: title as string, status: 'draft', delivery_status: 'draft', platform: 'meta', objective: String(body.objective), budget_amount: amount ?? null, budget_type: str(body.budget_type) ?? 'daily', budget_optimization: optimization, issues: [], created_at: now(), updated_at: now() };
    ads.campaigns.set(c.id, c);
    return { status: 200, body: campaignView(c) };
  }
  const campMatch = /^\/ad_campaigns\/([^/]+)(?:\/(pause|unpause))?$/.exec(path);
  if (campMatch) {
    const campaign = ads.campaigns.get(decodeURIComponent(campMatch[1]!)) ?? notFound('Ad campaign');
    const c = campaign as MockCampaign;
    const action = campMatch[2];
    if (method === 'GET' && !action) {
      if (!ctx.need(['ad_campaign:basic:read'])) return undefined;
      return { status: 200, body: campaignView(c) };
    }
    if (method === 'PATCH' && !action) {
      if (!ctx.need(['ad_campaign:update'])) return undefined;
      if (body.status === 'active') {
        if (c.status !== 'draft') bad('Only a draft campaign can be launched.');
        const gate = launchGateError(ctx, c);
        if (gate) bad(gate);
        c.status = 'active';
        setDelivery(ads, c, 'processing');
      }
      if (typeof body.title === 'string') c.title = body.title;
      if (num(body.budget_amount) !== undefined) c.budget_amount = num(body.budget_amount)!;
      c.updated_at = now();
      return { status: 200, body: campaignView(c) };
    }
    if (method === 'POST' && action === 'pause') {
      if (!ctx.need(['ad_campaign:update'])) return undefined;
      if (c.status !== 'active') bad('Only an active ad campaign can be paused.');
      c.status = 'paused';
      setDelivery(ads, c, 'paused');
      return { status: 200, body: campaignView(c) };
    }
    if (method === 'POST' && action === 'unpause') {
      if (!ctx.need(['ad_campaign:update'])) return undefined;
      if (c.status !== 'paused') bad('Only a paused ad campaign can be resumed.');
      if (!(biz.payment as { primary?: unknown } | null)?.primary) bad('Connect an ads payment method before launching');
      c.status = 'active';
      setDelivery(ads, c, 'active');
      return { status: 200, body: campaignView(c) };
    }
    if (method === 'DELETE' && !action) {
      if (!ctx.need(['ad_campaign:update'])) return undefined;
      for (const g of [...ads.groups.values()].filter((g) => g.ad_campaign.id === c.id)) ads.groups.delete(g.id);
      for (const a of [...ads.ads.values()].filter((a) => a.ad_campaign.id === c.id)) ads.ads.delete(a.id);
      ads.campaigns.delete(c.id);
      return { status: 200, body: { id: c.id, deleted: true } };
    }
  }

  // ── ad groups ──
  if (path === '/ad_groups' && method === 'POST') {
    if (!ctx.need(['ad_campaign:create'])) return undefined;
    const campaign = (ads.campaigns.get(str(body.ad_campaign_id) ?? '') ?? notFound('Ad campaign')) as MockCampaign;
    const title = str(body.title) ?? bad('title is required');
    checkBudget('ad_group', campaign, num(body.budget_amount));
    const g: MockGroup = { id: rid('adgrp', 12), title: title as string, status: str(body.status) ?? 'active', delivery_status: 'draft', conversion_event: str(body.conversion_event) ?? null, budget_amount: num(body.budget_amount) ?? null, budget_type: str(body.budget_type) ?? 'daily', ad_campaign: { id: campaign.id }, issues: [], body: { ...body } };
    ads.groups.set(g.id, g);
    return { status: 200, body: groupView(g) };
  }
  const groupMatch = /^\/ad_groups\/([^/]+)(?:\/(pause|unpause))?$/.exec(path);
  if (groupMatch) {
    const g = (ads.groups.get(decodeURIComponent(groupMatch[1]!)) ?? notFound('Ad group')) as MockGroup;
    const action = groupMatch[2];
    if (method === 'GET' && !action) {
      if (!ctx.need(['ad_campaign:basic:read'])) return undefined;
      return { status: 200, body: groupView(g) };
    }
    if (!ctx.need(['ad_campaign:update'])) return undefined;
    if (method === 'PATCH' && !action) {
      if (num(body.budget_amount) !== undefined) g.budget_amount = num(body.budget_amount)!;
      if (typeof body.title === 'string') g.title = body.title;
      g.body = { ...g.body, ...body };
      return { status: 200, body: groupView(g) };
    }
    if (method === 'POST' && action) {
      g.status = action === 'pause' ? 'paused' : 'active';
      if (g.delivery_status !== 'draft') g.delivery_status = action === 'pause' ? 'paused' : 'active';
      return { status: 200, body: groupView(g) };
    }
    if (method === 'DELETE' && !action) {
      for (const a of [...ads.ads.values()].filter((a) => a.ad_group.id === g.id)) ads.ads.delete(a.id);
      ads.groups.delete(g.id);
      return { status: 200, body: { id: g.id, deleted: true } };
    }
  }

  // ── ads ──
  if (path === '/ads' && method === 'POST') {
    if (!ctx.need(['ad_campaign:create'])) return undefined;
    const group = (ads.groups.get(str(body.ad_group_id) ?? '') ?? notFound('Ad group')) as MockGroup;
    const title = str(body.title) ?? bad('title is required');
    const url = str(body.url) ?? bad('A destination URL is required');
    const params = (body.url_parameters ?? {}) as Record<string, string>;
    const reserved = Object.keys(params).filter((k) => RESERVED.includes(k.toLowerCase()));
    if (reserved.length) bad(`url_parameters cannot include reserved parameter(s): ${reserved.join(', ')}`);
    const copy = (v: unknown, name: string): { text: string }[] => {
      if (!Array.isArray(v) || v.length === 0) return bad(`${name} is required`) as never;
      return v.map((x) => ({ text: String((x as { text?: unknown })?.text ?? '') }));
    };
    const headlines = copy(body.headlines, 'headlines');
    const primary = copy(body.primary_texts, 'primary_texts');
    // The pixel check: Whop loads the URL (following redirects) and reads the final page. A whop.com page needs none.
    const seen = await ctx.inspect(url as string);
    if (!seen.installed) bad(`The Whop pixel was not detected on ${url}. Install it on the destination so conversions can be tracked: https://docs.whop.com/developer/ads/pixel`);
    const creatives = attachCreatives(ads, body.creatives);
    const pages = attachPages(biz, body.social_accounts);
    const a: MockAd = { id: rid('ad', 15), title: title as string, status: 'active', delivery_status: 'draft', url: url as string, url_parameters: params, headlines, primary_texts: primary, descriptions: Array.isArray(body.descriptions) ? body.descriptions.map((x) => ({ text: String((x as { text?: unknown })?.text ?? '') })) : [], call_to_action: str(body.call_to_action) ?? null, creatives, social_accounts: pages, ad_group: { id: group.id }, ad_campaign: { id: group.ad_campaign.id }, issues: [] };
    ads.ads.set(a.id, a);
    return { status: 200, body: a };
  }
  const adMatch = /^\/ads\/([^/]+)(?:\/(pause|unpause))?$/.exec(path);
  if (adMatch) {
    const a = (ads.ads.get(decodeURIComponent(adMatch[1]!)) ?? notFound('Ad')) as MockAd;
    const action = adMatch[2];
    if (method === 'GET' && !action) {
      if (!ctx.need(['ad_campaign:basic:read'])) return undefined;
      return { status: 200, body: a };
    }
    if (!ctx.need(['ad_campaign:update'])) return undefined;
    if (method === 'PATCH' && !action) {
      if (body.creatives !== undefined) a.creatives = attachCreatives(ads, body.creatives);
      if (body.social_accounts !== undefined) a.social_accounts = attachPages(biz, body.social_accounts);
      if (typeof body.title === 'string') a.title = body.title;
      if (typeof body.url === 'string') {
        const seen = await ctx.inspect(body.url);
        if (!seen.installed) bad(`The Whop pixel was not detected on ${body.url}. Install it on the destination so conversions can be tracked: https://docs.whop.com/developer/ads/pixel`);
        a.url = body.url;
      }
      for (const k of ['headlines', 'primary_texts', 'descriptions'] as const) if (Array.isArray(body[k])) a[k] = (body[k] as { text?: unknown }[]).map((x) => ({ text: String(x?.text ?? '') }));
      return { status: 200, body: a };
    }
    if (method === 'POST' && action) {
      a.status = action === 'pause' ? 'paused' : 'active';
      if (a.delivery_status !== 'draft') a.delivery_status = action === 'pause' ? 'paused' : 'active';
      return { status: 200, body: a };
    }
    if (method === 'DELETE' && !action) {
      ads.ads.delete(a.id);
      return { status: 200, body: { id: a.id, deleted: true } };
    }
  }
  return undefined;
}

function publicFile(f: MockFile) {
  return { id: f.id, filename: f.filename, content_type: f.content_type, size: f.size, url: f.url, upload_status: f.upload_status, created_at: now() };
}
function campaignView(c: MockCampaign) {
  return { ...c, budget_currency: 'usd', clicks: 0, impressions: 0, spend: 0, results: null, result_event: null };
}
function groupView(g: MockGroup) {
  return { id: g.id, title: g.title, platform: 'meta', status: g.status, delivery_status: g.delivery_status, conversion_event: g.conversion_event, budget_amount: g.budget_amount, budget_type: g.budget_type, ad_campaign: g.ad_campaign, issues: g.issues, clicks: 0, impressions: 0, spend: 0 };
}
function attachCreatives(ads: MockAdsState, raw: unknown): MockAd['creatives'] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return bad('creatives must be a list');
  return raw.map((c) => {
    const id = String((c as { id?: unknown })?.id ?? '');
    const file = ads.files.get(id);
    if (!file) return bad(`Unknown creative file ${id}`);
    if (file!.upload_status !== 'ready') return bad(`The creative file ${id} is not ready yet.`);
    return { id, format: ((c as { format?: string }).format ?? null) as string | null, url: file!.url, media_type: file!.content_type.startsWith('video') ? 'video' : 'image' };
  });
}
function attachPages(biz: AdsContext['biz'], raw: unknown): { id: string }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return bad('social_accounts must be a list');
  return raw.map((p) => {
    const id = String((p as { id?: unknown })?.id ?? '');
    const page = biz.pages.find((x) => x.id === id);
    if (!page) return bad(`Unknown social account ${id}`);
    if (page!.error) return bad(`The page ${id} cannot be used for ads right now: ${page!.error}`);
    return { id };
  });
}
function setDelivery(ads: MockAdsState, c: MockCampaign, delivery: string): void {
  c.delivery_status = delivery;
  for (const g of ads.groups.values()) if (g.ad_campaign.id === c.id) g.delivery_status = delivery;
  for (const a of ads.ads.values()) if (a.ad_campaign.id === c.id) a.delivery_status = delivery;
}

/** Test hook: move a launched campaign (and its groups and ads) to a delivery state, as Whop / Meta would later. */
export function settleCampaign(ads: MockAdsState, campaignId: string, state: { delivery_status: string; status?: string; issues?: { message: string; resource_type?: WhopIssue['resource_type'] }[] }): void {
  const c = ads.campaigns.get(campaignId);
  if (!c) throw new Error(`mock: no campaign ${campaignId}`);
  if (state.status) c.status = state.status;
  setDelivery(ads, c, state.delivery_status);
  const issues: WhopIssue[] = (state.issues ?? []).map((i) => ({ id: rid('issue', 10), message: i.message, resource_id: campaignId, resource_type: i.resource_type ?? 'ad_campaign' }));
  c.issues = issues;
  for (const a of ads.ads.values()) if (a.ad_campaign.id === campaignId) a.issues = issues.map((i) => ({ ...i, resource_type: 'ad', resource_id: a.id }));
}
