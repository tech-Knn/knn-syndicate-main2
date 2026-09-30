import { WHOP_DASHBOARDS, type WhopChecklist, type WhopChecklistItem, type WhopEnvironment } from '@knn/shared';
import type { WhopAccount, WhopAccountPreferences, WhopApi, WhopPixelValidation, WhopSocialAccount } from './api.js';
import { WhopApiError } from './errors.js';

/**
 * The connection checklist: what a Whop business still needs before campaigns can launch, each as one
 * line with a plain sentence and (where we can) a fix button. Built only from READ calls; write
 * permissions cannot be probed without side effects, so they are confirmed on first use.
 */

type Probe<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

const kindOf = (p: Probe<unknown>): string | null => (!p.ok && p.error instanceof WhopApiError ? p.error.kind : p.ok ? null : 'other');

function whopDown(p: Probe<unknown>): string {
  if (p.ok) return '';
  if (p.error instanceof WhopApiError) {
    if (p.error.kind === 'timeout' || p.error.kind === 'network') return 'Whop did not answer. Try again in a minute.';
    if (p.error.kind === 'rate_limited') return 'Whop is limiting requests right now. Try again in a minute.';
    if (p.error.kind === 'server') return 'Whop returned an error. Try again in a minute.';
    return p.error.message;
  }
  return 'Something went wrong while asking Whop.';
}

/**
 * What the credentials probe found, for callers that must react (mark a connection broken, or not):
 * `rejected` = 401, `no_access` = 403, `wrong_business` = the key belongs to another business,
 * `unreachable` = Whop did not answer (an outage is never the user's fault).
 */
export type WhopKeyStatus = 'ok' | 'rejected' | 'no_access' | 'wrong_business' | 'unreachable';

export interface WhopHealth {
  keyStatus: WhopKeyStatus;
  checklist: WhopChecklist;
  /** From the key's own account, when the key may read it. */
  accountTitle: string | null;
  reportingCurrency: string | null;
  /** The business's Facebook/Instagram social accounts as Whop reports them. */
  pages: WhopSocialAccount[];
  /** False when the pages could not be read, so callers must not treat an empty `pages` as "none". */
  pagesRead: boolean;
}

