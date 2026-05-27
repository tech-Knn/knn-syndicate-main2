import { timingSafeEqual } from 'node:crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { getAllQueues } from '@knn/queue';

const BASE_PATH = '/admin/queues';

function checkBasicAuth(header: string | undefined): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const provided = Buffer.from(header.slice('Basic '.length), 'base64').toString();
  const expected = `${env.BULL_BOARD_USER}:${env.BULL_BOARD_PASSWORD}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mount the Bull-Board queue dashboard at /admin/queues behind basic auth. */
export async function registerBullBoard(app: FastifyInstance): Promise<void> {
  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: getAllQueues().map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(BASE_PATH);

  await app.register(async (instance) => {
    instance.addHook('onRequest', async (req, reply) => {
      if (!checkBasicAuth(req.headers.authorization)) {
        await reply
          .header('WWW-Authenticate', 'Basic realm="bull-board"')
          .code(401)
          .send({ error: 'Unauthorized' });
      }
    });
    await instance.register(serverAdapter.registerPlugin(), { prefix: BASE_PATH });
  });
}
