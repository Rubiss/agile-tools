import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { queryDailyThroughput } from './throughput-projection.js';

function mockDb(completedAt: string[]): PrismaClient {
  return {
    workItem: {
      findMany: vi.fn().mockResolvedValue(
        completedAt.map((date) => ({
          completedAt: new Date(date),
        })),
      ),
    },
  } as unknown as PrismaClient;
}

describe('queryDailyThroughput', () => {
  it('marks explicit historical ranges complete without appending the current day', async () => {
    const db = mockDb(['2026-02-03T12:00:00.000Z']);

    const days = await queryDailyThroughput(db, 'scope-1', 'UTC', {
      sampleStartDate: '2026-02-01',
      sampleEndDate: '2026-02-07',
      anchorDate: new Date('2026-04-21T00:00:00.000Z'),
    });

    expect(days).toEqual([
      { day: '2026-02-02', completedStoryCount: 0, complete: true },
      { day: '2026-02-03', completedStoryCount: 1, complete: true },
      { day: '2026-02-04', completedStoryCount: 0, complete: true },
      { day: '2026-02-05', completedStoryCount: 0, complete: true },
      { day: '2026-02-06', completedStoryCount: 0, complete: true },
    ]);
  });

  it('includes weekend completions on the selected range start boundary', async () => {
    const db = mockDb(['2026-02-07T12:00:00.000Z']);

    const days = await queryDailyThroughput(db, 'scope-1', 'UTC', {
      sampleStartDate: '2026-02-07',
      sampleEndDate: '2026-03-08',
      anchorDate: new Date('2026-04-21T00:00:00.000Z'),
    });

    expect(days[0]).toEqual({ day: '2026-02-06', completedStoryCount: 1, complete: true });
    expect(days[1]).toEqual({ day: '2026-02-09', completedStoryCount: 0, complete: true });
  });

  it('does not pull weekend completions from before the selected range', async () => {
    const db = mockDb(['2026-02-07T12:00:00.000Z']);

    const days = await queryDailyThroughput(db, 'scope-1', 'UTC', {
      sampleStartDate: '2026-02-09',
      sampleEndDate: '2026-03-10',
      anchorDate: new Date('2026-04-21T00:00:00.000Z'),
    });

    expect(days[0]).toEqual({ day: '2026-02-09', completedStoryCount: 0, complete: true });
    expect(days.every((day) => day.completedStoryCount === 0)).toBe(true);
  });
});
