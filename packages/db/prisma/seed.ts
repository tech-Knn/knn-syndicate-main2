import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  {
    key: 'compliance_prompt',
    value:
      "Remove health claims. Don't promise specific outcomes. Add disclaimers where needed. Keep a natural, informative tone.",
  },
  { key: 'auto_approve_ads', value: 'false' },
  { key: 'channel_pool_size', value: '2000' },
];

async function main(): Promise<void> {
  for (const setting of DEFAULT_SETTINGS) {
    await prisma.platformSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${DEFAULT_SETTINGS.length} platform settings.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
