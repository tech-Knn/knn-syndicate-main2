import { SignJWT, jwtVerify } from 'jose';
import { env } from '@knn/config';
import type { Role, UserStatus } from '@knn/shared';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims {
  sub: string; // user id
  org: string; // org id
  role: Role;
  status: UserStatus;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ org: claims.org, role: claims.role, status: claims.status })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessSecret, { algorithms: ['HS256'] });
  return {
    sub: String(payload.sub),
    org: String(payload.org),
    role: payload.role as Role,
    status: payload.status as UserStatus,
  };
}
