import { afterAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import {
  createRedirectDomain,
  deleteRedirectDomain,
  listRedirectDomains,
  setDefaultRedirectDomain,
} from './redirect-domains.service.js';

const suffix = Date.now().toString(36);
const hostA = `go-a-${suffix}.example.com`;
const hostB = `go-b-${suffix}.example.com`;

afterAll(async () => {
  await withSystem((tx) => tx.redirectDomain.deleteMany({ where: { host: { in: [hostA, hostB] } } }));
  await prisma.$disconnect();
});

describe('redirect domains service', () => {
  it('normalizes host + rejects junk', async () => {
    await expect(createRedirectDomain('not a host')).rejects.toMatchObject({ statusCode: 400 });
    const a = await createRedirectDomain(`HTTPS://${hostA.toUpperCase()}/go/x`, 'A');
    expect(a.host).toBe(hostA); // scheme/path/case stripped
  });

  it('keeps at most one default + switches it', async () => {
    const b = await createRedirectDomain(hostB, 'B');
    await setDefaultRedirectDomain(b.id);
    const list = await listRedirectDomains();
    const defaults = list.filter((d) => d.isDefault);
    // The partial-unique index guarantees ≤1 default globally; setDefault made it hostB.
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.host).toBe(hostB);
  });

  it('rejects a duplicate host', async () => {
    await expect(createRedirectDomain(hostA)).rejects.toMatchObject({ statusCode: 409 });
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
