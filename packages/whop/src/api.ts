import type { WhopClient } from './client.js';

/** The slice of Whop's API that the connect flow uses. Phase 2+ adds campaigns, ad groups, ads, files and events. */

export interface WhopPageInfo {
  end_cursor: string | null;
  has_next_page: boolean;
  has_previous_page?: boolean;
  start_cursor?: string | null;
}

export interface WhopList<T> {
  data: T[];
  page_info: WhopPageInfo;
}

export interface WhopAccount {
  id: string;
  title: string | null;
  route?: string | null;
  status?: string | null;
}

export interface WhopPaymentMethod {
  type: 'platform_balance' | 'card';
  id: string;
  card_brand?: string | null;
  last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
  title?: string | null;
}

export interface WhopAccountPreferences {
  ads_agreement: {
    status: 'not_required' | 'pending_signature' | 'signed';
    accepted_at?: string | null;
    agreement_version?: string | null;
    printed_name?: string | null;
  };
  /** null until ads billing has been configured. */
  ads_payment_methods: { primary: WhopPaymentMethod | null; backup: WhopPaymentMethod | null } | null;
  ads_reporting_currency: string;
  ads_scheduling_timezone: string;
}

export interface WhopSocialAccount {
  id: string;
  platform: string;
  name: string | null;
  username: string | null;
  external_id: string | null;
  url: string | null;
  verified: boolean;
  /** Why this account can't currently be used for advertising. Null when healthy. */
  error: string | null;
  profile_picture_url?: string | null;
  scopes?: string[];
  partnership_status?: string | null;
}

export interface WhopPixelValidation {
  /**
   * Without a `url`: the account has sent pixel events recently. With a `url`: THAT page has (recent
   * events from it, or the pixel found in its fetched source, following redirects), or it is hosted on
   * Whop. Events the account sent from other pages never make a given `url` installed.
   */
  installed: boolean;
  /** Days since the pixel last sent an event, within a 30-day window. */
  last_seen_days: number | null;
  last_fired_days?: Record<string, number>;
  /** True when the URL is hosted on Whop, so no snippet is needed. */
  native_tracking?: boolean;
  /** False when Whop could not load the page. Null when no URL was sent. */
  reachable?: boolean | null;
  url?: string | null;
  firing_data_ok?: boolean;
  /** Conversion events wired on the page (from its recent events or its source). */
  page_events?: string[];
  /** Conversion events seen recently anywhere on the page's host or its final redirect host. */
  host_events?: string[];
}

/** Whop's eight standard events. Anything else is a custom event under that name. */
export const WHOP_STANDARD_EVENTS = [
  'lead',
  'schedule',
  'submit_application',
  'contact',
  'complete_registration',
  'view_content',
  'add_to_cart',
  'purchase',
] as const;
export type WhopStandardEvent = (typeof WHOP_STANDARD_EVENTS)[number];

export type WhopActionSource = 'website' | 'app' | 'email' | 'phone_call' | 'chat' | 'physical_store' | 'system_generated' | 'business_messaging' | 'other';

/** Attribution context of a server event. Whop resolves the ad from these, so send every one you have. */
export interface WhopEventContext {
  /** Whop's own ids from the landing URL: `wacid`, `wasid`, `waid`. */
  ad_campaign_id?: string | null;
  ad_set_id?: string | null;
  ad_id?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  language?: string | null;
  timezone?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  utm_id?: string | null;
}

export interface WhopEventUser {
  /** The pixel's `_wuid` visitor id. Optional: Whop also resolves the ad from the URL ids, IP and user agent. */
  anonymous_id?: string | null;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  external_id?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
}

export interface WhopEventInput {
  account_id: string;
  event_name: WhopStandardEvent | (string & {});
  /** One per real action. Whop keeps a single copy of each `event_name` + `event_id` pair. */
  event_id?: string;
  /** ISO 8601. Whop rejects anything older than 28 days and clamps the future to now. */
  event_time?: string;
  action_source?: WhopActionSource;
  /** The page the visitor was on when the action started, INCLUDING its query string. */
  url?: string;
  referrer_url?: string;
  title?: string;
  /** `purchase` requires a value above zero. */
  value?: number;
  /** Lowercase ISO 4217, e.g. `usd`. */
  currency?: string;
  context?: WhopEventContext;
  user?: WhopEventUser;
}

/** An event as Whop lists it back. Only the fields we read are typed. */
export interface WhopStoredEvent {
  id: string;
  event_id: string;
  event_name: string;
  event_time: string;
  person_id: string;
  url?: string | null;
  context?: { ad_click_id?: string | null; ad_click_type?: string | null; source_type?: string | null; ad_id?: string | null; ad_campaign_id?: string | null; ad_set_id?: string | null } | null;
  related?: { ad?: { id: string } | null; ad_campaign?: { id: string } | null; ad_group?: { id: string } | null } | null;
}

export interface WhopAdCampaignBrief {
  id: string;
  title: string;
  status: string;
  delivery_status: string;
}

