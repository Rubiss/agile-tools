// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgingThresholdDrawer } from './aging-threshold-drawer';
import type { AgingModel, ColumnAgingModel } from '@agile-tools/shared/contracts/api';

const agingModel: AgingModel = {
  metricBasis: 'cycle_time',
  p50: 5,
  p70: 8,
  p85: 13,
  sampleSize: 40,
};

const columnAgingModels: ColumnAgingModel[] = [
  {
    columnName: 'Selected for Development',
    statusIds: ['selected'],
    metricBasis: 'column_working_days',
    p50: 2,
    p70: 4,
    p85: 6,
    sampleSize: 40,
  },
  {
    columnName: 'In Progress',
    statusIds: ['progress'],
    metricBasis: 'column_working_days',
    p50: 3,
    p70: 5,
    p85: 8,
    sampleSize: 40,
  },
];

function renderColumnDrawer(visibleColumnNames?: string[]) {
  render(
    <AgingThresholdDrawer
      open
      mode="column"
      agingModel={agingModel}
      columnAgingModels={columnAgingModels}
      {...(visibleColumnNames === undefined ? {} : { visibleColumnNames })}
      historicalWindowDays={90}
      activeItemCount={0}
      dataVersion="sync-1"
      onClose={vi.fn()}
    />,
  );
}

describe('AgingThresholdDrawer', () => {
  it('honors an intentionally empty visible-column filter', () => {
    renderColumnDrawer([]);

    expect(screen.getByText('No active columns are currently plotted.')).toBeInTheDocument();
    expect(screen.queryByText('Selected for Development')).not.toBeInTheDocument();
    expect(screen.queryByText('In Progress')).not.toBeInTheDocument();
  });

  it('shows the hidden-empty-column note only when the visible filter omits models', () => {
    renderColumnDrawer(['Selected for Development']);

    expect(screen.getByText('Selected for Development')).toBeInTheDocument();
    expect(screen.queryByText('In Progress')).not.toBeInTheDocument();
    expect(screen.getByText(/Columns without active stories are omitted/i)).toBeInTheDocument();
  });
});
