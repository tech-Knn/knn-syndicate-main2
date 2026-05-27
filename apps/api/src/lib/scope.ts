import { withSystem, withTenant, type TxClient } from '@knn/db';
import { ROLES } from '@knn/shared';
import type { AuthContext } from '../middleware/authenticate.js';

/**
 * Run a DB unit of work in the right RLS context for the actor: SUPER_ADMIN
 * gets `withSystem` (sees all orgs); COMPANY_ADMIN / MEDIA_BUYER are scoped to
 * their own org via `withTenant`, so cross-org access is impossible even with a
 * coding mistake (RLS enforces it).
 */
export function runScoped<T>(auth: AuthContext, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return auth.role === ROLES.SUPER_ADMIN ? withSystem(fn) : withTenant(auth.orgId, fn);
}
