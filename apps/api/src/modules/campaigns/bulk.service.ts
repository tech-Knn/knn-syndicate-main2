import { AppError } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { deleteCampaign } from './campaigns.service.js';
import { approveCampaign, rejectCampaign } from './approval.service.js';
import { setCampaignActive } from './launch.service.js';

/**
 * Bulk actions for the high-frequency queues (Approvals, Campaigns) — the velocity primitive the
 * elite-SaaS audit flagged as missing. Every op is just the EXISTING per-campaign service applied
 * across a set of ids, run SEQUENTIALLY (pause/resume + approve hit Facebook / assign channels, both
 * of which are per-account rate-limited and single-writer — parallel would trip limiters / lock
 * contention). Partial success is intentional: approve the 48 that work, report the 2 that don't.
 * Ownership / role / state are enforced by each underlying service (and the route's preHandler), so
 * a buyer can never bulk-act on another buyer's campaigns even by POSTing arbitrary ids.
 */

export interface BulkResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** Hard cap so one request can't fan out into thousands of FB writes. */
const MAX_BULK = 100;

function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new AppError(400, '`ids` must be an array of campaign ids');
  const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (clean.length === 0) throw new AppError(400, 'Select at least one campaign');
  if (clean.length > MAX_BULK) throw new AppError(400, `Too many at once — ${MAX_BULK} max per request`);
  return clean;
}

async function runBulk(ids: string[], op: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await op(id);
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof AppError ? err.message : 'Action failed' });
    }
  }
  return { succeeded, failed };
}

// `async` so a validation error (bad/empty `ids`, missing reason) becomes a clean promise
// rejection the route's try/catch maps to a 400 — not a synchronous throw the caller misses.
export async function bulkApprove(auth: AuthContext, ids: unknown): Promise<BulkResult> {
  return runBulk(normalizeIds(ids), (id) => approveCampaign(auth, id));
}

export async function bulkReject(auth: AuthContext, ids: unknown, reason: string): Promise<BulkResult> {
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    throw new AppError(400, 'A rejection reason of at least 10 characters is required');
  }
  return runBulk(normalizeIds(ids), (id) => rejectCampaign(auth, id, reason));
}

export async function bulkSetActive(auth: AuthContext, ids: unknown, active: boolean): Promise<BulkResult> {
  return runBulk(normalizeIds(ids), (id) => setCampaignActive(auth, id, active));
}

export async function bulkDelete(auth: AuthContext, ids: unknown): Promise<BulkResult> {
  return runBulk(normalizeIds(ids), (id) => deleteCampaign(auth, id));
}
