/**
 * Manual conformance check: replay the launch flow against Whop's real SANDBOX and compare what Whop answers
 * with what `src/testing/mock-ads.ts` assumes. The mock is only as good as its last comparison with the real
 * thing, so run this when Whop ships an API version, or before trusting a launch change:
 *
 *   pnpm --filter @knn/whop sandbox-check
 *
 * It reads `~/whop-sandbox.env` (WHOP_SANDBOX_API_KEY, WHOP_SANDBOX_BIZ_ID; mode 600, outside the repo) and
 * never prints the key. It talks ONLY to the sandbox host, creates a few clearly named draft objects ("KNN
 * conformance …") and deletes them again. It never launches anything: the sandbox business has no payment
 * method, and a launch is exactly what must be refused. Not part of CI (no key there).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { WHOP_API_BASES } from '@knn/shared';
import { createWhopClient, isWhopError, whopAdsApi } from '../src/index.js';

const env = Object.fromEntries(
  readFileSync(join(homedir(), 'whop-sandbox.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const key = env.WHOP_SANDBOX_API_KEY;
const biz = env.WHOP_SANDBOX_BIZ_ID;
if (!key || !biz) throw new Error('~/whop-sandbox.env must define WHOP_SANDBOX_API_KEY and WHOP_SANDBOX_BIZ_ID');

const api = whopAdsApi(createWhopClient({ apiKey: key, baseUrl: WHOP_API_BASES.SANDBOX }));
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  → ${detail}` : ''}`);
};
const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return '(no error)';
  } catch (err) {
    return isWhopError(err) ? err.message : String(err);
  }
};

// A tiny valid 1080x1080 PNG, generated here so no real creative is ever sent to a third party.
function png(): Uint8Array {
  const W = 1080;
  const row = Buffer.alloc(1 + W * 3);
  const raw = Buffer.concat(Array.from({ length: W }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const tag = `KNN conformance ${new Date().toISOString().slice(0, 16)}`;
let campaignId: string | undefined;
let deleted = false;
try {
  const file = await api.uploadCreative({ filename: 'knn-conformance.png', bytes: png() });
  check('a creative uploads and becomes ready', file.upload_status === 'ready' && (file.size ?? 0) > 0);

  const campaign = await api.createCampaign({ account_id: biz, title: tag, platform: 'meta', objective: 'leads', idempotencyKey: `${tag}:c` });
  campaignId = campaign.id;
  check('a standalone campaign is a draft', campaign.status === 'draft' && campaign.delivery_status === 'draft', `${campaign.status}/${campaign.delivery_status}`);
  const replay = await api.createCampaign({ account_id: biz, title: tag, platform: 'meta', objective: 'leads', idempotencyKey: `${tag}:c` });
  check('the same Idempotency-Key replays the same campaign', replay.id === campaign.id);

  const group = await api.createAdGroup({ ad_campaign_id: campaign.id, title: tag, budget_amount: 5, conversion_location: 'website', conversion_event: 'submit_application', optimization_goal: 'conversions', idempotencyKey: `${tag}:g` });
  check('an ad group starts active but is not delivering (draft)', group.status === 'active' && group.delivery_status === 'draft');
  check('the ad group\'s conversion event is kept', group.conversion_event === 'submit_application');

  const pixelGate = await refusal(() => api.createAd({ ad_group_id: group.id, title: tag, url: 'https://example.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] }));
  check('an ad on a page without the pixel is refused, with Whop\'s words', pixelGate.startsWith('The Whop pixel was not detected on https://example.com/'), pixelGate);

  const ad = await api.createAd({ ad_group_id: group.id, title: tag, url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], call_to_action: 'learn_more', idempotencyKey: `${tag}:a` });
  check('a whop.com destination needs no pixel', ad.url === 'https://whop.com/');

  const reserved = await refusal(() => api.createAd({ ad_group_id: group.id, title: tag, url: 'https://whop.com/', url_parameters: { waid: 'x' }, headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }] }));
  check('Whop\'s own click parameters are refused in url_parameters', reserved !== '(no error)', reserved);

  const noCreative = await refusal(() => api.launchCampaign(campaign.id));
  check('launch gate 1: a creative on every ad', noCreative.startsWith('Add a creative to these ads before launching'), noCreative);
  await api.updateAd(ad.id, { creatives: [{ id: file.id }] });
  const noPage = await refusal(() => api.launchCampaign(campaign.id));
  check('launch gate 2: a Facebook page', noPage.startsWith('Connect a Facebook page to launch these ads'), noPage);
  // Gates after the page (payment method, agreement) cannot be reached without a page on the sandbox business.
  console.log('NOTE  the payment-method and agreement gate texts are unverified (they need a page on the business)');

  const got = await api.getCampaign(campaign.id, { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), timeZone: 'Asia/Kolkata' });
  check('a stats window with a time zone is accepted', got.id === campaign.id);
} finally {
  if (campaignId) {
    await api
      .deleteCampaign(campaignId)
      .then(() => {
        deleted = true;
        console.log('cleaned up the test campaign');
      })
      .catch((e: unknown) => console.log('WARN  could not delete the test campaign:', e instanceof Error ? e.message : e));
  }
}
if (campaignId && deleted) {
  // The status sync archives a campaign only after TWO consecutive direct reads that say "not found", and it asks for that
  // read only for a campaign missing from the list. Both rest on what Whop answers for a deleted campaign.
  const readBack = await api.getCampaign(campaignId).then(
    (c) => `still readable as ${c.status}/${c.delivery_status}`,
    (e: unknown) => (isWhopError(e) ? e.kind : String(e)),
  );
  check('a deleted campaign reads as not_found (what the status sync archives on, twice in a row)', readBack === 'not_found', readBack);
  const stillListed = (await api.listCampaigns({ accountId: biz })).some((c) => c.id === campaignId);
  check('a deleted campaign is gone from the campaign list too', !stillListed);
}
console.log(failures ? `\n${failures} check(s) FAILED: the mock no longer matches Whop.` : '\nThe mock still matches the real sandbox on everything checked.');
process.exit(failures ? 1 : 0);
