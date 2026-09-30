import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import type { RedirectConfigPayload } from '../../lib/kv-sync.js';
import type { AuthContext } from '../../middleware/authenticate.js';

/**
 * A rate-limited launch is RESUMABLE. Before, `createFbStructure` recorded the Facebook ids only at
 * the very end, so a rate limit MID-build left live objects on Facebook with no id recorded and the
 * BATCHED re-drive built a whole second structure. Now every id is recorded the moment its object
 * exists (`fb_pending_campaign_id`, `ad_sets.fb_ad_set_id`, `ads.fb_ad_id`), `fb_campaign_id` keeps
 * meaning "fully built", and the next attempt creates only what is missing.
 *
 * Real Postgres; Facebook is a scripted fake: every create returns a UNIQUE id, every Graph call is
 * counted, and the Nth call can be made to fail.
 */

// Mock the Facebook network calls; keep the real error classes (instanceof in launch).
vi.mock('@knn/fb', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@knn/fb')>();
  return {
    ...actual,
    decryptToken: vi.fn(() => 'tok'),
    hasLaunchApp: vi.fn(() => false),
    checkAssetAccess: vi.fn(async () => ({ missingAccountIds: [], missingPageIds: [], missingPixelIds: [], ok: true })),
    // The scripted implementations are installed per test (see `scriptFacebook`).
    createFbCampaign: vi.fn(),
    createFbAdSet: vi.fn(),
    uploadFbAdImage: vi.fn(),
    createFbAdCreative: vi.fn(),
    createFbAd: vi.fn(),
    updateFbCampaignStatus: vi.fn(async () => ({ success: true })),
  };
});
// `relaunchCampaign` takes no deps and would write to the real Cloudflare KV — never let a test reach the edge.
vi.mock('../../lib/kv-sync.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../../lib/kv-sync.js')>();
  return { ...actual, writeRedirectConfigs: vi.fn(async () => undefined) };
});

// Notifications are asserted, not logged.
vi.mock('../../lib/notify.js', () => ({ notify: vi.fn(async () => undefined) }));

const fb = await import('@knn/fb');
const kv = await import('../../lib/kv-sync.js');
const { notify } = await import('../../lib/notify.js');
const { launchCampaign, relaunchCampaign, reopenCampaignForEdit, testLaunchCampaign } = await import('./launch.service.js');
const { reopenCampaign } = await import('./campaigns.service.js');

const suffix = Date.now().toString(36);
const storageKey = `resume-${suffix}.png`;
const SETS = 2;
const ADS_PER_SET = 2;
/** Graph calls a clean launch makes: 1 campaign + per ad set (1 ad set + per ad: image, creative, ad). */
const GRAPH_CALLS = 1 + SETS * (1 + ADS_PER_SET * 3);

let orgId = '';
let buyerId = '';
let adAccountId = '';
let pageId = '';
let pixelId = '';
let channelRef = '';
let uploadId = '';
let articleId = '';

const auth = (): AuthContext => ({ userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });

type Entries = { redirectId: string; config: RedirectConfigPayload }[];
const deps = () => ({
  generateArticle: vi.fn(async () => ({ slug: 'unused' })),
  writeRedirectConfigs: vi.fn(async (_e: Entries): Promise<void> => {}),
});

// ── the scripted Facebook ─────────────────────────────────────────────────────────────────────────
interface Script {
  /** Kind of every counted Graph call, in order (1-based position = "the Nth Graph call"). */
  calls: string[];
  /** Only what Facebook actually CREATED (a failed call creates nothing). */
  created: { campaigns: string[]; adSets: string[]; ads: string[] };
  /** Make the Nth counted call throw `failWith()`. */
  failAt: number | null;
  failWith: () => Error;
  /** Runs at the start of every counted call, before it can fail. */
  beforeCall?: (kind: string, n: number) => Promise<void>;
}
let script: Script;

