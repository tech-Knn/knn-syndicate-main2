import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { handleRouteError } from '../../lib/http.js';
import { authenticate } from '../../middleware/authenticate.js';
import { storeUpload } from './uploads.service.js';

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Multipart creative upload (one file per request). The @fastify/multipart
  // plugin is registered globally with the size/file-count limits.
  app.post('/', { preHandler: [authenticate] }, async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'Unauthenticated' });
    try {
      const file = await req.file();
      if (!file) throw new AppError(400, 'No file provided');
      const data = await file.toBuffer();
      const upload = await storeUpload(req.auth, {
        filename: file.filename,
        mimeType: file.mimetype,
        data,
      });
      return reply.code(201).send({ upload });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'File too large' });
      }
      return handleRouteError(err, reply);
    }
  });
}
