import { SignJWT, jwtVerify } from 'jose';
import { env } from '@knn/config';

/**
 * Google OAuth `state` (mirrors the Facebook one). Round-trips through Google to a
 * public callback, so it's a short-lived signed JWT carrying the connecting
 * super-admin; the `purpose` claim prevents cross-flow replay.
 */
const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const PURPOSE = 'adsense_oauth_state';

export async function signAdsenseState(userId: string, orgId: string): Promise<string> {
  return new SignJWT({ purpose: PURPOSE, org: orgId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyAdsenseState(token: string): Promise<{ userId: string; orgId: string }> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (payload.purpose !== PURPOSE) throw new Error('Unexpected state purpose');
  return { userId: String(payload.sub), orgId: String(payload.org) };
}
