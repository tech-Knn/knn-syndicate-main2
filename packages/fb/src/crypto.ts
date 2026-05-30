import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@knn/config';
import { TokenDecryptError } from './errors.js';

/**
 * AES-256-GCM at-rest encryption for Facebook tokens (DECISION D13). The key is
 * TOKEN_ENCRYPTION_KEY (32 bytes / 64 hex, validated in @knn/config). The stored
 * payload is base64(iv ‖ authTag ‖ ciphertext).
 */
const KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

if (KEY.length !== 32) {
  throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${KEY.length}`);
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptToken(payload: string): string {
  // Any failure here (rotated key, corrupt/garbage ciphertext, bad auth tag) means the stored
  // token is unusable. Re-throw as a typed, token-free error so callers can map it to a clean
  // "reconnect the account" response instead of leaking a raw Node crypto error to the client.
  try {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new TokenDecryptError();
  }
}
