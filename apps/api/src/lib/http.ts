import { FbApiError } from '@knn/fb';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/** Map known service/validation errors to HTTP responses; rethrow the rest (→ 500). */
export function handleRouteError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AppError) {
    return reply
      .code(err.statusCode)
      .send({ error: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation failed', details: err.flatten() });
  }
  // Surface Facebook Graph errors (e.g. from the launch write-path) with detail.
  if (err instanceof FbApiError) {
    return reply.code(502).send({
      error: err.userMessage ?? err.message,
      facebook: { code: err.code, subcode: err.subcode, fbtraceId: err.fbtraceId, userTitle: err.userTitle },
    });
  }
  throw err;
}