export async function runWhopHealthCheck(
  api: WhopApi,
  opts: { bizId: string; environment: WhopEnvironment; now?: () => Date },
): Promise<WhopHealth> {
  const { bizId, environment } = opts;
  const dashboard = WHOP_DASHBOARDS[environment];
  const openWhop = (path: string, label: string) => ({ kind: 'open_whop' as const, label, url: `${dashboard}${path}` });
  const items: WhopChecklistItem[] = [];
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  const empty: WhopHealth = { keyStatus: 'unreachable', checklist: { checkedAt, items, canDraft: false, canLaunch: false }, accountTitle: null, reportingCurrency: null, pages: [], pagesRead: false };

  // 1. Does the key work for this business? (also proves ad_campaign:basic:read)
  const campaigns = await probe(() => api.listAdCampaigns({ accountId: bizId, first: 1 }));
  if (!campaigns.ok) {
    const kind = kindOf(campaigns);
    if (kind === 'auth') {
      empty.keyStatus = 'rejected';
      items.push({ key: 'credentials', label: 'API key', status: 'error', detail: 'Whop rejected this API key. Check that it was copied completely and has not been deleted.', actions: [{ kind: 'recheck', label: 'Check again' }] });
    } else if (kind === 'permission') {
      empty.keyStatus = 'no_access';
      items.push({
        key: 'credentials',
        label: 'API key',
        status: 'error',
        detail: `Whop accepted the key but refused it for ${bizId}. Either the key belongs to another business, or it lacks the ad_campaign:basic:read permission.`,
        actions: [openWhop('/dashboard/developer', 'Open API keys in Whop'), { kind: 'recheck', label: 'Check again' }],
      });
    } else if (kind === 'not_found' || kind === 'validation') {
      empty.keyStatus = 'wrong_business';
      items.push({ key: 'credentials', label: 'API key', status: 'error', detail: `Whop does not recognise the business ${bizId}. Check the business ID.`, actions: [{ kind: 'recheck', label: 'Check again' }] });
    } else {
      items.push({ key: 'credentials', label: 'API key', status: 'unknown', detail: whopDown(campaigns), actions: [{ kind: 'recheck', label: 'Check again' }] });
    }
    return empty;
  }

  // Identity cross-check (optional: needs company:balance:read).
  let accountTitle: string | null = null;
  const me = await probe<WhopAccount>(() => api.accountMe());
  if (me.ok) {
    accountTitle = me.value.title ?? null;
    if (me.value.id && me.value.id !== bizId) {
      items.push({
        key: 'credentials',
        label: 'API key',
        status: 'error',
        detail: `This key belongs to ${me.value.id}${accountTitle ? ` (${accountTitle})` : ''}, not ${bizId}. Use that business ID or create a key in ${bizId}.`,
        actions: [{ kind: 'recheck', label: 'Check again' }],
      });
      return { ...empty, keyStatus: 'wrong_business', accountTitle };
    }
  }
  items.push({
    key: 'credentials',
    label: 'API key',
    status: 'ok',
    detail: accountTitle ? `Works for ${accountTitle} (${bizId}).` : `Works for ${bizId}.`,
  });

  // 2. Read the rest in parallel.
  const [social, prefs, pixel] = await Promise.all([
    probe<WhopSocialAccount[]>(() => api.allSocialAccounts(bizId)),
    probe<WhopAccountPreferences>(() => api.preferences(bizId)),
    probe<WhopPixelValidation>(() => api.validatePixel({ accountId: bizId })),
  ]);

  // Permissions: which read probes were refused, by permission name.
  const missing: string[] = [];
  if (kindOf(social) === 'permission') missing.push('social_account:read');
  if (kindOf(prefs) === 'permission') missing.push('ad_campaign:create');
  if (kindOf(pixel) === 'permission') missing.push('company:basic:read');
  items.push(
    missing.length
      ? {
          key: 'permissions',
          label: 'Key permissions',
          status: 'todo',
          detail: `Missing: ${missing.join(', ')}. In Whop, open the key under Developer → Account API Keys, tick them, then check again.`,
          actions: [openWhop('/dashboard/developer', 'Open API keys in Whop'), { kind: 'recheck', label: 'Check again' }],
        }
      : {
          key: 'permissions',
          label: 'Key permissions',
          status: 'ok',
          detail: 'Read access is confirmed. Create, update and event permissions are confirmed the first time they are used.',
        },
  );

  // 3. Ads agreement.
  if (prefs.ok) {
    const status = prefs.value.ads_agreement?.status;
    items.push(
      status === 'pending_signature'
        ? { key: 'agreement', label: 'Whop Ads agreement', status: 'todo', detail: 'The account owner must sign the Whop Ads agreement in Whop before any campaign can launch.', actions: [openWhop(`/dashboard/${bizId}/ads/sign-agreement/`, 'Sign the agreement in Whop'), { kind: 'recheck', label: 'Check again' }] }
        : { key: 'agreement', label: 'Whop Ads agreement', status: 'ok', detail: status === 'signed' ? 'Signed.' : 'No signature needed.' },
    );

    // 4. Payment method.
    const primary = prefs.value.ads_payment_methods?.primary ?? null;
    if (!primary) {
      items.push({ key: 'payment', label: 'Payment method', status: 'todo', detail: 'Add a payment method (Whop balance or a card) in Whop. Launching needs it.', actions: [openWhop(`/dashboard/${bizId}`, 'Open Whop dashboard'), { kind: 'recheck', label: 'Check again' }] });
    } else {
      const label = primary.type === 'card' ? `${(primary.card_brand ?? 'Card').toString().replace(/^./, (c) => c.toUpperCase())} ending ${primary.last4 ?? '••••'}` : `Whop balance${primary.title ? ` (${primary.title})` : ''}`;
      items.push({ key: 'payment', label: 'Payment method', status: 'ok', detail: `Pays with ${label}.` });
    }

    // 5. Reporting currency.
    const currency = (prefs.value.ads_reporting_currency ?? 'usd').toLowerCase();
    items.push(
      currency === 'usd'
        ? { key: 'currency', label: 'Reporting currency', status: 'ok', detail: 'USD.' }
        : { key: 'currency', label: 'Reporting currency', status: 'warn', detail: `Whop reports spend in ${currency.toUpperCase()}. We convert it to USD with our exchange rates, so small differences from Whop's own screens are normal.` },
    );
  } else {
    const detail = kindOf(prefs) === 'permission' ? 'Could not read the ads settings (needs the ad_campaign:create permission).' : whopDown(prefs);
    items.push({ key: 'agreement', label: 'Whop Ads agreement', status: 'unknown', detail });
    items.push({ key: 'payment', label: 'Payment method', status: 'unknown', detail });
  }

  // 6. Facebook page.
  const pages = social.ok ? social.value.filter((s) => s.platform === 'facebook' || s.platform === 'instagram') : [];
  if (social.ok) {
    const fb = pages.filter((p) => p.platform === 'facebook');
    const healthy = fb.find((p) => !p.error);
    if (healthy) {
      items.push({ key: 'page', label: 'Facebook page', status: 'ok', detail: `Ads will run under ${healthy.name ?? healthy.username ?? 'your page'}.` });
    } else if (fb.length > 0) {
      const broken = fb[0]!;
      items.push({
        key: 'page',
        label: 'Facebook page',
        status: 'warn',
        detail: `${broken.name ?? 'Your page'} cannot be used for ads right now: ${broken.error}`,
        actions: [{ kind: 'refresh_page', label: 'Refresh page state' }, { kind: 'connect_meta', label: 'Connect Meta Business' }],
      });
    } else {
      items.push({
        key: 'page',
        label: 'Facebook page',
        status: 'todo',
        detail: 'Ads need a Facebook page. Connect your Meta Business, or let Whop create a page (the business needs a logo, banner and description set in Whop first).',
        actions: [{ kind: 'connect_meta', label: 'Connect Meta Business' }, { kind: 'create_page', label: 'Create a Whop-managed page' }],
      });
    }
  } else {
    items.push({ key: 'page', label: 'Facebook page', status: 'unknown', detail: kindOf(social) === 'permission' ? 'Could not read the pages (needs the social_account:read permission).' : whopDown(social) });
  }

  // 7. Whop pixel. Informational only: it never blocks a launch. The pixel lives on OUR landing page, not on anything
  //    Whop hosts, and Whop checks it per ad, on that ad's own URL, at the moment the ad is created (a launch runs the
  //    same check first, see `apps/api/.../whop-launch.service.ts`). The account-level "seen recently" answer is
  //    therefore always "not yet" before a first launch, which is expected, not something for the buyer to fix.
  if (pixel.ok) {
    const days = pixel.value.last_seen_days;
    items.push(
      pixel.value.installed
        ? { key: 'pixel', label: 'Whop pixel', status: 'ok', detail: days === null ? 'Installed.' : days === 0 ? 'Seen today.' : `Last seen ${days} day${days === 1 ? '' : 's'} ago.` }
        : { key: 'pixel', label: 'Whop pixel', status: 'unknown', detail: 'Not seen yet. That is expected before your first launch: Whop looks for its pixel on the page an ad links to, when the ad is created. To test a page now, paste its address into the pixel check below.' },
    );
  } else {
    items.push({ key: 'pixel', label: 'Whop pixel', status: 'unknown', detail: kindOf(pixel) === 'permission' ? 'Could not check the pixel (needs the company:basic:read permission).' : whopDown(pixel) });
  }

  const ok = (key: string): boolean => items.find((i) => i.key === key)?.status === 'ok';
  const canDraft = ok('credentials');
  const canLaunch = canDraft && ['permissions', 'agreement', 'payment', 'page'].every(ok);
  return {
    keyStatus: 'ok',
    checklist: { checkedAt, items, canDraft, canLaunch },
    accountTitle,
    reportingCurrency: prefs.ok ? (prefs.value.ads_reporting_currency ?? null) : null,
    pages,
    pagesRead: social.ok,
  };
}
