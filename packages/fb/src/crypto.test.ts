import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './crypto.js';
import { TokenDecryptError } from './errors.js';

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

  it('throws a typed TokenDecryptError (never a raw crypto error) on an undecryptable value', () => {
    // Simulates a rotated TOKEN_ENCRYPTION_KEY or a corrupt/garbage stored ciphertext: callers
    // must be able to map this to a clean "reconnect" response, not leak ERR_CRYPTO_INVALID_AUTH_TAG.
    expect(() => decryptToken('not-a-real-encrypted-token')).toThrow(TokenDecryptError);

    const tampered = Buffer.from(encryptToken('secret'), 'base64');
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    let caught: unknown;
    try {
      decryptToken(tampered.toString('base64'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TokenDecryptError);
    // The message is generic and carries no token material or raw Node crypto code.
    expect((caught as Error).message).not.toMatch(/ERR_CRYPTO|auth(entication)? tag/i);
  });
});
