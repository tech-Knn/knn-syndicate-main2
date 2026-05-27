import { type Role, type UserStatus } from '@knn/shared';

export type { Role, UserStatus };

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export type FbStatus = 'ACTIVE' | 'CONNECTION_BROKEN';

export interface ConnectionStatus {
  connected: boolean;
  status?: FbStatus;
  fbUserId?: string;
  scopes?: string[];
  tokenExpiresAt?: string;
  lastError?: string | null;
  connectedAt?: string;
}

export interface FbAccount {
  id: string;
  fbAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
}

export interface FbPage {
  id: string;
  fbPageId: string;
  name: string;
  instagramId: string | null;
}

export interface FbPixel {
  id: string;
  fbPixelId: string;
  name: string;
}

export interface SyncResult {
  adAccounts: number;
  pages: number;
  pixels: number;
}
