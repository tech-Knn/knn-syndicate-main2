import bcrypt from 'bcryptjs';
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

  // The platform organization (KNN) that SUPER_ADMINs belong to.
  const platformOrg = await prisma.organization.upsert({
    where: { slug: 'knn-platform' },
    update: {},
    create: { name: 'KNN Syndicate', slug: 'knn-platform', isPlatform: true },
  });

  const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'super@knn.local';
  const password = process.env.SEED_SUPERADMIN_PASSWORD ?? 'super-admin-dev-pw';
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      orgId: platformOrg.id,
      email,
      name: 'Super Admin',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });

  // Bootstrap the white-domain pool (cloaker fallback + FB display link) on FIRST run only — once any
  // exist they're managed in the super-admin domain manager, so retired ones are never resurrected.
  // Override the initial hosts with SEED_WHITE_DOMAINS (comma-separated); defaults to the live pool.
  let whiteSeeded = 0;
  if ((await prisma.whiteDomain.count()) === 0) {
    const hosts = (process.env.SEED_WHITE_DOMAINS ?? 'readoranow.com,livedailyperch.com,brightleafreads.com')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length) {
      whiteSeeded = (await prisma.whiteDomain.createMany({ data: hosts.map((host) => ({ host })), skipDuplicates: true })).count;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${DEFAULT_SETTINGS.length} settings, platform org, super admin (${email}), and ${whiteSeeded} white domain(s).`,
  );
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
