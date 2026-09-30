/**
 * Whop Ads — definitions shared by the API, the Whop client package and the dashboard.
 *
 * Whop Ads is a second ad provider next to the direct Facebook connection (D32). Whop owns the Meta
 * ad account; we talk to Whop's REST API with an Account API key + the `biz_` business id.
 */

import { FUNNEL_EVENT_NAME, FUNNEL_STAGES, MAIN_CONVERSION_STAGE, type FunnelStage } from './conversions.js';

export const WHOP_ENVIRONMENTS = ['PRODUCTION', 'SANDBOX'] as const;
export type WhopEnvironment = (typeof WHOP_ENVIRONMENTS)[number];

/** Whop's public API roots (the sandbox has its own accounts, keys and data). */
export const WHOP_API_BASES: Readonly<Record<WhopEnvironment, string>> = {
  PRODUCTION: 'https://api.whop.com/api/v1',
  SANDBOX: 'https://sandbox-api.whop.com/api/v1',
};

/** The Whop dashboard per environment — where the account owner does the steps only they can do. */
export const WHOP_DASHBOARDS: Readonly<Record<WhopEnvironment, string>> = {
  PRODUCTION: 'https://whop.com',
  SANDBOX: 'https://sandbox.whop.com',
};

/** Whop account ("business") ids look like `biz_` + alphanumerics. */
export const WHOP_BIZ_ID_RE = /^biz_[A-Za-z0-9]{6,40}$/;
export function isWhopBizId(value: string): boolean {
  return WHOP_BIZ_ID_RE.test(value);
}

export interface WhopPermission {
  /** The permission string as it appears on Whop's API-key screen. */
  action: string;
  /** What we use it for, in words a buyer can follow. */
  purpose: string;
}

/**
 * Permissions the user ticks when creating the Account API key. Whop has no call that lists what a key
 * can do, so the connect check probes the read ones and reports the write ones as "unverified" until
 * first use (the error then names the missing permission).
 */
export const WHOP_REQUIRED_PERMISSIONS: readonly WhopPermission[] = [
  { action: 'ad_campaign:basic:read', purpose: 'Read campaigns, ad groups, ads and their stats' },
  { action: 'ad_campaign:create', purpose: 'Create campaigns, ad groups and ads' },
  { action: 'ad_campaign:update', purpose: 'Activate, pause, change budgets, retry a failed payment' },
  { action: 'social_account:read', purpose: 'List the Facebook page the ads run under' },
  { action: 'social_account:create', purpose: 'Connect Meta Business or create a Whop-managed page' },
  { action: 'event:create', purpose: 'Send conversion events from our server' },
  { action: 'company:basic:read', purpose: 'Check the Whop pixel and read events' },
];

export const WHOP_OPTIONAL_PERMISSIONS: readonly WhopPermission[] = [
  { action: 'developer:manage_webhook', purpose: 'Register status webhooks automatically (otherwise we poll)' },
  { action: 'company:balance:read', purpose: 'Confirm the key belongs to this business and show its name' },
];

/** One line on the connection checklist. */
export type WhopChecklistStatus = 'ok' | 'todo' | 'warn' | 'unknown' | 'error';

export type WhopChecklistKey =
  | 'credentials'
  | 'permissions'
  | 'agreement'
  | 'payment'
  | 'currency'
  | 'page'
  | 'pixel';

export type WhopChecklistActionKind = 'recheck' | 'open_whop' | 'connect_meta' | 'create_page' | 'refresh_page';

export interface WhopChecklistAction {
  kind: WhopChecklistActionKind;
  label: string;
  /** For `open_whop`: the Whop screen to open. */
  url?: string;
}

export interface WhopChecklistItem {
  key: WhopChecklistKey;
  label: string;
  status: WhopChecklistStatus;
  /** A plain-language sentence: what we found, or exactly what to fix. */
  detail?: string;
  /** Fix buttons, most useful first. */
  actions?: WhopChecklistAction[];
}

export interface WhopChecklist {
  checkedAt: string;
  items: WhopChecklistItem[];
  /** The key works and can read what we need: enough to build campaigns as drafts. */
  canDraft: boolean;
  /** Every launch gate is green: agreement, payment, page and pixel as well. */
  canLaunch: boolean;
}

// ── Tracking: funnel events and Whop's click parameters ─────────────────────────────────────────────

/** The three Whop standard events our funnel reports, shallow → deep. */
export type WhopFunnelEvent = 'view_content' | 'add_to_cart' | 'submit_application';

