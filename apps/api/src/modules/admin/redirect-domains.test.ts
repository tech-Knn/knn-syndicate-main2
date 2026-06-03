import { afterAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import {
  createRedirectDomain,
  deleteRedirectDomain,
  listRedirectDomains,
  setDefaultRedirectDomain,
  updateRedirectDomain,
} from './redirect-domains.service.js';

const suffix = Date.now().toString(36);
const hostA = `go-a-${suffix}.example.com`;
const hostB = `go-b-${suffix}.example.com`;
const hostC = `go-c-${suffix}.example.com`;

afterAll(async () => {
  await withSystem((tx) => tx.redirectDomain.deleteMany({ where: { host: { in: [hostA, hostB, hostC] } } }));
  await prisma.$disconnect();
});

describe('redirect domains service', () => {
  it('normalizes host + rejects junk + defaults to the cloaker pool, active', async () => {
    await expect(createRedirectDomain({ host: 'not a host' })).rejects.toMatchObject({ statusCode: 400 });
    const a = await createRedirectDomain({ host: `HTTPS://${hostA.toUpperCase()}/go/x`, label: 'A' });
    expect(a.host).toBe(hostA); // scheme/path/case stripped
    expect(a.mode).toBe('CLOAKER'); // pool segregation defaults to the cloaker pool
    expect(a.isActive).toBe(true);
    expect(a.ownerOrgId).toBeNull(); // shared pool by default
  });

  it('can add a domain HELD out of rotation (isActive=false → "not in use" until assigned)', async () => {
    const c = await createRedirectDomain({ host: hostC, label: 'held', isActive: false });
    expect(c.isActive).toBe(false); // parked — launch rotation skips it
    expect(c.ownerOrgId).toBeNull();
  });

  it('keeps at most one default + switches it', async () => {
    const b = await createRedirectDomain({ host: hostB, label: 'B', mode: 'NORMAL' });
    expect(b.mode).toBe('NORMAL');
    await setDefaultRedirectDomain(b.id);
    const list = await listRedirectDomains();
    const defaults = list.filter((d) => d.isDefault);
    // The partial-unique index guarantees ≤1 default globally; setDefault made it hostB.
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.host).toBe(hostB);
  });

  it('updates pool placement (mode + active) and rejects a duplicate host', async () => {
    const list = await listRedirectDomains();
    const a = list.find((d) => d.host === hostA)!;
    const upd = await updateRedirectDomain(a.id, { mode: 'NORMAL', isActive: false });
    expect(upd.mode).toBe('NORMAL');
    expect(upd.isActive).toBe(false);
    await expect(createRedirectDomain({ host: hostA })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('deletes a domain', async () => {
    const list = await listRedirectDomains();
    const a = list.find((d) => d.host === hostA);
    expect(a).toBeDefined();
    await deleteRedirectDomain(a!.id);
    const after = await listRedirectDomains();
    expect(after.find((d) => d.host === hostA)).toBeUndefined();
  });
});
