import { describe, expect, it } from 'vitest';

import { buildColumnDurationsForItem, type BoardColumnMapping } from './column-durations.js';

const timezone = 'UTC';
const columns: BoardColumnMapping[] = [
  { name: 'To Do', statusIds: ['todo'] },
  { name: 'In Progress', statusIds: ['dev', 'review'] },
  { name: 'Done', statusIds: ['done'] },
];

function d(value: string): Date {
  return new Date(value);
}

describe('buildColumnDurationsForItem', () => {
  it('sums repeated visits while keeping current contiguous dwell separate', () => {
    const result = buildColumnDurationsForItem({
      createdAt: d('2025-01-06T00:00:00Z'),
      startedAt: d('2025-01-06T00:00:00Z'),
      completedAt: null,
      currentStatusId: 'dev',
      statusChanges: [
        { fromStatusId: 'todo', toStatusId: 'dev', changedAt: d('2025-01-07T00:00:00Z') },
        { fromStatusId: 'dev', toStatusId: 'review', changedAt: d('2025-01-09T00:00:00Z') },
        { fromStatusId: 'review', toStatusId: 'todo', changedAt: d('2025-01-10T00:00:00Z') },
        { fromStatusId: 'todo', toStatusId: 'dev', changedAt: d('2025-01-13T00:00:00Z') },
      ],
      holdIntervals: [],
      columns,
      now: d('2025-01-15T00:00:00Z'),
      timezone,
    });

    expect(result.columnDurations).toEqual([
      expect.objectContaining({ columnName: 'To Do', workingDays: 2, visitCount: 2, current: false }),
      expect.objectContaining({ columnName: 'In Progress', workingDays: 5, visitCount: 2, current: true }),
    ]);
    expect(result.currentColumnDwell).toEqual(expect.objectContaining({ columnName: 'In Progress', workingDays: 2 }));
  });

  it('collapses consecutive statuses in the same column into one visit', () => {
    const result = buildColumnDurationsForItem({
      createdAt: d('2025-01-06T00:00:00Z'),
      startedAt: d('2025-01-06T00:00:00Z'),
      completedAt: null,
      currentStatusId: 'review',
      statusChanges: [
        { fromStatusId: 'todo', toStatusId: 'dev', changedAt: d('2025-01-07T00:00:00Z') },
        { fromStatusId: 'dev', toStatusId: 'review', changedAt: d('2025-01-08T00:00:00Z') },
      ],
      holdIntervals: [],
      columns,
      now: d('2025-01-10T00:00:00Z'),
      timezone,
    });

    expect(result.columnDurations).toEqual([
      expect.objectContaining({ columnName: 'To Do', workingDays: 1, visitCount: 1 }),
      expect.objectContaining({ columnName: 'In Progress', workingDays: 3, visitCount: 1, current: true }),
    ]);
    expect(result.currentColumnDwell).toEqual(expect.objectContaining({ columnName: 'In Progress', workingDays: 3 }));
  });

  it('merges overlapping holds before subtracting dwell time', () => {
    const result = buildColumnDurationsForItem({
      createdAt: d('2025-01-06T00:00:00Z'),
      startedAt: d('2025-01-06T00:00:00Z'),
      completedAt: null,
      currentStatusId: 'dev',
      statusChanges: [{ fromStatusId: 'todo', toStatusId: 'dev', changedAt: d('2025-01-07T00:00:00Z') }],
      holdIntervals: [
        { startedAt: d('2025-01-08T00:00:00Z'), endedAt: d('2025-01-10T00:00:00Z') },
        { startedAt: d('2025-01-09T00:00:00Z'), endedAt: d('2025-01-13T00:00:00Z') },
      ],
      columns,
      now: d('2025-01-14T00:00:00Z'),
      timezone,
    });

    expect(result.columnDurations).toEqual([
      expect.objectContaining({ columnName: 'To Do', workingDays: 1, holdWorkingDays: 0 }),
      expect.objectContaining({ columnName: 'In Progress', workingDays: 2, holdWorkingDays: 3 }),
    ]);
    expect(result.currentColumnDwell).toEqual(
      expect.objectContaining({ columnName: 'In Progress', workingDays: 2, holdWorkingDays: 3 }),
    );
  });

  it('ignores hold periods that do not overlap a column visit', () => {
    const result = buildColumnDurationsForItem({
      createdAt: d('2025-01-06T00:00:00Z'),
      startedAt: d('2025-01-06T00:00:00Z'),
      completedAt: null,
      currentStatusId: 'dev',
      statusChanges: [{ fromStatusId: 'todo', toStatusId: 'dev', changedAt: d('2025-01-07T00:00:00Z') }],
      holdIntervals: [
        { startedAt: d('2025-01-02T00:00:00Z'), endedAt: d('2025-01-03T00:00:00Z') },
        { startedAt: d('2025-01-20T00:00:00Z'), endedAt: d('2025-01-21T00:00:00Z') },
      ],
      columns,
      now: d('2025-01-09T00:00:00Z'),
      timezone,
    });

    expect(result.columnDurations).toEqual([
      expect.objectContaining({ columnName: 'To Do', workingDays: 1, holdWorkingDays: 0 }),
      expect.objectContaining({ columnName: 'In Progress', workingDays: 2, holdWorkingDays: 0 }),
    ]);
  });

  it('groups unmapped statuses under Uncategorized', () => {
    const result = buildColumnDurationsForItem({
      createdAt: d('2025-01-06T00:00:00Z'),
      startedAt: d('2025-01-06T00:00:00Z'),
      completedAt: null,
      currentStatusId: 'blocked',
      statusChanges: [],
      holdIntervals: [],
      columns,
      now: d('2025-01-08T00:00:00Z'),
      timezone,
    });

    expect(result.columnDurations).toEqual([
      expect.objectContaining({
        columnName: 'Uncategorized',
        statusIds: ['blocked'],
        workingDays: 2,
        visitCount: 1,
        current: true,
      }),
    ]);
    expect(result.currentColumnDwell).toEqual(expect.objectContaining({ columnName: 'Uncategorized', workingDays: 2 }));
  });
});
