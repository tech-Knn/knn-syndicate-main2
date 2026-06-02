import { afterAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { createWhiteDomain, deleteWhiteDomain, listWhiteDomains, updateWhiteDomain } from './white-domains.service.js';

const suffix = Date.now().toString(36);
const host = `wd-${suffix}.example.com`;

afterAll(async () => {
  await withSystem((tx) => tx.whiteDomain.deleteMany({ where: { host: { contains: suffix } } }));
  await prisma.$disconnect();
});

describe('white domains service', () => {
  it('normalizes + creates active/healthy, rejects junk + duplicates', async () => {
    await expect(createWhiteDomain('not a host')).rejects.toMatchObject({ statusCode: 400 });
    const d = await createWhiteDomain(`HTTPS://${host.toUpperCase()}/a/x`, 'Readora');
    expect(d.host).toBe(host); // scheme/path/case stripped
    expect(d.isActive).toBe(true);
    expect(d.healthy).toBe(true);
    expect(d.label).toBe('Readora');
    await expect(createWhiteDomain(host)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('retires (isActive=false) via update + appears in the list, then deletes', async () => {
    const list = await listWhiteDomains();
    const d = list.find((x) => x.host === host)!;
    const upd = await updateWhiteDomain(d.id, { isActive: false });
    expect(upd.isActive).toBe(false);
    await deleteWhiteDomain(d.id);
    expect((await listWhiteDomains()).find((x) => x.host === host)).toBeUndefined();
  });
});
