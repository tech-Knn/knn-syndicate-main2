import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto.js';

describe('token crypto (AES-256-GCM)', () => {
  it('round-trips a token and does not store plaintext', () => {
    const token = `EAABsbCS1iHgBA${'x'.repeat(160)}`;
    const enc = encryptToken(token);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
  });

  it('uses a random IV (different ciphertext each call)', () => {
    expect(encryptToken('same-token')).not.toBe(encryptToken('same-token'));
  });

  it('rejects tampered ciphertext (auth tag)', () => {
    const raw = Buffer.from(encryptToken('secret'), 'base64');
    const last = raw.length - 1;
    raw[last] = (raw[last] ?? 0) ^ 0xff;
    expect(() => decryptToken(raw.toString('base64'))).toThrow();
  });
});
