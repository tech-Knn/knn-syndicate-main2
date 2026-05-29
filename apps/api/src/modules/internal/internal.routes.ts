import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { decryptToken, graphRequest } from '@knn/fb';
import { handleRouteError } from '../../lib/http.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { launchCampaign } from '../campaigns/launch.service.js';

/**
 * Internal worker→API routes (Phase 8 auto-launch). Guarded by the shared
 * `INTERNAL_API_TOKEN` (NOT a user JWT) — the worker enqueues a launch when an
 * org has auto-launch on and a channel was just assigned. The launch runs as the
 * campaign's buyer (who owns it). Mounted at `/api/internal`.
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/launch/:id', async (req, reply) => {
    const header = req.headers['x-internal-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!env.INTERNAL_API_TOKEN || token !== env.INTERNAL_API_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const campaign = await withSystem((tx) =>
        tx.campaign.findUnique({ where: { id: req.params.id }, select: { buyerId: true, orgId: true } }),
      );
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      const auth: AuthContext = {
        userId: campaign.buyerId,
        orgId: campaign.orgId,
        role: ROLES.MEDIA_BUYER,
        status: USER_STATUS.ACTIVE,
      };
      return reply.send(await launchCampaign(auth, req.params.id));
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  // DEBUG (temporary): report a stored connection's token metadata via FB debug_token
  // (type / scopes / granular_scopes / validity / expiry) WITHOUT exposing the token, so
  // we can compare it to a known-good Graph Explorer token. Token stays server-side.
  app.post<{ Params: { id: string } }>('/debug-token/:id', async (req, reply) => {
    const header = req.headers['x-internal-token'];
    const tok = Array.isArray(header) ? header[0] : header;
    if (!env.INTERNAL_API_TOKEN || tok !== env.INTERNAL_API_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const conn = await withSystem((tx) =>
        tx.fbConnection.findUnique({ where: { id: req.params.id }, select: { accessTokenEnc: true, fbName: true, fbUserId: true } }),
      );
      if (!conn) return reply.code(404).send({ error: 'Connection not found' });
      const accessToken = decryptToken(conn.accessTokenEnc);
      const appToken = `${env.FB_APP_ID}|${env.FB_APP_SECRET}`;
      const debug = await graphRequest<{ data: unknown }>({
        path: '/debug_token',
        params: { input_token: accessToken, access_token: appToken },
      });
      const perms = await graphRequest<{ data: unknown }>({ path: '/me/permissions', accessToken });
      return reply.send({ fbName: conn.fbName, fbUserId: conn.fbUserId, debug: debug.data, permissions: perms.data });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
