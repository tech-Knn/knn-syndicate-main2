import { SignJWT, jwtVerify } from 'jose';
import { env } from '@knn/config';

/**
 * The Facebook OAuth `state` parameter. It round-trips through Facebook (the
 * callback is a public, unauthenticated endpoint), so it must be tamper-proof:
 * we sign it as a short-lived JWT (10m) carrying the connecting user + org, and
 * verify the `purpose` so an access token can't be replayed here.
 */
const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const PURPOSE = 'fb_oauth_state';

export interface FbStateClaims {
  userId: string;
  orgId: string;
}

export async function signFbState(claims: FbStateClaims): Promise<string> {
  return new SignJWT({ org: claims.orgId, purpose: PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyFbState(token: string): Promise<FbStateClaims> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (payload.purpose !== PURPOSE) throw new Error('Unexpected state purpose');
  return { userId: String(payload.sub), orgId: String(payload.org) };
}
