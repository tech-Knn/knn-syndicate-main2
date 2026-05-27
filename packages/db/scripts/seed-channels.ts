/**
 * Provision the AdSense channel pool (D7). Idempotent on `channelId`. Count via
 * CHANNEL_POOL_SEED (default 50 for dev; production target is 2000).
 *
 *   CHANNEL_POOL_SEED=2000 tsx packages/db/scripts/seed-channels.ts
 *
 * NOTE: these are placeholder ids (ch-00001…). Real attribution needs the actual
 * AdSense **custom-channel** ids from the publisher's account mapped in — replace
 * `channel_id` with the real values (OPEN_QUESTIONS #4) before driving live traffic.
 */
import { withSystem } from '../src/index.js';

const COUNT = Number(process.env.CHANNEL_POOL_SEED ?? 50);

async function main(): Promise<void> {
  const created = await withSystem(async (tx) => {
    let n = 0;
    for (let i = 1; i <= COUNT; i++) {
      const channelId = `ch-${String(i).padStart(5, '0')}`;
      const existing = await tx.channel.findUnique({ where: { channelId }, select: { id: true } });
      if (existing) continue;
      await tx.channel.create({ data: { channelId, label: `Channel ${i}` } });
      n += 1;
    }
    return n;
  });
  console.log(`Seeded ${created} channels (pool target ${COUNT}).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
