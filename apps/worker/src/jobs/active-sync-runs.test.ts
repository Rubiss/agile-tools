import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
  },
}));

vi.mock('@agile-tools/shared', () => ({
  logger: loggerMock,
}));

import {
  WORKER_SHUTDOWN_SYNC_ERROR_CODE,
  cancelActiveSyncRuns,
  trackActiveSyncRun,
} from './active-sync-runs.js';

describe('active sync run shutdown handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels tracked running sync runs with a shutdown error code', async () => {
    const db = {
      syncRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const now = new Date('2026-05-05T14:00:00.000Z');

    trackActiveSyncRun('run-1');

    await expect(
      cancelActiveSyncRuns(db as unknown as Parameters<typeof cancelActiveSyncRuns>[0], now),
    ).resolves.toBe(1);

    expect(db.syncRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['run-1'] },
        status: 'running',
      },
      data: expect.objectContaining({
        status: 'canceled',
        finishedAt: now,
        errorCode: WORKER_SHUTDOWN_SYNC_ERROR_CODE,
      }),
    });
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Canceled active sync runs during worker shutdown',
      {
        trackedCount: 1,
        canceledCount: 1,
      },
    );
  });

  it('does not cancel sync runs after they are untracked', async () => {
    const db = {
      syncRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const untrack = trackActiveSyncRun('run-2');
    untrack();

    await expect(
      cancelActiveSyncRuns(db as unknown as Parameters<typeof cancelActiveSyncRuns>[0]),
    ).resolves.toBe(0);

    expect(db.syncRun.updateMany).not.toHaveBeenCalled();
  });
});
