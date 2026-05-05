import type { PrismaClient } from '@agile-tools/db';
import { logger } from '@agile-tools/shared';

export const WORKER_SHUTDOWN_SYNC_ERROR_CODE = 'SYNC_WORKER_SHUTDOWN';
const WORKER_SHUTDOWN_SYNC_ERROR_SUMMARY =
  'Canceled because the worker shut down gracefully while this sync was running.';

const activeSyncRunIds = new Set<string>();

export function trackActiveSyncRun(syncRunId: string): () => void {
  activeSyncRunIds.add(syncRunId);
  return () => {
    activeSyncRunIds.delete(syncRunId);
  };
}

export async function cancelActiveSyncRuns(db: PrismaClient, now = new Date()): Promise<number> {
  const syncRunIds = Array.from(activeSyncRunIds);
  if (syncRunIds.length === 0) {
    return 0;
  }

  const canceled = await db.syncRun.updateMany({
    where: {
      id: { in: syncRunIds },
      status: 'running',
    },
    data: {
      status: 'canceled',
      finishedAt: now,
      errorCode: WORKER_SHUTDOWN_SYNC_ERROR_CODE,
      errorSummary: WORKER_SHUTDOWN_SYNC_ERROR_SUMMARY,
    },
  });

  for (const syncRunId of syncRunIds) {
    activeSyncRunIds.delete(syncRunId);
  }

  logger.info('Canceled active sync runs during worker shutdown', {
    trackedCount: syncRunIds.length,
    canceledCount: canceled.count,
  });

  return canceled.count;
}