/**
 * Funnel stage → Whop event. The same three-step shape as Facebook's ViewContent / AddToCart / Search, and
 * the mapping ClickFlare runs live for Whop: Page Visit → View Content, Click Button → Add to Cart,
 * Search → Submit Application. `submit_application` (the real ad click, the money event) is what an ad
 * group optimizes toward: its `conversion_event` becomes the campaign's `result_event`.
 */
export const WHOP_EVENT_FOR_STAGE: Readonly<Record<FunnelStage, WhopFunnelEvent>> = {
  lander: 'view_content',
  search: 'add_to_cart',
  adclick: 'submit_application',
};

/** The event a Whop ad group optimizes for by default: the money event. */
export const WHOP_MAIN_CONVERSION_EVENT: WhopFunnelEvent = WHOP_EVENT_FOR_STAGE[MAIN_CONVERSION_STAGE];

/**
 * A stored `conversion_events.event_name` (Facebook's names, which Analytics keys on) → the Whop event to
 * report. Undefined for a name that is not one of the funnel's.
 */
export function whopEventForStoredName(eventName: string): WhopFunnelEvent | undefined {
  const stage = FUNNEL_STAGES.find((s) => FUNNEL_EVENT_NAME[s] === eventName);
  return stage ? WHOP_EVENT_FOR_STAGE[stage] : undefined;
}

/** Whop's own id shapes (`adcamp_…` campaign, `adgrp_…` ad group, `ad_…` ad). */
const WHOP_CAMPAIGN_ID_RE = /^adcamp_[A-Za-z0-9]{6,40}$/;
const WHOP_AD_GROUP_ID_RE = /^adgrp_[A-Za-z0-9]{6,40}$/;
const WHOP_AD_ID_RE = /^ad_[A-Za-z0-9]{6,40}$/;
const META_ID_RE = /^[0-9]{6,30}$/;

/**
 * What Whop puts on the landing URL of a click on one of its ads. These names are reserved by Whop: an ad's
 * own parameters must never reuse them (Whop rejects them at ad creation).
 */
export const WHOP_RESERVED_CLICK_PARAMS = [
  'wacid',
  'wasid',
  'waid',
  'utm_whop',
  'utm_meta_ad_id',
  'utm_meta_adset_id',
  'utm_meta_campaign_id',
  'utm_source',
  'utm_placement',
  'utm_medium',
  'utm_content',
  'utm_adset',
  'tw_source',
  'tw_adid',
] as const;

export interface WhopClick {
  /** Whop's ids: `wacid`, `wasid`, `waid`. Whop resolves the ad from these, so they are what we report back. */
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  /** The network's ids as Whop forwards them. */
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaAdId?: string;
  /** The surface and placement the click came from (`fb`, `ig`, `msg`, `an` / `Facebook_Mobile_Feed`, ...). */
  utm: { source?: string; medium?: string; content?: string; adset?: string; placement?: string };
}

const clip = (v: string | null, max = 200): string | undefined => {
  if (!v) return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

/**
 * Read Whop's click parameters off a landing URL's query. Returns null unless the click is from a Whop ad
 * (it carries at least one valid Whop id, or `utm_whop`). Everything is validated and length-capped because
 * the result is stored and later sent back to Whop: a junk or hostile value is dropped, never passed on.
 * Pure string work, so it is safe at the edge.
 */
export function extractWhopClick(search: URLSearchParams | string): WhopClick | null {
  const q = typeof search === 'string' ? new URLSearchParams(search.replace(/^\?/, '')) : search;
  const campaignId = WHOP_CAMPAIGN_ID_RE.test(q.get('wacid') ?? '') ? q.get('wacid')! : undefined;
  const adGroupId = WHOP_AD_GROUP_ID_RE.test(q.get('wasid') ?? '') ? q.get('wasid')! : undefined;
  const adId = WHOP_AD_ID_RE.test(q.get('waid') ?? '') ? q.get('waid')! : undefined;
  const flagged = (q.get('utm_whop') ?? '').toLowerCase() === 'true';
  if (!campaignId && !adGroupId && !adId && !flagged) return null;
  const meta = (name: string): string | undefined => (META_ID_RE.test(q.get(name) ?? '') ? q.get(name)! : undefined);
  return {
    campaignId,
    adGroupId,
    adId,
    metaCampaignId: meta('utm_meta_campaign_id'),
    metaAdSetId: meta('utm_meta_adset_id'),
    metaAdId: meta('utm_meta_ad_id'),
    utm: {
      source: clip(q.get('utm_source'), 40),
      medium: clip(q.get('utm_medium'), 40),
      content: clip(q.get('utm_content')),
      adset: clip(q.get('utm_adset')),
      placement: clip(q.get('utm_placement'), 60),
    },
  };
}
