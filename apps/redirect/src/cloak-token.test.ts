import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CloakPayload, signCloakToken, verifyCloakToken } from './cloak-token.js';

const SECRET = 'cloak-secret-0123456789abcdef0123456789abcdef';
const NOW = 1_780_000_000_000;
const payload: CloakPayload = { p: { rc: 'Compare Backyard Apartments', ch: '05173', txid: 'tx-1', offerId: 'o-1' }, exp: NOW + 600_000 };

describe('cloak-token', () => {
  it('round-trips: a freshly signed token verifies and returns the payload', async () => {
    const token = await signCloakToken(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // base64url.base64url
    const out = await verifyCloakToken(token, SECRET, NOW);
    expect(out).toEqual(payload);
    expect(out?.p.ch).toBe('05173');
  });

  it('rejects a tampered token', async () => {
    const token = await signCloakToken(payload, SECRET);
    expect(await verifyCloakToken('A' + token.slice(1), SECRET, NOW)).toBeNull(); // body flipped
    expect(await verifyCloakToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), SECRET, NOW)).toBeNull(); // sig flipped
  });

  it('rejects a wrong secret', async () => {
    const token = await signCloakToken(payload, SECRET);
    expect(await verifyCloakToken(token, 'a-different-secret', NOW)).toBeNull();
  });

  it('rejects an expired token (a scanner replaying later)', async () => {
    const token = await signCloakToken(payload, SECRET);
    expect(await verifyCloakToken(token, SECRET, payload.exp + 1)).toBeNull();
  });

  it('rejects garbage / missing parts', async () => {
    expect(await verifyCloakToken('not-a-token', SECRET, NOW)).toBeNull();
    expect(await verifyCloakToken('', SECRET, NOW)).toBeNull();
    expect(await verifyCloakToken('abc.', SECRET, NOW)).toBeNull();
  });

  // Anti-drift guard: the article server has a byte-identical copy of this module (it can't import
  // @knn/redirect, and the Worker must stay lean / not pull @knn/shared's zod). A Worker-minted token
  // MUST verify on the article — that only holds if the crypto code is identical. This test fails
  // loudly if the two diverge, so they can never silently drift apart and break token verification.
  it('stays byte-identical to the article copy (apps/article/app/_afs/cloak-token.ts)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = (src: string): string => src.slice(src.indexOf('export interface CloakPayload'));
    const worker = readFileSync(resolve(here, 'cloak-token.ts'), 'utf8');
    const article = readFileSync(resolve(here, '../../article/app/_afs/cloak-token.ts'), 'utf8');
    expect(body(worker).length).toBeGreaterThan(100); // sanity: the marker was actually found
    expect(body(article)).toBe(body(worker));
  });
});