function scriptFacebook(): void {
  vi.clearAllMocks(); // call history only — a test's `mock.calls` must not include an earlier test's launches
  script = {
    calls: [],
    created: { campaigns: [], adSets: [], ads: [] },
    failAt: null,
    failWith: () => new fb.FbRateLimitError('rate limited', { code: 17 }),
  };
  const step = async (kind: string): Promise<void> => {
    const n = script.calls.push(kind);
    await script.beforeCall?.(kind, n);
    if (script.failAt === n) throw script.failWith();
  };
  vi.mocked(fb.createFbCampaign).mockImplementation(async () => {
    await step('campaign');
    const id = `fbcamp-${script.created.campaigns.length + 1}-${suffix}`;
    script.created.campaigns.push(id);
    return { id };
  });
  vi.mocked(fb.createFbAdSet).mockImplementation(async () => {
    await step('adset');
    const id = `fbadset-${script.created.adSets.length + 1}-${suffix}`;
    script.created.adSets.push(id);
    return { id };
  });
  vi.mocked(fb.uploadFbAdImage).mockImplementation(async () => {
    await step('image');
    return 'imghash';
  });
  vi.mocked(fb.createFbAdCreative).mockImplementation(async () => {
    await step('creative');
    return { id: `fbcreative-${script.calls.length}` };
  });
  vi.mocked(fb.createFbAd).mockImplementation(async () => {
    await step('ad');
    const id = `fbad-${script.created.ads.length + 1}-${suffix}`;
    script.created.ads.push(id);
    return { id };
  });
  vi.mocked(fb.updateFbCampaignStatus).mockReset().mockResolvedValue({ success: true });
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
/** A PROCESSING campaign with a channel + article, `sets` ad sets × `ads` ads (explicit createdAt → a fixed launch order). */
async function makeCampaign(opts: { sets?: number; ads?: number } = {}): Promise<string> {
  const sets = opts.sets ?? SETS;
  const adsPerSet = opts.ads ?? ADS_PER_SET;
  const tag = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `Resume ${tag}`,
        status: 'PROCESSING',
        keywords: ['health insurance'],
        racValue: 'health insurance',
        adAccountId,
        pageId,
        channelId: channelRef,
        articleId,
        adSets: {
          create: Array.from({ length: sets }, (_, s) => ({
            orgId,
            name: `Set ${s + 1}`,
            createdAt: new Date(t0 + s * 1_000),
            dailyBudgetCents: 5000,
            countries: ['US'],
            pixelId,
            ads: {
              create: Array.from({ length: adsPerSet }, (_, a) => ({
                orgId,
                name: `Ad ${s + 1}.${a + 1}`,
                createdAt: new Date(t0 + s * 1_000 + a * 10),
                headline: 'Save on Health',
                primaryText: 'Compare plans now.',
                uploadId,
                redirectId: `rs-${suffix}-${tag}-${s}${a}`,
              })),
            },
          })),
        },
      },
    }),
  );
  return c.id;
}

/** What the DB has recorded about the Facebook side of a campaign, in launch order. */
async function recorded(campaignId: string) {
  const c = await withSystem((tx) =>
    tx.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: {
        status: true,
        fbCampaignId: true,
        fbPendingCampaignId: true,
        redirectDomainHost: true,
        whiteDomainHost: true,
        adSets: { orderBy: { createdAt: 'asc' }, select: { fbAdSetId: true, ads: { orderBy: { createdAt: 'asc' }, select: { fbAdId: true } } } },
      },
    }),
  );
  return {
    ...c,
    adSetIds: c.adSets.map((s) => s.fbAdSetId).filter((x): x is string => x != null),
    adIds: c.adSets.flatMap((s) => s.ads.map((a) => a.fbAdId)).filter((x): x is string => x != null),
  };
}

/** Everything a launch left on Facebook is exactly what is recorded — nothing lost, nothing invented. */
function expectRecordedEqualsCreated(r: Awaited<ReturnType<typeof recorded>>, opts: { fbCampaignId: string | null }): void {
  expect(r.fbCampaignId).toBe(opts.fbCampaignId);
  expect(r.adSetIds).toEqual(script.created.adSets);
  expect(r.adIds).toEqual(script.created.ads);
}

