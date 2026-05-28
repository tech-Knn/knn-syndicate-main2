/**
 * One-shot ops seed for the platform AdSense connection — injects a pre-obtained
 * Google OAuth refresh token (so we don't need the interactive consent round-trip /
 * a registered staging redirect URI), discovers the account + AFS ad client, and
 * seeds the AFS custom channels into the pool. Idempotent (upsert + skipDuplicates).
 *
 * Tokens come from the ENV (never committed):
 *   GSEED_ACCESS_TOKEN=ya29... GSEED_REFRESH_TOKEN=1//... \
 *     pnpm --filter @knn/api exec tsx scripts/seed-google-connection.ts
 *
 * Run inside the deployed api container (it has TOKEN_ENCRYPTION_KEY + DB access).
 */
import { withSystem } from '@knn/db';
import { discoverChannels, listAccounts, listAdClients } from '@knn/adsense';
import { encryptToken } from '@knn/fb';

const MAX_CHANNELS = 2000;

async function main(): Promise<void> {
  const access = process.env.GSEED_ACCESS_TOKEN;
  const refresh = process.env.GSEED_REFRESH_TOKEN;
  if (!access || !refresh) throw new Error('Set GSEED_ACCESS_TOKEN and GSEED_REFRESH_TOKEN');

  const account = (await listAccounts(access))[0]?.name;
  if (!account) throw new Error('No AdSense account visible to this token');
  const clients = await listAdClients(access, account);
  const adClient = (clients.find((c) => c.productCode === 'AFS') ?? clients[0])?.name;

  await withSystem((tx) =>
    tx.googleConnection.upsert({
      where: { id: 'platform' },
      create: {
        id: 'platform',
        accessTokenEnc: encryptToken(access),
        refreshTokenEnc: encryptToken(refresh),
        tokenExpiresAt: new Date(Date.now() + 3000 * 1000),
        scopes: 'https://www.googleapis.com/auth/adsense.readonly',
        adsenseAccount: account,
        adsenseAdClient: adClient ?? null,
        status: 'ACTIVE',
      },
      update: {
        accessTokenEnc: encryptToken(access),
        refreshTokenEnc: encryptToken(refresh),
        tokenExpiresAt: new Date(Date.now() + 3000 * 1000),
        adsenseAccount: account,
        adsenseAdClient: adClient ?? null,
        status: 'ACTIVE',
        lastError: null,
      },
    }),
  );

  const channels = await discoverChannels(access, account, { afsOnly: true, max: MAX_CHANNELS });
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
  console.log(`AdSense connected: account=${account} adClient=${adClient}; channels discovered=${channels.length} added=${added}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
