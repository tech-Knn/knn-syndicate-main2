import { env } from '@knn/config';
import { withSystem, type TxClient } from '@knn/db';
import { ROLES, USER_STATUS, type Role, type UserStatus } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { signAccessToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashRefreshToken, parseDurationMs } from '../../lib/tokens.js';
import type { LoginInput, SignupInput } from './auth.schemas.js';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface DbUser extends AuthUser {
  passwordHash: string;
}

function toAuthUser(u: DbUser): AuthUser {
  return { id: u.id, orgId: u.orgId, email: u.email, name: u.name, role: u.role, status: u.status };
}

async function issueTokens(tx: TxClient, user: AuthUser): Promise<TokenPair> {
  const accessToken = await signAccessToken({
    sub: user.id,
    org: user.orgId,
    role: user.role,
    status: user.status,
  });
  const refreshToken = generateRefreshToken();
  await tx.refreshToken.create({
    data: {
      userId: user.id,
      orgId: user.orgId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_TTL)),
    },
  });
  return { accessToken, refreshToken };
}

/** Register a MEDIA_BUYER under an existing company. Created PENDING admin approval. */
export async function signup(input: SignupInput): Promise<{ status: UserStatus }> {
  const passwordHash = await hashPassword(input.password);
  return withSystem(async (tx) => {
    const org = await tx.organization.findUnique({ where: { slug: input.companySlug } });
    if (!org || org.status !== 'ACTIVE') {
      throw new AppError(400, 'Unknown or inactive company');
    }
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing) throw new AppError(409, 'Email already registered');
    const user = await tx.user.create({
      data: {
        orgId: org.id,
        email: input.email,
        name: input.name,
        passwordHash,
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.PENDING,
      },
    });
    return { status: user.status };
  });
}

export async function login(input: LoginInput): Promise<{ tokens: TokenPair; user: AuthUser }> {
  return withSystem(async (tx) => {
    const user = (await tx.user.findUnique({ where: { email: input.email } })) as DbUser | null;
    // Verify against the found hash or a dummy, so timing doesn't reveal existence.
    const hash = user?.passwordHash ?? '$2a$12$0000000000000000000000000000000000000000000000000000';
    const ok = await verifyPassword(input.password, hash);
    if (!user || !ok) throw new AppError(401, 'Invalid credentials');
    if (user.status !== USER_STATUS.ACTIVE) {
      const message =
        user.status === USER_STATUS.PENDING
          ? 'Account awaiting approval'
          : user.status === USER_STATUS.REJECTED
            ? 'Account not approved'
            : 'Account suspended';
      throw new AppError(403, message);
    }
    const tokens = await issueTokens(tx, user);
    return { tokens, user: toAuthUser(user) };
  });
}

export async function refresh(token: string): Promise<{ tokens: TokenPair; user: AuthUser }> {
  return withSystem(async (tx) => {
    const record = await tx.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
    });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new AppError(401, 'Invalid refresh token');
    }
    const user = (await tx.user.findUnique({ where: { id: record.userId } })) as DbUser | null;
    if (!user || user.status !== USER_STATUS.ACTIVE) throw new AppError(401, 'Invalid session');
    // Rotate: revoke the presented token, issue a fresh pair.
    await tx.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const tokens = await issueTokens(tx, user);
    return { tokens, user: toAuthUser(user) };
  });
}

export async function logout(token: string): Promise<void> {
  await withSystem((tx) =>
    tx.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

export async function getMe(userId: string): Promise<AuthUser | null> {
  return withSystem(async (tx) => {
    const user = (await tx.user.findUnique({ where: { id: userId } })) as DbUser | null;
    return user ? toAuthUser(user) : null;
  });
}
