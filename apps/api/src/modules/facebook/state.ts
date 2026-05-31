import { SignJWT, jwtVerify } from 'jose';
import { env } from '@knn/config';
import type { FbAppKind } from '@knn/fb';

/**
 * The Facebook OAuth `state` parameter. It round-trips through Facebook (the
 * callback is a public, unauthenticated endpoint), so it must be tamper-proof:
 * we sign it as a short-lived JWT (10m) carrying the connecting user + org (+ which
 * app is being connected, DATA vs LAUNCH), and verify the `purpose` so an access
 * token can't be replayed here.
 */
const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const PURPOSE = 'fb_oauth_state';

export interface FbStateClaims {
  userId: string;
  orgId: string;
  /** Which FB app the user is connecting (defaults to DATA on older/absent claims). */
  appKind: FbAppKind;
}

export async function signFbState(claims: FbStateClaims): Promise<string> {
  return new SignJWT({ org: claims.orgId, appKind: claims.appKind, purpose: PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyFbState(token: string): Promise<FbStateClaims> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (payload.purpose !== PURPOSE) throw new Error('Unexpected state purpose');
  const appKind: FbAppKind = payload.appKind === 'LAUNCH' ? 'LAUNCH' : 'DATA';
  return { userId: String(payload.sub), orgId: String(payload.org), appKind };
}
