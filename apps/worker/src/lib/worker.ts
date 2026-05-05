import { getPrismaClient } from '@agile-tools/db';
import { getConfig, logger } from '@agile-tools/shared';
import { initQueue, closeQueue } from './queue.js';
import { registerJobs } from '../jobs/register-jobs.js';
import { cancelActiveSyncRuns } from '../jobs/active-sync-runs.js';

let _started = false;

export async function startWorker(): Promise<void> {
  if (_started) return;

  const config = getConfig();
  logger.info('Worker starting', { nodeEnv: config.NODE_ENV });

  // Verify database connectivity before accepting jobs.
  const prisma = getPrismaClient();
  await prisma.$connect();
  logger.info('Database connected');

  // Initialise the job queue backed by the same PostgreSQL instance.
  await initQueue(config.DATABASE_URL);
  logger.info('Queue initialised');

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
  await closeQueue();
  await cancelActiveSyncRuns(prisma);
  await prisma.$disconnect();

  _started = false;
  logger.info('Worker stopped');
}
