import { createHash, randomBytes } from 'node:crypto';

/** Opaque refresh token — random, returned to the client; only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parse a short duration like "15m", "7d", "30s", "12h" into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const [, num, unit] = match;
  if (!num || !unit) throw new Error(`Invalid duration: ${value}`);
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(num) * (multipliers[unit] ?? 0);
}
