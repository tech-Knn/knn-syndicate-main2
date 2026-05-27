import { Queue } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import { env } from '@knn/config';
import { QUEUES, type QueueName } from '@knn/shared';

/** BullMQ requires `maxRetriesPerRequest: null` on its Redis connection. */
export const redisConnectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

export function createConnection(): IORedis {
  return new IORedis(env.REDIS_URL, redisConnectionOptions);
}

/**
 * Shared connection used by queue producers and Bull-Board. Workers should
 * create their OWN connection (BullMQ best practice) via `createConnection()`.
 */
export const sharedConnection: IORedis = createConnection();

const queueCache = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue {
  const existing = queueCache.get(name);
  if (existing) return existing;
  const queue = new Queue(name, { connection: sharedConnection });
  queueCache.set(name, queue);
  return queue;
}

/** All known queues — used to populate Bull-Board. */
export function getAllQueues(): Queue[] {
  return Object.values(QUEUES).map((name) => getQueue(name));
}

export async function pingRedis(): Promise<boolean> {
  const pong = await sharedConnection.ping();
  return pong === 'PONG';
}

/** Close all producer queues and the shared connection (tests / graceful shutdown). */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queueCache.values()].map((queue) => queue.close()));
  queueCache.clear();
  if (sharedConnection.status === 'ready' || sharedConnection.status === 'connecting') {
    await sharedConnection.quit();
  }
}

export { QUEUES, Queue };
export type { QueueName };
