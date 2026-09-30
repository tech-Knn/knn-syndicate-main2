import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WHOP_SCOPE_PARAM, signWhopScope, verifyWhopScope } from './whop-scope.js';

const SECRET = 'scope-secret-0123456789abcdef0123456789abcdef';
const BIZ = 'biz_5kCAsGozVBmEm1';

describe('whop-scope token', () => {
  it('round-trips: a freshly signed token names the business', async () => {
    const token = await signWhopScope(BIZ, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyWhopScope(token, SECRET)).toBe(BIZ);
  });

  it('is stable per business, so a cached page stays correct', async () => {
    expect(await signWhopScope(BIZ, SECRET)).toBe(await signWhopScope(BIZ, SECRET));
    expect(await signWhopScope('biz_OTHER123456', SECRET)).not.toBe(await signWhopScope(BIZ, SECRET));
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signWhopScope(BIZ, SECRET);
    expect(await verifyWhopScope(token, 'another-secret-0123456789abcdef0123456789')).toBeNull();
  });

  it('rejects a swapped business id: the pixel must never follow an id anyone can put in a URL', async () => {
    const token = await signWhopScope(BIZ, SECRET);
    const sig = token.slice(token.indexOf('.') + 1);
    const forged = `${btoa('biz_VICTIM123456').replace(/=+$/, '')}.${sig}`;
    expect(await verifyWhopScope(forged, SECRET)).toBeNull();
    // ...and an unsigned id
    expect(await verifyWhopScope(BIZ, SECRET)).toBeNull();
    expect(await verifyWhopScope(`${btoa(BIZ)}.`, SECRET)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signWhopScope(BIZ, SECRET);
    const bad = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await verifyWhopScope(bad, SECRET)).toBeNull();
  });

  it('returns null, never throws, for missing, empty, garbage or oversized input', async () => {
    expect(await verifyWhopScope(undefined, SECRET)).toBeNull();
    expect(await verifyWhopScope(null, SECRET)).toBeNull();
    expect(await verifyWhopScope('', SECRET)).toBeNull();
    expect(await verifyWhopScope('not a token', SECRET)).toBeNull();
    expect(await verifyWhopScope('%%%.%%%', SECRET)).toBeNull();
    expect(await verifyWhopScope('x'.repeat(5000), SECRET)).toBeNull();
    // No secret configured → feature off, even for a token that would otherwise be valid.
    expect(await verifyWhopScope(await signWhopScope(BIZ, SECRET), undefined)).toBeNull();
    expect(await verifyWhopScope(await signWhopScope(BIZ, SECRET), '')).toBeNull();
  });

  it('refuses to sign anything that is not a business id', async () => {
    for (const bad of ['', 'acct_123456', 'biz_', 'biz_ab', 'biz_<script>', '"); alert(1); ("']) {
      await expect(signWhopScope(bad, SECRET), bad).rejects.toThrow(/business id/);
    }
  });

  it('uses a parameter name Whop and Meta do not reserve', () => {
    expect(WHOP_SCOPE_PARAM).toBe('_ws');
  });

  // Anti-drift guard: the white Worker and the article server each hold a verbatim copy (neither may import
  // from this Worker). The redirect Worker SIGNS and they VERIFY, so the crypto and the context string must
  // be identical or the pixel silently disappears. This test fails if any copy drifts.
  it('stays byte-identical to the white Worker and article copies', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const redirect = readFileSync(resolve(here, 'whop-scope.ts'), 'utf8');
    const white = readFileSync(resolve(here, '../../white/src/whop-scope.ts'), 'utf8');
    const article = readFileSync(resolve(here, '../../article/app/_afs/whop-scope.ts'), 'utf8');
    expect(white).toBe(redirect);
    expect(article).toBe(redirect);
  });
});
