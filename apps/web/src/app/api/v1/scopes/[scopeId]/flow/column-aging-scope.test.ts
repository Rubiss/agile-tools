import { describe, expect, it } from 'vitest';

import { selectInScopeColumnAgingModels } from './column-aging-scope';

describe('selectInScopeColumnAgingModels', () => {
  it('keeps only columns between the configured start and done boundaries', () => {
    const models = [
      { columnName: 'Backlog', statusIds: ['1'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'Selected', statusIds: ['2'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'In Progress', statusIds: ['3'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'Done', statusIds: ['4'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'Archive', statusIds: ['5'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
    ];

    const scoped = selectInScopeColumnAgingModels(
      models,
      [
        { name: 'Backlog', statusIds: ['1'] },
        { name: 'Selected', statusIds: ['2'] },
        { name: 'In Progress', statusIds: ['3'] },
        { name: 'Done', statusIds: ['4'] },
        { name: 'Archive', statusIds: ['5'] },
      ],
      ['2'],
      ['4'],
    );

    expect(scoped.map((model) => model.columnName)).toEqual([
      'Selected',
      'In Progress',
      'Done',
    ]);
  });

  it('includes columns through the end of the board when the done status is not mapped to a visible column', () => {
    const models = [
      { columnName: 'Selected', statusIds: ['2'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'In Progress', statusIds: ['3'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
      { columnName: 'Review', statusIds: ['6'], metricBasis: 'column_working_days', p50: 1, p70: 2, p85: 3, sampleSize: 10 },
    ];

    const scoped = selectInScopeColumnAgingModels(
      models,
      [
        { name: 'Backlog', statusIds: ['1'] },
        { name: 'Selected', statusIds: ['2'] },
        { name: 'In Progress', statusIds: ['3'] },
        { name: 'Review', statusIds: ['6'] },
      ],
      ['2'],
      ['4'],
    );

    expect(scoped.map((model) => model.columnName)).toEqual([
      'Selected',
      'In Progress',
      'Review',
    ]);
  });
});
