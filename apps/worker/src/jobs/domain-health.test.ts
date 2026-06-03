import { afterAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { sweepDomainHealth } from './domain-health.js';

const sfx = Date.now().toString(36);
const rHost = `goh-${sfx}.example.com`;
const wHost = `wh-${sfx}.example.com`;

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.redirectDomain.deleteMany({ where: { host: { contains: sfx } } });
    await tx.whiteDomain.deleteMany({ where: { host: { contains: sfx } } });
  });
  await prisma.$disconnect();
});

describe('sweepDomainHealth', () => {
  it('marks active hosts down (healthy=false + lastCheck) on probe failure, then recovers them', async () => {
    await withSystem(async (tx) => {
      await tx.redirectDomain.create({ data: { host: rHost, healthy: true, isActive: true } });
      await tx.whiteDomain.create({ data: { host: wHost, healthy: true, isActive: true } });
    });

    // Injected probe: fail ONLY our two test hosts; everything else (seeded domains) reports ok so the
    // shared dev DB isn't disturbed. (No global fetch mock — keeps the concurrent suite stable.)
    const res = await sweepDomainHealth(async (host) =>
      host.includes(sfx) ? { ok: false, lastCheck: 'unreachable: injected' } : { ok: true, lastCheck: 'ok 200' },
    );
    expect(res.checked).toBeGreaterThanOrEqual(2);

    const r = await withSystem((tx) => tx.redirectDomain.findUnique({ where: { host: rHost }, select: { healthy: true, lastCheck: true } }));
    const w = await withSystem((tx) => tx.whiteDomain.findUnique({ where: { host: wHost }, select: { healthy: true, lastCheck: true } }));
    expect(r).toMatchObject({ healthy: false, lastCheck: 'unreachable: injected' });
    expect(w).toMatchObject({ healthy: false, lastCheck: 'unreachable: injected' });

    // A later successful probe flips them back to healthy.
    await sweepDomainHealth(async () => ({ ok: true, lastCheck: 'ok 200' }));
    const r2 = await withSystem((tx) => tx.redirectDomain.findUnique({ where: { host: rHost }, select: { healthy: true } }));
    expect(r2?.healthy).toBe(true);
  });
});
