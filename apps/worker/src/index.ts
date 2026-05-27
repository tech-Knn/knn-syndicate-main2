import { Worker, type Job } from 'bullmq';
import cron from 'node-cron';
import { env } from '@knn/config';
import { QUEUES, closeQueues, createConnection, getQueue } from '@knn/queue';

/**
 * Background worker. Phase 0 runs a heartbeat on the HEALTH queue (so Bull-Board
 * shows live activity) and a stubbed IST midnight cron. Real processors (stats
 * pull, attribution, channel maintenance, FB launch, token refresh, article
 * generation, meta-rejection checks) are added in their respective phases.
 */
async function main(): Promise<void> {
  const connection = createConnection();

  const healthWorker = new Worker(
    QUEUES.HEALTH,
    async (job: Job) => ({ ok: true, name: job.name, ranAt: new Date().toISOString() }),
    { connection, concurrency: 2 },
  );

  healthWorker.on('completed', (job) => {
    console.log(`[worker] ${QUEUES.HEALTH} job ${job.id} (${job.name}) completed`);
  });
  healthWorker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });

  // Repeatable heartbeat — visible in Bull-Board, proves the queue round-trips.
  await getQueue(QUEUES.HEALTH).add(
    'heartbeat',
    {},
    { repeat: { every: 60_000 }, removeOnComplete: 50, removeOnFail: 50 },
  );

  // Stub: IST-anchored midnight cleanup (Phase 6/9 will fill in the logic).
  const midnightCleanup = cron.schedule(
    '5 0 * * *',
    () => {
      console.log('[worker] (stub) midnight cleanup tick');
    },
    { timezone: env.BUSINESS_TIMEZONE },
  );

  console.log(
    `[worker] started — processing ${QUEUES.HEALTH}; business tz=${env.BUSINESS_TIMEZONE}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received, shutting down`);
    midnightCleanup.stop();
    await healthWorker.close();
    await closeQueues();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