/** Run `fn` with the org in CLOAKER mode and exactly these redirect (company-exclusive) + white hosts in the pools. */
async function withCloaker<T>(redirectHosts: string[], whiteHosts: string[], fn: () => Promise<T>): Promise<T> {
  await withSystem(async (tx) => {
    // Company-EXCLUSIVE redirect hosts, so the pool is exactly these (exclusive wins over shared).
    await tx.redirectDomain.createMany({ data: redirectHosts.map((host) => ({ host, mode: 'CLOAKER' as const, isActive: true, healthy: true, ownerOrgId: orgId })) });
    await tx.whiteDomain.createMany({ data: whiteHosts.map((host) => ({ host, isActive: true, healthy: true })) });
    await tx.organization.update({ where: { id: orgId }, data: { cloakingEnabled: true, defaultFunnelMode: 'CLOAKER' } });
  });
  try {
    return await fn();
  } finally {
    await withSystem(async (tx) => {
      await tx.redirectDomain.deleteMany({ where: { host: { in: redirectHosts } } });
      await tx.whiteDomain.deleteMany({ where: { host: { in: whiteHosts } } });
      await tx.organization.update({ where: { id: orgId }, data: { cloakingEnabled: false, defaultFunnelMode: 'NORMAL' } });
    });
  }
}

/** The link_data of every creative sent to Facebook this test, in order. */
function creativeLinkData(): { link: string; caption?: string }[] {
  return vi
    .mocked(fb.createFbAdCreative)
    .mock.calls.map((c) => (c[2] as unknown as { objectStorySpec: { link_data: { link: string; caption?: string } } }).objectStorySpec.link_data);
}

