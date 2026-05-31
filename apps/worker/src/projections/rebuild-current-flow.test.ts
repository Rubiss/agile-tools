import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agile-tools/shared', async (importActual) => {
  const actual = await importActual<typeof import('@agile-tools/shared')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
    },
  };
});

import { rebuildCurrentFlowProjection } from './rebuild-current-flow.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rebuildCurrentFlowProjection', () => {
  it('queries completed stories only from the current sync run', async () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());

    const db = {
      flowScope: {
        findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
      },
      boardSnapshot: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      workItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            startedAt: new Date('2026-05-25T12:00:00.000Z'),
            completedAt: new Date('2026-05-28T12:00:00.000Z'),
            createdAt: new Date('2026-05-24T12:00:00.000Z'),
            currentStatusId: 'done',
            lifecycleEvents: [],
            holdPeriods: [],
          },
        ]),
      },
      agingThresholdModel: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    await rebuildCurrentFlowProjection(
      db as unknown as Parameters<typeof rebuildCurrentFlowProjection>[0],
      'scope-1',
      'sync-run-2',
      { historicalWindowDays: 90 },
    );

    expect(db.workItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scopeId: 'scope-1',
          completedAt: { not: null, gte: new Date('2026-02-27T12:00:00.000Z') },
          excludedReason: null,
          lastSyncRunId: 'sync-run-2',
        }),
      }),
    );
  });

  it('persists per-column threshold models from completed item dwell samples', async () => {
    const now = new Date('2026-05-28T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());

    const db = {
      flowScope: {
        findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }),
      },
      boardSnapshot: {
        findFirst: vi.fn().mockResolvedValue({
          columns: [
            { name: 'To Do', statusIds: ['todo'] },
            { name: 'In Progress', statusIds: ['dev'] },
            { name: 'Done', statusIds: ['done'] },
          ],
        }),
      },
      workItem: {
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: new Date('2026-05-24T12:00:00.000Z'),
            startedAt: new Date('2026-05-25T00:00:00.000Z'),
            completedAt: new Date('2026-05-29T00:00:00.000Z'),
            currentStatusId: 'done',
            lifecycleEvents: [
              {
                fromStatusId: 'todo',
                toStatusId: 'dev',
                changedAt: new Date('2026-05-26T00:00:00.000Z'),
              },
              {
                fromStatusId: 'dev',
                toStatusId: 'done',
                changedAt: new Date('2026-05-29T00:00:00.000Z'),
              },
            ],
            holdPeriods: [],
          },
        ]),
      },
      agingThresholdModel: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    await rebuildCurrentFlowProjection(
      db as unknown as Parameters<typeof rebuildCurrentFlowProjection>[0],
      'scope-1',
      'sync-run-2',
      { historicalWindowDays: 90 },
    );

    expect(db.agingThresholdModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          columnThresholds: expect.arrayContaining([
            expect.objectContaining({
              columnName: 'To Do',
              metricBasis: 'column_working_days',
              sampleSize: 1,
              p50: 1,
            }),
            expect.objectContaining({
              columnName: 'In Progress',
              metricBasis: 'column_working_days',
              sampleSize: 1,
              p50: 3,
            }),
            expect.objectContaining({
              columnName: 'Done',
              metricBasis: 'column_working_days',
              sampleSize: 0,
            }),
          ]),
        }),
      }),
    );
  });
});
