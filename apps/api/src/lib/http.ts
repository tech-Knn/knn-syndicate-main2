import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/** Map known service/validation errors to HTTP responses; rethrow the rest (→ 500). */
export function handleRouteError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation failed', details: err.flatten() });
  }
  throw err;
}
