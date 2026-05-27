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
import { checkMetaRejections } from './jobs/meta-rejection.js';
import { refreshFbTokens } from './jobs/token-refresh.js';
import { type FbLaunchJob, runFbLaunch, triggerAutoLaunch } from './launch-trigger.js';

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
  // assignChannel is also concurrency-safe via FOR UPDATE SKIP LOCKED. Every path
  // that hands a campaign a channel fires `triggerAutoLaunch` (Phase 8 org toggle):
  // the direct assign here, and the queue-drain/rollover paths via the callback.
  const channelWorker = new Worker(
    QUEUES.CHANNEL_MAINTENANCE,
    async (job: Job<ChannelJob>) => {
      const { action, campaignId } = job.data;
      switch (action) {
        case 'assign': {
          if (!campaignId) return { skipped: true };
          const result = await assignChannel(campaignId);
          if (result.assigned) await triggerAutoLaunch(campaignId);
          return result;
        }
        case 'release':
          return campaignId ? releaseChannelForCampaign(campaignId, triggerAutoLaunch) : { skipped: true };
        case 'rollover':
          return rolloverChannels(undefined, triggerAutoLaunch);
        case 'process-queue':
          return processQueue(triggerAutoLaunch);
        default:
          return { skipped: true };
      }
    },
    { connection, concurrency: 1 },
  );
  channelWorker.on('failed', (job, err) => {
    console.error(`[worker] ${QUEUES.CHANNEL_MAINTENANCE} job ${job?.id} failed:`, err.message);
  });

  // FB launch (D12, Phase 8 auto-launch): each job POSTs the API's token-guarded
  // internal launch endpoint (the launch must run on the API — it owns the FB client
  // and the creative files on disk). Concurrency 1 keeps launches sequential so they
  // share the per-ad-account rate-limit budget; BullMQ retries with backoff on error.
  const fbLaunchWorker = new Worker(
    QUEUES.FB_LAUNCH,
    async (job: Job<FbLaunchJob>) => runFbLaunch(job.data),
    { connection, concurrency: 1 },
  );
  fbLaunchWorker.on('completed', (job, result) => {
    console.log(`[worker] ${QUEUES.FB_LAUNCH} job ${job.id} done:`, result);
  });
  fbLaunchWorker.on('failed', (job, err) => {
    console.error(`[worker] ${QUEUES.FB_LAUNCH} job ${job?.id} failed:`, err.message);
  });

  // Meta-rejection polling (D14): FB has no reliable disapproval webhook, so poll
  // effective_status; a disapproved ad → META_REJECTED + release channel + notify.
  const metaRejectionWorker = new Worker(
    QUEUES.META_REJECTION_CHECK,
    async () => checkMetaRejections(),
    { connection, concurrency: 1 },
  );
  metaRejectionWorker.on('failed', (job, err) => {
    console.error(`[worker] ${QUEUES.META_REJECTION_CHECK} job ${job?.id} failed:`, err.message);
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

  // Meta-rejection check every 30 min (D14).
  const metaRejectionCron = cron.schedule(
    '*/30 * * * *',
    () => {
      void getQueue(QUEUES.META_REJECTION_CHECK).add('check', {}, { removeOnComplete: 50, removeOnFail: 50 });
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
    metaRejectionCron.stop();
    tokenRefreshCron.stop();
    await healthWorker.close();
    await tokenRefreshWorker.close();
    await channelWorker.close();
    await fbLaunchWorker.close();
    await metaRejectionWorker.close();
    await closeQueues();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
