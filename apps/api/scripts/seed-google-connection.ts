/**
 * One-shot ops seed for the platform AdSense connection — injects a pre-obtained
 * Google OAuth refresh token (so we don't need the interactive consent round-trip /
 * a registered staging redirect URI), discovers the account + AFS ad client, and
 * seeds the AFS custom channels into the pool. Idempotent (upsert + skipDuplicates).
 *
 * The refresh token + the channel-id RANGE(s) this platform owns come from the ENV
 * (never committed); it refreshes to a fresh access token using GOOGLE_CLIENT_ID/SECRET
 * (already in the container env). Only the selected ranges are imported (the account
 * holds 100k+ channels split across teams):
 *   GSEED_REFRESH_TOKEN=1//... GSEED_CHANNEL_RANGES="03700-05000" \
 *     pnpm --filter @knn/api exec tsx scripts/seed-google-connection.ts
 *
 * Run inside the deployed api container (it has TOKEN_ENCRYPTION_KEY + DB access).
 */
import { withSystem } from '@knn/db';
import { discoverChannelsInRanges, listAccounts, listAdClients, parseChannelRanges, refreshGoogleToken } from '@knn/adsense';
import { encryptToken } from '@knn/fb';

async function main(): Promise<void> {
  const refresh = process.env.GSEED_REFRESH_TOKEN;
  if (!refresh) throw new Error('Set GSEED_REFRESH_TOKEN');
  const rangeSpec = (process.env.GSEED_CHANNEL_RANGES ?? '').trim();
  const ranges = parseChannelRanges(rangeSpec);
  if (ranges.length === 0) throw new Error('Set GSEED_CHANNEL_RANGES (e.g. "03700-05000")');
  // Refresh first — the pasted access token may be expired (≈1h TTL); the refresh token
  // + GOOGLE_CLIENT_ID/SECRET (from env) always mint a fresh one.
  const { accessToken: access, expiresInSec } = await refreshGoogleToken(refresh);

  const account = (await listAccounts(access))[0]?.name;
  if (!account) throw new Error('No AdSense account visible to this token');
  const clients = await listAdClients(access, account);
  const adClient = (clients.find((c) => c.productCode === 'AFS') ?? clients[0])?.name;
  if (!adClient) throw new Error('No AFS ad client found on the account');

  await withSystem((tx) =>
    tx.googleConnection.upsert({
      where: { id: 'platform' },
      create: {
        id: 'platform',
        accessTokenEnc: encryptToken(access),
        refreshTokenEnc: encryptToken(refresh),
        tokenExpiresAt: new Date(Date.now() + expiresInSec * 1000),
        scopes: 'https://www.googleapis.com/auth/adsense.readonly',
        adsenseAccount: account,
        adsenseAdClient: adClient,
        channelRanges: rangeSpec,
        status: 'ACTIVE',
      },
      update: {
        accessTokenEnc: encryptToken(access),
        refreshTokenEnc: encryptToken(refresh),
        tokenExpiresAt: new Date(Date.now() + expiresInSec * 1000),
        adsenseAccount: account,
        adsenseAdClient: adClient,
        channelRanges: rangeSpec,
        status: 'ACTIVE',
        lastError: null,
      },
    }),
  );

  const channels = await discoverChannelsInRanges(access, adClient, ranges);
  const added = await withSystem(async (tx) => {
    const existing = new Set((await tx.channel.findMany({ select: { channelId: true } })).map((c) => c.channelId));
    const fresh = channels.filter((ch) => !existing.has(ch.channelId));
    for (let i = 0; i < fresh.length; i += 500) {
      await tx.channel.createMany({
        data: fresh.slice(i, i + 500).map((ch) => ({ channelId: ch.channelId, label: ch.displayName ?? null, status: 'AVAILABLE' as const })),
        skipDuplicates: true,
      });
    }
    return fresh.length;
  });

  // eslint-disable-next-line no-console
  console.log(`AdSense connected: account=${account} adClient=${adClient}; ranges=${rangeSpec}; channels discovered=${channels.length} added=${added}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
