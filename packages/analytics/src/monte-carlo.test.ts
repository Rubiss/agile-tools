import { describe, expect, it } from 'vitest';
import { runEpicForecast } from './monte-carlo.js';

describe('runEpicForecast', () => {
  it('evaluates due-date confidence against cumulative sequential epic scope', () => {
    const result = runEpicForecast({
      historicalDailyThroughput: [1],
      sampleSize: 90,
      iterations: 1000,
      targets: [
        {
          id: 'target-1',
          jiraIssueKey: 'PROJ-1',
          summary: 'First epic',
          dueDate: '2026-07-01',
          remainingStoryCount: 3,
          targetDays: 3,
        },
        {
          id: 'target-2',
          jiraIssueKey: 'PROJ-2',
          summary: 'Second epic',
          dueDate: '2026-07-08',
          remainingStoryCount: 4,
          targetDays: 6,
        },
      ],
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        targetId: 'target-1',
        cumulativeStoryCount: 3,
        completionChance: 100,
      }),
      expect.objectContaining({
        targetId: 'target-2',
        cumulativeStoryCount: 7,
        completionChance: 0,
      }),
    ]);
  });

  it('keeps targets visible but marks chance unavailable when there is no throughput', () => {
    const result = runEpicForecast({
      historicalDailyThroughput: [0, 0, 0],
      sampleSize: 0,
      iterations: 1000,
      targets: [
        {
          id: 'target-1',
          jiraIssueKey: 'PROJ-1',
          summary: 'First epic',
          dueDate: '2026-07-01',
          remainingStoryCount: 3,
          targetDays: 10,
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      targetId: 'target-1',
      completionChance: 0,
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'LOW_SAMPLE_SIZE',
      'NO_THROUGHPUT_HISTORY',
    ]);
  });
});
