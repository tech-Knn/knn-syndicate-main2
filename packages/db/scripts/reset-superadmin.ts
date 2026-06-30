import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

/**
 * Reset (or create) the platform SUPER_ADMIN login.
 *
 * `seed.ts` can't do this: its user `upsert` has an EMPTY `update` clause, so re-seeding never
 * changes an existing admin's password. This script ALWAYS sets the password (and re-activates the
 * account) — use it to recover a lost super-admin password or hand a fresh login to a new owner/dev.
 *
 * Connects via DATABASE_URL (the owner role, like the seed) so it bypasses RLS to write the user.
 *
 *   SEED_SUPERADMIN_EMAIL=admin@rsoc.app SEED_SUPERADMIN_PASSWORD='NewStrongPassword' pnpm db:reset-admin
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim();
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD, e.g.\n' +
        "  SEED_SUPERADMIN_EMAIL=admin@rsoc.app SEED_SUPERADMIN_PASSWORD='NewPass' pnpm db:reset-admin",
    );
  }

  // The platform org SUPER_ADMINs belong to (created by seed.ts; upsert keeps this script standalone).
  const platformOrg = await prisma.organization.upsert({
    where: { slug: 'knn-platform' },
    update: {},
    create: { name: 'KNN Syndicate', slug: 'knn-platform', isPlatform: true },
  });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    // Reset path: set the password and ensure the account is an ACTIVE super admin.
    update: { passwordHash, role: 'SUPER_ADMIN', status: 'ACTIVE' },
    create: {
      orgId: platformOrg.id,
      email,
      name: 'Super Admin',
      passwordHash,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });

  console.log(`Super admin ready: ${user.email} — password set, role SUPER_ADMIN, status ACTIVE.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
