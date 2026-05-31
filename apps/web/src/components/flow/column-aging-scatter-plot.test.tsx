// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ColumnAgingScatterPlot } from './column-aging-scatter-plot';
import type { ColumnScatterDatum, FlowAnalyticsViewModel } from '@/server/views/flow-analytics';

function columnPoint(overrides: Partial<ColumnScatterDatum>): ColumnScatterDatum {
  return {
    x: 0,
    y: 5,
    workItemId: crypto.randomUUID(),
    issueKey: 'AGILE-1',
    summary: 'Seeded item',
    currentStatus: 'In Progress',
    currentColumn: 'In Progress',
    onHoldNow: false,
    agingZone: 'normal',
    columnDurations: [],
    ...overrides,
  };
}

function viewModel(points: ColumnScatterDatum[]): FlowAnalyticsViewModel {
  return {
    series: [
      { id: 'normal', data: [] },
      { id: 'watch', data: [] },
      { id: 'aging', data: [] },
    ],
    columnSeries: [
      { id: 'normal', data: points.filter((point) => point.agingZone === 'normal') },
      { id: 'watch', data: points.filter((point) => point.agingZone === 'watch') },
      { id: 'aging', data: points.filter((point) => point.agingZone === 'aging') },
    ],
    agingModel: {
      metricBasis: 'cycle_time',
      p50: 10,
      p70: 15,
      p85: 20,
      sampleSize: 40,
    },
    columnAgingModels: [
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
      {
        columnName: 'Ready for Review',
        statusIds: ['review'],
        metricBasis: 'column_working_days',
        p50: 1,
        p70: 2,
        p85: 3,
        sampleSize: 40,
      },
    ],
    columnNames: ['Selected for Development', 'In Progress', 'Ready for Review'],
    sampleSize: points.length,
    dataVersion: 'sync-1',
    syncedAt: new Date('2026-05-30T12:00:00Z').toISOString(),
  };
}

describe('ColumnAgingScatterPlot', () => {
  it('omits columns that do not currently contain active stories', () => {
    render(
      <ColumnAgingScatterPlot
        viewModel={viewModel([
          columnPoint({
            workItemId: '11111111-1111-4111-8111-111111111111',
            issueKey: 'AGILE-101',
            currentColumn: 'Selected for Development',
          }),
          columnPoint({
            workItemId: '22222222-2222-4222-8222-222222222222',
            issueKey: 'AGILE-102',
            currentColumn: 'In Progress',
          }),
        ])}
      />,
    );

    expect(screen.getByText('Selected for De…')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByText('Ready for Review')).not.toBeInTheDocument();
  });

  it('spreads same-column points with colliding ages into distinct x positions', () => {
    const { container } = render(
      <ColumnAgingScatterPlot
        viewModel={viewModel([
          columnPoint({
            workItemId: '11111111-1111-4111-8111-111111111111',
            issueKey: 'AGILE-101',
            currentColumn: 'In Progress',
            y: 5,
          }),
          columnPoint({
            workItemId: '22222222-2222-4222-8222-222222222222',
            issueKey: 'AGILE-102',
            currentColumn: 'In Progress',
            y: 5,
          }),
          columnPoint({
            workItemId: '33333333-3333-4333-8333-333333333333',
            issueKey: 'AGILE-103',
            currentColumn: 'In Progress',
            y: 5.1,
          }),
        ])}
      />,
    );

    const cxValues = Array.from(container.querySelectorAll('circle')).map((circle) => circle.getAttribute('cx'));

    expect(new Set(cxValues).size).toBe(3);
  });
});
