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

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${DEFAULT_SETTINGS.length} settings, platform org, and super admin (${email}).`,
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