/** Follow `page_info` cursors until the end (or `maxPages`). */
export async function listAllPages<T>(fetchPage: (after: string | undefined) => Promise<WhopList<T>>, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(after);
    out.push(...page.data);
    if (!page.page_info.has_next_page || !page.page_info.end_cursor) break;
    after = page.page_info.end_cursor;
  }
  return out;
}

export interface WhopApi {
  /** The account tied to the key. Needs `company:balance:read`. */
  accountMe(): Promise<WhopAccount>;
  /** Ads settings: agreement, payment methods, reporting currency. */
  preferences(accountId: string): Promise<WhopAccountPreferences>;
  listSocialAccounts(p: { accountId: string; platform?: string; first?: number; after?: string }): Promise<WhopList<WhopSocialAccount>>;
  /** Every social account of the business (paginated). */
  allSocialAccounts(accountId: string, platform?: string): Promise<WhopSocialAccount[]>;
  /** Starts Whop's Meta Business OAuth flow; returns where to send the user. */
  connectMetaBusiness(p: { accountId: string; redirectUrl: string; idempotencyKey?: string }): Promise<{ authorize_url: string }>;
  /** Creates (or returns) a Whop-managed Facebook page. The business needs a logo, banner and description. */
  createFacebookPage(p: { accountId: string; idempotencyKey?: string }): Promise<WhopSocialAccount>;
  refreshSocialAccount(p: { id: string; accountId: string; idempotencyKey?: string }): Promise<WhopSocialAccount>;
  /** A cheap read used to prove the key works for this business. */
  listAdCampaigns(p: { accountId: string; first?: number }): Promise<WhopList<WhopAdCampaignBrief>>;
  validatePixel(p: { accountId: string; url?: string }): Promise<WhopPixelValidation>;
  /**
   * Report a conversion from our server. Safe to retry: Whop stores each `event_name` + `event_id`
   * once, and answers a repeat with the same id. Returns the stored id (`<biz>:<event_id>`).
   */
  createEvent(input: WhopEventInput): Promise<{ id: string }>;
  /** Read events back (diagnostics). Needs a read permission such as `company:basic:read`. */
  listEvents(p: { accountId: string; identifier?: string; from?: string; to?: string; first?: number }): Promise<WhopList<WhopStoredEvent>>;
}

export function whopApi(client: WhopClient): WhopApi {
  return {
    accountMe: () => client.request<WhopAccount>({ method: 'GET', path: '/accounts/me' }),
    preferences: (accountId) => client.request<WhopAccountPreferences>({ method: 'GET', path: `/accounts/${encodeURIComponent(accountId)}/preferences` }),
    listSocialAccounts: (p) =>
      client.request<WhopList<WhopSocialAccount>>({
        method: 'GET',
        path: '/social_accounts',
        query: { account_id: p.accountId, platform: p.platform, first: p.first, after: p.after },
      }),
    allSocialAccounts: (accountId, platform) =>
      listAllPages((after) =>
        client.request<WhopList<WhopSocialAccount>>({
          method: 'GET',
          path: '/social_accounts',
          query: { account_id: accountId, platform, first: 100, after },
        }),
      ),
    connectMetaBusiness: (p) =>
      client.request<{ authorize_url: string }>({
        method: 'POST',
        path: '/social_accounts/connect',
        body: { account_id: p.accountId, platform: 'meta_business', scopes: ['advertise'], redirect_url: p.redirectUrl },
        idempotencyKey: p.idempotencyKey,
      }),
    createFacebookPage: (p) =>
      client.request<WhopSocialAccount>({
        method: 'POST',
        path: '/social_accounts',
        body: { account_id: p.accountId, platform: 'facebook' },
        idempotencyKey: p.idempotencyKey,
      }),
    refreshSocialAccount: (p) =>
      client.request<WhopSocialAccount>({
        method: 'POST',
        path: `/social_accounts/${encodeURIComponent(p.id)}/refresh`,
        body: { account_id: p.accountId },
        idempotencyKey: p.idempotencyKey,
      }),
    listAdCampaigns: (p) =>
      client.request<WhopList<WhopAdCampaignBrief>>({ method: 'GET', path: '/ad_campaigns', query: { account_id: p.accountId, first: p.first ?? 1 } }),
    validatePixel: (p) =>
      client.request<WhopPixelValidation>({ method: 'POST', path: '/events/validate_pixel', body: { account_id: p.accountId, ...(p.url ? { url: p.url } : {}) } }),
    createEvent: (input) =>
      client.request<{ id: string }>({ method: 'POST', path: '/events', body: input, naturallyIdempotent: Boolean(input.event_id) }),
    listEvents: (p) =>
      client.request<WhopList<WhopStoredEvent>>({
        method: 'GET',
        path: '/events',
        query: { account_id: p.accountId, identifier: p.identifier, from: p.from, to: p.to, first: p.first },
      }),
  };
}
