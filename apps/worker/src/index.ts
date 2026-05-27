import { Worker, type Job } from 'bullmq';
import cron from 'node-cron';
import { env } from '@knn/config';
import { QUEUES, closeQueues, createConnection, getQueue } from '@knn/queue';
import {
  assignChannel,
  processQueue,
  releaseChannelForCampaign,
  rolloverChannels,
} from './channel-pool/channel.service.js';
import { refreshFbTokens } from './jobs/token-refresh.js';

interface ChannelJob {
  action: 'assign' | 'release' | 'rollover' | 'process-queue';
  campaignId?: string;
}

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

  // Facebook long-lived-token maintenance (DECISION D13). The cron enqueues a job
  // daily (IST); this worker extends/degrades connections per the refresh windows.
  const tokenRefreshWorker = new Worker(
    QUEUES.TOKEN_REFRESH,
    async () => refreshFbTokens(),
    { connection, concurrency: 1 },
  );
  tokenRefreshWorker.on('completed', (job, result) => {
    console.log(`[worker] ${QUEUES.TOKEN_REFRESH} job ${job.id} done:`, result);
  });
  tokenRefreshWorker.on('failed', (job, err) => {
    console.error(`[worker] ${QUEUES.TOKEN_REFRESH} job ${job?.id} failed:`, err.message);
  });

  // Channel pool maintenance (D7/D11): assign on approval, release on stop, drain
  // the FIFO queue, and the IST midnight rollover. Single-writer (concurrency 1);
  // assignChannel is also concurrency-safe via FOR UPDATE SKIP LOCKED.
  const channelWorker = new Worker(
    QUEUES.CHANNEL_MAINTENANCE,
    async (job: Job<ChannelJob>) => {
      const { action, campaignId } = job.data;
      switch (action) {
        case 'assign':
          return campaignId ? assignChannel(campaignId) : { skipped: true };
        case 'release':
          return campaignId ? releaseChannelForCampaign(campaignId) : { skipped: true };
        case 'rollover':
          return rolloverChannels();
        case 'process-queue':
          return processQueue();
        default:
          return { skipped: true };
      }
    },
    { connection, concurrency: 1 },
  );
  channelWorker.on('failed', (job, err) => {
    console.error(`[worker] ${QUEUES.CHANNEL_MAINTENANCE} job ${job?.id} failed:`, err.message);
  });

  // Repeatable heartbeat — visible in Bull-Board, proves the queue round-trips.
  await getQueue(QUEUES.HEALTH).add(
    'heartbeat',
    {},
    { repeat: { every: 60_000 }, removeOnComplete: 50, removeOnFail: 50 },
  );

  // IST midnight channel rollover (00:05 IST, D4): release channels from ended
  // campaigns, renew active locks for the new day, and drain the wait queue.
  const midnightCleanup = cron.schedule(
    '5 0 * * *',
    () => {
      void getQueue(QUEUES.CHANNEL_MAINTENANCE).add(
        'rollover',
        { action: 'rollover' },
        { removeOnComplete: 50, removeOnFail: 50 },
      );
    },
    { timezone: env.BUSINESS_TIMEZONE },
  );

  // Daily FB token maintenance at 02:30 IST. Runs daily (not every ~60d) so a
  // token entering the refresh window or expiring is handled within a day (D13).
  const tokenRefreshCron = cron.schedule(
    '30 2 * * *',
    () => {
      void getQueue(QUEUES.TOKEN_REFRESH).add(
        'refresh',
        {},
        { removeOnComplete: 50, removeOnFail: 50 },
      );
    },
    { timezone: env.BUSINESS_TIMEZONE },
  );

  console.log(
    `[worker] started — processing ${QUEUES.HEALTH}; business tz=${env.BUSINESS_TIMEZONE}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received, shutting down`);
    midnightCleanup.stop();
    tokenRefreshCron.stop();
    await healthWorker.close();
    await tokenRefreshWorker.close();
    await channelWorker.close();
    await closeQueues();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
