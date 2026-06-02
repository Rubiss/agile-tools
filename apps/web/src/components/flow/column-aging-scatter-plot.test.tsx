// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('shows board columns by default even when they do not currently contain active stories', () => {
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
    expect(screen.getByText('Ready for Review')).toBeInTheDocument();
  });

  it('renders board columns and thresholds when there are no active stories', () => {
    const { container } = render(<ColumnAgingScatterPlot viewModel={viewModel([])} />);

    expect(screen.queryByText('No per-column dwell data to display.')).not.toBeInTheDocument();
    expect(screen.getByText('Selected for De…')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Ready for Review')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="column-threshold-segment"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('circle')).toHaveLength(0);
  });

  it('does not force horizontal scrolling inside the chart', () => {
    const { container } = render(
      <ColumnAgingScatterPlot
        viewModel={viewModel([
          columnPoint({
            workItemId: '11111111-1111-4111-8111-111111111111',
            issueKey: 'AGILE-101',
            currentColumn: 'Selected for Development',
          }),
        ])}
      />,
    );

    const chartContainer = container.querySelector('div[aria-label="Column aging scatter plot"]');
    const svg = container.querySelector('svg[aria-label="Column aging scatter plot"]');

    expect(chartContainer).toHaveStyle({ overflowX: '' });
    expect(svg).not.toHaveStyle({ minWidth: '48rem' });
  });

  it('omits columns that do not currently contain active stories when requested', () => {
    render(
      <ColumnAgingScatterPlot
        hideEmptyColumns
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

  it('uses a wider horizontal spread for dense Jira dots in the same column', () => {
    const { container } = render(
      <ColumnAgingScatterPlot
        hideEmptyColumns
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

    const cxValues = Array.from(container.querySelectorAll('circle'))
      .map((circle) => Number(circle.getAttribute('cx')))
      .sort((a, b) => a - b);

    expect(cxValues).toHaveLength(3);
    expect(cxValues[2]! - cxValues[0]!).toBeGreaterThan(30);
  });

  it('keeps threshold markers, labels, and points inside the plot bounds', () => {
    const { container } = render(
      <ColumnAgingScatterPlot
        viewModel={viewModel([
          columnPoint({
            workItemId: '11111111-1111-4111-8111-111111111111',
            issueKey: 'AGILE-101',
            currentColumn: 'Selected for Development',
            y: 7,
          }),
          columnPoint({
            workItemId: '22222222-2222-4222-8222-222222222222',
            issueKey: 'AGILE-102',
            currentColumn: 'Ready for Review',
            y: 2,
          }),
        ])}
      />,
    );

    const minX = 58;
    const maxX = 892;
    const values = (selector: string, attribute: string) =>
      Array.from(container.querySelectorAll(selector)).map((node) => Number(node.getAttribute(attribute)));

    for (const x of values('[data-testid="column-threshold-segment"]', 'x1')) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
    }
    for (const x of values('[data-testid="column-threshold-segment"]', 'x2')) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
    }
    for (const x of values('[data-testid="column-threshold-label"]', 'x')) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
    }
    for (const x of values('circle', 'cx')) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
    }
  });

  it('shows an interactive hover card for column points', () => {
    render(
      <ColumnAgingScatterPlot
        viewModel={viewModel([
          columnPoint({
            workItemId: '11111111-1111-4111-8111-111111111111',
            issueKey: 'AGILE-101',
            summary: 'Hover me',
            currentColumn: 'In Progress',
            currentStatus: 'Doing',
            assigneeName: 'Riley Chen',
            y: 5.5,
            agingZone: 'watch',
          }),
        ])}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole('button', { name: /AGILE-101: 5.5 working days in In Progress/i }));

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    expect(screen.getByText('Doing · In Progress')).toBeInTheDocument();
    expect(screen.getByText('5.5 days')).toBeInTheDocument();
    expect(screen.getByText('Riley Chen')).toBeInTheDocument();
  });
});