beforeAll(async () => {
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await writeFile(join(env.UPLOAD_DIR, storageKey), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'Resume Co', slug: `resume-${suffix}` } })).id;
    buyerId = (await tx.user.create({ data: { orgId, email: `resume-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    const conn = await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: 'fb-resume', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
    const acc = await tx.fbAdAccount.create({ data: { orgId, connectionId: conn.id, fbAccountId: 'act_r1', name: 'M', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } });
    adAccountId = acc.id;
    pageId = (await tx.fbPage.create({ data: { orgId, connectionId: conn.id, fbPageId: 'pg-resume', name: 'P' } })).id;
    pixelId = (await tx.fbPixel.create({ data: { orgId, adAccountId: acc.id, fbPixelId: 'px-resume', name: 'X' } })).id;
    channelRef = (await tx.channel.create({ data: { channelId: `ch-resume-${suffix}`, status: 'ASSIGNED' } })).id;
    uploadId = (await tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'c.png', mimeType: 'image/png', sizeBytes: 4, storageKey } })).id;
    articleId = (await tx.article.create({ data: { orgId, slug: `resume-art-${suffix}`, title: 'T', rawContent: 'r', compliantContent: 'c', status: 'READY' } })).id;
  });
});

beforeEach(() => {
  scriptFacebook();
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-resume-${suffix}` } } });
    await tx.redirectDomain.deleteMany({ where: { host: { contains: suffix } } });
    await tx.whiteDomain.deleteMany({ where: { host: { contains: suffix } } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('a rate-limited launch resumes instead of rebuilding', () => {
  // THE bug: throw FbRateLimitError at the Nth Graph call; the re-drive must not duplicate anything.
  // Sweeping N over EVERY call covers every seam: before the campaign, between objects, and in the
  // middle of an ad (image uploaded / creative made, ad not yet created).
  it.each(Array.from({ length: GRAPH_CALLS }, (_, i) => i + 1))(
    'rate limit at Graph call #%i → BATCHED, then a second launch creates NO duplicate campaign / ad set / ad',
    async (failAt) => {
      const campaignId = await makeCampaign();
      script.failAt = failAt;

      const first = await launchCampaign(auth(), campaignId, deps());
      expect(first).toEqual({ status: 'BATCHED' });

      // Parked, NOT claimed as launched — `fb_campaign_id` still means "fully built" — and everything
      // Facebook already has is on record.
      const mid = await recorded(campaignId);
      expect(mid.status).toBe('BATCHED');
      expect(mid.fbPendingCampaignId).toBe(script.created.campaigns[0] ?? null);
      expectRecordedEqualsCreated(mid, { fbCampaignId: null });

      const second = await launchCampaign(auth(), campaignId, deps());
      expect(second).toEqual({ status: 'ACTIVE', fbCampaignId: script.created.campaigns[0] });

      // Exactly ONE of each spend-relevant object was ever created; the re-drive built only the rest.
      expect(script.created.campaigns).toHaveLength(1);
      expect(script.created.adSets).toHaveLength(SETS);
      expect(script.created.ads).toHaveLength(SETS * ADS_PER_SET);
      const done = await recorded(campaignId);
      expect(done.status).toBe('ACTIVE');
      expect(done.fbPendingCampaignId).toBeNull();
      expectRecordedEqualsCreated(done, { fbCampaignId: script.created.campaigns[0]! });
      // The audit trail says whether this launch continued an interrupted build (call #1 left nothing to continue).
      const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: campaignId, action: 'campaign.launched' } }));
      expect(audit?.details).toMatchObject({ fbCampaignId: script.created.campaigns[0], resumed: failAt > 1 });
    },
  );

  it('the re-drive makes only the calls that are missing — nothing already on Facebook is touched again', async () => {
    const campaignId = await makeCampaign();
    // Call #9 = the second ad set. By then: campaign, ad set 1 and both of its ads exist.
    script.failAt = 9;
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
    expect(script.calls).toHaveLength(9);

    await launchCampaign(auth(), campaignId, deps());
    // No second campaign / ad set 1 / image / creative / ad for the first two ads — just ad set 2 and its two ads.
    expect(script.calls.slice(9)).toEqual(['adset', 'image', 'creative', 'ad', 'image', 'creative', 'ad']);
  });

  it('records each id BEFORE the next Graph call is made (not once at the end of the build)', async () => {
    const campaignId = await makeCampaign({ sets: 1, ads: 2 });
    const seen: { kind: string; pending: string | null; adSets: string[]; ads: string[] }[] = [];
    script.beforeCall = async (kind) => {
      const r = await recorded(campaignId);
      seen.push({ kind, pending: r.fbPendingCampaignId, adSets: r.adSetIds, ads: r.adIds });
    };

    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');

    // calls: 0 campaign · 1 adset · 2 image · 3 creative · 4 ad · 5 image · 6 creative · 7 ad
    expect(seen.map((s) => s.kind)).toEqual(['campaign', 'adset', 'image', 'creative', 'ad', 'image', 'creative', 'ad']);
    expect(seen[0]!.pending).toBeNull();
    expect(seen[1]!.pending).toBe(script.created.campaigns[0]); // recorded before the ad-set call
    expect(seen[2]!.adSets).toEqual([script.created.adSets[0]]); // recorded before the first ad's image upload
    expect(seen[5]!.ads).toEqual([script.created.ads[0]]); // ad 1 recorded before ad 2's first call
    for (const s of seen) expect(s.pending === null || s.pending === script.created.campaigns[0]).toBe(true);
  });

  it('a rate limit BEFORE anything exists records nothing, and the re-drive builds the whole structure once', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 1;
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
    const mid = await recorded(campaignId);
    expect(mid.fbPendingCampaignId).toBeNull();
    expect(mid.adSetIds).toEqual([]);
    expect(mid.adIds).toEqual([]);

    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');
    expect(script.created.campaigns).toHaveLength(1);
    expect(script.created.ads).toHaveLength(SETS * ADS_PER_SET);
  });

  it('survives being rate-limited AGAIN on the re-drive, and still never duplicates', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 6; // first attempt: campaign, ad set 1, ad 1 done
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
    script.failAt = 12; // second attempt gets further, then is limited again (ad 3's creative)
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');

    expect(script.created.campaigns).toHaveLength(1);
    expect(script.created.adSets).toHaveLength(SETS);
    expect(script.created.ads).toHaveLength(SETS * ADS_PER_SET);
    expectRecordedEqualsCreated(await recorded(campaignId), { fbCampaignId: script.created.campaigns[0]! });
  });

  it('two launches racing over a BATCHED partial build: the atomic LAUNCHING claim lets exactly one resume it', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 6;
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');

    const results = await Promise.allSettled([launchCampaign(auth(), campaignId, deps()), launchCampaign(auth(), campaignId, deps())]);

    expect(results.some((r) => r.status === 'fulfilled' && r.value.status === 'ACTIVE')).toBe(true);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ statusCode: 409 }); // the loser is refused
    expect(script.created.campaigns).toHaveLength(1);
    expect(script.created.adSets).toHaveLength(SETS);
    expect(script.created.ads).toHaveLength(SETS * ADS_PER_SET);
    expect((await recorded(campaignId)).status).toBe('ACTIVE');
  });

  it('a launch arriving while another is mid-build is refused (409) — an unfinished build is never reported as "already launched"', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 6;
    await launchCampaign(auth(), campaignId, deps());
    // The winner holds the claim and has recorded progress, but is not done.
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'LAUNCHING' } }));
    const before = script.calls.length;

    await expect(launchCampaign(auth(), campaignId, deps())).rejects.toMatchObject({ statusCode: 409 });
    expect(script.calls).toHaveLength(before); // and it did not touch Facebook
  });

  it('a campaign with an unfinished build is NOT treated as launched anywhere (fb_campaign_id stays null)', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 8;
    await launchCampaign(auth(), campaignId, deps());
    const mid = await recorded(campaignId);
    // The invariant every reader (auto-launch gate, meta-rejection scan, BATCHED sweep, google-signals `live`) relies on.
    expect(mid.fbCampaignId).toBeNull();
    expect(mid.fbPendingCampaignId).not.toBeNull();
  });

  it('the pre-build edge config already carries expectedAdId for ads that exist; the final resync carries all of them', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 9; // campaign, ad set 1 and both its ads exist
    await launchCampaign(auth(), campaignId, deps());

    const d = deps();
    await launchCampaign(auth(), campaignId, d);
    const writes = d.writeRedirectConfigs.mock.calls.map((c) => c[0]);
    const pre = Object.fromEntries(writes[0]!.map((e) => [e.redirectId, e.config.expectedAdId]));
    expect(Object.values(pre).filter(Boolean)).toHaveLength(2); // the two ads already on Facebook
    const post = writes.at(-1)!;
    expect(post).toHaveLength(SETS * ADS_PER_SET);
    expect(post.map((e) => e.config.expectedAdId).sort()).toEqual([...script.created.ads].sort());
    expect(post.every((e) => e.config.active === true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('D19 — a failure that is NOT a rate limit is never retried on its own', () => {
  it('reverts to PROCESSING with the progress recorded; the next MANUAL launch resumes it without duplicates', async () => {
    const campaignId = await makeCampaign();
    script.failAt = 9; // the second ad set
    script.failWith = () => new fb.FbApiError('Invalid parameter', { code: 100 });

    await expect(launchCampaign(auth(), campaignId, deps())).rejects.toThrow('Invalid parameter');
    expect(script.calls).toHaveLength(9); // nothing else was attempted after the failure (no retry inside the launch)
    const mid = await recorded(campaignId);
    expect(mid.status).toBe('PROCESSING'); // for a human — not BATCHED, so no re-drive picks it up
    expect(mid.fbCampaignId).toBeNull();
    expect(mid.fbPendingCampaignId).toBe(script.created.campaigns[0]);
    expectRecordedEqualsCreated(mid, { fbCampaignId: null });

    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');
    expect(script.created.campaigns).toHaveLength(1);
    expect(script.created.adSets).toHaveLength(SETS);
    expect(script.created.ads).toHaveLength(SETS * ADS_PER_SET);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('one campaign, one redirect host and one white domain — across a resume', () => {
  it('keeps the hosts its already-created ads use, even when the least-loaded ranking moves between attempts', async () => {
    const redirectHosts = [`rr1-${suffix}.example.com`, `rr2-${suffix}.example.com`];
    const whiteHosts = [`rw1-${suffix}.example.com`, `rw2-${suffix}.example.com`];
    await withCloaker(redirectHosts, whiteHosts, async () => {
      const campaignId = await makeCampaign();
      script.failAt = 6; // ad set 1 and its first ad exist (created on the first hosts)
      expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
      const mid = await recorded(campaignId);
      const redirectHost = mid.redirectDomainHost!; // recorded with the campaign, not at the end
      const whiteHost = mid.whiteDomainHost!;
      expect(redirectHosts).toContain(redirectHost);
      expect(whiteHost).toBeTruthy();

      // Load the hosts the first attempt used, so a fresh rotation would now prefer the OTHER ones.
      await withSystem(async (tx) => {
        for (let i = 0; i < 3; i += 1) {
          await tx.campaign.create({ data: { orgId, buyerId, name: `load ${i}`, status: 'DRAFT', keywords: [], redirectDomainHost: redirectHost, whiteDomainHost: whiteHost } });
        }
      });

      expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');

      const done = await recorded(campaignId);
      expect(done.redirectDomainHost).toBe(redirectHost);
      expect(done.whiteDomainHost).toBe(whiteHost);
      const specs = creativeLinkData();
      expect(new Set(specs.map((x) => new URL(x.link).host))).toEqual(new Set([redirectHost])); // every creative, both attempts
      expect(new Set(specs.map((x) => x.caption))).toEqual(new Set([`https://${whiteHost}`]));

      // Control: the load really does move a FRESH rotation elsewhere — so the above is the resume's doing.
      const control = await makeCampaign({ sets: 1, ads: 1 });
      await launchCampaign(auth(), control, deps());
      const other = await recorded(control);
      expect(other.redirectDomainHost).not.toBe(redirectHost);
      expect(other.whiteDomainHost).not.toBe(whiteHost);
    });
  });

  it('if the host its earlier ads link to leaves the pool mid-build, the rest of the build uses a fresh one — and says so', async () => {
    const redirectHosts = [`rs1-${suffix}.example.com`, `rs2-${suffix}.example.com`];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await withCloaker(redirectHosts, [], async () => {
        const campaignId = await makeCampaign();
        script.failAt = 6; // ad 1 exists, on the first host
        expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
        const first = (await recorded(campaignId)).redirectDomainHost!;
        const other = redirectHosts.find((h) => h !== first)!;
        await withSystem((tx) => tx.redirectDomain.updateMany({ where: { host: first }, data: { isActive: false } })); // retired mid-build

        expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');

        expect((await recorded(campaignId)).redirectDomainHost).toBe(other);
        expect(creativeLinkData().map((x) => new URL(x.link).host)).toEqual([first, other, other, other]); // ad 1 old host, the rest fresh
        expect(warn.mock.calls.some((c) => String(c[0]).includes('no longer eligible'))).toBe(true);
      });
    } finally {
      warn.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('editing / restarting a campaign whose launch is unfinished never resumes stale objects', () => {
  /** A campaign parked in BATCHED with the campaign, ad set 1 and ad 1 already on Facebook. */
  async function batchedPartial(): Promise<{ campaignId: string; staleFbCampaignId: string }> {
    const campaignId = await makeCampaign();
    script.failAt = 6;
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('BATCHED');
    return { campaignId, staleFbCampaignId: script.created.campaigns[0]! };
  }

  it('Reopen & edit pauses the unfinished Facebook campaign and forgets it; the edited campaign then launches from scratch', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    const reopened = await reopenCampaignForEdit(auth(), campaignId);

    expect(reopened.status).toBe('DRAFT');
    // Paused first — it was live and possibly spending.
    expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith(staleFbCampaignId, 'act_r1', 'tok', 'PAUSED', 'DATA');
    // …and nothing is left on record, so nothing can be resumed.
    const mid = await recorded(campaignId);
    expect(mid).toMatchObject({ status: 'DRAFT', fbCampaignId: null, fbPendingCampaignId: null, adSetIds: [], adIds: [] });
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: campaignId, action: 'campaign.fb_build_discarded' } }));
    expect(audit?.details).toMatchObject({ fbCampaignId: staleFbCampaignId, adSets: 1, ads: 1, pausedOnFacebook: true });
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.fb_build_not_paused' })); // it WAS paused — nothing to warn about

    // The buyer edits and resubmits → back in the launch pipeline with a channel.
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { name: 'Edited', status: 'PROCESSING', channelId: channelRef } }));
    const result = await launchCampaign(auth(), campaignId, deps());

    expect(result.status).toBe('ACTIVE');
    expect(script.created.campaigns).toHaveLength(2); // the abandoned (paused) one + a NEW one
    expect(result.fbCampaignId).toBe(script.created.campaigns[1]);
    expect(result.fbCampaignId).not.toBe(staleFbCampaignId);
    const done = await recorded(campaignId);
    expect(done.adSetIds).toEqual(script.created.adSets.slice(1)); // only the new build's ad sets/ads are recorded
    expect(done.adIds).toEqual(script.created.ads.slice(1));
  });

  it('Reopen & edit republishes the edge config INACTIVE — the channel it releases must not keep routing paid clicks (B1)', async () => {
    const { campaignId } = await batchedPartial();
    vi.mocked(kv.writeRedirectConfigs).mockClear();

    await reopenCampaignForEdit(auth(), campaignId);

    const writes = vi.mocked(kv.writeRedirectConfigs).mock.calls;
    expect(writes).toHaveLength(1);
    const entries = writes[0]![0];
    expect(entries).toHaveLength(SETS * ADS_PER_SET);
    expect(entries.every((e) => e.config.active === false && e.config.expectedAdId === undefined)).toBe(true);
  });

  it('Reopen & edit stops on a Facebook rate limit and changes NOTHING (it must not strand a live campaign)', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    vi.mocked(fb.updateFbCampaignStatus).mockRejectedValueOnce(new fb.FbRateLimitError('rate limited', { code: 17 }));

    await expect(reopenCampaignForEdit(auth(), campaignId)).rejects.toMatchObject({ statusCode: 429 });

    const kept = await recorded(campaignId);
    expect(kept).toMatchObject({ status: 'BATCHED', fbCampaignId: null, fbPendingCampaignId: staleFbCampaignId });
    expect(kept.adIds).toEqual(script.created.ads);
    // …and the launch still resumes cleanly afterwards.
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');
    expect(script.created.campaigns).toHaveLength(1);
  });

  it('Reopen & edit still works when Facebook can no longer pause the campaign (deleted in Ads Manager) — and says so', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    vi.mocked(fb.updateFbCampaignStatus).mockRejectedValueOnce(new fb.FbApiError('Object does not exist', { code: 100 }));

    const reopened = await reopenCampaignForEdit(auth(), campaignId);

    expect(reopened.status).toBe('DRAFT');
    expect((await recorded(campaignId)).fbPendingCampaignId).toBeNull();
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: campaignId, action: 'campaign.fb_build_discarded' } }));
    expect(audit?.details).toMatchObject({ fbCampaignId: staleFbCampaignId, pausedOnFacebook: false });
    // …and the buyer is told which Facebook campaign to pause by hand.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.fb_build_not_paused', body: expect.stringContaining(staleFbCampaignId) }));
  });

  it('Reopen & edit still works when the ad account is no longer connected (nothing to pause with)', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { adAccountId: null } }));
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    expect((await reopenCampaignForEdit(auth(), campaignId)).status).toBe('DRAFT');
    expect(fb.updateFbCampaignStatus).not.toHaveBeenCalled();
    expect((await recorded(campaignId)).fbPendingCampaignId).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.fb_build_not_paused', body: expect.stringContaining(staleFbCampaignId) }));
  });

  it('reopenCampaign on its own fails closed while a build is unfinished (409) — nothing is silently forgotten', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    await expect(reopenCampaign(auth(), campaignId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await recorded(campaignId)).toMatchObject({ status: 'BATCHED', fbPendingCampaignId: staleFbCampaignId });
  });

  it('reopening a campaign with NO unfinished build makes no Facebook call (nothing changed for the ordinary reopen)', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.updateFbCampaignStatus).mockClear();
    expect((await reopenCampaignForEdit(auth(), campaignId)).status).toBe('DRAFT');
    expect(fb.updateFbCampaignStatus).not.toHaveBeenCalled();
    expect(script.calls).toHaveLength(0);
  });

  it('a live (ACTIVE) campaign is still refused and untouched — the discard only ever applies to unfinished builds', async () => {
    const campaignId = await makeCampaign();
    await launchCampaign(auth(), campaignId, deps());
    const before = await recorded(campaignId);
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    await expect(reopenCampaignForEdit(auth(), campaignId)).rejects.toMatchObject({ statusCode: 409 });
    expect(fb.updateFbCampaignStatus).not.toHaveBeenCalled();
    expect(await recorded(campaignId)).toEqual(before);
  });

  it('relaunch is the explicit "start over": it pauses the unfinished campaign, forgets it, and rebuilds everything', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    const result = await relaunchCampaign(auth(), campaignId);

    expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith(staleFbCampaignId, 'act_r1', 'tok', 'PAUSED', 'DATA');
    expect(result.status).toBe('ACTIVE');
    expect(script.created.campaigns).toHaveLength(2);
    expect(result.fbCampaignId).toBe(script.created.campaigns[1]);
    const done = await recorded(campaignId);
    expect(done.fbPendingCampaignId).toBeNull();
    expect(done.adSetIds).toEqual(script.created.adSets.slice(1));
    expect(done.adIds).toEqual(script.created.ads.slice(1));
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.fb_build_not_paused' }));
  });

  it('relaunch of a FINISHED campaign pauses the old one with the owner’s write credential, then rebuilds', async () => {
    const campaignId = await makeCampaign();
    expect((await launchCampaign(auth(), campaignId, deps())).status).toBe('ACTIVE');
    const old = script.created.campaigns[0]!;
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    const result = await relaunchCampaign(auth(), campaignId);

    expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith(old, 'act_r1', 'tok', 'PAUSED', 'DATA');
    expect(script.created.campaigns).toHaveLength(2);
    expect(result.fbCampaignId).toBe(script.created.campaigns[1]);
  });

  it('relaunch pauses with the owner’s LAUNCH-app credential when they have one — not the raw DATA token', async () => {
    const launchConn = await withSystem((tx) =>
      tx.fbConnection.create({
        data: { orgId, userId: buyerId, fbUserId: 'fb-resume-launch', appKind: 'LAUNCH', accessTokenEnc: 'enc-launch', tokenExpiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE' },
      }),
    );
    vi.mocked(fb.hasLaunchApp).mockReturnValue(true);
    try {
      const { campaignId, staleFbCampaignId } = await batchedPartial();
      vi.mocked(fb.updateFbCampaignStatus).mockClear();

      await relaunchCampaign(auth(), campaignId);

      expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith(staleFbCampaignId, 'act_r1', 'tok', 'PAUSED', 'LAUNCH');
    } finally {
      vi.mocked(fb.hasLaunchApp).mockReturnValue(false);
      await withSystem((tx) => tx.fbConnection.delete({ where: { id: launchConn.id } }));
    }
  });

  it('relaunch never blocks on a pause that fails — but it tells the buyer which Facebook campaign to pause by hand', async () => {
    const { campaignId, staleFbCampaignId } = await batchedPartial();
    vi.mocked(fb.updateFbCampaignStatus).mockRejectedValueOnce(new fb.FbRateLimitError('rate limited', { code: 17 }));

    const result = await relaunchCampaign(auth(), campaignId);

    expect(result.status).toBe('ACTIVE'); // the relaunch went ahead
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'campaign.fb_build_not_paused', body: expect.stringContaining(staleFbCampaignId) }));
  });

  it('a test launch refuses to run over an unfinished build (it would take over fb_campaign_id and orphan it)', async () => {
    const { campaignId } = await batchedPartial();
    const before = script.calls.length;
    await expect(testLaunchCampaign(auth(), campaignId)).rejects.toMatchObject({ statusCode: 409 });
    expect(script.calls).toHaveLength(before);
  });

  it('a test launch is unchanged: always a fresh PAUSED structure, ids written at the end', async () => {
    const campaignId = await makeCampaign({ sets: 1, ads: 1 });
    const res = await testLaunchCampaign(auth(), campaignId);
    expect(res.fbCampaignId).toBe(script.created.campaigns[0]);
    expect(vi.mocked(fb.createFbCampaign).mock.calls[0]![2]).toMatchObject({ status: 'PAUSED' });
    const r = await recorded(campaignId);
    expect(r).toMatchObject({ fbCampaignId: script.created.campaigns[0], fbPendingCampaignId: null });
    expect(r.adIds).toEqual(script.created.ads);
  });
});
