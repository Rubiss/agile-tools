import { getPrismaClient } from '@agile-tools/db';
import {
  getConfig,
  initializeMetrics,
  logger,
  observeQueueStats,
  QUEUE_NAMES,
  startMetricsServer,
  stopMetricsServer,
} from '@agile-tools/shared';
import { initQueue, closeQueue } from './queue.js';
import { registerJobs } from '../jobs/register-jobs.js';
import { cancelActiveSyncRuns } from '../jobs/active-sync-runs.js';

let _started = false;

export async function startWorker(): Promise<void> {
  if (_started) return;

  const config = getConfig();
  initializeMetrics({ serviceName: 'agile-tools-worker', runtime: 'worker' });
  logger.info('Worker starting', { nodeEnv: config.NODE_ENV });

  // Verify database connectivity before accepting jobs.
  const prisma = getPrismaClient();
  await prisma.$connect();
  logger.info('Database connected');

  // Initialise the job queue backed by the same PostgreSQL instance.
  await initQueue(config.DATABASE_URL);
  observeQueueStats(async () => {
    const { getQueue } = await import('./queue.js');
    const queue = getQueue();
    return Promise.all(
      Object.values(QUEUE_NAMES).map(async (queueName) => {
        const stats = await queue.getQueueStats(queueName);
        return {
          queueName,
          queuedCount: stats.queuedCount,
          activeCount: stats.activeCount,
          deferredCount: stats.deferredCount,
          totalCount: stats.totalCount,
        };
      }),
    );
  });
  logger.info('Queue initialised');

  const metricsServer = await startMetricsServer({
    serviceName: 'agile-tools-worker',
    runtime: 'worker',
    host: config.METRICS_HOST,
    port: config.METRICS_PORT,
  });
  logger.info('Metrics server listening', metricsServer);

  // Register all job handlers.
  await registerJobs(prisma);
  logger.info('Jobs registered');

  _started = true;
  logger.info('Worker ready');
}

export async function stopWorker(): Promise<void> {
  if (!_started) return;

  logger.info('Worker shutting down');

  const prisma = getPrismaClient();
  await stopMetricsServer();
  await closeQueue();
  await cancelActiveSyncRuns(prisma);
  await prisma.$disconnect();

  _started = false;
  logger.info('Worker stopped');
}
